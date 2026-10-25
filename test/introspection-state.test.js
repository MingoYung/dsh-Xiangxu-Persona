import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryRepository } from '../core/repository.js';

test('known-target state introspection exposes global work and capacity while keeping person state distinct', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-state-'));
  const repository = new MemoryRepository({ root, clock: () => 5000 }); await repository.open();
  t.after(async () => { await repository.close(); await fs.rm(root, { recursive: true, force: true }); });
  await repository.upsertPerson({ personId: 'a' });
  const incoming = await repository.ingest({ personId: 'a', sourceSessionId: 's1', sourceEventId: 'actual-user', sourceKind: 'user',
    contentClass: 'participant_dialogue', channelId: 'desktop', role: 'user', text: '新经历仍待处理', sourceAt: 1000, observedAt: 1000 });
  const global = await repository.getRuntime();
  global.sleep = { ...global.sleep, state: 'sleeping', wakeCondition: 'consolidation_complete', wakeJobId: 'job_selected' };
  global.execution = { consolidationJobs: { job_selected: { jobId: 'job_selected', status: 'paused', targets: ['a', null],
    segmentCallsUsed: 8, children: [{ personId: 'a', runId: 'run_selected', status: 'paused' }], error: { code: 'CONSOLIDATION_CALL_BUDGET' } } } };
  const saved = await repository.saveRuntime(global), capacity = await repository.getCapacity();
  for (const [input, context] of [[{ section: 'state' }, { personId: 'a' }], [{ section: 'state', targetPersonId: 'a' }, {}]]) {
    const state = await repository.introspect(input, context);
    assert.equal(state.version, saved.version); assert.deepEqual(state.sleep, saved.sleep); assert.deepEqual(state.execution, saved.execution);
    assert.equal(state.personState.personId, 'a'); assert.deepEqual(state.personState.pendingEventIds, [incoming.eventId]);
    assert.equal(state.personState.execution, undefined); assert.equal(state.personState.sleep, undefined);
    assert.equal(state.capacity.persistentChars, capacity.persistentChars); assert.equal(state.capacity.physicalBytes, capacity.physicalBytes);
    assert.equal(state.capacity.longTermTargetChars, repository.config.longTermTargetChars); assert.ok(Number.isFinite(state.capacity.freeBytes));
    state.execution.consolidationJobs.job_selected.status = 'caller mutation';
    assert.equal((await repository.getRuntime()).execution.consolidationJobs.job_selected.status, 'paused');
  }
  const anonymous = await repository.introspect({ section: 'state' });
  assert.equal(anonymous.personState, null); assert.deepEqual(anonymous.sleep, saved.sleep); assert.equal(anonymous.version, saved.version);
  const all = await repository.introspect({ section: 'all' }, { personId: 'a' });
  assert.equal(all.state.personId, 'a'); assert.equal(all.state.sleep, undefined);
  assert.deepEqual(await repository.getRuntime(), saved); assert.equal((await repository.getPending()).length, 1);
});
