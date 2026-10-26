import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createInstanceManager } from '../adapters/dsh/instances.js';
import { JsonStore } from '../core/store.js';
import { createChannelService } from '../adapters/dsh/channels/service.js';
import { INSTANCE_LIMITS, sessionOwnershipKey, createSessionOwnershipStore, writeInstanceMetadata, acquireClearGate } from '../adapters/dsh/instance-lifecycle.js';

async function fixture(t, options = {}) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const base = await fs.realpath(await fs.mkdtemp(path.join(temporaryRoot, 'xiangxu-lifecycle-')));
  const root = path.join(base, 'memory'), registryPath = path.join(base, 'instances.json');
  const opened = [], stopped = [], maintenance = []; let busy = false, clock = Date.now(), flush = false;
  const createCoordinator = config => {
    const store = new JsonStore(config.memoryRoot), agents = new Map(); let closed = false;
    const coordinator = { memoryRoot: config.memoryRoot, agents, runtime: {}, store,
      ready: (async () => { await store.open(); if (!await store.readJson('config.json')) await store.transaction({ json: {
        'config.json': { schemaVersion: 'persona-memory/3' }, 'self/persona.json': { text: '人格原文' },
        'global/state.json': { version: 0 }, 'host-checkpoints.json': { sessions: {} },
      } }); })(),
      repository: { getRuntime: async () => ({ execution: { consolidationJobs: {} } }) },
      attachAgent: async agent => { await options.onFixtureAttach?.(agent, coordinator); agents.set(agent.id, { agent }); return { attached: true }; },
      readyState: async () => ({ loaded: true }),
      async close() { if (closed) return; await coordinator.ready; await options.onFixtureClose?.(coordinator); if (flush) await store.transaction({ json: { 'global/state.json': { stoppedAt: clock } } }); await store.close(); closed = true; stopped.push(config.memoryRoot); },
    }; opened.push(coordinator); return coordinator;
  };
  const settings = { initialRoot: root, registryPath, createCoordinator, lifecycleClock: () => clock,
    isBusy: () => busy, beforeMaintenance: async (kind, item) => maintenance.push({ kind, instanceId: item.instanceId }), ...options };
  const manager = createInstanceManager(settings), managers = [manager]; await manager.ready;
  t.after(async () => { for (const value of managers) await value.close().catch(() => {}); for (const value of opened) await value.close().catch(() => {});
    const resolved = path.resolve(base), prefix = path.resolve(temporaryRoot) + path.sep;
    assert.ok(resolved.startsWith(prefix) && path.basename(resolved).startsWith('xiangxu-lifecycle-'));
    await fs.rm(resolved, { recursive: true, force: true }); });
  return { base, root, registryPath, manager, opened, stopped, maintenance, settings, track: value => { managers.push(value); return value; },
    tick: amount => { clock += amount; }, busy: value => { busy = value; }, flush: value => { flush = value; } };
}
async function files(root) {
  const found = [];
  async function visit(directory) { for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name); if (entry.isDirectory()) await visit(file); else found.push([path.relative(root, file), await fs.readFile(file, 'utf8')]); } }
  await visit(root); return found.sort((a, b) => a[0].localeCompare(b[0]));
}
async function clearNow(manager, instanceId = 'default') {
  const value = await manager.clearPreview({ instanceId });
  return manager.clear({ instanceId, confirmationToken: value.confirmationToken, typedName: value.requiresName });
}

test('archive stops, retains exact text, rejects load and survives restart; explicit restore reattaches the same sessions', async t => {
  const f = await fixture(t), agent = { id: 'old-agent', session: { id: 'old-session' } };
  await f.manager.attachAgent(agent); const before = (await files(f.root)).filter(([name]) => name !== 'writer.lock');
  const result = await f.manager.archive({ instanceId: 'default' });
  assert.equal(result.activeInstanceId, null); assert.ok(result.items[0].archivedAt); assert.equal(result.items[0].retiredSessionCount, 1);
  assert.deepEqual(await files(f.root), before); await assert.rejects(f.manager.load(), { code: 'INSTANCE_RETIRED' });
  await f.manager.close();
  const cold = f.track(createInstanceManager(f.settings)); await cold.ready;
  assert.equal(cold.current, null); assert.equal(await cold.canAttachAgent(agent, f.root), false);
  await cold.restore({ instanceId: 'default', activate: false }); assert.equal(cold.current, null);
  await cold.load(); assert.deepEqual(await cold.attachAgent(agent), { attached: true });
});

test('preview is readonly and lists precise text scope and excluded sidecars; active clear deletes only listed text', async t => {
  const f = await fixture(t), external = path.join(f.base, 'work.png'), secret = path.join(f.base, 'accounts.json');
  await fs.writeFile(external, 'image'); await fs.writeFile(secret, 'credentials');
  const before = await files(f.root), preview = await f.manager.clearPreview();
  assert.deepEqual(await files(f.root), before); assert.equal(f.stopped.length, 0); assert.equal(f.maintenance.length, 0);
  assert.equal(preview.files, before.filter(([name]) => name !== 'writer.lock').length);
  assert.equal(typeof preview.bytes, 'number'); assert.ok(preview.scope.some(value => value.includes('文本')));
  assert.ok(preview.excluded.some(value => value.includes('账号'))); assert.ok(preview.excluded.some(value => value.includes('备份')));
  const receipt = await f.manager.clear({ confirmationToken: preview.confirmationToken, typedName: preview.requiresName });
  assert.equal(receipt.status, 'cleared'); assert.equal(receipt.remainingFiles, 0); assert.deepEqual(await files(f.root), []);
  assert.equal(await fs.readFile(external, 'utf8'), 'image'); assert.equal(await fs.readFile(secret, 'utf8'), 'credentials');
  assert.deepEqual(f.maintenance.map(value => value.kind), ['clear']);
  await assert.rejects(f.manager.load({ memoryRoot: f.root }), { code: 'INSTANCE_RETIRED' });
  await assert.rejects(f.manager.select({ instanceId: 'default' }), { code: 'INSTANCE_RETIRED' });
});

test('wrong names, expired tokens, data changes and disk registry changes each reject with zero deletion', async t => {
  const f = await fixture(t); let preview = await f.manager.clearPreview(), before = await files(f.root);
  await assert.rejects(f.manager.clear({ confirmationToken: preview.confirmationToken, typedName: preview.requiresName + ' ' }), { code: 'INSTANCE_CLEAR_NAME' });
  assert.deepEqual(await files(f.root), before); f.tick(INSTANCE_LIMITS.previewTtlMs + 1);
  await assert.rejects(f.manager.clear({ confirmationToken: preview.confirmationToken, typedName: preview.requiresName }), { code: 'INSTANCE_CLEAR_CONFIRMATION' });
  preview = await f.manager.clearPreview(); await f.manager.current.store.transaction({ json: { 'self/persona.json': { text: '新原文' } } }); before = await files(f.root);
  await assert.rejects(f.manager.clear({ confirmationToken: preview.confirmationToken, typedName: preview.requiresName }), { code: 'INSTANCE_CLEAR_STALE' });
  assert.deepEqual(await files(f.root), before);
  preview = await f.manager.clearPreview(); await fs.writeFile(f.registryPath, JSON.stringify({ differentOwner: true }));
  await assert.rejects(f.manager.clear({ confirmationToken: preview.confirmationToken, typedName: preview.requiresName }), { code: 'INSTANCE_CLEAR_STALE' });
  assert.deepEqual(await files(f.root), before); assert.equal(f.stopped.length, 0);
});

test('unknown sentinel files and directories block the whole clear before any deletion', async t => {
  const f = await fixture(t), sentinel = path.join(f.root, 'precious.json'); await fs.writeFile(sentinel, 'not owned');
  let before = await files(f.root); await assert.rejects(f.manager.clearPreview(), { code: 'INSTANCE_CLEAR_UNKNOWN_FILE' }); assert.deepEqual(await files(f.root), before);
  await fs.unlink(sentinel); await fs.mkdir(path.join(f.root, 'unknown')); before = await files(f.root);
  await assert.rejects(f.manager.clearPreview(), { code: 'INSTANCE_CLEAR_UNKNOWN_FILE' }); assert.deepEqual(await files(f.root), before); assert.equal(f.stopped.length, 0);
});

test('symlink or junction children and overlapping registered instance roots block before deleting originals', async t => {
  const f = await fixture(t), external = path.join(f.base, 'outside'); await fs.mkdir(external); await fs.writeFile(path.join(external, 'keep.txt'), 'keep');
  await fs.symlink(external, path.join(f.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.manager.clearPreview(), { code: 'INSTANCE_PATH' }); assert.equal(await fs.readFile(path.join(external, 'keep.txt'), 'utf8'), 'keep');
  await fs.unlink(path.join(f.root, 'alias'));
  await f.manager.load({ memoryRoot: path.join(f.root, 'nested'), name: '嵌套人格' });
  await assert.rejects(f.manager.clearPreview({ instanceId: 'default' }), { code: 'INSTANCE_ROOT_OVERLAP' });
  assert.equal(await fs.readFile(path.join(f.root, 'self/persona.json'), 'utf8').then(JSON.parse).then(value => value.text), '人格原文');
});

test('old sessions persist as hashed ownership after text deletion and never attach to a newly created personality', async t => {
  const f = await fixture(t), old = { id: 'agent-one', session: { id: 'sensitive-session-one' } };
  await f.manager.attachAgent(old); await f.manager.current.store.transaction({ json: { 'host-checkpoints.json': { sessions: { 'checkpoint-only': 9 } } } });
  await clearNow(f.manager); const ownership = await fs.readFile(f.registryPath + '.ownership.json', 'utf8');
  assert.ok(!ownership.includes(old.session.id)); assert.equal(JSON.parse(ownership).owners[sessionOwnershipKey(old.session.id)], 'default');
  assert.equal(JSON.parse(ownership).owners[sessionOwnershipKey('checkpoint-only')], 'default');
  const result = await f.manager.create({ name: '全新人格' }); assert.notEqual(result.activeInstanceId, 'default'); assert.notEqual(f.manager.memoryRoot, f.root);
  assert.deepEqual(await f.manager.attachAgent(old), { status: 'different_instance' });
  assert.deepEqual(await f.manager.attachAgent({ id: 'another', session: { id: 'checkpoint-only' } }), { status: 'different_instance' });
  assert.deepEqual(await f.manager.attachAgent({ id: 'fresh', session: { id: 'fresh-session' } }), { attached: true });
  await f.manager.close(); const cold = f.track(createInstanceManager(f.settings)); await cold.ready;
  assert.deepEqual(await cold.attachAgent(old), { status: 'different_instance' });
});

test('busy targets and failed maintenance authorization delete nothing and keep the active coordinator', async t => {
  const f = await fixture(t); const preview = await f.manager.clearPreview(), before = await files(f.root); f.busy(true);
  await assert.rejects(f.manager.clear({ confirmationToken: preview.confirmationToken, typedName: preview.requiresName }), { code: 'INSTANCE_BUSY' });
  assert.deepEqual(await files(f.root), before); assert.ok(f.manager.current); assert.equal(f.maintenance.length, 0);
  const denied = await fixture(t, { beforeMaintenance: async () => { throw Object.assign(new Error('port denied'), { code: 'PORT_FAILED' }); } });
  await assert.rejects(clearNow(denied.manager), { code: 'PORT_FAILED' }); assert.ok(denied.manager.current); assert.ok((await files(denied.root)).length > 0);
});

test('clear of inactive instance does not stop a different active personality', async t => {
  const f = await fixture(t); await f.manager.create({ name: '第二人格' }); const active = f.manager.current, stopCount = f.stopped.length;
  const result = await clearNow(f.manager, 'default'); assert.equal(result.status, 'cleared'); assert.equal(f.manager.current, active); assert.equal(f.stopped.length, stopCount);
});

test('close-flushed receipts invalidate the original confirmation without deletion, then a fresh stopped preview succeeds', async t => {
  const f = await fixture(t); f.flush(true); const preview = await f.manager.clearPreview();
  await assert.rejects(f.manager.clear({ confirmationToken: preview.confirmationToken, typedName: preview.requiresName }), error => error.code === 'INSTANCE_CLEAR_STALE' && error.message.includes('已停用'));
  assert.equal(f.manager.current, null); assert.equal((await f.manager.listInstances()).autoLoad, false);
  assert.ok((await files(f.root)).some(([name]) => name === 'self\\persona.json' || name === 'self/persona.json'));
  assert.equal((await clearNow(f.manager)).status, 'cleared');
});

test('partial Windows-style file lock failure remains stopped, survives restart and can only resume with a new clear preview', async t => {
  let locked = true; const f = await fixture(t, { lifecycleUnlink: async file => { if (locked && file.endsWith('persona.json')) throw Object.assign(new Error('busy'), { code: 'EPERM' }); return fs.unlink(file); } });
  const result = await clearNow(f.manager); assert.equal(result.status, 'partial'); assert.ok(result.remainingFiles > 0); assert.ok(result.errors.some(value => value.code === 'EPERM')); assert.equal(f.manager.current, null);
  await assert.rejects(f.manager.load(), { code: 'INSTANCE_RETIRED' }); await assert.rejects(f.manager.restore({ instanceId: 'default' }), { code: 'INSTANCE_RETIRED' });
  await f.manager.close(); const cold = f.track(createInstanceManager(f.settings)); await cold.ready;
  assert.equal(cold.current, null); assert.equal((await cold.listInstances()).items[0].clearStatus, 'partial');
  locked = false; assert.equal((await clearNow(cold)).status, 'cleared');
});

test('cleared tombstones do not consume the 16 available live personality slots or revive after a restart', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 17; i++) { const id = (await f.manager.listInstances()).activeInstanceId; assert.equal((await clearNow(f.manager, id)).status, 'cleared'); await f.manager.create({ name: '人格 ' + i }); }
  const result = await f.manager.listInstances(); assert.equal(result.counts.live, 1); assert.equal(result.counts.cleared, 17);
  await assert.rejects(f.manager.load({ memoryRoot: f.root }), { code: 'INSTANCE_RETIRED' });
  await f.manager.close(); const cold = f.track(createInstanceManager(f.settings)); await cold.ready;
  assert.notEqual(cold.memoryRoot, f.root); await assert.rejects(cold.load({ memoryRoot: f.root }), { code: 'INSTANCE_RETIRED' });
});

test('ownership technical capacity rejects before deleting any text rather than discarding old session ownership', async t => {
  const f = await fixture(t); await fs.writeFile(f.registryPath + '.ownership.json', ' '.repeat(INSTANCE_LIMITS.ownershipBytes + 1));
  const before = await files(f.root); await assert.rejects(clearNow(f.manager), { code: 'INSTANCE_METADATA_CAPACITY' }); assert.deepEqual(await files(f.root), before); assert.ok(f.manager.current);
});

test('cleared metadata is bounded separately, all roots stay protected while only the latest 20 tombstones are listed', async t => {
  const f = await fixture(t); await f.manager.close();
  const registry = { schemaVersion: 'persona-instances/1', version: 1, selectedInstanceId: 'default', autoLoad: true, items: [
    { instanceId: 'default', name: '相续人格', memoryRoot: f.root },
    ...Array.from({ length: INSTANCE_LIMITS.cleared }, (_, i) => ({ instanceId: 'retired-' + i, name: '已清除' + i, memoryRoot: path.join(f.base, 'retired-' + i), clearStatus: 'cleared', clearedAt: new Date().toISOString() })),
  ] };
  await fs.writeFile(f.registryPath, JSON.stringify(registry)); const cold = f.track(createInstanceManager(f.settings)); await cold.ready;
  const result = await cold.listInstances(); assert.equal(result.counts.cleared, 256); assert.equal(result.counts.live, 1); assert.equal(result.items.length, 21); assert.equal(result.clearedListComplete, false);
  const before = await files(f.root); await assert.rejects(clearNow(cold), { code: 'INSTANCE_REGISTRY_CAPACITY' }); assert.deepEqual(await files(f.root), before);
  await assert.rejects(cold.load({ memoryRoot: path.join(f.base, 'retired-0') }), { code: 'INSTANCE_RETIRED' });
});

test('maintenance gate blocks a new store writer during exact-file removal', async t => {
  let blocked = false; const f = await fixture(t, { lifecycleUnlink: async file => {
    const probe = new JsonStore(f.root); await assert.rejects(probe.open(), { code: 'MEMORY_MAINTENANCE' }); blocked = true; await probe.close(); return fs.unlink(file);
  } });
  assert.equal((await clearNow(f.manager)).status, 'cleared'); assert.equal(blocked, true);
});

test('unknown files appearing on stop persist the unloaded state and preserve every approved text file', async t => {
  const f = await fixture(t, { onStopping: async coordinator => { await fs.writeFile(path.join(coordinator.memoryRoot, 'unknown-from-host.txt'), 'external'); } });
  const before = (await files(f.root)).filter(([name]) => name !== 'writer.lock');
  await assert.rejects(clearNow(f.manager), { code: 'INSTANCE_CLEAR_UNKNOWN_FILE' });
  assert.equal(f.manager.current, null); assert.equal(JSON.parse(await fs.readFile(f.registryPath, 'utf8')).autoLoad, false);
  assert.deepEqual((await files(f.root)).filter(([name]) => name !== 'unknown-from-host.txt'), before);
});

test('a remaining foreign writer blocks clear without stopping an unrelated active instance', async t => {
  const f = await fixture(t); await f.manager.create({ name: '第二人格' });
  const writer = new JsonStore(f.root); await writer.open();
  try { const active = f.manager.current, before = await files(f.root); await assert.rejects(clearNow(f.manager), { code: 'INSTANCE_WRITER_ACTIVE' });
    assert.equal(f.manager.current, active); assert.deepEqual(await files(f.root), before); }
  finally { await writer.close(); }
});

test('parallel agent creation serializes real ownership writes and preserves every admitted session', async t => {
  const f = await fixture(t), agents = Array.from({ length: 16 }, (_, i) => ({ id: 'agent-' + i, session: { id: 'parallel-session-' + i } }));
  const results = await Promise.all(agents.map(agent => f.manager.attachAgent(agent)));
  assert.deepEqual(results, agents.map(() => ({ attached: true }))); assert.equal(f.manager.agents.size, 16);
  const ledger = JSON.parse(await fs.readFile(f.registryPath + '.ownership.json', 'utf8'));
  for (const agent of agents) assert.equal(ledger.owners[sessionOwnershipKey(agent.session.id)], 'default');
  assert.equal(Object.keys(ledger.owners).length, 16); await assert.rejects(fs.lstat(f.registryPath + '.ownership.json.lock'), { code: 'ENOENT' });
});

test('an in-flight attach completes in its original instance before switching and cannot leak into the new personality', async t => {
  let release, entered; const barrier = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { onFixtureAttach: async () => { entered(); await barrier; } }), old = f.manager.current;
  const agent = { id: 'original-agent', session: { id: 'original-session' } }, attaching = f.manager.attachAgent(agent); await started;
  let switched = false; const switching = f.manager.create({ name: '新人格' }).then(result => { switched = true; return result; });
  await Promise.resolve(); assert.equal(switched, false); assert.equal(f.manager.current, old); release(); await attaching; await switching;
  assert.equal(old.agents.has(agent.id), true); assert.equal(f.manager.agents.has(agent.id), false);
  assert.deepEqual(await f.manager.attachAgent(agent), { status: 'different_instance' });
});

test('the ownership store serializes its own callers, recovers after a rejected item and still refuses an external lock', async t => {
  const f = await fixture(t), ownerFile = path.join(f.base, 'independent-ownership.json'), item = { instanceId: 'first', memoryRoot: f.root };
  const store = createSessionOwnershipStore(ownerFile, () => [item]);
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.capture(item, ['owned-' + i])));
  assert.equal(Object.keys(JSON.parse(await fs.readFile(ownerFile, 'utf8')).owners).length, 12);
  await assert.rejects(store.capture({ ...item, instanceId: 'other' }, ['owned-0']), { code: 'INSTANCE_SESSION_CONFLICT' });
  await store.capture(item, ['after-rejection']);
  const external = JSON.stringify({ pid: process.pid, token: 'external-owner' }); await fs.writeFile(ownerFile + '.lock', external);
  await assert.rejects(store.capture(item, ['blocked']), { code: 'INSTANCE_OWNERSHIP_BUSY' }); assert.equal(await fs.readFile(ownerFile + '.lock', 'utf8'), external);
  await fs.unlink(ownerFile + '.lock'); await store.capture(item, ['after-external-release']);
});

test('failed metadata writes and lock initialization clean only their own incomplete files and keep old metadata intact', async t => {
  const f = await fixture(t), require = createRequire(import.meta.url), native = require('node:fs/promises'), original = native.open;
  const target = path.join(f.base, 'fault-metadata.json'); await fs.writeFile(target, '{"original":true}');
  async function failWrite(predicate, work) {
    native.open = async (file, ...args) => { const handle = await original(file, ...args); if (!predicate(String(file))) return handle;
      return new Proxy(handle, { get(object, key) {
        if (key === 'writeFile') return async () => { throw Object.assign(new Error('injected disk full'), { code: 'ENOSPC' }); };
        const value = Reflect.get(object, key); return typeof value === 'function' ? value.bind(object) : value;
      } }); };
    syncBuiltinESMExports(); try { await assert.rejects(work(), { code: 'ENOSPC' }); } finally { native.open = original; syncBuiltinESMExports(); }
  }
  await failWrite(file => file.startsWith(target + '.next-'), () => writeInstanceMetadata(target, { replaced: true }, 65536));
  assert.equal(await fs.readFile(target, 'utf8'), '{"original":true}'); assert.deepEqual((await fs.readdir(f.base)).filter(name => name.includes('.next-')), []);
  const gatePath = path.join(f.base, '.memory.maintenance.lock'); await failWrite(file => file === gatePath, () => acquireClearGate(f.root));
  await assert.rejects(fs.lstat(gatePath), { code: 'ENOENT' }); const gate = await acquireClearGate(f.root); await gate.release();
  const ownerFile = path.join(f.base, 'fault-ownership.json'), item = { instanceId: 'default', memoryRoot: f.root }, owner = createSessionOwnershipStore(ownerFile, () => [item]);
  await failWrite(file => file === ownerFile + '.lock', () => owner.capture(item, ['session'])); await assert.rejects(fs.lstat(ownerFile + '.lock'), { code: 'ENOENT' });
  await owner.capture(item, ['session']); assert.equal(await owner.ownerOf('session'), 'default');
});

test('a real channel ingress can finish its host attachment while archive drains the channel queue', async t => {
  let channels, shuttingDown = false, enteredCreate, allowAttach, enteredStop, cancelAttach;
  const createEntered = new Promise(resolve => { enteredCreate = resolve; }), attachAllowed = new Promise(resolve => { allowAttach = resolve; });
  const stopEntered = new Promise(resolve => { enteredStop = resolve; }), abortAttach = new Promise((_, reject) => { cancelAttach = reject; });
  const f = await fixture(t, { onStopping: async () => { if (!shuttingDown) { enteredStop(); await channels.suspend(); } } });
  let disk = null;
  channels = createChannelService({ getCoordinator: () => f.manager.current, port: 0,
    storage: { read: async () => disk, write: async value => { disk = structuredClone(value); } },
    clientFactory: () => ({ probe: async () => ({ connected: true, capabilities: { text: true, group: true } }) }),
    channelPort: {
      async create(binding) { enteredCreate(); await attachAllowed;
        await Promise.race([f.manager.attachAgent({ id: binding.sessionId, session: { id: binding.sessionId } }), abortAttach]); return binding; },
      async send() { return { status: 'accepted' }; }, async close() {},
    } });
  await channels.ready; let incoming, archiving, timer;
  try {
    await channels.configure({ id: 'qq', config: { apiUrl: 'http://127.0.0.1:12345', accountId: '100', accessToken: 'isolated', allowedPrivateIds: ['*'], allowedGroupIds: ['*'], voiceMode: 'text' } });
    const invite = await channels.rotateIngress({ id: 'qq' }), status = await channels.start({ id: 'qq' }), url = status.connections[0].callbackUrl;
    incoming = fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + invite.ingressToken },
      body: JSON.stringify({ post_type: 'message', message_type: 'private', self_id: 100, user_id: 11, sender: { user_id: 11 }, message_id: 1,
        time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: '隔离队列交错验证' } }] }) }).then(response => response.json());
    await createEntered; archiving = f.manager.archive({ instanceId: 'default' }); await stopEntered; allowAttach();
    const result = await Promise.race([Promise.all([incoming, archiving]), new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500); })]);
    if (!result) cancelAttach(new Error('isolated deadlock cancellation'));
    await Promise.allSettled([incoming, archiving]); assert.ok(result, 'channel drain must not wait behind its own lifecycle queue');
    assert.equal(result[0].status, 'accepted'); assert.equal(result[1].activeInstanceId, null);
    const ledger = JSON.parse(await fs.readFile(f.registryPath + '.ownership.json', 'utf8'));
    assert.equal(Object.values(ledger.owners).filter(value => value === 'default').length, 1);
  } finally { clearTimeout(timer); allowAttach(); cancelAttach(new Error('isolated cleanup')); shuttingDown = true; await channels.close(); }
});

test('new direct attachments cannot enter after channel drain closes the attachment gate for clear', async t => {
  let closingEntered, allowClose;
  const entered = new Promise(resolve => { closingEntered = resolve; }), barrier = new Promise(resolve => { allowClose = resolve; });
  const f = await fixture(t, { onFixtureClose: async () => { closingEntered(); await barrier; } });
  const clearing = clearNow(f.manager); await entered;
  try {
    const agent = { id: 'too-late', session: { id: 'too-late-session' } };
    assert.equal(await f.manager.canAttachAgent(agent, f.root), false);
    assert.deepEqual(await f.manager.attachAgent(agent), { status: 'unloaded' }); assert.equal(f.manager.agents.has(agent.id), false);
  } finally { allowClose(); }
  assert.equal((await clearing).status, 'cleared');
  await f.manager.create({ name: '之后的新实例' });
});
