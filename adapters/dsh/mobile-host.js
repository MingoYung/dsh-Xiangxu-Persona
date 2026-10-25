import { randomUUID } from 'node:crypto';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const safeGet = (ctx, key) => { try { return ctx.get?.(key, false) ?? ctx[key]; } catch { return undefined; } };
const plainText = content => (Array.isArray(content) ? content : []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
const routeKeys = ['provider', 'model', 'reasoningEffort', 'maxTokens'];
const selectRoute = selection => Object.fromEntries(routeKeys.filter(key => selection?.[key] !== undefined).map(key => [key, selection[key]]));

/** Native DSH channel; exposes participant dialogue only, never a general RPC proxy. */
export function createDshMobileChannelPort({ ctx, getCoordinator, presetId = 'persona-memory', agentOptions } = {}) {
  if (!ctx?.agents || typeof getCoordinator !== 'function') throw new TypeError('DSH agents and getCoordinator are required');
  const handles = new Map(), resolving = new Map();
  const coordinator = async () => {
    const current = await getCoordinator();
    if (!current) fail('MOBILE_INSTANCE_UNLOADED', '请先在电脑端加载人格实例');
    await current.ready;
    if (current.initializationError) fail('MOBILE_INSTANCE_UNAVAILABLE', '人格实例初始化未成功');
    return current;
  };
  const setup = async (scope, agent) => {
    const presets = safeGet(ctx, 'agentPresets');
    if (!presets?.mount) fail('MOBILE_PRESET_UNAVAILABLE', '宿主缺少人格预设服务');
    await presets.mount(scope ?? agent.ctx, presetId);
    // This capability restriction applies to the new phone chat scope only.
    // Scope-local personality/voice tools remain available; global coding tools do not.
    const tools = scope?.tools ?? agent.ctx?.tools;
    if (!tools?.restrict) fail('MOBILE_CHAT_SCOPE_UNAVAILABLE', '宿主不能创建独立普通聊天作用域');
    tools.restrict({ allow: [] });
  };
  async function resolveChannel(channel) {
    const current = await coordinator();
    if (channel.memoryRoot !== current.memoryRoot) fail('MOBILE_INSTANCE_MISMATCH', '此设备绑定的不是当前人格实例');
    let agent = ctx.agents.get(channel.sessionId);
    if (!agent) {
      if (!resolving.has(channel.sessionId)) resolving.set(channel.sessionId, (async () => {
        if (typeof ctx.agents.resume !== 'function') fail('MOBILE_RESUME_UNAVAILABLE', '宿主不能恢复此聊天');
        const handle = await ctx.agents.resume({ resumeSessionId: channel.sessionId, agentOptions: selectRoute(channel.agentOptions), setup });
        handles.set(channel.sessionId, handle);
        return handle.agent;
      })().finally(() => resolving.delete(channel.sessionId)));
      agent = await resolving.get(channel.sessionId);
    }
    await current.attachAgent(agent);
    return { agent, current };
  }
  async function create() {
    const current = await coordinator();
    const selection = selectRoute(agentOptions ?? safeGet(ctx, 'agentDefaultModel')?.currentSelection?.());
    if (!selection.provider || !selection.model) fail('MOBILE_MODEL_ROUTE_UNAVAILABLE', '请先在DSH中配置默认聊天模型');
    const sessionId = 'xiangxu-mobile-' + randomUUID();
    if (typeof ctx.agents.create !== 'function') fail('MOBILE_CREATE_UNAVAILABLE', '宿主不能创建聊天会话');
    const handle = await ctx.agents.create({ sessionId, agentOptions: selection, setup });
    handles.set(sessionId, handle);
    try {
      await current.attachAgent(handle.agent);
      await flush(handle.agent);
      return { sessionId, memoryRoot: current.memoryRoot, agentOptions: selection };
    } catch (error) { handles.delete(sessionId); await handle.dispose?.().catch(() => {}); throw error; }
  }
  async function flush(agent) {
    const sessions = safeGet(ctx, 'sessions');
    if (typeof sessions?.flush !== 'function') fail('MOBILE_DURABILITY_UNAVAILABLE', '宿主不能确认聊天收件箱持久化');
    await sessions.flush(agent.session);
  }
  async function send(channel, { messageId, text, deviceId }) {
    const { agent } = await resolveChannel(channel);
    const pending = [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])];
    const recent = agent.session?.deriveMessages?.() ?? [];
    const existing = [...pending, ...recent].find(message => message.id === messageId);
    if (existing && plainText(existing.content) !== text) fail('MOBILE_REQUEST_CONFLICT', '同一个发送标识不能用于不同原文');
    if (!existing) agent.followup({ id: messageId, role: 'user', source: { kind: 'user', channel: 'xiangxu-mobile', deviceId }, content: [{ type: 'text', text }] });
    await flush(agent);
    return { messageId, status: 'accepted', duplicate: Boolean(existing) };
  }
  async function read(channel, { after, before, until, windowStart, offset = 0, messageIndex = 0, limit = 30, maxChars = 16000, maxBytes = 90000 } = {}) {
    const { agent } = await resolveChannel(channel), query = safeGet(ctx, 'sessionQuery');
    if (typeof query?.readEvent !== 'function') fail('MOBILE_HISTORY_UNAVAILABLE', '宿主缺少分页聊天读取能力');
    const totalEnd = agent.session.seq, history = before !== undefined || until !== undefined;
    if (before !== undefined && after !== undefined || before !== undefined && until !== undefined) fail('MOBILE_CURSOR_INVALID', '旧页与新消息读取位置不能混用');
    const end = before ?? until ?? totalEnd;
    if (!Number.isSafeInteger(end) || end < 0 || end > totalEnd) fail('MOBILE_CURSOR_INVALID', '旧聊天读取边界无效');
    after ??= Math.max(0, end - 128);
    const start = windowStart ?? after;
    if (!Number.isSafeInteger(start) || start < 0 || start > after) fail('MOBILE_CURSOR_INVALID', '聊天窗口起点无效');
    if (!Number.isSafeInteger(end) || !Number.isSafeInteger(after) || after < 0 || after > end || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(messageIndex) || messageIndex < 0 || after === end && (offset || messageIndex) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 16000) fail('MOBILE_CURSOR_INVALID', '聊天读取位置无效');
    let seq = after, bytes = 0, scanned = 0, nextOffset = offset, nextIndex = messageIndex;
    const messages = [];
    outer: while (seq < end && messages.length < limit && scanned < 128) {
      const { target: event } = await query.readEvent({ sessionId: channel.sessionId, seq, before: 0, after: 0 });
      if (!event || event.seq !== seq) fail('MOBILE_HISTORY_GAP', '宿主聊天日志有读取缺口');
      scanned++;
      const candidates = event.type === 'assistant/message' ? [event.data?.message] : event.type === 'user/message' && event.data?.source?.kind === 'user' ? [event.data]
        : event.type === 'agent/inbox/spliced' ? (event.data?.inserted ?? []).filter(message => message.source?.kind === 'user') : [];
      const visible = candidates.filter(message => plainText(message?.content));
      if (nextIndex > visible.length) fail('MOBILE_CURSOR_INVALID', '聊天消息位置失效');
      for (let index = nextIndex; index < visible.length; index++) {
        const message = visible[index], text = plainText(message.content);
        const chars = Array.from(text);
        if (nextOffset > chars.length) fail('MOBILE_CURSOR_INVALID', '聊天片段位置失效');
        const to = Math.min(chars.length, nextOffset + maxChars);
        const row = { id: message.id, seq: seq + 1, role: event.type === 'assistant/message' ? 'assistant' : 'user', text: chars.slice(nextOffset, to).join(''), at: event.time ?? null,
          fragment: { from: nextOffset, to, total: chars.length, complete: to === chars.length } };
        const rowBytes = Buffer.byteLength(JSON.stringify(row));
        if (messages.length && bytes + rowBytes > maxBytes) { nextIndex = index; break outer; }
        if (rowBytes > maxBytes) fail('MOBILE_MESSAGE_CAPACITY', '聊天片段超过单次读取容量');
        messages.push(row); bytes += rowBytes;
        if (to < chars.length) { nextOffset = to; nextIndex = index; break outer; }
        nextOffset = 0; nextIndex = index + 1;
        if (messages.length >= limit && nextIndex < visible.length) break outer;
      }
      if (!visible.length && (nextOffset || nextIndex)) fail('MOBILE_CURSOR_INVALID', '聊天片段对应事件已失效');
      seq++; nextOffset = 0; nextIndex = 0;
    }
    return { messages, nextAfter: seq, nextOffset, nextIndex, hasMore: seq < end, history, windowStart: start, windowEnd: end,
      earlierBefore: start > 0 ? start : null, previousBefore: history && start > 0 ? start : null };
  }
  async function status(channel) {
    const { current, agent } = await resolveChannel(channel), state = await current.repository.getRuntime();
    const sleeping = state.sleep?.state === 'sleeping', plan = state.currentDecision?.replyPlan?.action;
    return { connected: true, displayName: '相续人格', sleep: { state: state.sleep?.state ?? 'awake', wakeCondition: state.sleep?.wakeCondition ?? null, wakeAt: state.sleep?.wakeAt ?? null },
      waiting: sleeping ? 'sleeping' : agent.status === 'running' ? 'thinking' : ['listen', 'wait'].includes(plan) ? 'waiting' : 'ready' };
  }
  async function closeChannel(channel) {
    const handle = handles.get(channel.sessionId); if (!handle) return;
    handles.delete(channel.sessionId); await handle.dispose?.();
  }
  async function close() {
    await Promise.allSettled([...resolving.values()]);
    for (const [id, handle] of handles) { await handle.dispose?.(); handles.delete(id); }
  }
  return { create, send, read, status, closeChannel, close };
}
