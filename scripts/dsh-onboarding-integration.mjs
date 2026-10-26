/** Real DSH SDK onboarding integration. Fixed responses only; no production profile or model credentials.
 * node scripts/dsh-onboarding-integration.mjs
 * Optional: DSH_TEST_INSTALL, DSH_TEST_HOME (must be new), DSH_TEST_ARTIFACTS.
 * Requires Windows and an installed DSH NEXT with the public SDK CLI.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, access, readdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const unsupported = message => Object.assign(new Error(message), { code: 'DSH_TEST_UNSUPPORTED' });
const within = (root, candidate) => { const rel = relative(root, candidate); return !rel || rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(rel); };
const ownError = (code, message) => Object.assign(new Error(message), { code });
function argumentsFrom(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { values.help = true; continue; }
    if (arg === '--prepare-only') { values.prepareOnly = true; continue; }
    if (!['--install', '--home', '--artifacts'].includes(arg) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw ownError('INVALID_ARGUMENT', 'Supported options: --install PATH --home NEW_PATH --artifacts PATH --prepare-only --help. This entry is always fixture-only.');
    values[arg.slice(2)] = argv[++i];
  }
  return values;
}
function fixtureEnvironment(home, memoryRoot) {
  // Retain only OS process-launch settings. No provider, token, API-key or production DSH environment is inherited.
  const names = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'temp', 'tmp', 'programfiles', 'programfiles(x86)', 'programdata', 'allusersprofile', 'number_of_processors', 'processor_architecture', 'os', 'lang', 'lc_all']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => names.has(name.toLowerCase())));
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'platform', 'roaming'), LOCALAPPDATA: join(home, 'platform', 'local'),
    DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1', PERSONA_MEMORY_ROOT: memoryRoot,
    NPM_CONFIG_USERCONFIG: join(home, 'empty.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'empty-global.npmrc'),
    npm_config_userconfig: join(home, 'empty.npmrc'), npm_config_globalconfig: join(home, 'empty-global.npmrc') };
}
async function nativeCommand(options, args, label, entry = options.cli) {
  const child = spawn(options.exe, [entry, ...args], { cwd: source, windowsHide: true, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const result = await new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => { child.kill(); resolveResult({ code: null, timedOut: true }); }, options.installTimeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolveResult({ code, signal }); });
  });
  await writeFile(join(options.artifacts, label + '.stdout.private.txt'), stdout);
  await writeFile(join(options.artifacts, label + '.stderr.txt'), stderr);
  if (result.code !== 0) throw ownError('DSH_PROFILE_SETUP_FAILED', label + ' failed; inspect the isolated run diagnostics.');
}
async function prepareProfile(options) {
  // The CLI's bundled sdk default is used in a newly created home. No existing user profile is opened or copied.
  await nativeCommand(options, ['--profile', options.profile, '--from-default-profile', 'sdk', '--help'], 'profile-init');
  const profileManifest = join(options.home, 'profiles', options.profile, 'package.json');
  const before = JSON.parse(await readFile(profileManifest, 'utf8'));
  const bundles = before.dsh?.profile?.bundles ?? [];
  const base = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'];
  const dependencies = manifest => ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap(key => Object.keys(manifest[key] ?? {}));
  if (!bundles.includes('@deepseek-ai/dsh-sdk-app') || bundles.some(name => !base.includes(name)) || dependencies(before).length) throw ownError('DSH_PROFILE_CONFLICT', 'Fresh SDK profile contains unexpected bundles or dependencies.');
  await nativeCommand(options, [options.profile, 'add', source], 'plugin-install', options.pluginCli);
  const after = JSON.parse(await readFile(profileManifest, 'utf8'));
  const packageName = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).name;
  if (!after.dependencies?.[packageName] || dependencies(after).some(name => name !== packageName) || (after.dsh?.profile?.bundles ?? []).some(name => ![...base, packageName].includes(name))) throw ownError('DSH_PROFILE_CONFLICT', 'Native package installation did not produce the dedicated test profile.');
}
async function run() {
const args = argumentsFrom(process.argv.slice(2));
if (args.help) { console.log('Usage: node scripts/dsh-onboarding-integration.mjs [--install PATH] [--home NEW_PATH] [--artifacts PATH] [--prepare-only]\nAlways fixed-response fixture-only. DSH_TEST_INSTALL, DSH_TEST_HOME and DSH_TEST_ARTIFACTS supply matching defaults. A new isolated home is required; no production profile or model credentials are used. Missing Windows/DSH returns unsupported (exit 2).'); return; }
if (process.platform !== 'win32') throw unsupported('This installed-DSH integration entry currently supports Windows only.');
const install = resolve(args.install ?? process.env.DSH_TEST_INSTALL ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'DSH NEXT'));
const exe = join(install, 'DSH NEXT.exe');
try { await access(exe); await access(join(install, 'resources', 'app.asar')); } catch { throw unsupported('Installed DSH NEXT was not found. Set DSH_TEST_INSTALL to its install directory; no test or production profile was changed.'); }
const artifactRoot = resolve(args.artifacts ?? process.env.DSH_TEST_ARTIFACTS ?? join(source, 'work', 'dsh-onboarding-integration'));
const runId = 'run-' + Date.now() + '-' + randomUUID().slice(0, 8), dir = join(artifactRoot, runId);
const home = resolve(args.home ?? process.env.DSH_TEST_HOME ?? join(dir, 'sdk-home')), memoryRoot = join(dir, 'memory');
for (const productionRoot of [join(homedir(), '.dsh'), process.env.DSH_HOME].filter(Boolean).map(root => resolve(root))) {
  if (within(productionRoot, home) || within(productionRoot, artifactRoot)) throw ownError('DSH_TEST_HOME_CONFLICT', 'Test home and artifacts must stay outside the production DSH home.');
}
try { await access(home); throw ownError('DSH_TEST_HOME_EXISTS', 'DSH_TEST_HOME must be a new path. Existing homes are never reused, modified or removed.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(dir, { recursive: true });
await mkdir(dirname(home), { recursive: true }); await mkdir(home);
await mkdir(join(home, 'platform', 'roaming'), { recursive: true }); await mkdir(join(home, 'platform', 'local'), { recursive: true });
await writeFile(join(home, 'empty.npmrc'), ''); await writeFile(join(home, 'empty-global.npmrc'), '');
const options = { home, artifacts: dir, profile: 'persona-onboarding-validation', fixtureOnly: true, realOnly: false, exe,
  cli: join(install, 'resources', 'app.asar', 'lib', 'desktop-cli.js'), pluginCli: join(install, 'resources', 'app.asar', 'lib', 'plugin-cli.js'),
  env: fixtureEnvironment(home, memoryRoot), installTimeout: Number(process.env.DSH_TEST_INSTALL_TIMEOUT_MS ?? 180000) };
await prepareProfile(options);
if (args.prepareOnly) { console.log(JSON.stringify({ status: 'prepared', artifactRoot: dir, home, profile: options.profile, fixtureOnly: true, productionProfileChanged: false })); return; }
await mkdir(memoryRoot, { recursive: true });
const sourceNames = ['package.json', 'cordis.patch.yml', 'adapters/dsh/index.js', 'adapters/dsh/instances.js', 'adapters/dsh/channels/native.js', 'adapters/dsh/channels/onebot.js',
  'adapters/dsh/channels/service.js', 'adapters/dsh/channels/windows-speech.js', 'adapters/dsh/channels/windows-speech.ps1', 'adapters/dsh/voice.js', 'adapters/dsh/model.js', 'adapters/dsh/normalize.js', 'adapters/dsh/tool-schema.js',
  'core/runtime.js', 'core/repository.js', 'core/store.js', 'core/schema.js', 'core/prompts.js', 'adapters/dsh/surfaces.js', 'adapters/dsh/permissions.js', 'adapters/dsh/companion-scope.js', 'adapters/dsh/media/index.js', 'adapters/dsh/media/service.js', 'adapters/dsh/media/providers.js', 'adapters/dsh/media/io.js', 'adapters/dsh/connections/service.js', 'adapters/dsh/connections/bridge.js'];
async function digests() { return Object.fromEntries(await Promise.all(sourceNames.map(async name => [name, createHash('sha256').update(await readFile(join(source, name))).digest('hex')]))); }
async function runtimeSourceNames(dir,prefix){const rows=[];for(const entry of await readdir(dir,{withFileTypes:true})){const name=prefix+'/'+entry.name;if(entry.isDirectory())rows.push(...await runtimeSourceNames(join(dir,entry.name),name));else if(entry.isFile()&&entry.name.endsWith('.js'))rows.push(name);}return rows;}
for(const name of [...await runtimeSourceNames(join(source,'adapters/dsh'),'adapters/dsh'),...await runtimeSourceNames(join(source,'core'),'core')].sort())if(!sourceNames.includes(name))sourceNames.push(name);
const sourceDigests = await digests();
const harnessDigests=Object.fromEntries(await Promise.all(['scripts/dsh-onboarding-integration.mjs','scripts/fixtures/onboarding-fixture.mjs'].map(async name=>[name,createHash('sha256').update(await readFile(join(source,name))).digest('hex')])));
const workspace=join(dir,'workspace');await mkdir(workspace,{recursive:true});await writeFile(join(workspace,'input.txt'),'ACTUAL_WORKER_READ_BYTES 主体保真🙂');
await writeFile(join(dir,'executed-fixture.mjs'),await readFile(join(source,'scripts','fixtures','onboarding-fixture.mjs')));
await writeFile(join(dir,'executed-runner.mjs'),await readFile(fileURLToPath(import.meta.url)));
const overlay = join(dir, 'test-overlay.yml');
await writeFile(overlay, JSON.stringify([
  { id: 'tools', config: { mode: 'native' } },
  { id: 'persona-memory-coordinator', config: { provider: 'persona-onboarding-fixture', model: 'fixture-v1', operatorControl: true } },
  { insert: [{ id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'persona-memory' } },
    { id: 'persona-onboarding-fixture-probe', name: pathToFileURL(join(dir, 'executed-fixture.mjs')).href, config: { artifacts: dir, workspace, connectionModule: pathToFileURL(join(install, 'resources', 'app.asar', 'node_modules', '@deepseek-ai', 'dsh-client-connection', 'lib', 'index.js')).href } }] },
], null, 2));
const child = spawn(options.exe, [options.cli, '--profile', options.profile, '--patch', overlay], { cwd: source, windowsHide: true,
  env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
let lineBuffer = '', stderr = '', stdout = '', closed = false, counter = 0;
const pendingRpc = new Map();
const exit = new Promise(resolve => child.once('close', (code, signal) => { closed = true; for (const item of pendingRpc.values()) { clearTimeout(item.timer); item.reject(new Error('Native SDK exited')); } pendingRpc.clear(); resolve({ code, signal }); }));
child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => {
  stdout += chunk; lineBuffer += chunk; let end;
  while ((end = lineBuffer.indexOf('\n')) >= 0) {
    const line = lineBuffer.slice(0, end); lineBuffer = lineBuffer.slice(end + 1); let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (value.id !== undefined && pendingRpc.has(value.id)) { const item = pendingRpc.get(value.id); clearTimeout(item.timer); pendingRpc.delete(value.id); value.error ? item.reject(new Error(JSON.stringify(value.error))) : item.resolve(value.result); }
  }
});
child.stderr.on('data', chunk => { stderr += chunk; });
function rpc(method, params = {}, timeout = 20000) {
  if (closed) return Promise.reject(new Error('Native SDK closed')); const id = ++counter;
  return new Promise((resolve, reject) => { const timer = setTimeout(() => { pendingRpc.delete(id); reject(new Error('RPC timeout ' + method)); }, timeout); pendingRpc.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const readLines = async file => { try { return (await readFile(file, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
async function until(check, timeout=35000) { const end=Date.now()+timeout; while(Date.now()<end) { const value=await check(); if(value)return value; if(closed)throw Error('Native SDK exited while waiting'); await sleep(70); } throw Error('Native onboarding fixture condition timed out'); }
let credentials;
async function control(path='/state',method='GET',data) {
  const response=await fetch(credentials.controlOrigin+path,{method,headers:{authorization:'Bearer '+credentials.controlToken,...(data?{'content-type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(15000)});
  const value=await response.json();if(!response.ok)throw Error('Isolated fixture control failed: '+response.status+' '+JSON.stringify(value));return value;
}
const summary={status:'running',startedAt:new Date().toISOString(),sourceDigests,harnessDigests,profile:options.profile,
  claims:{nativeDshEngine:true,deterministicFixture:true,realModel:false,productionProfileChanged:false,environmentCredentialsInherited:false,realPlatformAccounts:false,platformDeliveryVerified:false,naturalLanguageQualityVerified:false},checks:{}};
const check=(name,condition)=>{summary.checks[name]=Boolean(condition);if(!condition)throw Error('Check failed: '+name);};
const textOf=value=>((value?.message??value)?.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
const argsOf=value=>typeof value.arguments==='string'?JSON.parse(value.arguments):value.arguments??{};
const events=()=>readLines(join(dir,'native-events.private.jsonl'));
const requests=()=>readLines(join(dir,'requests.private.jsonl'));
const managedTestRoots=[];
async function regularFileNames(root,prefix='') {
  if(!within(dir,root))throw Error('Synthetic instance left the isolated artifact boundary');
  const names=[];
  for(const entry of await readdir(join(root,prefix),{withFileTypes:true})) {
    const name=prefix?prefix+'/'+entry.name:entry.name;
    if(entry.isSymbolicLink())throw Error('Unexpected link in the isolated memory tree');
    if(entry.isDirectory())names.push(...await regularFileNames(root,name));
    else if(entry.isFile()&&name!=='writer.lock')names.push(name);
  }
  return names.sort();
}
async function finalMessage(marker,sessionId) { return until(async()=>{
  const rows=await events(),value=await control('/state'),scope=value.scopes?.find(item=>item.sessionId===sessionId);
  const failure=rows.find(row=>row.sessionId===sessionId&&row.event?.type==='turn/end'&&row.event.data?.reason?.kind==='error');
  if(failure)throw Error('Native onboarding turn failed: '+String(failure.event.data.reason.error?.message??'unknown turn error'));
  return rows.some(row=>row.sessionId===sessionId&&row.event?.type==='assistant/message'&&textOf(row.event.data).includes(marker))&&scope?.status==='idle'?value:null;
},45000); }
try {
  credentials=await until(()=>readJson(join(dir,'access.private.json')),60000);
  const initialized=await rpc('initialize',{cwd:workspace,provider:'persona-onboarding-fixture',model:'fixture-v1',maxTokens:4096});
  check('actualInstalledNativeSdkInitialized',initialized.serverInfo?.name==='deepseek-harness-sdk-runtime');
  const ownerResult=async(action,args={},testForeign=false)=>{const result=await control('/owner','POST',{action,args,testForeign});return result.httpStatus===200?JSON.parse(result.body).result:{ok:false,error:{code:'HTTP_'+result.httpStatus}};};
  const owner=async(action,args={})=>{const result=await ownerResult(action,args);if(!result?.ok)throw ownError(result?.error?.code??'OWNER_FAILED','Owner '+action+' failed: '+JSON.stringify(result));return result.value;};
  await until(async()=>{const value=await ownerResult('status');return value?.ok?value.value:null;});
  check('actualOwnerManagementCarrierAcceptsOwner',(await owner('status')).available===true);
  check('actualOwnerManagementCarrierRejectsNonOwner',!(await ownerResult('self.get',{},true)).ok);
  let profile=await owner('self.get');
  check('oldCompatibleEmptySelfProfileNeedsNoInventedIdentity',profile.version===0&&profile.createdAt===null&&profile.mode==='unset'&&Object.values(profile.current).every(value=>value===''));
  const initial=await owner('self.update',{expectedVersion:profile.version,patch:{mode:'together',onboardingAcknowledged:true,initial:{name:'初始建议名',gender:'女性',ageDescription:'二十五岁形象'}}});
  check('ownerInitialWishesPersistWithoutReplacingCurrent',initial.initial.name==='初始建议名'&&initial.current.name===''&&initial.version===1);
  const stale=await ownerResult('self.update',{expectedVersion:0,patch:{initial:{name:'STALE_MUST_NOT_COMMIT'}}});
  check('ownerCasRejectsStaleEdit',!stale.ok&&stale.error?.code==='VERSION_CONFLICT'&&(await owner('self.get')).initial.name==='初始建议名');
  check('shortChatIsActualDefaultConfig',(await owner('config.get')).conversationStyle==='short_chat');

  await control('/begin','POST',{sessionId:'onboarding_first_fixture',sourceEventId:'onboarding-human-start',text:'ONBOARD_ADOPT 你好，先认识一下吧。'});
  let state=await finalMessage('ONBOARD_ADOPT_FINISHED','onboarding_first_fixture');
  profile=await owner('self.get');
  check('actualNativePersonaToolUpdatesCurrentDescription',profile.current.name==='相续自选名'&&profile.current.selfDescription.includes('ONBOARD_CURRENT_CHOSEN')&&profile.provenance.current.name.actor==='persona');
  check('initialWishesRemainDistinctAfterPersonaChoice',profile.initial.name==='初始建议名'&&profile.current.name!==profile.initial.name);
  check('currentProfileKeepsActualHumanSource',profile.provenance.current.name.sourceRefs.some(ref=>ref.sourceSessionId==='onboarding_first_fixture'&&ref.sourceEventId==='onboarding-human-start'));
  let rows=await requests(),native=rows.filter(row=>row.kind==='fixture-provider-received-request');
  check('nativeModelReceivesInitialWishesAndShortChatPreference',native.some(row=>JSON.stringify(row.messages).includes('初始建议名')&&JSON.stringify(row.messages).includes('自然短聊')));
  let observed=await events();
  check('actualNativeIntrospectReadAndWriteToolsExecuted',observed.some(row=>row.event?.type==='tool/call'&&row.event.data.name==='persona_introspect'&&argsOf(row.event.data).section==='self')&&observed.some(row=>row.event?.type==='tool/call'&&row.event.data.name==='persona_introspect'&&argsOf(row.event.data).action==='update_self'));
  const chosenVersion=profile.version;
  await owner('self.update',{expectedVersion:chosenVersion,patch:{initial:{name:'后来提出的新建议'}}});
  check('laterOwnerSuggestionDoesNotOverwriteCurrent',(await owner('self.get')).current.name==='相续自选名');

  await control('/begin','POST',{sessionId:'onboarding_second_fixture',sourceEventId:'onboarding-human-new-window',text:'ONBOARD_READ 新窗口里继续认识一下。'});
  state=await finalMessage('ONBOARD_READ_FINISHED','onboarding_second_fixture');
  const secondSnapshot=state.scopes.find(item=>item.sessionId==='onboarding_second_fixture')?.snapshot;
  check('sameInstanceNewNativeSessionKeepsCurrentIdentity',state.self.current.name==='相续自选名'&&secondSnapshot?.injectedText.includes('相续自选名'));
  const availability=secondSnapshot?.segments?.find(item=>item.name==='environment')?.text??'';
  check('newWindowDistinguishesUnassociatedAndUnrequestedFromEmptyStore',availability.includes('"personAssociation":"unassociated"')&&availability.includes('"retrieval":"not_requested"')&&availability.includes('"storeContent":"not_assessed"'));

  await control('/begin','POST',{sessionId:'onboarding_rhythm_fixture',sourceEventId:'onboarding-human-rhythm',text:'ONBOARD_RHYTHM_START 先说一句，然后再考虑是否继续。'});
  state=await finalMessage('ONBOARD_SHORT_FIRST','onboarding_rhythm_fixture');
  check('nativeToolActuallySelectsLaterReconsideration',state.runtime.schedule.nextCheckAt>Date.now()&&state.runtime.currentDecision.replyPlan.target.sessionId==='onboarding_rhythm_fixture');
  await control('/prompt','POST',{sourceEventId:'onboarding-human-latest',text:'ONBOARD_LATEST_ARRIVAL 刚才补充一条新消息，请按现在的内容再想。'});
  await until(async()=>{const value=await control('/state');return value.pending.some(row=>row.sourceEventId==='onboarding-human-latest')?value:null;},3000);
  state=await finalMessage('ONBOARD_SHORT_SECOND','onboarding_rhythm_fixture');
  observed=await events();
  check('actualDueControlIncludesNewestAcceptedInput',observed.some(row=>row.kind==='actual-reconsideration-input'&&row.text.includes('ONBOARD_LATEST_ARRIVAL')&&row.text.includes('onboarding-human-latest')));
  const first=observed.find(row=>row.sessionId==='onboarding_rhythm_fixture'&&row.event?.type==='assistant/message'&&textOf(row.event.data).includes('ONBOARD_SHORT_FIRST'));
  const second=observed.find(row=>row.sessionId==='onboarding_rhythm_fixture'&&row.event?.type==='assistant/message'&&textOf(row.event.data).includes('ONBOARD_SHORT_SECOND'));
  check('nativeShortMessagesHaveIndependentRealAssistantSources',first&&second&&first.event.data.message.id!==second.event.data.message.id&&first.event.seq<second.event.seq&&first.event.data.message.source.kind==='model'&&second.event.data.message.source.kind==='model');
  check('reconsiderationCanEndWithoutFixedContinuationCount',state.runtime.schedule.nextCheckAt===null&&state.runtime.currentDecision.replyPlan.replyAt===null);
  const accepted=await readLines(join(memoryRoot,'staging','events.jsonl'));
  check('automaticControlNoticeIsNotStoredAsHumanDialogue',accepted.some(row=>row.sourceEventId==='onboarding-human-latest'&&row.role==='user')&&!accepted.some(row=>row.sourceKind?.startsWith('persona-memory:')));

  const beforeReload=await owner('self.get');
  await owner('instances.unload',{});check('actualInstanceUnloadLeavesNoActiveCoordinator',(await control('/state')).loaded===false);
  await owner('instances.load',{instanceId:'default'});
  const afterReload=await owner('self.get');
  check('selfProfileSurvivesActualUnloadReload',JSON.stringify(afterReload)===JSON.stringify(beforeReload));
  await control('/begin','POST',{sessionId:'onboarding_after_reload',sourceEventId:'onboarding-human-after-reload',text:'ONBOARD_READ 再次加载后继续。'});
  await finalMessage('ONBOARD_READ_FINISHED','onboarding_after_reload');
  rows=await requests();observed=await events();native=rows.filter(row=>row.kind==='fixture-provider-received-request');
  check('allCallsStayOnFixedFixtureRoute',rows.length>0&&rows.every(row=>row.provider==='persona-onboarding-fixture'&&row.model==='fixture-v1')&&!observed.some(row=>row.kind==='non-fixture-route-rejected'));
  check('actualOrientationIsAdvisoryAndHasNoFalseHumanIdentity',native.some(row=>JSON.stringify(row.messages).includes('不是字数、条数或频率要求'))&&native.every(row=>!JSON.stringify(row.messages).includes('你是一个人')));
  check('finalNativeStepStillUsesRetainedCurrentName',native.some(row=>JSON.stringify(row.messages).includes('onboarding-human-after-reload')&&JSON.stringify(row.messages).includes('相续自选名')));

  // The permanent clear below is confined to a new synthetic SDK instance.
  // The original personality is archived/restored, never permanently cleared.
  const archivedProfile=await owner('self.get');
  await owner('instances.archive',{instanceId:'default'});
  let instances=await owner('instances.list');
  check('ownerArchiveKeepsRecoverableInstanceAndStopsIt',Boolean(instances.items.find(item=>item.instanceId==='default')?.archivedAt)&&instances.activeInstanceId!=='default'&&(await control('/state')).loaded===false);
  await owner('instances.create',{name:'SDK清除样本',autoLoad:true});
  instances=await owner('instances.list');
  const synthetic=instances.items.find(item=>item.instanceId===instances.activeInstanceId);
  check('createUsesDifferentOwnedEmptyRoot',synthetic&&synthetic.instanceId!=='default'&&within(dir,synthetic.memoryRoot)&&(await owner('self.get')).current.name==='');
  managedTestRoots.push(synthetic.memoryRoot);
  state=await control('/state');
  check('archivedHostSessionsDoNotAttachToNewPersonality',state.scopes.filter(item=>item.sessionId.startsWith('onboarding_')).every(item=>!item.attached));
  await owner('self.update',{expectedVersion:0,patch:{initial:{name:'清除测试初始资料'}}});
  await control('/begin','POST',{sessionId:'onboarding_clear_fixture',sourceEventId:'onboarding-human-clear-synthetic',text:'ONBOARD_EMPTY 清除验收只针对这个合成实例。'});
  await finalMessage('ONBOARD_EMPTY_FINISHED','onboarding_clear_fixture');
  const profilePath=join(synthetic.memoryRoot,'self','profile.json'),profileBytesBefore=await readFile(profilePath);
  const sentinelPath=join(synthetic.memoryRoot,'unknown-user-file.txt');
  await writeFile(sentinelPath,'SYNTHETIC_UNKNOWN_FILE_MUST_NOT_BE_DELETED');
  const blocked=await ownerResult('instances.clearPreview',{instanceId:synthetic.instanceId});
  check('unknownFileBlocksClearPreviewWithoutDeletingIt',!blocked.ok&&(await readFile(sentinelPath,'utf8'))==='SYNTHETIC_UNKNOWN_FILE_MUST_NOT_BE_DELETED'&&(await readFile(profilePath)).equals(profileBytesBefore)&&(await control('/state')).loaded===true);
  await unlink(sentinelPath);
  let preview=await owner('instances.clearPreview',{instanceId:synthetic.instanceId});
  check('clearPreviewIsReadOnlyAndStatesExclusions',preview.instanceId===synthetic.instanceId&&preview.requiresName===synthetic.name&&typeof preview.confirmationToken==='string'&&Array.isArray(preview.scope)&&Array.isArray(preview.excluded)&&preview.excluded.length>0&&(await readFile(profilePath)).equals(profileBytesBefore));
  const wrong=await ownerResult('instances.clear',{instanceId:synthetic.instanceId,confirmationToken:preview.confirmationToken,typedName:'WRONG_NAME'});
  check('permanentClearRequiresExactTypedName',!wrong.ok&&(await readFile(profilePath)).equals(profileBytesBefore)&&(await control('/state')).loaded===true);
  const beforeNames=await regularFileNames(synthetic.memoryRoot);
  let cleared=await ownerResult('instances.clear',{instanceId:synthetic.instanceId,confirmationToken:preview.confirmationToken,typedName:synthetic.name});
  summary.extraConfirmationAfterClose=false;
  if(!cleared.ok) {
    check('stalePreviewAfterClosingDeletesNoData',/STALE|CHANGED|PREVIEW/i.test(cleared.error?.code??'')&&JSON.stringify(await regularFileNames(synthetic.memoryRoot))===JSON.stringify(beforeNames)&&(await readFile(profilePath)).equals(profileBytesBefore));
    summary.extraConfirmationAfterClose=true;
    preview=await owner('instances.clearPreview',{instanceId:synthetic.instanceId});
    cleared=await ownerResult('instances.clear',{instanceId:synthetic.instanceId,confirmationToken:preview.confirmationToken,typedName:synthetic.name});
  }
  check('explicitClearOfSyntheticInstanceSucceeds',cleared.ok===true);
  check('clearedIdentityCannotBeLoadedAgain',!(await ownerResult('instances.load',{instanceId:synthetic.instanceId})).ok);
  let removed=false;try{await access(profilePath);}catch(error){if(error.code==='ENOENT')removed=true;else throw error;}
  check('syntheticPersonalityTextWasActuallyRemoved',removed);
  const retainedHostLog=await control('/session','POST',{sessionId:'onboarding_clear_fixture'});
  check('permanentPersonaClearDoesNotPretendToDeleteNativeHostLog',retainedHostLog.retained&&retainedHostLog.sourceEventIds.includes('onboarding-human-clear-synthetic'));
  await owner('instances.create',{name:'SDK清除后的新实例',autoLoad:true});
  instances=await owner('instances.list');const replacement=instances.items.find(item=>item.instanceId===instances.activeInstanceId);
  check('replacementHasIndependentFreshIdentity',replacement&&replacement.instanceId!==synthetic.instanceId&&replacement.memoryRoot!==synthetic.memoryRoot&&(await owner('self.get')).current.name==='');
  managedTestRoots.push(replacement.memoryRoot);
  state=await control('/state');
  check('clearedHostSessionDoesNotReenterReplacementMemory',!state.scopes.find(item=>item.sessionId==='onboarding_clear_fixture')?.attached&&!state.records.some(item=>item.sourceSessionId==='onboarding_clear_fixture'));
  await owner('instances.restore',{instanceId:'default',activate:true});
  check('explicitRestoreRecoversArchivedSelfDescription',JSON.stringify(await owner('self.get'))===JSON.stringify(archivedProfile));
  rows=await requests();observed=await events();native=rows.filter(row=>row.kind==='fixture-provider-received-request');
  check('allLifecycleCallsAlsoStayOnFixedFixtureRoute',rows.every(row=>row.provider==='persona-onboarding-fixture'&&row.model==='fixture-v1')&&!observed.some(row=>row.kind==='non-fixture-route-rejected'));
  summary.observation={hostRequests:rows.filter(row=>row.kind==='host-llm-stream-input').length,fixtureRequests:native.length,realModelRequests:0,realPlatformLogins:0,realPlatformSends:0,
    shortAssistantSources:[{seq:first.event.seq,id:first.event.data.message.id},{seq:second.event.seq,id:second.event.data.message.id}],ownerCarrier:'Actual HostConnection shared Fetch with owner and non-owner peers',latestArrivalIncluded:true};
  await owner('instances.unload',{});
  check('sourceDigestsStillMatch',JSON.stringify(sourceDigests)===JSON.stringify(await digests()));summary.status='passed';
} catch (error) { summary.status = 'failed'; summary.error = { name: error.name, code: error.code ?? null, message: String(error.message) }; }
finally {
  try { if (!closed) await rpc('shutdown', {}, 15000); } catch {}
  child.stdin.end(); let timer; const ended = await Promise.race([exit, new Promise(resolve => { timer = setTimeout(() => resolve(null), 12000); })]); clearTimeout(timer);
  if (!ended) { child.kill(); summary.exit = await exit; summary.forcedExit = true; } else summary.exit = ended;
  if (summary.exit.code !== 0) summary.status = 'failed';
  summary.finishedAt = new Date().toISOString(); summary.checkCount = Object.keys(summary.checks).length;
  const redact = value => credentials?.controlToken ? value.replaceAll(credentials.controlToken, '[fixture-secret]') : value;
  summary.locks={};for(const [name,file] of Object.entries({core:join(memoryRoot,'writer.lock'),media:memoryRoot+'.media-assets/writer.lock',tasks:memoryRoot+'.tasks/writer.lock',social:memoryRoot+'.social-identities.json.writer.lock',secondaryCore:join(dir,'secondary-memory','writer.lock')})){try{await access(file);summary.locks[name]={remaining:true};summary.status='failed';}catch(error){if(error.code!=='ENOENT')throw error;summary.locks[name]={remaining:false};}}
  summary.writerLockRemaining=summary.locks.core.remaining;
  summary.additionalInstanceLocks=[];
  for(const root of managedTestRoots)for(const file of [join(root,'writer.lock'),root+'.media-assets/writer.lock',root+'.tasks/writer.lock',root+'.social-identities.json.writer.lock']) {
    let remaining=false;try{await access(file);remaining=true;summary.status='failed';}catch(error){if(error.code!=='ENOENT')throw error;}
    summary.additionalInstanceLocks.push({remaining});
  }
  summary.sourceDigestsAfter=await digests();
  summary.sourceDigestsMatch=JSON.stringify(sourceDigests)===JSON.stringify(summary.sourceDigestsAfter);if(!summary.sourceDigestsMatch)summary.status='failed';
  summary.harnessDigestsAfter=Object.fromEntries(await Promise.all(Object.keys(harnessDigests).map(async name=>[name,createHash('sha256').update(await readFile(join(source,name))).digest('hex')])));
  summary.harnessDigestsMatch=JSON.stringify(harnessDigests)===JSON.stringify(summary.harnessDigestsAfter);if(!summary.harnessDigestsMatch)summary.status='failed';
  await writeFile(join(dir, 'stdout.private.txt'), redact(stdout)); await writeFile(join(dir, 'stderr.txt'), redact(stderr));
  await writeFile(join(dir, 'result.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(join(dir, 'process.json'), JSON.stringify({ pid: child.pid, exited: closed, exit: summary.exit, forcedExit: summary.forcedExit ?? false, checkedAt: new Date().toISOString() }, null, 2) + '\n');
}
console.log(JSON.stringify({status:summary.status,artifactRoot:dir,home,checkCount:summary.checkCount,passedChecks:Object.values(summary.checks).filter(Boolean).length,error:summary.error,sourceDigestsMatch:summary.sourceDigestsMatch,exit:summary.exit,locks:summary.locks})); process.exitCode = summary.status === 'passed' ? 0 : 1;
}
await run().catch(error => { console.error(JSON.stringify({status:error.code === 'DSH_TEST_UNSUPPORTED' ? 'unsupported' : 'failed',code:error.code??error.name,message:error.message})); process.exitCode=error.code === 'DSH_TEST_UNSUPPORTED' ? 2 : 1; });
