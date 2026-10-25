import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshCoordinator } from '../adapters/dsh/index.js';

async function fixture(t, events = [], config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'persona-dsh-'));
  const handlers = new Map(), tools = new Map();
  const scope = { on(name, handler) { handlers.set(name, handler); }, tools: { restrict() { return () => {}; }, register(tool) { tools.set(tool.name, tool); } } };
  const session = { id: 'session-a', header: {}, deriveMessages: () => [], requestHeader: () => ({ config: { provider: 'test', model: 'fixture' } }) };
  const agent = { id: session.id, session, ctx: scope, inbox: { nextTurn: [], nextStep: [] }, followup(message) { this.inbox.nextTurn.push(message); } };
  const query = { readSession: async () => ({ events }), readEvent: async ({ seq }) => ({ target: events.find(event => event.seq === seq) }) };
  const ctx = { agents: { get: () => agent }, get: key => key === 'sessionQuery' ? query : undefined, llm: {} };
  const coordinator = createDshCoordinator(ctx, { memoryRoot: root, ...config });
  await coordinator.ready; await coordinator.attachAgent(agent);
  t.after(async () => { await coordinator.close(); await rm(root, { recursive: true, force: true }); });
  const user = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
  const enter = async (message, turn) => {
    handlers.get('agent/inbox/claimed')({ message, turn });
    return handlers.get('agent/pre-step')({ messages: [message], turn }, async () => ({ kind: 'enter', messages: [message] }));
  };
  const assistant = (id, turn, text) => coordinator.observeEvent(session, { type: 'assistant/message', seq: turn * 10 + 3, time: Date.now(), data: {
    turn, message: { id, role: 'assistant', content: [{ type: 'text', text }] } } });
  return { coordinator, repository: coordinator.repository, runtime: coordinator.runtime, agent, handlers, tools, user, enter, assistant };
}

test('only inputs admitted to the actual turn are acknowledged; late arrivals remain', async t => {
  const f = await fixture(t), first = f.user('first', 'first question'), late = f.user('late', 'late question');
  await f.enter(first, 1);
  f.handlers.get('agent/inbox/inserted')({ message: late });
  await f.coordinator.readyState();
  await f.assistant('answer-1', 1, 'first answer');
  assert.deepEqual((await f.repository.getPending()).map(record => record.sourceEventId), ['late']);
});

test('proactive provenance ends with its actual turn and cannot leak into ordinary replies', async t => {
  const f = await fixture(t);
  const notice = { id: 'control-1', role: 'user', source: { kind: 'persona-memory:control', controlId: 'control-1', proactive: true }, content: [{ type: 'text', text: 'reconsider' }] };
  await f.enter(notice, 1); await f.coordinator.observeEvent(f.agent.session, { type: 'user/message', seq: 2, data: notice });
  await f.assistant('active-answer', 1, 'I chose to speak');
  await f.enter(f.user('ordinary', 'hello'), 2); await f.assistant('ordinary-answer', 2, 'hello back');
  const all = (await f.repository.getContext({ personId: null })).records;
  assert.equal(all.find(record => record.sourceEventId === 'active-answer').origin, 'ai_initiated');
  assert.equal(all.find(record => record.sourceEventId === 'ordinary-answer').origin, 'ai_reply');
});

test('delivery replay associates plain user/message with its preceding real turn', async t => {
  const events = [{ type: 'turn/start', data: { turn: 7 } },
    { type: 'user/message', data: { id: 'delivery-1', source: { kind: 'persona-memory:delivery', deliveryId: 'delivery-1' } } },
    { type: 'assistant/message', seq: 25, time: 12345, data: { turn: 7, message: { id: 'reply', content: [{ type: 'text', text: 'actually sent' }] } } }];
  const f = await fixture(t, events);
  const receipt = await f.runtime.host.reconcileDelivery({ deliveryId: 'delivery-1', target: { sessionId: 'session-a', personId: null } });
  assert.equal(receipt.status, 'delivered'); assert.equal(receipt.text, 'actually sent');
});

test('trace pagination reads every Unicode codepoint using the runtime cursor contract', async t => {
  const text = '开始🧠继续结束';
  const events = [{ type: 'assistant/message', seq: 8, data: { turn: 1, message: { id: 'reason', content: [{ type: 'reasoning', text }] } } }];
  const f = await fixture(t, events);
  const locator = `dsh-trace:${encodeURIComponent(JSON.stringify({ sessionId: 'session-a', seq: 8, blockIndex: 0, kind: 'reasoning' }))}`;
  let cursor = null, joined = '';
  do { const page = await f.runtime.host.readTrace(locator, { cursor, maxChars: 2 });
    joined += page.text; assert.equal(page.truncated, page.nextCursor !== null); cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(joined, text);
});

test('capacity gaps retain an earlier host checkpoint and actually backfill the available rejected source', async t => {
  const events = [], f = await fixture(t, events, { longTermTargetChars: 8 });
  const message = f.user('gap-source', 'capacity gap original remains available in the native inbox event');
  const event = { type: 'agent/inbox/spliced', seq: 1, time: Date.now(), data: { inserted: [message] } };
  events.push(event); await f.coordinator.observeEvent(f.agent.session, event);
  let checkpoint = await f.repository.store.readJson('host-checkpoints.json');
  assert.equal(checkpoint.blocked['session-a'], 1);
  assert.equal((await f.repository.getRuntime()).memoryGaps.at(-1).recoverable, true);
  assert.equal((await f.repository.getPending()).length, 0);
  await f.runtime.updateConfig({ longTermTargetChars: 2000 });
  const replay = await f.coordinator.replaySources(f.agent);
  assert.equal(replay.processed, 1); assert.equal(replay.blockedFromSeq, null);
  assert.equal((await f.repository.getPending())[0].text, message.content[0].text);
  checkpoint = await f.repository.store.readJson('host-checkpoints.json');
  assert.equal(checkpoint.blocked['session-a'], undefined);
  assert.equal((await f.coordinator.replaySources(f.agent)).processed, 0);
});

test('hot overflow can read an unadmitted original by message ID from the durable native inbox', async t => {
  const events = [], f = await fixture(t, events, { tempTargetChars: 1 });
  const message = f.user('unadmitted', '还没有进入用户历史的原始输入🧠');
  events.push({ type: 'agent/inbox/spliced', seq: 1, data: { inserted: [message] } });
  f.handlers.get('agent/inbox/inserted')({ message }); await f.coordinator.readyState();
  const run = await f.repository.prepareConsolidation({ personId: null, maxInputChars: 1000 });
  const hot = run.input.hot[0]; assert.equal(hot.content.mode, 'host_trace'); assert.equal(hot.content.available, true);
  const page = await f.runtime.host.readTrace(hot.content.locator, { maxChars: 100 });
  assert.equal(page.text, message.content[0].text);
});

test('a post-admission local failure never invokes the native next callback twice', async t => {
  const f = await fixture(t), message = f.user('one-call', 'question'); let calls = 0;
  f.handlers.get('agent/inbox/claimed')({ message, turn: 1 });
  const original = f.repository.getPending;
  f.repository.getPending = async () => { throw new Error('injected local projection failure'); };
  try {
    const entered = await f.handlers.get('agent/pre-step')({ messages: [message], turn: 1 }, async () => { calls++; return { kind: 'enter', messages: [message] }; });
    assert.equal(entered.kind, 'enter'); assert.equal(calls, 1);
  } finally { f.repository.getPending = original; }
});

test('tool result pagination reads the same snapshot without repeating a forget side effect', async t => {
  const f = await fixture(t); let calls = 0;
  const ids = Array.from({ length: 60 }, (_, i) => `record_${i}_` + 'x'.repeat(75));
  f.runtime.forget = async () => { calls++; return { revocation: { id: 'revocation-test', action: 'forget' }, affectedIds: ids }; };
  const tool = f.tools.get('memory_forget'), args = { ids: ['selected'], reason: 'explicit test selection' };
  const all = []; let cursor;
  do {
    const page = await tool.execute({ ...args, ...(cursor ? { cursor } : {}) }, { agent: f.agent });
    assert.equal(page.affectedCount, ids.length); all.push(...page.affectedIds); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(all, ids); assert.equal(calls, 1);
});

test('a seq trace for a multi-message inbox splice selects its exact original message ID', async t => {
  const events = [], f = await fixture(t, events, { tempTargetChars: 1 });
  const first = f.user('splice-first', '第一条原文'), second = f.user('splice-second', '第二条原文🧠');
  const event = { type: 'agent/inbox/spliced', seq: 1, data: { inserted: [first, second] } }; events.push(event);
  await f.coordinator.observeEvent(f.agent.session, event);
  const run = await f.repository.prepareConsolidation({ personId: null, maxInputChars: 1000 });
  const hot = run.input.hot.find(record => record.sourceRef.sourceEventId === 'splice-second');
  const decoded = JSON.parse(decodeURIComponent(hot.content.locator.slice(10)));
  assert.equal(decoded.seq, 1); assert.equal(decoded.messageId, 'splice-second');
  assert.equal((await f.runtime.host.readTrace(hot.content.locator, { maxChars: 100 })).text, second.content[0].text);
});

test('an applied forget still reports its receipt when details exceed the optional page cache', async t => {
  const f = await fixture(t, [], { retention: { backupMaxBytes: 128 } }); let calls = 0;
  f.runtime.forget = async () => { calls++; return { revocation: { id: 'revocation-small-cache' }, affectedIds: Array.from({ length: 60 }, (_, i) => `id_${i}_` + 'x'.repeat(75)) }; };
  const output = await f.tools.get('memory_forget').execute({ ids: ['chosen'], reason: 'explicit selection' }, { agent: f.agent });
  assert.equal(output.status, 'applied_details_not_cached'); assert.equal(output.affectedCount, 60);
  assert.equal(output.revocationId, 'revocation-small-cache'); assert.equal(calls, 1);
});

test('claiming the next turn cannot erase the previous turn receipt before asynchronous output observation', async t => {
  const f = await fixture(t), first = f.user('previous-turn', 'first question'), next = f.user('next-turn', 'second question');
  await f.enter(first, 1);
  const active = { id: 'active-control', role: 'user', source: { kind: 'persona-memory:control', controlId: 'active-control', proactive: true }, content: [{ type: 'text', text: 'self-selected reconsideration' }] };
  f.handlers.get('agent/inbox/claimed')({ message: active, turn: 1 });
  // Native claims publish synchronously; session/event processing is deferred.
  f.handlers.get('agent/inbox/claimed')({ message: next, turn: 2 });
  await f.assistant('first-final', 1, 'first answer');
  assert.equal((await f.repository.getPending()).some(record => record.sourceEventId === first.id), false);
  assert.equal((await f.repository.getContext({ personId: null })).records.find(record => record.sourceEventId === 'first-final').origin, 'ai_initiated');
});

test('raw identity and search tool results satisfy the actual lossless JSON contract before render', async t => {
  const f = await fixture(t), message = f.user('identity-original', '我叫林岚，喜欢无糖红茶');
  await f.enter(message, 1);
  const identity = await f.tools.get('persona_decide').execute({ identityPlan: { action: 'new', displayName: '林岚' } }, { agent: f.agent });
  assert.notEqual(identity.status, 'memory_error'); assert.ok(identity.identity.personId);
  assert.deepEqual(identity, JSON.parse(JSON.stringify(identity)));
  const recalled = await f.tools.get('memory_search').execute({ query: '红茶', scope: 'all' }, { agent: f.agent });
  assert.equal(recalled.items.length, 1); assert.deepEqual(recalled, JSON.parse(JSON.stringify(recalled)));
  const props = f.tools.get('persona_decide').parameters.properties;
  const identitySchema = props.identityPlan.oneOf.find(schema => schema.type === 'object');
  assert.deepEqual(identitySchema.properties.sourceRefs.items.required, ['sourceSessionId', 'sourceEventId']);
  assert.match(identitySchema.properties.sourceRefs.description, /omit/i);
});

test('personality-selected attention excludes native participant input, including mixed notice batches', async t => {
  const f = await fixture(t); await f.runtime.decide({ attention: { observeChannelIds: [] } });
  const message = f.user('not-observed', '这条不应进入模型或记忆');
  assert.equal((await f.enter(message, 1)).kind, 'reject');
  assert.equal((await f.repository.getPending()).length, 0);
  const notice = { id: 'self-control', role: 'user', source: { kind: 'persona-memory:control' }, content: [{ type: 'text', text: 'selected reconsideration' }] };
  const entered = await f.handlers.get('agent/pre-step')({ messages: [message, notice], turn: 2 }, async () => ({ kind: 'enter', messages: [message, notice] }));
  assert.deepEqual(entered.messages.map(item => item.id), [notice.id]);
});

test('actual visible environment changes trigger only the selected event listener without a periodic timer', async t => {
  const f = await fixture(t), target = { channelId: 'dsh:session-a', sessionId: 'session-a', personId: null };
  await f.runtime.decide({ replyPlan: { action: 'listen', target, replyAt: null, recheckOn: ['environment_change'] }, nextCheckAt: null }, f.coordinator.contextFor(f.agent));
  f.agent.session.header.cwd = 'C:/changed-workspace';
  await f.coordinator.notifyEnvironment(f.agent);
  assert.equal(f.agent.inbox.nextTurn.length, 1);
  assert.match(f.agent.inbox.nextTurn[0].content[0].text, /environment_change/);
  await f.coordinator.notifyEnvironment(f.agent);
  assert.equal(f.agent.inbox.nextTurn.length, 1);
  assert.equal((await f.repository.getRuntime()).schedule.nextCheckAt, null);
});

test('a cross-session native decision routes through a real outbox and stops output in the source turn', async t => {
  const f = await fixture(t), handlers = new Map();
  const targetAgent = { id: 'session-b', ctx: { on: (name, handler) => handlers.set(name, handler), tools: { restrict() { return () => {}; }, register() {} } },
    session: { id: 'session-b', header: {}, deriveMessages: () => [], requestHeader: () => ({ config: { provider: 'test', model: 'fixture' } }) },
    inbox: { nextTurn: [], nextStep: [] }, followup(message) { this.inbox.nextTurn.push(message); } };
  await f.coordinator.attachAgent(targetAgent);
  const source = f.user('source-to-B', '请你考虑给另一个已知通道说句话'); await f.enter(source, 1);
  let modelContext;
  f.runtime.model = { complete: async input => { modelContext = input.context; return { text: '我想在B通道说的话' }; } };
  const result = await f.tools.get('persona_decide').execute({ replyPlan: { action: 'reply', target: { channelId: 'dsh:session-b', sessionId: 'session-b', personId: null }, replyAt: null } }, { agent: f.agent });
  assert.notEqual(result.status, 'memory_error');
  assert.equal(modelContext.sessionId, 'session-b'); assert.equal(modelContext.pending[0].sourceSessionId, 'session-a');
  const outbox = await f.repository.getOutbox(); assert.equal(outbox.length, 1); assert.equal(outbox[0].target.sessionId, 'session-b');
  assert.equal(targetAgent.inbox.nextTurn[0].source.deliveryId, outbox[0].deliveryId);
  assert.equal((await f.handlers.get('agent/pre-step')({ messages: [], turn: 1 }, async () => ({ kind: 'enter', messages: [] }))).kind, 'reject');
});

test('choosing to observe another channel does not cancel the explicitly chosen reply to already admitted input', async t => {
  const f = await fixture(t), message = f.user('admitted-before-attention-change', '请回应这轮已接收的话');
  await f.enter(message, 1);
  await f.runtime.decide({ attention: { observeChannelIds: ['dsh:other-channel'] }, replyPlan: {
    action: 'reply', target: { channelId: 'dsh:session-a', sessionId: 'session-a', personId: null }, replyAt: null,
  } }, { ...f.coordinator.contextFor(f.agent), executeReply: false });
  const continuation = await f.handlers.get('agent/pre-step')({ messages: [], turn: 1 }, async () => ({ kind: 'enter', messages: [] }));
  assert.equal(continuation.kind, 'enter');
  await f.assistant('chosen-reply', 1, '本轮回复仍然发出');
  const excludedLater = f.user('later-excluded', '以后新来的这条仍不观察');
  assert.equal((await f.enter(excludedLater, 2)).kind, 'reject');
  assert.equal((await f.repository.getContext({ personId: null })).records.some(record => record.sourceEventId === excludedLater.id), false);
});

test('identifying explicitly selected B sources changes B routing without overwriting the active A conversation', async t => {
  const f = await fixture(t);
  const b = { id: 'session-b', ctx: { on() {}, tools: { restrict() { return () => {}; }, register() {} } }, session: { id: 'session-b', header: {}, deriveMessages: () => [] },
    inbox: { nextTurn: [], nextStep: [] }, followup(message) { this.inbox.nextTurn.push(message); } };
  await f.coordinator.attachAgent(b);
  await f.repository.upsertPerson({ personId: 'person_a', displayName: 'A' });
  await f.repository.upsertPerson({ personId: 'person_b', displayName: 'B' });
  const aMessage = f.user('actual-a', 'A本人'); await f.enter(aMessage, 1);
  await f.runtime.decide({ identityPlan: { action: 'associate', personId: 'person_a', sourceRefs: [{ sourceSessionId: 'session-a', sourceEventId: 'actual-a' }] } }, f.coordinator.contextFor(f.agent));
  await f.coordinator.observeEvent(b.session, { type: 'agent/inbox/spliced', seq: 1, data: { inserted: [f.user('actual-b', 'B本人')] } });
  const result = await f.tools.get('persona_decide').execute({ identityPlan: { action: 'associate', personId: 'person_b', sourceRefs: [{ sourceSessionId: 'session-b', sourceEventId: 'actual-b' }] } }, { agent: f.agent });
  assert.equal(f.coordinator.contextFor(f.agent).personId, 'person_a');
  assert.equal(f.coordinator.contextFor(b).personId, 'person_b');
  assert.deepEqual(result.identityAssociation.selectedSourceSessionIds, ['session-b']);
  assert.equal(result.identityAssociation.currentRoute.personId, 'person_a');
  assert.equal(result.identityAssociation.currentSessionWasSelected, false);
  assert.equal(result.identityAssociation.currentRouteMatchesRecognition, false);
  assert.deepEqual(result, JSON.parse(JSON.stringify(result)));
  assert.equal((await f.repository.readSources({ sourceRefs: [{ sourceSessionId: 'session-b', sourceEventId: 'actual-b' }] }))[0].personId, 'person_b');
});
