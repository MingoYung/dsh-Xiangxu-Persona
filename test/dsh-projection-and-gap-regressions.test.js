import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshCoordinator } from '../adapters/dsh/index.js';
import { mountCompanionScope } from '../adapters/dsh/companion-scope.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xiangxu-projection-replay-'));
  const handlers = new Map(), scoped = new Map(), agents = new Map(), events = [], cleanups = [];
  const query = { readSession: async () => ({ events }) };
  const ctx = { agents: { get: id => agents.get(id), list: () => [] }, llm: {},
    get: key => key === 'sessionQuery' ? query : key === 'agentPresets' ? { composedPreset: () => 'persona-memory' } : undefined,
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); }, effect: run => cleanups.push(run()) };
  const coordinator = createDshCoordinator(ctx, { memoryRoot: root, operatorControl: false });
  await coordinator.ready;
  mountCompanionScope(ctx, { getCoordinator: () => coordinator, attachAgent: agent => coordinator.attachAgent(agent) });
  for (const id of ['projection-first', 'projection-second']) {
    const local = new Map(), agent = { id, session: { id, header: { agentPreset: 'persona-memory' }, deriveMessages: () => [] },
      inbox: { nextTurn: [], nextStep: [] }, followup() {}, ctx: {
        on(name, handler) { local.set(name, handler); return () => local.delete(name); },
        tools: { restrict: () => () => {}, register: () => () => {}, wireSchemas: () => ({ schemas: [] }) },
      } };
    agents.set(id, agent); scoped.set(id, local); await handlers.get('agent/created')({ agent });
  }
  t.after(async () => { for (const cleanup of cleanups) await cleanup?.(); await coordinator.close(); await rm(root, { recursive: true, force: true }); });
  const assemble = async (id, signal) => {
    const agent = agents.get(id), context = { agent, scope: agent.ctx, signal }, value = { sections: [], tools: [] };
    return handlers.get('system-prompt/assemble')(value, context,
      () => scoped.get(id).get('system-prompt/assemble')(value, context, async () => value));
  };
  return { coordinator, handlers, scoped, agents, events, assemble };
}

test('the outer companion assembly retains the exact request signal for its final refreshed projection', async t => {
  const f = await fixture(t), compose = f.coordinator.runtime.compose.bind(f.coordinator.runtime);
  let revision = 0;
  f.coordinator.runtime.compose = async (...args) => {
    const snapshot = await compose(...args);
    return { ...snapshot, injectedText: snapshot.injectedText + '\nFIXTURE_ASSEMBLY_REVISION_' + ++revision };
  };
  const firstSignal = new AbortController().signal, secondSignal = new AbortController().signal, otherSignal = new AbortController().signal;
  const first = await f.assemble('projection-first', firstSignal), second = await f.assemble('projection-first', secondSignal), other = await f.assemble('projection-second', otherSignal);
  assert.equal(revision, 6, 'the real two-layer waterfall refreshes twice per assembly');
  const request = (id, signal, assembly) => ({ sessionId: id, signal, messages: [{ role: 'system', content: assembly.sections.map(row => row.text).join('\n') }] });
  const guard = f.handlers.get('llm/stream'); let calls = 0;
  assert.equal(guard(request('projection-first', firstSignal, first), () => ++calls), 1);
  assert.equal(guard(request('projection-first', secondSignal, second), () => ++calls), 2);
  assert.equal(guard(request('projection-second', otherSignal, other), () => ++calls), 3);
  assert.throws(() => guard(request('projection-first', secondSignal, first), () => ++calls), { code: 'PERSONA_CONTEXT_UNAVAILABLE', projectionFailure: 'live_missing' });
  assert.throws(() => guard(request('projection-first', new AbortController().signal, second), () => ++calls), { code: 'PERSONA_CONTEXT_UNAVAILABLE', projectionFailure: 'projection_lookup_missing' });
  assert.equal(calls, 3);
});

test('only the host compaction purpose can reuse a historical prefix without the native reply projection', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  const assembly = await f.assemble('projection-first', signal);
  const guard = f.handlers.get('llm/stream'); let calls = 0;
  const historical = { sessionId: 'projection-first', signal,
    messages: [{ role: 'system', content: 'Historical system prefix retained by the host compactor' }] };
  const next = () => ++calls;
  assert.equal(guard({ ...historical, purpose: 'compaction' }, next), 1);
  // Manual compaction has its own cancellation signal and no prompt assembly.
  assert.equal(guard({ ...historical, signal: new AbortController().signal, purpose: 'compaction' }, next), 2);
  assert.throws(() => guard(historical, next), { code: 'PERSONA_CONTEXT_UNAVAILABLE', projectionFailure: 'protocol_missing' });
  for (const purpose of ['native_turn', 'reply', 'consolidation', 'Compaction', '', null]) {
    assert.throws(() => guard({ ...historical, purpose }, next), { code: 'PERSONA_CONTEXT_UNAVAILABLE', projectionFailure: 'protocol_missing' });
  }
  assert.throws(() => guard({ ...historical, signal: new AbortController().signal }, next),
    { code: 'PERSONA_CONTEXT_UNAVAILABLE', projectionFailure: 'projection_lookup_missing' });
  assert.equal(guard({ sessionId: 'projection-first', signal,
    messages: [{ role: 'system', content: assembly.sections.map(row => row.text).join('\n') }] }, next), 3);
  assert.equal(calls, 3, 'failed native and unknown purposes never reach the provider');
});

test('a fully recovered native tool-result event resolves its prior memory gap by stable event cursor', async t => {
  const f = await fixture(t), agent = f.agents.get('projection-first'), repository = f.coordinator.repository;
  const event = { type: 'tool/result', seq: 7, time: Date.now(), data: { turn: 1, message: { id: 'native-tool-envelope-id', role: 'tool', source: { kind: 'tool' }, content: [{ type: 'text', text: '{"status":"fixture-ok"}' }] } } };
  f.events.push(event);
  const capture = repository.captureHot.bind(repository);
  repository.captureHot = input => capture({ ...input, dependencyScanComplete: false });
  await f.coordinator.observeEvent(agent.session, event);
  assert.equal((await repository.getRuntime()).memoryGaps.filter(row => row.resolvedAt == null).length, 1);
  repository.captureHot = capture;
  const replay = await f.coordinator.replaySources(agent);
  assert.equal(replay.blockedFromSeq, null);
  const gaps = (await repository.getRuntime()).memoryGaps;
  assert.equal(gaps.length, 1); assert.ok(gaps[0].resolvedAt != null); assert.equal(gaps[0].resolvedSourceCursor, '7');
  const hot = await repository.store.readLines('staging/hot.jsonl');
  assert.ok(hot.some(row => row.sourceRef.sourceEventId === '7' && row.kind === 'tool_result'));
});

test('a tool-result replay that is still incomplete cannot clear a memory gap or advance its blocked cursor', async t => {
  const f = await fixture(t), agent = f.agents.get('projection-first'), repository = f.coordinator.repository;
  const event = { type: 'tool/result', seq: 8, time: Date.now(), data: { turn: 1, message: { id: 'still-incomplete-tool', role: 'tool', source: { kind: 'tool' }, content: [{ type: 'text', text: 'fixture body' }] } } };
  f.events.push(event);
  const capture = repository.captureHot.bind(repository);
  repository.captureHot = input => capture({ ...input, dependencyScanComplete: false });
  await f.coordinator.observeEvent(agent.session, event);
  const replay = await f.coordinator.replaySources(agent);
  assert.equal(replay.blockedFromSeq, 8);
  const gaps = (await repository.getRuntime()).memoryGaps;
  assert.ok(gaps.length > 0); assert.ok(gaps.every(row => row.resolvedAt == null));
});

test('an unsupported event or an uncaptured tool result cannot resolve a gap solely because its cursor matches', async t => {
  const f = await fixture(t), agent = f.agents.get('projection-first'), repository = f.coordinator.repository;
  await repository.captureHot({ sourceSessionId: agent.session.id, sourceEventId: '9', sourceCursor: 9,
    kind: 'tool_result', sourceKind: 'tool/result', content: { mode: 'cached', text: 'fixture unavailable process', chars: 27 },
    dependencyScanComplete: false, hostAvailable: true });
  await f.coordinator.observeEvent(agent.session, { type: 'unsupported-fixture-event', seq: 9, data: {} });
  assert.ok((await repository.getRuntime()).memoryGaps.every(row => row.resolvedAt == null));
  const capture = repository.captureHot;
  repository.captureHot = async () => ({ duplicate: true, revoked: true, record: null, eventId: null });
  try {
    await f.coordinator.observeEvent(agent.session, { type: 'tool/result', seq: 9, data: { turn: 1, message: {
      id: 'uncaptured-tool', role: 'tool', source: { kind: 'tool' }, content: [{ type: 'text', text: 'fixture body' }] } } });
    assert.ok((await repository.getRuntime()).memoryGaps.every(row => row.resolvedAt == null));
  } finally { repository.captureHot = capture; }
});
