import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { decodeOneBotEvent, createOneBotClient, ONEBOT_LIMITS } from '../adapters/dsh/channels/onebot.js';

const qq = { platform: 'qq', protocol: 'onebot11', accountId: '10001' };
const wechat = { platform: 'wechat', protocol: 'onebot12', accountId: 'wxid-bot' };
const textSegment = text => ({ type: 'text', data: { text } });
const qqMessage = (extra = {}) => ({ time: 1000, self_id: 10001, post_type: 'message', message_type: 'private', sub_type: 'friend', message_id: 7, user_id: 20001, message: [textSegment('原文🙂')], sender: { user_id: 20001, nickname: '同名用户' }, ...extra });
const wxMessage = (extra = {}) => ({ id: 'event-1', self: { platform: 'wechat', user_id: 'wxid-bot' }, time: 1000.125, type: 'message', detail_type: 'private', sub_type: '', message_id: 'wx-msg-1', user_id: 'wxid-user-1', message: [textSegment('微信原文')], alt_message: '不得代替原文', ...extra });

test('OneBot11 private and group events retain stable account, actual actors, native message IDs and exact text segments', () => {
  const direct = decodeOneBotEvent(qq, qqMessage());
  assert.deepEqual(direct.conversation, { id: '20001', type: 'private' }); assert.equal(direct.sender.id, '20001'); assert.equal(direct.message.id, '7'); assert.equal(direct.message.createdAt, 1000000); assert.equal(direct.message.text, '原文🙂');
  const first = decodeOneBotEvent(qq, qqMessage({ message_type: 'group', sub_type: 'normal', group_id: 30001, message_id: -100, message: [textSegment('第一段'), textSegment('第二段')] }));
  const second = decodeOneBotEvent(qq, qqMessage({ message_type: 'group', sub_type: 'normal', group_id: 30001, user_id: 20002, message_id: -101, sender: { user_id: 20002, nickname: '同名用户' } }));
  assert.deepEqual(first.conversation, second.conversation); assert.notEqual(first.sender.id, second.sender.id); assert.equal(first.sender.name, second.sender.name); assert.equal(first.message.text, '第一段第二段'); assert.equal(first.message.id, '-100');
});

test('OneBot12 bridge private/group payloads keep room and sender distinct without claiming WeChat driver capability', () => {
  const direct = decodeOneBotEvent(wechat, wxMessage()); assert.equal(direct.conversation.id, 'wxid-user-1'); assert.equal(direct.rawReceiptId, 'event-1'); assert.equal(direct.message.createdAt, 1000125);
  const group = decodeOneBotEvent(wechat, wxMessage({ detail_type: 'group', group_id: 'room-1@chatroom', user_id: 'wxid-alice', message_id: 'room-msg-1' }));
  const other = decodeOneBotEvent(wechat, wxMessage({ detail_type: 'group', group_id: 'room-1@chatroom', user_id: 'wxid-bob', message_id: 'room-msg-2' }));
  assert.deepEqual(group.conversation, { id: 'room-1@chatroom', type: 'group' }); assert.equal(group.sender.id, 'wxid-alice'); assert.equal(other.sender.id, 'wxid-bob'); assert.equal(group.message.text, '微信原文');
});

test('OneBot event validation rejects mismatched accounts, conflicting actors and missing stable source fields', () => {
  assert.throws(() => decodeOneBotEvent(qq, qqMessage({ self_id: 10002 })), { code: 'ONEBOT_ACCOUNT_MISMATCH' });
  assert.throws(() => decodeOneBotEvent(wechat, wxMessage({ self: { platform: 'qq', user_id: 'wxid-bot' } })), { code: 'ONEBOT_ACCOUNT_MISMATCH' });
  assert.throws(() => decodeOneBotEvent(qq, qqMessage({ sender: { user_id: 99999 } })), { code: 'ONEBOT_ACTOR_MISMATCH' });
  for (const field of ['user_id', 'message_id', 'time']) assert.throws(() => { const value = qqMessage(); delete value[field]; return decodeOneBotEvent(qq, value); });
  assert.throws(() => decodeOneBotEvent(qq, qqMessage({ message_type: 'group', sub_type: 'normal' })), { code: 'ONEBOT_ID_INVALID' });
  assert.throws(() => decodeOneBotEvent(wechat, wxMessage({ detail_type: 'group' })), { code: 'ONEBOT_ID_INVALID' });
  assert.throws(() => decodeOneBotEvent(qq, qqMessage({ user_id: Number.MAX_SAFE_INTEGER + 1 })), { code: 'ONEBOT_ID_INVALID' });
});

test('OneBot own echoes, non-message events and unstable anonymous/system senders never become human originals', () => {
  assert.equal(decodeOneBotEvent(qq, qqMessage({ user_id: 10001, sender: { user_id: 10001 } })), null);
  assert.equal(decodeOneBotEvent(qq, qqMessage({ post_type: 'message_sent' })), null);
  assert.equal(decodeOneBotEvent(qq, qqMessage({ message_type: 'group', group_id: 30001, sub_type: 'anonymous', anonymous: { id: 1, name: 'anonymous' } })), null);
  assert.equal(decodeOneBotEvent(qq, qqMessage({ message_type: 'group', group_id: 30001, sub_type: 'notice' })), null);
  assert.equal(decodeOneBotEvent(wechat, wxMessage({ user_id: 'wxid-bot' })), null);
  assert.equal(decodeOneBotEvent(wechat, wxMessage({ type: 'notice' })), null);
});

test('OneBot does not invent media text, parse CQ strings, or infer identity from a nickname inside user text', () => {
  const normalized = decodeOneBotEvent(qq, qqMessage({ message: [textSegment('[小明 (55555)] 这只是用户写下的文字 [CQ:at,qq=all]'), { type: 'image', data: { file: 'unread-image', url: 'https://example.invalid/private' } }] }));
  assert.equal(normalized.sender.id, '20001'); assert(normalized.message.text.startsWith('[小明 (55555)]')); assert.deepEqual(normalized.unsupportedSegments, ['image']); assert.equal(normalized.textComplete, false); assert.equal(normalized.rich.media[0].fileId,'unread-image'); assert(!JSON.stringify(normalized.rich).includes('https://example.invalid/private'));
  const onlyMedia = decodeOneBotEvent(wechat, wxMessage({ message: [{ type: 'audio', data: { file_id: 'unread-audio' } }] })); assert.equal(onlyMedia.message.text, ''); assert.deepEqual(onlyMedia.unsupportedSegments, ['audio']);
  assert.throws(() => decodeOneBotEvent(qq, qqMessage({ message: '文字[CQ:image,file=x]', raw_message: 'fallback must not be used' })), { code: 'ONEBOT_MESSAGE_FORMAT' });
  assert.throws(() => decodeOneBotEvent(qq, qqMessage({ message: [textSegment('x'.repeat(ONEBOT_LIMITS.textChars + 1))] })), { code: 'ONEBOT_EVENT_CAPACITY' });
});

async function simulator(t, protocol, custom) {
  const calls = [], receivedMessages = [], sockets = new Set();
  const server = http.createServer(async (request, response) => {
    let source = ''; for await (const chunk of request) source += chunk;
    const body = JSON.parse(source), action = protocol === 'onebot11' ? request.url.slice(1) : body.action, params = protocol === 'onebot11' ? body : body.params;
    calls.push({ action, params, body, authorization: request.headers.authorization, url: request.url });
    if (custom && await custom({ request, response, action, params, body, calls, receivedMessages })) return;
    let data;
    if (action === 'get_login_info') data = { user_id: 10001, nickname: 'fixture bot' };
    else if (action === 'get_self_info') data = { user_id: 'wxid-bot', user_name: 'fixture bot' };
    else if (action === 'get_status') data = protocol === 'onebot11' ? { good: true, online: true } : { good: true, bots: [{ self: { platform: 'wechat', user_id: 'wxid-bot' }, online: true }] };
    else if (action === 'can_send_record') data = { yes: true };
    else { receivedMessages.push({ action, params }); data = { message_id: protocol === 'onebot11' ? receivedMessages.length + 8000 : 'wx-sent-' + receivedMessages.length, time: 1234.125 }; }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: 'ok', retcode: 0, data, ...(body.echo ? { echo: body.echo } : {}) }));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { const closing = new Promise(resolve => server.close(resolve)); for (const socket of sockets) socket.destroy(); await closing; });
  const apiUrl = 'http://127.0.0.1:' + server.address().port;
  return { apiUrl, calls, receivedMessages };
}

test('OneBot11 real loopback HTTP probe and private/group sends use official routes, array text and Bearer-only auth', async t => {
  const sim = await simulator(t, 'onebot11'), client = createOneBotClient({ ...qq, apiUrl: sim.apiUrl, accessToken: 'isolated-test-token' }, { clock: () => 999000 });
  const probe = await client.probe(); assert.equal(probe.connected, true); assert.equal(probe.capabilities.voice, true); assert.equal(probe.livePlatformVerified, false);
  const privateResult = await client.sendText({ conversation: { type: 'private', id: '20001' } }, '字面[CQ:at,qq=all]🙂', { deliveryId: 'qq-private-1' });
  const groupResult = await client.sendText({ type: 'group', id: '30001' }, '群回复', { deliveryId: 'qq-group-1' });
  assert.equal(privateResult.status, 'delivered'); assert.equal(groupResult.status, 'delivered'); assert.equal(privateResult.messageId, '8001');
  assert.deepEqual(sim.receivedMessages.map(item => item.action), ['send_private_msg', 'send_group_msg']); assert.equal(sim.receivedMessages[0].params.user_id, 20001); assert.equal(sim.receivedMessages[1].params.group_id, 30001);
  assert.deepEqual(sim.receivedMessages[0].params.message, [textSegment('字面[CQ:at,qq=all]🙂')]); assert(sim.calls.every(call => call.authorization === 'Bearer isolated-test-token')); assert(sim.calls.every(call => !call.url.includes('isolated-test-token')));
});

test('OneBot12 real loopback HTTP sends actions at root with explicit self, room kinds and acknowledged message IDs', async t => {
  const sim = await simulator(t, 'onebot12'), client = createOneBotClient({ ...wechat, apiUrl: sim.apiUrl });
  const probe = await client.probe(); assert.equal(probe.connected, true); assert.equal(probe.capabilities.voice, false); assert.equal(probe.livePlatformVerified, false); assert(probe.bridgeCapabilityRequired.includes('must-be-verified'));
  const direct = await client.sendText({ platform: 'wechat', accountId: 'wxid-bot', conversation: { type: 'private', id: 'wxid-person' } }, '微信私聊回复', { deliveryId: 'wx-private-1' });
  const group = await client.sendText({ conversation: { type: 'group', id: 'room-1@chatroom' } }, '桥接群回复', { deliveryId: 'wx-group-1' }); assert.equal(direct.status, 'delivered'); assert.equal(group.status, 'delivered'); assert.equal(group.deliveredAt, 1234125);
  assert(sim.calls.every(call => call.url === '/')); const sends = sim.calls.filter(call => call.action === 'send_message'); assert.equal(sends[0].params.detail_type, 'private'); assert.equal(sends[0].params.user_id, 'wxid-person'); assert.equal(sends[1].params.group_id, 'room-1@chatroom'); assert.deepEqual(sends[1].body.self, { platform: 'wechat', user_id: 'wxid-bot' }); assert.equal(sends[1].body.echo, 'wx-group-1');
});

test('OneBot sends are idempotent by retained delivery ID and reject different content/target reuse', async t => {
  const sim = await simulator(t, 'onebot11'), client = createOneBotClient({ ...qq, apiUrl: sim.apiUrl });
  const [first, duplicate] = await Promise.all([client.sendText({ type: 'private', id: '20001' }, '一次原文', { deliveryId: 'same-1' }), client.sendText({ type: 'private', id: '20001' }, '一次原文', { deliveryId: 'same-1' })]);
  assert.equal(first.status, 'delivered'); assert.equal(duplicate.duplicate, true); assert.equal(sim.receivedMessages.length, 1);
  await assert.rejects(client.sendText({ type: 'private', id: '20001' }, '不同原文', { deliveryId: 'same-1' }), { code: 'ONEBOT_DELIVERY_CONFLICT' });
  await assert.rejects(client.sendText({ type: 'group', id: '30001' }, '一次原文', { deliveryId: 'same-1' }), { code: 'ONEBOT_DELIVERY_CONFLICT' }); assert.equal(sim.receivedMessages.length, 1);
});

test('OneBot status ok without message_id stays unknown, never resends, and explicit rejection omits raw bridge text', async t => {
  const sim = await simulator(t, 'onebot11', async ({ response, action, params }) => {
    if (!action.startsWith('send_')) return false;
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(params.message[0].data.text === 'unknown' ? { status: 'ok', retcode: 0, data: {} } : { status: 'failed', retcode: 1404, message: 'isolated-test-token must not leak' })); return true;
  }), client = createOneBotClient({ ...qq, apiUrl: sim.apiUrl, accessToken: 'isolated-test-token' });
  const args = { deliveryId: 'unknown-1' }, first = await client.sendText({ type: 'private', id: '20001' }, 'unknown', args), duplicate = await client.sendText({ type: 'private', id: '20001' }, 'unknown', args); assert.equal(first.status, 'unknown'); assert.equal(duplicate.status, 'unknown'); assert.equal(duplicate.duplicate, true); assert.equal(sim.calls.length, 1);
  const rejected = await client.sendText({ type: 'private', id: '20001' }, 'reject', { deliveryId: 'reject-1' }); assert.equal(rejected.status, 'failed'); assert.equal(rejected.retcode, 1404); assert(!JSON.stringify(rejected).includes('isolated-test-token'));
});

test('OneBot timeout/lost response returns unknown and does not automatically retry a side effect', async t => {
  const sim = await simulator(t, 'onebot11', async ({ action }) => action.startsWith('send_')), client = createOneBotClient({ ...qq, apiUrl: sim.apiUrl }, { timeoutMs: 40 });
  const result = await client.sendText({ type: 'private', id: '20001' }, '一次超时发送', { deliveryId: 'timeout-1' }); assert.equal(result.status, 'unknown'); assert.equal(result.code, 'ONEBOT_TIMEOUT');
  assert.equal((await client.sendText({ type: 'private', id: '20001' }, '一次超时发送', { deliveryId: 'timeout-1' })).duplicate, true); assert.equal(sim.calls.length, 1);
});

test('OneBot response bounds and redirect refusal preserve unknown outcomes without leaking credentials', async t => {
  const sim = await simulator(t, 'onebot11', async ({ response, action, params }) => {
    if (!action.startsWith('send_')) return false;
    if (params.message[0].data.text === 'redirect') { response.writeHead(302, { location: '/must-not-follow' }); response.end(); }
    else { response.writeHead(200, { 'content-type': 'application/json' }); response.end('x'.repeat(ONEBOT_LIMITS.responseBytes + 1)); }
    return true;
  }), client = createOneBotClient({ ...qq, apiUrl: sim.apiUrl, accessToken: 'isolated-test-token' });
  const redirected = await client.sendText({ type: 'private', id: '20001' }, 'redirect', { deliveryId: 'redirect-1' }); assert.equal(redirected.status, 'unknown');
  const oversized = await client.sendText({ type: 'private', id: '20001' }, 'oversized', { deliveryId: 'large-1' }); assert.equal(oversized.status, 'unknown'); assert.equal(oversized.code, 'ONEBOT_RESPONSE_CAPACITY');
  assert.equal(sim.calls.length, 2); assert(!sim.calls.some(call => call.url === '/must-not-follow')); assert(!JSON.stringify([redirected, oversized]).includes('isolated-test-token'));
});

test('OneBot11 record send requires capability evidence and sends only caller audio bytes, not arbitrary file paths', async t => {
  const sim = await simulator(t, 'onebot11'), client = createOneBotClient({ ...qq, apiUrl: sim.apiUrl }), bytes = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]);
  assert.equal((await client.sendVoice({ type: 'private', id: '20001' }, bytes, { deliveryId: 'voice-before-probe' })).status, 'unsupported'); assert.equal(sim.calls.length, 0);
  await client.probe(); const sent = await client.sendVoice({ type: 'group', id: '30001' }, { bytes }, { deliveryId: 'voice-after-probe' }); assert.equal(sent.status, 'delivered');
  const audio = sim.receivedMessages[0].params.message[0]; assert.equal(audio.type, 'record'); assert.equal(audio.data.file, 'base64://' + Buffer.from(bytes).toString('base64'));
  await assert.rejects(client.sendVoice({ type: 'group', id: '30001' }, { path: 'C:/not-allowed.wav' }, { deliveryId: 'path-not-read' }), { code: 'ONEBOT_AUDIO_CAPACITY' });
});

test('OneBot client rejects token-in-URL, public HTTP/default public HTTPS, unsafe IDs and cross-account targets', async () => {
  for (const apiUrl of ['http://127.0.0.1/?access_token=never', 'http://user:password@127.0.0.1/', 'file:///C:/data', 'http://203.0.113.1/', 'https://example.com/']) assert.throws(() => createOneBotClient({ ...qq, apiUrl }));
  assert.throws(() => createOneBotClient({ ...qq, apiUrl: 'http://example.com/', allowRemote: true }), { code: 'ONEBOT_API_REMOTE_DISABLED' });
  let calls = 0; const client = createOneBotClient({ ...qq, apiUrl: 'https://example.com/', allowRemote: true }, { fetchImpl: async () => { calls++; return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 12 } })); } });
  await assert.rejects(client.sendText({ platform: 'wechat', type: 'private', id: '20001' }, 'text', { deliveryId: 'cross-platform' }), { code: 'ONEBOT_TARGET_MISMATCH' });
  await assert.rejects(client.sendText({ accountId: '99999', type: 'private', id: '20001' }, 'text', { deliveryId: 'cross-account' }), { code: 'ONEBOT_TARGET_MISMATCH' });
  await assert.rejects(client.sendText({ type: 'private', id: 'not-a-number' }, 'text', { deliveryId: 'bad-id' }), { code: 'ONEBOT_ID_INVALID' }); assert.equal(calls, 0);
  assert.equal((await client.sendText({ type: 'private', id: '20001' }, 'explicit HTTPS mock', { deliveryId: 'explicit-remote' })).status, 'delivered'); assert.equal(calls, 1);
});

test('OneBot12 mismatched echo cannot confirm delivery and a mismatched bot cannot pass the probe', async () => {
  const client = createOneBotClient({ ...wechat, apiUrl: 'http://127.0.0.1:17655' }, { fetchImpl: async (_url, options) => { const body = JSON.parse(options.body); return new Response(JSON.stringify(body.action === 'get_self_info' ? { status: 'ok', retcode: 0, data: { user_id: 'another-bot' } } : { status: 'ok', retcode: 0, data: { message_id: 'sent-but-wrong-echo' }, echo: 'wrong' })); } });
  assert.equal((await client.probe()).code, 'ONEBOT_ACCOUNT_MISMATCH'); assert.equal((await client.sendText({ type: 'private', id: 'wxid-person' }, 'text', { deliveryId: 'correct-echo-id' })).status, 'unknown');
});

test('OneBot unknown receipts remain bounded and are not discarded to make room for new unconfirmed sends', async () => {
  let calls = 0; const client = createOneBotClient({ ...qq, apiUrl: 'http://127.0.0.1:17655' }, { fetchImpl: async () => { calls++; return new Response(JSON.stringify({ status: 'async', retcode: 1, data: null })); } });
  for (let index = 0; index < ONEBOT_LIMITS.receipts; index++) assert.equal((await client.sendText({ type: 'private', id: '20001' }, 'pending-' + index, { deliveryId: 'pending-' + index })).status, 'unknown');
  await assert.rejects(client.sendText({ type: 'private', id: '20001' }, 'new', { deliveryId: 'after-cap' }), { code: 'ONEBOT_RECEIPT_CAPACITY' }); assert.equal(calls, ONEBOT_LIMITS.receipts);
  assert.equal((await client.sendText({ type: 'private', id: '20001' }, 'pending-0', { deliveryId: 'pending-0' })).duplicate, true); assert.equal(calls, ONEBOT_LIMITS.receipts);
});
