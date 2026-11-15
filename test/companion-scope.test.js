import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountCompanionScope } from '../adapters/dsh/companion-scope.js';
import { createDshCoordinator } from '../adapters/dsh/index.js';

function fixture({ loaded = false, preexisting = false, preset = 'persona-memory', attach, detach, tools, isWorkerSession } = {}) {
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
  const ctx = { get(name) { return name === 'agents' ? { get: id => roster.get(id), list: () => preexisting ? [...roster.values()] : [] } : name === 'agentPresets' ? { composedPreset: scope => selections.get(scope) } : name === 'tools' ? (typeof tools === 'function' ? tools() : tools) : undefined; },
    on(name, handler, options) { handlers.set(name, { handler, options }); }, effect: fn => cleanup.push(fn()), logger: { warn: value => warnings.push(value) } };
  const manager = { getCoordinator: () => current, async attachAgent(value) { calls.push({ kind: 'attach', agent: value }); await attach?.(value); if (current) localTools.set(value.id, ['persona_decide']); } };
  mountCompanionScope(ctx, manager, { isWorkerSession });
  return { primary, agent, roster, selections, calls, warnings, masks, cleanup, globalTools, localTools, localHandlers, handlers,
    mountAnother() { const otherHandlers = new Map(), otherCleanup = []; mountCompanionScope({ ...ctx, on(name, handler) { otherHandlers.set(name, handler); }, effect: fn => otherCleanup.push(fn()) }, manager, { isWorkerSession }); return { created: value => otherHandlers.get('agent/created')({ agent: value }), cleanup: otherCleanup }; },
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
  release(); const [, , state] = await Promise.all([first, second, next]); assert.notEqual(state, old); assert.equal(state.disposed, false); assert.equal(f.tools.size, 8); assert.equal(f.registrations, 16);
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
  release(); const [initial, concurrent] = await Promise.all([first, second]); assert.equal(concurrent, initial); assert.equal(concurrent.disposed, false); assert.equal(f.tools.size, 8); assert.equal(f.registrations, 8);
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
  assert.equal(f.tools.size, 8); assert.equal(f.registrations, 16); assert.equal(f.releases, 1); assert.equal((await f.coordinator.repository.getPending()).length, 0); await f.coordinator.close(); assert.equal(f.tools.size, 0);
});

test('the preset first step waits for attachment even before the selected notification is delivered', async () => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const f = fixture({ loaded: true, preset: 'coding', attach: () => waiting });
  f.selections.set(f.primary.ctx, 'persona-memory'); // The SDK bound its composition; notification has not run.
  let entered = false; const step = f.handlers.get('agent/pre-step').handler({ agent: f.primary }, () => { entered = true; return 'entered'; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(entered, false); assert.deepEqual(f.visible(), []);
  release(); assert.equal(await step, 'entered'); assert.deepEqual(f.visible(), ['persona_decide']); await f.cleanup[0]();
});

test('preset first-step recovery cannot mount a trusted task worker into personality memory', async () => {
  const handlers = new Map(), cleanup = []; let attached = false, masked = false, continued = false;
  const ctx = { get: name => name === 'agentPresets' ? { composedPreset: () => 'persona-memory' } : undefined, on: (name, handler) => handlers.set(name, handler), effect: fn => cleanup.push(fn()) };
  mountCompanionScope(ctx, { attachAgent: async () => { attached = true; } }, { isWorkerSession: id => id === 'owned-worker' });
  const agent = { id: 'owned-worker', ctx: { tools: { restrict: () => { masked = true; } } } };
  await handlers.get('agent/pre-step')({ agent }, () => { continued = true; });
  assert.equal(attached, false); assert.equal(masked, false); assert.equal(continued, true); await cleanup[0]();
});

test('first prompt assembly waits for full attachment and refreshes the authoritative wire schemas without changing the host presentation mode', async () => {
  const handlers = new Map(), cleanup = [], parameters = { type: 'object', properties: { action: { type: 'string' } } }; let released, attached = false, mode = 'native', decorated = 0;
  const gate = new Promise(resolve => { released = resolve; }), scope = {}, agent = { id: 'first-prompt', session: { id: 'first-prompt', header: { agentPreset: 'persona-memory' } }, ctx: { on: () => () => {}, tools: { restrict: () => () => {}, wireSchemas: actualScope => { assert.equal(actualScope, scope); return { schemas: attached ? [{ name: mode === 'native' ? 'persona_task' : 'run_code', parameters }] : [] }; } } } };
  const coordinator = { preparePersonaAssembly: async (_agent, value) => { decorated++; return { ...value, sections: [...value.sections, { name: 'persona-memory:protocol', text: 'protocol' }, { name: 'persona-memory:live', text: 'live' }] }; }, detachAgent: async () => {} };
  const manager = { getCoordinator: () => coordinator, attachAgent: async () => { await gate; attached = true; } };
  const ctx = { get: name => name === 'agentPresets' ? { composedPreset: () => 'persona-memory' } : undefined, on: (name, handler) => handlers.set(name, handler), effect: fn => cleanup.push(fn()) };
  mountCompanionScope(ctx, manager);
  let finished = false; const assembling = handlers.get('system-prompt/assemble')({ sections: [], tools: [] }, { agent, scope }, async () => ({ sections: [], tools: [] })).then(value => { finished = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false); released(); const first = await assembling;
  assert.equal(first.tools[0].name, 'persona_task'); assert.equal(decorated, 1); first.tools[0].parameters.properties.action.type = 'number'; assert.equal(parameters.properties.action.type, 'string');
  mode = 'ptc'; const ptc = await handlers.get('system-prompt/assemble')({ sections: [], tools: [] }, { agent, scope }, async () => ({ sections: [], tools: [] })); assert.equal(ptc.tools[0].name, 'run_code');
  await cleanup[0]();
});

test('native tool resolution waits before capturing the first late-selected companion tool set', async () => {
  let release, captured = 0, receiver;
  const waiting = new Promise(resolve => { release = resolve; });
  const tools = { async resolve({ agent }) { captured++; receiver = this; return Object.freeze([...f.visible(agent)]); } };
  const original = tools.resolve, f = fixture({ loaded: true, preset: 'coding', attach: () => waiting, tools });
  f.selections.set(f.primary.ctx, 'persona-memory'); // Composition exists; selected event has not arrived.
  let complete = false;
  const resolving = tools.resolve({ agent: f.primary }).then(value => { complete = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(complete, false); assert.equal(captured, 0); assert.deepEqual(f.visible(), []);
  release(); assert.deepEqual(await resolving, ['persona_decide']); assert.equal(receiver, tools);
  assert.equal(f.calls.filter(call => call.kind === 'attach').length, 1);
  await f.cleanup[0](); assert.equal(tools.resolve, original);
});

test('the native resolve barrier leaves other presets and trusted workers independent of a slow companion attach', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const tools = { async resolve({ agent }) { return f.visible(agent); } };
  const f = fixture({ loaded: true, attach: () => waiting, tools, isWorkerSession: id => id === 'worker' });
  const resolving = tools.resolve({ agent: f.primary });
  const coding = f.agent('coding', 'coding'), worker = f.agent('worker');
  assert.deepEqual(await tools.resolve({ agent: coding }), ['agent_dispatch', 'shell']);
  assert.deepEqual(await tools.resolve({ agent: worker }), ['agent_dispatch', 'shell']);
  assert.equal(f.calls.length, 1); release(); await resolving; await f.cleanup[0]();
});

test('native resolve propagates attachment failure before capturing a partial tool set', async () => {
  let captured = 0;
  const failure = Object.assign(new Error('attachment failed'), { code: 'ATTACH_FAILED' });
  const tools = { async resolve() { captured++; return []; } };
  const f = fixture({ loaded: true, tools, attach: async () => { throw failure; } });
  await assert.rejects(tools.resolve({ agent: f.primary }), error => error === failure);
  assert.equal(captured, 0); await f.cleanup[0]();
});

test('aborting native resolve does not cancel shared attachment or capture stale definitions', async () => {
  let release, captured = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const tools = { async resolve({ agent }) { captured++; return f.visible(agent); } };
  const f = fixture({ loaded: true, tools, attach: () => waiting }), controller = new AbortController();
  const abort = Object.assign(new Error('cancelled by host'), { name: 'AbortError' });
  const resolving = tools.resolve({ agent: f.primary, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(abort);
  await assert.rejects(resolving, error => error === abort); assert.equal(captured, 0);
  release(); assert.deepEqual(await tools.resolve({ agent: f.primary }), ['persona_decide']);
  assert.equal(f.calls.filter(call => call.kind === 'attach').length, 1); await f.cleanup[0]();
});

test('traced service proxies and overlapping preset revisions share and release one native resolve barrier', async () => {
  const prototype = { async resolve({ agent }) { assert.equal(this[Symbol.for('cordis.original')], raw); return f.visible(agent); } };
  const raw = Object.create(prototype), proxies = [];
  const proxy = () => { const value = new Proxy(raw, { get(target, key, receiver) { return key === Symbol.for('cordis.original') ? target : Reflect.get(target, key, receiver); } }); proxies.push(value); return value; };
  const f = fixture({ loaded: true, tools: proxy }), wrapper = raw.resolve, next = f.mountAnother();
  assert.equal(raw.resolve, wrapper); assert.equal(Object.hasOwn(raw, 'resolve'), true);
  assert.deepEqual(await proxies[0].resolve({ agent: f.primary }), ['persona_decide']);
  assert.equal(f.calls.filter(call => call.kind === 'attach').length, 1);
  await f.cleanup[0](); assert.equal(raw.resolve, wrapper); assert.equal(f.calls.filter(call => call.kind === 'detach').length, 0);
  assert.deepEqual(await proxies.at(-1).resolve({ agent: f.primary }), ['persona_decide']);
  await next.cleanup[0](); assert.equal(raw.resolve, prototype.resolve); assert.equal(Object.hasOwn(raw, 'resolve'), false);
  assert.equal(f.calls.filter(call => call.kind === 'detach').length, 1);
});

test('leaving a preset during native resolution drains its late attachment before the next preset snapshot', async () => {
  let release, captured = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const tools = { async resolve({ agent }) { captured++; return f.visible(agent); } };
  const f = fixture({ loaded: true, tools, attach: () => waiting });
  const resolving = tools.resolve({ agent: f.primary });
  await new Promise(resolve => setImmediate(resolve)); const leaving = f.select(f.primary, 'coding');
  release(); assert.deepEqual(await resolving, ['agent_dispatch', 'shell']); await leaving;
  assert.equal(captured, 1); assert.equal(f.localTools.size, 0); await f.cleanup[0]();
});

test('native resolve cannot attach an Agent replaced under the same session ID', async () => {
  const tools = { async resolve({ agent }) { return agent.id; } };
  const f = fixture({ loaded: true, tools }), replacement = f.agent(f.primary.id);
  assert.equal(await tools.resolve({ agent: f.primary }), f.primary.id); assert.equal(f.calls.length, 0);
  await tools.resolve({ agent: replacement }); assert.equal(f.calls[0].agent, replacement); await f.cleanup[0]();
});

test('an already aborted native resolution never starts a companion attachment', async () => {
  let captured = 0;
  const tools = { async resolve() { captured++; } }, f = fixture({ loaded: true, tools });
  const controller = new AbortController(); controller.abort(new Error('already stopped'));
  await assert.rejects(tools.resolve({ agent: f.primary, signal: controller.signal }), /already stopped/);
  assert.equal(f.calls.length, 0); assert.equal(captured, 0); await f.cleanup[0]();
});

test('last scope disposal preserves an independently installed tools resolve wrapper', async () => {
  const tools = { async resolve() { return 'native'; } }, f = fixture({ loaded: true, tools });
  const ours = tools.resolve, later = async function (...args) { return ours.apply(this, args); };
  tools.resolve = later;
  await f.cleanup[0](); assert.equal(tools.resolve, later); assert.equal(await tools.resolve({ agent: f.primary }), 'native');
});

test('an in-flight native resolution waits for a replacement preset revision before taking its snapshot', async () => {
  let release, count = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const tools = { async resolve({ agent }) { return f.visible(agent); } };
  const original = tools.resolve, f = fixture({ loaded: true, tools, attach: () => ++count === 1 ? waiting : undefined });
  const resolving = tools.resolve({ agent: f.primary });
  await new Promise(resolve => setImmediate(resolve));
  const oldCleanup = f.cleanup[0](), next = f.mountAnother();
  release(); assert.deepEqual(await resolving, ['persona_decide']); await oldCleanup;
  assert.deepEqual(f.calls.map(call => call.kind), ['attach', 'detach', 'attach']);
  assert.notEqual(tools.resolve, original); await next.cleanup[0](); assert.equal(tools.resolve, original);
});

test('native resolution starting after preset leave waits for its exact retiring mask without attaching unrelated agents', async () => {
  let releaseDetach, captured = 0;
  const waiting = new Promise(resolve => { releaseDetach = resolve; });
  const tools = { async resolve({ agent }) { captured++; return f.visible(agent); } };
  const f = fixture({ loaded: true, tools, detach: () => waiting });
  await f.created(f.primary); const leaving = f.select(f.primary, 'coding');
  let complete = false;
  const resolving = tools.resolve({ agent: f.primary }).then(value => { complete = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(complete, false); assert.equal(captured, 0);
  const unrelated = f.agent('other-coding', 'coding');
  assert.deepEqual(await tools.resolve({ agent: unrelated }), ['agent_dispatch', 'shell']);
  assert.equal(f.calls.filter(call => call.kind === 'attach').length, 1);
  releaseDetach(); assert.deepEqual(await resolving, ['agent_dispatch', 'shell']); await leaving;
  assert.equal(f.localTools.size, 0); await f.cleanup[0]();
});

test('an aborted native resolve handles a later shared attachment rejection without an unhandled promise', async () => {
  let rejectAttach, captured = 0;
  const waiting = new Promise((_resolve, reject) => { rejectAttach = reject; });
  const tools = { async resolve() { captured++; } }, f = fixture({ loaded: true, tools, attach: () => waiting });
  const controller = new AbortController(), resolving = tools.resolve({ agent: f.primary, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(new Error('request cancelled'));
  await assert.rejects(resolving, /request cancelled/); rejectAttach(new Error('late attach failure'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(captured, 0); await f.cleanup[0]();
});
