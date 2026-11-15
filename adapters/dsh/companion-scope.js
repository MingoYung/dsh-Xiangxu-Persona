const managerLeases = new WeakMap();
const resolveBarrierKey = Symbol.for('xiangxu-persona.tools.resolve-barrier');
const cordisOriginal = Symbol.for('cordis.original');
const currentCoordinator = manager => typeof manager.getCoordinator === 'function' ? manager.getCoordinator() : manager;
function awaitAttachment(task, signal) {
  signal?.throwIfAborted?.();
  if (!signal) return task;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? Object.assign(new Error('Tool resolution aborted'), { name: 'AbortError' }));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(task).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
function beforeToolResolution(tools, prepare) {
  // Cordis returns a new traced service proxy at each access. Share the barrier
  // on its original service while retaining the caller's scoped `this` below.
  const target = tools?.[cordisOriginal] ?? tools;
  if (typeof target?.resolve !== 'function') return () => {};
  let state = target[resolveBarrierKey];
  if (!state || target.resolve !== state.wrapper) {
    const descriptor = Object.getOwnPropertyDescriptor(target, 'resolve'), original = target.resolve;
    state = { entries: new Set(), descriptor, original, version: 0, resolving: 0 };
    state.release = () => {
      if (state.entries.size || state.resolving) return;
      if (target.resolve === state.wrapper) {
        if (state.descriptor) Object.defineProperty(target, 'resolve', state.descriptor);
        else delete target.resolve;
      }
      if (target[resolveBarrierKey] === state) delete target[resolveBarrierKey];
    };
    state.wrapper = async function (context, ...rest) {
      state.resolving++;
      try {
        context?.signal?.throwIfAborted?.();
        let version;
        do {
          version = state.version;
          for (const entry of [...state.entries]) await entry(context);
        } while (version !== state.version);
        context?.signal?.throwIfAborted?.();
        return state.original.call(this, context, ...rest);
      } finally { state.resolving--; state.release(); }
    };
    Object.defineProperty(target, 'resolve', { configurable: true, writable: true, value: state.wrapper });
    Object.defineProperty(target, resolveBarrierKey, { configurable: true, value: state });
  }
  state.entries.add(prepare);
  state.version++;
  return () => {
    if (!state.entries.delete(prepare)) return;
    state.version++;
    state.release();
  };
}
function retireLease(lease) {
  if (lease.disposal) return lease.disposal;
  lease.disposed = true;
  const task = lease.slot.tail.then(async () => {
    for (const coordinator of new Set([lease.coordinator, currentCoordinator(lease.manager)])) await coordinator?.detachAgent?.(lease.agent.id, lease.agent);
  });
  lease.slot.tail = task.catch(() => {});
  lease.disposal = task.finally(() => { if (lease.slot.current === lease) lease.sessions.delete(lease.agent.id); });
  lease.disposal.catch(() => {});
  return lease.disposal;
}
function acquireLease(manager, agent, claim) {
  let sessions = managerLeases.get(manager);
  if (!sessions) managerLeases.set(manager, sessions = new Map());
  let slot = sessions.get(agent.id);
  if (!slot) sessions.set(agent.id, slot = { current: null, tail: Promise.resolve() });
  const prior = slot.current;
  if (prior?.agent === agent && !prior.disposed) { prior.claims.add(claim); return prior; }
  if (prior) retireLease(prior);
  const lease = { manager, agent, slot, sessions, claims: new Set([claim]), coordinator: currentCoordinator(manager), disposed: false };
  slot.current = lease;
  lease.task = slot.tail.then(async () => {
    if (lease.disposed) return;
    await manager.attachAgent(agent);
    lease.coordinator = currentCoordinator(manager) ?? lease.coordinator;
  });
  slot.tail = lease.task.catch(() => {});
  return lease;
}
function releaseLease(lease, claim) {
  lease.claims.delete(claim);
  return lease.claims.size ? Promise.resolve() : retireLease(lease);
}

/** Keep the companion preset isolated even while its memory instance is unloaded.
 * The SDK can select a preset after agent/created. Its registry emits
 * agent-preset/selected(sessionId, presetId) after rebinding the Agent scope.
 */
export function mountCompanionScope(ctx, manager, { presetId = 'persona-memory', isWorkerSession = () => false } = {}) {
  const owned = new Map(), pending = new Set(); let closed = false;
  const service = name => { try { return ctx.get?.(name) ?? ctx[name]; } catch { return undefined; } };
  const actualPreset = (agent, announced) => service('agentPresets')?.composedPreset?.(agent.ctx) ?? announced ?? agent.session?.header?.agentPreset;
  const report = error => ctx.logger?.warn?.('[xiangxu-persona] companion scope: ' + (error?.code ?? 'PERSONA_SCOPE_ATTACH_FAILED'));
  function track(task) { pending.add(task); task.finally(() => pending.delete(task)).catch(() => {}); return task; }
  function dispose(item) {
    if (item.disposal) return item.disposal;
    item.disposed = true;
    const released = releaseLease(item.lease, item.claim);
    item.disposal = track((async () => {
      await released.catch(report);
      await item.task.catch(() => {});
      try { item.releaseGate?.(); } catch (error) { report(error); }
      try { item.release?.(); } catch (error) { report(error); }
      if (owned.get(item.agent.id) === item) owned.delete(item.agent.id);
    })());
    return item.disposal;
  }
  function activate(agent) {
    if (closed || isWorkerSession(agent.id)) return;
    const previous = owned.get(agent.id);
    if (previous?.agent === agent && !previous.disposed) return previous.task;
    if (typeof agent.ctx?.tools?.restrict !== 'function') throw Object.assign(new Error('宿主无法建立陪伴工具作用域'), { code: 'PERSONA_SCOPE_UNAVAILABLE' });
    const priorDisposal = previous ? dispose(previous) : Promise.resolve();
    // The SDK event emitter need not await memory attachment. Mask immediately.
    const item = { agent, release: agent.ctx.tools.restrict({ allow: [] }), claim: {}, disposed: false };
    owned.set(agent.id, item);
    item.lease = acquireLease(manager, agent, item.claim);
    item.task = track(Promise.all([item.lease.task, priorDisposal]).then(() => undefined));
    item.task.catch(report);
    if (typeof agent.ctx.on === 'function') item.releaseGate = agent.ctx.on('agent/pre-step', async (_payload, next) => {
      await item.task;
      return next();
    });
    return item.task;
  }
  const eligible = agent => agent && !closed && !isWorkerSession(agent.id) && actualPreset(agent) === presetId
    && (!service('agents')?.get || service('agents').get(agent.id) === agent);
  // DSH 2.0.22 freezes tool definitions before prompt assembly/pre-step. Wait
  // before that native snapshot; registering tools afterwards cannot repair it.
  const releaseResolution = beforeToolResolution(service('tools'), async context => {
    const agent = context?.agent;
    if (!eligible(agent)) {
      // A leave notification is not awaited either. Drain only our exact prior
      // owner so its retiring mask/tools cannot enter the next preset's view.
      const previous = owned.get(agent?.id);
      if (previous?.agent === agent) await awaitAttachment(dispose(previous), context?.signal);
      return;
    }
    while (eligible(agent)) {
      const task = activate(agent);
      await awaitAttachment(task, context.signal);
      const item = owned.get(agent.id);
      if (eligible(agent) && item?.agent === agent && !item.disposed && item.task === task) return;
    }
    const item = owned.get(agent.id);
    if (item?.agent === agent) await awaitAttachment(dispose(item), context.signal);
  });
  // Older DSH versions collect schemas in this waterfall. Retain that refresh
  // alongside the earlier barrier required by the frozen tool-set contract.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const agent = context?.agent;
    if (!agent || closed || isWorkerSession(agent.id) || actualPreset(agent) !== presetId) return next();
    await activate(agent);
    let value = await next();
    const coordinator = currentCoordinator(manager);
    // The inner agent waterfall may already have prepared a projection. This
    // authoritative refresh must retain the same request context and signal,
    // so the final model boundary checks the assembly actually returned here.
    if (coordinator?.preparePersonaAssembly) value = await coordinator.preparePersonaAssembly(agent, value, context);
    const tools = agent.ctx?.tools ?? service('tools');
    const fresh = typeof tools?.wireSchemas === 'function' ? tools.wireSchemas(context.scope ?? agent.ctx).schemas : tools?.schemas?.(agent);
    return Array.isArray(fresh) ? { ...value, tools: fresh.map(tool => ({ ...tool, parameters: structuredClone(tool.parameters) })) } : value;
  });
  // Selecting a preset and following up can precede its selected notification.
  // This listener belongs to the preset scope itself, so its first step waits.
  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload?.agent;
    if (agent && !closed && !isWorkerSession(agent.id) && actualPreset(agent) === presetId) await activate(agent);
    return next();
  });
  ctx.on('agent/created', ({ agent }) => {
    // Creation is scoped to the preset. The live registry also rejects stale callbacks.
    if (isWorkerSession(agent.id)) return;
    const preset = actualPreset(agent);
    if (preset !== undefined && preset !== presetId) return;
    return activate(agent);
  });
  ctx.on('agent-preset/selected', (sessionId, announced) => {
    if (closed) return;
    const agent = service('agents')?.get?.(sessionId), previous = owned.get(sessionId);
    if (!agent || isWorkerSession(agent.id)) return previous ? dispose(previous) : undefined;
    if (actualPreset(agent, announced) !== presetId) return previous ? dispose(previous) : undefined;
    return activate(agent);
  }, { global: true });
  // A restored Agent can have joined the revision before this plugin mounted.
  for (const agent of service('agents')?.list?.() ?? []) if (!isWorkerSession(agent.id) && actualPreset(agent) === presetId) activate(agent);
  ctx.effect(() => async () => {
    closed = true;
    releaseResolution();
    await Promise.allSettled([...owned.values()].map(dispose));
    await Promise.allSettled([...pending]);
    owned.clear();
  });
}
