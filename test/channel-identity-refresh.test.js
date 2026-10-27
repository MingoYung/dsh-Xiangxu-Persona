import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createChannelService } from '../adapters/dsh/channels/service.js';
import { createDshChannelPort } from '../adapters/dsh/channels/native.js';
import { normalizeDshEvent } from '../adapters/dsh/normalize.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const root = path.join(os.tmpdir(), 'xiangxu-display-' + randomUUID()), agents = new Map(), sourceFacts = new Map(), hooks = {}; let disk = null, service;
  let current = { memoryRoot: root, ready: Promise.resolve(), agents: new Map(), async registerExternalChannel(id, facts) { sourceFacts.set(id, structuredClone(facts)); }, async attachAgent() {}, async detachAgent() {}, hasRegisteredSession() { return false; } };
  const native = createDshChannelPort({ ctx: { agents: {
    get: id => agents.get(id),
    async create({ sessionId }) { const agent = { id: sessionId, session: { id: sessionId, deriveMessages: () => [], requestHeader: () => ({ config: { provider: 'fixture', model: 'fixture-only' } }) }, inbox: { nextTurn: [], nextStep: [] }, followup(message) { this.inbox.nextTurn.push(structuredClone(message)); } }; agents.set(sessionId, agent); return { agent, async dispose() { agents.delete(sessionId); } }; },
  }, agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture-only', reasoningEffort: 'low' }) }, sessions: { flush: async () => {} } }, getCoordinator: () => current });
  service = createChannelService({ getCoordinator: () => current, channelPort: native, port: 0, storage: { read: async () => structuredClone(disk), async write(value) { if (hooks.write) await hooks.write(value); disk = structuredClone(value); } },
    clientFactory: () => ({ probe: async () => ({ connected: true, capabilities: { text: true, group: true } }) }) });
  await service.ready; t.after(() => service.close());
  await service.configure({ id: 'qq', config: { accountId: '100', apiUrl: 'http://127.0.0.1:12345', allowedPrivateIds: ['*'], allowedGroupIds: ['*'] } });
  const secret = await service.rotateIngress({ id: 'qq' }), state = await service.start({ id: 'qq' }), url = state.connections.find(v => v.id === 'qq').callbackUrl;
  async function send({ id, sender = 11, group = 200, nickname = '旧昵称', card, text = '你好', privateMessage = false }) { const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret.ingressToken }, body: JSON.stringify({ post_type: 'message', message_type: privateMessage ? 'private' : 'group', sub_type: privateMessage ? 'friend' : 'normal', self_id: 100, user_id: sender, sender: { user_id: sender, nickname, ...(card === undefined ? {} : { card }) }, ...(privateMessage ? {} : { group_id: group }), message_id: id, time: 1800000000 + id, message: [{ type: 'text', data: { text } }] }) }); return { http: response.status, value: await response.json() }; }
  return { service, send, agents, sourceFacts, hooks, root, disk: () => structuredClone(disk), setCurrent(value) { current = value; }, current: () => current, messages: id => agents.get(id)?.inbox.nextTurn ?? [] };
}

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
