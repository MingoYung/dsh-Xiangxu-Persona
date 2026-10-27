import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createSessionOwnershipStore, sessionOwnershipKey } from '../adapters/dsh/instance-lifecycle.js';

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'xiangxu-ownership-recovery-')));
  const file = path.join(base, 'instances.json.ownership.json'), memoryRoot = path.join(base, 'persona');
  await fs.mkdir(memoryRoot); await fs.writeFile(path.join(memoryRoot, 'keep.txt'), 'exact personality text');
  const item = { instanceId: 'default', memoryRoot }, store = createSessionOwnershipStore(file, () => [item]);
  await store.capture(item, ['retained-before-crash']);
  t.after(async () => { const realTemp = await fs.realpath(os.tmpdir()); assert.ok(path.resolve(base).startsWith(realTemp + path.sep + 'xiangxu-ownership-recovery-')); await fs.rm(base, { recursive: true, force: true }); });
  return { base, file, item, store, lock: file + '.lock', guard: file + '.lock.recovery' };
}

// This process uses the production store and pauses a real metadata write only
// after its ownership lock has been durably initialized. No user data or QQ.
async function worker(t, f) {
  const moduleUrl = new URL('../adapters/dsh/instance-lifecycle.js', import.meta.url).href;
  const source = `import {createSessionOwnershipStore} from ${JSON.stringify(moduleUrl)};
import {createRequire,syncBuiltinESMExports} from 'node:module';
const file=${JSON.stringify(f.file)},item=${JSON.stringify(f.item)},native=createRequire(import.meta.url)('node:fs/promises'),original=native.open;
let release,held=false;native.open=async(path,...args)=>{const handle=await original(path,...args);if(!held&&String(path).startsWith(file+'.next-')){held=true;process.send({kind:'outcome',status:'held',pid:process.pid});await new Promise(done=>{release=done;});}return handle;};syncBuiltinESMExports();
const store=createSessionOwnershipStore(file,()=>[item]);process.on('message',value=>{if(value==='go')void store.capture(item,['child-'+process.pid]).then(()=>process.send({kind:'result',status:'captured'})).catch(error=>process.send({kind:'outcome',status:'error',code:error.code,ownerPid:error.ownerPid,ownerState:error.ownerState}));else if(value==='release')release?.();});process.send({kind:'ready',pid:process.pid});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const messages = [], waiters = []; let stderr = '';
  child.stderr.on('data', data => { stderr += data.toString().slice(0, 2000); });
  child.on('message', value => { const index = waiters.findIndex(x => x.kind === value.kind); if (index < 0) messages.push(value); else { const [entry] = waiters.splice(index, 1); clearTimeout(entry.timer); entry.resolve(value); } });
  function wait(kind) { const index = messages.findIndex(x => x.kind === kind); if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]); return new Promise((resolve, reject) => {
    const entry = { kind, resolve, timer: setTimeout(() => { const at = waiters.indexOf(entry); if (at >= 0) waiters.splice(at, 1); reject(Error('Isolated ownership worker timed out: ' + kind + ' ' + stderr)); }, 7000) }; waiters.push(entry);
  }); }
  async function kill() { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  t.after(kill); await wait('ready'); return { child, wait, kill, send: value => child.send(value), get pid() { return child.pid; } };
}

async function crash(t, f) {
  const owner = await worker(t, f); owner.send('go'); assert.equal((await owner.wait('outcome')).status, 'held');
  const bytes = await fs.readFile(f.lock); assert.equal(JSON.parse(bytes).pid, owner.pid);
  await owner.kill(); assert.throws(() => process.kill(owner.pid, 0), { code: 'ESRCH' }); return { owner, bytes };
}

async function noGuard(f) { await assert.rejects(fs.lstat(f.guard), { code: 'ENOENT' }); }
async function keepPersonality(f) { assert.equal(await fs.readFile(path.join(f.item.memoryRoot, 'keep.txt'), 'utf8'), 'exact personality text'); }

test('an actual ownership writer crash is recovered on normal capture without changing retained owners or personality text', { timeout: 15000 }, async t => {
  const f = await fixture(t), before = JSON.parse(await fs.readFile(f.file, 'utf8')), { bytes } = await crash(t, f);
  assert.deepEqual(await fs.readFile(f.lock), bytes); assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), before);
  const cold = createSessionOwnershipStore(f.file, () => [f.item]); await cold.capture(f.item, ['fresh-after-crash']);
  const after = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.equal(after.owners[sessionOwnershipKey('retained-before-crash')], 'default');
  assert.equal(after.owners[sessionOwnershipKey('fresh-after-crash')], 'default');
  assert.equal(Object.keys(after.owners).length, 2); assert.equal(after.version, before.version + 1);
  await assert.rejects(fs.lstat(f.lock), { code: 'ENOENT' }); await noGuard(f); await keepPersonality(f);
});

test('two recovering processes admit one writer and the loser cannot remove its new live lock', { timeout: 20000 }, async t => {
  const f = await fixture(t); await crash(t, f); const a = await worker(t, f), b = await worker(t, f);
  a.send('go'); b.send('go'); const results = await Promise.all([a.wait('outcome'), b.wait('outcome')]);
  assert.equal(results.filter(x => x.status === 'held').length, 1); assert.equal(results.filter(x => x.status === 'error' && x.code === 'INSTANCE_OWNERSHIP_BUSY').length, 1);
  const winner = results[0].status === 'held' ? a : b, current = await fs.readFile(f.lock);
  assert.equal(JSON.parse(current).pid, winner.pid); process.kill(winner.pid, 0);
  await assert.rejects(f.store.capture(f.item, ['later-contender']), error => error.code === 'INSTANCE_OWNERSHIP_BUSY' && error.ownerPid === winner.pid && error.ownerState === 'alive');
  assert.deepEqual(await fs.readFile(f.lock), current);
  winner.send('release'); assert.equal((await winner.wait('result')).status, 'captured');
  await assert.rejects(fs.lstat(f.lock), { code: 'ENOENT' }); await noGuard(f); await keepPersonality(f);
});

test('live PID, malformed owner and an abnormal recovery guard are preserved byte for byte', async t => {
  const f = await fixture(t), variants = [JSON.stringify({ pid: process.pid, token: randomUUID() }), '', '{broken', JSON.stringify({ pid: 0, token: randomUUID() }), JSON.stringify({ pid: -1, token: randomUUID() }), JSON.stringify({ pid: String(process.pid), token: randomUUID() }), JSON.stringify({ pid: process.pid, token: 'invalid' }), JSON.stringify({ pid: process.pid, token: randomUUID(), extra: true }), 'x'.repeat(4097)];
  const before = await fs.readFile(f.file);
  for (const value of variants) {
    await fs.writeFile(f.lock, value);
    await assert.rejects(f.store.capture(f.item, ['must-not-attach']), { code: 'INSTANCE_OWNERSHIP_BUSY' });
    assert.equal(await fs.readFile(f.lock, 'utf8'), value); assert.deepEqual(await fs.readFile(f.file), before); await noGuard(f);
  }
  await fs.unlink(f.lock); await fs.writeFile(f.guard, 'unverified recovery');
  await assert.rejects(f.store.capture(f.item, ['guard-blocked']), { code: 'INSTANCE_OWNERSHIP_BUSY' });
  assert.equal(await fs.readFile(f.guard, 'utf8'), 'unverified recovery'); await assert.rejects(fs.lstat(f.lock), { code: 'ENOENT' }); await keepPersonality(f);
});

test('EPERM or PID reuse during the second confirmation never turns an unknown owner into a dead owner', { timeout: 15000 }, async t => {
  const f = await fixture(t), { owner, bytes } = await crash(t, f), original = process.kill;
  try {
    process.kill = (pid, signal) => { if (pid === owner.pid && signal === 0) throw Object.assign(Error('unverifiable'), { code: 'EPERM' }); return original(pid, signal); };
    await assert.rejects(f.store.capture(f.item, ['unknown']), error => error.code === 'INSTANCE_OWNERSHIP_BUSY' && error.ownerPid === owner.pid && error.ownerState === 'unknown');
    assert.deepEqual(await fs.readFile(f.lock), bytes); await noGuard(f);
    let checks = 0;
    process.kill = (pid, signal) => { if (pid === owner.pid && signal === 0) { if (++checks === 1) throw Object.assign(Error('old process gone'), { code: 'ESRCH' }); return true; } return original(pid, signal); };
    await assert.rejects(f.store.capture(f.item, ['reused-pid']), error => error.code === 'INSTANCE_OWNERSHIP_BUSY' && error.ownerState === 'alive');
    assert.equal(checks, 2); assert.deepEqual(await fs.readFile(f.lock), bytes); await noGuard(f);
  } finally { process.kill = original; }
});

test('a lock replaced between snapshots is preserved and cannot authorize recovery', { timeout: 15000 }, async t => {
  const f = await fixture(t); await crash(t, f);
  const native = createRequire(import.meta.url)('node:fs/promises'), original = native.open, replacement = JSON.stringify({ pid: process.pid, token: randomUUID() }); let reads = 0;
  native.open = async (file, ...args) => {
    if (String(file) === f.lock && args[0] === 'r' && ++reads === 2) { await fs.rename(f.lock, f.lock + '.old'); await fs.writeFile(f.lock, replacement); }
    return original(file, ...args);
  }; syncBuiltinESMExports();
  try { await assert.rejects(f.store.capture(f.item, ['replaced']), { code: 'INSTANCE_OWNERSHIP_BUSY' }); }
  finally { native.open = original; syncBuiltinESMExports(); }
  assert.equal(await fs.readFile(f.lock, 'utf8'), replacement); await noGuard(f); await keepPersonality(f);
});

test('an ordinary wx winner after stale unlink is never reaped or retried', { timeout: 15000 }, async t => {
  const f = await fixture(t); await crash(t, f);
  const native = createRequire(import.meta.url)('node:fs/promises'), original = native.open, replacement = JSON.stringify({ pid: process.pid, token: randomUUID() }); let creates = 0;
  native.open = async (file, ...args) => {
    if (String(file) === f.lock && args[0] === 'wx' && ++creates === 2) { const winner = await original(file, 'wx'); await winner.writeFile(replacement); await winner.close(); }
    return original(file, ...args);
  }; syncBuiltinESMExports();
  try { await assert.rejects(f.store.capture(f.item, ['lost-create-race']), { code: 'INSTANCE_OWNERSHIP_BUSY' }); }
  finally { native.open = original; syncBuiltinESMExports(); }
  assert.equal(creates, 2); assert.equal(await fs.readFile(f.lock, 'utf8'), replacement); await noGuard(f); await keepPersonality(f);
});

test('hardlinked or redirected ownership lock paths are never reclaimed', { timeout: 15000 }, async t => {
  const f = await fixture(t), external = path.join(f.base, 'external'); await fs.mkdir(external); await fs.writeFile(path.join(external, 'keep'), 'untouched');
  await fs.symlink(external, f.lock, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.store.capture(f.item, ['link']), { code: 'INSTANCE_OWNERSHIP_BUSY' });
  assert.equal((await fs.lstat(f.lock)).isSymbolicLink(), true); assert.equal(await fs.readFile(path.join(external, 'keep'), 'utf8'), 'untouched'); await noGuard(f);
  await fs.unlink(f.lock); const { bytes } = await crash(t, f), linked = path.join(f.base, 'hardlink'); await fs.link(f.lock, linked);
  await assert.rejects(f.store.capture(f.item, ['hardlink']), { code: 'INSTANCE_OWNERSHIP_BUSY' });
  assert.deepEqual(await fs.readFile(f.lock), bytes); assert.deepEqual(await fs.readFile(linked), bytes); await noGuard(f);
});

test('release checks its own file identity and token, preserving a replacement lock', async t => {
  const f = await fixture(t), native = createRequire(import.meta.url)('node:fs/promises'), original = native.open;
  const replacement = JSON.stringify({ pid: process.pid, token: randomUUID() }); let replaced = false;
  native.open = async (file, ...args) => {
    const handle = await original(file, ...args);
    if (!replaced && String(file).startsWith(f.file + '.next-')) { replaced = true; await fs.rename(f.lock, f.lock + '.old'); await fs.writeFile(f.lock, replacement); }
    return handle;
  }; syncBuiltinESMExports();
  try { await f.store.capture(f.item, ['committed-before-replacement']); }
  finally { native.open = original; syncBuiltinESMExports(); }
  assert.equal(replaced, true); assert.equal(await fs.readFile(f.lock, 'utf8'), replacement);
  assert.equal(await f.store.ownerOf('committed-before-replacement'), 'default'); await noGuard(f); await keepPersonality(f);
});

test('recovery guard initialization failure preserves the dead lock and a later normal attempt can recover', { timeout: 15000 }, async t => {
  const f = await fixture(t), { bytes } = await crash(t, f), native = createRequire(import.meta.url)('node:fs/promises'), original = native.open;
  native.open = async (file, ...args) => {
    const handle = await original(file, ...args);
    if (String(file) !== f.guard || args[0] !== 'wx') return handle;
    return new Proxy(handle, { get(target, key) { if (key === 'writeFile') return async () => { throw Object.assign(Error('isolated guard disk fault'), { code: 'ENOSPC' }); }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  }; syncBuiltinESMExports();
  try { await assert.rejects(f.store.capture(f.item, ['not-committed']), { code: 'ENOSPC' }); }
  finally { native.open = original; syncBuiltinESMExports(); }
  assert.deepEqual(await fs.readFile(f.lock), bytes); await noGuard(f);
  await f.store.capture(f.item, ['recovered-after-disk-fault']); assert.equal(await f.store.ownerOf('recovered-after-disk-fault'), 'default');
  assert.equal(await f.store.ownerOf('not-committed'), null); await assert.rejects(fs.lstat(f.lock), { code: 'ENOENT' }); await noGuard(f);
});

test('metadata failure after recovery releases the new lock without changing the old ownership ledger', { timeout: 15000 }, async t => {
  const f = await fixture(t); await crash(t, f); const before = await fs.readFile(f.file), native = createRequire(import.meta.url)('node:fs/promises'), original = native.open;
  native.open = async (file, ...args) => {
    const handle = await original(file, ...args);
    if (!String(file).startsWith(f.file + '.next-')) return handle;
    return new Proxy(handle, { get(target, key) { if (key === 'writeFile') return async () => { throw Object.assign(Error('isolated metadata disk fault'), { code: 'ENOSPC' }); }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  }; syncBuiltinESMExports();
  try { await assert.rejects(f.store.capture(f.item, ['not-committed']), { code: 'ENOSPC' }); }
  finally { native.open = original; syncBuiltinESMExports(); }
  assert.deepEqual(await fs.readFile(f.file), before); await assert.rejects(fs.lstat(f.lock), { code: 'ENOENT' }); await noGuard(f); await keepPersonality(f);
  await f.store.capture(f.item, ['fresh-retry']); assert.equal(await f.store.ownerOf('retained-before-crash'), 'default'); assert.equal(await f.store.ownerOf('fresh-retry'), 'default');
});

test('a failed recovery-guard release cannot strand the newly acquired live ownership lock', { timeout: 15000 }, async t => {
  const f = await fixture(t); await crash(t, f); const before = await fs.readFile(f.file), native = createRequire(import.meta.url)('node:fs/promises'), original = native.unlink;
  native.unlink = async file => { if (String(file) === f.guard) throw Object.assign(Error('isolated guard release fault'), { code: 'EACCES' }); return original(file); }; syncBuiltinESMExports();
  try { await assert.rejects(f.store.capture(f.item, ['not-admitted']), { code: 'EACCES' }); }
  finally { native.unlink = original; syncBuiltinESMExports(); }
  assert.deepEqual(await fs.readFile(f.file), before); await assert.rejects(fs.lstat(f.lock), { code: 'ENOENT' });
  assert.equal(JSON.parse(await fs.readFile(f.guard, 'utf8')).pid, process.pid, 'Unreleased guard remains fail-closed for operator inspection'); await keepPersonality(f);
});
