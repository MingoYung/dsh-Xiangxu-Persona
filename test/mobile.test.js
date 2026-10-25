import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createMobileChatService } from '../adapters/dsh/mobile.js';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'xiangxu-mobile-')), assetsDir = join(dir, 'ui');
  await mkdir(assetsDir); for (const file of ['index.html', 'app.js', 'style.css', 'speech.js']) await writeFile(join(assetsDir, file), file === 'index.html' ? '<!doctype html><title>isolated fixture</title>' : '/* isolated fixture */');
  let now = 1000000, current = { memoryRoot: join(dir, 'persona'), ready: Promise.resolve() }, sendCalls = 0, createCalls = 0, closeCalls = 0;
  const channels = new Map(), channelPort = {
    async create() { createCalls++; const channel = { sessionId: 'xiangxu-mobile-' + randomUUID(), memoryRoot: current.memoryRoot, agentOptions: { provider: 'fixture', model: 'fixture-v1' } }; channels.set(channel.sessionId, []); return channel; },
    async send(channel, args) { sendCalls++; if (options.send) return options.send(channel, args); channels.get(channel.sessionId).push({ id: args.messageId, seq: sendCalls, role: 'user', text: args.text, at: now }); return { status: 'accepted' }; },
    async read(channel, args) { return { messages: (channels.get(channel.sessionId) ?? []).filter(row => row.seq > args.after), nextAfter: sendCalls, nextOffset: 0, hasMore: false }; },
    async status() { return { connected: true, sleep: { state: 'awake' }, waiting: 'ready' }; },
    async close() { closeCalls++; }, async closeChannel() { closeCalls++; },
  };
  const config = { getCoordinator: () => current, registryPath: join(dir, 'mobile.json'), assetsDir, channelPort, clock: () => now, interfaces: () => ({ test: [{ family: 'IPv4', address: '192.168.10.9', internal: false }, { family: 'IPv4', address: '8.8.8.8', internal: false }] }), ...options };
  let service = createMobileChatService(config); const services = [service]; await service.ready;
  t.after(async () => { for (const item of services) await item.close(); await rm(dir, { recursive: true, force: true }); });
  async function start(args = {}) { const status = await service.start({ port: 0, ...args }); return status.addresses[0]; }
  async function request(base, route, { method = 'GET', token, data, headers = {} } = {}) {
    const result = await fetch(base + route, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(data ? { 'content-type': 'application/json' } : {}), ...headers }, body: data ? JSON.stringify(data) : undefined });
    const text = await result.text(); let value; try { value = JSON.parse(text); } catch { value = text; }
    return { status: result.status, headers: result.headers, value };
  }
  async function pair(base) { const invitation = await service.pair({ baseUrl: base, label: '隔离验收手机' }), secret = new URLSearchParams(new URL(invitation.pairUrl).hash.slice(1)).get('pair'), result = await request(base, '/api/pair', { method: 'POST', data: { token: secret } }); assert.equal(result.status, 200); return { ...result.value, invitation, secret }; }
  return { dir, config, start, pair, request, get service() { return service; }, now: () => now, advance: ms => { now += ms; }, current: () => current, setCurrent: value => { current = value; }, counts: () => ({ sendCalls, createCalls, closeCalls }),
    async reopen() { await service.close(); service = createMobileChatService(config); services.push(service); await service.ready; return service; } };
}

test('mobile is disabled by default, persists explicit configuration and exposes only private LAN candidates', async t => {
  const f = await fixture(t); assert.equal((await f.service.status()).enabled, false); assert.equal((await f.service.status()).configuration.host, '127.0.0.1');
  await assert.rejects(f.service.pair({}), { code: 'MOBILE_NOT_STARTED' });
  await f.service.configure({ host: '0.0.0.0', autoStart: false, publicBaseUrl: 'https://chat.example.test/' });
  const base = await f.start(), status = await f.service.status(); assert.equal(status.enabled, true); assert(status.addresses.some(url => url.includes('192.168.10.9'))); assert(!status.addresses.some(url => url.includes('8.8.8.8')));
  await assert.rejects(f.service.configure({ port: 1234 }), { code: 'MOBILE_STOP_BEFORE_CONFIG' });
  await f.service.stop(); await f.reopen(); assert.equal((await f.service.status()).configuration.publicBaseUrl, 'https://chat.example.test'); assert.equal((await f.service.status()).listening, false);
  assert(base.startsWith('http://127.0.0.1:'));
});

test('mobile pairing is one-use, fragment-only, hashed on disk, and device authentication survives same-root restart', async t => {
  const f = await fixture(t), base = await f.start(), device = await f.pair(base);
  assert(device.invitation.pairUrl.includes('/#pair=')); assert(!new URL(device.invitation.pairUrl).search);
  const reused = await f.request(base, '/api/pair', { method: 'POST', data: { token: device.secret } }); assert.equal(reused.value.error.code, 'MOBILE_PAIR_EXPIRED');
  const disk = await readFile(join(f.dir, 'mobile.json'), 'utf8'); assert(!disk.includes(device.deviceToken)); assert(!disk.includes(device.secret)); assert(disk.includes('tokenHash'));
  assert.equal((await f.request(base, '/api/state', { token: device.deviceToken })).status, 200);
  await f.reopen(); const second = await f.start(); assert.equal((await f.request(second, '/api/state', { token: device.deviceToken })).status, 200);
  await f.service.revoke({ deviceId: device.device.id }); assert.equal((await f.request(second, '/api/state', { token: device.deviceToken })).status, 401);
});

test('mobile rejects expired pairing, invalid origin/host, query credentials, unauthenticated access and management paths', async t => {
  const f = await fixture(t), base = await f.start(), device = await f.pair(base);
  assert.equal((await f.request(base, '/api/state')).status, 401);
  assert.equal((await f.request(base, '/api/state', { token: device.deviceToken, headers: { origin: 'https://evil.example' } })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => { const request = httpRequest(base + '/api/state', { headers: { host: 'evil.example', authorization: 'Bearer ' + device.deviceToken } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }); request.on('error', reject); request.end(); });
  assert.equal(hostStatus, 403);
  assert.equal((await f.request(base, '/?token=do-not-use-query')).status, 400);
  assert.equal((await f.request(base, '/api/persona-memory.manage', { token: device.deviceToken, method: 'POST', data: { action: 'config', args: {} } })).status, 404);
  assert.equal((await f.request(base, '/api/send?token=x', { token: device.deviceToken, method: 'POST', data: {} })).status, 404);
  const invitation = await f.service.pair({ baseUrl: base }); f.advance(300001);
  const expired = await f.request(base, '/api/pair', { method: 'POST', data: { token: new URLSearchParams(new URL(invitation.pairUrl).hash.slice(1)).get('pair') } }); assert.equal(expired.value.error.code, 'MOBILE_PAIR_EXPIRED');
});

test('mobile sends preserve original text, durable receipts are idempotent, and receipt GET never sends', async t => {
  const f = await fixture(t), base = await f.start(), device = await f.pair(base), args = { requestId: 'one-input', createdAt: f.now(), text: '这是原文 🙂，不是管理指令。' };
  const before = await f.request(base, '/api/receipt?requestId=one-input', { token: device.deviceToken }); assert.equal(before.value.status, 'not_found'); assert.equal(f.counts().sendCalls, 0);
  const first = await f.request(base, '/api/send', { token: device.deviceToken, method: 'POST', data: args }); assert.equal(first.value.status, 'accepted');
  const second = await f.request(base, '/api/send', { token: device.deviceToken, method: 'POST', data: args }); assert.equal(second.value.duplicate, true); assert.equal(f.counts().sendCalls, 1);
  const receipt = await f.request(base, '/api/receipt?requestId=one-input', { token: device.deviceToken }); assert.equal(receipt.value.status, 'accepted'); assert.equal(f.counts().sendCalls, 1);
  const conflict = await f.request(base, '/api/send', { token: device.deviceToken, method: 'POST', data: { ...args, text: '不同原文' } }); assert.equal(conflict.value.error.code, 'MOBILE_REQUEST_CONFLICT');
  const page = await f.request(base, '/api/messages?after=0', { token: device.deviceToken }); assert.equal(page.value.messages[0].text, args.text);
  const disk = await readFile(join(f.dir, 'mobile.json'), 'utf8'); assert(!disk.includes(args.text));
  await f.reopen(); const next = await f.start(), again = await f.request(next, '/api/send', { token: device.deviceToken, method: 'POST', data: args }); assert.equal(again.value.duplicate, true); assert.equal(f.counts().sendCalls, 1);
  f.advance(600001); const expired = await f.request(next, '/api/send', { token: device.deviceToken, method: 'POST', data: { ...args, requestId: 'expired-never-submitted' } }); assert.equal(expired.value.error.code, 'MOBILE_REQUEST_EXPIRED'); assert.equal(f.counts().sendCalls, 1);
});

test('mobile delivery failures remain unknown and never replay, including restart', async t => {
  const f = await fixture(t, { send: async () => { throw Object.assign(new Error('isolated ambiguous transport failure'), { code: 'FIXTURE_LOST_ACK' }); } }), base = await f.start(), device = await f.pair(base), args = { requestId: 'lost-ack', createdAt: f.now(), text: '一次发送' };
  assert.equal((await f.request(base, '/api/send', { token: device.deviceToken, method: 'POST', data: args })).value.status, 'unknown');
  await f.reopen(); const next = await f.start(); assert.equal((await f.request(next, '/api/send', { token: device.deviceToken, method: 'POST', data: args })).value.status, 'unknown'); assert.equal(f.counts().sendCalls, 1);
  assert.equal((await f.request(next, '/api/receipt?requestId=lost-ack', { token: device.deviceToken })).value.status, 'unknown');
  await f.service.revoke({ deviceId: device.device.id }); const registry = JSON.parse(await readFile(join(f.dir, 'mobile.json'), 'utf8')); assert.equal(registry.requests.length, 0);
});

test('mobile instance binding, suspend/resume and restore invalidation preserve history without reusing wrong-root auth', async t => {
  const f = await fixture(t), base = await f.start(), device = await f.pair(base), original = f.current();
  await f.service.suspend(); assert.equal((await f.service.status()).listening, false); assert.equal((await f.service.status()).wanted, true); assert.equal((await f.service.status()).devices.length, 1);
  await f.service.resume(); let address = (await f.service.status()).addresses[0]; assert.equal((await f.request(address, '/api/state', { token: device.deviceToken })).status, 200);
  await f.service.suspend(); f.setCurrent({ memoryRoot: join(f.dir, 'other-persona'), ready: Promise.resolve() }); await f.service.resume(); address = (await f.service.status()).addresses[0]; assert.equal((await f.request(address, '/api/state', { token: device.deviceToken })).status, 403);
  await f.service.suspend(); f.setCurrent(original); await f.service.resume(); address = (await f.service.status()).addresses[0]; assert.equal((await f.request(address, '/api/state', { token: device.deviceToken })).status, 200);
  const result = await f.service.invalidateForRoot(original.memoryRoot); assert.equal(result.revokedDevices, 1); assert.equal((await f.service.status()).devices.length, 0); assert.equal((await f.service.status()).listening, false);
  await f.service.resume(); address = (await f.service.status()).addresses[0]; assert.equal((await f.request(address, '/api/state', { token: device.deviceToken })).status, 401); assert.equal(f.counts().createCalls, 1);
});

test('mobile voice actions use the authenticated device session and cannot select a session from phone input', async t => {
  const calls = [], voice = { inspect: async sessionKey => ({ sessionKey, effective: { available: false } }), registerCatalog: async (sessionKey, args) => { calls.push(['catalog', sessionKey, args]); return { accepted: true }; }, configure: async (args, context) => { calls.push(['configure', context.sessionKey, args]); return { accepted: true }; } };
  const f = await fixture(t, { getVoice: () => voice }), base = await f.start(), device = await f.pair(base), catalog = { supported: true, voices: [] };
  assert.equal((await f.request(base, '/api/voice/catalog', { token: device.deviceToken, method: 'POST', data: catalog })).status, 200);
  assert.equal((await f.request(base, '/api/voice/config', { token: device.deviceToken, method: 'POST', data: { mode: 'persona', sessionKey: 'attempted-other-session' } })).status, 200);
  assert(calls.every(call => call[1].startsWith('xiangxu-mobile-'))); assert(calls.every(call => call[1] !== 'attempted-other-session'));
});

test('mobile registry validates dates, receipt structures, source routes and secrets before accepting state', async t => {
  const f = await fixture(t), base = await f.start(); await f.pair(base); await f.service.stop();
  const baseline = JSON.parse(await readFile(join(f.dir, 'mobile.json'), 'utf8'));
  const changes = [value => { value.devices[0].expiresAt = 'forever'; }, value => { value.devices[0].channel.sessionId = 'unrelated-user-session'; }, value => { value.devices[0].channel.agentOptions.secret = 'unwanted'; }, value => { value.requests = ['not-a-receipt']; }, value => { value.devices.push(structuredClone(value.devices[0])); }];
  for (const mutate of changes) {
    const value = structuredClone(baseline); mutate(value);
    const service = createMobileChatService({ ...f.config, storage: { read: async () => value, write: async () => {} } });
    await assert.rejects(service.ready, { code: 'MOBILE_REGISTRY_INVALID' });
  }
});

test('mobile recovered prepared receipt becomes persisted unknown without dispatch', async t => {
  const f = await fixture(t), base = await f.start(), device = await f.pair(base); await f.service.stop();
  const registryPath = join(f.dir, 'mobile.json'), registry = JSON.parse(await readFile(registryPath, 'utf8'));
  registry.requests.push({ deviceId: device.device.id, requestId: 'prepared-at-crash', textHash: '0'.repeat(64), messageId: 'mobile-' + device.device.id + '-prepared-at-crash', status: 'prepared', at: f.now() }); await writeFile(registryPath, JSON.stringify(registry));
  await f.reopen(); const next = await f.start(), result = await f.request(next, '/api/receipt?requestId=prepared-at-crash', { token: device.deviceToken }); assert.equal(result.value.status, 'unknown');
  assert.equal(JSON.parse(await readFile(registryPath, 'utf8')).requests[0].status, 'unknown'); assert.equal(f.counts().sendCalls, 0);
});

test('mobile rejects overlong input and extra config, caps devices, and emits strict static CSP', async t => {
  const f = await fixture(t), base = await f.start(), device = await f.pair(base);
  await assert.rejects(f.service.configure({ enabled: true }), { code: 'MOBILE_STOP_BEFORE_CONFIG' });
  const response = await f.request(base, '/api/send', { token: device.deviceToken, method: 'POST', data: { requestId: 'too-long', createdAt: f.now(), text: '🙂'.repeat(16001) } }); assert.equal(response.status, 400); assert.equal(f.counts().sendCalls, 0);
  const html = await f.request(base, '/'); assert.equal(html.status, 200); assert(html.headers.get('content-security-policy').includes("frame-ancestors 'none'")); assert.equal(html.headers.get('referrer-policy'), 'no-referrer');
  for (let count = 1; count < 8; count++) await f.pair(base);
  const invitation = await f.service.pair({ baseUrl: base }), denied = await f.request(base, '/api/pair', { method: 'POST', data: { token: new URLSearchParams(new URL(invitation.pairUrl).hash.slice(1)).get('pair') } }); assert.equal(denied.value.error.code, 'MOBILE_DEVICE_CAPACITY');
  await f.service.stop(); await assert.rejects(f.service.configure({ enabled: true }), { code: 'MOBILE_BAD_CONFIG' }); await assert.rejects(f.service.configure({ publicBaseUrl: 'http://example.com' }), { code: 'MOBILE_BAD_CONFIG' });
});

test('mobile rechecks auth after a slow POST body, so revoke cannot race a new delivery', async t => {
  const f = await fixture(t), base = await f.start(), device = await f.pair(base), text = JSON.stringify({ requestId: 'revoked-while-reading-body', createdAt: f.now(), text: '不应被投递' });
  let request;
  const result = new Promise((resolve, reject) => {
    request = httpRequest(base + '/api/send', { method: 'POST', headers: { authorization: 'Bearer ' + device.deviceToken, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } }, response => { let data = ''; response.on('data', chunk => { data += chunk; }); response.on('end', () => resolve({ status: response.statusCode, value: JSON.parse(data) })); }); request.on('error', reject); request.write(text.slice(0, 5));
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  await f.service.revoke({ deviceId: device.device.id }); request.end(text.slice(5)); const response = await result;
  assert.equal(response.status, 401); assert.equal(f.counts().sendCalls, 0);
});

test('mobile rechecks instance after a slow POST body and refuses forwarding into another root', async t => {
  const f = await fixture(t), base = await f.start(), device = await f.pair(base), text = JSON.stringify({ requestId: 'switched-while-reading-body', createdAt: f.now(), text: '不能跨库' });
  let request;
  const result = new Promise((resolve, reject) => {
    request = httpRequest(base + '/api/send', { method: 'POST', headers: { authorization: 'Bearer ' + device.deviceToken, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }); request.on('error', reject); request.write(text.slice(0, 5));
  });
  await new Promise(resolve => setTimeout(resolve, 20)); f.setCurrent({ memoryRoot: join(f.dir, 'wrong-root'), ready: Promise.resolve() }); request.end(text.slice(5));
  assert.equal(await result, 403); assert.equal(f.counts().sendCalls, 0);
});

test('mobile serializes suspend behind a committed send and keeps its durable receipt', async t => {
  let finishSend, entered;
  const gate = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { send: async () => { entered(); await new Promise(resolve => { finishSend = resolve; }); return { status: 'accepted' }; } }), base = await f.start(), device = await f.pair(base);
  const delivery = f.request(base, '/api/send', { token: device.deviceToken, method: 'POST', data: { requestId: 'accepted-before-suspend', createdAt: f.now(), text: '保留收件箱回执' } });
  await gate; let suspended = false; const suspend = f.service.suspend().then(() => { suspended = true; }); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(suspended, false);
  finishSend(); const delivered = await delivery; assert.equal(delivered.value.status, 'accepted'); await suspend;
  await f.service.resume(); const next = (await f.service.status()).addresses[0], receipt = await f.request(next, '/api/receipt?requestId=accepted-before-suspend', { token: device.deviceToken }); assert.equal(receipt.value.status, 'accepted'); assert.equal(f.counts().sendCalls, 1);
});

test('mobile rejects a public socket without an explicitly configured public HTTPS origin', async t => {
  const f = await fixture(t); await f.start();
  let status, value;
  const request = { method: 'GET', url: '/api/state', headers: { host: new URL((await f.service.status()).addresses[0]).host }, socket: { remoteAddress: '203.0.113.80' } };
  const response = { writeHead(code) { status = code; }, end(data) { value = JSON.parse(data); } };
  await f.service.handle(request, response); assert.equal(status, 403); assert.equal(value.error.code, 'MOBILE_ORIGIN_REJECTED');
});

test('mobile persists prepared receipt before delivery and returns unknown on a lost accepted-receipt write', async t => {
  let value = null, writes = 0, failAt = Infinity;
  const storage = { read: async () => structuredClone(value), write: async next => { writes++; if (writes === failAt) throw Object.assign(new Error('isolated write fault'), { code: 'FIXTURE_WRITE_FAILED' }); value = structuredClone(next); } };
  const f = await fixture(t, { storage }), base = await f.start(), device = await f.pair(base);
  failAt = writes + 2;
  const response = await f.request(base, '/api/send', { token: device.deviceToken, method: 'POST', data: { requestId: 'lost-receipt-write', createdAt: f.now(), text: '已投递但回执写入失败' } });
  assert.equal(response.value.status, 'unknown'); assert.equal(value.requests[0].status, 'prepared'); assert.equal(f.counts().sendCalls, 1);
  await f.reopen(); const next = await f.start(), receipt = await f.request(next, '/api/receipt?requestId=lost-receipt-write', { token: device.deviceToken }); assert.equal(receipt.value.status, 'unknown'); assert.equal(f.counts().sendCalls, 1);
});

test('mobile explicit wake is a narrow authenticated signal with no arbitrary command arguments', async t => {
  const f = await fixture(t), calls = []; f.current().executeCommand = async (command, args) => { calls.push([command, args]); return { internalDetail: 'must not be exposed' }; };
  const base = await f.start(), device = await f.pair(base);
  const denied = await f.request(base, '/api/wake', { method: 'POST', data: {} }); assert.equal(denied.status, 401);
  const extra = await f.request(base, '/api/wake', { token: device.deviceToken, method: 'POST', data: { command: 'config', target: 'foreign' } }); assert.equal(extra.status, 400); assert.equal(calls.length, 0);
  const result = await f.request(base, '/api/wake', { token: device.deviceToken, method: 'POST', data: {} }); assert.equal(result.status, 200); assert.equal(result.value.signaled, true); assert.equal(result.value.internalDetail, undefined); assert.deepEqual(calls, [['wake', {}]]);
});

test('mobile explicit historical pages keep a fixed-end cursor even at a whole-message boundary', async t => {
  const observed = [];
  const f = await fixture(t, { channelPort: { create: async () => ({ sessionId: 'xiangxu-mobile-' + randomUUID(), memoryRoot: f.current().memoryRoot, agentOptions: { provider: 'fixture', model: 'fixture' } }), status: async () => ({ sleep: { state: 'awake' } }), read: async (_channel, args) => { observed.push(args); return observed.length === 1 ? { messages: [], nextAfter: 20, nextOffset: 0, nextIndex: 0, hasMore: true, history: true, windowStart: 10, windowEnd: 100, previousBefore: 10, earlierBefore: 10 } : { messages: [], nextAfter: 100, nextOffset: 0, nextIndex: 0, hasMore: false, history: true, windowStart: 10, windowEnd: 100, previousBefore: 10, earlierBefore: 10 }; } } });
  const base = await f.start(), device = await f.pair(base), first = await f.request(base, '/api/messages?before=100', { token: device.deviceToken }); assert(first.value.nextCursor); assert.equal(first.value.history, true);
  const next = await f.request(base, '/api/messages?cursor=' + encodeURIComponent(first.value.nextCursor), { token: device.deviceToken }); assert.equal(next.value.nextCursor, null); assert.equal(observed[1].until, 100); assert.equal(observed[1].windowStart, 10); assert.equal(observed[1].after, 20);
});

test('mobile suspend refuses a turn that started after the initial manager idle check without closing transport', async t => {
  let finish, entered;
  const gate = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { send: async () => { entered(); await new Promise(resolve => { finish = resolve; }); f.current().agents.set('phone-agent', { agent: { status: 'running' } }); return { status: 'accepted' }; } });
  f.current().agents = new Map(); const base = await f.start(), device = await f.pair(base);
  const delivery = f.request(base, '/api/send', { token: device.deviceToken, method: 'POST', data: { requestId: 'turn-started-before-suspend', createdAt: f.now(), text: '不得被切换取消的对话' } });
  await gate; const suspended = assert.rejects(f.service.suspend(), { code: 'INSTANCE_BUSY' }); finish();
  assert.equal((await delivery).value.status, 'accepted'); await suspended;
  const status = await f.service.status(); assert.equal(status.listening, true); assert.equal(status.enabled, true); assert.equal(status.wanted, true); assert.equal(f.counts().closeCalls, 0);
  assert.equal((await f.request(base, '/api/state', { token: device.deviceToken })).status, 200);
  f.current().agents.get('phone-agent').agent.status = 'idle'; await f.service.suspend(); assert.equal((await f.service.status()).listening, false); assert.equal(f.counts().closeCalls, 1);
});

test('mobile explicit plugin close can release a running phone scope while ordinary lifecycle suspend stays guarded', async t => {
  const f = await fixture(t); f.current().agents = new Map([['active-phone', { agent: { status: 'running' } }]]); await f.start();
  await assert.rejects(f.service.suspend(), { code: 'INSTANCE_BUSY' }); await f.service.close(); assert.equal((await f.service.status()).listening, false); assert.equal(f.counts().closeCalls, 1);
});

test('mobile restore invalidation refuses a newly started turn before revoking devices or closing its listener', async t => {
  let finish, entered;
  const gate = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { send: async () => { entered(); await new Promise(resolve => { finish = resolve; }); f.current().agents.set('phone-agent', { agent: { status: 'running' } }); return { status: 'accepted' }; } });
  f.current().agents = new Map(); const base = await f.start(), device = await f.pair(base), registryPath = join(f.dir, 'mobile.json');
  const delivery = f.request(base, '/api/send', { token: device.deviceToken, method: 'POST', data: { requestId: 'turn-started-before-restore', createdAt: f.now(), text: '恢复前已启动的对话' } });
  await gate; const blocked = assert.rejects(f.service.invalidateForRoot(f.current().memoryRoot), { code: 'INSTANCE_BUSY' }); finish();
  assert.equal((await delivery).value.status, 'accepted'); await blocked;
  const state = await f.service.status(); assert.equal(state.enabled, true); assert.equal(state.devices.length, 1); assert.equal(state.wanted, true); assert.equal(f.counts().closeCalls, 0);
  const registry = JSON.parse(await readFile(registryPath, 'utf8')); assert.equal(registry.devices.length, 1); assert.equal(registry.requests[0].status, 'accepted');
  assert.equal((await f.request(base, '/api/state', { token: device.deviceToken })).status, 200);
  f.current().agents.get('phone-agent').agent.status = 'idle'; const revoked = await f.service.invalidateForRoot(f.current().memoryRoot); assert.equal(revoked.revokedDevices, 1); assert.equal((await f.service.status()).listening, false);
});
