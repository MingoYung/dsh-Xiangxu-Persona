// Opt-in native component probe: no desktop CLI, account, model or profile. Run
// this file with the installed DSH Electron exe in ELECTRON_RUN_AS_NODE=1 mode.
// This exercises shipped subprocess/windows-job, built-in ACL runner and pwsh argv
// components; it does not claim a complete Cordis/SDK application integration.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installWindowsAclBootstrap } from '../adapters/dsh/compat/windows-acl.js';

if (process.platform !== 'win32' || !process.versions.electron) {
  throw new Error('Run with the DSH Electron executable in Node mode; no application/profile is started.');
}
const option = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const allowed = resolve('C:/XiangxuCoreTest/reliability');
const parent = resolve(option('--root') ?? allowed);
if (parent !== allowed && !parent.toLowerCase().startsWith(allowed.toLowerCase() + '\\')) {
  throw new Error('Probe root must stay inside C:/XiangxuCoreTest/reliability');
}
await mkdir(parent, { recursive: true });
const root = await mkdtemp(join(parent, 'product-acl-probe-'));
const workspace = join(root, 'workspace'), temp = join(root, 'temp');
await mkdir(workspace); await mkdir(temp);
const resultFile = join(root, 'receipt.json');
const hostModule = name => pathToFileURL(join(dirname(process.execPath), 'resources/app.asar/node_modules/@deepseek-ai', name, 'lib/index.js')).href;
const [{ LocalSubprocessRuntime }, { LocalSandboxProvider }, { PwshLocalExecutor, resolvePwshPath }] = await Promise.all([
  import(hostModule('dsh-subprocess-local')), import(hostModule('dsh-sandbox-local')), import(hostModule('dsh-pwsh-local')),
]);
// Only this standalone probe process had the launch flag; no ambient flag should
// be inherited by commands after the compatibility bootstrap has run.
for (const key of Object.keys(process.env)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete process.env[key];
const pwsh = resolvePwshPath(option('--pwsh'));
const subprocess = Object.create(LocalSubprocessRuntime.prototype);
Object.assign(subprocess, { internals: {}, live: new Set(), controlChannels: new Set(), terminals: new Set(),
  reportSpillFailure: () => {}, fallbackWarningIssued: false });
Object.defineProperty(subprocess, 'ctx', { value: { logger: { debug() {}, warn(message) { process.stderr.write(message + '\n'); } } } });
const sandbox = Object.create(LocalSandboxProvider.prototype);
Object.assign(sandbox, { internals: {}, runnerCommand: [] });
const runnerPrefix = sandbox.windowsAclRunnerInvocation();
const compat = installWindowsAclBootstrap({ subprocess, sandbox });
assert.equal(compat.installed, true, compat.reason);
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const inside = join(workspace, '中文输出.txt'), outside = join(root, 'outside-must-deny.txt');
const observations = [];
const receipt = { at: new Date().toISOString(), kind: 'native component probe; not full SDK integration',
  realModelCalls: 0, root, exe: process.execPath, node: process.versions.node, electron: process.versions.electron,
  pwsh, runnerPrefix, observations };
async function run(name, mode, command, { allowReadOnlyEncodingWarning = false, env } = {}) {
  const shellArgv = PwshLocalExecutor.prototype.argv.call({ pwshPath: pwsh }, { command });
  const argv = [...runnerPrefix, '--workspace', workspace, '--temp', temp, '--mode', mode, '--', ...shellArgv];
  const selected = subprocess.selectContainmentMode('ordinary');
  assert.equal(selected, 'windows-job', 'no fallback process containment accepted');
  const spec = { argv, cwd: workspace, graceMs: 1000, ...(env === undefined ? {} : { env }),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 32768 }, stderr: { maxBytes: 32768 } } };
  const started = Date.now(), handle = subprocess.spawn(spec);
  assert.equal(typeof handle.then, 'undefined', 'native live-handle API remains synchronous');
  const timer = setTimeout(() => handle.terminate(), 20000);
  let outcome;
  try { outcome = await handle.done; await handle.waitForExit(); } finally { clearTimeout(timer); }
  const row = { name, mode, containment: selected, durationMs: Date.now() - started, ...outcome,
    stdout: handle.collected.stdout.finalize(), stderr: handle.collected.stderr.finalize() };
  observations.push(row);
  await writeFile(resultFile, JSON.stringify(receipt, null, 2));
  assert.equal(row.exitCode, 0, JSON.stringify(row));
  if (allowReadOnlyEncodingWarning) {
    assert.ok(row.stderr.text.split(/\r?\n/).filter(Boolean).every(line =>
      /^InvalidOperation: Cannot create type\. Only core types are supported in this language mode\.$/.test(line)), JSON.stringify(row));
    row.readOnlyHostEncodingPreambleWarnings = row.stderr.text.split(/\r?\n/).filter(Boolean).length;
  } else assert.equal(row.stderr.text, '', JSON.stringify(row));
  return row.stdout.text;
}
try {
  const out = await run('write, UTF-8 output/file, no bootstrap env leakage, outside write denied', 'workspace-write',
    `$ErrorActionPreference='Stop'; Write-Output 'XIANGXU_PRODUCT_ACL_OK'; Write-Output ('NODE_FLAG=' + [string]$env:ELECTRON_RUN_AS_NODE); `
    + `[IO.File]::WriteAllText(${literal(inside)},'保真✓',[Text.UTF8Encoding]::new($false)); Write-Output ([IO.File]::ReadAllText(${literal(inside)},[Text.Encoding]::UTF8)); `
    + `try { [IO.File]::WriteAllText(${literal(outside)},'should-deny'); Write-Output 'UNEXPECTED_WRITE'; exit 9 } catch [UnauthorizedAccessException] { Write-Output 'OUTSIDE_DENIED_OK' }`);
  assert.match(out, /XIANGXU_PRODUCT_ACL_OK/); assert.match(out, /NODE_FLAG=\r?\n/);
  assert.match(out, /保真✓/); assert.match(out, /OUTSIDE_DENIED_OK/);
  assert.equal(await readFile(inside, 'utf8'), '保真✓');
  await assert.rejects(stat(outside), error => error.code === 'ENOENT');
  const read = await run('read-only rejects write without changing persisted file', 'read-only',
    `$ErrorActionPreference='Stop'; Write-Output ('LANGUAGE_MODE=' + $ExecutionContext.SessionState.LanguageMode); try { Set-Content -LiteralPath ${literal(inside)} -Value 'should-deny' -ErrorAction Stop; Write-Output 'UNEXPECTED_WRITE'; exit 9 } catch { Write-Output ('READONLY_DENIED_OK=' + $_.Exception.Message) }`,
    { allowReadOnlyEncodingWarning: true });
  assert.match(read, /READONLY_DENIED_OK=Access to the path .* is denied\./); assert.equal(await readFile(inside, 'utf8'), '保真✓');
  const original = await run('explicit target Electron flag remains original, never injected 1', 'workspace-write',
    `Write-Output ('ORIGINAL_FLAG=' + [string]$env:ELECTRON_RUN_AS_NODE)`, { env: { electron_run_as_node: 'native-original' } });
  assert.match(original, /ORIGINAL_FLAG=native-original/);
  receipt.passed = true;
  receipt.limitations = ['Read-only ACL forbids temporary writes. PowerShell enters ConstrainedLanguage; the unchanged host UTF-8 preamble emits constructor errors. Built-in read/write-denial verification still passes; no ACL or language policy is relaxed.'];
  receipt.assertions = { nativeWindowsJob: true, realPowerShellSentinel: true, utf8OutputAndFile: true,
    noBootstrapFlagLeak: true, explicitOriginalFlagPreserved: true, outsideDenied: true, readOnlyDenied: true, syncLiveHandle: true };
} catch (error) {
  receipt.passed = false; receipt.error = error?.stack ?? String(error); throw error;
} finally {
  compat.dispose();
  await writeFile(resultFile, JSON.stringify(receipt, null, 2));
  process.stdout.write(JSON.stringify({ resultFile, passed: receipt.passed, realModelCalls: 0 }) + '\n');
}
