import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryRepository, PersonaRuntime } from '../core/index.js';
import { conversationPage } from '../core/prompts.js';

const env = (id = 'a') => ({ sessionId: `session_${id}`, channelId: `channel_${id}`, timezone: 'UTC' });
const chat = (id, personId = 'a', text = id) => ({ sourceSessionId: `session_${personId ?? id}`, sourceEventId: id, sourceKind: 'user',
  contentClass: 'participant_dialogue', role: 'user', origin: 'user', channelId: `channel_${personId ?? id}`, personId, text });
const ref = record => ({ sourceSessionId: record.sourceSessionId, sourceEventId: record.sourceEventId, available: true });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, { config = {}, complete, host = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'persona-autonomous-job-')), requests = [], wakes = [];
  const repository = new MemoryRepository({ root, config });
  const runtime = new PersonaRuntime({ repository, config, autoSchedule: false,
    model: { countTokens: text => Array.from(text).length, complete: async request => {
      requests.push(request); return complete ? complete(request, requests.length) : { patch: { entries: [] } };
    } }, host: { onWake: wake => { wakes.push(wake); return { accepted: true, status: 'queued' }; }, ...host } });
  await runtime.open(); for (const personId of ['a', 'b', 'c']) await repository.upsertPerson({ personId });
  t.after(async () => { if (runtime.opened) await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { root, repository, runtime, requests, wakes };
}
const jobs = async repository => Object.values((await repository.getRuntime()).execution?.consolidationJobs ?? {});

test('on_write merges observed-write facts with zero model calls; awake run is one-shot, empty changes and later defer are valid', async t => {
  const f = await fixture(t, { config: { consolidationMode: 'on_write' } });
  await f.runtime.accept(chat('one'), env());
  await f.runtime.accept({ ...chat('actual_reply'), role: 'assistant', origin: 'ai_reply', sourceKind: 'model' }, env());
  await f.runtime.accept(chat('one'), env()); await f.runtime.idle();
  let state = await f.repository.getRuntime();
  assert.equal(f.requests.length, 0); assert.equal(state.execution.consolidationOpportunity.writesObserved, 2);
  assert.equal(state.execution.consolidationOpportunity.kind, 'observed_writes');
  const snapshot = await f.runtime.compose({ ...env(), environment: env(), personId: 'a' }); assert.match(snapshot.injectedText, /writesObserved/);
  await f.runtime.decide({ consolidationPlan: { action: 'run', targetPersonIds: ['a'] } }, { ...env(), personId: 'a', executeReply: false });
  await f.runtime.idle(); assert.equal(f.requests.length, 1); assert.equal((await jobs(f.repository))[0].status, 'completed');
  assert.equal((await f.repository.getPersona()).version, 0); assert.equal((await f.repository.getRuntime()).sleep.state, 'awake');
  await f.runtime.decide({ attention: { observeChannelIds: ['channel_a'] } }, { ...env(), personId: 'a' }); await f.runtime.idle();
  assert.equal(f.requests.length, 1);
  await f.runtime.accept(chat('later'), env()); const before = (await f.repository.getRuntime()).consolidationCursors;
  await f.runtime.decide({ consolidationPlan: { action: 'defer' } }, { personId: 'a' }); await f.runtime.idle();
  assert.equal(f.requests.length, 1); assert.deepEqual((await f.repository.getRuntime()).consolidationCursors, before);
  await f.runtime.decide({ consolidationPlan: { action: 'run', targetPersonIds: [] } }); await f.runtime.idle();
  assert.equal(f.requests.length, 1); assert.equal((await jobs(f.repository)).length, 1);
});

test('sleep without selected work only sleeps; implicit conso-complete work freezes current+staging after identity and leaves later input and other people for a future choice', async t => {
  const entered = deferred(), finish = deferred(); let held = false;
  const f = await fixture(t, { complete: async request => {
    if (!held) { held = true; entered.resolve(); await finish.promise; }
    return { patch: [] };
  } });
  await f.runtime.decide({ sleepPlan: { action: 'sleep', wakeCondition: 'explicit_wake', wakeAt: null } }, { ...env(), personId: 'a' });
  await f.runtime.idle(); assert.equal(f.requests.length, 0);
  await f.runtime.handleSignal('explicit_wake');
  const known = await f.runtime.accept(chat('known_a'), env()); await f.runtime.accept(chat('not_selected_b', 'b'), env('b'));
  await f.runtime.accept(chat('unknown_ai_one', null), env('unknown_ai_one')); await f.runtime.accept(chat('unknown_ai_two', null), env('unknown_ai_two'));
  await f.runtime.decide({ identityPlan: { action: 'associate', personId: 'a', sourceRefs: [ref(known.record)] },
    sleepPlan: { action: 'sleep', wakeCondition: 'consolidation_complete', wakeAt: null } }, { ...env(), environment: env(), personId: null });
  await entered.promise;
  try { await f.runtime.accept(chat('unknown_late', null), env('unknown_late')); } finally { finish.resolve(); }
  await f.runtime.idle();
  const job = (await jobs(f.repository))[0]; assert.deepEqual(job.targets, ['a', null]); assert.equal(job.status, 'completed');
  assert.equal(f.requests.length, 2);
  const staged = f.requests.map(request => JSON.parse(request.messages.at(-1).content)).find(body => body.personId === null);
  assert.deepEqual(staged.input.chat.map(record => record.sourceEventId), ['unknown_ai_one', 'unknown_ai_two']);
  const next = await f.repository.prepareConsolidation({ personId: null }); assert.deepEqual(next.input.chat.map(record => record.sourceEventId), ['unknown_late']);
  assert.equal((await f.repository.getRuntime()).consolidationCursors['person:b'], undefined);
  assert.equal((await f.repository.getRuntime()).sleep.state, 'awake'); assert.equal(f.wakes.at(-1).context.jobId, job.jobId);
});

test('one shared call segment bounds all selected children and an explicit runId continuation completes the matching wake job without automatic retry', async t => {
  const f = await fixture(t, { config: { processingLimits: { consolidationCallsPerSegment: 2 } } });
  await f.runtime.accept(chat('a'), env()); await f.runtime.accept(chat('staged', null), env('staged')); await f.runtime.accept(chat('b', 'b'), env('b'));
  await f.runtime.decide({ consolidationPlan: { action: 'run', targetPersonIds: ['a', null, 'b'] },
    sleepPlan: { action: 'sleep', wakeCondition: 'consolidation_complete', wakeAt: null } }, { ...env(), personId: 'a' });
  await f.runtime.idle(); let job = (await jobs(f.repository))[0];
  assert.equal(f.requests.length, 2); assert.equal(job.status, 'paused'); assert.equal(job.children.filter(child => child.status === 'committed').length, 2);
  assert.deepEqual(f.requests.map(request => JSON.parse(request.messages.at(-1).content).page.callBudget),
    [{ used: 0, limit: 2, remaining: 2 }, { used: 1, limit: 2, remaining: 1 }]);
  assert.equal((await f.repository.getRuntime()).sleep.state, 'sleeping');
  const child = job.children.find(entry => entry.personId === 'b'); assert.equal((await f.repository.getConsolidationRun(child.runId)).status, 'prepared');
  await f.runtime.close(); await f.runtime.open(); await f.runtime.idle(); assert.equal(f.requests.length, 2);
  await f.runtime.consolidate({ runId: child.runId, personId: 'b' });
  job = (await jobs(f.repository))[0]; assert.equal(job.status, 'completed'); assert.equal(f.requests.length, 3);
  assert.deepEqual(JSON.parse(f.requests[2].messages.at(-1).content).page.callBudget, { used: 0, limit: 2, remaining: 2 });
  assert.equal((await f.repository.getRuntime()).sleep.state, 'awake'); assert.equal(f.wakes.length, 1);
});

test('context pages use only exposed frozen cursors, pause at a call budget, survive restart and explicitly resume without a false complete read', async t => {
  const f = await fixture(t, { config: { processingLimits: { consolidationContextChars: 2000, consolidationCallsPerSegment: 2 } },
    complete: async request => {
      const page = JSON.parse(request.messages.at(-1).content).input.context;
      return { patch: { entries: [], ...(page.nextCursor == null ? {} : { readContext: { cursor: page.nextCursor } }) } };
    } });
  const seed = await f.repository.prepareConsolidation({ personId: 'b' });
  await f.repository.applyConsolidation(seed, { entries: [{ documentKey: 'persona', expectedVersion: seed.inputVersions.persona, operation: 'upsert', recordId: 'anchor',
    value: { text: 'FROZEN_CONTEXT_'.repeat(500), srcRefs: [] } }] });
  await f.runtime.accept(chat('context_source'), env());
  const run = await f.repository.prepareConsolidation({ personId: 'a' });
  let result = await f.runtime.consolidate({ runId: run.runId, personId: 'a' });
  assert.equal(result.paused, true); assert.equal(f.requests.length, 2);
  let saved = await f.repository.getConsolidationRun(run.runId); assert.equal(saved.reviewState.contextComplete, false);
  assert.equal(saved.reviewState.modelCalls, 2); assert.equal(saved.status, 'prepared');
  assert.deepEqual((await f.repository.prepareConsolidation({ personId: 'a' })).input.chat.map(record => record.sourceEventId), ['context_source']);
  await f.runtime.close(); await f.runtime.open(); await f.runtime.idle(); assert.equal(f.requests.length, 2);
  do { result = await f.runtime.consolidate({ runId: run.runId, personId: 'a' }); } while (result.paused);
  assert.equal(result.committed, true); assert.ok(result.modelCalls > 2);
  saved = await f.repository.getConsolidationRun(run.runId); assert.equal(saved.status, 'committed');
  const cursors = f.requests.map(request => JSON.parse(request.messages.at(-1).content).input.context.fragment.from);
  assert.deepEqual(cursors, [...cursors].sort((a, b) => a - b)); assert.equal(new Set(cursors).size, cursors.length);
});

test('a guessed context cursor and a request frame that cannot fit pause without consuming sources or dispatching an oversized call', async t => {
  const f = await fixture(t, { complete: async () => ({ patch: { entries: [], readContext: { cursor: 123456 } } }) });
  await f.runtime.accept(chat('cursor_source'), env()); const run = await f.repository.prepareConsolidation({ personId: 'a' });
  await assert.rejects(f.runtime.consolidate({ runId: run.runId }), error => error.code === 'CONTEXT_CURSOR_INVALID');
  assert.equal((await f.repository.getConsolidationRun(run.runId)).status, 'prepared');
  await f.runtime.updateConfig({ processingLimits: { consolidationRequestTokens: 100 } });
  const before = f.requests.length;
  await assert.rejects(f.runtime.consolidate({ runId: run.runId }), error => error.code === 'MODEL_INPUT_BUDGET');
  assert.equal(f.requests.length, before); assert.equal((await f.repository.getPending()).length, 1);
});

test('large source input is dynamically split to the full JSON request budget and one selected increment leaves the unread original tail', async t => {
  const budget = 18000;
  const f = await fixture(t, { config: { processingLimits: { consolidationInputChars: 16000, consolidationRequestTokens: budget } } });
  await f.runtime.accept(chat('large', 'a', 'Z'.repeat(22000)), env());
  await f.runtime.decide({ consolidationPlan: { action: 'run', targetPersonIds: ['a'] } }, { ...env(), personId: 'a' }); await f.runtime.idle();
  assert.ok(f.requests.length >= 2); assert.ok(f.requests.every(request => Array.from(JSON.stringify(request.messages)).length <= budget));
  assert.ok(f.requests.every(request => request.maxOutputTokens === 16384));
  const next = await f.repository.prepareConsolidation({ personId: 'a' });
  assert.equal(next.input.chat[0].fragment.from, 16000); assert.equal(next.input.chat[0].text.length, 6000);
});

test('replaceDraft withdraws only unpaid proposals and evictions while retaining old business memory and actual source records', async t => {
  let count = 0;
  const f = await fixture(t, { complete: async request => {
    count++; const body = JSON.parse(request.messages.at(-1).content);
    if (count === 1) return { patch: { entries: [{ documentKey: 'person:a:index', expectedVersion: body.inputVersions['person:a:index'], operation: 'upsert', recordId: 'uncommitted_new',
      value: { kind: 'pattern', text: 'WITHDRAW_THIS_DRAFT', srcRefs: [ref(request.run.input.chat[0])] } }], evictSourceIds: ['old_root'] } };
    return { patch: { entries: [], replaceDraft: true } };
  }, host: { readTrace: async (_locator, options) => options.cursor == null ? { available: true, text: 'first page', nextCursor: 'second' }
    : { available: true, text: 'second page', nextCursor: null } } });
  const old = await f.runtime.accept(chat('old_root'), env()); const seed = await f.repository.prepareConsolidation({ personId: 'a' });
  await f.repository.applyConsolidation(seed, { entries: [{ documentKey: 'person:a:index', expectedVersion: seed.inputVersions['person:a:index'], operation: 'upsert', recordId: 'old_memory',
    value: { kind: 'fact', text: 'OLD_BUSINESS_KEEP', srcRefs: [ref(old.record)] } }] });
  await f.repository.clearPending([old.eventId]); await f.runtime.accept(chat('new_source'), env());
  await f.repository.captureHot({ personId: 'a', sourceRef: { sourceSessionId: 'session_a', sourceEventId: 'trace', available: true }, sourceKind: 'reasoning', origin: 'ai_reply',
    kind: 'reasoning', content: { mode: 'host_trace', locator: 'trace:test', available: true, chars: null }, dependencyRefs: [], dependencyRecordIds: [] });
  await f.runtime.consolidate({ personId: 'a' }); assert.equal(count, 3);
  assert.equal((await f.repository.search({ query: 'WITHDRAW_THIS_DRAFT', targetPersonId: 'a' })).items.length, 0);
  assert.equal((await f.repository.search({ query: 'OLD_BUSINESS_KEEP', targetPersonId: 'a' })).items[0].id, 'old_memory');
  assert.equal((await f.repository.readSources({ eventIds: [old.eventId] })).length, 1);
});

test('legacy selected prepared wake run resumes its own manifest rather than inventing a default job or scanning other people', async t => {
  const f = await fixture(t); await f.runtime.accept(chat('legacy_a'), env()); await f.runtime.accept(chat('unselected_b', 'b'), env('b'));
  const run = await f.repository.prepareConsolidation({ personId: 'a' });
  const state = await f.repository.getRuntime(); state.activeRunId = null;
  state.sleep = { state: 'sleeping', sleepDecisionId: 'legacy_sleep', wakeCondition: 'consolidation_complete', wakeAt: null, wakeRunId: run.runId, wakeJobId: null };
  await f.repository.saveRuntime(state); await f.runtime.close(); await f.runtime.open(); await f.runtime.idle();
  assert.equal(f.requests.length, 1); assert.equal((await f.repository.getConsolidationRun(run.runId)).status, 'committed');
  assert.equal((await f.repository.listConsolidationRuns()).length, 1); assert.equal((await jobs(f.repository)).length, 0);
  assert.equal((await f.repository.getRuntime()).sleep.state, 'awake');
  assert.deepEqual((await f.repository.prepareConsolidation({ personId: 'b' })).input.chat.map(record => record.sourceEventId), ['unselected_b']);
});

test('trace budget continuation replays local pages but never repeats their model call, and changed replay pauses without clearing the unread tail', async t => {
  let changed = false; const cursors = [];
  const f = await fixture(t, { config: { processingLimits: { consolidationCallsPerSegment: 1 } }, host: { readTrace: async (_locator, options) => {
    cursors.push(options.cursor);
    return options.cursor == null ? { available: true, text: changed ? 'CHANGED_FIRST' : 'FIRST', nextCursor: 'second' }
      : { available: true, text: 'SECOND', nextCursor: null };
  } } });
  await f.repository.captureHot({ personId: 'a', sourceRef: { sourceSessionId: 'session_a', sourceEventId: 'trace_budget', available: true }, sourceKind: 'reasoning', origin: 'ai_reply',
    kind: 'reasoning', content: { mode: 'host_trace', locator: 'trace:budget', available: true, chars: null }, dependencyRefs: [], dependencyRecordIds: [] });
  const run = await f.repository.prepareConsolidation({ personId: 'a' });
  assert.equal((await f.runtime.consolidate({ runId: run.runId })).paused, true); assert.equal(f.requests.length, 1);
  assert.equal((await f.repository.prepareConsolidation({ personId: 'a' })).input.hot.length, 1);
  changed = true;
  await assert.rejects(f.runtime.consolidate({ runId: run.runId }), error => error.code === 'SOURCE_REPLAY_CHANGED');
  assert.equal(f.requests.length, 1); assert.equal((await f.repository.prepareConsolidation({ personId: 'a' })).input.hot.length, 1);
  changed = false; const result = await f.runtime.consolidate({ runId: run.runId });
  assert.equal(result.committed, true); assert.equal(result.modelCalls, 2); assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests.map(request => JSON.parse(request.messages.at(-1).content).traceMaterial[0].text), ['FIRST', 'SECOND']);
  assert.ok(cursors.filter(cursor => cursor === null).length >= 3);
});

test('an invalidated paused child becomes a terminal job and a later explicit choice can create fresh selected work', async t => {
  const f = await fixture(t, { config: { processingLimits: { consolidationCallsPerSegment: 1 } } });
  await f.runtime.accept(chat('a'), env()); const b = await f.runtime.accept(chat('b', 'b'), env('b'));
  await f.runtime.decide({ consolidationPlan: { action: 'run', targetPersonIds: ['a', 'b'] } }, { ...env(), personId: 'a' }); await f.runtime.idle();
  const paused = (await jobs(f.repository))[0]; assert.equal(paused.status, 'paused');
  await f.repository.forget({ targetPersonId: 'b', ids: [b.record.id], reason: 'Explicit source revocation invalidates the prepared second child' });
  await f.runtime.accept(chat('new_b', 'b'), env('b'));
  await f.runtime.decide({ consolidationPlan: { action: 'run', targetPersonIds: ['a', 'b'] } }, { ...env(), personId: 'a' }); await f.runtime.idle();
  const all = await jobs(f.repository); assert.equal(all.find(job => job.jobId === paused.jobId).status, 'invalidated');
  assert.equal(all.length, 2); assert.equal(all.find(job => job.jobId !== paused.jobId).status, 'completed');
  assert.ok(!JSON.stringify(f.requests.at(-1).run.input).includes('"sourceEventId":"b"'));
});

test('target fan-out and queued work capacity reject explicitly instead of silently clipping a selection', async t => {
  const entered = deferred(), finish = deferred(); let held = false;
  const f = await fixture(t, { config: { processingLimits: { maxTargetsPerJob: 2, maxQueuedConsolidations: 2 } }, complete: async () => {
    if (!held) { held = true; entered.resolve(); await finish.promise; } return { patch: [] };
  } });
  await f.runtime.accept(chat('a'), env()); await f.runtime.accept(chat('b', 'b'), env('b'));
  await assert.rejects(f.runtime.decide({ consolidationPlan: { action: 'run', targetPersonIds: ['a', 'b', null] } }), error => error.code === 'CONSOLIDATION_TARGET_CAPACITY');
  assert.equal((await jobs(f.repository)).length, 0); assert.equal(f.requests.length, 0);
  await f.runtime.decide({ consolidationPlan: { action: 'run', targetPersonIds: ['a'] } }); await entered.promise;
  try {
    await f.runtime.decide({ consolidationPlan: { action: 'run', targetPersonIds: ['b'] } });
    await assert.rejects(f.runtime.decide({ consolidationPlan: { action: 'run', targetPersonIds: [null] } }), error => error.code === 'CONSOLIDATION_QUEUE_CAPACITY');
    assert.equal((await jobs(f.repository)).length, 2); assert.equal(f.requests.length, 1);
  } finally { finish.resolve(); }
  await f.runtime.idle();
});

test('a correction transport failure preserves its original candidate until a real replacement response, and empty correction can withdraw it', async t => {
  let calls = 0;
  const f = await fixture(t, { complete: async request => {
    calls++; const body = JSON.parse(request.messages.at(-1).content);
    if (calls === 1) return { patch: { entries: [{ documentKey: 'person:a:index', expectedVersion: body.inputVersions['person:a:index'], operation: 'upsert', recordId: 'bad_draft',
      value: { kind: 'invalid_enum', text: 'A subjective candidate, structurally invalid only' } }] } };
    assert.equal(body.candidatePatch.entries[0].value.kind, 'invalid_enum'); assert.deepEqual(body.previousProposedPatch, []);
    if (calls === 2) throw Object.assign(new Error('Transport ended before replacement response'), { code: 'EIO' });
    return { patch: { entries: [], replaceDraft: true } };
  } });
  await f.runtime.accept(chat('source'), env()); const run = await f.repository.prepareConsolidation({ personId: 'a' });
  await assert.rejects(f.runtime.consolidate({ runId: run.runId }), error => error.code === 'SCHEMA_INVALID');
  const candidate = (await f.repository.getConsolidationRun(run.runId)).candidatePatch;
  await assert.rejects(f.runtime.consolidate({ runId: run.runId }), error => error.code === 'EIO');
  assert.deepEqual((await f.repository.getConsolidationRun(run.runId)).candidatePatch, candidate);
  assert.equal((await f.runtime.consolidate({ runId: run.runId })).committed, true);
  assert.equal((await f.repository.search({ query: 'subjective candidate', targetPersonId: 'a' })).items.length, 0);
});

test('each actual model purpose receives its separate configured output reservation', async t => {
  const f = await fixture(t, { config: { processingLimits: { controlOutputTokens: 45, replyOutputTokens: 46, consolidationOutputTokens: 47 } },
    complete: async request => request.purpose === 'control' ? { decision: { replyPlan: { action: 'listen', replyAt: null, target: null, recheckOn: ['new_message'] } } }
      : request.purpose === 'reply' ? { text: 'Actual reply.' } : { patch: [] },
    host: { deliver: async record => ({ status: 'delivered', sourceEventId: 'actual_purpose_reply', text: record.text }) } });
  await f.runtime.accept(chat('purpose_source'), env()); await f.runtime.handleSignal('new_message', { ...env(), personId: 'a' });
  await f.runtime.decide({ replyPlan: { action: 'reply', target: { ...env(), personId: 'a' }, replyAt: null, pendingEventIds: [] } }, { ...env(), personId: 'a' });
  await f.runtime.consolidate({ personId: 'a' });
  assert.deepEqual(f.requests.map(request => [request.purpose, request.maxOutputTokens]), [['control', 45], ['reply', 46], ['consolidation', 47]]);
});

test('legacy recovery without a selected manifest respects persisted defer, empty targets and an explicit target scope', async t => {
  for (const plan of [{ action: 'defer' }, { action: 'run', targetPersonIds: [] }, { action: 'run', targetPersonIds: ['b'] }]) {
    const f = await fixture(t); await f.runtime.accept(chat('unselected_a'), env()); await f.runtime.accept(chat('selected_b', 'b'), env('b'));
    await f.runtime.decide({ consolidationPlan: { action: 'defer' } }, { ...env(), personId: 'a' });
    const state = await f.repository.getRuntime(); state.currentDecision.consolidationPlan = plan;
    state.sleep = { state: 'sleeping', sleepDecisionId: state.currentDecision.decisionId, wakeCondition: 'consolidation_complete', wakeAt: null, wakeRunId: null, wakeJobId: null };
    await f.repository.saveRuntime(state); await f.runtime.close(); await f.runtime.open(); await f.runtime.idle();
    if (plan.targetPersonIds?.length) {
      assert.equal(f.requests.length, 1); assert.deepEqual((await jobs(f.repository))[0].targets, ['b']);
      assert.deepEqual(f.requests[0].run.input.chat.map(record => record.sourceEventId), ['selected_b']);
      assert.equal((await f.repository.getRuntime()).sleep.state, 'awake');
    } else {
      assert.equal(f.requests.length, 0); assert.deepEqual(await jobs(f.repository), []);
      assert.deepEqual(await f.repository.listConsolidationRuns(), []); assert.equal((await f.repository.getRuntime()).sleep.state, 'sleeping');
    }
    assert.deepEqual((await f.repository.prepareConsolidation({ personId: 'a' })).input.chat.map(record => record.sourceEventId), ['unselected_a']);
  }
});

test('a selected safe but unknown person fails before any child manifest or model work is created', async t => {
  const f = await fixture(t); await f.runtime.accept(chat('available_a'), env());
  await assert.rejects(f.runtime.decide({ consolidationPlan: { action: 'run', targetPersonIds: ['a', 'missing_person'] } }, { ...env(), personId: 'a' }),
    error => error.code === 'UNKNOWN_PERSON_TARGET' && error.personId === 'missing_person');
  await f.runtime.idle(); assert.equal(f.requests.length, 0); assert.deepEqual(await jobs(f.repository), []);
  assert.deepEqual(await f.repository.listConsolidationRuns(), []);
  assert.deepEqual((await f.repository.listPeople()).map(person => person.personId), ['a', 'b', 'c']);
});

test('reducing new input batches to 4000 preserves an existing 16000-character manifest, highwater and page width', async t => {
  const f = await fixture(t, { config: { processingLimits: { consolidationInputChars: 16000 } } });
  await f.runtime.accept(chat('large_legacy_input', 'a', '旧材料🙂'.repeat(5500)), env());
  const frozen = await f.repository.prepareConsolidation({ personId: 'a', maxInputChars: 16000 });
  await f.repository.recordConsolidationProgress(frozen.runId, { reviewState: { ...frozen.reviewState, pageChars: 16000 } });
  await f.runtime.updateConfig({ processingLimits: { consolidationInputChars: 4000 } });
  const retained = await f.repository.getConsolidationRun(frozen.runId);
  assert.deepEqual(retained.input, frozen.input); assert.deepEqual(retained.inputSlices, frozen.inputSlices);
  assert.equal(retained.inputEndEventId, frozen.inputEndEventId); assert.equal(retained.reviewState.pageChars, 16000);
  const result = await f.runtime.consolidate({ runId: frozen.runId }); assert.equal(result.committed, true);
  const data = f.requests.map(request => JSON.parse(request.messages.at(-1).content));
  assert.equal(data.reduce((sum, body) => sum + body.input.chat.reduce((n, record) => n + Array.from(record.text).length, 0), 0), 16000);
  assert.ok(data.every(body => body.page.total === 16000));
  const next = await f.repository.prepareConsolidation({ personId: 'a' });
  assert.equal(next.input.chat.reduce((sum, record) => sum + Array.from(record.text).length, 0), 4000);
});

test('runId continuation restores its frozen person scope despite a later conversation, rejects an explicit mismatch, and keeps staging null', async t => {
  const f = await fixture(t); await f.runtime.accept(chat('selected_a'), env());
  const a = await f.repository.prepareConsolidation({ personId: 'a' });
  await f.runtime.accept(chat('later_b', 'b'), env('b'));
  await assert.rejects(f.runtime.consolidate({ runId: a.runId, personId: 'b' }), error => error.code === 'RUN_SCOPE_MISMATCH');
  assert.equal(f.requests.length, 0); assert.equal((await f.repository.getConsolidationRun(a.runId)).status, 'prepared');
  assert.equal((await f.runtime.consolidate({ runId: a.runId })).committed, true);
  const request = f.requests[0], body = JSON.parse(request.messages.at(-1).content);
  const shape = JSON.parse(request.messages[1].content.slice('Value shape guide: '.length));
  assert.equal(body.personId, 'a'); assert.equal(request.context.personId, 'a'); assert.equal(shape.personMeta.personId, 'a');
  assert.ok(shape.documentKeyExamples.some(entry => entry.documentKey === 'person:a:impression'));
  assert.deepEqual(body.input.chat.map(record => record.sourceEventId), ['selected_a']);
  await f.runtime.accept(chat('unknown_source', null), env('unknown'));
  const staging = await f.repository.prepareConsolidation({ personId: null });
  assert.equal((await f.runtime.consolidate({ runId: staging.runId })).committed, true);
  const unknown = f.requests.at(-1); assert.equal(JSON.parse(unknown.messages.at(-1).content).personId, null);
  assert.equal(unknown.context.personId, null);
  assert.equal(JSON.parse(unknown.messages[1].content.slice('Value shape guide: '.length)).personMeta, null);
});

test('direct continuation refreshes an untouched later child after the earlier child commits common personality without expanding its frozen sources', async t => {
  const f = await fixture(t, { config: { processingLimits: { consolidationCallsPerSegment: 1 } }, complete: async (request, call) => {
    const body = JSON.parse(request.messages.at(-1).content);
    return { patch: { entries: [{ documentKey: 'persona', expectedVersion: body.inputVersions.persona,
      operation: 'upsert', recordId: 'anchor', value: { text: call < 3 ? 'A selected common personality update' : 'A and the selected staging experience', srcRefs: [] } }],
      ...(call === 1 ? { readContext: { cursor: 0 } } : {}) } };
  } });
  await f.runtime.accept(chat('selected_a'), env()); await f.runtime.accept(chat('selected_unknown', null), env('unknown'));
  await f.runtime.decide({ consolidationPlan: { action: 'run', targetPersonIds: ['a', null] } }, { ...env(), personId: 'a' }); await f.runtime.idle();
  const job = (await jobs(f.repository))[0], a = job.children[0], staging = job.children[1];
  const untouched = await f.repository.getConsolidationRun(staging.runId);
  assert.equal(untouched.reviewState.modelCalls, 0); assert.ok(!Object.hasOwn(untouched, 'candidatePatch')); assert.equal(untouched.inputVersions.persona, 0);
  await f.runtime.accept(chat('late_b', null), env('b'));
  assert.equal((await f.runtime.consolidate({ runId: a.runId })).committed, true);
  assert.equal((await f.repository.getPersona()).version, 1);
  assert.equal((await f.runtime.consolidate({ runId: staging.runId })).committed, true);
  const reviewed = f.requests[2].run;
  assert.equal(reviewed.inputVersions.persona, 1); assert.equal(reviewed.input.context.persona.anchor.text, 'A selected common personality update');
  assert.deepEqual(reviewed.input.chat, untouched.input.chat); assert.deepEqual(reviewed.input.hot, untouched.input.hot);
  for (const key of ['inputSlices', 'cursorBefore', 'cursorAfter', 'inputEndEventId']) assert.deepEqual(reviewed[key], untouched[key]);
  assert.deepEqual(reviewed.input.chat.map(record => record.sourceEventId), ['selected_unknown']);
  assert.deepEqual((await f.repository.prepareConsolidation({ personId: null })).input.chat.map(record => record.sourceEventId), ['late_b']);
  assert.equal((await jobs(f.repository))[0].status, 'completed');
});

test('a malformed model response retains truthful format feedback without consuming input and an explicit empty correction can commit no change', async t => {
  const raw = '{}\nThese historical engineering materials do not make me choose a personality change.';
  const f = await fixture(t, { config: { processingLimits: { consolidationCallsPerSegment: 1 } }, complete: async (request, call) => {
    if (call === 1) return { patch: { entries: [] } };
    if (call === 2) throw Object.assign(new Error('Expected exactly one structured JSON response'), { code: 'INVALID_MODEL_JSON', responseText: raw,
      usage: { inputTokens: 100, outputTokens: 20 } });
    const body = JSON.parse(request.messages.at(-1).content);
    assert.equal(body.validationError.code, 'INVALID_MODEL_JSON'); assert.equal(body.validationError.responseText.text, raw);
    assert.equal(body.validationError.responseText.fragment.complete, true);
    assert.deepEqual(body.candidatePatch, { entries: [], evictSourceIds: [] });
    return { patch: { entries: [] } };
  } });
  await f.runtime.accept(chat('first_a'), env()); await f.runtime.accept(chat('unchanged_source', null), env('unknown'));
  await f.runtime.decide({ consolidationPlan: { action: 'run', targetPersonIds: ['a', null] } }, { ...env(), personId: 'a' }); await f.runtime.idle();
  let job = (await jobs(f.repository))[0]; assert.equal(job.error.code, 'CONSOLIDATION_CALL_BUDGET'); assert.equal(f.requests.length, 1);
  const child = job.children.find(entry => entry.personId === null), run = await f.repository.getConsolidationRun(child.runId);
  const before = await f.repository.getRuntime();
  await assert.rejects(f.runtime.consolidate({ runId: run.runId }), error => error.code === 'INVALID_MODEL_JSON');
  const failed = await f.repository.getConsolidationRun(run.runId);
  assert.equal(failed.status, 'prepared'); assert.equal(failed.commitMarker, null); assert.equal(failed.reviewState.stage, 'needs_format_correction');
  assert.deepEqual(failed.candidatePatch, { entries: [], evictSourceIds: [] }); assert.equal(failed.validationError.responseText.text, raw);
  assert.deepEqual((await f.repository.getRuntime()).consolidationCursors, before.consolidationCursors);
  job = (await jobs(f.repository))[0]; assert.equal(job.status, 'paused'); assert.equal(job.error.code, 'INVALID_MODEL_JSON');
  assert.match(job.error.message, /one structured JSON/); assert.equal(job.children.find(entry => entry.runId === run.runId).status, 'paused');
  assert.equal(job.children.find(entry => entry.runId === run.runId).modelCalls, 1); assert.equal(f.requests.length, 2);
  assert.equal((await f.runtime.consolidate({ runId: run.runId })).committed, true);
  assert.equal(f.requests.length, 3); assert.equal((await f.repository.getPersona()).version, 0);
  job = (await jobs(f.repository))[0]; assert.equal(job.status, 'completed'); assert.equal(job.error, undefined);
  assert.equal(job.children.find(entry => entry.runId === run.runId).modelCalls, 2);
  assert.equal((await f.repository.getConsolidationRun(run.runId)).validationError, undefined);
});

test('format correction resumes only its failed data page, retains earlier proposals and labels a bounded long response with its complete digest', async t => {
  const raw = JSON.stringify({ explanation: '格式说明🙂'.repeat(2000) });
  const f = await fixture(t, { config: { processingLimits: { consolidationInputChars: 4 } }, complete: async (request, call) => {
    const body = JSON.parse(request.messages.at(-1).content);
    if (call === 1) return { patch: { entries: [{ documentKey: 'person:a:index', expectedVersion: body.inputVersions['person:a:index'], operation: 'upsert', recordId: 'first_page_proposal',
      value: { kind: 'pattern', text: 'Preserve the actual earlier uncommitted proposal', srcRefs: [ref(request.run.input.chat[0])] } }] } };
    if (call === 2) throw Object.assign(new Error('A structured patch needs an entries array'), { code: 'INVALID_MODEL_PATCH', responseText: raw, responsePointer: 'fixture://malformed-response' });
    if (call === 3) {
      const feedback = body.validationError.responseText;
      assert.equal(Array.from(feedback.text).length, 4000); assert.equal(feedback.fragment.complete, false); assert.equal(feedback.fragment.total, Array.from(raw).length);
      assert.equal(feedback.sha256, createHash('sha256').update(raw).digest('hex')); assert.equal(feedback.pointer, 'fixture://malformed-response');
      assert.equal(body.candidatePatch.entries[0].recordId, 'first_page_proposal');
    }
    return { patch: { entries: [] } };
  } });
  await f.runtime.accept(chat('paged_source', 'a', 'abcdefghijklmnop'), env());
  const run = await f.repository.prepareConsolidation({ personId: 'a', maxInputChars: 16 });
  await assert.rejects(f.runtime.consolidate({ runId: run.runId }), error => error.code === 'INVALID_MODEL_PATCH');
  const paused = await f.repository.getConsolidationRun(run.runId);
  assert.equal(paused.reviewState.dataPageIndex, 1); assert.equal(paused.reviewState.dataPartOffset, 0); assert.equal(paused.reviewState.modelCalls, 2);
  assert.equal((await f.runtime.consolidate({ runId: run.runId })).committed, true);
  assert.deepEqual(f.requests.map(request => JSON.parse(request.messages.at(-1).content).input.chat.map(record => record.text).join('')), ['abcd', 'efgh', 'efgh', 'ijkl', 'mnop']);
  assert.equal((await f.repository.search({ query: 'earlier uncommitted proposal', targetPersonId: 'a' })).items[0].id, 'first_page_proposal');
});

test('actual bounded capacity facts reach snapshots and control as facts, respect explicit input, and remain fail-open when measurement is unavailable', async t => {
  const f = await fixture(t, { complete: async request => {
    assert.equal(request.purpose, 'control'); return { decision: { consolidationPlan: { action: 'defer' }, replyPlan: { action: 'listen', recheckOn: ['new_message'] } } };
  }, host: { onError() { throw new Error('A diagnostic callback cannot reject ordinary chat'); } } });
  await f.runtime.accept(chat('stored_source'), env());
  await f.repository.captureHot({ personId: 'a', sourceRef: { sourceSessionId: 'session_a', sourceEventId: 'stored_process', available: true },
    sourceKind: 'reasoning', origin: 'ai_reply', kind: 'reasoning', content: { mode: 'cached', text: 'Actual local process memory', chars: 26 }, dependencyRefs: [], dependencyRecordIds: [] });
  await f.runtime.updateConfig({ longTermTargetChars: 1, tempTargetChars: 1 });
  const gap = await f.runtime.accept(chat('capacity_gap'), env()); assert.ok(gap.gap);
  const actualCapacity = f.repository.getCapacity.bind(f.repository), observations = [];
  f.repository.getCapacity = async () => { const value = await actualCapacity(); observations.push(value); return value; };
  const resources = snapshot => JSON.parse(snapshot.segments.find(segment => segment.name === 'environment').text.split('\n')[1]).resources;
  const snapshot = await f.runtime.compose({ ...env(), personId: 'a' }), facts = resources(snapshot);
  assert.equal(observations.length, 1); assert.equal(facts.available, true);
  assert.deepEqual(facts.longTermChars, { used: observations[0].persistentChars, limit: 1 });
  assert.deepEqual(facts.tempChars, { used: observations[0].hotChars, limit: 1 });
  assert.deepEqual(facts.storeBytes, { used: observations[0].physicalBytes, limit: f.runtime.config.capacityLimits.storeBytes });
  assert.equal(facts.unresolvedGaps, 1); assert.equal(facts.pressure.longTerm, true); assert.equal(facts.pressure.hot, true);
  assert.ok(snapshot.tokens <= 2970);
  f.runtime.model.maxInputTokens = 10000;
  await f.runtime.handleSignal('new_message', { ...env(), personId: 'a', pending: [] });
  assert.equal(f.requests.length, 1); assert.match(JSON.stringify(f.requests[0].messages), /longTermChars/);
  assert.match(JSON.stringify(f.requests[0].messages), /unresolvedGaps/); assert.deepEqual(await jobs(f.repository), []);
  assert.equal((await f.repository.getRuntime()).sleep.state, 'awake');
  const callsBeforeExplicit = observations.length;
  const explicit = await f.runtime.compose({ ...env(), personId: 'a', capacity: { persistentChars: 123, longTermTargetChars: 456 } });
  assert.equal(observations.length, callsBeforeExplicit); assert.deepEqual(resources(explicit).longTermChars, { used: 123, limit: 456 });
  f.repository.getCapacity = async () => { throw Object.assign(new Error('Local capacity read is unavailable'), { code: 'EIO' }); };
  const unavailable = await f.runtime.compose({ ...env(), personId: 'a' });
  assert.deepEqual(resources(unavailable), { available: false, errorCode: 'EIO' });
  assert.ok(f.runtime.errors.some(error => error.code === 'CAPACITY_UNAVAILABLE'));
  await f.runtime.handleSignal('new_message', { ...env(), personId: 'a', pending: [] });
  assert.equal(f.requests.length, 2); assert.deepEqual(await jobs(f.repository), []); assert.equal((await f.repository.getRuntime()).sleep.state, 'awake');
});

test('wake, control and reply page the actual source against the same complete 32k input envelope rather than the old 5018 fallback', async t => {
  const f = await fixture(t, { complete: async request => request.purpose === 'reply' ? { text: 'A chosen reply after the budgeted input.' }
    : { decision: { replyPlan: { action: 'listen', recheckOn: ['new_message'] } } }, host: { deliver: async () => ({ status: 'delivered' }) } });
  const source = await f.runtime.accept(chat('long_pending', 'a', '有待真实读取🙂'.repeat(10000)), env());
  const ctx = { ...env(), personId: 'a', environment: { ...env(), technicalMetadata: '' }, identityClues: await f.repository.listPeople(), reason: 'new_message' };
  let snapshot = await f.runtime.compose(ctx);
  const header = await conversationPage(snapshot, { ...ctx, pending: [] }, { counter: f.runtime.tokenCounter, maxTokens: 32768 });
  const oldBudget = 2970 + 2048; ctx.environment.technicalMetadata = 'H'.repeat(Math.max(0, oldBudget - 60 - header.tokens));
  snapshot = await f.runtime.compose(ctx);
  const originals = await f.repository.getPending({ personId: 'a' });
  await assert.rejects(conversationPage(snapshot, { ...ctx, pending: originals }, { counter: f.runtime.tokenCounter, maxTokens: oldBudget }), error => error.code === 'MODEL_INPUT_BUDGET');
  assert.ok(snapshot.tokens <= 2970);
  await f.runtime.decide({ sleepPlan: { action: 'sleep', wakeCondition: 'explicit_wake', wakeAt: null },
    replyPlan: { action: 'listen', recheckOn: ['new_message'] } }, ctx);
  await f.runtime.handleSignal('explicit_wake', ctx);
  assert.equal((await f.repository.getRuntime()).sleep.state, 'awake'); assert.equal(f.wakes.length, 1);
  assert.ok(f.wakes[0].groups[0].records[0].fragment.to > 1); assert.equal(f.wakes[0].groups[0].records[0].fragment.complete, false);
  assert.equal((await f.repository.getPending())[0].eventId, source.eventId);
  await f.runtime.handleSignal('new_message', ctx);
  assert.equal(f.requests[0].purpose, 'control'); assert.ok(Array.from(JSON.stringify(f.requests[0].messages)).length > oldBudget);
  assert.ok(Array.from(JSON.stringify(f.requests[0].messages)).length <= 32768); assert.equal(f.requests[0].maxOutputTokens, 4096);
  await f.runtime.decide({ replyPlan: { action: 'reply', replyAt: null, pendingEventIds: [], target: { sessionId: 'session_a', channelId: 'channel_a', personId: 'a' } } },
    { ...ctx, pendingEventIds: [] });
  const reply = f.requests.at(-1); assert.equal(reply.purpose, 'reply'); assert.equal(reply.maxOutputTokens, 4096);
  assert.ok(Array.from(JSON.stringify(reply.messages)).length <= 32768); assert.ok(snapshot.tokens <= 2970);
  assert.equal((await f.repository.getPending())[0].eventId, source.eventId);
});

test('cold open performs the already selected completed-job wake exactly once without new consolidation or changing child commit markers', async t => {
  const f = await fixture(t); await f.runtime.accept(chat('selected_wake_source'), env());
  const run = await f.repository.prepareConsolidation({ personId: 'a' }); await f.repository.applyConsolidation(run, { entries: [] });
  const committed = await f.repository.getConsolidationRun(run.runId), state = await f.repository.getRuntime(), jobId = 'completed_selected_job';
  state.execution = { ...state.execution, consolidationJobs: { [jobId]: { jobId, decisionId: 'selected_sleep', status: 'completed', targets: ['a'],
    context: { ...env(), personId: 'a' }, children: [{ personId: 'a', runId: run.runId, status: 'committed' }] } } };
  state.sleep = { state: 'sleeping', sleepDecisionId: 'selected_sleep', wakeCondition: 'consolidation_complete', wakeAt: null, wakeJobId: jobId, wakeRunId: null };
  await f.repository.saveRuntime(state); await f.runtime.close(); await f.runtime.open(); await f.runtime.idle();
  assert.equal(f.requests.length, 0); assert.equal(f.wakes.length, 1); assert.equal(f.wakes[0].context.jobId, jobId);
  assert.equal(f.wakes[0].context.reason, 'selected_consolidation_complete'); assert.equal((await f.repository.getRuntime()).sleep.state, 'awake');
  assert.deepEqual((await f.repository.getConsolidationRun(run.runId)).commitMarker, committed.commitMarker);
  assert.equal((await f.repository.listConsolidationRuns()).length, 1);
  await f.runtime.acknowledgeWake(f.wakes[0].wakeId); await f.runtime.close(); await f.runtime.open(); await f.runtime.idle();
  assert.equal(f.wakes.length, 1); assert.equal(f.requests.length, 0); assert.equal((await f.repository.listConsolidationRuns()).length, 1);
});
