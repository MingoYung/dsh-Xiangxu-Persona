import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRepository, PersonaRuntime } from '../core/index.js';

const environment = personId => ({ sessionId: `session_${personId}`, channelId: `channel_${personId}`, timezone: 'UTC' });
const context = personId => ({ ...environment(personId), environment: environment(personId), personId, executeReply: false });
const sourceRef = source => ({ sourceSessionId: source.record.sourceSessionId, sourceEventId: source.record.sourceEventId, available: true });
const chat = personId => ({ sourceSessionId: `session_${personId}`, sourceEventId: `source_${personId}`, sourceKind: 'user', contentClass: 'participant_dialogue',
  role: 'user', origin: 'user', channelId: `channel_${personId}`, personId, text: `Actual original from ${personId}` });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'persona-identity-scope-')), identities = [], decisions = [];
  const repository = new MemoryRepository({ root });
  const runtime = new PersonaRuntime({ repository, autoSchedule: false,
    model: { complete: async () => { throw new Error('Identity scope unit checks must not call a model'); } },
    host: { onIdentity: (identity, selected) => { identities.push({ identity: structuredClone(identity), context: structuredClone(selected) }); },
      onDecision: (decision, selected) => { decisions.push({ decision, context: structuredClone(selected) }); } } });
  await runtime.open(); for (const personId of ['a', 'b', 'c']) await repository.upsertPerson({ personId });
  t.after(async () => { if (runtime.opened) await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { repository, runtime, identities, decisions,
    accept: personId => runtime.accept(chat(personId), environment(personId)),
    ingest: personId => repository.ingest(chat(personId)) };
}
async function sourceIds(repository, personId) { return (await repository.getContext({ personId })).records.map(record => record.sourceEventId).sort(); }

test('explicit B-only identity sources assign B and scope its route without changing current A identity or last context', async t => {
  const f = await fixture(t), a = await f.accept('a'), b = await f.accept('b');
  await f.runtime.decide({ identityPlan: { action: 'new', personId: 'recognized_b', sourceRefs: [sourceRef(b)] } },
    { ...context('a'), srcRefs: [sourceRef(a), sourceRef(b)] });
  assert.deepEqual(await sourceIds(f.repository, 'a'), ['source_a']); assert.deepEqual(await sourceIds(f.repository, 'recognized_b'), ['source_b']);
  const selected = f.identities[0].context;
  assert.deepEqual(selected.identityRefs, [sourceRef(b)]); assert.deepEqual(selected.identitySourceSessionIds, ['session_b']);
  assert.equal(selected.identityAffectsCurrent, false); assert.equal(f.decisions[0].context.personId, 'a');
  const last = (await f.repository.getRuntime()).execution.lastContext; assert.equal(last.sessionId, 'session_a'); assert.equal(last.personId, 'a');
});

test('an explicit A+B selection can recognize one person across both sessions without a proof or source-count gate', async t => {
  const f = await fixture(t), a = await f.accept('a'), b = await f.accept('b');
  await f.runtime.decide({ identityPlan: { action: 'new', personId: 'one_subject', sourceRefs: [sourceRef(a), sourceRef(b)] } }, context('a'));
  assert.deepEqual(await sourceIds(f.repository, 'one_subject'), ['source_a', 'source_b']);
  assert.deepEqual(f.identities[0].context.identitySourceSessionIds, ['session_a', 'session_b']);
  assert.equal(f.identities[0].context.identityAffectsCurrent, true); assert.equal(f.decisions[0].context.personId, 'one_subject');
});

test('omitted refs select only the current source group from a multi-session visible page', async t => {
  const f = await fixture(t), a = await f.accept('a'), b = await f.accept('b');
  await f.runtime.decide({ identityPlan: { action: 'new', personId: 'recognized_a' } }, { ...context('a'), srcRefs: [sourceRef(a), sourceRef(b)] });
  assert.deepEqual(await sourceIds(f.repository, 'recognized_a'), ['source_a']); assert.deepEqual(await sourceIds(f.repository, 'b'), ['source_b']);
  assert.deepEqual(f.identities[0].context.identityRefs, [sourceRef(a)]); assert.deepEqual(f.identities[0].context.identitySourceSessionIds, ['session_a']);
});

test('current A with only B+C visible can recognize its environment without implicitly assigning either other group', async t => {
  const f = await fixture(t), b = await f.accept('b'), c = await f.accept('c');
  await f.runtime.decide({ identityPlan: { action: 'new', personId: 'environment_a' } }, { ...context('a'), srcRefs: [sourceRef(b), sourceRef(c)] });
  assert.deepEqual(await sourceIds(f.repository, 'b'), ['source_b']); assert.deepEqual(await sourceIds(f.repository, 'c'), ['source_c']);
  assert.deepEqual(await sourceIds(f.repository, 'environment_a'), []);
  assert.deepEqual(f.identities[0].context.identityRefs, []); assert.deepEqual(f.identities[0].context.identitySourceSessionIds, ['session_a']);
  assert.equal(f.decisions[0].context.personId, 'environment_a');
});

test('explicit empty refs still permit subjective current-environment recognition and never reassign visible roots', async t => {
  const f = await fixture(t), a = await f.accept('a'), b = await f.accept('b');
  await f.runtime.decide({ identityPlan: { action: 'new', personId: 'no_history_assignment', sourceRefs: [] } },
    { ...context('a'), srcRefs: [sourceRef(a), sourceRef(b)] });
  assert.deepEqual(await sourceIds(f.repository, 'a'), ['source_a']); assert.deepEqual(await sourceIds(f.repository, 'b'), ['source_b']);
  assert.deepEqual(await sourceIds(f.repository, 'no_history_assignment'), []);
  assert.deepEqual(f.identities[0].context.identityRefs, []); assert.equal(f.identities[0].context.identityAffectsCurrent, true);
  assert.deepEqual(f.identities[0].context.identitySourceSessionIds, ['session_a']);
});

test('a truly sessionless portable context may explicitly operate on its whole actually visible source set by default', async t => {
  const f = await fixture(t), b = await f.ingest('b'), c = await f.ingest('c');
  await f.runtime.decide({ identityPlan: { action: 'new', personId: 'sessionless_subject' } },
    { srcRefs: [sourceRef(b), sourceRef(c)], personId: null, executeReply: false });
  assert.deepEqual(await sourceIds(f.repository, 'sessionless_subject'), ['source_b', 'source_c']);
  assert.deepEqual(f.identities[0].context.identitySourceSessionIds, ['session_b', 'session_c']);
  assert.equal(f.identities[0].context.identityAffectsCurrent, false); assert.equal(f.decisions[0].context.personId, null);
});

test('identity completion for A does not overwrite a later accepted C lastContext while the assignment was in flight', async t => {
  const f = await fixture(t), a = await f.accept('a'), entered = deferred(), finish = deferred();
  const assign = f.repository.assign.bind(f.repository);
  f.repository.assign = async value => { const assigned = await assign(value); entered.resolve(); await finish.promise; return assigned; };
  const work = f.runtime.decide({ identityPlan: { action: 'new', personId: 'recognized_a', sourceRefs: [sourceRef(a)] } }, context('a'));
  await entered.promise; await f.accept('c'); finish.resolve(); await work;
  const last = (await f.repository.getRuntime()).execution.lastContext;
  assert.equal(last.sessionId, 'session_c'); assert.equal(last.personId, 'c'); assert.equal(f.decisions[0].context.personId, 'recognized_a');
});

test('a legacy pending identity effect fixes its omitted-ref scope before recovering any assignment', async t => {
  const f = await fixture(t), a = await f.accept('a'), b = await f.accept('b');
  const plan = { action: 'new', personId: 'legacy_scoped' }, ctx = { ...context('a'), srcRefs: [sourceRef(a), sourceRef(b)] };
  const decision = { schemaVersion: 'persona-memory/3', decisionId: 'legacy_scope_decision', decidedAt: 100, identityPlan: plan };
  const state = await f.repository.getRuntime(); state.currentDecision = decision;
  state.execution.pendingEffects = { [decision.decisionId]: { operationId: 'legacy_scope_operation', decision, input: { identityPlan: plan },
    context: ctx, wasSleeping: false, completed: [], values: {} } };
  await f.repository.saveRuntime(state);
  const assign = f.repository.assign.bind(f.repository); let fixedBeforeAssignment = false;
  f.repository.assign = async value => {
    const pending = (await f.repository.getRuntime()).execution.pendingEffects[decision.decisionId];
    assert.deepEqual(pending.context.identityRefs, [sourceRef(a)]); fixedBeforeAssignment = true; return assign(value);
  };
  await f.runtime.close(); await f.runtime.open(); await f.runtime.idle();
  assert.equal(fixedBeforeAssignment, true); assert.deepEqual(await sourceIds(f.repository, 'legacy_scoped'), ['source_a']);
  assert.deepEqual(await sourceIds(f.repository, 'b'), ['source_b']); assert.deepEqual(f.identities[0].context.identitySourceSessionIds, ['session_a']);
});
