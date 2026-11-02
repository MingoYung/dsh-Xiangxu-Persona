// Child-only Electron bootstrap for the built-in Windows ACL runner. The parent
// environment, runner policy, restricted token, Job and control pipe are intact.
import { createRequire } from 'node:module';
import { win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ELECTRON_NODE_FLAG = 'ELECTRON_RUN_AS_NODE';
const RUNNER_SUFFIX = 'node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js';
const WIN32_SUFFIX = 'node_modules/@deepseek-ai/dsh-win32-process/lib/index.js';

export function sameWindowsPath(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
}

// Deliberately limited to the built-in runner shipped beside this Electron exe.
// A custom runner, arbitrary user command or a standalone node.exe is untouched.
export function trustedWindowsAclPaths(execPath, entry) {
  if (typeof execPath !== 'string' || typeof entry !== 'string') return null;
  const base = win32.join(win32.dirname(execPath), 'resources', 'app.asar');
  const runner = win32.join(base, RUNNER_SUFFIX);
  if (!sameWindowsPath(runner, entry)) return null;
  return { runner: entry, win32Module: win32.join(base, WIN32_SUFFIX) };
}

export function restoreElectronEnvironment(env, original) {
  for (const key of Object.keys(env)) if (key.toUpperCase() === ELECTRON_NODE_FLAG) delete env[key];
  if (original !== null) env[original.key] = original.value;
}

export function decodeBootstrapEnvironment(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 32768 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('invalid bootstrap environment payload');
  }
  const data = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (!data || data.version !== 1 || !Object.hasOwn(data, 'original')) throw new Error('unsupported bootstrap payload');
  const original = data.original;
  if (original !== null && (!original || typeof original.key !== 'string'
    || original.key.toUpperCase() !== ELECTRON_NODE_FLAG || typeof original.value !== 'string')) {
    throw new Error('invalid original Electron environment');
  }
  return original;
}

// Electron is a GUI-subsystem executable even in Node mode. The native runner's
// restricted pwsh child needs a shared console to initialize its DLLs. Allocate
// only when this child has none; immediately hide it and restore the pipe handles
// AllocConsole replaces. Keep it alive until process exit, not just import end:
// the original runner's main() is asynchronous. No parent console is modified.
export function ensureHiddenConsole(api) {
  if (api.getConsoleCP() !== 0) return { allocated: false };
  const handles = [-10, -11, -12].map(id => [id, api.getStdHandle(id)]);
  if (!api.allocConsole()) throw new Error(`AllocConsole failed (${api.getLastError()})`);
  let restoreError;
  try {
    const window = api.getConsoleWindow();
    if (window) api.showWindow(window, 0);
  } finally {
    for (const [id, handle] of handles) {
      if (!api.setStdHandle(id, handle)) restoreError ??= new Error(`SetStdHandle(${id}) failed (${api.getLastError()})`);
    }
  }
  if (restoreError) throw restoreError;
  return { allocated: true };
}

async function consoleBindings(modulePath) {
  const hostUrl = pathToFileURL(modulePath);
  const requireHost = createRequire(hostUrl);
  const koffi = requireHost('koffi');
  const { extendWin32ProcessBindings } = await import(hostUrl.href);
  if (typeof extendWin32ProcessBindings !== 'function') throw new Error('host Win32 bindings are unavailable');
  const user32 = koffi.load('user32.dll');
  return extendWin32ProcessBindings(({ kernel32, bind }) => ({
    getConsoleCP: bind(kernel32, 'GetConsoleCP', 'uint32', []),
    getConsoleWindow: bind(kernel32, 'GetConsoleWindow', 'void *', []),
    allocConsole: bind(kernel32, 'AllocConsole', 'int', []),
    setStdHandle: bind(kernel32, 'SetStdHandle', 'int', ['int', 'void *']),
    showWindow: bind(user32, 'ShowWindow', 'int', ['void *', 'int']),
  }));
}

export async function runWindowsAclBootstrap({ runtime = process, loadConsoleBindings = consoleBindings,
  importRunner = url => import(url) } = {}) {
  if (runtime.platform !== 'win32' || !runtime.versions?.electron) throw new Error('Windows Electron bootstrap required');
  const [, , encoded, entry, ...args] = runtime.argv;
  const paths = trustedWindowsAclPaths(runtime.execPath, entry);
  if (!paths) throw new Error('untrusted Windows ACL runner entry');
  const original = decodeBootstrapEnvironment(encoded);
  restoreElectronEnvironment(runtime.env, original);
  const consoleState = ensureHiddenConsole(await loadConsoleBindings(paths.win32Module));
  runtime.argv = [runtime.execPath, entry, ...args];
  await importRunner(pathToFileURL(entry).href);
  return consoleState;
}

if (process.argv[1] && sameWindowsPath(fileURLToPath(import.meta.url), process.argv[1])) {
  try { await runWindowsAclBootstrap(); }
  catch (error) {
    process.stderr.write(`xiangxu-windows-acl-bootstrap: ${error?.message ?? String(error)}\n`);
    process.exitCode = 127;
  }
}
