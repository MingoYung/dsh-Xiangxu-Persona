import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createChannelService, CHANNEL_LIMITS } from '../adapters/dsh/channels/service.js';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
async function fixture(t, options = {}) {
  let disk = null, now = 1000000, current = { memoryRoot: join(tmpdir(), 'xiangxu-channels-persona'), ready: Promise.resolve(), agents: new Map() }, writes = 0;
  const received = [], created = [], sent = [], errors = [], closed = [], clients = [];
  const storage = { async read() { return structuredClone(disk); }, async write(value) { writes++; if (options.writeFault?.()) throw Object.assign(new Error('isolated storage fault'), { code: 'TEST_WRITE_FAULT' }); disk = structuredClone(value); } };
  const channelPort = {
    async create(binding) { created.push(binding); return { ...binding, ...(options.agentOptions ? { agentOptions: options.agentOptions } : {}) }; },
    async send(binding, message) { if (options.inboundFault) throw Object.assign(new Error('isolated inbound outcome unknown'), { code: 'TEST_INBOUND_UNKNOWN' }); received.push({ binding, message }); options.afterNativeSend?.(); return { status: 'accepted' }; },
    async close() { closed.push('all'); }, async closeChannel(binding) { closed.push(binding.sessionId); },
  };
  const clientFactory = profile => {
    clients.push(profile);
    return { async probe() { return { connected: !options.offline, status: options.offline ? 'offline' : 'connected', capabilities: { text: true, voice: false, group: true } }; },
      async sendText(target, text, args) { sent.push({ target, text, args }); return options.outboundResult ?? { status: 'delivered', deliveryId: args.deliveryId, messageId: 'platform-' + sent.length, receiptId: 'onebot:' + sent.length, deliveredAt: now, confirmedBy: 'onebot-message-id' }; } };
  };
  const settings = { getCoordinator: () => current, channelPort, storage, clientFactory, clock: () => now, port: 0, onError: error => errors.push(error) };
  let service = createChannelService(settings); const all = [service]; await service.ready;
  t.after(async () => { for (const value of all) await value.close(); });
  async function configure(id = 'qq', config = {}) { return service.configure({ id, config: { apiUrl: 'http://127.0.0.1:12345', accountId: id === 'qq' ? '100' : 'wx-bot', accessToken: 'isolated-api-token', allowedPrivateIds: ['*'], allowedGroupIds: ['*'], voiceMode: 'text', ...config } }); }
  async function start(id = 'qq', config = {}) { await configure(id, config); const secret = await service.rotateIngress({ id }); const status = await service.start({ id }); return { token: secret.ingressToken, url: status.connections.find(value => value.id === id).callbackUrl }; }
  async function callback(invitation, payload, { token = invitation.token, headers = {} } = {}) {
    const result = await fetch(invitation.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...headers }, body: JSON.stringify(payload) });
    return { http: result.status, value: await result.json() };
  }
  function event({ messageId = 1, sender = 11, group = 200, text = '原话 🙂', time = now / 1000, privateMessage = false } = {}) {
    return { post_type: 'message', message_type: privateMessage ? 'private' : 'group', self_id: 100, user_id: sender, sender: { user_id: sender, nickname: '昵称只是线索' }, ...(privateMessage ? {} : { group_id: group }), message_id: messageId, time, message: [{ type: 'text', data: { text } }] };
  }
  return { configure, start, callback, event, received, created, sent, errors, clients, closed, get service() { return service; }, disk: () => structuredClone(disk), setDisk: value => { disk = structuredClone(value); }, current: () => current, setCurrent: value => { current = value; }, advance: amount => { now += amount; }, writes: () => writes,
    async reopen({ resume = true } = {}) { await service.close(); service = createChannelService(settings); all.push(service); await service.ready; if (resume) await service.resume(); return service; } };
}

test('channels are disabled by default, keep credentials out of status and reject unsafe API configuration', async t => {
  const f = await fixture(t), initial = await f.service.status();
  assert.equal(initial.listener.running, false); assert(initial.connections.every(value => !value.enabled));
  await f.configure(); const value = await f.service.status(); assert.equal(value.connections[0].hasAccessToken, true); assert(!JSON.stringify(value).includes('isolated-api-token'));
  await f.service.configure({ id: 'qq', config: { accessToken: '' } }); assert.equal(f.disk().profiles[0].config.accessToken, 'isolated-api-token');
  await f.service.configure({ id: 'qq', config: { clearAccessToken: true } }); assert.equal(f.disk().profiles[0].config.accessToken, '');
  await assert.rejects(f.configure('qq', { apiUrl: 'http://public.example.test' }), { code: 'ONEBOT_API_REMOTE_DISABLED' });
  await assert.rejects(f.configure('qq', { apiUrl: 'https://user:secret@example.test' }), { code: 'CHANNEL_BAD_CONFIG' });
});

test('callback requires local host, origin and bearer authentication and bounded JSON', async t => {
  const f = await fixture(t), invitation = await f.start();
  assert.equal((await f.callback(invitation, f.event(), { token: 'wrong' })).http, 401);
  assert.equal((await f.callback(invitation, f.event(), { headers: { origin: 'https://evil.example' } })).http, 403);
  const hostStatus = await new Promise((resolve, reject) => { const request = httpRequest(invitation.url, { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json', authorization: 'Bearer ' + invitation.token } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); }); request.once('error', reject); request.end('{}'); });
  assert.equal(hostStatus, 403);
  const tooLarge = await f.callback(invitation, { padding: 'x'.repeat(CHANNEL_LIMITS.bodyBytes + 1) }); assert.equal(tooLarge.http, 413);
  assert.equal(f.received.length, 0); assert(!JSON.stringify(f.disk()).includes(invitation.token));
});

test('empty scopes reject intake without importing dialogue and retain only bounded excluded metadata', async t => {
  const f = await fixture(t), invitation = await f.start('qq', { allowedPrivateIds: [], allowedGroupIds: [] });
  for (let index = 0; index < 10; index++) { const result = await f.callback(invitation, f.event({ messageId: index + 1, text: '不能进入登记文件的原话' })); assert.equal(result.value.status, 'outside_scope'); }
  assert.equal(f.received.length, 0); assert.equal(f.disk().profiles[0].recentExcluded.length, 8); assert(!JSON.stringify(f.disk()).includes('不能进入登记文件的原话'));
});

test('group actors and private rooms use separate stable native channels and preserve original source facts', async t => {
  const f = await fixture(t), invitation = await f.start();
  await f.callback(invitation, f.event({ sender: 11, messageId: 1, text: 'A 原话' }));
  await f.callback(invitation, f.event({ sender: 12, messageId: 2, text: 'B 原话' }));
  await f.callback(invitation, f.event({ sender: 11, messageId: 3, privateMessage: true, text: '私聊原话' }));
  assert.equal(new Set(f.received.map(value => value.binding.sessionId)).size, 3);
  assert.equal(f.received[0].message.text, 'A 原话'); assert.equal(f.received[0].message.sourceFacts.sender.id, '11'); assert.equal(f.received[0].message.sourceFacts.conversation.id, '200');
  assert(f.received.every(value => value.message.messageId.startsWith('im-'))); assert(!JSON.stringify(f.disk()).includes('A 原话'));
});

test('inbound durable receipts deduplicate exact platform IDs and reject changed original text', async t => {
  const f = await fixture(t), invitation = await f.start(), payload = f.event({ text: '保真原话' });
  assert.equal((await f.callback(invitation, payload)).value.status, 'accepted');
  const duplicate = await f.callback(invitation, payload); assert.equal(duplicate.value.duplicate, true); assert.equal(f.received.length, 1);
  const conflict = await f.callback(invitation, f.event({ text: '替换原话' })); assert.equal(conflict.http, 400); assert.equal(conflict.value.error.code, 'CHANNEL_MESSAGE_CONFLICT');
  await f.reopen(); const current = (await f.service.status()).connections[0]; const replay = await f.callback({ ...invitation, url: current.callbackUrl }, payload); assert.equal(replay.value.duplicate, true); assert.equal(f.received.length, 1);
});

test('inbound uncertain outcomes persist unknown and never replay after restart', async t => {
  const f = await fixture(t, { inboundFault: true }), invitation = await f.start(), payload = f.event();
  const result = await f.callback(invitation, payload); assert.equal(result.value.status, 'unknown'); assert.equal(f.created.length, 1);
  await f.reopen(); const replay = await f.callback({ ...invitation, url: (await f.service.status()).connections[0].callbackUrl }, payload);
  assert.equal(replay.value.status, 'unknown'); assert.equal(f.created.length, 1); assert.equal(f.disk().receipts[0].status, 'unknown');
});

test('prepared receipt recovery becomes unknown without native or platform dispatch', async t => {
  const f = await fixture(t), invitation = await f.start(); await f.callback(invitation, f.event()); await f.service.close();
  const disk = f.disk(); disk.receipts[0].status = 'prepared'; f.setDisk(disk); const before = f.created.length; await f.reopen({ resume: false });
  assert.equal(f.disk().receipts[0].status, 'unknown'); assert.equal(f.created.length, before); assert.equal(f.sent.length, 0);
});

test('outbound ack is platform-only, persisted, repeat-safe and contains seq/hash for source reconciliation', async t => {
  const f = await fixture(t), invitation = await f.start(); await f.callback(invitation, f.event()); const sessionId = f.created[0].sessionId;
  const args = { sessionId, sourceEventId: 'assistant-final-1', seq: 10, text: '模型自己的最终原话', deliveryId: 'proactive-1' };
  const receipt = await f.service.output(args); assert.equal(receipt.status, 'delivered'); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].text, args.text); assert.equal(receipt.sourceSeq, 10); assert.equal(receipt.textHash, hash(args.text));
  const duplicate = await f.service.output(args); assert.equal(duplicate.duplicate, true); assert.equal(f.sent.length, 1);
  const reconciled = await f.service.reconcile({ target: { sessionId }, deliveryId: 'proactive-1' }); assert.equal(reconciled.status, 'delivered'); assert.equal(reconciled.text, undefined);
  await assert.rejects(f.service.output({ ...args, text: '别的原话' }), { code: 'CHANNEL_OUTPUT_CONFLICT' }); assert(!JSON.stringify(f.disk()).includes(args.text));
});

test('unknown platform result never becomes a native ack and is not retried across reload', async t => {
  const f = await fixture(t, { outboundResult: { status: 'unknown', code: 'ONEBOT_TIMEOUT' } }), invitation = await f.start(); await f.callback(invitation, f.event());
  const args = { sessionId: f.created[0].sessionId, sourceEventId: 'final-timeout', seq: 5, text: '尚未确认送出的原话' };
  assert.equal((await f.service.output(args)).status, 'unknown'); assert.equal((await f.service.reconcile({ sessionId: args.sessionId, sourceEventId: args.sourceEventId })).status, 'unknown');
  await f.reopen(); assert.equal((await f.service.output(args)).status, 'unknown'); assert.equal(f.sent.length, 1);
});

test('desktop UI replies are delivered as text with versioned source hashes and persist no message body', async t => {
  const f=await fixture(t),invitation=await f.start();await f.callback(invitation,f.event());
  const raw='我想好了。\n```dsh-ui\n'+JSON.stringify({title:'草案',items:[{type:'keyvalue',pairs:[{key:'昵称',value:'相续'}]}]})+'\n```';
  const args={sessionId:f.created[0].sessionId,sourceEventId:'ui-reply',seq:19,text:raw};
  const result=await f.service.output(args);assert.equal(result.status,'delivered');assert.equal(result.formatVersion,'dsh-plain/1');
  assert.match(result.text,/昵称：相续/);assert(!result.text.includes('dsh-ui'));assert.equal(f.sent[0].text,result.text);
  assert.equal(result.sourceTextHash,hash(raw));assert.equal(result.textHash,hash(result.text));
  assert(!JSON.stringify(f.disk()).includes('草案'));assert(!JSON.stringify(f.disk()).includes('相续'));
  await f.reopen();const restored=await f.service.reconcile({sessionId:args.sessionId,sourceEventId:args.sourceEventId});
  assert.equal(restored.sourceTextHash,hash(raw));assert.equal(restored.textHash,hash(result.text));assert.equal(restored.text,undefined);
  assert.equal((await f.service.output(args)).text,result.text);assert.equal(f.sent.length,1);
});

test('old raw output receipts replay exactly what was historically sent without a second platform message', async t => {
  const f=await fixture(t),invitation=await f.start();await f.callback(invitation,f.event());
  const text='```dsh-ui\n'+JSON.stringify({title:'历史原文',items:[]})+'\n```',args={sessionId:f.created[0].sessionId,sourceEventId:'legacy-card',seq:20,text};
  await f.service.output(args);const disk=f.disk(),receipt=disk.receipts.find(row=>row.kind==='outbound');
  delete receipt.formatVersion;delete receipt.sourceTextHash;receipt.textHash=hash(text);f.setDisk(disk);await f.reopen();
  const replay=await f.service.output(args);assert.equal(replay.status,'delivered');assert.equal(replay.text,text);assert.equal(replay.formatVersion,undefined);assert.equal(f.sent.length,1);
});

test('busy stop, suspend and restore invalidation fail before mutating state; explicit close still releases', async t => {
  const f = await fixture(t), invitation = await f.start(); await f.callback(invitation, f.event()); const sessionId = f.created[0].sessionId;
  f.current().agents.set(sessionId, { agent: { session: { id: sessionId }, status: 'running' } });
  await assert.rejects(f.service.stop({ id: 'qq' }), { code: 'CHANNEL_BUSY' }); await assert.rejects(f.service.suspend(), { code: 'CHANNEL_BUSY' }); await assert.rejects(f.service.invalidateForRoot(f.current().memoryRoot), { code: 'CHANNEL_BUSY' });
  assert.equal((await f.service.status()).listener.running, true); assert.equal(f.disk().profiles[0].enabled, true); assert.equal(f.disk().bindings[0].retired, false);
  await f.service.close(); assert(f.closed.includes('all'));
});

test('restore retires old source channels and requires explicit start while preserving duplicate receipts', async t => {
  const f = await fixture(t), invitation = await f.start(); await f.callback(invitation, f.event()); const old = f.created[0].sessionId;
  await f.service.invalidateForRoot(f.current().memoryRoot); assert.equal(f.disk().bindings[0].retired, true); assert.equal(f.disk().profiles[0].enabled, false); assert.equal(f.service.handles(old), true);
  assert.equal((await f.service.output({ sessionId: old, sourceEventId: 'retired-output', seq: 20, text: '不应发送的旧会话正文' })).status, 'unknown'); assert.equal(f.sent.length, 0);
  await f.service.start({ id: 'qq' }); const url = (await f.service.status()).connections[0].callbackUrl;
  await f.callback({ ...invitation, url }, f.event()); assert.equal(f.created.length, 1);
  f.advance(1000); await f.callback({ ...invitation, url }, f.event({ messageId: 2 })); assert.equal(f.created.length, 2); assert.notEqual(f.created[1].sessionId, old);
});

test('compaction uses an explicit dedupe floor and rejects expired unknown source IDs without dispatch', async t => {
  const f = await fixture(t), invitation = await f.start(); await f.callback(invitation, f.event()); await f.service.close();
  const disk = f.disk(), first = disk.receipts[0]; disk.receipts = Array.from({ length: CHANNEL_LIMITS.terminalReceipts + 1 }, (_, index) => ({ ...first, id: hash('terminal-' + index), messageId: 'im-' + hash('message-' + index), at: index + 100, sourceAt: index + 100, status: 'accepted' })); f.setDisk(disk);
  await f.reopen(); const currentInvitation = { ...invitation, url: (await f.service.status()).connections[0].callbackUrl };
  await f.callback(currentInvitation, f.event({ messageId: 3000 })); const before = f.received.length;
  const expired = await f.callback(currentInvitation, f.event({ messageId: 3001, time: 0 })); assert.equal(expired.http, 409); assert.equal(expired.value.error.code, 'CHANNEL_EVENT_OUTSIDE_DEDUPE_WINDOW'); assert.equal(f.received.length, before);
  assert(f.disk().bindings[0].inboundFloorAt >= 100); assert(f.disk().profiles[0].recentExcluded.some(value => value.code === 'CHANNEL_EVENT_OUTSIDE_DEDUPE_WINDOW'));
});

test('unresolved receipt capacity rejects before native intake and never deletes unknown entries', async t => {
  const f = await fixture(t), invitation = await f.start(); await f.callback(invitation, f.event()); await f.service.close();
  const disk = f.disk(), first = disk.receipts[0]; disk.receipts = Array.from({ length: CHANNEL_LIMITS.unresolved }, (_, index) => ({ ...first, id: hash('unknown-' + index), messageId: 'im-' + hash('u-' + index), status: 'unknown' })); f.setDisk(disk); await f.reopen();
  const before = f.created.length, result = await f.callback({ ...invitation, url: (await f.service.status()).connections[0].callbackUrl }, f.event({ messageId: 9000 })); assert.equal(result.http, 413); assert.equal(result.value.error.code, 'CHANNEL_RECEIPT_CAPACITY'); assert.equal(f.created.length, before); assert.equal(f.disk().receipts.length, CHANNEL_LIMITS.unresolved);
});

test('voice-only never silently sends text; both may report the real text ack with voice unavailable', async t => {
  const voice = await fixture(t), first = await voice.start('qq', { voiceMode: 'voice' }); await voice.callback(first, voice.event());
  const unavailable = await voice.service.output({ sessionId: voice.created[0].sessionId, sourceEventId: 'voice-final', seq: 10, text: '只能语音时不偷发文字' });
  assert.equal(unavailable.status, 'failed'); assert.equal(unavailable.voiceUnavailable, true); assert.equal(voice.sent.length, 0);
  const both = await fixture(t), second = await both.start('qq', { voiceMode: 'both' }); await both.callback(second, both.event());
  const acknowledged = await both.service.output({ sessionId: both.created[0].sessionId, sourceEventId: 'both-final', seq: 10, text: '实际文字原话' });
  assert.equal(acknowledged.status, 'delivered'); assert.equal(acknowledged.voiceUnavailable, true); assert.equal(both.sent.length, 1);
});

test('two profiles share one callback listener even when a test requests ephemeral port twice', async t => {
  const f = await fixture(t); await f.start('qq'); await f.configure('wechat'); await f.service.rotateIngress({ id: 'wechat' });
  const before = (await f.service.status()).listener.port; await f.service.start({ id: 'wechat', port: 0 });
  assert.equal((await f.service.status()).listener.port, before); assert((await f.service.status()).connections.every(value => value.enabled));
});

test('native accepted plus receipt-write failure reports unknown and never queues the input twice', async t => {
  let faults = 0;
  const f = await fixture(t, { afterNativeSend() { faults = 1; }, writeFault() { if (faults) { faults--; return true; } return false; } }), invitation = await f.start(), payload = f.event();
  const result = await f.callback(invitation, payload); assert.equal(result.http, 200); assert.equal(result.value.status, 'unknown'); assert.equal(result.value.code, 'CHANNEL_INBOUND_RECEIPT_UNKNOWN'); assert.equal(f.received.length, 1); assert.equal(f.disk().receipts[0].status, 'unknown');
  const duplicate = await f.callback(invitation, payload); assert.equal(duplicate.value.status, 'unknown'); assert.equal(f.received.length, 1);
});

test('prepared write failure happens before any native side effect and permits a later fresh acceptance', async t => {
  let faults = 0;
  const f = await fixture(t, { writeFault() { if (faults) { faults--; return true; } return false; } }), invitation = await f.start(), payload = f.event(); faults = 1;
  const result = await f.callback(invitation, payload); assert.equal(result.http, 400); assert.equal(f.created.length, 0); assert.equal(f.received.length, 0);
  assert.equal((await f.callback(invitation, payload)).value.status, 'accepted'); assert.equal(f.received.length, 1);
});

test('rotating ingress credentials while a request body is pending rejects the old authorization before intake', async t => {
  const f = await fixture(t), invitation = await f.start(), payload = JSON.stringify(f.event());
  let request;
  const completed = new Promise((resolve, reject) => {
    request = httpRequest(invitation.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + invitation.token } }, response => { let text = ''; response.on('data', chunk => { text += chunk; }); response.once('end', () => resolve({ http: response.statusCode, value: JSON.parse(text) })); });
    request.once('error', reject); request.write(payload.slice(0, 5));
  });
  await new Promise(resolve => setTimeout(resolve, 10)); await f.service.rotateIngress({ id: 'qq' }); request.end(payload.slice(5));
  const result = await completed; assert.equal(result.http, 401); assert.equal(f.received.length, 0);
});

test('each outbound send verifies the current bridge account instead of trusting an old probe', async t => {
  const options = {}, f = await fixture(t, options), invitation = await f.start(); await f.callback(invitation, f.event()); options.offline = true;
  const result = await f.service.output({ sessionId: f.created[0].sessionId, sourceEventId: 'after-account-change', seq: 10, text: '不能发给错误登录状态' });
  assert.equal(result.status, 'unknown'); assert.equal(f.sent.length, 0);
});

test('native model route is retained without credentials and real platform message metadata reaches the port', async t => {
  const route = { provider: 'fixture', model: 'fixture-v1', reasoningEffort: 'low', maxTokens: 1234 }, f = await fixture(t, { agentOptions: route }), invitation = await f.start();
  await f.callback(invitation, f.event({ messageId: 88, time: 50 }));
  assert.deepEqual(f.disk().bindings[0].agentOptions, route); assert.equal(f.received[0].message.sourceFacts.messageId, '88'); assert.equal(f.received[0].message.sourceFacts.sourceAt, 50000);
});
