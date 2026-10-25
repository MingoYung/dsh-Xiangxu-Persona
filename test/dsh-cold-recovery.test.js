import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRepository } from '../core/repository.js';
import { createDshCoordinator } from '../adapters/dsh/index.js';

test('cold inactive wake recovery loads delayed host metadata before resolving and queueing its persisted target', async t => {
  const root = await mkdtemp(join(tmpdir(), 'persona-cold-wake-'));
  let coordinator;
  t.after(async () => { await coordinator?.close(); await rm(root, { recursive: true, force: true }); });

  // Persist the actual runtime and host checkpoint, then release the writer to
  // reproduce a process restart with no already active DSH agent.
  const repository = new MemoryRepository({ root }); await repository.open();
  try {
    const identity = await repository.upsertPerson({ personId: 'known_person', displayName: 'Known acquaintance' });
    const context = { personId: identity.personId, sessionId: 'inactive_session', channelId: 'channel_a' };
    const state = await repository.getRuntime();
    state.execution = { lastContext: context, pendingWake: {
      wakeId: 'persisted_wake', groups: [], totalCount: 0, remainingCount: 0, pendingEventIds: [],
      pendingPage: { completeEventIds: [], progress: {}, total: 0, remaining: 0 }, context,
    } };
    await repository.saveRuntime(state);
    await repository.store.transaction({ json: {
      'registry.json': { schemaVersion: 'persona-memory/3', version: 1, updatedAt: 1, items: [
        { id: 'route_a', sessionId: context.sessionId, channelId: context.channelId, personId: identity.personId, decidedAt: 1 },
      ] },
      'host-checkpoints.json': { schemaVersion: 'persona-memory/3', sessions: { [context.sessionId]: 4 }, blocked: {} },
    } });
  } finally { await repository.close(); }

  const handlers = new Map(), tools = new Map(), queued = [], resumes = [], metadata = { registry: false, checkpoints: false }; let resumedRoute;
  const scope = { on(name, handler) { handlers.set(name, handler); }, tools: { restrict() { return () => {}; }, register(tool) { tools.set(tool.name, tool); } } };
  const session = { id: 'inactive_session', header: {}, deriveMessages: () => [] };
  const agent = { id: session.id, ctx: scope, session, inbox: { nextTurn: [], nextStep: [] },
    followup(message) { queued.push(message); this.inbox.nextTurn.push(message); } };
  const presets = { composedPreset: () => 'persona-memory', mount: async () => {}, select: async () => { throw new Error('select is locked after a session has started'); } };
  const query = { readSession: async () => ({ inheritedEventCount: 0, events: [{ type: 'request/header', seq: 1,
    data: { header: { config: { provider: 'saved-provider', model: 'saved-model', reasoningEffort: 'low', maxTokens: 512, unrelated: 'not copied' } } } }] }) };
  const ctx = { llm: {}, get: key => key === 'agentPresets' ? presets : key === 'sessionQuery' ? query : key === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'global', model: 'different' }) } : undefined,
    agents: { get: () => undefined, async resume(options) {
      resumedRoute = options.agentOptions;
      resumes.push({ target: options.resumeSessionId, metadata: { ...metadata } });
      await options.setup(scope, agent); return { agent, async dispose() {} };
    } } };
  coordinator = createDshCoordinator(ctx, { memoryRoot: root, operatorControl: false });
  const readJson = coordinator.repository.store.readJson.bind(coordinator.repository.store);
  coordinator.repository.store.readJson = async (path, ...args) => {
    if (path === 'registry.json' || path === 'host-checkpoints.json') {
      await new Promise(resolve => setTimeout(resolve, 80));
      const result = await readJson(path, ...args);
      metadata[path === 'registry.json' ? 'registry' : 'checkpoints'] = true; return result;
    }
    return readJson(path, ...args);
  };
  await coordinator.ready; await coordinator.runtime.idle();

  assert.deepEqual(resumes, [{ target: session.id, metadata: { registry: true, checkpoints: true } }]);
  assert.deepEqual(resumedRoute, { provider: 'saved-provider', model: 'saved-model', reasoningEffort: 'low', maxTokens: 512 });
  assert.deepEqual(coordinator.errors, []);
  assert.equal(queued.length, 1); assert.equal(queued[0].id, 'persisted_wake');
  assert.equal(queued[0].source.kind, 'persona-memory:wake');
  assert.equal(coordinator.contextFor(agent).personId, 'known_person');
  assert.equal((await coordinator.repository.getRuntime()).execution.pendingWake.wakeId, 'persisted_wake');
  assert.ok(tools.has('persona_decide'));
});
