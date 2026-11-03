import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshCoordinator } from '../adapters/dsh/index.js';
import { MemoryRepository, PersonaRuntime } from '../core/index.js';

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
  let now = Date.now(); coordinator.runtime.clock = () => now;
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
  return { coordinator, agent, tools, handlers, observe, preStep, decide, userMessage, runSearch, repository: coordinator.repository,
    advance: duration => { now += duration; } };
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

test('an unrelated or older visible output cannot clear a newer indefinite wait or listen plan', async t => {
  const f = await fixture(t);
  for (const action of ['wait', 'listen']) {
    await f.decide({ replyPlan: { action, target: null, pendingEventIds: [], replyAt: null, reason: '我选择持续等待，不安排自动复查。' } }, `indefinite-${action}`);
    const before = await f.repository.getRuntime();
    await f.coordinator.observeEvent(f.agent.session, { type: 'assistant/message', seq: action === 'wait' ? 3000 : 3001,
      time: before.currentDecision.decidedAt - 1000, data: { turn: 29, message: { id: `older-${action}`, role: 'assistant',
        content: [{ type: 'text', text: '这是较早回合的已保留公开输出，不是新等待计划的完成信号。' }] } } });
    assert.deepEqual((await f.repository.getRuntime()).currentDecision.replyPlan, before.currentDecision.replyPlan,
      'visible delivery is a fact, not proof that this newer plan was spent');
    assert.equal((await f.repository.getRuntime()).schedule.replyPlanDecisionId, before.schedule.replyPlanDecisionId);
    const turn = action === 'wait' ? 30 : 31, message = f.userMessage(`holding-${action}`, '普通新消息');
    f.handlers.get('agent/inbox/claimed')({ message, turn });
    assert.equal((await f.preStep(turn, [message])).kind, 'reject', 'no unselected trigger is added after an output');
    await f.observe('turn/end', { turn, reason: { kind: 'blocked' } });
  }
});

test('a wait with explicit recheckOn or a future replyAt is never expired by a delivery', async t => {
  const f = await fixture(t);
  await f.decide({ replyPlan: { action: 'wait', target: null, pendingEventIds: [], replyAt: null, recheckOn: ['environment_change'], reason: 'explicit event wait' } }, 'trigger-wait');
  await f.observe('turn/start', { turn: 40 });
  await f.observe('assistant/message', { turn: 40, message: { id: 'trigger-reply', role: 'assistant', content: [{ type: 'text', text: '交付一条' }] } });
  await f.observe('turn/end', { turn: 40, reason: { kind: 'completed' } });
  const during = f.userMessage('gate-msg-8', '显式触发不该被交付冲掉');
  await f.observe('turn/start', { turn: 41 });
  f.handlers.get('agent/inbox/claimed')({ message: during, turn: 41 });
  assert.equal((await f.preStep(41, [during])).kind, 'reject', 'wait with explicit recheckOn keeps holding after a delivery');
  await f.observe('turn/end', { turn: 41, reason: { kind: 'blocked' } });
  await f.decide({ replyPlan: { action: 'wait', target: null, pendingEventIds: [], replyAt: Date.now() + 3600e3, reason: 'future check' } }, 'future-wait');
  await f.observe('turn/start', { turn: 42 });
  await f.observe('assistant/message', { turn: 42, message: { id: 'future-reply', role: 'assistant', content: [{ type: 'text', text: '再交付一条' }] } });
  await f.observe('turn/end', { turn: 42, reason: { kind: 'completed' } });
  const later = f.userMessage('gate-msg-9', '有钟点的等待也保持');
  await f.observe('turn/start', { turn: 43 });
  f.handlers.get('agent/inbox/claimed')({ message: later, turn: 43 });
  assert.equal((await f.preStep(43, [later])).kind, 'reject', 'wait with a future replyAt keeps holding after a delivery');
  await f.observe('turn/end', { turn: 43, reason: { kind: 'blocked' } });
});

test('a no-trigger wait remains selected after ten minutes or many days even with pending participant messages', async t => {
  const f = await fixture(t);
  await f.decide({ replyPlan: { action: 'wait', target: null, pendingEventIds: [], replyAt: null, reason: '明确选择不设自动出口的等待。' } }, 'long-wait');
  const before = await f.repository.getRuntime();
  for (const [turn, advance] of [[50, 600000], [51, 30 * 86400000]]) {
    f.advance(advance);
    const message = f.userMessage(`long-wait-${turn}`, '尚未答复的真实来信');
    await f.observe('turn/start', { turn }); f.handlers.get('agent/inbox/claimed')({ message, turn });
    assert.equal((await f.preStep(turn, [message])).kind, 'reject', 'elapsed wall time is not an autonomous expiry signal');
    await f.observe('turn/end', { turn, reason: { kind: 'blocked' } });
    const after = await f.repository.getRuntime(); assert.deepEqual(after.currentDecision.replyPlan, before.currentDecision.replyPlan);
    assert.equal(after.schedule.replyPlanDecisionId, before.schedule.replyPlanDecisionId);
    assert.ok((await f.repository.getPending()).some(record => record.sourceEventId === message.id));
  }
});

test('a selected environment notification admits necessary tool continuation without rewriting the old wait', async t => {
  const f = await fixture(t);
  await f.decide({ replyPlan: { action: 'wait', target: null, pendingEventIds: [], replyAt: null, recheckOn: ['environment_change'], reason: '只等我选择的环境通知。' } }, 'notification-wait');
  const before = await f.repository.getRuntime();
  await f.coordinator.runtime.handleSignal('environment_change', f.coordinator.contextFor(f.agent));
  const notice = f.agent.inbox.nextTurn.shift(); assert.equal(notice.source.kind, 'persona-memory:control');
  f.handlers.get('agent/inbox/claimed')({ message: notice, turn: 60 });
  assert.equal((await f.preStep(60, [notice])).kind, 'enter'); await f.observe('user/message', notice);
  assert.notEqual((await f.runSearch('notification-search')).status, 'memory_error');
  assert.equal((await f.preStep(60, [])).kind, 'enter', 'selected notification admission survives tool continuations');
  assert.deepEqual((await f.repository.getRuntime()).currentDecision.replyPlan, before.currentDecision.replyPlan);
  await f.observe('turn/end', { turn: 60, reason: { kind: 'completed' } });
  assert.equal((await f.preStep(61, [])).kind, 'reject', 'notification admission does not cross into another turn');
});

test('a selected one-shot recheck admits its control turn but consuming its time does not erase the reply sub-plan', async t => {
  const f = await fixture(t);
  await f.decide({ nextCheckAfterMs: 60000, replyPlan: { action: 'wait', target: null, pendingEventIds: [], replyAt: null,
    reason: '选择一分钟后再看一次，其后是否变更等待仍由我决定。' } }, 'selected-recheck');
  const before = await f.repository.getRuntime(); f.advance(60001);
  assert.equal((await f.coordinator.runtime.handleDue(f.coordinator.contextFor(f.agent))).status, 'queued');
  const notice = f.agent.inbox.nextTurn.shift(); assert.equal(notice.source.kind, 'persona-memory:control');
  f.handlers.get('agent/inbox/claimed')({ message: notice, turn: 70 });
  assert.equal((await f.preStep(70, [notice])).kind, 'enter'); await f.observe('user/message', notice);
  assert.notEqual((await f.runSearch('selected-recheck-search')).status, 'memory_error');
  assert.equal((await f.preStep(70, [])).kind, 'enter');
  await f.observe('assistant/message', { turn: 70, message: { id: 'recheck-answer', role: 'assistant', content: [{ type: 'text', text: '我看到了复查结果。' }] } });
  await f.observe('turn/end', { turn: 70, reason: { kind: 'completed' } });
  const after = await f.repository.getRuntime(); assert.equal(after.schedule.nextCheckAt, null, 'the chosen check is one-shot');
  assert.deepEqual(after.currentDecision.replyPlan, before.currentDecision.replyPlan, 'omitting a new replyPlan preserves the previous sub-plan');
  assert.equal(after.schedule.replyPlanDecisionId, before.schedule.replyPlanDecisionId);
});

test('cold open preserves an indefinite listen and pending originals without inventing an expiry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'persona-listen-cold-')); let now = 1000;
  let repository = new MemoryRepository({ root, clock: () => now });
  let runtime = new PersonaRuntime({ repository, clock: () => now, autoSchedule: false });
  t.after(async () => { if (runtime.opened) await runtime.close(); await rm(root, { recursive: true, force: true }); });
  await runtime.open();
  await runtime.accept({ role: 'user', origin: 'user', sourceKind: 'user', contentClass: 'participant_dialogue',
    sourceSessionId: 'cold', sourceEventId: 'cold-original', channelId: 'dsh:cold', personId: null, text: '旧来信仍待处理。' }, { sessionId: 'cold', channelId: 'dsh:cold' });
  await runtime.decide({ replyPlan: { action: 'listen', target: null, pendingEventIds: [], replyAt: null, reason: '我选择继续倾听，不设置时钟。' } }, { executeReply: false });
  const before = await repository.getRuntime(), pending = await repository.getPending(); await runtime.close();
  now += 30 * 86400000;
  repository = new MemoryRepository({ root, clock: () => now }); runtime = new PersonaRuntime({ repository, clock: () => now, autoSchedule: false });
  await runtime.open();
  const after = await repository.getRuntime(); assert.deepEqual(after.currentDecision.replyPlan, before.currentDecision.replyPlan);
  assert.equal(after.schedule.replyPlanDecisionId, before.schedule.replyPlanDecisionId);
  // Timeline tier is a legitimate time-based view; the same pending original,
  // identity, role, source and body must survive that recent-to-long transition.
  const original = rows => rows.map(({ tier: _tier, ...row }) => row);
  assert.deepEqual(original(await repository.getPending()), original(pending));
});
