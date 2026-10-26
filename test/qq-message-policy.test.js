import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createQqClient, QQ_DELIVERY_POLICY } from '../adapters/dsh/connections/qq.js';

const route = (type = 'private', id = 'person') => ({ platform: 'qq', accountId: 'bot', conversation: { type, id }, sender: { id: 'person' } });
function clientFor(transport = { contexts: {} }, now = 10000000) {
  const requests = []; let time = now;
  const fetchImpl = async (url, options = {}) => {
    const value = { url: String(url), method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null }; requests.push(value);
    const body = value.url.endsWith('/getAppAccessToken') ? { access_token: 'fixture-token', expires_in: 7200 } : value.url.endsWith('/files') ? { file_info: 'fixture-file' } : { id: 'actual-ack', timestamp: '2026-10-26T00:00:00Z' };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  const client = createQqClient({ accountId: 'bot', appSecret: 'fixture-secret', transport }, { fetchImpl, clock: () => time });
  return { client, requests, setTime(value) { time = value; } };
}

test('QQ official delivery facts distinguish supported replies from unavailable active push', async t => {
  const f = clientFor(); t.after(() => f.client.close()); const caps = await f.client.inspectCapabilities();
  assert.equal(caps['chat.text'].supported, true); assert.equal(caps['chat.text'].deliveryPolicy.proactive, false); assert.equal(QQ_DELIVERY_POLICY.passiveReplyRequired, true); assert.equal(QQ_DELIVERY_POLICY.privateReplyWindowMs, 3600000); assert.equal(QQ_DELIVERY_POLICY.groupReplyWindowMs, 300000);
  const probe = await f.client.probe(); assert.equal(probe.deliveryPolicy.proactive, false); assert.equal(probe.capabilities.proactive, false);
});

test('an unsupported proactive text has a definite failed outcome and performs no token or send request', async t => {
  const f = clientFor(); t.after(() => f.client.close()); const result = await f.client.sendText(route(), '人格自主想主动说的话', { deliveryId: 'active-wish' });
  assert.deepEqual(result, { status: 'failed', deliveryId: 'active-wish', code: 'QQ_PUSH_UNAVAILABLE' }); assert.equal(result.messageId, undefined); assert.deepEqual(f.requests, []);
});

test('unsupported active media returns before upload, authentication or message mutation', async t => {
  const f = clientFor(); t.after(() => f.client.close());
  for (const capability of ['chat.image', 'chat.video', 'chat.file']) { const result = await f.client.execute(route(), capability, { bytes: Buffer.from('actual-bytes') }, { deliveryId: capability }); assert.equal(result.status, 'failed'); assert.equal(result.code, 'QQ_PUSH_UNAVAILABLE'); }
  assert.equal(f.requests.length, 0);
});

test('a private reply between thirty and sixty minutes uses its actual passive message identifier', async t => {
  const now = 10000000, f = clientFor({ contexts: { 'private:person': { messageId: 'real-incoming-id', at: now - 45 * 60000 } } }, now); t.after(() => f.client.close());
  assert.equal((await f.client.sendText(route(), '被动回复', { deliveryId: 'reply-45m' })).status, 'delivered');
  const sent = f.requests.find(x => x.url.endsWith('/messages')); assert.equal(sent.body.msg_id, 'real-incoming-id'); assert.equal(sent.body.content, '被动回复'); assert.ok(Number.isInteger(sent.body.msg_seq));
});

test('private expiry is explicit and group reply windows do not inherit the private window', async t => {
  const now = 10000000, f = clientFor({ contexts: { 'private:person': { messageId: 'private-id', at: now - 3600000 }, 'group:room': { messageId: 'group-id', at: now - 300000 } } }, now); t.after(() => f.client.close());
  assert.equal((await f.client.sendText(route(), 'expired', { deliveryId: 'private-expired' })).code, 'QQ_PUSH_UNAVAILABLE');
  assert.equal((await f.client.sendText(route('group', 'room'), 'expired', { deliveryId: 'group-expired' })).code, 'QQ_PUSH_UNAVAILABLE'); assert.equal(f.requests.length, 0);
});

test('a fresh group reply and media preserve the same group context without selecting an unrelated private route', async t => {
  const now = 10000000, f = clientFor({ contexts: { 'private:person': { messageId: 'unrelated', at: now }, 'group:room': { messageId: 'group-id', at: now - 299999 } } }, now); t.after(() => f.client.close());
  const sent = await f.client.execute(route('group', 'room'), 'chat.image', { bytes: Buffer.from('image') }, { deliveryId: 'reply-image' }); assert.equal(sent.status, 'delivered');
  const request = f.requests.find(x => x.url.endsWith('/messages')); assert.equal(request.body.msg_id, 'group-id'); assert.match(request.url, /\/v2\/groups\/room\/messages$/); assert.equal(request.body.media.file_info, 'fixture-file');
});

test('future, malformed and another-recipient contexts cannot be used as real passive authority', async t => {
  const now = 10000000;
  for (const contexts of [{ 'private:person': { messageId: 'future', at: now + 1 } }, { 'private:person': { messageId: '', at: now } }, { 'private:person': { messageId: 'missing-time' } }, { 'private:other': { messageId: 'other', at: now } }]) {
    const f = clientFor({ contexts }, now); t.after(() => f.client.close()); assert.equal((await f.client.sendText(route(), 'text', { deliveryId: 'no-context' })).code, 'QQ_PUSH_UNAVAILABLE'); assert.equal(f.requests.length, 0);
  }
});

test('a lost reply acknowledgement remains unknown and is never fabricated as delivered', async t => {
  const now = Date.now(); let sends = 0;
  const client = createQqClient({ accountId: 'bot', appSecret: 'secret', transport: { contexts: { 'private:person': { messageId: 'source', at: now } } } }, { clock: () => now, fetchImpl: async url => { if (String(url).endsWith('/getAppAccessToken')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 7200 })); sends++; return new Response('{}'); } }); t.after(() => client.close());
  const result = await client.sendText(route(), 'reply', { deliveryId: 'unknown-reply' }); assert.equal(result.status, 'unknown'); assert.equal(result.code, 'QQ_MESSAGE_ID_MISSING'); assert.equal(result.messageId, undefined); assert.equal(sends, 1);
});

test('message retraction does not require a new incoming reply context', async t => {
  const f = clientFor(); t.after(() => f.client.close()); const result = await f.client.execute(route(), 'message.retract', { messageId: 'known-message' }, { deliveryId: 'retract' });
  assert.equal(result.status, 'completed'); assert.ok(f.requests.some(x => x.method === 'DELETE' && x.url.endsWith('/messages/known-message')));
});

test('loopback HTTP carries the real reply ID and original Unicode text in an actual POST', async t => {
  const requests = [], sockets = new Set(); const server = http.createServer(async (req, res) => { const bytes = []; for await (const part of req) bytes.push(part); const body = JSON.parse(Buffer.concat(bytes).toString('utf8')); requests.push({ url: req.url, headers: req.headers, body }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url.endsWith('/getAppAccessToken') ? { access_token: 'fixture-access', expires_in: 7200 } : { id: 'loopback-confirmed', timestamp: '2026-10-26T00:00:00Z' })); });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const now = Date.now(), client = createQqClient({ accountId: 'bot', appSecret: 'fixture-secret', transport: { contexts: { 'private:person': { messageId: 'incoming-real-id', at: now } } } }, { clock: () => now, endpoints: { api: 'http://127.0.0.1:' + server.address().port } }); t.after(() => client.close());
  const value = await client.sendText(route(), '原话😀组合字é', { deliveryId: 'wire-reply' }); assert.equal(value.status, 'delivered'); assert.equal(value.messageId, 'loopback-confirmed'); assert.equal(requests.length, 2); assert.equal(requests[1].body.msg_id, 'incoming-real-id'); assert.equal(requests[1].body.content, '原话😀组合字é'); assert.equal(requests[1].headers.authorization, 'QQBot fixture-access');
});
