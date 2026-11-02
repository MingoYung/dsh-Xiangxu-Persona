import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ELECTRON_NODE_FLAG, sameWindowsPath, trustedWindowsAclPaths } from './windows-acl-bootstrap.mjs';

const installations = new WeakMap();
const bootstrapPath = fileURLToPath(new URL('./windows-acl-bootstrap.mjs', import.meta.url));

// Mirrors the host's Windows case-insensitive env-delta merge. An undefined
// tombstone removes an inherited value. No parent process.env writes occur.
export function effectiveElectronEnvironment(parent, delta) {
  let original = null;
  for (const [key, value] of Object.entries(parent ?? {})) {
    if (key.toUpperCase() === ELECTRON_NODE_FLAG && value !== undefined) original = { key, value };
  }
  for (const [key, value] of Object.entries(delta ?? {})) {
    if (key.toUpperCase() === ELECTRON_NODE_FLAG) original = value === undefined ? null : { key, value };
  }
  return original;
}

function compatibleInvocation(ctx, runtime, exists) {
  const sandbox = ctx.sandbox;
  if (!sandbox || typeof sandbox.windowsAclRunnerInvocation !== 'function'
    || sandbox.runnerCommand?.length || sandbox.internals?.windowsAclRunnerArgs !== undefined
    || sandbox.internals?.windowsAclRunnerEntry !== undefined) return null;
  let prefix;
  try { prefix = sandbox.windowsAclRunnerInvocation(); } catch { return null; }
  if (!Array.isArray(prefix) || prefix.length !== 2 || !sameWindowsPath(prefix[0], runtime.execPath)) return null;
  const paths = trustedWindowsAclPaths(runtime.execPath, prefix[1]);
  if (!paths || !exists(paths.runner) || !exists(paths.win32Module) || !exists(bootstrapPath)) return null;
  return prefix;
}

function inactive(reason) { return { installed: false, reason, dispose() {} }; }

/**
 * Install a synchronous, child-only compatibility shim on the native subprocess
 * service. Exact built-in ACL-prefix matching confines it to the affected Windows
 * Electron path. New upstream node runners, env-fixed calls and custom runners
 * pass through unchanged. Call dispose() with the owning coordinator lifecycle.
 * `runtime` and `exists` are deterministic zero-model test seams, never UI config.
 */
export function installWindowsAclBootstrap(ctx, { runtime = process, exists = existsSync } = {}) {
  if (runtime.platform !== 'win32' || !runtime.versions?.electron) return inactive('not-windows-electron');
  const subprocess = ctx?.subprocess;
  if (!subprocess || typeof subprocess.spawn !== 'function') return inactive('subprocess-unavailable');
  const previous = installations.get(subprocess);
  if (previous && subprocess.spawn === previous.wrapper) return acquire(previous);
  if (!compatibleInvocation(ctx, runtime, exists)) return inactive('trusted-builtin-runner-unavailable');
  const descriptor = Object.getOwnPropertyDescriptor(subprocess, 'spawn');
  const originalSpawn = subprocess.spawn;
  const state = { subprocess, descriptor, originalSpawn, references: 0, active: true, wrapper: null };
  state.wrapper = function spawnWithWindowsAclBootstrap(spec) {
    if (!state.active) return originalSpawn.call(this, spec);
    const prefix = compatibleInvocation(ctx, runtime, exists);
    const argv = spec?.argv;
    if (!prefix || !Array.isArray(argv) || argv.length < 3
      || !sameWindowsPath(argv[0], prefix[0]) || !sameWindowsPath(argv[1], prefix[1])) {
      return originalSpawn.call(this, spec);
    }
    const original = effectiveElectronEnvironment(runtime.env, spec.env);
    // An upstream caller explicitly starting Electron as Node owns its cleanup.
    // Never double-wrap it or presume to change its revised launch contract.
    if (original?.value === '1') return originalSpawn.call(this, spec);
    if (original !== null && typeof original.value !== 'string') return originalSpawn.call(this, spec);
    const env = Object.fromEntries(Object.entries(spec.env ?? {}).filter(([key]) => key.toUpperCase() !== ELECTRON_NODE_FLAG));
    env[ELECTRON_NODE_FLAG] = '1';
    const encoded = Buffer.from(JSON.stringify({ version: 1, original })).toString('base64url');
    return originalSpawn.call(this, {
      ...spec,
      argv: [argv[0], bootstrapPath, encoded, argv[1], ...argv.slice(2)],
      env,
    });
  };
  subprocess.spawn = state.wrapper;
  installations.set(subprocess, state);
  return acquire(state);
}

function acquire(state) {
  state.references++;
  let disposed = false;
  return {
    installed: true,
    reason: 'windows-electron-builtin-acl-bootstrap',
    dispose() {
      if (disposed) return;
      disposed = true;
      if (--state.references !== 0) return;
      state.active = false;
      // Another extension may wrap spawn after us; do not replace its function.
      if (state.subprocess.spawn === state.wrapper) {
        if (state.descriptor) Object.defineProperty(state.subprocess, 'spawn', state.descriptor);
        else delete state.subprocess.spawn;
      }
      if (installations.get(state.subprocess) === state) installations.delete(state.subprocess);
    },
  };
}
