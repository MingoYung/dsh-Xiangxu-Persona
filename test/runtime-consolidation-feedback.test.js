import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRepository, PersonaRuntime } from '../core/index.js';

async function fixture(t, complete) {
  const root = await mkdtemp(join(tmpdir(), 'persona-conso-feedback-'));
  const repository = new MemoryRepository({ root });
  const runtime = new PersonaRuntime({ repository, autoSchedule: false, model: { countTokens: text => Array.from(text).length, complete } });
  await runtime.open(); await repository.upsertPerson({ personId: 'a' });
  const source = await runtime.accept({ sourceSessionId: 'session_a', sourceEventId: 'actual_source', sourceKind: 'user', contentClass: 'participant_dialogue',
    role: 'user', origin: 'user', channelId: 'channel_a', personId: 'a', text: 'One actual source for a subjective interpretation.' },
  { sessionId: 'session_a', channelId: 'channel_a', timezone: 'UTC' });
  t.after(async () => { if (runtime.opened) await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { root, repository, runtime, source };
}

test('a structural rejection persists only the uncommitted candidate and its error; explicit retry of the stale run object receives the feedback and lets the model correct it', async t => {
  let calls = 0, originalVersions, invalidCandidate;
  const f = await fixture(t, async request => {
    calls++; const body = JSON.parse(request.messages.at(-1).content);
    const ref = { sourceSessionId: body.input.chat[0].sourceSessionId, sourceEventId: body.input.chat[0].sourceEventId, available: true };
    if (calls === 1) {
      assert.equal(body.candidatePatch, null); assert.equal(body.validationError, null); originalVersions = body.inputVersions;
      invalidCandidate = { entries: [{ documentKey: 'person:a:index', expectedVersion: body.inputVersions['person:a:index'], operation: 'upsert', recordId: 'subjective_meaning',
        value: { kind: 'not_a_schema_kind', text: 'An opinion whose content the program does not evaluate.', srcRefs: [ref] } }], evictSourceIds: [] };
      return { patch: invalidCandidate, usage: { inputTokens: 40, outputTokens: 15 }, model: 'test/structured-port' };
    }
    assert.deepEqual(body.candidatePatch, invalidCandidate); assert.equal(body.validationError.code, 'SCHEMA_INVALID');
    assert.match(body.validationError.message, /kind/); assert.deepEqual(body.inputVersions, originalVersions);
    const fixed = structuredClone(body.candidatePatch); fixed.entries[0].value.kind = 'pattern';
    return { patch: fixed, usage: { inputTokens: 55, outputTokens: 18 }, model: 'test/structured-port' };
  });
  const staleRunObject = await f.repository.prepareConsolidation({ personId: 'a' });
  const before = await f.repository.getRuntime();
  await assert.rejects(f.runtime.consolidate({ personId: 'a', run: staleRunObject }), error => error.code === 'SCHEMA_INVALID');
  let stored = await f.repository.getConsolidationRun(staleRunObject.runId);
  assert.equal(calls, 1); assert.equal(stored.status, 'prepared'); assert.deepEqual(stored.candidatePatch, invalidCandidate);
  assert.deepEqual(stored.validatedPatch, []); assert.equal(stored.commitMarker, null);
  assert.deepEqual((await f.repository.getRuntime()).consolidationCursors, before.consolidationCursors);
  assert.equal((await f.repository.search({ query: 'opinion', targetPersonId: 'a' })).items.length, 0);
  assert.equal((await f.repository.getPending())[0].eventId, f.source.eventId);
  const result = await f.runtime.consolidate({ personId: 'a', run: staleRunObject });
  assert.equal(result.committed, true); assert.equal(calls, 2);
  stored = await f.repository.getConsolidationRun(staleRunObject.runId);
  assert.equal(stored.status, 'committed'); assert.equal(stored.candidatePatch, undefined); assert.equal(stored.validationError, undefined);
  assert.equal(stored.validatedPatch[0].value.kind, 'pattern');
  assert.equal((await f.repository.search({ query: 'opinion', targetPersonId: 'a' })).items[0].id, 'subjective_meaning');
});

test('a model parse failure retains actual reported provider usage instead of replacing the paid call with unknown zero usage', async t => {
  let calls = 0; const actualUsage = { input_tokens: 123, output_tokens: 17 };
  const f = await fixture(t, async () => { calls++; throw Object.assign(new Error('The provider text was complete but its structured JSON was invalid'),
    { code: 'INVALID_MODEL_JSON', usage: actualUsage, model: 'test/paid-route' }); });
  const run = await f.repository.prepareConsolidation({ personId: 'a' });
  await assert.rejects(f.runtime.consolidate({ personId: 'a', run }), error => error.code === 'INVALID_MODEL_JSON');
  const usage = (await f.repository.getUsage()).at(-1);
  assert.equal(calls, 1); assert.equal(usage.observed, true); assert.deepEqual(usage.usage, actualUsage);
  assert.equal(usage.model, 'test/paid-route'); assert.match(usage.error, /structured JSON/);
  assert.equal((await f.repository.getConsolidationRun(run.runId)).status, 'prepared');
  assert.equal((await f.repository.getPending()).length, 1);
});

test('retrying an invalidated run reloads its durable status and refuses before any model call or source resurrection', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return { patch: [] }; });
  const staleRunObject = await f.repository.prepareConsolidation({ personId: 'a' });
  await f.repository.forget({ targetPersonId: 'a', ids: [f.source.record.id], reason: 'Explicit source deletion' });
  await assert.rejects(f.runtime.consolidate({ personId: 'a', run: staleRunObject }), error => error.code === 'RUN_INVALIDATED');
  assert.equal(calls, 0); assert.equal((await f.repository.getConsolidationRun(staleRunObject.runId)).status, 'failed');
  assert.deepEqual(await f.repository.readSources({ eventIds: [f.source.eventId] }), []);
});

test('the small runId entry point loads the durable run and preserves committed and unknown-run semantics without another paid call', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return { patch: [] }; });
  const run = await f.repository.prepareConsolidation({ personId: 'a' });
  assert.equal((await f.runtime.consolidate({ personId: 'a', runId: run.runId })).committed, true); assert.equal(calls, 1);
  const repeated = await f.runtime.consolidate({ personId: 'a', runId: run.runId });
  assert.equal(repeated.duplicate, true); assert.equal(calls, 1);
  await assert.rejects(f.runtime.consolidate({ personId: 'a', runId: 'unknown_run' }), error => error.code === 'RUN_NOT_FOUND');
  assert.equal(calls, 1);
});
