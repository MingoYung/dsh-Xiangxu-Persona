import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createChannelService } from '../adapters/dsh/channels/service.js';
import { createDshChannelPort } from '../adapters/dsh/channels/native.js';
import { normalizeDshEvent } from '../adapters/dsh/normalize.js';
import { createOneBotClient } from '../adapters/dsh/channels/onebot.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, clientFactory) {
  const root = path.join(os.tmpdir(), 'xiangxu-display-' + randomUUID()), agents = new Map(), sourceFacts = new Map(), hooks = {}; let disk = null, service;
  let current = { memoryRoot: root, ready: Promise.resolve(), agents: new Map(), async registerExternalChannel(id, facts) { await hooks.register?.(); sourceFacts.set(id, structuredClone(facts)); }, async attachAgent() {}, async detachAgent() {}, hasRegisteredSession() { return false; } };
  const native = createDshChannelPort({ ctx: { agents: {
    get: id => agents.get(id),
    async create({ sessionId }) { const agent = { id: sessionId, session: { id: sessionId, deriveMessages: () => [], requestHeader: () => ({ config: { provider: 'fixture', model: 'fixture-only' } }) }, inbox: { nextTurn: [], nextStep: [] }, followup(message) { this.inbox.nextTurn.push(structuredClone(message)); } }; agents.set(sessionId, agent); return { agent, async dispose() { agents.delete(sessionId); } }; },
  }, agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture-only', reasoningEffort: 'low' }) }, sessions: { flush: async () => {} } }, getCoordinator: () => current });
  service = createChannelService({ getCoordinator: () => current, channelPort: native, port: 0, storage: { read: async () => structuredClone(disk), async write(value) { if (hooks.write) await hooks.write(value); disk = structuredClone(value); } },
    clientFactory: clientFactory ?? (() => ({ probe: async () => ({ connected: true, capabilities: { text: true, group: true } }),
      sendText: async (...args) => hooks.sendText?.(...args) })) });
  await service.ready; t.after(() => service.close());
  await service.configure({ id: 'qq', config: { accountId: '100', apiUrl: 'http://127.0.0.1:12345', allowedPrivateIds: ['*'], allowedGroupIds: ['*'] } });
  const secret = await service.rotateIngress({ id: 'qq' }), state = await service.start({ id: 'qq' }), url = state.connections.find(v => v.id === 'qq').callbackUrl;
  async function send({ id, sender = 11, group = 200, nickname = '旧昵称', card, text = '你好', privateMessage = false, segments = [] }) { const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret.ingressToken }, body: JSON.stringify({ post_type: 'message', message_type: privateMessage ? 'private' : 'group', sub_type: privateMessage ? 'friend' : 'normal', self_id: 100, user_id: sender, sender: { user_id: sender, nickname, ...(card === undefined ? {} : { card }) }, ...(privateMessage ? {} : { group_id: group }), message_id: id, time: 1800000000 + id, message: [...segments, { type: 'text', data: { text } }] }) }); return { http: response.status, value: await response.json() }; }
  return { service, send, agents, sourceFacts, hooks, root, disk: () => structuredClone(disk), setCurrent(value) { current = value; }, current: () => current, messages: id => agents.get(id)?.inbox.nextTurn ?? [] };
}

for (const change of ['same-root replacement', 'queued stop']) test('native intake rechecks ownership after the last awaited binding operation: ' + change, async t => {
  const f = await fixture(t);
  let registered = 0, stopping;
  f.hooks.register = () => {
    if (++registered !== 2) return;
    if (change === 'same-root replacement') f.setCurrent({ ...f.current() });
    else stopping = f.service.stop({ id: 'qq' });
  };
  const result = await f.send({ id: 1 });
  await stopping;
  assert.equal(registered, 2, 'second registration happens inside native send');
  assert.equal(result.value.accepted, false);
  assert.equal(result.value.code, change === 'same-root replacement' ? 'CHANNEL_INSTANCE_CHANGED' : 'CHANNEL_SUSPENDED');
  assert.ok([...f.agents.values()].every(agent => agent.inbox.nextTurn.length === 0));
  assert.equal(f.disk().receipts[0].status, 'unknown');
});

test('QQ group intake carries the timestamped login nickname from its latest account probe without rewriting earlier messages', async t => {
  let nickname = '已观察昵称', observedAt = 1800000000000, probeCount = 0;
  const f = await fixture(t, profile => createOneBotClient(profile, {
    clock: () => observedAt,
    fetchImpl: async url => {
      const action = new URL(url).pathname;
      if (action === '/get_login_info') probeCount++;
      const data = action === '/get_login_info' ? { user_id: 100, nickname }
        : action === '/get_status' ? { good: true, online: true } : { yes: false };
      return Response.json({ status: 'ok', retcode: 0, data });
    },
  }));
  const first = await f.send({ id: 1, text: '保留原文' });
  assert.equal(first.value.status, 'accepted');
  const [before] = f.messages(first.value.sessionId);
  const firstObservation = { value: nickname, source: 'onebot_get_login_info', observedAt };
  assert.deepEqual(before.source.xiangxuStructured.groupContext.connectedAccountDisplayName, firstObservation);
  const direct = await f.send({ id: 2, privateMessage: true });
  assert.equal(direct.value.status, 'accepted');
  assert.equal(f.messages(direct.value.sessionId)[0].source.xiangxuStructured?.groupContext, undefined);
  assert.equal(probeCount, 1, 'group and private intake reuse the probe without an extra login request');
  nickname = '改后的账号昵称';
  observedAt += 1000;
  await f.service.probe({ id: 'qq' });
  const second = await f.send({ id: 3 });
  assert.equal(second.value.sessionId, first.value.sessionId);
  const after = f.messages(second.value.sessionId)[1];
  assert.deepEqual(after.source.xiangxuStructured.groupContext.connectedAccountDisplayName,
    { value: nickname, source: 'onebot_get_login_info', observedAt });
  assert.deepEqual(before.source.xiangxuStructured.groupContext.connectedAccountDisplayName, firstObservation);
  assert.equal(normalizeDshEvent({ id: first.value.sessionId }, { type: 'user/message', data: before }).dialogue.text, '保留原文');
  assert.equal(f.disk().bindings[0].facts.connectedAccountDisplayName, undefined);
  assert.equal(probeCount, 2);
});

test('changed QQ nickname and group card refresh the same binding while original message source facts remain immutable', async t => {
  const f = await fixture(t), first = await f.send({ id: 1, nickname: '旧昵称' }), second = await f.send({ id: 2, nickname: '新昵称', card: '新群名片' });
  assert.equal(first.value.sessionId, second.value.sessionId); const messages = f.messages(first.value.sessionId);
  assert.equal(messages.length, 2); assert.equal(messages[0].source.xiangxuChannel.sender.name, '旧昵称'); assert.equal(messages[1].source.xiangxuChannel.sender.name, '新群名片');
  assert.equal(f.disk().bindings.length, 1); assert.equal(f.disk().bindings[0].facts.sender.name, '新群名片'); assert.equal(f.sourceFacts.get(first.value.sessionId).sender.name, '新群名片');
  const third = await f.send({ id: 3, nickname: '最新昵称', card: '' }); assert.equal(third.value.sessionId, first.value.sessionId); assert.equal(f.messages(first.value.sessionId)[2].source.xiangxuChannel.sender.name, '最新昵称');
  const replay = await f.send({ id: 1, nickname: '重复投递伪新昵称' }); assert.equal(replay.value.duplicate, true); assert.equal(f.messages(first.value.sessionId).length, 3); assert.equal(messages[0].source.xiangxuChannel.sender.name, '旧昵称'); assert.equal(f.disk().bindings[0].facts.sender.name, '最新昵称');
});

test('same display name never merges different QQ actors; real account change creates a new binding', async t => {
  const f = await fixture(t), first = await f.send({ id: 1, sender: 11, nickname: '同名' }), second = await f.send({ id: 2, sender: 12, nickname: '同名' });
  assert.notEqual(first.value.sessionId, second.value.sessionId); assert.equal(f.disk().bindings.length, 2); assert.deepEqual(f.disk().bindings.map(v => v.facts.sender.id), ['11', '12']);
  assert.equal(f.messages(first.value.sessionId)[0].source.xiangxuChannel.sender.id, '11'); assert.equal(f.messages(second.value.sessionId)[0].source.xiangxuChannel.sender.id, '12');
});

test('QQ name candidates and quoted authors stay scoped to observed participants in the same group', async t => {
  const f = await fixture(t);
  await f.send({ id: 1, sender: 12, card: '小夏' });
  await f.send({ id: 2, sender: 13, card: '小夏' });
  await f.send({ id: 3, sender: 14, card: '小夏', group: 201 });
  await f.send({ id: 4, sender: 15, nickname: '小夏', privateMessage: true });
  const original = '小夏在么？', plain = await f.send({ id: 5, text: original });
  assert.equal(plain.value.status, 'accepted');
  const [message] = f.messages(plain.value.sessionId);
  const group = message.source.xiangxuStructured.groupContext;
  assert.deepEqual(group.sender, { platformUserId: '11', displayName: '旧昵称' });
  assert.equal(group.connectedAccountId, '100');
  assert.equal(group.explicitlyMentionsConnectedAccount, false);
  assert.deepEqual(group.observedNameMatches, [
    { platformUserId: '12', observedDisplayName: '小夏' },
    { platformUserId: '13', observedDisplayName: '小夏' },
  ]);
  assert.equal(message.source.xiangxuStructured.groupPresentation, 'xiangxu-group-scene/1');
  const scene = JSON.parse(message.content[0].text.split('\n').slice(1).join('\n'));
  assert.equal(scene.kind, 'public_group_utterance');
  assert.equal(scene.utterance.text, original);
  assert.equal(scene.source.sender.platformUserId, '11');
  assert.equal(scene.source.connectedAccountId, '100');
  assert.equal(scene.addressee, undefined, 'source presentation does not decide whom this is addressed to');
  assert.equal(message.content[1].text, '[QQ 群消息来源资料，昵称匹配仅供判断对方在说谁]\n' + JSON.stringify(group));
  const normalized = normalizeDshEvent({ id: plain.value.sessionId }, { type: 'user/message', data: message });
  assert.equal(normalized.dialogue.text, original);
  assert.equal(normalized.hot.length, 1);

  const rich = await f.send({ id: 6, text: '这条呢', segments: [
    { type: 'at', data: { qq: '100' } },
    { type: 'reply', data: { id: '1' } },
    { type: 'reply', data: { id: '3' } },
  ] });
  const replySource = f.messages(rich.value.sessionId).at(-1).source.xiangxuStructured;
  assert.equal(replySource.groupContext.explicitlyMentionsConnectedAccount, true);
  assert.deepEqual(replySource.groupContext.quoteLinks, [
    { platformMessageId: '1', observedAuthorPlatformUserId: '12' },
    { platformMessageId: '3', observedAuthorPlatformUserId: null },
  ]);
  assert.deepEqual(replySource.rich.mentions, [{ segmentIndex: 0, userId: '100', all: false }]);
  const duplicate = await f.send({ id: 5, text: original });
  assert.equal(duplicate.value.duplicate, true);
  assert.equal(f.messages(plain.value.sessionId).length, 2);
});

test('QQ quotes recognize each confirmed sent bubble, including a partial delivery prefix', async t => {
  const f = await fixture(t), first = await f.send({ id: 1 });
  const text = '```xiangxu-qq\n["第一条","第二条"]\n```';
  let send = 1000, failSecond = false;
  f.hooks.sendText = async (_facts, _text, { deliveryId }) => {
    const messageId = String(++send);
    if (failSecond && send === 1004) return { status: 'unknown', code: 'FIXTURE_TIMEOUT' };
    return { status: 'delivered', deliveryId, messageId, receiptId: 'qq:' + messageId, messageIdKind: 'server_id' };
  };
  const sendBatch = (sourceEventId, seq) => f.service.output({ sessionId: first.value.sessionId, sourceEventId, seq, text });
  assert.equal((await sendBatch('complete', 1)).status, 'delivered');
  failSecond = true;
  assert.equal((await sendBatch('partial', 2)).status, 'partial');

  const quote = id => ({ type: 'reply', data: { id } });
  const incoming = await f.send({ id: 2, segments: ['1001', '1002', '1003', '1004'].map(quote) });
  assert.equal(incoming.value.status, 'accepted');
  assert.deepEqual(f.messages(incoming.value.sessionId).at(-1).source.xiangxuStructured.groupContext.quoteLinks, [
    { platformMessageId: '1001', observedAuthorPlatformUserId: '100', confirmedAccountDelivery: true },
    { platformMessageId: '1002', observedAuthorPlatformUserId: '100', confirmedAccountDelivery: true },
    { platformMessageId: '1003', observedAuthorPlatformUserId: '100', confirmedAccountDelivery: true },
    { platformMessageId: '1004', observedAuthorPlatformUserId: null },
  ]);
});

test('one QQ actor keeps stable platform account and sender clues across private chat and groups while each source session stays separate', async t => {
  const f = await fixture(t), a = await f.send({ id: 1, group: 200, card: '群一名片' }), b = await f.send({ id: 2, group: 201, card: '群二名片' }), c = await f.send({ id: 3, privateMessage: true, nickname: '本人昵称' });
  assert.equal(new Set([a.value.sessionId, b.value.sessionId, c.value.sessionId]).size, 3);
  const messages = [a, b, c].map(v => f.messages(v.value.sessionId)[0]);
  assert.equal(new Set(messages.map(v => [v.source.xiangxuChannel.platform, v.source.xiangxuChannel.accountId, v.source.xiangxuChannel.sender.id].join(':'))).size, 1);
  assert.deepEqual(messages.map(v => v.source.xiangxuChannel.sender.name), ['群一名片', '群二名片', '本人昵称']);
  assert.deepEqual(messages.map(v => v.source.xiangxuChannel.conversation.type), ['group', 'group', 'private']);
  for (const [i, message] of messages.entries()) { assert.equal(message.role, 'user'); assert.equal(message.source.kind, 'user'); const normalized = normalizeDshEvent({ id: [a, b, c][i].value.sessionId }, { type: 'user/message', data: message }, { personId: 'one-recognized-person', participantSourceKinds: ['user'], now: 1800000000000 }); assert.equal(normalized.dialogue.role, 'user'); assert.equal(normalized.dialogue.sourceEventId, message.id); assert.equal(normalized.dialogue.personId, 'one-recognized-person'); }
});

test('a persona switch while refreshed binding metadata is being saved rejects intake before native source registration or sending', async t => {
  const f = await fixture(t), first = await f.send({ id: 1 }), began = deferred(), finish = deferred();
  f.hooks.write = async value => { if (value.bindings[0]?.facts.sender.name === '迟到的新昵称') { began.resolve(); await finish.promise; } };
  const pending = f.send({ id: 2, nickname: '迟到的新昵称' }); await began.promise; f.setCurrent({ ...f.current(), memoryRoot: path.join(f.root, 'different-persona') }); finish.resolve();
  const result = await pending; assert.notEqual(result.value.status, 'accepted'); assert.equal(f.messages(first.value.sessionId).length, 1); assert.equal(f.sourceFacts.get(first.value.sessionId).sender.name, '旧昵称');
});
