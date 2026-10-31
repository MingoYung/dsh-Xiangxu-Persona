import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshCoordinator } from '../adapters/dsh/index.js';

// Zero-model regression for the OBS-1 wait-gate fix (D1 independent review §6):
// a legitimately triggered reconsideration admits the whole turn including tool
// continuation steps; an explicit NEW wait/listen chosen during the turn revokes
// admission; identity-only decides do not; no-trigger stale waits still hold;
// admission is cleared at turn/end and never crosses turns.

const SEARCH_TERMS = ['豆包', '气闸'];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'persona-wait-gate-')), handlers = new Map(), tools = new Map();
  const scope = {on(name, handler) { handlers.set(name, handler); }, tools: { restrict() { return () => {}; }, register(tool) { tools.set(tool.name, tool); } }};
  const session = { id: 'wait-gate-session', header: {}, deriveMessages: () => [], requestHeader: () => ({ config: { provider: 'test', model: 'fixture' } }) };
  const agent = { id: session.id, session, ctx: scope, inbox: { nextTurn: [], nextStep: [] }, followup(message) { this.inbox.nextTurn.push(message); } };
  const coordinator = createDshCoordinator({ agents: { get: () => agent }, llm: {}, get: () => undefined },
    { memoryRoot: root, operatorControl: false });
  await coordinator.ready; await coordinator.attachAgent(agent);
  await coordinator.repository.upsertPerson({ personId: 'person_gate' });
  await coordinator.runtime.decide({ identityPlan: { action: 'associate', personId: 'person_gate', sourceRefs: [] } },
    { ...coordinator.contextFor(agent), executeReply: false });
  t.after(async () => { await coordinator.close(); await rm(root, { recursive: true, force: true }); });
  let seq = 0;
  const observe = (type, data) => coordinator.observeEvent(session, { type, seq: seq++, time: Date.now(), data });
  const preStep = (turn, messages) => handlers.get('agent/pre-step')({ messages, turn }, async () => ({ kind: 'enter', messages }));
  const decide = (input, callId) => coordinator.runtime.decide(input, { ...coordinator.contextFor(agent), executeReply: false, operationId: callId });
  const userMessage = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
  const runSearch = async callId => {
    const payload = { scope: 'all', limit: 5 };
    payload.query = SEARCH_TERMS.join(' ');
    return tools.get('memory_search').execute(payload, { agent, callId });
  };
  return { coordinator, agent, tools, handlers, observe, preStep, decide, userMessage, runSearch, repository: coordinator.repository };
}

test('a triggered reconsideration admits tool continuation steps of the same turn under a stale wait', async t => {
  const f = await fixture(t);
  await f.decide({ replyPlan: { action: 'wait', target: null, pendingEventIds: [], replyAt: null, recheckOn: ['new_message'], reason: 'stale wait from an earlier day' } }, 'old-wait');
  const message = f.userMessage('gate-msg-1', SEARCH_TERMS.join('') + '现场');
  await f.observe('turn/start', { turn: 1 });
  f.handlers.get('agent/inbox/claimed')({ message, turn: 1 });
  const first = await f.preStep(1, [message]);
  assert.equal(first.kind, 'enter', 'new_message trigger admits the first step');
  await f.observe('user/message', message);
  const search = await f.runSearch('gate-search');
  assert.notEqual(search.status, 'memory_error', 'registered search runs inside the admitted turn');
  const continuation = await f.preStep(1, []);
  assert.equal(continuation.kind, 'enter', 'tool continuation stays admitted for the admitted turn');
  const again = await f.preStep(1, []);
  assert.equal(again.kind, 'enter', 'repeated continuation steps are not cut either');
  await f.observe('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const bare = await f.preStep(3, []);
  assert.equal(bare.kind, 'reject', 'admission does not survive turn/end');
});

test('an explicit NEW wait chosen during the admitted turn stops its later steps; identity-only decide does not', async t => {
  const f = await fixture(t);
  await f.decide({ replyPlan: { action: 'wait', target: null, pendingEventIds: [], replyAt: null, recheckOn: ['new_message'], reason: 'stale wait' } }, 'w1');
  const message = f.userMessage('gate-msg-3', '再来一条');
  await f.observe('turn/start', { turn: 10 });
  f.handlers.get('agent/inbox/claimed')({ message, turn: 10 });
  const first = await f.preStep(10, [message]);
  assert.equal(first.kind, 'enter');
  await f.observe('user/message', message);
  await f.decide({ identityPlan: { action: 'unknown', reason: 'identity-only during an admitted turn' } }, 'id-only');
  const afterIdentity = await f.preStep(10, []);
  assert.equal(afterIdentity.kind, 'enter', 'identity-only decide keeps the turn admitted');
  await f.decide({ replyPlan: { action: 'wait', target: null, pendingEventIds: [], replyAt: null, recheckOn: ['new_message'], reason: 'new explicit wait this turn' } }, 'new-wait');
  const afterWait = await f.preStep(10, []);
  assert.equal(afterWait.kind, 'reject', 'explicit new wait stops later steps of the same turn');
  // A future replyAt chosen mid-turn also stops later steps of this turn.
  const message2 = f.userMessage('gate-msg-3b', '再触发一次');
  await f.observe('turn/start', { turn: 11 });
  f.handlers.get('agent/inbox/claimed')({ message: message2, turn: 11 });
  const first11 = await f.preStep(11, [message2]);
  assert.equal(first11.kind, 'enter');
  await f.observe('user/message', message2);
  await f.decide({ replyPlan: { action: 'reply', target: null, pendingEventIds: [], replyAt: Date.now() + 3600e3, reason: 'deferred to later' } }, 'future-reply');
  const afterFuture = await f.preStep(11, []);
  assert.equal(afterFuture.kind, 'reject', 'future replyAt defers later steps of the same turn');
  await f.observe('turn/end', { turn: 11, reason: { kind: 'completed' } });
});

test('an event-triggered listen admits its turn the same way; a no-trigger stale wait still holds and pending stays honest', async t => {
  const f = await fixture(t);
  await f.decide({ replyPlan: { action: 'listen', target: null, pendingEventIds: [], replyAt: null, recheckOn: ['new_message'], reason: 'stale listen' } }, 'l1');
  const message = f.userMessage('gate-msg-4', 'listen 路径');
  await f.observe('turn/start', { turn: 20 });
  f.handlers.get('agent/inbox/claimed')({ message, turn: 20 });
  const first = await f.preStep(20, [message]);
  assert.equal(first.kind, 'enter');
  await f.observe('user/message', message);
  const continuation = await f.preStep(20, []);
  assert.equal(continuation.kind, 'enter', 'listen path admits continuation steps too');
  await f.observe('turn/end', { turn: 20, reason: { kind: 'completed' } });
  await f.decide({ replyPlan: { action: 'wait', target: null, pendingEventIds: [], replyAt: null, reason: 'no-trigger wait' } }, 'w2');
  await f.observe('turn/start', { turn: 21 });
  const plainMessage = f.userMessage('gate-msg-5', '普通消息');
  f.handlers.get('agent/inbox/claimed')({ message: plainMessage, turn: 21 });
  const plain = await f.preStep(21, [plainMessage]);
  assert.equal(plain.kind, 'reject', 'stale wait without a new_message trigger still rejects');
  await f.observe('turn/end', { turn: 21, reason: { kind: 'blocked' } });
  const pending = await f.repository.getPending();
  assert.ok(pending.some(record => record.sourceEventId === 'gate-msg-5'), 'unanswered message remains pending');
  assert.ok(pending.every(record => record.role !== 'assistant' || record.origin !== 'user'), 'nothing re-queued as human speech');
});
