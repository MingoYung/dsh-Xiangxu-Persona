import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSocialIdentityService, SOCIAL_IDENTITY_LIMITS } from '../adapters/dsh/social-identities.js';

function memory() { let data = null, writes = 0, failure = false; return { async read() { return structuredClone(data); }, async write(value) { if (failure) throw Object.assign(new Error('private storage diagnostic'), { code: 'EIO' }); data = structuredClone(value); writes++; }, get value() { return structuredClone(data); }, get writes() { return writes; }, fail(value) { failure = value; } }; }
function fixture(options = {}) {
  const store = options.storage ?? memory(), roots = { a: resolve('isolated-social-a'), b: resolve('isolated-social-b') }; let active = 'a', timestamp = 100;
  const status = { qq: { accountId: 'bot-A', connected: false }, wechat: { accountId: 'wechat-A', connected: false } };
  const channels = { qq: { accountId: 'bot-A', connected: false, mode: 'official', items: [{ id: 'chat.text', supported: true, available: false }, { id: 'feed.publish', supported: false }] }, wechat: { accountId: 'wechat-A', connected: false, mode: 'official', items: [{ id: 'chat.text', supported: true, available: false }] } };
  const grants = { qq: { accountId: 'bot-A', items: [{ id: 'chat.text', supported: true, allowed: true, available: false }] }, wechat: { accountId: 'wechat-A', items: [{ id: 'chat.text', supported: true, allowed: false, available: false }] } };
  const coordinator = id => ({ memoryRoot: roots[id], ready: Promise.resolve() });
  const ports = { storage: store, getCoordinator: id => ['a', 'b'].includes(id ?? active) ? coordinator(id ?? active) : null,
    getConnectionStatus: async id => structuredClone(status[id]), getChannelCapabilities: async id => structuredClone(channels[id]),
    getPermissionStatus: async id => structuredClone(grants[id]), clock: () => timestamp, ...options };
  const service = createSocialIdentityService(ports);
  return { service, ports, store, status, channels, grants, roots, use(id) { active = id; }, tick() { timestamp++; }, online(id = 'qq') { status[id].connected = true; channels[id].connected = true; for (const item of channels[id].items) item.available = item.supported; for (const item of grants[id].items) item.available = item.allowed; } };
}

test('an empty identity directory does not connect, register or grant capabilities while browsing', async t => {
  let calls = 0; const f = fixture({ getConnectionStatus: async () => { calls++; }, getChannelCapabilities: async () => { calls++; } }); t.after(() => f.service.close());
  const value = await f.service.inspect(); assert.equal(value.items.length, 0); assert.equal(f.store.writes, 0); assert.equal(calls, 0);
  assert.deepEqual(value.limits, SOCIAL_IDENTITY_LIMITS); assert.equal(value.executionGrantedByRegistration, false);
  assert.equal(value.platforms.find(x => x.id === 'qq').adapterAvailable, true); assert.equal(value.platforms.find(x => x.id === 'douyin').adapterAvailable, false);
});

test('a manual creator profile persists without claiming authentication or a platform implementation', async t => {
  const f = fixture(); let service = f.service; t.after(() => service.close());
  const saved = await service.upsert({ platform: 'bilibili', accountId: '123456', displayName: '相续自己的频道', profileUrl: 'https://space.bilibili.com/123456', notes: '用户准备的创作身份' });
  assert.match(saved.item.identityId, /^social-[a-f0-9]{32}$/); assert.equal(saved.item.bindingSource, 'manual');
  assert.equal(saved.item.connection.verification, 'unverified'); assert.equal(saved.item.connection.status, 'unsupported'); assert.deepEqual(saved.item.capabilities, []);
  assert.equal(saved.item.memoryRoot, undefined); await service.close(); service = createSocialIdentityService(f.ports);
  assert.equal((await service.list()).items[0].displayName, '相续自己的频道'); assert.equal(f.store.value.items[0].platform, 'bilibili');
});

test('metadata updates preserve omitted fields, explicitly clear fields, and avoid unchanged writes', async t => {
  const f = fixture(); t.after(() => f.service.close());
  await f.service.upsert({ platform: 'douyin', accountId: 'creator', displayName: '原名', notes: '保留备注', profileUrl: 'https://www.douyin.com/user/creator', avatarUrl: 'https://example.org/avatar.png' });
  f.tick(); const changed = await f.service.upsert({ platform: 'douyin', accountId: 'creator', displayName: '新名' }); assert.equal(changed.item.notes, '保留备注'); assert.equal(changed.item.profileUrl, 'https://www.douyin.com/user/creator');
  const count = f.store.writes; f.tick(); assert.equal((await f.service.upsert({ platform: 'douyin', accountId: 'creator', displayName: '新名' })).changed, false); assert.equal(f.store.writes, count);
  const clear = await f.service.upsert({ platform: 'douyin', accountId: 'creator', displayName: '', notes: '', profileUrl: '', avatarUrl: null }); assert.equal(clear.item.displayName, ''); assert.equal(clear.item.notes, ''); assert.equal(clear.item.profileUrl, null); assert.equal(clear.item.avatarUrl, null);
});

test('owner input cannot forge verification, credentials, memory roots or capability grants', async t => {
  const f = fixture(); t.after(() => f.service.close());
  for (const key of ['verified', 'verification', 'connected', 'accessToken', 'token', 'memoryRoot', 'capabilities', 'bindingSource', 'identityId']) {
    assert.throws(() => f.service.upsert({ platform: 'qq', accountId: 'bot-A', [key]: 'private-forgery' }), { code: 'SOCIAL_INVALID' });
  }
  assert.equal(f.store.writes, 0); assert.equal((await f.service.list()).items.length, 0);
});

test('identical platform accounts are separate identity records for each actual persona root', async t => {
  const f = fixture(); t.after(() => f.service.close());
  const first = await f.service.upsert({ platform: 'qq', accountId: 'bot-A', displayName: '人格甲' }); f.use('b');
  assert.equal((await f.service.list()).items.length, 0); const second = await f.service.upsert({ platform: 'qq', accountId: 'bot-A', displayName: '人格乙' });
  assert.notEqual(first.item.identityId, second.item.identityId); await assert.rejects(f.service.inspect({ identityId: first.item.identityId }), { code: 'SOCIAL_NOT_FOUND' });
  await assert.rejects(f.service.remove({ identityId: first.item.identityId }), { code: 'SOCIAL_NOT_FOUND' });
  f.use('a'); assert.equal((await f.service.list()).items[0].displayName, '人格甲'); assert.equal(f.store.value.items.length, 2);
});

test('linkCurrent requires an actual connected matching account rather than a saved credential flag', async t => {
  const f = fixture(); t.after(() => f.service.close());
  await assert.rejects(f.service.linkCurrent({ platform: 'qq' }), { code: 'SOCIAL_ACCOUNT_UNVERIFIED' }); assert.equal(f.store.writes, 0);
  f.online(); f.channels.qq.accountId = 'other'; await assert.rejects(f.service.linkCurrent({ platform: 'qq' }), { code: 'SOCIAL_ACCOUNT_UNVERIFIED' }); assert.equal(f.store.writes, 0);
  f.channels.qq.accountId = 'bot-A'; const saved = await f.service.linkCurrent({ platform: 'qq', displayName: '独立机器人' });
  assert.equal(saved.item.accountId, 'bot-A'); assert.equal(saved.item.bindingSource, 'current_connection'); assert.equal(saved.item.connection.verification, 'verified'); assert.equal(saved.item.connection.credentialReference, 'connection:qq');
  assert.equal(saved.item.capabilities.find(x => x.id === 'chat.text').available, true); assert.equal(saved.item.capabilities.find(x => x.id === 'feed.publish').status, 'unsupported');
});

test('account switches invalidate live status and never carry another account permission into the old record', async t => {
  const f = fixture(); f.online(); t.after(() => f.service.close());
  await f.service.linkCurrent({ platform: 'qq' }); f.status.qq.accountId = 'bot-B'; f.channels.qq.accountId = 'bot-B'; f.grants.qq.accountId = 'bot-B';
  const old = (await f.service.inspect()).items[0]; assert.equal(old.accountId, 'bot-A'); assert.equal(old.connection.status, 'account_changed'); assert.equal(old.connection.verification, 'unverified'); assert.equal(old.capabilities[0].available, false); assert.equal(old.capabilities[0].allowed, null);
});

test('support, current transport and user permission are independent capability facts', async t => {
  const f = fixture(); f.online(); t.after(() => f.service.close());
  await f.service.linkCurrent({ platform: 'qq' }); f.grants.qq.items[0].allowed = false;
  let item = (await f.service.inspect()).items[0].capabilities[0]; assert.equal(item.supported, true); assert.equal(item.allowed, false); assert.equal(item.available, false); assert.equal(item.status, 'needs_grant');
  f.grants.qq.items[0].allowed = true; f.channels.qq.connected = false; item = (await f.service.inspect()).items[0].capabilities[0]; assert.equal(item.allowed, true); assert.equal(item.status, 'unavailable'); assert.equal(item.available, false);
  f.channels.qq.connected = true; f.grants.qq.accountId = 'unrelated'; item = (await f.service.inspect()).items[0].capabilities[0]; assert.equal(item.status, 'unverified'); assert.equal(item.available, false);
});

test('a bridge uses its verified current connector rather than a different official bot account', async t => {
  const f = fixture(); t.after(() => f.service.close()); f.channels.qq.mode = 'bridge'; f.channels.qq.accountId = 'personal-qq'; f.channels.qq.connected = true; f.channels.qq.items[0].available = true;
  f.status.qq.accountId = 'personal-qq'; f.status.qq.connected = true;
  f.grants.qq.accountId = 'personal-qq'; f.grants.qq.items[0].available = true;
  const value = await f.service.linkCurrent({ platform: 'qq' }); assert.equal(value.item.accountId, 'personal-qq'); assert.equal(value.item.accountType, 'personal'); assert.equal(value.item.connection.credentialReference, 'channel:qq'); assert.equal(value.item.connection.connected, true); assert.equal(value.item.connection.samePlatformConcurrentAccounts, false);
});

test('injected adapters expose only actual identity and explicit permissions, without forwarding raw provider data', async t => {
  let refreshes = 0;
  const f = fixture({ adapters: { creator_net: { async inspect() { return { accountId: 'creator-A', connected: true, capabilities: [{ id: 'content.publish', supported: true, allowed: true }], accessToken: 'private-adapter-token', email: 'private-email' }; }, async refresh() { refreshes++; return this.inspect(); } } }, getPermissionStatus: async () => ({ accountId: 'creator-A', items: [{ id: 'content.publish', supported: true, allowed: true, available: true }] }) }); t.after(() => f.service.close());
  const saved = await f.service.upsert({ platform: 'creator_net', accountId: 'creator-A' }); assert.equal(saved.item.connection.connected, true); assert.equal(saved.item.capabilities[0].available, true);
  assert.doesNotMatch(JSON.stringify(saved), /private-adapter-token|private-email|accessToken/); assert.equal(f.store.value.items[0].accessToken, undefined);
  await f.service.refresh({ platform: 'creator_net' }); assert.equal(refreshes, 1);
});

test('a provider claim that an action is allowed does not substitute for the scoped user permission port', async t => {
  const f = fixture({ adapters: { creator_net: { async inspect() { return { accountId: 'c', connected: true, items: [{ id: 'content.publish', supported: true, allowed: true, available: true }] }; } } }, getPermissionStatus: undefined }); t.after(() => f.service.close());
  const saved = await f.service.upsert({ platform: 'creator_net', accountId: 'c' }); assert.equal(saved.item.capabilities[0].allowed, null); assert.equal(saved.item.capabilities[0].available, false); assert.equal(saved.item.capabilities[0].status, 'unverified');
});

test('the supported extension point does not invent a login flow for an unimplemented platform', async t => {
  const f = fixture(); t.after(() => f.service.close());
  const saved = await f.service.upsert({ platform: 'future_chat', accountId: 'new-account' }); assert.equal(saved.item.connection.adapterAvailable, false); assert.equal(saved.item.connection.verification, 'unverified'); assert.deepEqual(saved.item.capabilities, []);
  assert.throws(() => f.service.linkCurrent({ platform: 'future_chat' }), { code: 'SOCIAL_CONNECTOR_UNAVAILABLE' });
});

test('record capacity refuses the next identity without evicting or changing existing records', async t => {
  const f = fixture({ limits: { perInstance: 2, total: 4 } }); t.after(() => f.service.close());
  await f.service.upsert({ platform: 'qq', accountId: 'one' }); await f.service.upsert({ platform: 'qq', accountId: 'two' }); const before = f.store.value;
  await assert.rejects(f.service.upsert({ platform: 'qq', accountId: 'three' }), { code: 'SOCIAL_CAPACITY' }); assert.deepEqual(f.store.value, before);
  assert.deepEqual((await f.service.list()).items.map(x => x.accountId), ['one', 'two']);
});

test('UTF-8 registry byte limits do not use character length or silently truncate metadata', async t => {
  const f = fixture({ limits: { registryBytes: 4096 } }); t.after(() => f.service.close());
  await f.service.upsert({ platform: 'bilibili', accountId: 'one', notes: '中'.repeat(1000) }); const before = f.store.value;
  await assert.rejects(f.service.upsert({ platform: 'bilibili', accountId: 'two', notes: '文'.repeat(1000) }), { code: 'SOCIAL_CAPACITY' }); assert.deepEqual(f.store.value, before); assert.equal((await f.service.list()).items[0].notes.length, 1000);
});

test('disk writers are exclusive, recover stale in-memory reads after the prior writer closes, and release their own lease', async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'xiangxu-social-')), registryPath = join(dir, 'identities.json'); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const getCoordinator = () => ({ memoryRoot: join(dir, 'persona'), ready: Promise.resolve() });
  const first = createSocialIdentityService({ registryPath, getCoordinator }), second = createSocialIdentityService({ registryPath, getCoordinator }); t.after(() => first.close()); t.after(() => second.close());
  await Promise.all([first.ready, second.ready]); await first.upsert({ platform: 'bilibili', accountId: 'one' });
  await assert.rejects(second.upsert({ platform: 'bilibili', accountId: 'two' }), { code: 'SOCIAL_WRITER_LOCKED' });
  await first.close(); await second.upsert({ platform: 'bilibili', accountId: 'two' }); assert.deepEqual((await second.list()).items.map(x => x.accountId), ['one', 'two']);
  await second.close(); await assert.rejects(fs.access(registryPath + '.writer.lock'), { code: 'ENOENT' });
  const third = createSocialIdentityService({ registryPath, getCoordinator }); t.after(() => third.close()); assert.equal((await third.list()).items.length, 2);
});

test('unknown or private persisted fields fail closed rather than appearing in account responses', async t => {
  const f = fixture(); await f.service.upsert({ platform: 'qq', accountId: 'bot-A' }); await f.service.close(); const stored = f.store.value; stored.items[0].token = 'private-file-token';
  const service = createSocialIdentityService({ ...f.ports, storage: { read: async () => stored, write: async () => {} } }); t.after(() => service.close()); await assert.rejects(service.ready, { code: 'SOCIAL_REGISTRY_INVALID' });
});

test('registry writes reject a directory junction before touching the target', async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'xiangxu-social-link-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'target'), link = join(dir, 'link'); await fs.mkdir(target); try { await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { if (error.code === 'EPERM') return t.skip('Directory link creation is unavailable in this environment'); throw error; }
  const service = createSocialIdentityService({ registryPath: join(link, 'identity.json'), getCoordinator: () => ({ memoryRoot: join(dir, 'persona') }) }); t.after(() => service.close());
  await assert.rejects(service.ready, { code: 'SOCIAL_UNSAFE_PATH' }); assert.deepEqual(await fs.readdir(target), []);
});

test('a delayed read from a previous active instance cannot return that instance metadata after a switch', async t => {
  const f = fixture(); t.after(() => f.service.close()); await f.service.upsert({ platform: 'qq', accountId: 'bot-A', notes: 'private-A' });
  let resolve, started; const began = new Promise(r => { started = r; }), wait = new Promise(r => { resolve = r; });
  f.ports.getChannelCapabilities = async () => { started(); await wait; return structuredClone(f.channels.qq); };
  await f.service.close(); const service = createSocialIdentityService(f.ports); t.after(() => service.close()); const pending = service.inspect(); await began; f.use('b'); resolve();
  await assert.rejects(pending, { code: 'SOCIAL_INSTANCE_CHANGED' }); assert.equal((await service.list()).items.length, 0);
});

test('adapter errors expose only bounded codes and never private error messages', async t => {
  const f = fixture({ getConnectionStatus: async () => { throw Object.assign(new Error('secret-token-and-private-url'), { code: 'PRIVATE_ADAPTER_DOWN' }); } }); t.after(() => f.service.close());
  const saved = await f.service.upsert({ platform: 'qq', accountId: 'bot-A' }); assert.equal(saved.changed, true); assert.equal(saved.item.connection.diagnostic.code, 'PRIVATE_ADAPTER_DOWN'); assert.doesNotMatch(JSON.stringify(saved), /secret-token|private-url/); assert.equal(saved.item.connection.verification, 'unverified');
});

test('a failed durable write does not update live identity state', async t => {
  const f = fixture(); t.after(() => f.service.close()); await f.service.upsert({ platform: 'qq', accountId: 'one' }); f.store.fail(true);
  await assert.rejects(f.service.upsert({ platform: 'qq', accountId: 'two' }), { code: 'EIO' }); assert.deepEqual((await f.service.list()).items.map(x => x.accountId), ['one']);
});

test('removing a directory record neither logs out the platform nor deletes memories or permissions', async t => {
  const f = fixture(); t.after(() => f.service.close()); const saved = await f.service.upsert({ platform: 'qq', accountId: 'bot-A' }); const grants = structuredClone(f.grants), state = structuredClone(f.status);
  const removed = await f.service.remove({ identityId: saved.item.identityId }); assert.equal(removed.removed, true); assert.equal(removed.platformAccountLoggedOut, false); assert.equal(removed.permissionsChanged, false); assert.equal(removed.memoriesDeleted, false); assert.deepEqual(f.grants, grants); assert.deepEqual(f.status, state);
});

test('identity pagination is explicit and closed services cannot mutate or query', async t => {
  const f = fixture(); t.after(() => f.service.close()); for (const accountId of ['one', 'two', 'three']) await f.service.upsert({ platform: 'qq', accountId });
  const first = await f.service.list({ limit: 2 }); assert.equal(first.complete, false); assert.equal(first.nextOffset, 2); const next = await f.service.list({ limit: 2, offset: first.nextOffset }); assert.equal(next.items[0].accountId, 'three'); assert.equal(next.complete, true);
  await f.service.close(); await assert.rejects(f.service.list(), { code: 'SOCIAL_CLOSED' }); await assert.rejects(f.service.upsert({ platform: 'qq', accountId: 'four' }), { code: 'SOCIAL_CLOSED' });
});

test('profile URLs and identifiers reject embedded credentials, query secrets and malformed Unicode', async t => {
  const f = fixture(); t.after(() => f.service.close());
  for (const profileUrl of ['file:///private', 'javascript:alert(1)', 'https://user:secret@example.org/a', 'https://example.org/a?access_token=secret', 'https://example.org/a#secret']) await assert.rejects(f.service.upsert({ platform: 'qq', accountId: 'one', profileUrl }), { code: 'SOCIAL_INVALID' });
  for (const platform of ['../qq', '__proto__', 'constructor', 'QQ']) await assert.rejects(f.service.upsert({ platform, accountId: 'one' }), { code: 'SOCIAL_INVALID' });
  await assert.rejects(f.service.upsert({ platform: 'qq', accountId: 'one', notes: '\ud800' }), { code: 'SOCIAL_INVALID' }); assert.equal(f.store.writes, 0);
});

test('explicit refresh reloads another completed metadata write instead of presenting a cached directory as current', async t => {
  const f = fixture(); t.after(() => f.service.close()); await f.service.ready;
  const other = createSocialIdentityService(f.ports); t.after(() => other.close()); await other.upsert({ platform: 'bilibili', accountId: 'newly-registered' });
  assert.equal((await f.service.list()).items.length, 0); assert.equal((await f.service.refresh()).items[0].accountId, 'newly-registered');
});

test('concurrent close callers await the same pending write and release the metadata storage exactly once', async () => {
  let release, started, closeCount = 0; const entered = new Promise(resolve => { started = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const storage = { read: async () => null, write: async () => { started(); await blocked; }, close: async () => { closeCount++; } }, f = fixture({ storage });
  const pending = f.service.upsert({ platform: 'bilibili', accountId: 'c' }); await entered;
  const first = f.service.close(), second = f.service.close(); assert.equal(first, second); assert.equal(closeCount, 0); release(); await pending; await Promise.all([first, second]); assert.equal(closeCount, 1);
  await assert.rejects(f.service.list(), { code: 'SOCIAL_CLOSED' });
});
