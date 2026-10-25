import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryRepository } from '../core/repository.js';

const chat = (id, personId) => ({ personId, sourceSessionId: 's1', sourceEventId: id, sourceKind: 'user',
  contentClass: 'participant_dialogue', channelId: 'desktop', role: 'user', text: '这段经历保持原文', sourceAt: 1000, observedAt: 1000 });
const fragmentOf = (raw, limit = 4000) => {
  const points = Array.from(raw), text = points.slice(0, limit).join('');
  return { format: 'text_fragment', text, fragment: { from: 0, to: Array.from(text).length, total: points.length, complete: points.length <= limit },
    sha256: createHash('sha256').update(raw).digest('hex') };
};
async function fixture(t, config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-feedback-'));
  const repository = new MemoryRepository({ root, config, clock: () => 5000 }); await repository.open();
  t.after(async () => { await repository.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, repository };
}

test('actual Unicode format feedback survives restart detached, without treating it as a committed patch', async t => {
  const { root, repository } = await fixture(t, { processingLimits: { consolidationContextChars: 8 } });
  await repository.upsertPerson({ personId: 'a' }); await repository.ingest(chat('one', 'a'));
  const run = await repository.prepareConsolidation({ personId: 'a' }), before = await repository.getRuntime();
  const responseText = { ...fragmentOf('{}中文😀后面还有内容', 8), pointer: 'host:actual-artifact' }, original = structuredClone(responseText);
  const saved = await repository.recordConsolidationAttempt(run.runId, { candidatePatch: [], validationError: { code: 'INVALID_MODEL_JSON', message: 'Extra content after JSON', responseText } });
  assert.deepEqual(saved.validationError.responseText, original); assert.equal(saved.status, 'prepared');
  assert.equal(saved.commitMarker, null); assert.deepEqual(saved.validatedPatch, []); assert.deepEqual(await repository.getRuntime(), before);
  assert.equal((await repository.getPending()).length, 1); assert.equal((await repository.readSources({ sourceRefs: [{ sourceSessionId: 's1', sourceEventId: 'one' }] })).length, 1);
  responseText.text = 'caller mutation'; saved.validationError.responseText.fragment.total = 0;
  await repository.close(); await repository.open();
  const persisted = await repository.getConsolidationRun(run.runId); assert.deepEqual(persisted.validationError.responseText, original);
  const committed = await repository.applyConsolidation(persisted, []);
  assert.equal(committed.run.validationError, undefined); assert.equal(committed.run.candidatePatch, undefined);
  assert.equal(await fs.stat(path.join(root, 'journal', 'runs', run.runId + '.json')).then(() => true), true);
});

test('malformed, nonfinite and oversized format fragments leave the prepared manifest unchanged', async t => {
  const { repository } = await fixture(t, { processingLimits: { consolidationContextChars: 3 } });
  const run = await repository.prepareConsolidation(), valid = fragmentOf('中😀文');
  const invalid = [
    { ...valid, fragment: { ...valid.fragment, to: 4 } },
    { ...valid, fragment: { ...valid.fragment, total: Infinity } },
    { ...valid, sha256: 'guessed' },
    { ...valid, pointer: { invented: true } },
  ];
  for (const responseText of invalid) {
    await assert.rejects(repository.recordConsolidationAttempt(run.runId, { candidatePatch: [], validationError: { message: 'format', responseText } }), { code: 'SCHEMA_INVALID' });
    assert.deepEqual(await repository.getConsolidationRun(run.runId), run);
  }
  await assert.rejects(repository.recordConsolidationAttempt(run.runId, { candidatePatch: [], validationError: { message: 'format', responseText: fragmentOf('中😀文多') } }), { code: 'CAPACITY_EXCEEDED' });
  assert.deepEqual(await repository.getConsolidationRun(run.runId), run);
});

test('revocation also invalidates source references inside retained response JSON and clears the diagnostic', async t => {
  const { repository } = await fixture(t); await repository.upsertPerson({ personId: 'a' }); await repository.upsertPerson({ personId: 'b' });
  await repository.ingest(chat('a-original', 'a')); const other = await repository.ingest(chat('b-original', 'b'));
  const run = await repository.prepareConsolidation({ personId: 'a' });
  const responseText = fragmentOf(JSON.stringify({ sourceSessionId: 's1', sourceEventId: 'b-original', text: '模型未提交的原始返回' }));
  await repository.recordConsolidationAttempt(run.runId, { candidatePatch: [], validationError: { message: 'format', responseText } });
  await repository.forget({ ids: [other.record.id], targetPersonId: 'b', reason: '明确撤回' });
  const invalidated = await repository.getConsolidationRun(run.runId);
  assert.equal(invalidated.status, 'failed'); assert.equal(invalidated.validationError, undefined); assert.equal(invalidated.candidatePatch, undefined);
  await assert.rejects(repository.recordConsolidationAttempt(run.runId, { candidatePatch: [], validationError: { message: 'retry', responseText } }), { code: 'RUN_INVALIDATED' });
  const next = await repository.prepareConsolidation({ personId: 'a' });
  await assert.rejects(repository.recordConsolidationAttempt(next.runId, { candidatePatch: [], validationError: { message: 'retry', responseText } }), { code: 'SOURCE_REVOKED' });
  assert.equal((await repository.readSources({ sourceRefs: [{ sourceSessionId: 's1', sourceEventId: 'a-original' }] })).length, 1);
});
