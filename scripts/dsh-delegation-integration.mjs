/** Real DSH SDK delegation integration. Fixed responses only; no production profile or model credentials.
 * node scripts/dsh-delegation-integration.mjs
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
if (args.help) { console.log('Usage: node scripts/dsh-delegation-integration.mjs [--install PATH] [--home NEW_PATH] [--artifacts PATH] [--prepare-only]\nAlways fixed-response fixture-only. DSH_TEST_INSTALL, DSH_TEST_HOME and DSH_TEST_ARTIFACTS supply matching defaults. A new isolated home is required; no production profile or model credentials are used. Missing Windows/DSH returns unsupported (exit 2).'); return; }
if (process.platform !== 'win32') throw unsupported('This installed-DSH integration entry currently supports Windows only.');
const install = resolve(args.install ?? process.env.DSH_TEST_INSTALL ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'DSH NEXT'));
const exe = join(install, 'DSH NEXT.exe');
try { await access(exe); await access(join(install, 'resources', 'app.asar')); } catch { throw unsupported('Installed DSH NEXT was not found. Set DSH_TEST_INSTALL to its install directory; no test or production profile was changed.'); }
const artifactRoot = resolve(args.artifacts ?? process.env.DSH_TEST_ARTIFACTS ?? join(source, 'work', 'dsh-delegation-integration'));
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
const options = { home, artifacts: dir, profile: 'persona-delegation-validation', fixtureOnly: true, realOnly: false, exe,
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
const harnessDigests=Object.fromEntries(await Promise.all(['scripts/dsh-delegation-integration.mjs','scripts/fixtures/delegation-fixture.mjs'].map(async name=>[name,createHash('sha256').update(await readFile(join(source,name))).digest('hex')])));
const workspace=join(dir,'workspace');await mkdir(workspace,{recursive:true});await writeFile(join(workspace,'input.txt'),'ACTUAL_WORKER_READ_BYTES 主体保真🙂');
await writeFile(join(dir,'executed-fixture.mjs'),await readFile(join(source,'scripts','fixtures','delegation-fixture.mjs')));
await writeFile(join(dir,'executed-runner.mjs'),await readFile(fileURLToPath(import.meta.url)));
const overlay = join(dir, 'test-overlay.yml');
await writeFile(overlay, JSON.stringify([
  { id: 'tools', config: { mode: 'native' } },
  { id: 'persona-memory-coordinator', config: { provider: 'persona-delegation-fixture', model: 'fixture-v1', operatorControl: true } },
  { insert: [{ id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'persona-memory' } },
    { id: 'persona-delegation-fixture-probe', name: pathToFileURL(join(dir, 'executed-fixture.mjs')).href, config: { artifacts: dir, workspace } }] },
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
async function until(check, timeout = 35000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await check(); if (value) return value; if (closed) throw new Error('Native SDK exited while waiting'); await sleep(70); } throw new Error('Native social fixture condition timed out'); }
let credentials;
async function control(path = '/snapshot', method = 'GET', data) {
  const response = await fetch(credentials.controlOrigin + path, { method, headers: { authorization: 'Bearer ' + credentials.controlToken, ...(data?{'content-type':'application/json'}:{}) }, ...(data?{body:JSON.stringify(data)}:{}), signal: AbortSignal.timeout(15000) });
  const value = await response.json(); if (!response.ok) throw new Error('Test control error ' + response.status + ' ' + JSON.stringify(value)); return value;
}
const summary = { status: 'running', startedAt: new Date().toISOString(), sourceDigests, harnessDigests, profile: options.profile,
  claims: { delegation:true, nativeDshEngine: true, deterministicFixture: true, realModel: false, productionProfileChanged: false, environmentCredentialsInherited: false }, checks: {} };
const check = (name, condition) => { summary.checks[name] = Boolean(condition); if (!condition) throw new Error('Check failed: ' + name); };
try {
  credentials = await until(() => readJson(join(dir, 'access.private.json')), 60000);
  const initialized = await rpc('initialize', { cwd: workspace, provider: 'persona-delegation-fixture', model: 'fixture-v1', maxTokens: 4096 });
  check('actualInstalledNativeSdkInitialized', initialized.serverInfo?.name === 'deepseek-harness-sdk-runtime');
  await control('/begin', 'POST', {});
  let snapshot = await until(async () => { const value = await control('/snapshot'); return value.tasks?.items?.length ? value : null; });
  const taskId = snapshot.tasks.items[0].taskId, workerSessionId = snapshot.tasks.items[0].sessionId;
  let task = await until(async () => { const value = await control('/task', 'POST', { taskId }); return value.status === 'completed' && value.capture?.complete && value.resultDocumentId ? value : null; }, 60000);
  snapshot = await control('/snapshot'); summary.task = { taskId, workerSessionId, status: task.status, capture: task.capture, documents: task.documents.length, actualWorkspace: task.workspace };
  const taskManifest = await readJson(join(memoryRoot + '.tasks', taskId, 'manifest.json'));
  summary.task.sourceRefCount = taskManifest.sourceRefs.length;
  summary.task.sourceRecordIdCount = taskManifest.sourceRecordIds.length;
  check('firstActualTurnDelegationKeepsItsRealHumanSourceDependency', taskManifest.sourceRefs.some(ref => ref.sourceSessionId === 'delegation_parent_fixture' && ref.sourceEventId === 'parent-original-human-message'));
  check('sameTurnMemorySearchDependenciesReachTaskManifest', taskManifest.sourceRecordIds.length > 0);
  let events = await readLines(join(dir, 'native-events.private.jsonl')), requests = await readLines(join(dir, 'requests.private.jsonl'));
  check('parentActuallyCalledPersonaTaskCreate', events.some(row => row.sessionId === 'delegation_parent_fixture' && row.event?.type === 'tool/call' && row.event.data.name === 'persona_task' && argsOfEvent(row.event.data).action === 'create'));
  const workerCreated = events.find(row => row.kind === 'agent-created' && row.sessionId === workerSessionId);
  check('nativeWorkerHasSeparateStableSession', workerCreated?.header.parentSession === 'delegation_parent_fixture' && workerCreated.header.isSeeded === false && workerCreated.header.agentPreset === 'xiangxu-task-worker');
  check('nativeInitialEnvelopeIsReallyUserAndWasNotRewrittenByFixture', events.some(row => row.sessionId === workerSessionId && row.event?.type === 'user/message' && row.event.data.source?.kind === 'user' && textEvent(row.event.data).includes('TASK_WORKER_PAYLOAD')));
  const workerRequests = requests.filter(row => row.kind === 'fixture-provider-received-request' && row.tools.includes('read') && !row.tools.includes('persona_task'));
  check('workerActuallyRanAgainstFixedProvider', workerRequests.length >= 3);
  check('workerDoesNotInheritPrivateParentContext', workerRequests.every(row => !JSON.stringify(row.messages).includes('PARENT_PRIVATE_ONLY')));
  check('workerHasNoPersonalityToolsOrProtocol', workerRequests.every(row => !row.tools.some(name => name.startsWith('persona_') || name.startsWith('memory_')) && !JSON.stringify(row.messages).includes('你有一份跨会话连续的记忆和共同人格')));
  check('workerCannotUseBareDelegationOrDirectParentMessages', workerRequests.every(row => !row.tools.some(name => ['subagent', 'subagent_fork', 'send_message', 'workflow'].includes(name))));
  check('workerReallyExecutedNativeReadAndWrite', ['read', 'write'].every(name => events.some(row => row.sessionId === workerSessionId && row.event?.type === 'tool/call' && row.event.data.name === name)));
  check('workerInitialInstructionNotAcceptedAsHumanMemory', !snapshot.memory.items.some(record => record.sourceSessionId === workerSessionId || (record.text ?? '').includes('TASK_WORKER_PAYLOAD')));
  const beforeReadParentRequests = requests.filter(row => row.tools.includes('persona_task'));
  check('fullReportDoesNotAutomaticallyReturnToParent', beforeReadParentRequests.every(row => !JSON.stringify(row.messages).includes('TASK_REPORT_FIRST_CHOSEN_INSIGHT')));
  check('noNativeSettlementFullTextWasSentToParent', !events.some(row => row.sessionId === 'delegation_parent_fixture' && row.event?.type === 'user/message' && ['subagent-settled', 'agent-message'].includes(row.event.data.source?.kind) && textEvent(row.event.data).includes('TASK_REPORT_FIRST_CHOSEN_INSIGHT')));
  async function readAll(documentId) { let text = '', offset = 0, expectedSha256; for (let i = 0; i < 300; i++) { const value = await control('/read', 'POST', { taskId, documentId, offset, maxChars: 5000, ...(expectedSha256 ? { expectedSha256 } : {}) }); expectedSha256 ??= value.sha256; text += value.text; if (value.complete) return { text, sha256: expectedSha256, pages: i + 1 }; if (value.nextOffset <= offset) throw Error('Archived Unicode cursor did not advance'); offset = value.nextOffset; } throw Error('Archive page safety limit exceeded'); }
  const full = await readAll(task.resultDocumentId); summary.report = { bytes: Buffer.byteLength(full.text), pages: full.pages, sha256: full.sha256 };
  check('fullClosingReportRetainedAndReadableWithoutTruncation', full.text.includes('TASK_REPORT_FIRST_CHOSEN_INSIGHT') && full.text.includes('TASK_REPORT_LAST_END') && full.pages > 2);
  const projected = await memoryText(); check('taskProcessesNotAutomaticallyCopiedIntoPersonaStore', !projected.includes('TASK_FULL_PROCESS_ONLY') && !projected.includes('TASK_REPORT_FIRST_CHOSEN_INSIGHT') && !projected.includes('TASK_WORKER_PAYLOAD'));
  const reportFile = await readFile(join(workspace, 'worker-report.txt'));
  const artifact = await control('/archive-file', 'POST', { taskId, path: 'worker-report.txt' });
  const artifactRead = await readAll(artifact.document.documentId);
  check('actualWorkerProducedFileWasSnapshottedByBytes', artifact.immutableSnapshot === true && createHash('sha256').update(reportFile).digest('hex') === artifact.document.sha256 && Buffer.from(artifactRead.text).equals(reportFile));
  await writeFile(join(workspace, 'worker-report.txt'), 'later workspace replacement');
  check('archivePreservesOriginalFileAfterWorkspaceChanges', (await readAll(artifact.document.documentId)).text === artifactRead.text);
  await control('/prompt', 'POST', { text: 'TASK_PARENT_READ ' + taskId });
  await until(async () => (await readLines(join(dir, 'native-events.private.jsonl'))).some(row => row.sessionId === 'delegation_parent_fixture' && row.event?.type === 'assistant/message' && textEvent(row.event.data.message).includes('TASK_PARENT_READ_ON_DEMAND')));
  requests = await readLines(join(dir, 'requests.private.jsonl'));
  check('parentReadsSelectedReportOnlyOnDemand', requests.filter(row => row.tools.includes('persona_task')).some(row => JSON.stringify(row.messages).includes('TASK_REPORT_FIRST_CHOSEN_INSIGHT')));
  check('boundedToolResponseConsumedByActualContinuationCalls', (await readLines(join(dir, 'native-events.private.jsonl'))).some(row => row.kind === 'fixture-consumed-complete-tool-response' && row.pages > 1));
  check('readingDoesNotAutomaticallyOfferReportToMemoryReview', !(await memoryText()).includes('TASK_REPORT_FIRST_CHOSEN_INSIGHT'));
  await control('/prompt', 'POST', { text: 'TASK_PARENT_RETAIN ' + taskId });
  await until(async () => (await readLines(join(dir, 'native-events.private.jsonl'))).some(row => row.sessionId === 'delegation_parent_fixture' && row.event?.type === 'assistant/message' && textEvent(row.event.data.message).includes('TASK_PARENT_RETAIN_SELECTED')));
  const retained = await memoryText(); check('parentCanSelectActualArchiveMaterialForItsOwnMemoryReview', retained.includes('TASK_REPORT_FIRST_CHOSEN_INSIGHT'));
  check('retainingSelectedPageDoesNotCopyTheUnselectedFullTail', !retained.includes('TASK_REPORT_LAST_END'));
  const personaBefore = (await control('/snapshot')).persona;
  let reviewRows = [];
  for (let increment = 0; increment < 8; increment++) {
    const existingJobs = new Set(Object.keys((await control('/snapshot')).runtime.execution?.consolidationJobs ?? {}));
    await control('/prompt', 'POST', { text: 'TASK_PARENT_REVIEW bounded increment ' + (increment + 1) });
    const job = await until(async () => {
      const current = await control('/snapshot');
      const created = Object.entries(current.runtime.execution?.consolidationJobs ?? {}).find(([id]) => !existingJobs.has(id));
      return created && ['completed', 'paused', 'invalidated'].includes(created[1].status) && current.scopes.every(scope => scope.status !== 'running') ? created[1] : null;
    }, 60000);
    if (job.status !== 'completed') throw Error('Actual bounded review did not commit: ' + JSON.stringify(job.error));
    summary.reviewIncrements = increment + 1;
    reviewRows = (await readLines(join(dir, 'native-events.private.jsonl'))).filter(row => row.kind === 'memory-review-input');
    if (reviewedMaterial(reviewRows).includes('TASK_REPORT_FIRST_CHOSEN_INSIGHT')) break;
  }
  check('autonomousReviewActuallyReceivesSelectedMaterial', reviewedMaterial(reviewRows).includes('TASK_REPORT_FIRST_CHOSEN_INSIGHT'));
  check('reviewDoesNotReceiveAllWorkerProcessByDefault', !reviewedMaterial(reviewRows).includes('TASK_REPORT_LAST_END'));
  await until(async () => (await control('/snapshot')).scopes.every(row => row.status !== 'running'));
  check('modelMayLeavePersonalityUnchangedAfterReview', JSON.stringify((await control('/snapshot')).persona) === JSON.stringify(personaBefore));
  const cycle = await control('/cycle', 'POST', { taskId });
  check('taskMetadataAndCompleteReportSurviveInstanceReload', cycle.task.status === 'completed' && cycle.task.resultDocumentId === task.resultDocumentId && cycle.task.capture.complete === true);
  check('immutableArtifactSurvivesReloadAndWorkspaceChanges', (await readAll(artifact.document.documentId)).sha256 === artifactRead.sha256);
  const forgotten = await control('/forget', 'POST', {}); summary.forget = { revocation: Boolean(forgotten.revocation), taskCleanup: forgotten.taskCleanup ?? null };
  check('explicitUnknownSourceSelectionActuallyCreatesRevocation', Boolean(forgotten.revocation) && forgotten.revocation.targetSrcRefs.some(ref => ref.sourceSessionId === 'delegation_parent_fixture' && ref.sourceEventId === 'parent-original-human-message'));
  check('explicitSourceForgetRevokesTheDependentTaskArchive', (await control('/snapshot')).tasks.items.find(item => item.taskId === taskId)?.status === 'revoked');
  const afterForget = await fetch(credentials.controlOrigin + '/read', { method: 'POST', headers: { authorization: 'Bearer ' + credentials.controlToken, 'content-type': 'application/json' }, body: JSON.stringify({ taskId, documentId: task.resultDocumentId, offset: 0, maxChars: 1000 }) });
  check('revokedTaskFullTextCannotBeReadBack', afterForget.status === 500 && (await afterForget.json()).error === 'TASK_SOURCE_REVOKED');
  const resumed = await control('/resume-revoked-worker', 'POST', { sessionId: workerSessionId });
  summary.revokedWorkerResume = { presetSwitch: resumed.presetSwitch };
  await until(async () => (await readLines(join(dir, 'native-events.private.jsonl'))).some(row => row.sessionId === workerSessionId && row.event?.type === 'assistant/message' && textEvent(row.event.data.message).includes('WORKER_REVOKED_ROLE_STAYS_TECHNICAL')));
  const resumedScope = (await control('/snapshot')).scopes.find(row => row.sessionId === workerSessionId);
  check('resumedRevokedWorkerRemainsOutsideSharedPersonalityAfterPresetSwitchAttempt', resumedScope && !resumedScope.attachedToPersona && !resumedScope.tools.some(name => name.startsWith('persona_') || name.startsWith('memory_') || ['send_message', 'subagent', 'subagent_fork', 'workflow'].includes(name)));
  check('revokedWorkerNativeUserEnvelopesStillNeverEnterPersonalityMemory', !(await memoryText()).includes('TASK_WORKER_PAYLOAD') && !(await memoryText()).includes('WORKER_RESUMED_REVOKED_IDENTITY'));
  requests = await readLines(join(dir, 'requests.private.jsonl'));
  check('onlyFixedFixtureModelWasUsed', requests.length > 0 && requests.every(row => row.provider === 'persona-delegation-fixture' && row.model === 'fixture-v1'));
  summary.observation = { hostRequests: requests.filter(row => row.kind === 'host-llm-stream-input').length, fixtureRequests: requests.filter(row => row.kind === 'fixture-provider-received-request').length, workerRequests: workerRequests.length, realModelRequests: 0 };
  await control('/unload', 'POST', {});
  check('sourceDigestsStillMatch', JSON.stringify(sourceDigests) === JSON.stringify(await digests())); summary.status = 'passed';

  function argsOfEvent(data) { try { return typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments ?? {}; } catch { return {}; } }
  function textEvent(message) { return (message?.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n'); }
  async function memoryText() { const text = []; async function walk(root) { for (const entry of await readdir(root, { withFileTypes: true })) { if (entry.isDirectory() && entry.name !== '.wal') await walk(join(root, entry.name)); else if (entry.isFile() && /\.jsonl?$/.test(entry.name)) text.push(await readFile(join(root, entry.name), 'utf8')); } } await walk(memoryRoot); return text.join('\n'); }

} catch (error) { summary.status = 'failed'; summary.error = { name: error.name, code: error.code ?? null, message: String(error.message) }; }
finally {
  try { if (!closed) await rpc('shutdown', {}, 15000); } catch {}
  child.stdin.end(); let timer; const ended = await Promise.race([exit, new Promise(resolve => { timer = setTimeout(() => resolve(null), 12000); })]); clearTimeout(timer);
  if (!ended) { child.kill(); summary.exit = await exit; summary.forcedExit = true; } else summary.exit = ended;
  if (summary.exit.code !== 0) summary.status = 'failed';
  summary.finishedAt = new Date().toISOString(); summary.checkCount = Object.keys(summary.checks).length;
  const redact = value => credentials?.controlToken ? value.replaceAll(credentials.controlToken, '[fixture-secret]') : value;
  summary.locks={};for(const [name,file] of Object.entries({core:join(memoryRoot,'writer.lock'),media:memoryRoot+'.media-assets/writer.lock',tasks:memoryRoot+'.tasks/writer.lock'})){try{await access(file);summary.locks[name]={remaining:true};summary.status='failed';}catch(error){if(error.code!=='ENOENT')throw error;summary.locks[name]={remaining:false};}}
  summary.writerLockRemaining=summary.locks.core.remaining;
  summary.sourceDigestsAfter=await digests();
  summary.sourceDigestsMatch=JSON.stringify(sourceDigests)===JSON.stringify(summary.sourceDigestsAfter);if(!summary.sourceDigestsMatch)summary.status='failed';
  await writeFile(join(dir, 'stdout.private.txt'), redact(stdout)); await writeFile(join(dir, 'stderr.txt'), redact(stderr));
  await writeFile(join(dir, 'result.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(join(dir, 'process.json'), JSON.stringify({ pid: child.pid, exited: closed, exit: summary.exit, forcedExit: summary.forcedExit ?? false, checkedAt: new Date().toISOString() }, null, 2) + '\n');
}
console.log(JSON.stringify({status:summary.status,artifactRoot:dir,home,checkCount:summary.checkCount,passedChecks:Object.values(summary.checks).filter(Boolean).length,error:summary.error,sourceDigestsMatch:summary.sourceDigestsMatch,exit:summary.exit,locks:summary.locks})); process.exitCode = summary.status === 'passed' ? 0 : 1;
}
await run().catch(error => { console.error(JSON.stringify({status:error.code === 'DSH_TEST_UNSUPPORTED' ? 'unsupported' : 'failed',code:error.code??error.name,message:error.message})); process.exitCode=error.code === 'DSH_TEST_UNSUPPORTED' ? 2 : 1; });
