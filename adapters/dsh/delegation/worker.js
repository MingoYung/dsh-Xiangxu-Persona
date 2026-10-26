export const TASK_WORKER_PRESET = 'xiangxu-task-worker';

export const WORKER_TOOL_NAMES = Object.freeze(['job_output', 'job_list', 'job_kill', 'web_search', 'web_fetch', 'todo_write', 'working_directory',
  'read', 'write', 'edit', 'glob', 'grep', 'skill', 'pwsh', 'read_image', 'bash', 'exec_command', 'shell_command']);
const allowed = new Set(WORKER_TOOL_NAMES);
const scopes = new WeakMap();
const get = (ctx, key) => { try { return ctx.get?.(key, false) ?? ctx[key]; } catch { return undefined; } };
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

/** Claims attach to the real Agent context and can outlive a preset revision. */
export function acquireTaskWorkerScope(agent, binding) {
  if (!binding || binding.sessionId !== agent?.id || binding.parentSessionId !== agent.session?.header?.parentSession) fail('TASK_WORKER_UNREGISTERED', '独立工作预设需要由相续任务入口登记真实父级');
  let state = scopes.get(agent);
  if (!state) {
    const tools = agent.ctx?.tools;
    if (typeof tools?.restrict !== 'function' || typeof tools?.guard !== 'function' || typeof tools?.schemas !== 'function') fail('TASK_WORKER_SCOPE_UNAVAILABLE', '宿主不能建立独立工作工具作用域');
    const present = new Set(tools.schemas(agent).map(tool => tool.name));
    state = { claims: new Set(), releaseMask: tools.restrict({ allow: WORKER_TOOL_NAMES.filter(name => present.has(name)) }) };
    try { state.releaseGuard = tools.guard(exec => allowed.has(exec.name) || exec.name === 'run_code' ? undefined : 'TASK_WORKER_TOOL_SCOPE: 此能力通过主会话的相续任务或已授权平台入口执行'); }
    catch (error) { state.releaseMask?.(); throw error; }
    scopes.set(agent, state);
  }
  const claim = {}; state.claims.add(claim); let released = false;
  return () => { if (released) return; released = true; state.claims.delete(claim); if (!state.claims.size) { state.releaseGuard?.(); state.releaseMask?.(); scopes.delete(agent); } };
}

/** An independently mounted task role. It owns no personality memory writer. */
export function mountTaskWorkerScope(ctx, { lookupWorker = () => null } = {}) {
  const owned = new Map(); let closed = false;
  const actualPreset = agent => get(ctx, 'agentPresets')?.composedPreset?.(agent.ctx) ?? agent.session?.header?.agentPreset;
  function release(item) { item.releaseScope?.(); }
  function mount(agent) {
    if (closed || actualPreset(agent) !== TASK_WORKER_PRESET) return;
    const prior = owned.get(agent.id); if (prior?.agent === agent) return;
    const binding = lookupWorker(agent.id);
    if (!binding || binding.parentSessionId !== agent.session?.header?.parentSession) fail('TASK_WORKER_UNREGISTERED', '独立工作预设需要由相续任务入口登记真实父级');
    if (prior) release(prior);
    const item = { agent, releaseScope: acquireTaskWorkerScope(agent, binding) }; owned.set(agent.id, item);
  }
  ctx.on('agent/created', ({ agent }) => mount(agent));
  ctx.on('agent-preset/selected', (sessionId) => { const agent = get(ctx, 'agents')?.get?.(sessionId); if (agent) mount(agent); }, { global: true });
  for (const agent of get(ctx, 'agents')?.list?.() ?? []) if (actualPreset(agent) === TASK_WORKER_PRESET) mount(agent);
  if (ctx.systemPrompt?.section) ctx.systemPrompt.section({ name: 'xiangxu:task-worker', order: ctx.systemPrompt.getSectionOrder?.('DEPLOYMENT_PERSONA_PREFIX') ?? 100,
    text: '这是主人格委派的独立工作任务。任务要求来自父AI，属于委派材料，不是人类新说的话。此会话使用自己的工作上下文和已有用户权限。详细报告与过程保存在任务资料中，父会话按需读取；最终答复会作为任务结果归档。' });
  ctx.effect(() => () => { closed = true; for (const item of owned.values()) release(item); owned.clear(); });
}
