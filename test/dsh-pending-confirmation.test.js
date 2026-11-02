import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createDshCoordinator } from '../adapters/dsh/index.js';
import { createDshChannelPort } from '../adapters/dsh/channels/native.js';

async function fixture(t, id = 'confirmation-session') {
  const root = await mkdtemp(join(tmpdir(), 'persona-pending-confirm-')), handlers = new Map(), tools = new Map(), history = [];
  const scope = { on(name, handler) { handlers.set(name, handler); }, tools: { restrict() { return () => {}; }, register(tool) { tools.set(tool.name, tool); } } };
  const session = { id, header: {}, deriveMessages: () => history, requestHeader: () => ({ config: { provider: 'none', model: 'none' } }) };
  const agent = { id, session, ctx: scope, inbox: { nextTurn: [], nextStep: [] }, followup(message) { this.inbox.nextTurn.push(message); } };
  const coordinator = createDshCoordinator({ agents: { get: key => key === id ? agent : null }, llm: {}, get: () => undefined }, { memoryRoot: root, operatorControl: false });
  await coordinator.ready; await coordinator.attachAgent(agent);
  t.after(async () => { await coordinator.close(); await rm(root, { recursive: true, force: true }); });
  let seq = 0;
  const observe = (type, data) => coordinator.observeEvent(session, { type, data, time: Date.now(), seq: seq++ });
  const message = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
  const incoming = (id, text, extra = {}) => coordinator.runtime.accept({ role: 'user', origin: 'user', contentClass: 'participant_dialogue', sourceKind: 'user',
    sourceSessionId: session.id, sourceEventId: id, text, channelId: coordinator.contextFor(agent).channelId, personId: null, ...extra }, coordinator.contextFor(agent).environment);
  const admit = async (value, turn = 1) => {
    await observe('turn/start', { turn }); handlers.get('agent/inbox/claimed')({ message: value, turn });
    const entered = await handlers.get('agent/pre-step')({ messages: [value], turn }, async () => ({ kind: 'enter', messages: [value] }));
    assert.equal(entered.kind, 'enter'); await observe('user/message', value);
  };
  const decide = async ids => tools.get('persona_decide').execute({ replyPlan: { action: 'reply', target: null, pendingEventIds: ids, replyAt: null } }, { agent, callId: `decide-${seq++}` });
  const output = (text, turn = 1, content) => observe('assistant/message', { turn, step: 1,
    message: { id: `output-${seq}`, role: 'assistant', source: { kind: 'model' }, content: content ?? [{ type: 'text', text }] } });
  const pendingIds = async () => (await coordinator.repository.getPending()).map(row => row.eventId);
  return { coordinator, agent, history, tools, handlers, observe, message, incoming, admit, decide, output, pendingIds };
}

test('same-session explicit old pending selection takes effect only after real visible delivery', async t => {
  const f = await fixture(t), old = await f.incoming('old-user', 'Please read the final report, then tell me the result.');
  f.history.push(f.message('old-user', old.record.text));
  await f.admit(f.message('new-user', 'Did it finish?'));
  const current = (await f.coordinator.repository.getPending()).find(row => row.sourceEventId === 'new-user');
  const result = await f.decide([old.eventId]);
  assert.notEqual(result.status, 'memory_error');
  assert.deepEqual([...f.coordinator.agents.get(f.agent.id).selectedPendingByTurn.get(1)], [old.eventId]);
  assert.deepEqual(new Set(await f.pendingIds()), new Set([old.eventId, current.eventId]), 'a decision is not a delivery');
  await f.output('The final report is ready.');
  assert.deepEqual(await f.pendingIds(), []);
  const facts = await f.coordinator.getDeliveryFacts({ sessionId: f.agent.id });
  assert.equal(facts.outputs.items.length, 1);
  assert.deepEqual(new Set(facts.outputs.items[0].settledPendingEventIds), new Set([old.eventId, current.eventId]));
  assert.equal(facts.outputs.items[0].evidence, 'native_visible_assistant_event');
  assert.equal((await f.coordinator.repository.readSources({ eventIds: [old.eventId] }))[0].text, old.record.text, 'original remains recoverable');
});

test('unread guessed IDs, incomplete history, foreign session and other person cannot be acknowledged by a same-session reply', async t => {
  const f = await fixture(t);
  await f.coordinator.repository.upsertPerson({ personId: 'other-person' });
  const unread = await f.incoming('unread', 'Never admitted original body.'), partial = await f.incoming('partial', 'Exact full old source body.'),
    foreign = await f.incoming('foreign', 'Another session question.', { sourceSessionId: 'foreign-session', channelId: 'dsh:foreign-session' }),
    otherPerson = await f.incoming('other-person-user', 'Different person in this channel.', { personId: 'other-person' });
  f.history.push(f.message('partial', 'Exact full'));
  f.history.push(f.message('other-person-user', otherPerson.record.text));
  await f.admit(f.message('current', 'Hello'));
  const ids = [unread, partial, foreign, otherPerson].map(value => value.eventId);
  const result = await f.decide(ids); assert.notEqual(result.status, 'memory_error');
  assert.deepEqual([...f.coordinator.agents.get(f.agent.id).selectedPendingByTurn.get(1)], []);
  await f.output('Hello.'); assert.deepEqual(new Set(await f.pendingIds()), new Set(ids));
});

test('tool-only output and silence preserve pending; later real output is a fact, not proof an older request was answered', async t => {
  const f = await fixture(t), old = await f.incoming('old', 'Old still unanswered question.');
  await f.admit(f.message('new', 'Current question'));
  const before = await f.pendingIds();
  await f.output('', 1, [{ type: 'tool-call', id: 'tool-only', name: 'memory_search', arguments: { query: 'question' } }]);
  assert.deepEqual(await f.pendingIds(), before);
  await f.observe('turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.deepEqual(await f.pendingIds(), before, 'no visible final stays pending');
  await f.admit(f.message('another', 'Unrelated follow-up'), 2); await f.output('Here is an unrelated answer.', 2);
  assert.ok((await f.pendingIds()).includes(old.eventId));
  const facts = await f.coordinator.getDeliveryFacts({ sessionId: f.agent.id });
  const row = facts.pending.items.find(item => item.eventId === old.eventId);
  assert.equal(row.answeredByLaterOutput, 'not_inferred'); assert.equal(row.laterOutputCount, 1);
  assert.match(facts.note, /do not prove/);
});

test('wake presentation never settles other channels and partial source pages only qualify after complete observed coverage', async t => {
  const f = await fixture(t), full = await f.incoming('full', 'Complete here.'), partial = await f.incoming('paged', 'abcdefghij'),
    foreign = await f.incoming('foreign', 'Complete elsewhere.', { sourceSessionId: 'foreign-session', channelId: 'dsh:foreign-session' });
  const page = (value, from, to) => ({ eventId: value.eventId, sourceSessionId: value.record.sourceSessionId, sourceEventId: value.record.sourceEventId,
    fragment: { from, to, total: Array.from(value.record.text).length, complete: to === Array.from(value.record.text).length } });
  const notice = (id, pages) => ({ ...f.message(id, 'Trusted host source page'), source: { kind: 'persona-memory:control', pendingEventIds: pages.map(row => row.eventId), pendingSourcePage: pages } });
  await f.admit(notice('notice-tail', [page(full, 0, full.record.text.length), page(partial, 5, 10), page(foreign, 0, foreign.record.text.length)]));
  f.coordinator.tasks.sourceFacts = async () => ({ items: [{ taskId: 'task-related', status: 'completed', relation: 'dependency_reference', resultAvailable: true,
    sourceRefs: [{ sourceSessionId: foreign.record.sourceSessionId, sourceEventId: foreign.record.sourceEventId }] }], totalCandidates: 1, scannedCandidates: 1, truncated: false });
  const view = await f.coordinator.getDeliveryFacts({ sessionId: f.agent.id });
  assert.ok(view.pending.items.some(row => row.eventId === foreign.eventId), 'wake sources have on-demand delivery context even when the original session differs');
  assert.equal(view.relatedTasks.items[0].relation, 'dependency_reference');
  assert.equal(view.pending.items.find(row => row.eventId === foreign.eventId).answeredByLaterOutput, 'not_inferred');
  await f.output('I heard the message here.');
  assert.deepEqual(new Set(await f.pendingIds()), new Set([partial.eventId, foreign.eventId]), 'tail alone and foreign source stay pending');
  await f.admit(notice('notice-head', [page(partial, 0, 5)]), 2); await f.output('Now I have the whole local message.', 2);
  assert.deepEqual(await f.pendingIds(), [foreign.eventId]);
});

test('unknown external delivery does not settle explicitly selected or admitted pending', async t => {
  const id = 'xiangxu-social-0123456789abcdef', f = await fixture(t, id), facts = { platform: 'qq', accountId: 'bot', conversation: { type: 'private', id: 'human' }, sender: { id: 'human' } };
  await f.coordinator.registerExternalChannel(id, facts);
  f.coordinator.externalDelivery = { output: async () => ({ status: 'unknown', code: 'CHANNEL_OUTPUT_UNKNOWN' }) };
  const old = await f.incoming('platform-old', 'Old external question.'); f.history.push(f.message('platform-old', old.record.text));
  await f.admit({ ...f.message('platform-new', 'Follow-up'), source: { kind: 'user', xiangxuChannel: facts, platformMessageId: 'platform-new' } });
  await f.decide([old.eventId]); const before = await f.pendingIds();
  await f.output('Generated but not confirmed sent.'); assert.deepEqual(await f.pendingIds(), before);
  const state = await f.tools.get('persona_introspect').execute({ section: 'state' }, { agent: f.agent, callId: 'facts-inspect' });
  // Introspection is normally bounded by the adapter; use the direct view to
  // assert its full diagnostics without treating transport previews as complete.
  assert.notEqual(state.status, 'memory_error');
  const view = await f.coordinator.getDeliveryFacts({ sessionId: id });
  assert.equal(view.outputs.items[0].status, 'unknown'); assert.deepEqual(view.outputs.items[0].settledPendingEventIds, []);
});

test('many pending sources bound task-fact inputs and task diagnostics failure never blocks native replies', async t => {
  const f = await fixture(t), original = f.coordinator.repository.getPending.bind(f.coordinator.repository);
  const rows = Array.from({ length: 257 }, (_, i) => ({ eventId: `ev-${i}`, sourceSessionId: `parent-${i % 17}`,
    sourceEventId: `source-${i}`, sourceAt: 1, channelId: `dsh:parent-${i % 17}`, personId: null, text: 'original' }));
  f.coordinator.repository.getPending = async () => rows;
  let received;
  f.coordinator.tasks.sourceFacts = async args => { received = args; return { items: [], totalCandidates: 0, scannedCandidates: 0, truncated: false }; };
  const facts = await f.coordinator.getDeliveryFacts();
  assert.equal(facts.pending.total, 257); assert.equal(facts.pending.truncated, true);
  assert.ok(received.sourceRefs.length <= 256); assert.equal(received.parentSessionIds.length, 16);
  assert.equal(facts.relatedTasks.requestScope.totalSourceRefs, 257); assert.equal(facts.relatedTasks.requestScope.totalParentSessions, 17);
  assert.equal(facts.relatedTasks.truncated, true);
  f.coordinator.tasks.sourceFacts = async () => { throw Object.assign(new Error('isolated fact service unavailable'), { code: 'TEST_FACTS_UNAVAILABLE' }); };
  const failed = await f.coordinator.getDeliveryFacts();
  assert.equal(failed.relatedTasks.available, false); assert.equal(failed.relatedTasks.errorCode, 'TEST_FACTS_UNAVAILABLE');
  f.coordinator.repository.getPending = original;
  await f.admit(f.message('still-receive', 'Can normal chat continue?')); await f.output('Yes.');
  assert.deepEqual(await f.pendingIds(), []);
});

async function platformFixture(t) {
  const f = await fixture(t, 'xiangxu-social-abcdef0123456789');
  const facts = { platform: 'qq', accountId: 'bot', conversation: { type: 'private', id: 'human' }, sender: { id: 'human' } };
  await f.coordinator.registerExternalChannel(f.agent.id, facts);
  f.coordinator.externalDelivery = { output: async args => ({ status: 'delivered', receiptId: 'platform-confirmed-output',
    textHash: createHash('sha256').update(args.text).digest('hex') }) };
  const port = createDshChannelPort({ ctx: { agents: { get: id => id === f.agent.id ? f.agent : null },
    get: key => key === 'sessions' ? { flush: async () => {} } : undefined }, getCoordinator: () => f.coordinator });
  async function message(id, caption, structured = true) {
    await port.send({ memoryRoot: f.coordinator.memoryRoot, sessionId: f.agent.id, facts }, { messageId: id, text: caption,
      ...(structured ? { structured: { rich: { hasStructuredContent: true, mentions: [], replies: [], faces: [],
        media: [{ kind: 'image', status: 'not_attached' }], forwards: [], perception: { understandingConfirmed: false } }, derived: [], images: [] } } : {}),
      sourceFacts: { messageId: 'platform-' + id } });
    return f.agent.inbox.nextTurn.find(value => value.id === id);
  }
  return { ...f, facts, platformMessage: message };
}

for (const caption of ['Look at this complete caption.', '']) test(`native structured QQ source ${caption ? 'with caption' : 'without caption'} is admitted whole while derived text stays separate`, async t => {
  const f = await platformFixture(t), message = await f.platformMessage('structured-source', caption);
  assert.match(message.content.filter(block => block.type === 'text').at(-1).text, /平台结构化资料/);
  await f.admit(message);
  const original = (await f.coordinator.repository.getPending()).find(row => row.sourceEventId === message.id);
  assert.equal(original.text, caption); assert.equal(f.coordinator.agents.get(f.agent.id).admittedByTurn.get(1).has(original.eventId), true);
  await f.output('The attachment came through.'); assert.deepEqual(await f.pendingIds(), []);
  const view = await f.coordinator.getDeliveryFacts({ sessionId: f.agent.id });
  assert.equal(view.outputs.items[0].status, 'delivered'); assert.deepEqual(view.outputs.items[0].settledPendingEventIds, [original.eventId]);
  assert.equal((await f.coordinator.repository.readSources({ eventIds: [original.eventId] }))[0].text, caption);
});

test('an explicitly selected old structured QQ source qualifies through its exact native history projection', async t => {
  const f = await platformFixture(t), oldMessage = await f.platformMessage('old-structured', 'Full earlier caption.');
  await f.observe('user/message', oldMessage); f.history.push(oldMessage);
  const old = (await f.coordinator.repository.getPending()).find(row => row.sourceEventId === oldMessage.id);
  await f.admit(await f.platformMessage('new-question', 'Did you see it?', false));
  const result = await f.decide([old.eventId]); assert.notEqual(result.status, 'memory_error');
  assert.deepEqual([...f.coordinator.agents.get(f.agent.id).selectedPendingByTurn.get(1)], [old.eventId]);
  assert.ok((await f.pendingIds()).includes(old.eventId), 'selection alone is not delivery');
  await f.output('Yes, the earlier attachment is available.'); assert.deepEqual(await f.pendingIds(), []);
});

test('structured metadata cannot credit an omitted original, incomplete derived projection or mismatched platform identity', async t => {
  const f = await platformFixture(t), originalText = 'Complete caption with an unread tail.';
  const incompleteOriginal = await f.platformMessage('incomplete-original', originalText);
  incompleteOriginal.content[0].text = 'Complete caption';
  await f.admit(incompleteOriginal); f.history.push(incompleteOriginal);
  const incompleteDerived = await f.platformMessage('incomplete-derived', 'Second caption.');
  incompleteDerived.content[1].text = '[平台结构化资料：不是用户键入的原话]\n';
  await f.admit(incompleteDerived, 2); f.history.push(incompleteDerived);
  const forgedHistory = await f.platformMessage('foreign-account', 'Third caption.');
  await f.observe('user/message', forgedHistory);
  f.history.push({ ...forgedHistory, source: { ...forgedHistory.source, xiangxuChannel: { ...f.facts, accountId: 'different-account' } } });
  const oldIds = await f.pendingIds();
  await f.admit(await f.platformMessage('actual-new', 'A current question.', false), 3);
  const result = await f.decide(oldIds); assert.notEqual(result.status, 'memory_error');
  assert.deepEqual([...f.coordinator.agents.get(f.agent.id).selectedPendingByTurn.get(3)], []);
  await f.output('A delivered answer to the current question.', 3);
  assert.deepEqual(new Set(await f.pendingIds()), new Set(oldIds));
});
