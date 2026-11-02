import test from 'node:test';
import assert from 'node:assert/strict';
import { installWindowsAclBootstrap, effectiveElectronEnvironment } from '../adapters/dsh/compat/windows-acl.js';
import { decodeBootstrapEnvironment, ensureHiddenConsole, restoreElectronEnvironment,
  runWindowsAclBootstrap, trustedWindowsAclPaths } from '../adapters/dsh/compat/windows-acl-bootstrap.mjs';

const exe = 'C:\\host\\DSH NEXT.exe';
const entry = 'C:\\host\\resources\\app.asar\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js';
const prefix = [exe, entry];
const encode = original => Buffer.from(JSON.stringify({ version: 1, original })).toString('base64url');
function fixture(extra = {}) {
  const calls = [], handle = { done: Promise.resolve({ exitCode: 0 }), terminate() {} };
  const service = { spawn(spec) { calls.push({ self: this, spec }); return handle; } };
  const originalSpawn = service.spawn;
  const ctx = { subprocess: service, sandbox: { runnerCommand: [], internals: {}, windowsAclRunnerInvocation: () => prefix } };
  const runtime = { platform: 'win32', versions: { electron: '44.7.0' }, execPath: exe, env: {}, ...extra };
  const options = { runtime, exists: () => true };
  const spec = { argv: [...prefix, '--mode', 'read-only', '--', 'pwsh.exe'], cwd: 'C:\\work',
    stdio: { stdin: 'ignore', stdout: { maxBytes: 100 }, stderr: { maxBytes: 100 }, control: { fd: 3 } },
    signal: new AbortController().signal, graceMs: 500, env: { NO_COLOR: '1', REMOVED: undefined } };
  return { calls, handle, ctx, runtime, options, spec, originalSpawn };
}

test('shim preserves synchronous live handle, spec controls, argument boundaries and parent env', () => {
  const f = fixture(); f.spec.argv.push('中文 argument', 'literal;$x');
  const before = structuredClone(f.runtime.env), argv = [...f.spec.argv], env = { ...f.spec.env };
  const h = installWindowsAclBootstrap(f.ctx, f.options);
  assert.equal(h.installed, true);
  assert.equal(f.ctx.subprocess.spawn(f.spec), f.handle, 'not a promise or replacement handle');
  const out = f.calls[0].spec;
  assert.equal(f.calls[0].self, f.ctx.subprocess);
  assert.deepEqual(out.argv.slice(3), argv.slice(1));
  assert.match(out.argv[1], /windows-acl-bootstrap\.mjs$/);
  assert.equal(decodeBootstrapEnvironment(out.argv[2]), null);
  assert.equal(out.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(out.env.REMOVED, undefined);
  for (const key of ['cwd', 'stdio', 'signal', 'graceMs']) assert.equal(out[key], f.spec[key]);
  assert.deepEqual(f.spec.argv, argv); assert.deepEqual(f.spec.env, env); assert.deepEqual(f.runtime.env, before);
  h.dispose(); assert.equal(f.ctx.subprocess.spawn, f.originalSpawn);
});

test('non-Windows, non-Electron, unavailable service or missing host files do not install', () => {
  for (const runtime of [{ platform: 'linux' }, { versions: {} }]) {
    const f = fixture(runtime); assert.equal(installWindowsAclBootstrap(f.ctx, f.options).installed, false);
    assert.equal(f.ctx.subprocess.spawn, f.originalSpawn);
  }
  const f = fixture(); assert.equal(installWindowsAclBootstrap({}, f.options).installed, false);
  assert.equal(installWindowsAclBootstrap(f.ctx, { ...f.options, exists: () => false }).installed, false);
});

test('only exact built-in trusted prefix matches; custom or revised upstream runners remain untouched', () => {
  const f = fixture(); const h = installWindowsAclBootstrap(f.ctx, f.options);
  for (const argv of [['pwsh.exe', '-Command', 'hi'], [exe, 'C:\\user\\runner.js', '--'],
    [exe, entry + '.fake', '--'], ['C:\\other\\DSH NEXT.exe', entry, '--']]) {
    const spec = { ...f.spec, argv }; f.ctx.subprocess.spawn(spec); assert.equal(f.calls.at(-1).spec, spec);
  }
  f.ctx.sandbox.runnerCommand = ['custom']; f.ctx.subprocess.spawn(f.spec); assert.equal(f.calls.at(-1).spec, f.spec);
  f.ctx.sandbox.runnerCommand = []; f.ctx.sandbox.internals.windowsAclRunnerArgs = prefix;
  f.ctx.subprocess.spawn(f.spec); assert.equal(f.calls.at(-1).spec, f.spec);
  delete f.ctx.sandbox.internals.windowsAclRunnerArgs;
  f.ctx.sandbox.internals.windowsAclRunnerEntry = entry;
  f.ctx.subprocess.spawn(f.spec); assert.equal(f.calls.at(-1).spec, f.spec);
  delete f.ctx.sandbox.internals.windowsAclRunnerEntry;
  f.ctx.sandbox.windowsAclRunnerInvocation = () => ['C:\\node.exe', entry];
  f.ctx.subprocess.spawn(f.spec); assert.equal(f.calls.at(-1).spec, f.spec); h.dispose();
});

test('path matching accepts Windows casing and separators without trusting neighboring files', () => {
  const f = fixture(); f.spec.argv[0] = exe.toLowerCase(); f.spec.argv[1] = entry.toLowerCase().replaceAll('\\', '/');
  const h = installWindowsAclBootstrap(f.ctx, f.options); f.ctx.subprocess.spawn(f.spec);
  assert.notEqual(f.calls[0].spec, f.spec); h.dispose();
  assert.equal(trustedWindowsAclPaths(exe, entry + '-other'), null);
  assert.equal(trustedWindowsAclPaths(exe, 'C:\\else\\resources\\app.asar\\' + entry.split('app.asar\\')[1]), null);
});

test('upstream env-fixed calls are left intact including case-insensitive inherited flag', () => {
  for (const [parent, delta] of [[{}, { electron_run_as_node: '1' }], [{ ELECTRON_RUN_AS_NODE: '1' }, {}]]) {
    const f = fixture({ env: parent }); f.spec.env = delta;
    const h = installWindowsAclBootstrap(f.ctx, f.options); f.ctx.subprocess.spawn(f.spec);
    assert.equal(f.calls[0].spec, f.spec); h.dispose();
  }
});

test('environment casing, explicit values and undefined tombstones preserve target semantics', () => {
  assert.deepEqual(effectiveElectronEnvironment({ electron_run_as_node: 'old' }, { ELECTRON_RUN_AS_NODE: '0' }),
    { key: 'ELECTRON_RUN_AS_NODE', value: '0' });
  assert.equal(effectiveElectronEnvironment({ ELECTRON_RUN_AS_NODE: '1' }, { electron_run_as_node: undefined }), null);
  assert.deepEqual(effectiveElectronEnvironment({}, { ELECTRON_RUN_AS_NODE: 'x', electron_run_as_node: '' }),
    { key: 'electron_run_as_node', value: '' });
  for (const [parent, delta, expected] of [
    [{ electron_run_as_node: 'original' }, {}, { key: 'electron_run_as_node', value: 'original' }],
    [{ ELECTRON_RUN_AS_NODE: '1' }, { electron_run_as_node: undefined }, null],
    [{ ELECTRON_RUN_AS_NODE: 'old' }, { electron_run_as_node: '' }, { key: 'electron_run_as_node', value: '' }],
  ]) {
    const f = fixture({ env: parent }); f.spec.env = delta;
    const h = installWindowsAclBootstrap(f.ctx, f.options); f.ctx.subprocess.spawn(f.spec);
    const out = f.calls[0].spec;
    assert.deepEqual(decodeBootstrapEnvironment(out.argv[2]), expected);
    assert.deepEqual(Object.keys(out.env).filter(k => k.toUpperCase() === 'ELECTRON_RUN_AS_NODE'), ['ELECTRON_RUN_AS_NODE']);
    const childEnv = { untouched: 'yes', ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1' };
    restoreElectronEnvironment(childEnv, expected);
    assert.deepEqual(childEnv, { untouched: 'yes', ...(expected ? { [expected.key]: expected.value } : {}) });
    h.dispose();
  }
});

test('duplicate installation shares one wrapper and releases only after both owners dispose', () => {
  const f = fixture(), first = installWindowsAclBootstrap(f.ctx, f.options), wrapper = f.ctx.subprocess.spawn;
  const second = installWindowsAclBootstrap(f.ctx, f.options); assert.equal(f.ctx.subprocess.spawn, wrapper);
  f.ctx.subprocess.spawn(f.spec); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].spec.argv.length, f.spec.argv.length + 2);
  first.dispose(); first.dispose(); assert.equal(f.ctx.subprocess.spawn, wrapper);
  second.dispose(); assert.equal(f.ctx.subprocess.spawn, f.originalSpawn);
});

test('disposal restores inherited descriptor and does not clobber later wrappers', () => {
  const f = fixture(); const prototype = { spawn: f.originalSpawn }; Object.setPrototypeOf(f.ctx.subprocess, prototype);
  delete f.ctx.subprocess.spawn;
  const first = installWindowsAclBootstrap(f.ctx, f.options); first.dispose();
  assert.equal(Object.hasOwn(f.ctx.subprocess, 'spawn'), false);
  const second = installWindowsAclBootstrap(f.ctx, f.options), inner = f.ctx.subprocess.spawn;
  const later = function(spec) { return inner.call(this, spec); }; f.ctx.subprocess.spawn = later;
  second.dispose(); assert.equal(f.ctx.subprocess.spawn, later);
  f.ctx.subprocess.spawn(f.spec); assert.equal(f.calls.at(-1).spec, f.spec, 'disposed inner hook remains inert');
});

function nativeFixture(attached = false) {
  const calls = [];
  const api = { getConsoleCP() { return attached ? 65001 : 0; }, getStdHandle(id) { calls.push(['get', id]); return `pipe:${id}`; },
    allocConsole() { calls.push(['alloc']); return 1; }, getConsoleWindow() { return 'owned-window'; },
    showWindow(...args) { calls.push(['hide', ...args]); }, setStdHandle(...args) { calls.push(['restore', ...args]); return 1; },
    getLastError() { return 5; } };
  return { api, calls };
}

test('existing console is untouched; a new console is hidden and all stdio handles restored', () => {
  const current = nativeFixture(true); assert.deepEqual(ensureHiddenConsole(current.api), { allocated: false });
  assert.deepEqual(current.calls, []);
  const f = nativeFixture(); assert.deepEqual(ensureHiddenConsole(f.api), { allocated: true });
  assert.deepEqual(f.calls, [['get', -10], ['get', -11], ['get', -12], ['alloc'], ['hide', 'owned-window', 0],
    ['restore', -10, 'pipe:-10'], ['restore', -11, 'pipe:-11'], ['restore', -12, 'pipe:-12']]);
});

test('console failures fail closed and handle restoration still runs if hiding fails', () => {
  const f = nativeFixture(); f.api.allocConsole = () => 0;
  assert.throws(() => ensureHiddenConsole(f.api), /AllocConsole failed/);
  const g = nativeFixture(); g.api.showWindow = () => { throw new Error('hide failed'); };
  assert.throws(() => ensureHiddenConsole(g.api), /hide failed/);
  assert.equal(g.calls.filter(x => x[0] === 'restore').length, 3);
  const h = nativeFixture(); h.api.setStdHandle = id => { h.calls.push(['failed', id]); return 0; };
  assert.throws(() => ensureHiddenConsole(h.api), /SetStdHandle/);
  assert.equal(h.calls.filter(x => x[0] === 'failed').length, 3);
});

test('bootstrap restores env before original runner import and rebuilds argv without quoting loss', async () => {
  const f = nativeFixture(); const args = ['--workspace', 'C:\\路径 space', '--', 'pwsh.exe', 'literal;$x'];
  const runtime = { platform: 'win32', versions: { electron: '44' }, execPath: exe,
    argv: [exe, 'bootstrap.mjs', encode({ key: 'electron_run_as_node', value: 'original' }), entry, ...args],
    env: { ELECTRON_RUN_AS_NODE: '1', untouched: 'yes' } };
  let imported;
  const result = await runWindowsAclBootstrap({ runtime,
    loadConsoleBindings: async modulePath => { assert.match(modulePath, /dsh-win32-process/); assert.equal(runtime.env.electron_run_as_node, 'original'); return f.api; },
    importRunner: async url => { imported = url; assert.deepEqual(runtime.argv, [exe, entry, ...args]); } });
  assert.deepEqual(result, { allocated: true }); assert.match(imported, /runner\.js$/);
  assert.deepEqual(runtime.env, { untouched: 'yes', electron_run_as_node: 'original' });
});

test('bootstrap rejects invalid environment or untrusted entry before native loading', async () => {
  for (const value of ['', '!', Buffer.from('{}').toString('base64url'), encode({ key: 'OTHER_FLAG', value: '1' }),
    encode({ key: 'ELECTRON_RUN_AS_NODE', value: 1 })]) assert.throws(() => decodeBootstrapEnvironment(value));
  const runtime = { platform: 'win32', versions: { electron: '44' }, execPath: exe,
    argv: [exe, 'bootstrap.mjs', encode(null), 'C:\\user\\runner.js'], env: {} };
  await assert.rejects(runWindowsAclBootstrap({ runtime, loadConsoleBindings: async () => { throw new Error('must not load'); } }), /untrusted/);
});
