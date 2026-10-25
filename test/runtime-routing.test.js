import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRepository, PersonaRuntime } from '../core/index.js';

const env = id => ({ version: 1, sessionId: `session_${id}`, channelId: `channel_${id}`, timezone: 'UTC', placeDescription: `Real environment ${id}` });
const target = id => ({ personId: id, sessionId: `session_${id}`, channelId: `channel_${id}` });
const chat = (id, who = 'a') => ({ sourceSessionId: `session_${who}`, sourceEventId: id, sourceKind: 'user', contentClass: 'participant_dialogue',
  channelId: `channel_${who}`, personId: who, role: 'user', origin: 'user', text: `Original ${id} by ${who}`, sourceAt: 100, observedAt: 100 });
async function fixture(t, { model = {}, host = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'persona-runtime-route-'));
  let now = 1000; const clock = { now: () => now, set: value => { now = value; } };
  const repository = new MemoryRepository({ root, clock });
  const requests = [], deliveries = [], described = [];
  const runtime = new PersonaRuntime({ repository, clock, autoSchedule: false,
    model: { countTokens: text => Array.from(text).length, complete: async request => {
      requests.push(request); return request.purpose === 'reply' ? { text: 'Actual reply selected for the destination.' } : { patch: [] };
    }, ...model },
    host: { describeTarget: async selected => { described.push(selected); return env(selected.personId); },
      deliver: async record => { deliveries.push(record); return { status: 'delivered', sourceSessionId: record.target.sessionId,
        sourceEventId: `actual_${record.deliveryId}`, sourceKind: 'model', text: record.text, deliveredAt: now }; }, ...host } });
  await runtime.open(); await repository.upsertPerson({ personId: 'a' }); await repository.upsertPerson({ personId: 'b' });
  t.after(async () => { if (runtime.opened) await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { root, repository, runtime, clock, requests, deliveries, described };
}
async function persistLegacyIdentityEffect(f, plan, operationId) {
  const decision = { schemaVersion: 'persona-memory/3', decisionId: `decision_${operationId}`, decidedAt: f.clock.now(),
    identityPlan: plan, srcRefs: plan.sourceRefs ?? [] };
  const context = { personId: 'a', sessionId: 'session_a', channelId: 'channel_a', environment: env('a'), executeReply: false,
    controlId: 'selected_control', srcRefs: plan.sourceRefs ?? [], decisionId: decision.decisionId };
  const state = await f.repository.getRuntime(); state.currentDecision = decision;
  state.execution = { ...state.execution, pendingControl: { controlId: context.controlId, reason: 'recheck_due', context },
    pendingEffects: { [decision.decisionId]: { operationId, decision, input: { identityPlan: plan }, context,
      wasSleeping: false, completed: [], values: {} } } };
  await f.repository.saveRuntime(state);
}

test('a cross-person reply composes the chosen destination environment while preserving admitted source records and their delivery acknowledgement', async t => {
  const f = await fixture(t);
  const source = await f.runtime.accept(chat('source_a'), env('a'));
  const destinationInput = await f.runtime.accept(chat('unrelated_b', 'b'), env('b'));
  await f.runtime.decide({ replyPlan: { action: 'reply', target: target('b'), replyAt: null, pendingEventIds: [], reason: 'I choose this destination.' } },
    { ...env('a'), environment: env('a'), personId: 'a', executeReply: true, pending: [source.record], pendingEventIds: [source.eventId],
      srcRefs: [{ sourceSessionId: 'session_a', sourceEventId: 'source_a', available: true }] });
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].purpose, 'reply');
  const request = f.requests[0], body = JSON.parse(request.messages.at(-1).content);
  assert.equal(request.context.personId, 'b'); assert.equal(request.context.sessionId, 'session_b'); assert.equal(request.context.channelId, 'channel_b');
  assert.equal(body.environment.placeDescription, 'Real environment b'); assert.deepEqual(body.target, target('b'));
  assert.deepEqual(body.pending.map(row => ({ personId: row.personId, sourceEventId: row.sourceEventId, text: row.text })),
    [{ personId: 'a', sourceEventId: 'source_a', text: source.record.text }]);
  assert.equal(request.context.eventContext.personId, 'a'); assert.equal(request.context.eventContext.sessionId, 'session_a');
  assert.deepEqual(f.deliveries[0].target, target('b')); assert.deepEqual(f.deliveries[0].pendingEventIds, [source.eventId]);
  assert.deepEqual((await f.repository.getPending()).map(row => row.eventId), [destinationInput.eventId]);
  const spoken = (await f.repository.getContext({ personId: 'b' })).records.filter(row => row.role === 'assistant');
  assert.equal(spoken.length, 1); assert.equal(spoken[0].sourceSessionId, 'session_b');
  assert.equal((await f.repository.getContext({ personId: 'a' })).records.filter(row => row.role === 'assistant').length, 0);
});

test('interrupted cross-target effects persist source IDs instead of another transcript and recover the same actual source after restart', async t => {
  const f = await fixture(t), source = await f.runtime.accept(chat('restart_source'), env('a'));
  await f.runtime.accept(chat('do_not_substitute_b', 'b'), env('b'));
  const patch = f.repository.patchRuntime.bind(f.repository); let once = true;
  f.repository.patchRuntime = async (base, next) => {
    const stored = await patch(base, next);
    if (once && Object.keys(stored.execution?.pendingEffects ?? {}).length) { once = false; throw new Error('interrupted after source-ID journal commit'); }
    return stored;
  };
  await assert.rejects(f.runtime.decide({ replyPlan: { action: 'reply', target: target('b'), replyAt: null, pendingEventIds: [], reason: 'Cross target.' } },
    { personId: 'a', sessionId: 'session_a', channelId: 'channel_a', environment: env('a'), executeReply: true, pending: [source.record], operationId: 'stable_cross' }), /source-ID journal/);
  const effect = Object.values((await f.repository.getRuntime()).execution.pendingEffects)[0];
  assert.deepEqual(effect.context.pendingEventIds, [source.eventId]); assert.ok(!JSON.stringify(effect).includes(source.record.text));
  assert.equal(f.requests.length, 0); assert.equal(f.deliveries.length, 0);
  // Actual wake admission can finish its pending receipt before the redirected
  // effect resumes. The retained C1 source remains available without replaying it.
  await f.repository.clearPending([source.eventId]);
  f.repository.patchRuntime = patch; await f.runtime.close(); await f.runtime.open(); await f.runtime.idle();
  assert.equal(f.requests.length, 1); assert.equal(f.deliveries.length, 1);
  assert.deepEqual(JSON.parse(f.requests[0].messages.at(-1).content).pending.map(row => row.sourceEventId), ['restart_source']);
  assert.deepEqual(f.deliveries[0].target, target('b'));
  assert.deepEqual((await f.repository.getPending()).map(row => row.sourceEventId), ['do_not_substitute_b']);
});

test('a chosen reply timer restores its real target after later input changes lastContext and keeps that later source separate', async t => {
  const queued = [], f = await fixture(t, { host: { requestDecision: context => { queued.push(context); return { queued: true }; } } });
  await f.runtime.accept(chat('waiting_a'), env('a'));
  await f.runtime.decide({ replyPlan: { action: 'wait', target: target('a'), replyAt: 2000, pendingEventIds: [], reason: 'Reconsider A at my chosen time.' } },
    { personId: 'a', sessionId: 'session_a', channelId: 'channel_a', environment: env('a'), executeReply: false });
  await f.runtime.accept(chat('later_b', 'b'), env('b')); assert.equal((await f.repository.getRuntime()).execution.lastContext.personId, 'b');
  f.clock.set(2000); await f.runtime.handleDue();
  assert.equal(queued.length, 1); assert.equal(queued[0].reason, 'reply_due');
  assert.equal(queued[0].personId, 'a'); assert.equal(queued[0].sessionId, 'session_a'); assert.deepEqual(queued[0].target, target('a'));
  assert.equal(queued[0].environment.placeDescription, 'Real environment a');
  assert.equal(queued[0].eventContext.personId, 'b');
  assert.deepEqual(queued[0].pending.map(row => row.sourceEventId), ['waiting_a']); assert.equal(f.deliveries.length, 0);
});

test('an explicitly supplied due target takes precedence and an actual new message keeps its own source context', async t => {
  const queued = [], f = await fixture(t, { host: { requestDecision: context => { queued.push(context); return { queued: true }; } } });
  await f.runtime.decide({ nextCheckAt: 2000, replyPlan: { action: 'listen', target: target('a'), replyAt: null, pendingEventIds: [], recheckOn: ['new_message'], reason: 'My chosen plan.' } },
    { personId: 'a', sessionId: 'session_a', channelId: 'channel_a', environment: env('a'), executeReply: false });
  await f.runtime.accept(chat('source_b', 'b'), env('b'));
  f.clock.set(2000); await f.runtime.handleDue({ target: target('b') });
  assert.equal(queued[0].personId, 'b'); assert.deepEqual(queued[0].target, target('b'));
  await f.runtime.handleSignal('new_message', { personId: 'b', sessionId: 'session_b', channelId: 'channel_b', environment: env('b') });
  assert.equal(queued[1].personId, 'b'); assert.equal(queued[1].sessionId, 'session_b');
  assert.deepEqual(queued[1].pending.map(row => row.sourceEventId), ['source_b']);
});

test('explicit observation channel and person ranges apply to incoming users while actual assistant output is still remembered', async t => {
  const f = await fixture(t);
  await f.runtime.decide({ attention: { observeChannelIds: ['channel_a'], targetPersonIds: ['a'] } }, { executeReply: false });
  assert.equal((await f.runtime.accept(chat('chosen_a'), env('a'))).observed, undefined);
  assert.equal((await f.runtime.accept({ ...chat('other_person', 'b'), channelId: 'channel_a' }, env('a'))).observed, false);
  assert.equal((await f.runtime.accept({ ...chat('other_channel'), channelId: 'channel_b' }, env('b'))).observed, false);
  assert.equal((await f.runtime.accept({ ...chat('unknown'), personId: null }, env('a'))).observed, false);
  await f.runtime.accept({ ...chat('actually_spoken_b', 'b'), sourceKind: 'model', role: 'assistant', origin: 'ai_initiated' }, env('b'));
  assert.deepEqual((await f.repository.getContext({ personId: 'a' })).records.map(row => row.sourceEventId), ['chosen_a']);
  assert.deepEqual((await f.repository.getContext({ personId: 'b' })).records.map(row => row.sourceEventId), ['actually_spoken_b']);
  assert.deepEqual((await f.repository.getPending()).map(row => row.sourceEventId), ['chosen_a']);
  assert.equal(f.requests.length, 0);
});

test('a nonexistent identity source is rejected before creating a person or persisting a decision effect', async t => {
  let notified = 0;
  const f = await fixture(t, { host: { onIdentity: () => { notified++; } } });
  const before = await f.repository.getRuntime(), people = await f.repository.listPeople();
  await assert.rejects(f.runtime.decide({ identityPlan: { action: 'new', displayName: 'An executable decision needs real root IDs',
    sourceRefs: [{ sourceSessionId: 'session_a', sourceEventId: 'invented_root', available: true }] } }, { executeReply: false }), error => error.code === 'SOURCE_UNKNOWN');
  assert.deepEqual(await f.repository.listPeople(), people); assert.deepEqual(await f.repository.getRuntime(), before);
  assert.equal(notified, 0); assert.equal(f.requests.length, 0);
});

test('a historical unknown-source effect becomes explicitly failed without redoing its partial identity and retains the selected control for correction', async t => {
  let notified = 0; const queued = [];
  const f = await fixture(t, { host: { onIdentity: () => { notified++; }, requestDecision: request => { queued.push(request); return { queued: true }; } } });
  const orphan = await f.repository.upsertPerson({ personId: 'historical_orphan', displayName: 'Created before the old assignment failed' });
  await persistLegacyIdentityEffect(f, { action: 'new', personId: orphan.personId, displayName: orphan.displayName,
    sourceRefs: [{ sourceSessionId: 'session_a', sourceEventId: 'old_invented_root', available: true }] }, 'old_bad_identity');
  await f.runtime.close(); await f.runtime.open(); await f.runtime.idle();
  let state = await f.repository.getRuntime();
  assert.deepEqual(Object.keys(state.execution.pendingEffects), []);
  assert.equal(state.execution.effectFailures[0].status, 'failed'); assert.equal(state.execution.effectFailures[0].error.code, 'SOURCE_UNKNOWN');
  assert.equal(state.execution.effectReceipts?.some(receipt => receipt.operationId === 'old_bad_identity') ?? false, false);
  assert.equal(state.execution.pendingControl.controlId, 'selected_control');
  assert.equal((await f.repository.listPeople()).find(person => person.personId === orphan.personId).version, orphan.version);
  assert.equal(notified, 0); assert.equal(f.requests.length, 0);
  await assert.rejects(f.runtime.decide({}, { operationId: 'old_bad_identity', executeReply: false }), error => error.code === 'SOURCE_UNKNOWN' && error.effectStatus === 'failed');
  await f.runtime.close(); await f.runtime.open(); await f.runtime.idle();
  assert.equal(queued.length, 1); assert.equal(queued[0].controlId, 'selected_control');
  assert.equal((await f.repository.listPeople()).find(person => person.personId === orphan.personId).version, orphan.version);
  await f.runtime.decide({ identityPlan: { action: 'new', displayName: 'Corrected autonomous recognition', sourceRefs: [] } },
    { controlId: 'selected_control', operationId: 'corrected_identity', executeReply: false });
  state = await f.repository.getRuntime(); assert.equal(state.execution.pendingControl, undefined); assert.equal(notified, 1);
});

test('a historical effect whose explicit source was revoked fails before reassigning or replaying the identity callback', async t => {
  let notified = 0;
  const f = await fixture(t, { host: { onIdentity: () => { notified++; }, requestDecision: () => ({ queued: true }) } });
  const source = await f.runtime.accept(chat('later_revoked'), env('a'));
  const ref = { sourceSessionId: source.record.sourceSessionId, sourceEventId: source.record.sourceEventId, available: true };
  await f.repository.forget({ targetPersonId: 'a', ids: [source.record.id], reason: 'Explicitly chosen deletion' });
  const people = await f.repository.listPeople();
  await persistLegacyIdentityEffect(f, { action: 'associate', personId: 'b', sourceRefs: [ref] }, 'revoked_identity');
  await f.runtime.close(); await f.runtime.open(); await f.runtime.idle();
  const state = await f.repository.getRuntime();
  assert.equal(state.execution.effectFailures[0].error.code, 'SOURCE_REVOKED'); assert.deepEqual(Object.keys(state.execution.pendingEffects), []);
  assert.deepEqual(await f.repository.listPeople(), people); assert.equal(notified, 0);
  assert.equal((await f.repository.getContext({ personId: 'b' })).records.length, 0);
});

test('a temporary source-preflight I/O failure stays recoverable and a later restart completes the same identity only once', async t => {
  let notified = 0;
  const f = await fixture(t, { host: { onIdentity: () => { notified++; }, requestDecision: () => ({ queued: true }) } });
  const source = await f.runtime.accept(chat('recoverable_source'), env('a'));
  await persistLegacyIdentityEffect(f, { action: 'new', personId: 'retry_person', displayName: 'One retained choice',
    sourceRefs: [{ sourceSessionId: source.record.sourceSessionId, sourceEventId: source.record.sourceEventId, available: true }] }, 'recoverable_identity');
  const validate = f.repository.validateSourceRefs.bind(f.repository); let unavailable = true;
  f.repository.validateSourceRefs = async (...args) => { if (unavailable) throw Object.assign(new Error('Temporary disk read failure'), { code: 'EIO' }); return validate(...args); };
  await f.runtime.close(); await f.runtime.open(); await f.runtime.idle();
  let state = await f.repository.getRuntime();
  assert.equal(Object.keys(state.execution.pendingEffects).length, 1); assert.equal(state.execution.effectFailures, undefined);
  assert.equal((await f.repository.listPeople()).some(person => person.personId === 'retry_person'), false); assert.equal(notified, 0);
  unavailable = false; await f.runtime.close(); await f.runtime.open(); await f.runtime.idle();
  state = await f.repository.getRuntime(); assert.deepEqual(Object.keys(state.execution.pendingEffects), []);
  assert.equal(state.execution.effectReceipts.filter(receipt => receipt.operationId === 'recoverable_identity').length, 1); assert.equal(notified, 1);
  assert.deepEqual((await f.repository.getContext({ personId: 'retry_person' })).records.map(row => row.sourceEventId), ['recoverable_source']);
});

test('a redirected admitted source fragment is reconstructed from its exact slice rather than the next unread tail and cannot clear the whole source', async t => {
  const f = await fixture(t), text = 'Actually admitted start🙂'.repeat(30) + 'UNSEEN_TAIL';
  const source = await f.runtime.accept({ ...chat('fragment_source'), text }, env('a'));
  const fragment = { from: 0, to: 100, total: Array.from(text).length, complete: false };
  await f.runtime.acknowledgePendingPage({ completeEventIds: [], progress: { [source.eventId]: 100 } }, { clearComplete: false });
  const admitted = { ...source.record, text: Array.from(text).slice(0, 100).join(''), chars: 100, fragment };
  await f.runtime.decide({ replyPlan: { action: 'reply', target: target('b'), replyAt: null, pendingEventIds: [], reason: 'Redirect the fragment I actually read.' } },
    { personId: 'a', sessionId: 'session_a', channelId: 'channel_a', environment: env('a'), executeReply: true,
      pending: [admitted], pendingEventIds: [source.eventId] });
  const body = JSON.parse(f.requests[0].messages.at(-1).content);
  assert.equal(body.pending[0].text, admitted.text); assert.deepEqual(body.pending[0].fragment, fragment);
  assert.equal(body.pendingPage.remaining, 1); assert.deepEqual(f.deliveries[0].pendingEventIds, []);
  assert.deepEqual((await f.repository.getPending()).map(record => record.eventId), [source.eventId]);
  assert.equal((await f.repository.getRuntime()).execution.pendingOffsets[source.eventId], 100);
});
