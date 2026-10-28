import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createDshCoordinator } from '../adapters/dsh/index.js';

const A = 'xiangxu-social-' + 'a'.repeat(32), B = 'xiangxu-social-' + 'b'.repeat(32);
const facts = sender => ({ platform: 'qq', accountId: 'bot-account-1', conversation: { id: 'shared-group-1', type: 'group' }, sender: { id: 'sender-' + sender, name: 'Display ' + sender } });
const user = (id, text, sender = 'A', source = {}) => ({ id, role: 'user', source: { kind: 'user', xiangxuChannel: facts(sender), platformMessageId: 'platform-' + id,
  platformSourceAt: Date.now() - 1000, ...source }, content: [{ type: 'text', text }] });
function replacementOf(previous) {
  const handlers = new Map(), tools = new Map(), restrictions = [], registrations = [];
  const scope = { on(event, handler) { handlers.set(event, handler); return () => { if (handlers.get(event) === handler) handlers.delete(event); }; }, tools: {
    register(tool) { assert.equal(tools.has(tool.name), false, 'a resumed scope must not register a second copy of a tool'); tools.set(tool.name, tool); registrations.push(tool.name); return () => { if (tools.get(tool.name) === tool) tools.delete(tool.name); }; },
    restrict(value) { restrictions.push(value); return () => {}; },
  } };
  const agent = { ...previous.agent, session: { ...previous.agent.session }, ctx: scope, inbox: { ...previous.agent.inbox, nextTurn: [], nextStep: [] } };
  return { agent, handlers, tools, restrictions, registrations };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xiangxu-external-context-')), agents = new Map(), events = new Map(); let modelCalls = 0, queryReads = 0;
  for (const id of [A, B]) {
    const handlers = new Map(), tools = new Map(), restrictions = [];
    const scope = { on(event, handler) { handlers.set(event, handler); return () => { if (handlers.get(event) === handler) handlers.delete(event); }; },
      tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); }, restrict(value) { restrictions.push(value); return () => {}; } } };
    const session = { id, header: {}, deriveMessages: () => [], requestHeader: () => ({ config: { provider: 'fixture', model: 'fixture-only' } }) };
    const agent = { id, session, ctx: scope, inbox: { nextTurn: [], nextStep: [], splice(target, start, count, inserted) { const list = target === 'next-turn' ? this.nextTurn : this.nextStep; list.splice(start, count, ...inserted); } },
      followup(message) { this.inbox.nextTurn.push(message); }, cancel() {}, status: 'idle' };
    agents.set(id, { agent, handlers, tools, restrictions }); events.set(id, []);
  }
  const query = { async readSession(id) { queryReads++; return { events: events.get(id) ?? [] }; }, async readEvent({ sessionId, seq }) { return { target: (events.get(sessionId) ?? []).find(event => event.seq === seq) }; } };
  const ctx = { agents: { get: id => agents.get(id)?.agent, list: () => [...agents.values()].map(value => value.agent) },
    get: key => key === 'sessionQuery' ? query : key === 'agentPresets' ? { composedPreset: () => 'persona-memory' } : undefined,
    llm: { async stream() { modelCalls++; throw new Error('External context persistence tests must not request a model'); } } };
  let coordinator;
  const open = async () => { coordinator = createDshCoordinator(ctx, { memoryRoot: root, operatorControl: false, provider: 'fixture', model: 'fixture-only' }); await coordinator.ready; assert.equal(coordinator.initializationError, null); return coordinator; };
  await open();
  t.after(async () => { await coordinator.close(); await rm(root, { recursive: true, force: true }); });
  const register = async () => { await coordinator.registerExternalChannel(A, facts('A')); await coordinator.registerExternalChannel(B, facts('B')); for (const value of agents.values()) await coordinator.attachAgent(value.agent); };
  const enter = async (id, message, turn) => {
    const state = agents.get(id); state.handlers.get('agent/inbox/claimed')({ message, turn });
    return state.handlers.get('agent/pre-step')({ messages: [message], turn }, async () => ({ kind: 'enter', messages: [message] }));
  };
  const assistant = async (id, messageId, turn, text) => {
    const event = { type: 'assistant/message', seq: turn * 10 + 3, time: Date.now(), data: { turn, message: { id: messageId, role: 'assistant', content: [{ type: 'text', text }] } } };
    events.get(id).push(event); await coordinator.observeEvent(agents.get(id).agent.session, event); return event;
  };
  return { root, agents, events, get coordinator() { return coordinator; }, get modelCalls() { return modelCalls; }, get queryReads() { return queryReads; }, register, enter, assistant,
    async reload() { await coordinator.close(); await open(); for (const value of agents.values()) await coordinator.attachAgent(value.agent); } };
}

test('same-room participants keep separate external facts and only explicit personality recognition assigns A', async t => {
  const f = await fixture(t); await f.register();
  const ca = f.coordinator.contextFor(f.agents.get(A).agent), cb = f.coordinator.contextFor(f.agents.get(B).agent);
  assert.equal(ca.personId, null); assert.equal(cb.personId, null); assert.equal(ca.environment.platform, 'qq');
  assert.deepEqual(ca.environment.externalChannel, facts('A')); assert.deepEqual(cb.environment.externalChannel, facts('B'));
  assert.equal(ca.environment.participantClues[0].externalId, 'qq:bot-account-1:sender-A'); assert.notEqual(ca.environment.participantClues[0].externalId, cb.environment.participantClues[0].externalId);
  assert.equal(ca.environment.externalChannel.conversation.id, cb.environment.externalChannel.conversation.id);
  assert.equal((await f.coordinator.repository.listPeople()).length, 0, 'platform IDs must not silently create people');
  await f.enter(A, user('actual-A', 'Original from group sender A'), 1); await f.enter(B, user('actual-B', 'Original from group sender B', 'B'), 1);
  await f.agents.get(A).tools.get('persona_decide').execute({ identityPlan: { action: 'new', personId: 'recognized_a', displayName: 'A' } }, { agent: f.agents.get(A).agent, callId: 'explicit-recognize-A' });
  assert.equal(f.coordinator.contextFor(f.agents.get(A).agent).personId, 'recognized_a'); assert.equal(f.coordinator.contextFor(f.agents.get(B).agent).personId, null);
  const known = (await f.coordinator.repository.getContext({ personId: 'recognized_a' })).records;
  const unknown = (await f.coordinator.repository.getContext({ personId: null })).records;
  assert.equal(known.some(record => record.sourceEventId === 'actual-A' && record.speakerId === 'recognized_a'), true);
  assert.equal(known.some(record => record.sourceEventId === 'actual-B'), false); assert.equal(unknown.some(record => record.sourceEventId === 'actual-B' && record.personId === null), true);
  assert.equal(f.modelCalls, 0); assert.deepEqual(f.agents.get(A).restrictions[0], { allow: [] });
});

test('unknown or failed platform output stays a draft in hot state and does not acknowledge incoming originals', async t => {
  for (const deliveryStatus of ['unknown', 'failed']) await t.test(deliveryStatus, async st => {
    const f = await fixture(st); await f.register(); let observed;
    f.coordinator.externalDelivery = { output: async value => { observed = value; return { status: deliveryStatus }; } };
    await f.enter(A, user('incoming-' + deliveryStatus, 'Incoming participant original'), 1);
    await f.assistant(A, 'draft-' + deliveryStatus, 1, 'Generated but not confirmed ' + deliveryStatus);
    const records = (await f.coordinator.repository.getContext({ personId: null })).records;
    assert.equal(records.some(record => record.role === 'assistant'), false);
    assert.equal((await f.coordinator.repository.getPending()).some(record => record.sourceEventId === 'incoming-' + deliveryStatus), true);
    const hot = await f.coordinator.repository.store.readLines('staging/hot.jsonl');
    const draft = hot.find(record => record.sourceRef?.sourceEventId === 'draft-' + deliveryStatus);
    assert.equal(draft.kind, 'plugin_state'); assert.equal(draft.origin, 'system');
    assert.equal(JSON.parse(draft.content.text).state, 'generated_not_confirmed_on_platform'); assert.equal(JSON.parse(draft.content.text).deliveryStatus, deliveryStatus);
    assert.equal(observed.sessionId, A); assert.equal(observed.sourceEventId, 'draft-' + deliveryStatus); assert.equal(f.modelCalls, 0);
  });
});

test('a thrown platform error cannot promote generated text to a delivered assistant memory', async t => {
  const f = await fixture(t); await f.register(); f.coordinator.externalDelivery = { output: async () => { throw Object.assign(new Error('test transport failure'), { code: 'EPIPE' }); } };
  await f.enter(A, user('in-error', 'Actual incoming original'), 1); await f.assistant(A, 'draft-error', 1, 'Output with an unknown send outcome');
  assert.equal((await f.coordinator.repository.getContext({ personId: null })).records.some(record => record.role === 'assistant'), false);
  assert.equal((await f.coordinator.repository.getPending()).some(record => record.sourceEventId === 'in-error'), true);
  assert.equal(f.coordinator.errors.some(item => item.code === 'EPIPE'), true);
});

test('confirmed platform delivery alone records the assistant and clears only that turn admitted inputs', async t => {
  const f = await fixture(t); await f.register();
  f.coordinator.externalDelivery = { output: async args => ({ status: 'delivered', receiptId: 'platform-message-99', textHash: createHash('sha256').update(args.text).digest('hex') }) };
  await f.enter(A, user('in-admitted', 'Admitted A original'), 1);
  f.agents.get(A).handlers.get('agent/inbox/inserted')({ message: user('in-late-A', 'Late original from A') });
  f.agents.get(B).handlers.get('agent/inbox/inserted')({ message: user('in-pending-B', 'Unanswered original from B', 'B') }); await f.coordinator.readyState();
  await f.assistant(A, 'delivered-A', 1, 'Actually acknowledged by the platform');
  const records = (await f.coordinator.repository.getContext({ personId: null })).records;
  const delivered = records.find(record => record.sourceEventId === 'delivered-A');
  assert.equal(delivered.role, 'assistant'); assert.equal(delivered.speakerId, null); assert.equal(delivered.origin, 'ai_reply');
  assert.deepEqual((await f.coordinator.repository.getPending()).map(record => record.sourceEventId).sort(), ['in-late-A', 'in-pending-B']);
});

test('external reconciliation cannot use retained native DSH text as a platform receipt without a sink', async t => {
  const f = await fixture(t); await f.register();
  f.events.set(A, [{ type: 'turn/start', seq: 1, data: { turn: 7 } }, { type: 'user/message', seq: 2, data: { id: 'delivery-1', source: { kind: 'persona-memory:delivery', deliveryId: 'delivery-1' } } },
    { type: 'assistant/message', seq: 3, time: 12345, data: { turn: 7, message: { id: 'generated-internal', content: [{ type: 'text', text: 'This native text has no platform acknowledgment' }] } } }]);
  const reads = f.queryReads, receipt = await f.coordinator.runtime.host.reconcileDelivery({ deliveryId: 'delivery-1', target: { channelId: 'dsh:' + A, sessionId: A, personId: null } });
  assert.equal(receipt.status, 'unknown'); assert.equal(receipt.text, undefined); assert.equal(f.queryReads, reads);
  assert.equal((await f.coordinator.repository.getContext({ personId: null })).records.some(record => record.role === 'assistant'), false);
});

test('a real platform receipt permits reconciliation of the retained native original, with stable source provenance', async t => {
  const f = await fixture(t); await f.register();
  f.events.set(A, [{ type: 'turn/start', seq: 1, data: { turn: 8 } }, { type: 'user/message', seq: 2, data: { id: 'delivery-2', source: { kind: 'persona-memory:delivery', deliveryId: 'delivery-2' } } },
    { type: 'assistant/message', seq: 3, time: 23456, data: { turn: 8, message: { id: 'platform-backed-original', content: [{ type: 'text', text: 'The retained native reply body' }] } } }]);
  f.coordinator.externalDelivery = { reconcile: async () => ({ status: 'delivered', receiptId: 'real-platform-message-2', sourceEventId: 'platform-backed-original', sourceSeq: 3, deliveredAt: 23456, textHash: createHash('sha256').update('The retained native reply body').digest('hex') }) };
  const receipt = await f.coordinator.runtime.host.reconcileDelivery({ deliveryId: 'delivery-2', target: { channelId: 'dsh:' + A, sessionId: A, personId: null } });
  assert.equal(receipt.status, 'delivered'); assert.equal(receipt.receiptId, 'real-platform-message-2'); assert.equal(receipt.text, 'The retained native reply body');
  assert.equal(receipt.sourceSessionId, A); assert.equal(receipt.sourceEventId, 'platform-backed-original'); assert.equal(receipt.deliveredAt, 23456);
});

test('external room/account/sender facts survive coordinator reload without implicit identities or model calls', async t => {
  const f = await fixture(t); await f.register();
  const stored = await f.coordinator.repository.store.readJson('host-channels.json'); assert.deepEqual(stored.sessions[A], facts('A')); assert.deepEqual(stored.sessions[B], facts('B'));
  await f.reload(); assert.deepEqual(f.coordinator.contextFor(f.agents.get(A).agent).environment.externalChannel, facts('A'));
  assert.deepEqual(f.coordinator.contextFor(f.agents.get(B).agent).environment.externalChannel, facts('B')); assert.equal(f.coordinator.contextFor(f.agents.get(A).agent).personId, null);
  assert.equal(f.modelCalls, 0); assert.equal(f.agents.get(A).restrictions.length, 2);
});

test('manual DSH input or mismatched sender metadata in a social session is not an external participant original', async t => {
  const f = await fixture(t); await f.register();
  const manual = { id: 'manual-dsh-input', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Typed into the DSH UI, not received from QQ' }] };
  await f.enter(A, manual, 1);
  await f.enter(A, user('wrong-sender', 'This metadata belongs to sender B', 'B'), 2);
  await f.enter(A, user('missing-platform-id', 'No stable platform message ID', 'A', { platformMessageId: '' }), 3);
  const records = (await f.coordinator.repository.getContext({ personId: null })).records;
  assert.equal(records.some(record => ['manual-dsh-input', 'wrong-sender', 'missing-platform-id'].includes(record.sourceEventId)), false);
  assert.equal((await f.coordinator.repository.getPending()).length, 0);
  const hot = await f.coordinator.repository.store.readLines('staging/hot.jsonl');
  for (const id of ['manual-dsh-input', 'wrong-sender', 'missing-platform-id']) {
    const technical = hot.find(record => record.sourceRef?.sourceEventId === id);
    assert.equal(technical.kind, 'plugin_state'); assert.equal(technical.origin, 'system'); assert.equal(technical.speakerId, null);
  }
  assert.equal(f.coordinator.contextFor(f.agents.get(A).agent).personId, null); assert.equal(f.modelCalls, 0);
});

test('a real platform timestamp remains source time while incomplete media facts do not invent participant words', async t => {
  const f = await fixture(t); await f.register();
  const sourceAt = Date.now() - 3600000, observedBefore = Date.now();
  await f.enter(A, user('actual-partial', 'Only the text that actually arrived', 'A', { platformSourceAt: sourceAt, textComplete: false, unsupportedSegments: ['record', 'image'] }), 1);
  const original = (await f.coordinator.repository.getContext({ personId: null })).records.find(record => record.sourceEventId === 'actual-partial');
  assert.equal(original.text, 'Only the text that actually arrived'); assert.equal(original.sourceAt, sourceAt); assert.ok(original.observedAt >= observedBefore);
  assert.equal(original.role, 'user'); assert.equal(original.personId, null); assert.equal(original.speakerId, null);
  const environment = f.coordinator.contextFor(f.agents.get(A).agent).environment;
  assert.equal(environment.externalInput.textComplete, false); assert.deepEqual(environment.externalInput.unsupportedSegments, ['record', 'image']);
  assert.equal(f.modelCalls, 0);
});

test('detaching a social agent disables old tools while a fresh same-session scope retains memory and personality routes', async t => {
  const f = await fixture(t); await f.register(); const old = f.agents.get(A);
  await f.enter(A, user('before-channel-stop', 'A real original retained across channel stop/start'), 1);
  await old.tools.get('persona_decide').execute({ identityPlan: { action: 'new', personId: 'recognized_before_stop' } }, { agent: old.agent, callId: 'recognize-before-stop' });
  const staleTool = old.tools.get('persona_decide'), oldState = f.coordinator.agents.get(A);
  oldState.toolResults.set('retained-result-fixture', { value: { text: 'ephemeral lookup data' }, bytes: 24 });
  assert.equal(await f.coordinator.detachAgent(A, old.agent), true);
  assert.equal(oldState.disposed, true); assert.equal(oldState.toolResults.size, 0); assert.equal(oldState.processDependenciesByTurn.size, 0);
  assert.equal(old.tools.size, 0); assert.equal(old.handlers.size, 0); assert.equal(f.coordinator.hasRegisteredSession(A), true);
  const rejected = await staleTool.execute({ identityPlan: { action: 'new', personId: 'must_not_be_created' } }, { agent: old.agent, callId: 'stale-after-stop' });
  assert.equal(rejected.code, 'INSTANCE_UNLOADED'); assert.equal((await f.coordinator.repository.listPeople()).some(person => person.personId === 'must_not_be_created'), false);
  const fresh = replacementOf(old); f.agents.set(A, fresh); await f.coordinator.attachAgent(fresh.agent); await f.coordinator.attachAgent(fresh.agent);
  assert.equal(fresh.tools.size, 8); assert.equal(fresh.registrations.length, 8); assert.equal(new Set(fresh.registrations).size, 8);
  assert.equal(f.coordinator.contextFor(fresh.agent).personId, 'recognized_before_stop');
  assert.equal((await f.coordinator.repository.getContext({ personId: 'recognized_before_stop' })).records.some(record => record.sourceEventId === 'before-channel-stop'), true);
  assert.equal(f.modelCalls, 0);
});

test('a stale expectedAgent reference cannot detach the newer same-ID agent installed by attachAgent', async t => {
  const f = await fixture(t); await f.register(); const old = f.agents.get(A), staleTool = old.tools.get('persona_decide');
  const fresh = replacementOf(old); f.agents.set(A, fresh); await f.coordinator.attachAgent(fresh.agent);
  assert.equal(old.tools.size, 0); assert.equal(old.handlers.size, 0); assert.equal(fresh.tools.size, 8);
  assert.equal(await f.coordinator.detachAgent(A, old.agent), false); assert.equal(f.coordinator.agents.get(A).agent, fresh.agent); assert.equal(fresh.tools.size, 8);
  assert.equal((await staleTool.execute({ identityPlan: { action: 'unknown' } }, { agent: fresh.agent })).code, 'INSTANCE_UNLOADED');
  await fresh.tools.get('persona_decide').execute({ identityPlan: { action: 'new', personId: 'recognized_after_replacement' } }, { agent: fresh.agent, callId: 'new-scope-still-works' });
  assert.equal(f.coordinator.contextFor(fresh.agent).personId, 'recognized_after_replacement'); assert.equal(fresh.registrations.length, 8); assert.equal(f.modelCalls, 0);
});
