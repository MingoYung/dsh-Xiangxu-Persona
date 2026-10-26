import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createConnectionService } from '../adapters/dsh/connections/service.js';
import { createQqClient, decodeQqEvent } from '../adapters/dsh/connections/qq.js';
import { createWechatClient, decodeWechatEvent } from '../adapters/dsh/connections/wechat.js';
import { createChannelService } from '../adapters/dsh/channels/service.js';
import { createBridgeClient } from '../adapters/dsh/connections/bridge.js';

const memory = () => { let data = null; return { async read() { return structuredClone(data); }, async write(value) { data = structuredClone(value); }, get value() { return structuredClone(data); } }; };
async function server(handler) {
  const requests = [], sockets = new Set();
  const instance = http.createServer(async (req, res) => { const parts = []; for await (const p of req) parts.push(p); const raw = Buffer.concat(parts); let body; try { body = JSON.parse(raw.toString()); } catch {} const item = { url: req.url, method: req.method, headers: req.headers, body, raw }; requests.push(item); try { await handler(item, (value, status = 200, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(value === null ? '' : JSON.stringify(value)); }); } catch (error) { res.writeHead(500); res.end('{}'); } });
  instance.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + instance.address().port, requests, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => instance.close(resolve)); } };
}
async function until(predicate, ms = 1500) { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } }
const route = (platform, accountId = 'bot') => ({ platform, accountId, conversation: { id: platform === 'qq' ? 'group-A' : 'person@im.wechat', type: platform === 'qq' ? 'group' : 'private' }, sender: { id: 'person' } });

test('QQ real binding requests decrypt official AES-GCM credentials and never expose them in owner status', async t => {
  let key, phase = 1;
  const api = await server((r, send) => {
    if (r.url === '/lite/create_bind_task') { key = Buffer.from(r.body.key, 'base64'); return send({ retcode: 0, data: { task_id: 'task-1' } }); }
    if (r.url === '/lite/poll_bind_result') { assert.deepEqual(r.body, { task_id: 'task-1' }); if (phase !== 2) return send({ retcode: 0, data: { status: phase } }); const iv = Buffer.alloc(12, 7), cipher = createCipheriv('aes-256-gcm', key, iv), encrypted = Buffer.concat([iv, cipher.update('private-app-secret'), cipher.final(), cipher.getAuthTag()]); return send({ retcode: 0, data: { status: 2, bot_appid: 10001, bot_encrypt_secret: encrypted.toString('base64'), user_openid: 'paired-person' } }); }
    send({}, 404);
  }); t.after(() => api.close()); const store = memory();
  const service = createConnectionService({ storage: store, endpoints: { qq: { binding: api.url } } }); t.after(() => service.close());
  const initial = await service.start({ id: 'qq' }), flow = initial.connections.find(x => x.id === 'qq');
  assert.equal(flow.phase, 'waiting'); assert.match(flow.qrContent, /^https:\/\/q\.qq\.com\/qqbot\/openclaw\/connect\.html/);
  assert.equal((await service.start({ id: 'qq' })).connections[0].flowId, flow.flowId); assert.equal(api.requests.length, 1);
  await service.poll({ id: 'qq', flowId: flow.flowId }); phase = 2;
  const connected = await service.poll({ id: 'qq', flowId: flow.flowId }); assert.equal(connected.connections[0].phase, 'authorized'); assert.equal(connected.connections[0].accountId, '10001');
  assert.equal(store.value.accounts.qq.appSecret, 'private-app-secret'); assert.doesNotMatch(JSON.stringify(connected), /private-app-secret|bot_encrypt_secret|QQBot /);
  const restarted = createConnectionService({ storage: store }); t.after(() => restarted.close()); assert.equal((await restarted.status()).connections[0].phase, 'authorized');
  await restarted.disconnect({ id: 'qq' }); assert.equal((await restarted.status()).connections[0].hasCredentials, false); assert.equal(store.value.accounts.qq, undefined);
});

test('QR expiration and cancellation retain no credentials; stale flow cannot cancel the replacement', async t => {
  let issued = 0; const api = await server((r, send) => r.url.includes('create_bind_task') ? send({ retcode: 0, data: { task_id: 'task-' + ++issued } }) : send({ retcode: 0, data: { status: 3 } })); t.after(() => api.close());
  const service = createConnectionService({ storage: memory(), endpoints: { qq: { binding: api.url } } }); t.after(() => service.close());
  const first = (await service.start({ id: 'qq' })).connections[0]; assert.equal((await service.poll({ id: 'qq', flowId: first.flowId })).connections[0].phase, 'expired');
  const second = (await service.start({ id: 'qq' })).connections[0]; assert.notEqual(second.flowId, first.flowId);
  await assert.rejects(service.cancel({ id: 'qq', flowId: first.flowId }), { code: 'CONNECTION_FLOW_STALE' });
  await service.cancel({ id: 'qq', flowId: second.flowId }); assert.equal((await service.status()).connections[0].phase, 'idle');
});

test('Wechat QR uses official request metadata, verification and confirmed account without exposing tokens', async t => {
  let phase = 'need_verifycode'; const api = await server((r, send) => {
    assert.equal(r.headers['ilink-app-id'], 'bot');
    if (r.url.startsWith('/ilink/bot/get_bot_qrcode')) { assert.deepEqual(r.body, { local_token_list: [] }); assert.equal(r.headers.authorization, undefined); return send({ qrcode: 'wx-task', qrcode_img_content: 'https://liteapp.weixin.qq.com/qr-test' }); }
    assert.equal(r.method, 'GET'); assert.equal(r.headers.authorization, undefined);
    if (phase === 'need_verifycode') return send({ status: phase });
    assert.match(r.url, /verify_code=123456/); return send({ status: 'confirmed', bot_token: 'private-wx-token', ilink_bot_id: 'wxbot', ilink_user_id: 'person@im.wechat', baseurl: api.url });
  }); t.after(() => api.close()); const store = memory(); const service = createConnectionService({ storage: store, endpoints: { wechat: { api: api.url } } }); t.after(() => service.close());
  const first = (await service.start({ id: 'wechat' })).connections[1]; assert.equal(first.phase, 'waiting');
  assert.equal((await service.poll({ id: 'wechat', flowId: first.flowId })).connections[1].phase, 'verify'); phase = 'confirmed';
  const result = await service.poll({ id: 'wechat', flowId: first.flowId, verifyCode: '123456' });
  assert.equal(result.connections[1].pairedUserId, 'person@im.wechat'); assert.deepEqual(result.connections[1].chatTypes, ['private']); assert.doesNotMatch(JSON.stringify(result), /private-wx-token/); assert.equal(store.value.accounts.wechat.token, 'private-wx-token');
});

test('official event normalization preserves group actor, exact original text, occurrence time and unhandled media facts', () => {
  const value = decodeQqEvent('app', 'GROUP_MESSAGE_CREATE', { id: 'message', group_openid: 'group', author: { member_openid: 'person', username: 'nickname' }, content: ' <@!bot> 原话 ', timestamp: '2026-10-26T00:00:00Z', attachments: [{ content_type: 'image/png' }] });
  assert.equal(value.message.text, ' <@!bot> 原话 '); assert.equal(value.message.createdAt, Date.parse('2026-10-26T00:00:00Z')); assert.equal(value.conversation.id, 'group'); assert.equal(value.sender.id, 'person'); assert.equal(value.textComplete, false);
  const wx = decodeWechatEvent('bot', { message_type: 1, message_id: '18446744073709551615', from_user_id: 'person@im.wechat', create_time_ms: 123, item_list: [{ type: 1, text_item: { text: '原文' } }, { type: 3, voice_item: { text: 'ASR不能冒充原文' } }] });
  assert.equal(wx.message.id, '18446744073709551615'); assert.equal(wx.message.text, '原文'); assert.deepEqual(wx.unsupportedSegments, ['voice']);
  assert.equal(decodeWechatEvent('bot', { message_type: 1, group_id: 'not-supported' }), null);
});

test('QQ gateway sends protocol identify, preserves all group messages and stop releases transport without a mention rule', async t => {
  class Socket extends EventTarget { static current; readyState = 1; sent = []; constructor(url) { super(); this.url = url; Socket.current = this; queueMicrotask(() => this.emit({ op: 10, d: { heartbeat_interval: 40000 } })); } emit(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); } send(text) { const value = JSON.parse(text); this.sent.push(value); if (value.op === 2) { this.emit({ op: 0, t: 'READY', s: 1, d: { session_id: 'session-1' } }); this.emit({ op: 0, t: 'GROUP_MESSAGE_CREATE', s: 2, d: { id: 'm-1', group_openid: 'group-A', author: { member_openid: 'person' }, content: '没有@也到达人格', timestamp: '2026-10-26T00:00:00Z' } }); } } close() { this.readyState = 3; this.dispatchEvent(new Event('close')); } }
  const api = await server((r, send) => r.url === '/app/getAppAccessToken' ? send({ access_token: 'ephemeral', expires_in: 7200 }) : r.url === '/gateway' ? send({ url: api.url.replace('http:', 'ws:') }) : send({ id: 'account' })); t.after(() => api.close());
  const events = [], checkpoints = []; const client = createQqClient({ accountId: 'app', appSecret: 'secret', transport: { contexts: {}, lastSeq: null, sessionId: null } }, { endpoints: { api: api.url }, WebSocketImpl: Socket, onCheckpoint: async state => { checkpoints.push(state); } }); t.after(() => client.close());
  await client.listen(async event => { events.push(event); return { status: 'accepted' }; }); await until(() => checkpoints.some(x => x.lastSeq === 2));
  assert.equal(events[0].message.text, '没有@也到达人格'); assert.equal(Socket.current.sent[0].op, 2); assert.equal(Socket.current.sent[0].d.intents, 1 << 25); assert.equal(Socket.current.sent[0].d.token, 'QQBot ephemeral');
  await client.stop(); assert.equal(Socket.current.readyState, 3); assert.equal(client.listening, false);
});

test('QQ text/media mutations require actual message IDs and never retry unknown writes', async t => {
  let sendCount = 0, noId = false; const api = await server((r, send) => {
    if (r.url === '/app/getAppAccessToken') { assert.deepEqual(r.body, { appId: 'bot', clientSecret: 'secret' }); return send({ access_token: 'token', expires_in: 7200 }); }
    assert.equal(r.headers.authorization, 'QQBot token');
    if (r.url.endsWith('/files')) { assert.equal(Buffer.from(r.body.file_data, 'base64').toString(), 'image-bytes'); return send({ file_info: 'opaque-upload', file_uuid: 'uuid' }); }
    if (r.method === 'DELETE') return send(null, 204);
    if (r.url.endsWith('/messages')) { sendCount++; return send(noId ? {} : { id: 'sent-' + sendCount, timestamp: '2026-10-26T00:00:00Z' }); }
    send({ id: 'bot' });
  }); t.after(() => api.close()); const client = createQqClient({ accountId: 'bot', appSecret: 'secret', transport: { contexts: { 'group:group-A': { messageId: 'actual-incoming-message', at: Date.now() } } } }, { endpoints: { api: api.url } }); t.after(() => client.close());
  assert.equal((await client.inspectCapabilities())['chat.voice'].supported, false); assert.match((await client.inspectCapabilities())['chat.voice'].reason, /PCM WAV/);
  assert.equal((await client.sendVoice(route('qq'), Buffer.from('RIFF-pcm-wav'), { deliveryId: 'voice-unavailable' })).code, 'QQ_VOICE_CODEC_UNAVAILABLE'); assert.equal(api.requests.length, 0);
  const image = await client.execute(route('qq'), 'chat.image', { bytes: Buffer.from('image-bytes') }, { deliveryId: 'image-1' }); assert.equal(image.status, 'delivered'); assert.equal(image.messageIdKind, 'server_id');
  assert.equal((await client.execute(route('qq'), 'message.retract', { messageId: 'sent-1' }, { deliveryId: 'retract-1' })).status, 'completed');
  noId = true; assert.equal((await client.sendText(route('qq'), '原文', { deliveryId: 'text-unknown' })).status, 'unknown'); assert.equal(sendCount, 2);
});

test('Wechat long-poll persists its cursor only after native acceptance and ret0 receipts retain client-ID provenance', async t => {
  let delivered = false; const api = await server((r, send) => {
    assert.equal(r.headers.authorization, 'Bearer private-token');
    if (r.url.endsWith('/getconfig')) return send({ ret: 0 });
    if (r.url.endsWith('/getupdates')) { if (!delivered) { delivered = true; return send({ ret: 0, get_updates_buf: 'next-cursor', msgs: [{ message_type: 1, message_id: '18446744073709551615', from_user_id: 'person@im.wechat', create_time_ms: 123, context_token: 'private-context', item_list: [{ type: 1, text_item: { text: '原文' } }] }] }); } return send({ ret: 0, msgs: [], get_updates_buf: 'next-cursor' }); }
    if (r.url.endsWith('/sendmessage')) { assert.equal(r.body.msg.context_token, 'private-context'); assert.equal(r.body.msg.client_id, 'delivery-1'); return send({ ret: 0 }); }
    send({}, 404);
  }); t.after(() => api.close()); const checkpoints = [], events = []; const client = createWechatClient({ accountId: 'bot', token: 'private-token', pairedUserId: 'person@im.wechat', apiBase: api.url, transport: { cursor: '', contexts: {} } }, { endpoints: { api: api.url }, onCheckpoint: async state => checkpoints.push(state) }); t.after(() => client.close());
  await client.listen(async event => { events.push(event); return { status: 'accepted' }; }); await until(() => checkpoints.length > 0);
  assert.equal(events[0].message.id, '18446744073709551615'); assert.equal(checkpoints[0].cursor, 'next-cursor');
  const result = await client.sendText(route('wechat'), '回复', { deliveryId: 'delivery-1' }); assert.equal(result.status, 'delivered'); assert.equal(result.messageId, 'delivery-1'); assert.equal(result.messageIdKind, 'client_id'); assert.equal(result.confirmedBy, 'ilink-ret0');
  assert.equal((await client.inspectCapabilities())['feed.publish'].supported, false); assert.equal((await client.inspectCapabilities())['call.voice'].supported, false); await client.stop();
});

test('Wechat actual media flow encrypts uploaded bytes and sends the returned CDN reference', async t => {
  let key, uploaded = false, mediaMessage; const api = await server((r, send) => {
    if (r.url.endsWith('/getuploadurl')) { key = Buffer.from(r.body.aeskey, 'hex'); assert.equal(r.body.media_type, 1); return send({ upload_full_url: api.url + '/cdn/upload' }); }
    if (r.url === '/cdn/upload') { const decipher = createDecipheriv('aes-128-ecb', key, null); assert.equal(Buffer.concat([decipher.update(r.raw), decipher.final()]).toString(), 'actual-image'); uploaded = true; return send(null, 200, { 'x-encrypted-param': 'actual-cdn-reference' }); }
    if (r.url.endsWith('/sendmessage')) { assert.equal(uploaded, true); mediaMessage = r.body.msg; return send({ ret: 0 }); }
    send({}, 404);
  }); t.after(() => api.close()); const client = createWechatClient({ accountId: 'bot', token: 'secret', pairedUserId: 'person@im.wechat', apiBase: api.url, transport: { cursor: '', contexts: { 'person@im.wechat': { token: 'context' } } } }, { endpoints: { api: api.url, cdn: api.url } }); t.after(() => client.close());
  const sent = await client.execute(route('wechat'), 'chat.image', { bytes: Buffer.from('actual-image'), mime: 'image/png' }, { deliveryId: 'media-1' }); assert.equal(sent.status, 'delivered'); assert.equal(sent.messageIdKind, 'client_id'); assert.equal(mediaMessage.item_list[0].image_item.media.encrypt_query_param, 'actual-cdn-reference'); assert.equal(Buffer.from(mediaMessage.item_list[0].image_item.media.aes_key, 'base64').toString(), key.toString('hex'));
  const disconnected = createWechatClient({ accountId: 'bot', token: 'secret', pairedUserId: 'person@im.wechat', apiBase: api.url, transport: { cursor: '', contexts: {} } }, { endpoints: { api: api.url, cdn: api.url } }); t.after(() => disconnected.close());
  const before = api.requests.length; assert.equal((await disconnected.execute(route('wechat'), 'chat.image', { bytes: Buffer.from('image') }, { deliveryId: 'no-context' })).code, 'WECHAT_CONTEXT_UNAVAILABLE'); assert.equal(api.requests.length, before);
});

test('a stopped Wechat poll cannot mutate or terminate a newly started transport', async t => {
  const pending = [], events = [], errors = [];
  const response = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, options) => url.endsWith('/getconfig') ? response({ ret: 0 }) : new Promise(resolve => { pending.push({ resolve: value => resolve(response(value)), signal: options.signal }); });
  const client = createWechatClient({ accountId: 'bot', token: 'secret', pairedUserId: 'u', transport: { cursor: '', contexts: {} } }, { fetchImpl, onError: error => errors.push(error.code) });
  t.after(async () => { await client.stop(); for (const request of pending) request.resolve({ ret: 0, msgs: [] }); await client.close(); });
  const receive = async event => { events.push(event); return { status: 'accepted' }; };
  await client.listen(receive); await until(() => pending.length === 1); await client.stop(); assert.equal(pending[0].signal.aborted, true);
  await client.listen(receive); await until(() => pending.length === 2);
  const message = id => ({ ret: 0, get_updates_buf: id, msgs: [{ message_type: 1, message_id: id, from_user_id: 'u', create_time_ms: 1, context_token: 'c', item_list: [{ type: 1, text_item: { text: id } }] }] });
  pending[0].resolve(message('stale')); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(events.length, 0); assert.equal(client.listening, true);
  pending[1].resolve(message('fresh')); await until(() => events.length === 1); assert.equal(events[0].message.id, 'fresh'); assert.deepEqual(errors, []);
});

test('official channel service bypasses no callback auth, retains its native route and guards media actions durably', async () => {
  const storage = memory(), actions = [], inbox = [], authorizations = []; let on = false;
  const client = { capabilities: { text: true, voice: false }, get listening() { return on; }, async probe() { return { connected: true, accountId: 'bot', capabilities: { text: true } }; }, async inspectCapabilities() { return { 'chat.text': { supported: true }, 'chat.image': { supported: true } }; }, async sendText() { return { status: 'delivered', messageId: 'text-1', receiptId: 'ack-1' }; }, async execute(target, capability, payload, options) { actions.push({ target, capability, payload, options }); return { status: 'delivered', messageId: 'image-1', receiptId: 'ack-image', messageIdKind: 'server_id' }; } };
  const connectionPort = { ready: Promise.resolve(), client: () => client, async listen() { on = true; }, async stop() { on = false; } };
  const native = { async create() { return { provider: 'fixture', model: 'fixture' }; }, async send(binding, value) { inbox.push({ binding, value }); return { status: 'accepted' }; }, async close() {}, async closeChannel() {} };
  const c = { ready: Promise.resolve(), memoryRoot: resolve('isolated-persona'), agents: new Map() };
  const service = createChannelService({ storage, connectionPort, getCoordinator: () => c, channelPort: native, authorizeAction: async value => { authorizations.push(value); } });
  await service.configure({ id: 'qq', config: { mode: 'official', accountId: 'bot', allowedPrivateIds: ['person'], allowedGroupIds: ['group-A'] } }); await service.start({ id: 'qq' }); assert.equal((await service.status()).listener.running, false);
  const event = { platform: 'qq', accountId: 'bot', sender: { id: 'person' }, conversation: { id: 'group-A', type: 'group' }, message: { id: 'source-1', text: '原文', createdAt: 100 }, textComplete: true, unsupportedSegments: [] };
  const received = await service.receive({ id: 'qq', event }); assert.equal(received.status, 'accepted'); assert.equal(inbox.length, 1);
  const request = { sessionId: received.sessionId, capability: 'chat.image', payload: { bytes: Buffer.from('image'), mime: 'image/png' }, requestId: 'operation-1' };
  assert.equal((await service.execute(request)).status, 'delivered'); assert.equal((await service.execute(request)).duplicate, true); assert.equal(actions.length, 1); assert.equal(authorizations[0].capability, 'chat.image'); assert.equal((await service.capabilities({ sessionId: received.sessionId })).voiceMode, 'text');
  await assert.rejects(service.execute({ ...request, payload: { bytes: Buffer.from('different') } }), { code: 'CHANNEL_OUTPUT_CONFLICT' });
  await service.stop({ id: 'qq' }); await service.configure({ id: 'qq', config: { accountId: 'new-bot' } }); assert.equal(storage.value.bindings[0].retired, true); await service.close();
});

test('cancelling an in-flight QR poll aborts the owner network request and leaves no account', async t => {
  const api = await server((r, send) => { if (r.url.includes('create_bind_task')) return send({ retcode: 0, data: { task_id: 'task' } }); }); t.after(() => api.close());
  const service = createConnectionService({ storage: memory(), endpoints: { qq: { binding: api.url } } }); t.after(() => service.close());
  const flow = (await service.start({ id: 'qq' })).connections[0]; const pending = service.poll({ id: 'qq', flowId: flow.flowId });
  await until(() => api.requests.some(r => r.url.includes('poll_bind_result'))); await service.cancel({ id: 'qq', flowId: flow.flowId }); await pending;
  assert.equal((await service.status()).connections[0].phase, 'idle'); assert.equal((await service.status()).connections[0].hasCredentials, false);
});

test('Wechat authorization rejects an untrusted returned API host without persisting or returning its credential', async t => {
  const api = await server((r, send) => r.url.includes('get_bot_qrcode') ? send({ qrcode: 'q', qrcode_img_content: 'https://liteapp.weixin.qq.com/q' }) : send({ status: 'confirmed', bot_token: 'must-remain-private', ilink_bot_id: 'bot', ilink_user_id: 'u', baseurl: 'https://untrusted.example' })); t.after(() => api.close());
  const store = memory(), service = createConnectionService({ storage: store, endpoints: { wechat: { api: api.url } } }); t.after(() => service.close());
  const flow = (await service.start({ id: 'wechat' })).connections[1], result = await service.poll({ id: 'wechat', flowId: flow.flowId });
  assert.equal(result.connections[1].phase, 'failed'); assert.equal(result.connections[1].hasCredentials, false); assert.doesNotMatch(JSON.stringify(result), /must-remain-private|untrusted\.example/); assert.equal(store.value, null);
});

test('Wechat unknown native intake stops transport without advancing its cursor or retrying the model', async t => {
  const api = await server((r, send) => r.url.endsWith('/getconfig') ? send({ ret: 0 }) : send({ ret: 0, get_updates_buf: 'new-cursor', msgs: [{ message_type: 1, message_id: 'm', from_user_id: 'u', create_time_ms: 1, context_token: 'c', item_list: [{ type: 1, text_item: { text: 'pending' } }] }] })); t.after(() => api.close());
  let calls = 0, checkpoints = 0; const errors = [];
  const client = createWechatClient({ accountId: 'bot', token: 'secret', pairedUserId: 'u', apiBase: api.url, transport: { cursor: 'old', contexts: {} } }, { endpoints: { api: api.url }, onCheckpoint: async () => checkpoints++, onError: error => errors.push(error.code) }); t.after(() => client.close());
  await client.listen(async () => { calls++; return { status: 'unknown' }; }); await until(() => errors.length > 0); assert.equal(calls, 1); assert.equal(checkpoints, 0); assert.equal(client.listening, false); assert.deepEqual(errors, ['CONNECTION_INBOUND_UNKNOWN']);
});

test('Wechat HTTP success with missing application acknowledgement is unknown, not a fabricated message receipt', async t => {
  const api = await server((r, send) => send({})); t.after(() => api.close());
  const client = createWechatClient({ accountId: 'bot', token: 'secret', pairedUserId: 'person@im.wechat', apiBase: api.url, transport: { cursor: '', contexts: { 'person@im.wechat': { token: 'c' } } } }, { endpoints: { api: api.url } }); t.after(() => client.close());
  const result = await client.sendText(route('wechat'), 'text', { deliveryId: 'd' }); assert.equal(result.status, 'unknown'); assert.equal(result.messageId, undefined); assert.equal(api.requests.length, 1);
});

test('QQ fatal gateway authority rejection surfaces once instead of silently changing group subscriptions', async t => {
  class Socket extends EventTarget { readyState = 1; constructor() { super(); queueMicrotask(() => { const event = new Event('close'); Object.defineProperty(event, 'code', { value: 4915 }); this.dispatchEvent(event); }); } close() { this.readyState = 3; } }
  const api = await server((r, send) => r.url.includes('getAppAccessToken') ? send({ access_token: 'token', expires_in: 3600 }) : send({ url: api.url.replace('http:', 'ws:') })); t.after(() => api.close());
  const client = createQqClient({ accountId: 'app', appSecret: 'secret', transport: { contexts: {} } }, { endpoints: { api: api.url }, WebSocketImpl: Socket }); t.after(() => client.close());
  await assert.rejects(client.listen(async () => {}), { code: 'QQ_GATEWAY_AUTHORITY_REJECTED' }); assert.equal(client.listening, false); assert.equal(api.requests.filter(r => r.url === '/gateway').length, 1);
});

test('platform authorization executes before a mutation; unknown receipts survive restart without replay', async () => {
  const store = memory(); let enabled = false, allowed = false, count = 0;
  const client = { get listening() { return enabled; }, capabilities: { text: true }, async probe() { return { connected: true, accountId: 'bot' }; }, async inspectCapabilities() { return { 'chat.image': { supported: true }, 'message.retract': { supported: true } }; }, async execute(target, capability) { count++; return capability === 'message.retract' ? { status: 'completed', receiptId: 'retract-receipt', affectedMessageId: 'actual-message', confirmedBy: 'platform-success' } : { status: 'unknown', code: 'LOST_ACK' }; } };
  const port = { ready: Promise.resolve(), client: () => client, async listen() { enabled = true; }, async stop() { enabled = false; } }, coordinator = { ready: Promise.resolve(), memoryRoot: resolve('fixture-unknown'), agents: new Map() }, native = { async create() { return { provider: 'fixture', model: 'fixture' }; }, async send() { return { status: 'accepted' }; }, async close() {} };
  const create = () => createChannelService({ storage: store, getCoordinator: () => coordinator, channelPort: native, connectionPort: port, authorizeAction: async () => { if (!allowed) throw Object.assign(new Error('denied'), { code: 'CAPABILITY_PERMISSION_DENIED' }); } });
  let service = create(); await service.configure({ id: 'qq', config: { mode: 'official', accountId: 'bot', allowedPrivateIds: ['u'] } }); await service.start({ id: 'qq' });
  const event = { platform: 'qq', accountId: 'bot', sender: { id: 'u' }, conversation: { id: 'u', type: 'private' }, message: { id: 'm', text: 't', createdAt: 1 }, unsupportedSegments: [], textComplete: true }, received = await service.receive({ id: 'qq', event });
  const args = { sessionId: received.sessionId, capability: 'chat.image', payload: { bytes: Buffer.from('image') }, requestId: 'stable-operation' }, before = store.value.receipts.length;
  await assert.rejects(service.execute(args), { code: 'CAPABILITY_PERMISSION_DENIED' }); assert.equal(count, 0); assert.equal(store.value.receipts.length, before);
  allowed = true; assert.equal((await service.execute(args)).status, 'unknown'); assert.equal(count, 1);
  const retract = { sessionId: received.sessionId, capability: 'message.retract', payload: { messageId: 'actual-message' }, requestId: 'stable-retract' }, actual = await service.execute(retract); assert.equal(actual.status, 'completed'); await service.close();
  service = create(); await service.resume(); assert.equal((await service.execute(args)).status, 'unknown'); assert.deepEqual(await service.execute(retract), { ...actual, duplicate: true }); assert.equal(count, 2); await service.close();
  const full = store.value, pinned = full.receipts.find(value => value.capability === 'message.retract');
  full.receipts.push(...Array.from({ length: 1024 }, (_, index) => ({ ...pinned, id: createHash('sha256').update('pinned-' + index).digest('hex') }))); await store.write(full);
  service = create(); await service.resume(); await assert.rejects(service.execute({ ...retract, requestId: 'capacity-blocked' }), { code: 'CHANNEL_RECEIPT_CAPACITY' }); assert.equal(count, 2); assert.deepEqual(await service.execute(retract), { ...actual, duplicate: true }); await service.close();
});

test('documented NapCat actions expose usable sticker, quote, retract and bounded contact reads without arbitrary paths', async t => {
  const api = await server((r, send) => {
    const name = r.url.slice(1); const data = name === 'get_login_info' ? { user_id: 123 } : name === 'get_status' ? { good: true, online: true } : name === 'can_send_record' || name === 'can_send_image' ? { yes: true } : name === 'get_version_info' ? { app_name: 'NapCat', app_version: 'test' } : name === 'get_friend_list' ? [{ user_id: 7, nickname: '真实平台昵称' }] : name === 'send_private_msg' ? { message_id: 9 } : null;
    if (name === 'get_supported_actions') return send({ status: 'failed', retcode: 1404 });
    return send({ status: 'ok', retcode: 0, data });
  }); t.after(() => api.close()); const client = createBridgeClient({ platform: 'qq', protocol: 'onebot11', accountId: '123', apiUrl: api.url });
  await client.probe(); const caps = await client.inspectCapabilities(); assert.equal(caps['chat.sticker'].supported, true); assert.equal(caps['feed.publish'].supported, false); assert.equal(caps['call.voice'].supported, false);
  const target = { platform: 'qq', accountId: '123', conversation: { type: 'private', id: '7' }, sender: { id: '7' } };
  assert.equal((await client.execute(target, 'chat.sticker', { stickerId: '14' }, { deliveryId: 'sticker' })).status, 'delivered'); assert.deepEqual(api.requests.at(-1).body.message, [{ type: 'face', data: { id: 14 } }]);
  assert.equal((await client.execute(target, 'message.reply', { quoteMessageId: '2', text: 'reply' }, { deliveryId: 'quote' })).status, 'delivered');
  const contacts = await client.execute(target, 'contacts.read', {}, { deliveryId: 'read' }); assert.equal(contacts.data[0].name, '真实平台昵称'); assert.equal(contacts.complete, true);
  assert.equal((await client.execute(target, 'message.retract', { messageId: '9' }, { deliveryId: 'retract' })).status, 'completed');
});
