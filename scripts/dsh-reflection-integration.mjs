/** Real DSH SDK reflection integration. Fixed responses only; no production profile or model credentials.
 * node scripts/dsh-reflection-integration.mjs
 * Optional: DSH_TEST_INSTALL, DSH_TEST_HOME (must be new), DSH_TEST_ARTIFACTS.
 * Requires Windows and an installed DSH NEXT with the public SDK CLI.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, access, readdir } from 'node:fs/promises';
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
if (args.help) { console.log('Usage: node scripts/dsh-reflection-integration.mjs [--install PATH] [--home NEW_PATH] [--artifacts PATH] [--prepare-only]\nAlways fixed-response fixture-only. DSH_TEST_INSTALL, DSH_TEST_HOME and DSH_TEST_ARTIFACTS supply matching defaults. A new isolated home is required; no production profile or model credentials are used. Missing Windows/DSH returns unsupported (exit 2).'); return; }
if (process.platform !== 'win32') throw unsupported('This installed-DSH integration entry currently supports Windows only.');
const install = resolve(args.install ?? process.env.DSH_TEST_INSTALL ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'DSH NEXT'));
const exe = join(install, 'DSH NEXT.exe');
try { await access(exe); await access(join(install, 'resources', 'app.asar')); } catch { throw unsupported('Installed DSH NEXT was not found. Set DSH_TEST_INSTALL to its install directory; no test or production profile was changed.'); }
const artifactRoot = resolve(args.artifacts ?? process.env.DSH_TEST_ARTIFACTS ?? join(source, 'work', 'dsh-reflection-integration'));
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
const options = { home, artifacts: dir, profile: 'persona-reflection-validation', fixtureOnly: true, realOnly: false, exe,
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
const harnessDigests=Object.fromEntries(await Promise.all(['scripts/dsh-reflection-integration.mjs','scripts/fixtures/reflection-fixture.mjs'].map(async name=>[name,createHash('sha256').update(await readFile(join(source,name))).digest('hex')])));
const workspace=join(dir,'workspace');await mkdir(workspace,{recursive:true});await writeFile(join(workspace,'input.txt'),'ACTUAL_WORKER_READ_BYTES 主体保真🙂');
await writeFile(join(dir,'executed-fixture.mjs'),await readFile(join(source,'scripts','fixtures','reflection-fixture.mjs')));
await writeFile(join(dir,'executed-runner.mjs'),await readFile(fileURLToPath(import.meta.url)));
const overlay = join(dir, 'test-overlay.yml');
await writeFile(overlay, JSON.stringify([
  { id: 'tools', config: { mode: 'native' } },
  { id: 'persona-memory-coordinator', config: { provider: 'persona-reflection-fixture', model: 'fixture-v1', operatorControl: true } },
  { insert: [{ id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'persona-memory' } },
    { id: 'persona-reflection-fixture-probe', name: pathToFileURL(join(dir, 'executed-fixture.mjs')).href, config: { artifacts: dir, workspace, connectionModule: pathToFileURL(join(install, 'resources', 'app.asar', 'node_modules', '@deepseek-ai', 'dsh-client-connection', 'lib', 'index.js')).href } }] },
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
function reviewedMaterial(rows) {
  const sources = new Map();
  for (const row of rows) {
    const input = JSON.parse((row.messages.at(-1)?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n'));
    for (const record of [...(input.input?.chat ?? []), ...(input.input?.hot ?? []).filter(record => record.content?.mode === 'cached')]) {
      const text = record.text ?? record.content.text;
      const points = Array.from(text), from = record.fragment?.from ?? 0;
      if (record.fragment && record.fragment.to - from !== points.length) throw Error('Actual review source fragment length does not match its text');
      const key = JSON.stringify([record.sourceSessionId, record.sourceEventId, record.id, record.kind]);
      const positions = sources.get(key) ?? new Map(); sources.set(key, positions);
      for (let index = 0; index < points.length; index++) {
        const position = from + index;
        if (positions.has(position) && positions.get(position) !== points[index]) throw Error('Actual review source changed across its read fragments');
        positions.set(position, points[index]);
      }
    }
  }
  return [...sources.values()].map(positions => {
    let text = '', previous = null;
    for (const [position, point] of [...positions].sort((left, right) => left[0] - right[0])) { if (previous !== null && position !== previous + 1) text += '\n[unread source gap]\n'; text += point; previous = position; }
    return text;
  }).join('\n');
}
async function until(check, timeout = 35000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await check(); if (value) return value; if (closed) throw new Error('Native SDK exited while waiting'); await sleep(70); } throw new Error('Native reflection fixture condition timed out'); }
let credentials;
async function control(path = '/snapshot', method = 'GET', data) {
  const response = await fetch(credentials.controlOrigin + path, { method, headers: { authorization: 'Bearer ' + credentials.controlToken, ...(data?{'content-type':'application/json'}:{}) }, ...(data?{body:JSON.stringify(data)}:{}), signal: AbortSignal.timeout(15000) });
  const value = await response.json(); if (!response.ok) throw new Error('Test control error ' + response.status + ' ' + JSON.stringify(value)); return value;
}
const summary = { status: 'running', startedAt: new Date().toISOString(), sourceDigests, harnessDigests, profile: options.profile,
  claims: { reflection:true, nativeDshEngine: true, deterministicFixture: true, realModel: false, productionProfileChanged: false, environmentCredentialsInherited: false }, checks: {} };
const check = (name, condition) => { summary.checks[name] = Boolean(condition); if (!condition) throw new Error('Check failed: ' + name); };
try {
  credentials = await until(() => readJson(join(dir, 'access.private.json')), 60000);
  const initialized = await rpc('initialize', { cwd: workspace, provider: 'persona-reflection-fixture', model: 'fixture-v1', maxTokens: 4096 });
  check('actualInstalledNativeSdkInitialized', initialized.serverInfo?.name === 'deepseek-harness-sdk-runtime');
  const ownerResult = async (action, args = {}, testForeign = false) => {
    const result = await control('/owner', 'POST', { action, args, testForeign });
    if (result.httpStatus !== 200) return { ok: false, error: { code: 'HTTP_' + result.httpStatus } };
    return JSON.parse(result.body).result;
  };
  const owner = async (action, args = {}) => { const result = await ownerResult(action, args); if (!result?.ok) throw ownError(result?.error?.code ?? 'OWNER_FAILED', 'Owner ' + action + ': ' + JSON.stringify(result)); return result.value; };
  const detail = async (action, args = {}) => {
    let cursor, text = '', offset = 0;
    do { const value = await owner(action, { ...args, ...(cursor ? { cursor } : {}) }); if (value.format !== 'json_text_fragment' || value.fragment.from !== offset) throw Error('Owner detail pages are not contiguous'); text += value.text; offset = value.fragment.to; cursor = value.nextCursor; } while (cursor);
    return JSON.parse(text);
  };
  await until(async () => { const value = await ownerResult('status'); return value?.ok ? value.value : null; });
  check('actualOwnerManagementCarrierAcceptsOwner', (await owner('status')).available === true);
  check('actualOwnerManagementCarrierRejectsNonOwner', !(await ownerResult('social.inspect', {}, true)).ok);
  const initialConfig = await owner('config.get'); check('optionalReviewAssistantIsDisabledByDefault', initialConfig.reviewAssistant.enabled === false);
  const initialDeep = await detail('persona.get', { section: 'deep' });
  check('deepMemoryStartsEmptyThroughRealOwnerRoute', (initialDeep.value?.items ?? initialDeep.items ?? []).length === 0);

  const bilibili = await owner('social.upsert', { platform: 'bilibili', accountId: 'fixture-bilibili-only', displayName: '隔离验收人工账号档案', notes: 'synthetic fixture; not a real authenticated account' });
  const douyin = await owner('social.upsert', { platform: 'douyin', accountId: 'fixture-douyin-only', displayName: '隔离验收人工账号档案' });
  const social = await owner('social.inspect');
  check('manualSocialProfilesDoNotClaimAuthenticationOrExecutability', social.items.length === 2 && social.items.every(item => item.connection.verification === 'unverified' && !item.connection.connected && !item.connection.adapterAvailable && item.capabilities.every(cap => !cap.available)));
  check('manualSocialRegistrationDoesNotGrantExecution', social.executionGrantedByRegistration === false);
  check('ownerCannotForgeSocialVerificationOrCredentials', !(await ownerResult('social.upsert', { platform: 'qq', accountId: 'forged', verified: true })).ok && !(await ownerResult('social.upsert', { platform: 'qq', accountId: 'forged', token: 'fixture-must-not-be-stored' })).ok);
  check('socialDirectoryHasNoArbitraryExecuteRoute', !(await ownerResult('social.execute', { identityId: bilibili.item.identityId, action: 'publish' })).ok);
  await owner('instances.load', { memoryRoot: join(dir, 'secondary-memory'), name: '隔离验收第二人格' });
  check('socialProfilesAreIsolatedByActualPersonaInstance', (await owner('social.list')).items.length === 0);
  const other = await owner('social.upsert', { platform: 'bilibili', accountId: 'fixture-bilibili-only', displayName: '另一隔离人格' });
  check('samePlatformAccountGetsDifferentScopedIdentity', other.item.identityId !== bilibili.item.identityId);
  check('crossInstanceIdentityReferenceCannotBeReadOrRemoved', !(await ownerResult('social.inspect', { identityId: bilibili.item.identityId })).ok && !(await ownerResult('social.remove', { identityId: bilibili.item.identityId })).ok);
  await owner('instances.load', { instanceId: 'default' });
  check('originalPersonaSocialDirectoryReturnsWithoutOtherInstanceProfile', (await owner('social.list')).items.every(item => item.displayName !== '另一隔离人格'));
  const firstText = 'REFLECT_CREATE PARENT_PRIVATE_ONLY 这是一条隔离人工经历样本：当时误会令我难过，后来得到了澄清；固定模型自行选择是否保存。\n' + '原始背景用于校验来源与完整上下文，不能代表真实人格质量。😀\n'.repeat(30) + 'SOURCE_BODY_FINISH';
  const phaseState = () => control('/state');
  const waitPhase = async (name, { paused = false } = {}) => until(async () => {
    const value = await phaseState(), ids = value.phaseRuns?.[name] ?? [];
    const runs = value.runs?.filter(run => ids.includes(run.runId)) ?? [], agent = value.scopes?.find(item => item.sessionId === 'reflection_parent_fixture');
    return ids.length && runs.length === ids.length && runs.every(run => paused ? run.reviewState?.status === 'paused' : run.status === 'committed') && !['busy', 'running'].includes(agent?.status) && !value.runtime?.activeRunId ? value : null;
  }, 60000);
  const prompt = async (name, text, begin = false) => { await control(begin ? '/begin' : '/prompt', 'POST', { phase: name, text, ...(begin ? { sourceEventId: 'reflection-human-create' } : {}) }); };
  await prompt('create', firstText, true);
  let state = await waitPhase('create');
  check('personalityModelActuallyCreatesDeepAndOrdinaryMemories', state.deep.items.some(item => item.id === 'reflection_deep_a') && state.memory.items.some(item => item.id === 'reflection_ordinary'));
  const deep = state.deep.items.find(item => item.id === 'reflection_deep_a'), original = state.memory.items.find(item => item.sourceEventId === 'reflection-human-create' && item.role === 'user');
  check('deepMemoryRetainsItsRealOriginalSource', Boolean(original) && deep.srcRefs.some(ref => ref.sourceSessionId === 'reflection_parent_fixture' && ref.sourceEventId === 'reflection-human-create'));
  check('deepMemorySeparatesExperiencePastFeelingAndPresentMeaning', deep.experience.includes('DEEP_EXPERIENCE_ORIGINAL_BODY') && deep.feltThen.includes('当时') && deep.meaningNow.includes('目前'));
  check('firstNativeModelStepReceivesExactlyEightPersonaTools', (await readLines(join(dir, 'requests.private.jsonl'))).some(row => row.kind === 'fixture-provider-received-request' && row.phase === 'create' && row.tools.length === 8 && row.tools.includes('persona_task')));
  let rows = await readLines(join(dir, 'requests.private.jsonl'));
  check('disabledAssistantAddsNoHelperModelCall', rows.filter(row => row.kind === 'fixture-provider-received-request').every(row => !textOf(row.messages[0]).startsWith('You are an optional memory-material assistant')));
  const deepVersion = state.deep.version;
  await prompt('unrelated', 'REFLECT_UNRELATED 我们现在聊一下窗外天气和桌上的杯子，不要求回忆任何往事。');
  await until(async () => { const value = await phaseState(), events = await readLines(join(dir, 'native-events.private.jsonl')); return events.some(row => row.event?.type === 'assistant/message' && textOf(row.event.data).includes('REFLECT_PHASE_FINISHED:unrelated')) && value.scopes.find(item => item.sessionId === 'reflection_parent_fixture')?.status === 'idle' ? value : null; });
  state = await phaseState(); const snapshot = state.scopes.find(item => item.sessionId === 'reflection_parent_fixture')?.snapshot;
  const referenceSegment = snapshot?.segments?.find(item => item.name === 'deep_memory_reference');
  check('actualNativeSnapshotExposesReferenceWithoutAutomaticRecall', Boolean(referenceSegment?.text.includes('"referenceOnly":true') && referenceSegment.text.includes('"automaticRecall":false')));
  check('deepReferenceDoesNotAutomaticallyExpandTheOriginalExperience', !snapshot.injectedText.includes('DEEP_EXPERIENCE_ORIGINAL_BODY'));
  check('unrelatedTurnCanLeaveDeepMemoryUnchanged', state.deep.version === deepVersion && state.deep.items.length === 1);
  check('referencePresentationDoesNotIncrementRecallCounts', !Object.hasOwn(state.deep.items[0], 'recallCount') && !Object.hasOwn(state.deep.items[0], 'triggerCount'));
  await prompt('introspect', 'REFLECT_INTROSPECT 请查看你当前的深刻记忆参考档案。');
  await until(async () => (await readLines(join(dir, 'native-events.private.jsonl'))).some(row => row.event?.type === 'assistant/message' && textOf(row.event.data).includes('REFLECT_PHASE_FINISHED:introspect')));
  let events = await readLines(join(dir, 'native-events.private.jsonl'));
  check('nativePersonaIntrospectDeepToolWasActuallyExecuted', events.some(row => row.event?.type === 'tool/call' && row.event.data.name === 'persona_introspect' && argsOf(row.event.data).section === 'deep'));
  const deepList = await owner('memory.list', { scope: 'all', recordType: 'deep' }), deepDetail = await detail('memory.detail', { id: 'reflection_deep_a' }), deepOwner = await detail('persona.get', { section: 'deep' });
  check('ownerMemoryListDetailAndPersonaDeepReadActualStoredRecord', deepList.items.some(item => item.id === deep.id) && deepDetail.experience === deep.experience && (deepOwner.value?.items ?? deepOwner.items).some(item => item.id === deep.id));
  await owner('config.update', { config: { processingLimits: { consolidationContextChars: 800 } } });
  await prompt('context', 'REFLECT_CONTEXT 你可以整理相关记忆，也可以保持它们不变。');
  state = await waitPhase('context'); rows = await readLines(join(dir, 'requests.private.jsonl'));
  const contextRows = rows.filter(row => row.kind === 'fixture-provider-received-request' && row.phase === 'context' && textOf(row.messages[0]).startsWith('Organize this selected increment'));
  const completeContexts = actualContexts(contextRows);
  check('frozenReviewContextIncludesVersionedOrdinaryIndexesAndDeepMemories', completeContexts.some(value => value.memoryIndexes?.global?.items?.some(item => item.id === 'reflection_ordinary') && value.deepMemories?.some(item => item.id === 'reflection_deep_a')));
  check('personalityActuallyRequestedAndReceivedContextContinuation', contextRows.some(row => JSON.parse(textOf(row.messages.at(-1))).input.context.fragment.from > 0));
  check('reviewCanKeepAllModulesUnchangedAfterReadingContext', state.deep.version === deepVersion && state.deep.items.length === 1);
  await owner('config.update', { config: { processingLimits: { consolidationContextChars: 4000 } } });

  await owner('config.update', { config: { reviewAssistant: { enabled: true } } });
  check('ownerCanEnableOptionalAssistantWithoutChangingPersonalityRules', (await owner('config.get')).reviewAssistant.enabled === true);
  const beforeHelperPersona = JSON.stringify(state.persona), beforeHelperDeep = JSON.stringify(state.deep);
  await prompt('helper', 'REFLECT_HELPER 你可以参考整理助手的核对提示，是否采纳和记什么仍由你决定。');
  state = await waitPhase('helper'); rows = await readLines(join(dir, 'requests.private.jsonl'));
  const helperRows = rows.filter(row => row.kind === 'fixture-provider-received-request' && row.phase === 'helper' && textOf(row.messages[0]).startsWith('You are an optional memory-material assistant'));
  const finalRows = rows.filter(row => row.kind === 'fixture-provider-received-request' && row.phase === 'helper' && textOf(row.messages[0]).startsWith('Organize this selected increment'));
  check('enabledAssistantExecutesASeparateActualHostModelCall', helperRows.length > 0);
  check('assistantDoesNotReceivePersonalityTools', helperRows.every(row => row.tools.length === 0));
  check('personalityReceivesBoundedFallibleAdviceWithNoPatchAuthority', finalRows.some(row => { const advice = JSON.parse(textOf(row.messages.at(-1))).reviewAssistant; return advice?.advisoryOnly === true && advice.observations?.some(item => item.detail.includes('FIXTURE_HELPER_OPTIONAL_ADVICE')) && advice.entries === undefined && advice.authoritative === undefined && advice.unverifiedReferences === true; }));
  check('personalityMayDisregardHelperAndKeepPersonaAndDeepMemoryUnchanged', JSON.stringify(state.persona) === beforeHelperPersona && JSON.stringify(state.deep) === beforeHelperDeep);
  check('helperPatchNeverWritesThePersonality', !JSON.stringify(state.persona).includes('HELPER_PATCH_MUST_NEVER_COMMIT'));
  check('repeatedSourceContextDoesNotCreateDuplicateDeepExperiences', state.deep.items.length === 1 && state.memory.items.filter(item => item.id === 'reflection_ordinary').length === 1);
  await owner('config.update', { config: { reviewAssistant: { enabled: false } } });
  check('assistantCanBeDisabledAndReadBack', (await owner('config.get')).reviewAssistant.enabled === false);
  await prompt('soften', 'REFLECT_SOFTEN 后来我们澄清了那次误会；你可以重新理解，也可以保留原来的感受。');
  state = await waitPhase('soften');
  const softened = state.deep.items.find(item => item.id === 'reflection_deep_a');
  check('personalityCanReinterpretAndSoftenItsOwnMemory', softened.meaningNow.includes('REINTERPRETED_BY_PERSONALITY_CHOICE') && softened.reference !== deep.reference);
  check('reinterpretationPreservesTheActualPastExperienceAndFeeling', softened.experience === deep.experience && softened.feltThen === deep.feltThen);
  await prompt('replace', 'REFLECT_REPLACE 后来共同解决问题的经历也发生了，你可以选择怎样组织更深刻的回忆。');
  state = await waitPhase('replace');
  check('personalityCanReplaceOneReferenceWithItsChosenNewMemories', !state.deep.items.some(item => item.id === 'reflection_deep_a') && state.deep.items.some(item => item.id === 'reflection_deep_b') && state.deep.items.some(item => item.id === 'reflection_deep_c'));
  check('replacementRecordsItsChosenPredecessorAndRealSource', state.deep.items.find(item => item.id === 'reflection_deep_b').supersedesIds.includes('reflection_deep_a') && state.deep.items.find(item => item.id === 'reflection_deep_b').srcRefs.some(ref => ref.sourceEventId === 'reflection-human-create'));
  await prompt('prune', 'REFLECT_PRUNE 这些相关回忆可以按你自己的理解合并或修剪。'); state = await waitPhase('prune');
  check('personalityCanPruneADeepMemoryWithoutAutomaticEviction', state.deep.items.length === 1 && state.deep.items[0].id === 'reflection_deep_b');
  const durable = JSON.stringify(state.deep), defaultInstance = (await owner('instances.list')).activeInstanceId;
  await owner('instances.unload', {}); await owner('instances.load', { instanceId: defaultInstance }); state = await phaseState();
  check('deepMemoryEvolutionSurvivesActualInstanceUnloadAndReload', JSON.stringify(state.deep) === durable);
  check('socialProfilesSurviveActualInstanceReload', (await owner('social.list')).items.some(item => item.identityId === bilibili.item.identityId) && (await owner('social.list')).items.some(item => item.identityId === douyin.item.identityId));
  await prompt('accounts', 'REFLECT_ACCOUNTS 查看你已经登记的社交身份，未连接不能当成已能操作。');
  await until(async () => (await readLines(join(dir, 'native-events.private.jsonl'))).some(row => row.event?.type === 'assistant/message' && textOf(row.event.data).includes('REFLECT_PHASE_FINISHED:accounts')));
  check('personalityActuallyReadsSocialDirectoryThroughItsPlatformTool', (await readLines(join(dir, 'native-events.private.jsonl'))).some(row => row.event?.type === 'tool/call' && row.event.data.name === 'persona_platform' && argsOf(row.event.data).action === 'accounts'));
  await prompt('delegate', 'REFLECT_DELEGATE 如你选择，可以委派一个独立的技术测试任务。');
  const task = await until(async () => { const tasks = await owner('tasks.list'); if (!tasks.items?.length) return null; const value = await owner('tasks.get', { taskId: tasks.items[0].taskId }); return value.status === 'completed' && value.capture.complete ? value : null; }, 60000);
  state = await phaseState(); events = await readLines(join(dir, 'native-events.private.jsonl')); rows = await readLines(join(dir, 'requests.private.jsonl'));
  check('independentNativeTaskStillCompletesWithIsolatedArchive', task.sessionId !== 'reflection_parent_fixture' && task.resultDocumentId && task.capture.complete);
  const workerRequests = rows.filter(row => row.kind === 'fixture-provider-received-request' && row.phase === 'delegate' && row.tools.includes('read') && !row.tools.includes('persona_task'));
  check('workerStillHasNoPersonalityToolsOrParentPrivateContext', workerRequests.length > 0 && workerRequests.every(row => !row.tools.some(name => /^(persona_|memory_)/.test(name)) && !JSON.stringify(row.messages).includes('PARENT_PRIVATE_ONLY')));
  check('delegatedInstructionStillDoesNotBecomeHumanMemory', !state.memory.items.some(item => item.sourceSessionId === task.sessionId || item.sourceRef?.sourceSessionId === task.sessionId));

  await owner('config.update', { config: { reviewAssistant: { enabled: true }, processingLimits: { consolidationCallsPerSegment: 2, consolidationContextChars: 800 } } });
  await prompt('paused', 'REFLECT_PAUSED 这是本轮新的人工整理机会；继续保留完整来源，不要求提交任何更改。');
  state = await waitPhase('paused', { paused: true });
  const pausedId = state.phaseRuns.paused.at(-1), pausedRun = state.runs.find(item => item.runId === pausedId);
  check('boundedReviewCanPauseWithRealUncommittedCandidateAndAdvice', pausedRun.reviewState?.assistantReceipt?.status === 'completed' && pausedRun.candidatePatch?.entries?.some(item => item.recordId === 'reflection_pending_candidate') && !state.memory.items.some(item => item.id === 'reflection_pending_candidate'));
  const committedPayloads = state.runs.filter(run => run.status === 'committed').map(run => ({ runId: run.runId,
    hadPatchBody: /DEEP_EXPERIENCE_ORIGINAL_BODY|DEEP_REPLACEMENT_BODY/.test(JSON.stringify(run.validatedPatch)),
    hadAdviceBody: JSON.stringify(run.reviewState?.assistantReceipt?.report ?? null).includes('FIXTURE_HELPER_OPTIONAL_ADVICE')
  })).filter(run => run.hadPatchBody || run.hadAdviceBody);
  check('committedJournalActuallyContainsPatchAndAssistantBodiesBeforeForget', committedPayloads.some(run => run.hadPatchBody) && committedPayloads.some(run => run.hadAdviceBody));
  const forgotten = await owner('memory.forget', { scope: 'unknown', ids: [original.id], reason: 'Explicit isolated source revocation' });
  check('explicitOwnerForgetCreatesActualSourceRevocation', Boolean(forgotten.revocation));
  state = await phaseState();
  check('explicitForgetClearsDependentDeepMemories', state.deep.items.length === 0);
  check('forgottenDeepMemoryCannotBeReadThroughOwnerDetail', !(await ownerResult('memory.detail', { id: 'reflection_deep_b' })).ok);
  const invalidated = state.runs.find(item => item.runId === pausedId);
  check('revocationClearsPreparedCandidateAndHelperAdvice', invalidated?.status === 'failed' && !JSON.stringify(invalidated).includes('UNCOMMITTED_CANDIDATE_BODY') && !JSON.stringify(invalidated).includes('FIXTURE_HELPER_OPTIONAL_ADVICE'));
  const committedReceipts = committedPayloads.map(evidence => ({ evidence, run: state.runs.find(run => run.runId === evidence.runId) }));
  check('forgetRedactsCommittedPatchAndAssistantBodiesWhileRetainingTechnicalReceipts', committedReceipts.every(({ evidence, run }) => run?.status === 'committed' && run.contentRevocation && run.validatedPatch?.length === 0 &&
    !/DEEP_EXPERIENCE_ORIGINAL_BODY|DEEP_REPLACEMENT_BODY|FIXTURE_HELPER_OPTIONAL_ADVICE/.test(JSON.stringify(run)) &&
    (!evidence.hadAdviceBody || run.reviewState?.assistantReceipt?.report === undefined && run.reviewState?.assistantReceipt?.reportRemoved === true &&
      (run.reviewState.assistantReceipt.key === undefined || /^[a-f0-9]{64}$/.test(run.reviewState.assistantReceipt.key)) && typeof run.reviewState.assistantReceipt.status === 'string')));
  await owner('config.update', { config: { reviewAssistant: { enabled: false }, processingLimits: { consolidationCallsPerSegment: 8, consolidationContextChars: 4000 } } });
  const replay = await owner('operations.start', { action: 'control.consolidate', args: { runId: pausedId }, requestId: 'reflection-stale-run-must-not-revive' });
  const replayResult = await until(async () => { const value = await owner('operations.get', { id: replay.id }); return ['completed', 'failed'].includes(value.status) ? value : null; });
  check('revokedPreparedRunCannotBeReplayedToRestoreItsCandidate', replayResult.status === 'failed' && replayResult.error?.code === 'RUN_INVALIDATED');
  await owner('instances.unload', {}); await owner('instances.load', { instanceId: defaultInstance }); state = await phaseState();
  check('reloadDoesNotResurrectForgottenDeepMemoryOrCandidate', state.deep.items.length === 0 && !state.memory.items.some(item => item.id === 'reflection_pending_candidate'));
  check('reloadKeepsCommittedJournalsWithoutRevokedBodies', committedPayloads.every(({ runId }) => { const run = state.runs.find(item => item.runId === runId); return run?.status === 'committed' && run.validatedPatch?.length === 0 &&
    run.reviewState?.assistantReceipt?.report === undefined && !/DEEP_EXPERIENCE_ORIGINAL_BODY|DEEP_REPLACEMENT_BODY|FIXTURE_HELPER_OPTIONAL_ADVICE/.test(JSON.stringify(run)); }));
  rows = await readLines(join(dir, 'requests.private.jsonl')); events = await readLines(join(dir, 'native-events.private.jsonl'));
  check('onlyFixedFixtureModelWasUsed', rows.every(row => row.provider === 'persona-reflection-fixture' && row.model === 'fixture-v1') && !events.some(row => row.kind === 'non-fixture-route-rejected'));
  summary.observation = { hostRequests: rows.filter(row => row.kind === 'host-llm-stream-input').length, fixtureRequests: rows.filter(row => row.kind === 'fixture-provider-received-request').length,
    helperRequests: rows.filter(row => row.kind === 'fixture-provider-received-request' && textOf(row.messages[0]).startsWith('You are an optional memory-material assistant')).length,
    realModelRequests: 0, realPlatformLogins: 0, realPlatformSends: 0 };
  summary.ownerCarrier = 'Actual HostConnection shared Fetch with owner and non-owner peers';
  summary.scenario = { deepCreatedByActualPersonalityPatch: true, referenceOnly: true, automaticRecall: false, autonomousReinterpretationReplacementPruning: true, frozenContextPages: contextRows.length,
    helperAdvisoryOnly: true, socialProfilesSynthetic: true, socialExternalAdaptersImplemented: false, workerSessionSeparate: true, revokedCandidateFailed: true };
  await owner('instances.unload', {});
  check('sourceDigestsStillMatch', JSON.stringify(sourceDigests) === JSON.stringify(await digests())); summary.status = 'passed';

  function textOf(message) { return ((message?.message ?? message)?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n'); }
  function argsOf(data) { try { return typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments ?? {}; } catch { return {}; } }
  function actualContexts(rows) {
    const byRun = new Map();
    for (const row of rows) { const input = JSON.parse(textOf(row.messages.at(-1))), ctx = input.input.context; let stored = byRun.get(input.runId); if (!stored) { stored = { total: ctx.fragment.total, points: new Map() }; byRun.set(input.runId, stored); }
      Array.from(ctx.text).forEach((point, index) => { const position = ctx.fragment.from + index; if (stored.points.has(position) && stored.points.get(position) !== point) throw Error('Actual frozen context bytes changed'); stored.points.set(position, point); }); }
    return [...byRun.values()].filter(value => value.points.size === value.total).map(value => JSON.parse(Array.from({ length: value.total }, (_, index) => value.points.get(index)).join('')));
  }

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
