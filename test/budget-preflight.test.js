import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRepository } from '../core/repository.js';
import { PersonaRuntime } from '../core/runtime.js';
import { defaultConfig } from '../core/schema.js';
import { buildContinuitySnapshot, measureContinuityRequirements } from '../core/request-snapshot.js';
import { createManagementService } from '../adapters/dsh/management.js';

const route = { personId: null, sessionId: 'preflight', channelId: 'fixture', timezone: 'UTC' };
const chars = text => Array.from(text).length;
const source = (id, text) => ({ sourceSessionId: 'preflight', sourceEventId: id, sourceKind: 'user',
  contentClass: 'participant_dialogue', role: 'user', personId: null, channelId: 'fixture', text });
async function fixture(t, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'xiangxu-preflight-')), calls = [];
  const repository = new MemoryRepository({ root, config, clock: () => 1000 });
  const runtime = new PersonaRuntime({ repository, config, clock: () => 1000, autoSchedule: false,
    model: { countTokens: chars, complete: async request => { calls.push(request); return { patch: [] }; } } });
  await runtime.open();
  const coordinator = { repository, runtime, errors: [], agents: new Map(), executeCommand: (action, input) => {
    assert.equal(action, 'config'); return runtime.updateConfig(input);
  } };
  const service = createManagementService({ getCoordinator: () => coordinator });
  t.after(async () => { if (runtime.opened) await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { root, repository, runtime, service, calls };
}
async function grow(repository, size = 5000) {
  const persona = await repository.getPersona(); persona.version++;
  persona.anchor.text = '完整的性格与价值判断😀'.repeat(Math.ceil(size / 12));
  await repository.store.transaction({ runId: 'preflight-fixture-growth-' + persona.version, json: { 'self/persona.json': persona } });
  return persona;
}

test('mandatory preflight measures the actual concatenation and delivery facts, and its exact minimum builds a complete snapshot', async () => {
  const counter = { method: 'boundary_sensitive', count: async text => chars(text) + (text.includes('[anchor]') && text.includes('[recent_memory]') ? 73 : 0) };
  const input = { context: { ...route, deliveryFacts: { confirmedNativeSends: 1, currentTurnVisibleOutput: false } },
    material: { persona: { version: 2, anchor: { text: '不截断的锚点' }, axes: { warmth: { desc: '自然温暖' } } },
      recentMemory: { items: [{ id: 'recent', role: 'user', sourceAt: 900, sourceSessionId: 'earlier', sourceEventId: 'one', text: '完整原文😀'.repeat(300) }], total: 1 } },
    state: {}, now: 1000, counter, config: defaultConfig() };
  const before = structuredClone(input.material), measured = await measureContinuityRequirements(input);
  assert.ok(measured.requiredTokens > measured.segments.reduce((sum, row) => sum + row.tokens, 0));
  assert.equal(measured.personaVersion, 2);
  const config = defaultConfig({ contextBudget: { totalTokens: measured.requiredTokens, recentMemoryTokens: measured.recentMinimumTokens,
    selfProfileTokens: 0, environmentTokens: 0, personaTokens: 0, relationTokens: 0, retrievalTokens: 0, habitTokens: 0 } });
  const snapshot = await buildContinuitySnapshot({ ...input, config });
  assert.equal(await counter.count(snapshot.injectedText), measured.requiredTokens);
  assert.match(snapshot.injectedText, /confirmedNativeSends/); assert.match(snapshot.injectedText, /不截断的锚点/);
  assert.ok(snapshot.recentMemoryReference.fragments[0].to >= 1); assert.equal(snapshot.mandatoryContext.complete, true);
  assert.deepEqual(input.material, before);
});

test('growth preflight is read-only, does no retrieval/model work and offers only a verified bounded explicit recommendation', async t => {
  const f = await fixture(t); await grow(f.repository);
  await f.runtime.accept(source('pending', '来信原件保留'), { ...route });
  const before = { state: await f.repository.getRuntime(), config: structuredClone(f.runtime.config), pending: await f.repository.getPending(), snapshots: await f.repository.getSnapshots() };
  f.repository.search = async () => { throw new Error('Preflight must not retrieve'); };
  const check = await f.runtime.preflightConfig({}, route);
  assert.equal(check.ok, false); assert.equal(check.requiresExplicitApply, true);
  assert.ok(check.requiredTokens > before.config.contextBudget.totalTokens);
  assert.ok(check.suggestedConfig.contextBudget.totalTokens <= check.configured.requestTokens);
  assert.equal((await f.runtime.preflightConfig(check.suggestedConfig, route)).ok, true);
  assert.deepEqual(await f.repository.getRuntime(), before.state); assert.deepEqual(f.runtime.config, before.config);
  assert.deepEqual(await f.repository.getPending(), before.pending); assert.deepEqual(await f.repository.getSnapshots(), before.snapshots);
  assert.deepEqual(f.calls, []);
});

test('budget saving rejects insufficient total and recent reference before persistence but permits unrelated settings', async t => {
  const f = await fixture(t);
  const stored = structuredClone(f.repository.config);
  await assert.rejects(f.runtime.updateConfig({ contextBudget: { totalTokens: 1 } }), { code: 'CONFIG_BUDGET_INSUFFICIENT' });
  await assert.rejects(f.runtime.updateConfig({ contextBudget: { recentMemoryTokens: 1 } }), { code: 'CONFIG_BUDGET_INSUFFICIENT' });
  await assert.rejects(f.runtime.updateConfig({ processingLimits: { consolidationRequestTokens: 100 } }), { code: 'CONFIG_BUDGET_INSUFFICIENT' });
  assert.deepEqual(f.repository.config, stored); assert.deepEqual(f.runtime.config, stored);
  await f.runtime.updateConfig({ conversationStyle: 'balanced' }); assert.equal(f.runtime.config.conversationStyle, 'balanced');
  assert.deepEqual(f.calls, []);
});

test('an insufficient existing full-request ceiling is never silently raised or advertised as a safe recommendation', async t => {
  const f = await fixture(t, { processingLimits: { consolidationRequestTokens: 1000 } }); await grow(f.repository);
  const check = await f.runtime.preflightConfig({}, route);
  assert.equal(check.ok, false); assert.equal(check.requiresExplicitApply, false); assert.deepEqual(check.suggestedConfig, {});
  assert.equal(f.runtime.config.processingLimits.consolidationRequestTokens, 1000); assert.deepEqual(f.calls, []);
});

test('management recovery needs the displayed current recommendation and applies only its explicitly requested budget change', async t => {
  const f = await fixture(t); await grow(f.repository);
  const first = await f.service.dispatch('config.preflight');
  await grow(f.repository, 6200);
  await assert.rejects(f.service.dispatch('config.recoverBudget', { recommendationId: first.recommendationId }), { code: 'BUDGET_PREFLIGHT_STALE' });
  assert.equal(f.runtime.config.contextBudget.totalTokens, 2970);
  const current = await f.service.dispatch('config.preflight');
  const result = await f.service.dispatch('config.recoverBudget', { recommendationId: current.recommendationId });
  assert.equal(result.applied, true); assert.equal(result.preflight.ok, true);
  assert.equal(result.config.processingLimits.consolidationRequestTokens, 32768);
  assert.equal(result.config.contextBudget.totalTokens, current.suggestedConfig.contextBudget.totalTokens);
  assert.deepEqual(f.calls, []); assert.deepEqual(await f.repository.getSnapshots(), []);
});

test('failed frozen consolidation records the measured minimum and preserves its original run, candidates and source progress', async t => {
  const f = await fixture(t, { processingLimits: { consolidationRequestTokens: 100 } });
  await f.runtime.accept(source('frozen', '冻结原件必须保留'), route);
  const run = await f.repository.prepareConsolidation({ personId: null });
  await assert.rejects(f.runtime.consolidate({ runId: run.runId }), error => error.code === 'MODEL_INPUT_BUDGET' && error.budgetRequirement.requiredTokens > 100);
  const after = await f.repository.getConsolidationRun(run.runId);
  assert.equal(after.status, 'prepared'); assert.equal(after.reviewState.pauseReason, 'MODEL_INPUT_BUDGET');
  assert.equal(after.reviewState.modelCalls, 0); assert.equal(after.reviewState.dataPageIndex, 0); assert.equal(after.reviewState.dataPartOffset, 0);
  assert.equal(after.reviewState.budgetRequirement.countingMethod, 'port'); assert.deepEqual(after.input, run.input);
  assert.equal((await f.repository.getPending()).length, 1); assert.deepEqual(f.calls, []);
  // Changing resources is explicit; continuation reuses this same manifest.
  await f.runtime.updateConfig({ processingLimits: { consolidationRequestTokens: 32768 } });
  const continued = await f.runtime.consolidate({ runId: run.runId });
  assert.equal(continued.run.runId, run.runId); assert.equal(continued.committed, true);
  assert.equal(continued.run.reviewState.budgetRequirement, undefined);
});

test('a selected paused job exposes its measured work requirement without selecting work or retrying and refuses a newly insufficient request cap', async t => {
  const f = await fixture(t, { processingLimits: { consolidationRequestTokens: 100 } });
  await f.runtime.accept(source('selected', '原作业来源'), route);
  await f.runtime.decide({ consolidationPlan: { action: 'run', targetPersonIds: [null] } }, { ...route, executeReply: false });
  await f.runtime.idle();
  const state = await f.repository.getRuntime(), job = Object.values(state.execution.consolidationJobs)[0];
  assert.equal(job.status, 'paused'); const runId = job.children[0].runId;
  const before = await f.repository.getConsolidationRun(runId), check = await f.runtime.preflightConfig({}, route);
  assert.equal(check.workIssues[0].runId, runId); assert.ok(check.workIssues[0].required > 100);
  assert.deepEqual(await f.repository.getConsolidationRun(runId), before); assert.deepEqual(f.calls, []);
  await assert.rejects(f.runtime.updateConfig({ processingLimits: { consolidationRequestTokens: check.workIssues[0].required - 1 } }), { code: 'CONFIG_BUDGET_INSUFFICIENT' });
  await f.runtime.updateConfig({ processingLimits: { consolidationRequestTokens: 32768 } });
  const ready = await f.runtime.preflightConfig({}, route);
  assert.equal(ready.workIssues.length, 0); assert.equal(ready.pausedRuns[0].runId, runId); assert.equal(ready.pausedRuns[0].fits, true);
  assert.deepEqual(f.calls, []); assert.equal((await f.repository.getRuntime()).execution.consolidationJobs[job.jobId].status, 'paused');
});
