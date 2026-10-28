import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshCoordinator } from '../adapters/dsh/index.js';
import { createInstanceManager } from '../adapters/dsh/instances.js';
import { MemoryRepository } from '../core/repository.js';

function scopedSurface() {
  const handlers = new Map(), tools = new Map();
  const scope = {
    on(name, handler) {
      const set = handlers.get(name) ?? new Set(); set.add(handler); handlers.set(name, set);
      return () => { set.delete(handler); if (!set.size) handlers.delete(name); };
    },
    tools: { restrict() { return () => {}; }, register(tool) {
      if (tools.has(tool.name)) throw new Error('Duplicate mounted tool: ' + tool.name);
      tools.set(tool.name, tool); return () => { if (tools.get(tool.name) === tool) tools.delete(tool.name); };
    } },
  };
  return { scope, handlers, tools, handlerCount: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0) };
}

test('actual coordinator mount/unload/reload releases all scoped tools and listeners without duplicate personality context', async t => {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'xiangxu-live-lifecycle-'))), root = join(base, 'memory'), surface = scopedSurface();
  const session = { id: 's-one', header: {}, deriveMessages: () => [], requestHeader: () => ({ config: { provider: 'not-called', model: 'not-called' } }) };
  const agent = { id: session.id, session, ctx: surface.scope, inbox: { nextTurn: [], nextStep: [] }, status: 'idle', followup() {} };
  const ctx = { agents: { get: () => agent }, get: key => key === 'sessionQuery' ? { readSession: async () => ({ events: [] }) } : undefined, llm: {} };
  let manager;
  manager = createInstanceManager({ initialRoot: root, registryPath: join(base, 'instances.json'), config: { operatorControl: false },
    createCoordinator: options => createDshCoordinator(ctx, options), onLoaded: coordinator => coordinator.attachAgent(agent) });
  await manager.ready;
  t.after(async () => { await manager.close(); await fs.rm(base, { recursive: true, force: true }); });
  const initialCount = surface.handlerCount(); assert.ok(initialCount > 0); assert.equal(surface.tools.size, 8);
  for (let cycle = 0; cycle < 3; cycle++) {
    const assemble = [...surface.handlers.get('system-prompt/assemble')][0], oldTool = surface.tools.get('memory_search');
    const value = await assemble({}, { agent }, async () => ({ sections: [] }));
    assert.equal(value.sections.filter(section => section.name === 'persona-memory:live').length, 1);
    assert.equal(value.sections.filter(section => section.name === 'persona-memory:protocol').length, 1);
    await manager.unload(); assert.equal(surface.tools.size, 0); assert.equal(surface.handlerCount(), 0);
    const unloaded = await oldTool.execute({ query: '不会执行' }, { agent }); assert.equal(unloaded.code, 'INSTANCE_UNLOADED');
    let staleNextCalls = 0;
    await assert.rejects(async () => assemble({}, { agent }, async () => { staleNextCalls++; return { sections: [] }; }), { code: 'PERSONA_CONTEXT_UNAVAILABLE', reason: 'INSTANCE_UNLOADED' });
    assert.equal(staleNextCalls, 0);
    await manager.load(); assert.equal(surface.tools.size, 8); assert.equal(surface.handlerCount(), initialCount);
  }
});

test('a failing disposer cannot strand the writer lock or skip the remaining scoped cleanup', async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'xiangxu-dispose-fault-'))), surface = scopedSurface();
  const session = { id: 'dispose-session', header: {}, deriveMessages: () => [] };
  const agent = { id: session.id, session, ctx: surface.scope, inbox: { nextTurn: [], nextStep: [] }, status: 'idle' };
  const ctx = { agents: { get: () => agent }, get: () => undefined, llm: {} };
  const coordinator = createDshCoordinator(ctx, { memoryRoot: root, operatorControl: false }); await coordinator.ready; await coordinator.attachAgent(agent);
  t.after(async () => { await coordinator.close(); await fs.rm(root, { recursive: true, force: true }); });
  coordinator.agents.get(agent.id).disposers.unshift(() => { throw Object.assign(new Error('Injected plugin disposer failure'), { code: 'TEST_DISPOSER_FAILURE' }); });
  await coordinator.close(); assert.equal(surface.tools.size, 0); assert.equal(surface.handlerCount(), 0); assert.equal(coordinator.agents.size, 0);
  assert.ok(coordinator.errors.some(row => row.code === 'TEST_DISPOSER_FAILURE'));
  const reopened = new MemoryRepository({ root }); await reopened.open(); await reopened.close();
  assert.deepEqual(await coordinator.attachAgent(agent), { status: 'unloaded' });
  assert.equal(surface.tools.size, 0); assert.equal(surface.handlerCount(), 0);
});
