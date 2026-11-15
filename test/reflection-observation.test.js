import test from 'node:test';
import assert from 'node:assert/strict';
import { readReflectionObservation, reflectionPhaseReady } from '../scripts/fixtures/reflection-fixture.mjs';

function fixture({ commitDuringRead = false, commitAtRunRead = false, deepIds = ['reflection_deep_b', 'reflection_deep_c'] } = {}) {
  let version = 3;
  const runtime = () => ({ version, activeRunId: null });
  const coordinator = { readyState: async () => runtime(), repository: {
    browseMemory: async () => ({ items: [] }),
    introspect: async () => ({ version, items: deepIds.map(id => ({ id })) }),
    getPersona: async () => { if (commitDuringRead) version++; return {}; },
    getRuntime: async () => runtime(),
    listConsolidationRuns: async () => { if (commitAtRunRead) version++; return [{ runId: 'prune-run', status: 'committed' }]; },
  } };
  const phase = { phaseRuns: { prune: ['prune-run'] }, scopes: [{ sessionId: 'reflection_parent_fixture', status: 'idle' }] };
  return { coordinator, phase };
}

test('reflection observation rejects a deep-before-commit/runtime-after-commit torn snapshot', async () => {
  const f = fixture({ commitDuringRead: true });
  const value = { ...f.phase, ...await readReflectionObservation(f.coordinator) };
  assert.deepEqual(value.observationVersions, { before: 3, after: 4 });
  assert.equal(value.runs[0].status, 'committed'); assert.equal(value.runtime.activeRunId, null);
  assert.deepEqual(value.deep.items.map(item => item.id), ['reflection_deep_b', 'reflection_deep_c']);
  assert.equal(value.observationStable, false); assert.equal(reflectionPhaseReady(value, 'prune'), false);
});

test('the ending version is read after run statuses so a commit at the last document read is rejected', async () => {
  const f = fixture({ commitAtRunRead: true }), value = { ...f.phase, ...await readReflectionObservation(f.coordinator) };
  assert.deepEqual(value.observationVersions, { before: 3, after: 4 });
  assert.equal(reflectionPhaseReady(value, 'prune'), false);
});

test('a stable wrong deep-memory result remains ready and fails the actual content assertion', async () => {
  const f = fixture(), value = { ...f.phase, ...await readReflectionObservation(f.coordinator) };
  assert.equal(value.observationStable, true); assert.equal(reflectionPhaseReady(value, 'prune'), true);
  assert.throws(() => assert(value.deep.items.length === 1 && value.deep.items[0].id === 'reflection_deep_b'), assert.AssertionError);
});

test('a stable correct deep-memory result passes the unchanged content assertion', async () => {
  const f = fixture({ deepIds: ['reflection_deep_b'] }), value = { ...f.phase, ...await readReflectionObservation(f.coordinator) };
  assert.equal(reflectionPhaseReady(value, 'prune'), true);
  assert(value.deep.items.length === 1 && value.deep.items[0].id === 'reflection_deep_b');
});
