import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createChannelService, CHANNEL_LIMITS } from '../adapters/dsh/channels/service.js';
import { projectSocialReply, resolveExternalOutput } from '../adapters/dsh/external-output.js';
import { groupReplyAddressEvidence } from '../adapters/dsh/social-dialogue.js';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const qqReply = (...bubbles) => '\x60\x60\x60xiangxu-qq\n' + JSON.stringify(bubbles) + '\n\x60\x60\x60';
const socialReply = (messages, addressee = 'uncertain', participation = 'join', reference = null) => '```xiangxu-social\n' + JSON.stringify({
  understanding: { addressee, reference }, participation, messages,
}) + '\n```';
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
      async sendText(target, text, args) {
        sent.push({ target, text, args });
        return await options.onOutbound?.(sent.length, text, args) ?? options.outboundResult ?? { status: 'delivered', deliveryId: args.deliveryId, messageId: 'platform-' + sent.length, receiptId: 'onebot:' + sent.length, deliveredAt: now, confirmedBy: 'onebot-message-id' };
      } };
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

test('group contract failures leave a durable failed receipt, send nothing, and can recover on a new final', async t => {
  const f = await fixture(t), invitation = await f.start();
  const incoming = await f.callback(invitation, f.event());
  const args = { sessionId: incoming.value.sessionId, sourceEventId: 'bad-social-final', seq: 2,
    outputContract: 'xiangxu-social/1', text: '未按格式生成的原文，不可以冒充已经送达' };
  const result = await f.service.output(args);
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'SOCIAL_REPLY_FORMAT_REQUIRED');
  assert.equal(f.sent.length, 0);
  assert.equal(f.service.findOutboundReceipt(args).code, 'SOCIAL_REPLY_FORMAT_REQUIRED');
  assert(!JSON.stringify(f.disk()).includes(args.text), 'receipt stores only a digest, not the rejected draft');
  await f.reopen();
  assert.equal((await f.service.output(args)).duplicate, true);
  assert.equal(f.sent.length, 0, 'restart does not re-send an invalid old draft');
  const recovered = await f.service.output({ ...args, sourceEventId: 'new-social-final', seq: 3, text: socialReply(['现在可以正确交付。']) });
  assert.equal(recovered.status, 'delivered'); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].text, '现在可以正确交付。');
  const malformed = await f.service.output({ ...args, sourceEventId: 'malformed-social-final', seq: 4, text: '```xiangxu-social\n{bad}\n```' });
  assert.equal(malformed.status, 'failed'); assert.equal(malformed.code, 'SOCIAL_REPLY_FORMAT_INVALID');
  assert.equal(f.sent.length, 1, 'malformed internal JSON is never sent as visible code');
});

test('a group reply can join an uncertain summons or answer someone else without a name or mention gate', async t => {
  const f = await fixture(t), invitation = await f.start();
  const incoming = await f.callback(invitation, f.event({ text: '陌生称呼在吗？' }));
  for (const [index, addressee, participation, text] of [
    [1, 'uncertain', 'join', '我也在这儿听着。'], [2, 'other', 'answer', '这件事我也知道一点。'],
  ]) {
    const args = { sessionId: incoming.value.sessionId, sourceEventId: 'independent-choice-' + index, seq: index,
      outputContract: 'xiangxu-social/1', text: socialReply([text], addressee, participation) };
    const result = await f.service.output(args);
    assert.equal(result.status, 'delivered'); assert.equal(result.text, text);
    assert.equal(f.sent.at(-1).text, text);
    assert(!JSON.stringify(f.disk()).includes('understanding'), 'interpretation does not become a registry identity');
    assert.equal((await f.service.output(args)).duplicate, true);
  }
  assert.equal(f.sent.length, 2);
});

test('only an explicit unsupported self claim is withheld, with no QQ send or retry', async t => {
  const f = await fixture(t), invitation = await f.start();
  const incoming = await f.callback(invitation, f.event({ text: '熙熙熙熙在么' }));
  const { messageId: acceptedId } = f.received[0].message;
  const args = { sessionId: incoming.value.sessionId, sourceEventId: 'unsupported-self', seq: 3,
    outputContract: 'xiangxu-social/1',
    text: socialReply(['在呢在呢——喊了这么多声，是有什么急事吗？'], 'self', 'answer').replace('"reference":null', '"reference":"熙熙"') };
  const denied = await f.service.output({ ...args, groupAddressEvidence: { sourceEventId: acceptedId, direct: false, names: [] } });
  assert.equal(denied.code, 'SOCIAL_SELF_ADDRESS_UNSUPPORTED');
  assert.equal(denied.status, 'failed'); assert.equal(f.sent.length, 0);
  const stale = await f.service.output({ ...args, seq: 4, sourceEventId: 'unaccepted-source',
    groupAddressEvidence: { sourceEventId: 'not-admitted', direct: true } });
  assert.equal(stale.code, 'SOCIAL_SELF_ADDRESS_UNSUPPORTED'); assert.equal(f.sent.length, 0);
  await f.reopen();
  assert.equal((await f.service.output(args)).duplicate, true); assert.equal(f.sent.length, 0);
  const joined = await f.service.output({ ...args, seq: 5, sourceEventId: 'independent-join', text: socialReply(['我也可以帮你找。'], 'uncertain', 'answer') });
  assert.equal(joined.status, 'delivered'); assert.equal(f.sent[0].text, '我也可以帮你找。');
  const named = await f.service.output({ ...args, seq: 6, sourceEventId: 'supported-self',
    groupAddressEvidence: { sourceEventId: acceptedId, direct: false, names: ['熙熙'] } });
  assert.equal(named.status, 'delivered');
  const mentioned = await f.service.output({ ...args, seq: 7, sourceEventId: 'supported-mention',
    groupAddressEvidence: { sourceEventId: acceptedId, direct: true, names: [] } });
  assert.equal(mentioned.status, 'delivered'); assert.equal(f.sent.length, 3);
  assert(!JSON.stringify(f.disk()).includes('喊了这么多声'), 'failed receipt retains only the original draft hash');
});

test('the reported H1 named uncertain answer cannot reach a connected group transport', async t => {
  const f = await fixture(t), invitation = await f.start();
  const incoming = await f.callback(invitation, f.event({ text: '熙熙熙熙在么' }));
  const evidence = { sourceEventId: f.received[0].message.messageId, direct: false, names: [] };
  const args = { sessionId: incoming.value.sessionId, sourceEventId: 'h1-uncertain-answer', seq: 2,
    outputContract: 'xiangxu-social/1', groupAddressEvidence: evidence, groupAddressCurrent: () => true,
    text: socialReply(['在，喊这么多次，这回真真切切在着呢。'], 'uncertain', 'answer').replace('"reference":null', '"reference":"熙熙熙熙"') };
  const withheld = await f.service.output(args);
  assert.equal(withheld.status, 'failed');
  assert.equal(withheld.code, 'SOCIAL_SELF_ADDRESS_UNSUPPORTED');
  assert.equal(f.sent.length, 0);
  assert.equal(f.service.findOutboundReceipt(args).status, 'failed');
  await f.reopen();
  assert.equal((await f.service.output(args)).duplicate, true);
  assert.equal(f.sent.length, 0);
  for (const [index, participation, text] of [[3, 'join', '我刚看到熙熙上线。'], [4, 'clarify', '你说的是哪位熙熙？']]) {
    const result = await f.service.output({ ...args, seq: index, sourceEventId: 'independent-' + index,
      text: socialReply([text], 'uncertain', participation).replace('"reference":null', '"reference":"熙熙熙熙"') });
    assert.equal(result.status, 'delivered');
    assert.equal(f.sent.at(-1).text, text);
  }
  const supported = await f.service.output({ ...args, seq: 5, sourceEventId: 'confirmed-target',
    groupAddressEvidence: { ...evidence, direct: true } });
  assert.equal(supported.status, 'delivered');
  assert.equal(f.sent.length, 3);
});

test('the actual Q2 join draft is held before transport while witnessed and conditional participation still sends', async t => {
  const f = await fixture(t), invitation = await f.start();
  const incoming = await f.callback(invitation, f.event({ text: '熙熙熙熙在么' }));
  const { message } = f.received[0];
  const source = { id: message.messageId, source: { platformMessageId: message.sourceFacts.sourceMessageId, textComplete: true,
    xiangxuStructured: { originalText: message.text, groupContext: message.groupContext } } };
  const evidence = groupReplyAddressEvidence(source, message.sourceFacts, '');
  assert.deepEqual(evidence.presenceQuestion, { target: '熙熙熙熙', nameCue: true });
  assert.equal(evidence.direct, false); assert.deepEqual(evidence.names, []);
  const actual = '在——第五遍了，我怀疑你是在测我会不会累。不累，但我记住了。';
  const original = socialReply([actual], 'uncertain', 'join', '熙熙熙熙');
  let seq = 1;
  const send = (text, proof = evidence, current = true) => f.service.output({ sessionId: incoming.value.sessionId,
    sourceEventId: 'q2-followup-' + ++seq, seq, outputContract: 'xiangxu-social/1', text,
    groupAddressEvidence: proof, groupAddressCurrent: () => current });
  for (const reply of [original, socialReply(['我听见了', '在在在'], 'other'),
    socialReply(['```dsh-ui\n{"type":"text","content":"我在。"}\n```'], 'uncertain', 'clarify')]) {
    const withheld = await send(reply);
    assert.equal(withheld.status, 'failed'); assert.equal(withheld.code, 'SOCIAL_SELF_ADDRESS_UNSUPPORTED');
  }
  const stale = await send(original, { ...evidence, direct: true }, false);
  assert.equal(stale.code, 'SOCIAL_SELF_ADDRESS_UNSUPPORTED');
  assert.equal(f.sent.length, 0);
  const old = projectSocialReply(original);
  assert.equal(resolveExternalOutput(original, { formatVersion: old.formatVersion, sourceTextHash: old.sourceTextHash,
    textHash: old.deliveryTextHash }).text, actual);
  for (const body of ['这都喊第四遍啦——要真是喊我，那我一直在这儿呢。', '我也在这儿听着。',
    '在，刚看到他上线。', '我刚看到熙熙上线。', '你说的是哪位熙熙？']) {
    const result = await send(socialReply([body], 'uncertain', 'join', '熙熙熙熙'));
    assert.equal(result.status, 'delivered', body); assert.equal(f.sent.at(-1).text, body);
  }
  assert.equal((await send(original, { ...evidence, direct: true })).status, 'delivered');
  const self = groupReplyAddressEvidence(source, message.sourceFacts, '熙熙熙熙');
  assert.equal((await send(original, self)).status, 'delivered');
  source.source.xiangxuStructured.groupContext.observedNameMatches = [{ platformUserId: '22', observedDisplayName: '熙熙熙熙' }];
  const collision = groupReplyAddressEvidence(source, message.sourceFacts, '熙熙熙熙');
  assert.equal((await send(original, collision)).code, 'SOCIAL_SELF_ADDRESS_UNSUPPORTED');
});

test('social reply partial delivery keeps only the actual prefix after registry cold reopen', async t => {
  const f = await fixture(t, { onOutbound: async count => count === 2 ? { status: 'unknown', code: 'FIXTURE_NETWORK_UNKNOWN' } : undefined });
  const invitation = await f.start(), incoming = await f.callback(invitation, f.event());
  const args = { sessionId: incoming.value.sessionId, sourceEventId: 'partial-social', seq: 5, outputContract: 'xiangxu-social/1',
    text: socialReply(['第一条确实送达。', '第二条结果未知。', '第三条没有发送。']) };
  const first = await f.service.output(args);
  assert.equal(first.status, 'partial'); assert.equal(first.text, '第一条确实送达。');
  assert.equal(f.sent.length, 2); assert.equal(first.bubbles[2].status, 'not_sent');
  await f.reopen();
  const replay = await f.service.output(args);
  assert.equal(replay.status, 'partial'); assert.equal(replay.text, first.text); assert.equal(replay.duplicate, true);
  assert.equal(f.sent.length, 2, 'unknown remainder is never replayed automatically');
});

test('group self evidence is rechecked at each actual send, preserving an already delivered prefix', async t => {
  let current = true;
  const f = await fixture(t, { onOutbound: () => { current = false; } });
  const invitation = await f.start(), incoming = await f.callback(invitation, f.event());
  const result = await f.service.output({
    sessionId: incoming.value.sessionId, sourceEventId: 'source-epoch-final', seq: 2, outputContract: 'xiangxu-social/1',
    text: socialReply(['先回一句。', '证据失效后不发第二句。'], 'self', 'answer'),
    groupAddressEvidence: { sourceEventId: f.received[0].message.messageId, direct: true, names: [] },
    groupAddressCurrent: () => current,
  });
  assert.equal(result.status, 'partial'); assert.equal(result.text, '先回一句。');
  assert.equal(result.bubbles[1].code, 'SOCIAL_SELF_ADDRESS_UNSUPPORTED');
  assert.equal(f.sent.length, 1);
});

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

test('inbound durable receipts deduplicate the same original and reject a changed source', async t => {
  const f = await fixture(t), invitation = await f.start(), payload = f.event({ text: '保真原话' });
  assert.equal((await f.callback(invitation, payload)).value.status, 'accepted');
  const duplicate = await f.callback(invitation, payload); assert.equal(duplicate.value.duplicate, true); assert.equal(f.received.length, 1);
  const conflict = await f.callback(invitation, f.event({ text: '替换原话' })); assert.equal(conflict.http, 400); assert.equal(conflict.value.error.code, 'CHANNEL_MESSAGE_CONFLICT');
  for (const changes of [{ sender: 12 }, { group: 201 }, { privateMessage: true }]) {
    const mismatched = await f.callback(invitation, f.event({ text: '保真原话', ...changes }));
    assert.equal(mismatched.http, 400); assert.equal(mismatched.value.error.code, 'CHANNEL_MESSAGE_CONFLICT');
  }
  assert.equal(f.created.length, 1); assert.equal(f.received.length, 1);
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

test('model-selected QQ bubbles are delivered in order and cold replay retains every confirmed receipt', async t => {
  const f = await fixture(t), invitation = await f.start();
  await f.callback(invitation, f.event({ privateMessage: true }));
  const expected = ['刚到家', '路上碰见只猫'];
  const args = { sessionId: f.created[0].sessionId, sourceEventId: 'selected-bubbles', seq: 23, text: qqReply(...expected) };
  const result = await f.service.output(args);
  assert.equal(result.status, 'delivered');
  assert.equal(result.text, expected.join('\n'));
  assert.equal(result.textHash, hash(expected.join('\n')));
  assert.equal(result.sourceTextHash, hash(args.text));
  assert.deepEqual(f.sent.map(value => value.text), expected);
  assert.equal(new Set(f.sent.map(value => value.args.deliveryId)).size, expected.length);
  assert.deepEqual(result.bubbles.map(value => [value.status, value.messageId]), [['delivered', 'platform-1'], ['delivered', 'platform-2']]);
  assert.ok(expected.every(text => !JSON.stringify(f.disk()).includes(text)));

  await f.reopen();
  const receipt = await f.service.reconcile({ sessionId: args.sessionId, sourceEventId: args.sourceEventId });
  assert.deepEqual(receipt.bubbles, result.bubbles);
  assert.equal(receipt.text, undefined);
  assert.equal((await f.service.output(args)).text, result.text);
  await assert.rejects(f.service.output({ ...args, text: qqReply(...expected.reverse()) }), { code: 'CHANNEL_OUTPUT_CONFLICT' });
  assert.equal(f.sent.length, 2);
});

test('QQ bubble failure preserves the visible prefix, stops later sends, and is never replayed', async t => {
  const f = await fixture(t, { onOutbound: index => index === 2 ? { status: 'failed', code: 'ONEBOT_REJECTED' } : undefined });
  const invitation = await f.start();
  await f.callback(invitation, f.event());
  const args = { sessionId: f.created[0].sessionId, sourceEventId: 'partial-bubbles', seq: 24, text: qqReply('听见了', '让我想想', '还有一句') };
  const result = await f.service.output(args);
  assert.equal(result.status, 'partial');
  assert.equal(result.text, '听见了');
  assert.equal(result.code, 'ONEBOT_REJECTED');
  assert.deepEqual(result.bubbles.map(value => value.status), ['delivered', 'failed', 'not_sent']);
  assert.deepEqual(f.sent.map(value => value.text), ['听见了', '让我想想']);
  await f.reopen();
  const receipt = await f.service.reconcile({ sessionId: args.sessionId, sourceEventId: args.sourceEventId });
  assert.equal(receipt.status, 'partial');
  assert.deepEqual(receipt.bubbles, result.bubbles);
  assert.equal((await f.service.output(args)).text, result.text);
  assert.equal(f.sent.length, 2);
});

test('reusing the first platform message ID cannot confirm a second QQ bubble', async t => {
  const f = await fixture(t, { onOutbound: index => index === 2 ? { status: 'delivered', messageId: 'platform-1', receiptId: 'onebot:1' } : undefined });
  const invitation = await f.start();
  await f.callback(invitation, f.event());
  const result = await f.service.output({ sessionId: f.created[0].sessionId, sourceEventId: 'repeated-platform-id', seq: 27, text: qqReply('第一句', '第二句', '第三句') });
  assert.equal(result.status, 'partial');
  assert.equal(result.code, 'CHANNEL_DUPLICATE_MESSAGE_ID');
  assert.equal(result.text, '第一句');
  assert.deepEqual(result.bubbles.map(bubble => bubble.status), ['delivered', 'unknown', 'not_sent']);
  assert.equal(f.sent.length, 2);
});

test('a stop requested during the first QQ bubble prevents the second driver invocation', async t => {
  let stopping;
  const f = await fixture(t, { onOutbound: index => { if (index === 1) stopping = f.service.stop({ id: 'qq' }); } });
  const invitation = await f.start();
  await f.callback(invitation, f.event());
  const args = { sessionId: f.created[0].sessionId, sourceEventId: 'stop-between-bubbles', seq: 26, text: qqReply('已发第一句', '不要发这一句') };
  const result = await f.service.output(args);
  await stopping;
  assert.equal(result.status, 'partial');
  assert.equal(result.code, 'CHANNEL_DISABLED');
  assert.deepEqual(f.sent.map(value => value.text), ['已发第一句']);
  assert.equal(f.service.findOutboundReceipt(args).bubbles[0].messageId, 'platform-1');
});

test('interrupted QQ bubble persistence keeps the confirmed prefix and never resends an uncertain bubble', async t => {
  let storageUnavailable = false;
  const f = await fixture(t, {
    writeFault: () => storageUnavailable,
    onOutbound: index => { if (index === 2) storageUnavailable = true; },
  });
  const invitation = await f.start();
  await f.callback(invitation, f.event());
  const args = { sessionId: f.created[0].sessionId, sourceEventId: 'interrupted-bubbles', seq: 25, text: qqReply('已经确认', '发送结果未落盘', '尚未开始发送') };
  const result = await f.service.output(args);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.bubbles.map(value => value.status), ['delivered', 'unknown', 'not_sent']);
  assert.deepEqual(f.disk().receipts.find(value => value.sourceEventId === args.sourceEventId).bubbles.map(value => value.status), ['delivered', 'prepared', 'not_sent']);
  storageUnavailable = false;
  await f.reopen();
  const replay = await f.service.output(args);
  assert.equal(replay.text, '已经确认');
  assert.equal(replay.code, 'CHANNEL_INTERRUPTED_UNKNOWN');
  assert.deepEqual(replay.bubbles.map(value => value.status), ['delivered', 'unknown', 'not_sent']);
  assert.equal(f.sent.length, 2);
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
