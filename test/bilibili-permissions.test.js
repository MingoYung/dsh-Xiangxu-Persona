import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createBilibiliService } from '../adapters/dsh/bilibili/service.js';
import { createPermissionService } from '../adapters/dsh/permissions.js';

const BV = 'BV1234567890';
const stored = { schemaVersion: 'xiangxu-bilibili/1', enabled: true, credential: { accountId: '1234', sessdata: 'private-session', csrf: 'private-csrf' }, receipts: [] };
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
async function setup(t, intercept = async () => null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiangxu-bili-permission-')), memoryRoot = path.join(root, 'persona'), registryPath = path.join(root, 'bilibili.json');
  await fs.mkdir(memoryRoot); await fs.writeFile(registryPath, JSON.stringify(stored));
  const requests = [], snapshots = []; let permissions;
  const fetchImpl = async (url, options) => {
    const target = new URL(url); requests.push({ path: target.pathname, options }); const response = await intercept(target, options); if (response) return response;
    if (target.pathname === '/x/web-interface/nav') { const accountId = /DedeUserID=([0-9]+)/.exec(options.headers.Cookie ?? '')?.[1]; return json({ code: 0, data: { isLogin: true, mid: Number(accountId), uname: '隔离账号' } }); }
    if (target.pathname === '/x/web-interface/view') return json({ code: 0, data: { bvid: BV, aid: 50, cid: 60, title: '外部资料', duration: 30, pages: [{ page: 1, cid: 60, duration: 30 }] } });
    if (target.pathname === '/web_im/v1/web_im/send_msg') return json({ code: 0, data: { msg_key: 'real-fixture-message' } });
    if (target.pathname.endsWith('/qrcode/generate')) return json({ code: 0, data: { qrcode_key: 'ephemeral-key', url: 'https://passport.bilibili.com/qrcode/h5/login?key=ephemeral-key' } });
    if (target.pathname.endsWith('/qrcode/poll')) { const response = json({ code: 0, data: { code: 0 } }); for (const value of ['SESSDATA=new-session', 'bili_jct=new-csrf', 'DedeUserID=4321']) response.headers.append('set-cookie', value + '; Path=/'); return response; }
    throw new Error('Fixture rejects any other request');
  };
  const bili = createBilibiliService({ registryPath, fetchImpl, authorize: value => permissions.authorize(value) });
  const coordinator = { ready: Promise.resolve(), memoryRoot };
  permissions = createPermissionService({ file: path.join(root, 'permissions.json'), getCoordinator: () => coordinator, getCapabilities: id => {
    assert.equal(id, 'bilibili'); const snapshot = bili.capabilitySnapshot(); assert.equal(typeof snapshot?.then, 'undefined'); snapshots.push(snapshot); return snapshot;
  } });
  t.after(async () => { await bili.close(); await permissions.close(); await fs.rm(root, { recursive: true, force: true }); });
  await Promise.all([bili.ready, permissions.ready]);
  return { bili, permissions, root, memoryRoot, requests, snapshots, context: deliveryId => ({ memoryRoot, accountId: '1234', ...(deliveryId ? { deliveryId } : {}) }) };
}

test('actual permission service authorizes Bilibili reads and sends without awaiting the occupied Bilibili queue', { timeout: 3000 }, async t => {
  const { bili, permissions, context, requests, snapshots } = await setup(t);
  await bili.inspect({ probe: true }); assert.ok((await permissions.inspect({ id: 'bilibili' })).items.every(item => !item.allowed));
  await permissions.configure({ id: 'bilibili', allowed: ['feed.read', 'chat.text'] });
  const read = await bili.read({ operation: 'video', bvid: BV }, context()); assert.equal(read.video.bvid, BV);
  const sent = await bili.execute({ operation: 'message', receiverUid: '5678', text: '权限联测' }, context('permission-integration')); assert.equal(sent.status, 'delivered'); assert.equal(sent.messageId, 'real-fixture-message');
  assert.equal(requests.filter(request => request.path.endsWith('/send_msg')).length, 1); assert.ok(snapshots.length >= 6);
  assert.ok(snapshots.every(snapshot => !JSON.stringify(snapshot).includes('private-session') && !JSON.stringify(snapshot).includes('private-csrf')));
});

test('actual permission integration rejects disabled Bilibili and never transfers an old account grant to a new login', { timeout: 3000 }, async t => {
  const { bili, permissions, context, memoryRoot, requests } = await setup(t);
  await bili.inspect({ probe: true }); await permissions.configure({ id: 'bilibili', allowed: ['feed.read', 'chat.text'] }); await bili.configure({ enabled: false });
  let before = requests.length; await assert.rejects(bili.read({ operation: 'video', bvid: BV }, context()), { code: 'BILI_DISABLED' }); assert.equal(requests.length, before);
  await assert.rejects(permissions.authorize({ memoryRoot, platform: 'bilibili', accountId: '1234', capability: 'feed.read' }), { code: 'CAPABILITY_UNAVAILABLE' });
  await bili.configure({ enabled: true }); const login = await bili.loginStart(); await bili.loginPoll({ flowId: login.login.flowId }); assert.equal(bili.capabilitySnapshot().accountId, '4321');
  before = requests.length; await assert.rejects(bili.execute({ operation: 'message', receiverUid: '5678', text: '旧账号不得外发' }, context('old-account')), { code: 'BILI_ACCOUNT_CHANGED' });
  await assert.rejects(bili.read({ operation: 'video', bvid: BV }, { memoryRoot, accountId: '4321' }), { code: 'BILI_PERMISSION_DENIED' }); assert.equal(requests.length, before);
  await permissions.configure({ id: 'bilibili', allowed: ['feed.read'] }); assert.equal((await bili.read({ operation: 'video', bvid: BV }, { memoryRoot, accountId: '4321' })).video.bvid, BV);
});

test('capability snapshots stay synchronous, isolated and unavailable during closing while the real permission-authorized read is pending', { timeout: 3000 }, async t => {
  let entered; const active = new Promise(resolve => { entered = resolve; });
  const { bili, permissions, context } = await setup(t, async (target, options) => {
    if (target.pathname !== '/x/web-interface/view') return null; entered(); return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('fixture cancelled')), { once: true }));
  });
  await bili.inspect({ probe: true }); await permissions.configure({ id: 'bilibili', allowed: ['feed.read'] }); const pending = bili.read({ operation: 'video', bvid: BV }, context()); await active;
  const snapshot = bili.capabilitySnapshot(); assert.equal(snapshot.ready, true); assert.equal(snapshot.connected, true); snapshot.items[0].available = false; snapshot.sources.protocol = 'changed only in the consumer copy'; assert.notEqual(bili.peekCapabilities().sources.protocol, snapshot.sources.protocol); assert.equal(bili.peekCapabilities().items[0].available, true);
  const closing = bili.close(), during = bili.capabilitySnapshot(); assert.equal(during.phase, 'closing'); assert.equal(during.connected, false); assert.equal(during.enabled, false); assert.ok(during.items.every(item => !item.available && !item.driverAvailable)); await assert.rejects(pending); await closing;
  assert.equal(bili.peekCapabilities().phase, 'closed'); assert.ok(bili.peekCapabilities().items.every(item => !item.available));
});

test('capability inspection before ready does not touch the queue, expose partial credentials or claim a usable account', async t => {
  let release, platformCalls = 0; const waiting = new Promise(resolve => { release = resolve; });
  const bili = createBilibiliService({ storage: { async read() { await waiting; return structuredClone(stored); }, async write() {} }, fetchImpl: async (_url, options) => { platformCalls++; assert.equal(options.method, 'GET'); return json({ code: 0, data: { isLogin: true, mid: 1234, uname: '隔离账号' } }); } }); t.after(() => bili.close());
  const before = bili.peekCapabilities(); assert.equal(before.ready, false); assert.equal(before.accountId, null); assert.ok(before.items.every(item => !item.available));
  assert.equal(platformCalls, 0); release(); await bili.ready; const after = bili.capabilitySnapshot(); assert.equal(after.ready, true); assert.equal(after.accountId, '1234'); assert.equal(after.connected, true); assert.ok(after.items.every(item => item.available && item.defaultAllowed === false)); assert.equal(platformCalls, 1); assert.ok(!JSON.stringify(after).includes('private-session'));
});
