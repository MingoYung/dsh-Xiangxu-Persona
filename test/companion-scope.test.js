import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountCompanionScope } from '../adapters/dsh/companion-scope.js';
import { createDshCoordinator } from '../adapters/dsh/index.js';

function fixture({ loaded = false, preexisting = false, preset = 'persona-memory', attach, detach } = {}) {
  const handlers = new Map(), cleanup = [], roster = new Map(), selections = new WeakMap(), calls = [], warnings = [];
  const globalTools = new Map([['agent_dispatch', () => 'delegated'], ['shell', () => 'executed']]);
  const localTools = new Map(), masks = new Map(), localHandlers = new Map();
  const coordinator = { async detachAgent(id, expected) { calls.push({ kind: 'detach', id, agent: expected }); await detach?.(id, expected); if (roster.get(id) === expected) localTools.delete(id); } };
  let current = loaded ? coordinator : null;
  function agent(id = 'normal-companion-session', selected = preset) {
    const value = { id, session: { id, header: { agentPreset: selected } }, ctx: {
      tools: { restrict({ allow }) { assert.deepEqual(allow, []); masks.set(value, (masks.get(value) ?? 0) + 1); return () => masks.set(value, masks.get(value) - 1); } },
      on(name, handler) { const key = id + ':' + name; localHandlers.set(key, handler); return () => { if (localHandlers.get(key) === handler) localHandlers.delete(key); }; },
    } };
    roster.set(id, value); selections.set(value.ctx, selected); return value;
  }
  const primary = agent();
  const ctx = { get(name) { return name === 'agents' ? { get: id => roster.get(id), list: () => preexisting ? [...roster.values()] : [] } : name === 'agentPresets' ? { composedPreset: scope => selections.get(scope) } : undefined; },
    on(name, handler, options) { handlers.set(name, { handler, options }); }, effect: fn => cleanup.push(fn()), logger: { warn: value => warnings.push(value) } };
  const manager = { getCoordinator: () => current, async attachAgent(value) { calls.push({ kind: 'attach', agent: value }); await attach?.(value); if (current) localTools.set(value.id, ['persona_decide']); } };
  mountCompanionScope(ctx, manager);
  return { primary, agent, roster, selections, calls, warnings, masks, cleanup, globalTools, localTools, localHandlers, handlers,
    mountAnother() { const otherHandlers = new Map(), otherCleanup = []; mountCompanionScope({ ...ctx, on(name, handler) { otherHandlers.set(name, handler); }, effect: fn => otherCleanup.push(fn()) }, manager); return { created: value => otherHandlers.get('agent/created')({ agent: value }), cleanup: otherCleanup }; },
    set current(value) { current = value; }, coordinator,
    created: value => handlers.get('agent/created').handler({ agent: value }),
    select(value, selected) { selections.set(value.ctx, selected); return handlers.get('agent-preset/selected').handler(value.id, selected); },
    visible(value = primary) { return [...(localTools.get(value.id) ?? []), ...((masks.get(value) ?? 0) > 0 ? [] : globalTools.keys())]; },
  };
}

test('ordinary companion scope masks inherited dispatch while memory is unloaded and leaves other presets intact', async () => {
  const f = fixture(); await f.created(f.primary); assert.deepEqual(f.visible(), []);
  const other = f.agent('other-preset', 'coding'); await f.created(other); assert(f.visible(other).includes('agent_dispatch'));
  assert.equal(f.globalTools.get('agent_dispatch')(), 'delegated'); await f.created(f.primary); assert.equal(f.masks.get(f.primary), 1);
  await f.cleanup[0](); assert.equal(f.masks.get(f.primary), 0); assert(f.visible().includes('agent_dispatch'));
});

test('selecting the companion preset after agent creation immediately masks and attaches the exact Agent', async () => {
  const f = fixture({ loaded: true, preset: 'coding' }); await f.created(f.primary); assert(f.visible().includes('agent_dispatch'));
  const selected = f.select(f.primary, 'persona-memory'); assert.equal(f.masks.get(f.primary), 1); assert(!f.visible().includes('agent_dispatch')); await selected;
  assert.deepEqual(f.visible(), ['persona_decide']); assert.equal(f.calls.filter(call => call.kind === 'attach').length, 1);
  await f.select(f.primary, 'persona-memory'); assert.equal(f.masks.get(f.primary), 1); assert.equal(f.calls.filter(call => call.kind === 'attach').length, 1);
  assert.deepEqual(f.handlers.get('agent-preset/selected').options, { global: true }); await f.cleanup[0]();
});

test('leaving the preset detaches only its exact agent and releases its own mask without unloading the plugin', async () => {
  const f = fixture({ loaded: true }); await f.created(f.primary); const other = f.agent('unrelated', 'coding');
  await f.select(f.primary, 'coding'); assert(f.visible().includes('agent_dispatch')); assert(f.visible(other).includes('agent_dispatch'));
  assert.deepEqual(f.calls.filter(call => call.kind === 'detach').map(call => [call.id, call.agent]), [[f.primary.id, f.primary]]);
  assert.equal(f.localHandlers.size, 0); await f.cleanup[0](); assert.equal(f.calls.filter(call => call.kind === 'detach').length, 1);
});

test('late selection still masks inherited tools when no personality instance is loaded', async () => {
  const f = fixture({ preset: 'coding' }); await f.created(f.primary); await f.select(f.primary, 'persona-memory'); assert.deepEqual(f.visible(), []);
  await f.select(f.primary, 'coding'); assert(f.visible().includes('shell')); await f.cleanup[0]();
});

test('an already-bound restored companion is attached when the scope plugin mounts', async () => {
  const f = fixture({ loaded: true, preexisting: true }); assert.equal(f.masks.get(f.primary), 1);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(f.visible(), ['persona_decide']); await f.cleanup[0]();
});

test('the first step waits for memory attachment and preset exit cannot leave tools registered by a late attach', async () => {
  let release; const waiting = new Promise(resolve => { release = resolve; }); const f = fixture({ loaded: true, preset: 'coding', attach: () => waiting });
  const selected = f.select(f.primary, 'persona-memory'); let entered = false;
  const step = f.localHandlers.get(f.primary.id + ':agent/pre-step')({}, () => { entered = true; return 'entered'; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(entered, false); const left = f.select(f.primary, 'coding'); release();
  await Promise.all([selected, step, left]); assert.equal(entered, true); assert(f.visible().includes('agent_dispatch')); assert.equal(f.localTools.size, 0); await f.cleanup[0]();
});

test('a stale preset notification cannot mask an Agent whose live registry composition belongs elsewhere', async () => {
  const f = fixture({ preset: 'coding' }); await f.handlers.get('agent-preset/selected').handler(f.primary.id, 'persona-memory');
  assert.equal(f.masks.get(f.primary), undefined); assert.equal(f.calls.length, 0); await f.cleanup[0]();
});

test('rapid leave and reselection waits for the exact old asynchronous detach before attaching again', async () => {
  let releaseDetach; const waiting = new Promise(resolve => { releaseDetach = resolve; });
  const f = fixture({ loaded: true, detach: () => waiting }); await f.created(f.primary);
  const leaving = f.select(f.primary, 'coding'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call.kind === 'detach').length, 1);
  const selectedAgain = f.select(f.primary, 'persona-memory'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call.kind === 'attach').length, 1); assert(!f.visible().includes('agent_dispatch'));
  releaseDetach(); await Promise.all([leaving, selectedAgain]);
  assert.deepEqual(f.calls.map(call => call.kind), ['attach', 'detach', 'attach']); assert.deepEqual(f.visible(), ['persona_decide']); assert.equal(f.masks.get(f.primary), 1);
  await f.cleanup[0](); assert.equal(f.localTools.size, 0); assert.equal(f.masks.get(f.primary), 0);
});

test('replacing an Agent with the same session ID releases the old object and attaches the new object', async () => {
  const f = fixture({ loaded: true }); await f.created(f.primary); const replacement = f.agent(f.primary.id); await f.created(replacement);
  assert.equal(f.masks.get(f.primary), 0); assert.equal(f.masks.get(replacement), 1);
  assert.equal(f.calls.filter(call => call.kind === 'detach')[0].agent, f.primary); assert.equal(f.calls.filter(call => call.kind === 'attach').at(-1).agent, replacement); await f.cleanup[0]();
});

test('unsupported scope fails before companion attach rather than inheriting unrestricted tools', async () => {
  let attached = false; const handlers = new Map();
  mountCompanionScope({ on: (name, fn) => handlers.set(name, fn), effect() {} }, { attachAgent: async () => { attached = true; } });
  assert.throws(() => handlers.get('agent/created')({ agent: { id: 'unsafe', ctx: { tools: {} } } }), { code: 'PERSONA_SCOPE_UNAVAILABLE' }); assert.equal(attached, false);
});

test('two preset mounts share one attachment and an old revision cleanup cannot detach the new owner', async () => {
  const f = fixture({ loaded: true }); await f.created(f.primary); const next = f.mountAnother(); await next.created(f.primary);
  assert.equal(f.calls.filter(call => call.kind === 'attach').length, 1); assert.equal(f.masks.get(f.primary), 2);
  await f.cleanup[0](); assert.deepEqual(f.visible(), ['persona_decide']); assert.equal(f.calls.filter(call => call.kind === 'detach').length, 0); assert.equal(f.masks.get(f.primary), 1);
  await next.cleanup[0](); assert.equal(f.calls.filter(call => call.kind === 'detach').length, 1); assert.equal(f.masks.get(f.primary), 0);
});

test('a new preset mount waits for the old mount slow detach instead of reusing its dying attachment', async () => {
  let release; const waiting = new Promise(resolve => { release = resolve; }); const f = fixture({ loaded: true, detach: () => waiting }); await f.created(f.primary);
  const closingOld = f.cleanup[0](); await new Promise(resolve => setImmediate(resolve)); const next = f.mountAnother(), selected = next.created(f.primary);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.filter(call => call.kind === 'attach').length, 1); assert(!f.visible().includes('agent_dispatch'));
  release(); await Promise.all([closingOld, selected]); assert.deepEqual(f.calls.map(call => call.kind), ['attach', 'detach', 'attach']); assert.deepEqual(f.visible(), ['persona_decide']);
  await next.cleanup[0](); assert.equal(f.masks.get(f.primary), 0);
});

async function actualCoordinator(t, { slowDispose } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'xiangxu-attachment-race-')), tools = new Map(), handlers = new Map(); let registrations = 0, releases = 0;
  const scope = { on(name, handler) { const values = handlers.get(name) ?? new Set(); values.add(handler); handlers.set(name, values); return () => { values.delete(handler); if (!values.size) handlers.delete(name); }; },
    tools: { restrict() { return async () => { releases++; await slowDispose?.(releases); }; }, register(tool) { assert.equal(tools.has(tool.name), false, 'must not register over an old tool'); registrations++; tools.set(tool.name, tool); return () => { if (tools.get(tool.name) === tool) tools.delete(tool.name); }; } } };
  const agent = { id: 'real-coordinator-agent', session: { id: 'real-coordinator-agent', header: {}, deriveMessages: () => [] }, ctx: scope, inbox: { nextTurn: [], nextStep: [] }, status: 'idle' };
  const coordinator = createDshCoordinator({ agents: { get: () => agent }, get: () => undefined, llm: {} }, { memoryRoot: root, operatorControl: false });
  await coordinator.ready; t.after(async () => { await coordinator.close(); await rm(root, { recursive: true, force: true }); });
  return { coordinator, agent, tools, handlers, get registrations() { return registrations; }, get releases() { return releases; } };
}

test('actual coordinator concurrent detach calls dispose once and a new attach waits for the dying state', async t => {
  let release; const waiting = new Promise(resolve => { release = resolve; }); const f = await actualCoordinator(t, { slowDispose: count => count === 1 ? waiting : undefined });
  const old = await f.coordinator.attachAgent(f.agent), pendingBefore = await f.coordinator.repository.getPending();
  const first = f.coordinator.detachAgent(f.agent.id, f.agent), second = f.coordinator.detachAgent(f.agent.id, f.agent); let attached = false;
  const next = f.coordinator.attachAgent(f.agent).then(value => { attached = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(attached, false); assert.equal(old.disposed, true); assert.equal(f.releases, 1);
  release(); const [, , state] = await Promise.all([first, second, next]); assert.notEqual(state, old); assert.equal(state.disposed, false); assert.equal(f.tools.size, 7); assert.equal(f.registrations, 14);
  assert.deepEqual(await f.coordinator.repository.getPending(), pendingBefore);
  await f.coordinator.close(); assert.equal(f.tools.size, 0); assert.equal(f.handlers.size, 0); assert.equal(f.coordinator.runtime._timer, null); assert.equal(f.releases, 2);
});

test('actual coordinator initialization, concurrent detach and close drain without registering orphan tools', async t => {
  const f = await actualCoordinator(t), transaction = f.coordinator.repository.store.transaction.bind(f.coordinator.repository.store); let release, entered;
  const waiting = new Promise(resolve => { release = resolve; }), checkpoint = new Promise(resolve => { entered = resolve; }); let blocked = false;
  f.coordinator.repository.store.transaction = async args => { if (!blocked && Object.hasOwn(args.json ?? {}, 'host-checkpoints.json')) { blocked = true; entered(); await waiting; } return transaction(args); };
  const attaching = f.coordinator.attachAgent(f.agent); await checkpoint;
  const first = f.coordinator.detachAgent(f.agent.id, f.agent), second = f.coordinator.detachAgent(f.agent.id, f.agent), closing = f.coordinator.close();
  assert.equal(f.coordinator.agents.get(f.agent.id).disposed, true); release(); await Promise.all([attaching, first, second, closing]);
  assert.equal(f.tools.size, 0); assert.equal(f.handlers.size, 0); assert.equal(f.coordinator.agents.size, 0); assert.equal(f.releases, 1); assert.equal(f.coordinator.runtime._timer, null);
  assert.equal((await f.coordinator.attachAgent(f.agent)).status, 'unloaded');
});

test('a second actual coordinator attach waits for complete initialization instead of returning the early state', async t => {
  const f = await actualCoordinator(t), transaction = f.coordinator.repository.store.transaction.bind(f.coordinator.repository.store); let release, entered, blocked = false;
  const waiting = new Promise(resolve => { release = resolve; }), checkpoint = new Promise(resolve => { entered = resolve; });
  f.coordinator.repository.store.transaction = async args => { if (!blocked && Object.hasOwn(args.json ?? {}, 'host-checkpoints.json')) { blocked = true; entered(); await waiting; } return transaction(args); };
  const first = f.coordinator.attachAgent(f.agent); await checkpoint; let secondCompleted = false;
  const second = f.coordinator.attachAgent(f.agent).then(value => { secondCompleted = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(secondCompleted, false); assert.equal(f.tools.size, 0);
  release(); const [initial, concurrent] = await Promise.all([first, second]); assert.equal(concurrent, initial); assert.equal(concurrent.disposed, false); assert.equal(f.tools.size, 7); assert.equal(f.registrations, 7);
  assert.equal((await f.coordinator.repository.getPending()).length, 0); await f.coordinator.close(); assert.equal(f.tools.size, 0); assert.equal(f.coordinator.runtime._timer, null);
});

test('a replacement actual Agent waits for old initialization and disposal before registering its own tools', async t => {
  const f = await actualCoordinator(t), transaction = f.coordinator.repository.store.transaction.bind(f.coordinator.repository.store); let release, entered, blocked = false;
  const waiting = new Promise(resolve => { release = resolve; }), checkpoint = new Promise(resolve => { entered = resolve; });
  f.coordinator.repository.store.transaction = async args => { if (!blocked && Object.hasOwn(args.json ?? {}, 'host-checkpoints.json')) { blocked = true; entered(); await waiting; } return transaction(args); };
  const first = f.coordinator.attachAgent(f.agent); await checkpoint; const replacement = { ...f.agent }; let replaced = false;
  const second = f.coordinator.attachAgent(replacement).then(value => { replaced = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(replaced, false); assert.equal(f.tools.size, 0);
  release(); const [initial, concurrent] = await Promise.all([first, second]); assert.notEqual(concurrent, initial); assert.equal(initial.disposed, true); assert.equal(concurrent.agent, replacement); assert.equal(concurrent.disposed, false);
  assert.equal(f.tools.size, 7); assert.equal(f.registrations, 14); assert.equal(f.releases, 1); assert.equal((await f.coordinator.repository.getPending()).length, 0); await f.coordinator.close(); assert.equal(f.tools.size, 0);
});
