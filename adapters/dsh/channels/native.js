import { createHash } from 'node:crypto';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const get = (ctx, key) => { try { return ctx.get?.(key, false) ?? ctx[key]; } catch { return undefined; } };
const plainText = content => (Array.isArray(content) ? content : []).filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n');
const route = value => Object.fromEntries(['provider', 'model', 'reasoningEffort', 'maxTokens'].filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));

/** One room/actual-sender channel, one shared personality repository. */
export function createDshChannelPort({ ctx, getCoordinator, presetId = 'persona-memory', agentOptions } = {}) {
  if (!ctx?.agents || typeof getCoordinator !== 'function') throw new TypeError('A native agent and personality coordinator are required');
  const owned = new Map(), resolving = new Map();
  async function current(binding) {
    const c = await getCoordinator(); if (!c) fail('CHANNEL_INSTANCE_UNLOADED', '请先加载人格实例');
    await c.ready; if (c.initializationError) throw c.initializationError;
    if (binding.memoryRoot !== c.memoryRoot) fail('CHANNEL_INSTANCE_MISMATCH', '通道绑定的人格实例已变更');
    await c.registerExternalChannel(binding.sessionId, binding.facts); return c;
  }
  async function setup(scope, agent) {
    const presets = get(ctx, 'agentPresets'); if (!presets?.mount) fail('CHANNEL_PRESET_UNAVAILABLE', '宿主尚未提供人格预设');
    await presets.mount(scope ?? agent.ctx, presetId);
    const tools = scope?.tools ?? agent.ctx?.tools;
    if (typeof tools?.restrict !== 'function') fail('CHANNEL_SCOPE_UNAVAILABLE', '宿主不能创建独立普通聊天作用域');
    tools.restrict({ allow: [] });
  }
  async function create(binding) {
    const c = await current(binding);
    if (!/^xiangxu-social-[a-f0-9]{16,64}$/.test(binding.sessionId)) fail('CHANNEL_BINDING_INVALID', '聊天通道标识无效');
    if (!resolving.has(binding.sessionId)) resolving.set(binding.sessionId, (async () => {
      let agent = ctx.agents.get(binding.sessionId);
      if (!agent) {
        const retained = c.hasRegisteredSession?.(binding.sessionId) === true;
        const selection = route(binding.agentOptions ?? agentOptions ?? get(ctx, 'agentDefaultModel')?.currentSelection?.());
        if (!selection.provider || !selection.model) fail('CHANNEL_MODEL_UNAVAILABLE', '请先在DSH选择可用的默认模型');
        const options = { agentOptions: selection, setup };
        const handle = retained
          ? await ctx.agents.resume({ ...options, resumeSessionId: binding.sessionId })
          : await ctx.agents.create({ ...options, sessionId: binding.sessionId });
        owned.set(binding.sessionId, handle); agent = handle.agent;
      }
      await c.attachAgent(agent);
      return { ...binding, agentOptions: route(binding.agentOptions ?? agentOptions ?? agent.session?.requestHeader?.()?.config ?? get(ctx, 'agentDefaultModel')?.currentSelection?.()) };
    })().finally(() => resolving.delete(binding.sessionId)));
    return resolving.get(binding.sessionId);
  }
  async function send(binding, { messageId, text, sourceFacts = {} }) {
    const saved = await create(binding), agent = ctx.agents.get(saved.sessionId);
    if (!agent) fail('CHANNEL_AGENT_UNAVAILABLE', '聊天会话尚未就绪');
    const pending = [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])], history = agent.session?.deriveMessages?.() ?? [];
    const previous = [...pending, ...history].find(message => message.id === messageId);
    if (previous && plainText(previous.content) !== text) fail('CHANNEL_MESSAGE_CONFLICT', '同一个平台消息标识不能对应不同原文');
    if (!previous) agent.followup({ id: messageId, role: 'user', source: { kind: 'user', xiangxuChannel: saved.facts,
      platformMessageId: sourceFacts.messageId ?? sourceFacts.sourceMessageId ?? null, platformSourceAt: Number.isSafeInteger(sourceFacts.sourceAt) ? sourceFacts.sourceAt : null,
      textComplete: sourceFacts.textComplete !== false, unsupportedSegments: Array.isArray(sourceFacts.unsupportedSegments) ? sourceFacts.unsupportedSegments.slice(0, 32) : [] },
      content: [{ type: 'text', text }] });
    const sessions = get(ctx, 'sessions'); if (typeof sessions?.flush !== 'function') fail('CHANNEL_DURABILITY_UNAVAILABLE', '宿主不能确认原生收件箱持久化');
    await sessions.flush(agent.session);
    return { status: 'accepted', messageId, duplicate: Boolean(previous), binding: saved };
  }
  async function closeChannel(binding) {
    const handle = owned.get(binding.sessionId); if (!handle) return;
    const c = await getCoordinator();
    if (c?.memoryRoot === binding.memoryRoot) await c.detachAgent?.(binding.sessionId, handle.agent);
    await handle.dispose?.(); owned.delete(binding.sessionId);
  }
  async function close() {
    await Promise.allSettled([...resolving.values()]);
    for (const [sessionId, handle] of owned) {
      const c = await getCoordinator(); await c?.detachAgent?.(sessionId, handle.agent);
      await handle.dispose?.(); owned.delete(sessionId);
    }
  }
  return { create, send, closeChannel, close };
}

export function externalChannelSessionId({ platform, accountId, conversation, sender }, memoryRoot) {
  return 'xiangxu-social-' + createHash('sha256').update(JSON.stringify([memoryRoot, platform, accountId, conversation.type, conversation.id, sender.id])).digest('hex').slice(0, 40);
}
