import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshCoordinator } from '../adapters/dsh/index.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'persona-dsh-source-page-')), agents = new Map();
  const makeAgent = id => {
    const handlers = new Map(), tools = new Map();
    const scope = { on(name, handler) { handlers.set(name, handler); }, tools: { restrict() { return () => {}; }, register(tool) { tools.set(tool.name, tool); } } };
    const session = { id, header: { cwd: `C:/real/${id}` }, deriveMessages: () => [], requestHeader: () => ({ config: { provider: 'test', model: 'fixture' } }) };
    const agent = { id, session, ctx: scope, handlers, tools, inbox: { nextTurn: [], nextStep: [], splice(target, ...args) {
      return (target === 'next-turn' ? this.nextTurn : this.nextStep).splice(...args);
    } }, followup(message) { this.inbox.nextTurn.push(message); } };
    agents.set(id, agent); return agent;
  };
  const a = makeAgent('session-a'), b = makeAgent('session-b');
  const coordinator = createDshCoordinator({ agents: { get: id => agents.get(id) }, llm: {} }, { memoryRoot: root, operatorControl: false });
  await coordinator.ready; await coordinator.attachAgent(a); await coordinator.attachAgent(b);
  const replies = [];
  coordinator.runtime.model = { maxInputTokens: 6000, complete: async request => {
    if (request.purpose === 'reply') { replies.push(request); return { text: 'The actual chosen cross-session reply.' }; }
    return { patch: [] };
  } };
  t.after(async () => { await coordinator.close(); await rm(root, { recursive: true, force: true }); });
  let seq = 10;
  const admit = async (agent, message, turn) => {
    agent.handlers.get('agent/inbox/claimed')({ message, turn });
    const entered = await agent.handlers.get('agent/pre-step')({ messages: [message], turn }, async () => ({ kind: 'enter', messages: [message] }));
    assert.equal(entered.kind, 'enter');
    await coordinator.observeEvent(agent.session, { type: 'turn/start', seq: seq++, data: { turn } });
    await coordinator.observeEvent(agent.session, { type: 'user/message', seq: seq++, data: message });
    return entered;
  };
  const incoming = async (text, personId = null) => coordinator.runtime.accept({ sourceSessionId: a.id, sourceEventId: `root_${seq++}`, sourceKind: 'user',
    contentClass: 'participant_dialogue', role: 'user', origin: 'user', personId, text, channelId: `dsh:${a.id}` }, coordinator.contextFor(a).environment);
  const cross = async () => a.tools.get('persona_decide').execute({ replyPlan: { action: 'reply', replyAt: null,
    target: { sessionId: b.id, channelId: `dsh:${b.id}`, personId: null }, pendingEventIds: [] } }, { agent: a, callId: `cross_${seq++}` });
  return { coordinator, runtime: coordinator.runtime, repository: coordinator.repository, a, b, replies, admit, incoming, cross };
}

test('partial control notice retains every source ID and exact Unicode slice without copying the text into metadata; cross reply cannot acknowledge its unread tail', async t => {
  const f = await fixture(t), text = 'Visible beginning🙂中文'.repeat(2000) + 'UNREAD_FINAL_TAIL';
  const source = await f.incoming(text);
  await f.runtime.handleSignal('new_message', f.coordinator.contextFor(f.a));
  const notice = f.a.inbox.nextTurn.shift(), metadata = notice.source.pendingSourcePage;
  assert.equal(metadata.length, 1); assert.equal(metadata[0].eventId, source.eventId); assert.equal(metadata[0].fragment.complete, false);
  assert.ok(!JSON.stringify(notice.source).includes('Visible beginning')); assert.deepEqual(notice.source.pendingEventIds, []);
  await f.admit(f.a, notice, 1);
  assert.equal((await f.repository.getRuntime()).execution.pendingOffsets[source.eventId], metadata[0].fragment.to);
  const result = await f.cross(); assert.notEqual(result.status, 'memory_error');
  const body = JSON.parse(f.replies[0].messages.at(-1).content), actual = body.pending[0];
  assert.equal(f.replies[0].context.sessionId, f.b.id); assert.equal(actual.sourceSessionId, f.a.id);
  assert.equal(actual.text, Array.from(text).slice(metadata[0].fragment.from, metadata[0].fragment.to).join(''));
  assert.deepEqual(actual.fragment, metadata[0].fragment);
  const outbox = await f.repository.getOutbox(); assert.equal(outbox[0].target.sessionId, f.b.id); assert.deepEqual(outbox[0].pendingEventIds, []);
  assert.deepEqual((await f.repository.getPending()).map(record => record.eventId), [source.eventId]);
  assert.equal((await f.a.handlers.get('agent/pre-step')({ messages: [], turn: 1 }, async () => ({ kind: 'enter', messages: [] }))).kind, 'reject');
});

test('a wake source remains available to a cross reply after native admission legitimately clears the complete pending receipt', async t => {
  const f = await fixture(t), source = await f.incoming('A complete sleep-time source that remains an original after wake acknowledgement.');
  await f.runtime.decide({ sleepPlan: { action: 'sleep', wakeCondition: 'explicit_wake', wakeAt: null } }, f.coordinator.contextFor(f.a));
  await f.runtime.idle(); await f.runtime.handleSignal('explicit_wake', f.coordinator.contextFor(f.a));
  const notice = f.a.inbox.nextTurn.shift(); assert.equal(notice.source.kind, 'persona-memory:wake');
  assert.equal(notice.source.pendingSourcePage[0].fragment.complete, true);
  await f.admit(f.a, notice, 1); assert.equal((await f.repository.getPending()).length, 0);
  const result = await f.cross(); assert.notEqual(result.status, 'memory_error');
  const body = JSON.parse(f.replies[0].messages.at(-1).content);
  assert.equal(body.pending[0].text, source.record.text); assert.equal(body.pending[0].sourceSessionId, f.a.id);
  assert.equal(f.replies[0].context.environment.sessionId, f.b.id);
  assert.equal((await f.repository.getContext({ personId: null })).records.filter(record => record.sourceEventId === source.record.sourceEventId).length, 1);
});

test('a source explicitly revoked after a page was admitted is never reconstructed for the redirected request', async t => {
  const f = await fixture(t); await f.repository.upsertPerson({ personId: 'a' });
  const source = await f.incoming('Do not resurrect this selected original after it is explicitly forgotten.', 'a');
  await f.runtime.handleSignal('new_message', { ...f.coordinator.contextFor(f.a), personId: 'a' });
  const notice = f.a.inbox.nextTurn.shift(); await f.admit(f.a, notice, 1);
  await f.repository.forget({ targetPersonId: 'a', ids: [source.record.id], reason: 'Explicit deletion after source admission' });
  const result = await f.cross(); assert.notEqual(result.status, 'memory_error');
  assert.deepEqual(JSON.parse(f.replies[0].messages.at(-1).content).pending, []);
  assert.deepEqual(await f.repository.readSources({ eventIds: [source.eventId] }), []);
});
