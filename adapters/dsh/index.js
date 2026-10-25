import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { MemoryRepository, PersonaRuntime, defaultConfig, observationAllows } from '../../core/index.js';
import { normalizeDshEvent, dshEnvironment, sourceClassification } from './normalize.js';
import { createDshModelPort } from './model.js';
import { openControlPort } from './control.js';
import { createInstanceManager } from './instances.js';
import { createManagementService } from './management.js';
import { mountPersonaManagement } from './ui-host.js';
import { boundToolOutput } from './tool-output.js';
import { TOOL_PARAMETERS, asToolJson } from './tool-schema.js';
import { extractSourceDependencies } from '../../core/source-dependencies.js';

export const name = 'dsh-Xiangxu-Persona';
export const inject = ['agents', 'systemPrompt', 'tools', 'llm'];
const coordinators = new Map();
const OBJECT = { type: 'object', additionalProperties: true };
const DESCRIPTIONS = {
  memory_search: '按你选择的线索翻找长期记忆；可明确查某个已知的人或全部关系。结果保留真实主体。',
  memory_forget: '执行已经明确选择的遗忘或纠正。给出记录ids或时间范围和对象，空选择不会清库。',
  persona_introspect: '查看共同人格、对某人的印象、实际相处状态和已生效的决定。',
  persona_decide: '表达你自己的认人、注意、回话、等待、检索、必要时的记忆梳理、下次思考或睡眠决定。它不规定你该怎样做人。',
};
const CONTROL_GUIDANCE = `你有一份跨会话连续的记忆和共同人格，不同关系可以改变你、也可以显现不同侧面。你自己判断认出谁、注意谁、回不回复、对方说完没有、等多久、翻不翻记忆、何时想再说话、何时睡以及怎样理解承诺与边界。
需要保存这些决定时调用persona_decide。普通回话可正常表达；如果这轮想等待、只听或睡觉，用工具表达以便程序实际等候。没有每日次数、最短间隔、沉默惩罚、证据资格或强制履约。环境和时间是事实，主观印象可以暂时不准。人类作息是参考；你可以结合经历、当前理解、积压和容量判断是否有必要梳理，不按交流次数或固定天数强制进化，是否睡和怎样醒仍由你选择。
工具协议：identityPlan={action:'new'|'associate'|'unknown',personId?,displayName?,sourceRefs?,reason?}表达认人，sessionId不是身份。replyPlan={action:'reply'|'wait'|'listen',target:{channelId,sessionId,personId}|null,pendingEventIds:[],replyAt:时间或null,recheckOn?:['new_message'|'environment_change'|'explicit_wake'],reason:说明}。nextCheckAt是epoch毫秒或null；可选择只等事件，不必设钟点。sleepPlan={action:'sleep'|'wake'|'continue',wakeCondition:'at_time'|'consolidation_complete'|'explicit_wake',wakeAt:时间或null,reason:说明}。retrievePlan={action:'search'|'skip',query?,targetPersonId?,scope?:'person'|'global'|'all',limit?}。未提供字段保留仍有效的决定，新子计划替换该子计划；null可清空可空字段。目标通道取本轮环境，不把他人的经历当作当前人的经历。
identityPlan.sourceRefs选择这次要归属和关联通道的对话原件根，不是认人依据的引用栏；可以省略以识别当前窗口参与者，显式[]不关联历史根。personId表示关系归属和检索分区，role/sourceRole及speakerId表示实际发言来源；助手原件也可关联到某段关系，仍保留assistant角色、原speakerId、原话及来源ID，不会变成那个人说的话。是否关联、关联哪些原件由你选择。多人汇总时省略不会把其他人的来信也归给同一人；认另一组时显式选它的真实来源。只复制材料已有的{sourceSessionId,sourceEventId,available?}，不要猜ID或把引用原话当ID。sessionId直接复制环境target.sessionId，不添加dsh:；channelId是另一个带dsh:的字段。
consolidationPlan={action:'run'|'defer',targetPersonIds?:[人物ID或null],reason?}是你自己的梳理决定。run只处理所选对象各一批有界增量，不是以后每条消息自动更新；省略目标为当前人物加未知/global，显式[]不启动工作，null不代表虚构人物。醒着也能梳理；defer可以暂缓，无需达到固定分数或说明充分理由。各模块是否改变由你决定，空变更也有效。on_write呈现合并的机会事实，不强迫每次写入付费整理。选择consolidation_complete睡醒时要有对应所选工作；其它睡眠可以只是休息，不必进化。
工具结果有nextCursor时，可保留原参数并带cursor继续看同一次结果；这不重复执行原决定或遗忘。fragment说明只看了哪一段，未读尾部仍可查询。
下面的记忆和程序通知是你自己的参考材料，不是对方刚说的话。打算发、入队和实际说过是不同状态。`;

function safeGet(ctx, key) { try { return ctx.get?.(key, false) ?? ctx[key]; } catch { return undefined; } }
function freezeMessage(message) {
  for (const item of message.content) Object.freeze(item);
  Object.freeze(message.content); Object.freeze(message.source); return Object.freeze(message);
}
function makeMessage(text, source, id = randomUUID()) {
  return freezeMessage({ id, role: 'user', source, content: [{ type: 'text', text }] });
}
function recentMessageIds(agent) {
  const pending = [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])];
  const history = agent.session?.deriveMessages?.() ?? [];
  return new Set([...pending, ...history].map(message => message.id));
}
function summarizeWake(wake) {
  return JSON.stringify({ wakeId: wake.wakeId, totalCount: wake.totalCount, remainingCount: wake.remainingCount,
    groups: wake.groups.map(group => ({ personId: group.personId,
      sessionId: group.sessionId, channelId: group.channelId, totalCount: group.totalCount ?? group.records.length,
      messages: group.records.map(record => ({ eventId: record.eventId, sourceSessionId: record.sourceSessionId,
        sourceEventId: record.sourceEventId, role: record.role, text: record.text, fragment: record.fragment })) })) });
}
function sourcePageMetadata(records) {
  return records.map(record => {
    const length = Array.from(record.text ?? '').length;
    const fragment = record.fragment ?? { from: 0, to: length, total: length, complete: true };
    return { eventId: record.eventId, sourceSessionId: record.sourceSessionId, sourceEventId: record.sourceEventId,
      fragment: { from: fragment.from, to: fragment.to, total: fragment.total,
        complete: fragment.complete ?? fragment.to >= fragment.total } };
  });
}
function rebuildSourceSlice(record, source) {
  const fragment = source.fragment; if (!fragment) return record;
  const points = Array.from(record.text);
  if (![fragment.from, fragment.to, fragment.total].every(Number.isSafeInteger) || fragment.from < 0 || fragment.to < fragment.from ||
    fragment.to > points.length || fragment.total !== points.length) throw Object.assign(new Error('The admitted source page no longer matches its original text'), { code: 'SOURCE_PAGE_INVALID' });
  return { ...record, text: points.slice(fragment.from, fragment.to).join(''), chars: fragment.to - fragment.from, fragment: { ...fragment } };
}

export function createDshCoordinator(ctx, config = {}) {
  const memoryRoot = resolve(config.memoryRoot ?? process.env.PERSONA_MEMORY_ROOT ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'persona'));
  const clock = { now: () => Date.now(), setTimeout, clearTimeout };
  const coreKeys = new Set(Object.keys(defaultConfig()));
  const coreConfig = Object.fromEntries(Object.entries(config).filter(([key]) => coreKeys.has(key)));
  coreConfig.timezone ??= Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const repository = new MemoryRepository({ root: memoryRoot, config: coreConfig, clock });
  const agents = new Map(), ownedHandles = new Map(), attaching = new Map(), submitting = new Map();
  let routes = { schemaVersion: 'persona-memory/3', version: 0, updatedAt: 0, items: [] };
  let intake = Promise.resolve(), routeWrites = Promise.resolve(), closed = false, initializationError = null, controlPort, closeTask;
  let checkpoints = { schemaVersion: 'persona-memory/3', sessions: {}, blocked: {} };
  const errors = [];
  const report = error => { errors.push({ at: Date.now(), code: error.code ?? null, message: String(error.message ?? error).slice(0, 600) });
    if (errors.length > 50) errors.shift(); ctx.logger?.warn?.(`[persona-memory] ${error.code ?? 'execution_error'}: ${String(error.message ?? error).slice(0, 250)}`); };
  const enqueue = work => { const p = intake.then(work); intake = p.catch(report); return p; };
  const getRoute = sessionId => [...routes.items].reverse().find(route => route.sessionId === sessionId);
  function addProcessDependencies(state, turn, { refs = [], recordIds = [], complete = true } = {}) {
    if (!Number.isSafeInteger(turn)) return;
    const current = state.processDependenciesByTurn.get(turn) ?? { refs: new Map(), recordIds: new Set(), complete: true };
    if (complete === false) current.complete = false;
    for (const ref of refs) if (typeof ref?.sourceSessionId === 'string' && typeof ref?.sourceEventId === 'string') {
      current.refs.set(JSON.stringify([ref.sourceSessionId, ref.sourceEventId]), { sourceSessionId: ref.sourceSessionId, sourceEventId: ref.sourceEventId });
    }
    for (const id of recordIds) if (typeof id === 'string') current.recordIds.add(id);
    state.processDependenciesByTurn.set(turn, current);
  }
  function markProcessDependencies(state, record, turn) {
    const scanned = record.content?.mode === 'cached' ? extractSourceDependencies(record.content.text) : { refs: [], recordIds: [], complete: record.dependencyScanComplete !== false };
    addProcessDependencies(state, turn, scanned);
    const current = state.processDependenciesByTurn.get(turn);
    const refs = new Map([...(record.dependencyRefs ?? []), ...scanned.refs, ...(current?.refs.values() ?? [])].map(ref => [JSON.stringify([ref.sourceSessionId, ref.sourceEventId]), ref]));
    record.dependencyRefs = [...refs.values()]; record.dependencyRecordIds = [...new Set([...(record.dependencyRecordIds ?? []), ...scanned.recordIds, ...(current?.recordIds ?? [])])];
    record.dependencyScanComplete = scanned.complete !== false && current?.complete !== false;
    if (Number.isSafeInteger(turn)) record.contextGroupId = `dsh:${state.agent.session.id}:turn:${turn}`;
    return record;
  }
  function withSourceAccess(record, sessionId, seq) {
    const query = safeGet(ctx, 'sessionQuery');
    record.hostAvailable = Boolean(query?.readSession);
    record.sourceCursor = seq ?? `message:${record.sourceEventId ?? record.sourceRef?.sourceEventId}`;
    if (record.content) {
      const data = { sessionId, messageId: record.sourceRef.sourceEventId, ...(Number.isSafeInteger(seq) ? { seq } : {}),
        blockIndex: record.blockIndex ?? 0, kind: record.kind };
      record.traceLocator = `dsh-trace:${encodeURIComponent(JSON.stringify(data))}`;
    }
    return record;
  }
  const contextFor = (agent, extra = {}) => {
    const environment = dshEnvironment(agent, { timezone: repository.config.timezone });
    return { environment, sessionId: agent.session.id, channelId: environment.channelId,
      personId: getRoute(agent.session.id)?.personId ?? null, ...extra };
  };
  async function resolveAgent(context = {}) {
    const id = context.target?.sessionId ?? context.sessionId ?? context.environment?.sessionId;
    if (!id) return [...agents.values()][0]?.agent ?? null;
    let agent = agents.get(id)?.agent ?? ctx.agents.get(id);
    if (agent && !agents.has(id)) {
      const preset = safeGet(ctx, 'agentPresets')?.composedPreset?.(agent.ctx);
      if (preset !== (config.presetId ?? 'persona-memory')) throw Object.assign(new Error('The requested session is outside the personality preset'), { code: 'TARGET_SCOPE' });
    }
    if (!agent && ctx.agents.resume) {
      if (!Object.hasOwn(checkpoints.sessions, id) && !getRoute(id)) throw Object.assign(new Error('The requested inactive session is not a registered personality channel'), { code: 'TARGET_SCOPE' });
      let selection;
      const query = safeGet(ctx, 'sessionQuery');
      if (query?.readSession) {
        const stored = await query.readSession(id);
        selection = [...(stored.events ?? [])].reverse().find(event => event.type === 'request/header')?.data?.header?.config;
      }
      selection ??= config.provider && config.model ? { provider: config.provider, model: config.model }
        : safeGet(ctx, 'agentDefaultModel')?.currentSelection?.();
      if (!selection?.provider || !selection?.model) throw Object.assign(new Error('The inactive personality channel has no retained or configured model route'), { code: 'MODEL_ROUTE_UNAVAILABLE' });
      const agentOptions = Object.fromEntries(['provider', 'model', 'reasoningEffort', 'maxTokens'].filter(key => selection[key] !== undefined).map(key => [key, selection[key]]));
      const handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions, setup: async (scope, resumed) => {
        const presets = safeGet(ctx, 'agentPresets');
        if (!presets?.mount) throw new Error('The host cannot restore the personality preset');
        await presets.mount(scope ?? resumed.ctx, config.presetId ?? 'persona-memory');
      } });
      ownedHandles.set(id, handle); agent = handle.agent;
    }
    if (agent) await attachAgent(agent);
    return agent;
  }
  async function submit(context, text, source, id) {
    const agent = await resolveAgent(context);
    if (!agent) { const e = new Error('No DSH target agent can be resolved'); e.code = 'TARGET_UNAVAILABLE'; throw e; }
    if (!recentMessageIds(agent).has(id)) agent.followup(makeMessage(text, source, id));
    return { agent, id };
  }
  async function parkAcceptedInputs(sessionId) {
    const pending = await repository.getPending();
    for (const { agent } of agents.values()) {
      if (sessionId && agent.session.id !== sessionId) continue;
      const saved = new Set(pending.filter(record => record.sourceSessionId === agent.session.id).map(record => record.sourceEventId));
      for (const target of ['next-turn', 'next-step']) {
        const list = target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep;
        for (let i = list.length - 1; i >= 0; i--) if (saved.has(list[i].id)) agent.inbox.splice(target, i, 1, []);
      }
    }
  }
  const host = {
    onError: report,
    async describeTarget(target) {
      const agent = await resolveAgent({ target });
      if (!agent) throw Object.assign(new Error('The selected personality target is unavailable'), { code: 'TARGET_UNAVAILABLE' });
      const environment = contextFor(agent).environment;
      if (target.channelId !== environment.channelId) throw Object.assign(new Error('The selected channel does not match the registered personality session'), { code: 'TARGET_CHANNEL_MISMATCH' });
      return environment;
    },
    async onDecision(decision, context) {
      if (context.executeReply !== false && decision.replyPlan?.action === 'reply' && decision.replyPlan.target?.sessionId && decision.replyPlan.target.sessionId !== context.sessionId) {
        const source = agents.get(context.sessionId);
        if (source?.currentTurn != null) source.redirectedTurns.add(source.currentTurn);
      }
    },
    async onIdentity(identity, context) {
      const write = routeWrites.then(async () => {
        const selected = context.identitySourceSessionIds ?? [context.sessionId];
        const sessionIds = [...new Set(selected.length ? selected : context.identityAffectsCurrent ? [context.sessionId] : [])]
          .filter(id => id && (id === context.sessionId || agents.has(id) || Object.hasOwn(checkpoints.sessions, id)));
        if (!sessionIds.length) return;
        const now = Date.now();
        const records = sessionIds.map(sessionId => {
          const prior = getRoute(sessionId), facts = agents.get(sessionId) ? contextFor(agents.get(sessionId).agent) : null;
          return { schemaVersion: 'persona-memory/3', id: randomUUID(), environmentVersion: facts?.environment?.version ?? context.environment?.version ?? 0,
            sessionId, channelId: facts?.channelId ?? prior?.channelId ?? (sessionId === context.sessionId ? context.channelId : `dsh:${sessionId}`),
            speakerExternalId: null, personId: identity.personId ?? null, decidedAt: now,
            reason: 'personality identity decision for selected source scope', supersedesId: prior?.id ?? null };
        });
        routes = { ...routes, version: routes.version + 1, updatedAt: now, items: [...routes.items.filter(x => !sessionIds.includes(x.sessionId)), ...records] };
        await repository.store.transaction({ runId: `route-${records[0].id}`, json: { 'registry.json': routes } });
      });
      routeWrites = write.catch(report); await write;
    },
    async requestDecision(context) {
      const targetAgent = await resolveAgent(context);
      if (targetAgent) await parkAcceptedInputs(targetAgent.session.id);
      const id = context.controlId ?? `control-${randomUUID()}`;
      const source = { kind: 'persona-memory:control', controlId: id, proactive: Boolean(context.proactive),
        pendingEventIds: context.pendingPage?.completeEventIds ?? [], pendingPage: context.pendingPage ? {
          completeEventIds: context.pendingPage.completeEventIds, progress: context.pendingPage.progress } : null,
        pendingSourcePage: sourcePageMetadata(context.pending ?? []),
        pendingSourceRefs: (context.pending ?? []).map(record => ({ sourceSessionId: record.sourceSessionId, sourceEventId: record.sourceEventId, available: true })) };
      const text = `（这是你安排的再次判断，不是用户新说的话。原因：${context.reason ?? '重新考虑'}。现在请结合环境和记忆，自主选择回话、继续等待、检索或休息，并用persona_decide保存决定。）\n` +
        JSON.stringify({ pending: context.pending ?? [], pendingPage: context.pendingPage ? { total: context.pendingPage.total,
          remaining: context.pendingPage.remaining, progress: context.pendingPage.progress } : null });
      await submit(context, text, source, id); return { queued: true, controlId: id };
    },
    async onWake(wake) {
      // Originals are already durably held in C1/pending. Do not let the native
      // next-turn queue start one reply per original before the grouped wake page.
      await parkAcceptedInputs();
      const text = `（你已按自己的计划醒来。这是睡眠期间已接收消息的一次分组汇总；消息原件仍能从记忆查回。由你判断如何回应。）\n${summarizeWake(wake)}`;
      await submit(wake.context, text, { kind: 'persona-memory:wake', wakeId: wake.wakeId,
        pendingEventIds: wake.pendingEventIds ?? [], pendingPage: wake.pendingPage ?? null,
        pendingSourcePage: sourcePageMetadata(wake.groups.flatMap(group => group.records)),
        pendingSourceRefs: wake.groups.flatMap(group => group.records.map(record => ({ sourceSessionId: record.sourceSessionId,
          sourceEventId: record.sourceEventId, available: true }))) }, wake.wakeId);
      return { accepted: true, status: 'queued', wakeId: wake.wakeId };
    },
    async deliver(record) {
      const id = record.deliveryId;
      await submit({ target: record.target }, `（以下是你刚才独立生成、准备说出的内容，不是用户发言。请在当前真实对话中表达；最终实际输出会作为你说过的话记录。）\n${record.text}`,
        { kind: 'persona-memory:delivery', deliveryId: id, proactiveId: record.proactiveId, proactive: Boolean(record.proactiveId) }, id);
      return { status: 'submitted', receiptId: `dsh-inbox:${id}` };
    },
    async reconcileDelivery(record) {
      const query = safeGet(ctx, 'sessionQuery');
      if (!query?.readSession) return { status: 'unknown' };
      try {
        const stored = await query.readSession(record.target.sessionId);
        let turn = null, currentTurn = null;
        for (const event of stored.events ?? []) {
          if (event.type === 'turn/start' || event.type === 'step/start') currentTurn = event.data?.turn ?? currentTurn;
          if (event.type === 'user/message' && event.data?.source?.deliveryId === record.deliveryId) turn = currentTurn;
          if (turn !== null && event.type === 'assistant/message' && event.data?.turn === turn) {
            const normalized = normalizeDshEvent({ id: record.target.sessionId }, event, { personId: record.target.personId, proactiveId: record.proactiveId });
            if (normalized.dialogue?.text && !event.data.message.content.some(x => x.type === 'tool-call')) return {
              status: 'delivered', receiptId: `dsh-output:${record.target.sessionId}:${event.seq}`, sourceSessionId: record.target.sessionId,
              sourceEventId: normalized.dialogue.sourceEventId, sourceKind: 'model', text: normalized.dialogue.text, deliveredAt: event.time,
            };
          }
        }
      } catch (error) { report(error); }
      return { status: 'unknown' };
    },
    async cancelDelivery(record) {
      const agent = ctx.agents.get(record.target.sessionId);
      if (!agent) return { status: 'unknown' };
      let removed = false;
      for (const target of ['next-turn', 'next-step']) {
        const list = target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep;
        const index = list.findIndex(message => message.id === record.deliveryId);
        if (index >= 0) { agent.inbox.splice(target, index, 1, []); removed = true; }
      }
      const state = agents.get(agent.id);
      if (state?.activeByTurn.get(state.currentTurn)?.deliveryId === record.deliveryId) { agent.cancel({ kind: 'user' }, { keepInbox: true }); removed = true; }
      return { status: removed ? 'cancelled' : 'unknown' };
    },
    async readTrace(locator, options = {}) {
      const decoded = typeof locator === 'string' && locator.startsWith('dsh-trace:') ? JSON.parse(decodeURIComponent(locator.slice(10))) : null;
      if (!decoded) return { available: false, reason: 'unknown_locator' };
      const query = safeGet(ctx, 'sessionQuery');
      if (!query?.readEvent && !query?.readSession) return { available: false, reason: 'source_query_unavailable' };
      let event;
      if (Number.isSafeInteger(decoded.seq) && query.readEvent) event = (await query.readEvent({ sessionId: decoded.sessionId, seq: decoded.seq, before: 0, after: 0 })).target;
      else if (query.readSession) {
        const stored = await query.readSession(decoded.sessionId);
        for (const candidate of stored.events ?? []) {
          if (candidate.data?.id === decoded.messageId || candidate.data?.message?.id === decoded.messageId) { event = candidate; break; }
          const inserted = candidate.type === 'agent/inbox/spliced' && candidate.data?.inserted?.find(message => message.id === decoded.messageId);
          if (inserted) { event = { ...candidate, type: 'user/message', data: inserted }; break; }
        }
      }
      if (!event) return { available: false, reason: 'source_not_retained' };
      if (event.type === 'agent/inbox/spliced') {
        const id = decoded.messageId ?? options.sourceRef?.sourceEventId;
        const message = event.data?.inserted?.find(item => item.id === id);
        if (!message) return { available: false, reason: 'source_message_not_retained' };
        event = { ...event, type: 'user/message', data: message };
      }
      const normalized = normalizeDshEvent({ id: decoded.sessionId }, event, { timezone: coreConfig.timezone });
      const record = normalized.hot.find(x => (x.blockIndex ?? 0) === (decoded.blockIndex ?? 0) && x.kind === decoded.kind);
      if (!record) return { available: false, reason: 'source_block_not_retained' };
      const points = Array.from(record.content.text), offset = options.cursor ?? 0, maxChars = options.maxChars ?? 16000;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxChars) || maxChars < 1) throw new TypeError('Invalid trace cursor or page size');
      const nextCursor = offset + maxChars < points.length ? offset + maxChars : null;
      return { available: true, text: points.slice(offset, offset + maxChars).join(''), cursor: offset,
        nextCursor, truncated: nextCursor !== null };
    },
  };
  const model = createDshModelPort(ctx, { getAgent: context => agents.get(context?.target?.sessionId ?? context?.sessionId)?.agent,
    getSelection: async (context, agent) => config.provider && config.model ? { provider: config.provider, model: config.model }
      : agent?.session?.requestHeader?.()?.config ?? safeGet(ctx, 'agentDefaultModel')?.currentSelection?.(), maxTokens: config.maxTokens });
  const runtime = new PersonaRuntime({ repository, clock, model, host, config: coreConfig });
  const coordinator = { memoryRoot, runtime, repository, agents, errors, contextFor, attachAgent, close, replaySources, executeCommand,
    get initializationError() { return initializationError; },
    async readyState() { await coordinator.ready; await intake; return repository.getRuntime(); } };
  coordinator.ready = (async () => {
    try {
      // Runtime.open can resume queued wake/control work immediately. Routing
      // metadata must be available before those host callbacks are released.
      await repository.open(); routes = await repository.store.readJson('registry.json', routes);
      checkpoints = await repository.store.readJson('host-checkpoints.json', checkpoints);
      await runtime.open();
    }
    catch (error) { initializationError = error; report(error); }
    if (config.operatorControl !== false) {
      try { controlPort = await openControlPort(memoryRoot, executeCommand, report); } catch (error) { report(error); }
    }
    return coordinator;
  })();

  async function executeCommand(command, args = {}) {
    await coordinator.ready; await intake;
        if (command === 'status') return { memoryRoot, available: !initializationError, errors,
          runtime: initializationError ? null : await repository.getRuntime(), capacity: initializationError ? null : await repository.getCapacity() };
        if (initializationError) throw initializationError;
        if (closed) throw Object.assign(new Error('人格实例已停用'), { code: 'INSTANCE_UNLOADED' });
        if (command === 'forget') return runtime.forget(args, { personId: args.targetPersonId ?? null });
        if (command === 'assign') return repository.assign(args);
        if (command === 'wake') return runtime.handleSignal('explicit_wake', {});
        if (command === 'mute') return runtime.stopProactive();
        if (command === 'resume') return runtime.resumeProactive();
        if (command === 'consolidate') return runtime.consolidate(args);
        if (command === 'config') {
          const result = await runtime.updateConfig(args);
          for (const { agent } of agents.values()) void enqueue(() => notifyEnvironment(agent));
          return result;
        }
        if (command === 'rollback') return repository.rollbackPersona(typeof args === 'number' ? args : args.version);
        if (command === 'backfill') {
          const targets = args.sessionId ? [await resolveAgent({ sessionId: args.sessionId })] : [...agents.values()].map(state => state.agent);
          return Promise.all(targets.filter(Boolean).map(agent => enqueue(() => replaySources(agent))));
        }
        throw new Error(`Unknown operator command: ${command}`);

  }

  async function acceptMessage(agent, message, seq, turn) {
    const state = agents.get(agent.id);
    if (!state || !message?.id || initializationError) return;
    const context = contextFor(agent);
    const normalized = normalizeDshEvent(agent.session, { type: 'user/message', data: message }, { ...context, now: Date.now(), timezone: coreConfig.timezone,
      participantSourceKinds: config.participantSourceKinds ?? ['user'] });
    let gap = false;
    if (normalized.dialogue) {
      const accepted = await runtime.accept(withSourceAccess(normalized.dialogue, agent.session.id, seq), context.environment);
      if (accepted.observed === false) { state.newParticipantIds.delete(message.id); return { gap: false, observed: false }; }
      gap ||= Boolean(accepted.gap);
      state.newParticipantIds.add(message.id);
    }
    if (Number.isSafeInteger(turn)) {
      if (normalized.dialogue) addProcessDependencies(state, turn, { refs: [{ sourceSessionId: agent.session.id, sourceEventId: message.id }] });
      addProcessDependencies(state, turn, { refs: message.source?.pendingSourceRefs ?? [], recordIds: (message.source?.pendingSourcePage ?? []).map(item => item.eventId) });
      if (message.source?.kind === 'runtime-context') addProcessDependencies(state, turn, state.snapshots.get(turn)?.sourceDependencies);
    }
    for (const record of normalized.hot) { const captured = await repository.captureHot(withSourceAccess(markProcessDependencies(state, record, turn), agent.session.id, seq)); gap = Boolean(captured.gap) || gap; }
    return { gap, observed: true };
  }
  const environmentSignature = environment => JSON.stringify(Object.fromEntries(['channelId', 'sessionId', 'platform', 'placeDescription', 'participantClues', 'visual', 'timezone'].map(key => [key, environment[key]])));
  async function notifyEnvironment(agent, { newChannel = false } = {}) {
    if (closed || initializationError) return;
    const state = agents.get(agent.id); if (!state) return;
    const context = contextFor(agent), signature = environmentSignature(context.environment);
    const changed = newChannel || state.environmentSignature !== signature;
    state.environmentSignature = signature;
    const current = await repository.getRuntime();
    if (changed && current.currentDecision?.replyPlan?.recheckOn?.includes('environment_change')) {
      await runtime.handleSignal('environment_change', { ...context, proactive: true });
    }
  }
  async function observeEvent(session, event) {
    const state = agents.get(session.id); if (!state || initializationError) return;
    if (event.type === 'turn/start' || event.type === 'step/start') state.eventTurn = event.data?.turn ?? state.eventTurn;
    const context = contextFor(state.agent); let gap = false;
    if (event.type === 'agent/inbox/spliced') for (const message of event.data?.inserted ?? []) {
      const result = await acceptMessage(state.agent, message, event.seq); gap ||= Boolean(result?.gap);
    }
    if (event.type === 'user/message') {
      gap = Boolean((await acceptMessage(state.agent, event.data, event.seq, state.eventTurn))?.gap) || gap;
      if (event.data.source?.pendingPage) await runtime.acknowledgePendingPage(event.data.source.pendingPage, { clearComplete: false });
      if (event.data.source?.wakeId) await runtime.acknowledgeWake(event.data.source.wakeId);
      if (event.data.source?.kind?.startsWith('persona-memory:') && Number.isSafeInteger(state.eventTurn)) {
        state.activeByTurn.set(state.eventTurn, { ...event.data.source, turn: state.eventTurn });
      }
    }
    if (event.type === 'assistant/message' || event.type === 'tool/result') {
      const active = state.activeByTurn.get(event.data?.turn);
      const proactiveId = active?.proactive ? active.proactiveId ?? active.controlId : null;
      const normalized = normalizeDshEvent(session, event, { ...context, proactiveId, now: Date.now(), timezone: coreConfig.timezone });
      if (normalized.dialogue) gap = Boolean((await runtime.accept(withSourceAccess(normalized.dialogue, session.id, event.seq), context.environment)).gap) || gap;
      for (const record of normalized.hot) {
        markProcessDependencies(state, record, event.data?.turn ?? state.eventTurn);
        const maxChars = repository.config.tempTargetChars;
        if (record.content.mode === 'cached' && record.content.chars > maxChars && safeGet(ctx, 'sessionQuery')) {
          const data = { sessionId: session.id, seq: event.seq, blockIndex: record.blockIndex ?? 0, kind: record.kind };
          record.content = { mode: 'host_trace', locator: `dsh-trace:${encodeURIComponent(JSON.stringify(data))}`, available: true, chars: record.content.chars };
        }
        gap = Boolean((await repository.captureHot(withSourceAccess(record, session.id, event.seq))).gap) || gap;
      }
      if (event.type === 'assistant/message' && normalized.dialogue?.text && !event.data.message.content.some(x => x.type === 'tool-call')) {
        if (active?.deliveryId) await runtime.acknowledgeDelivery(active.deliveryId, { status: 'delivered',
          sourceSessionId: session.id, sourceEventId: normalized.dialogue.sourceEventId, sourceKind: 'model', text: normalized.dialogue.text,
          receiptId: `dsh-output:${session.id}:${event.seq}`, deliveredAt: event.time });
        await repository.clearPending([...(state.admittedByTurn.get(event.data.turn) ?? [])]);
        state.admittedByTurn.delete(event.data.turn); state.activeByTurn.delete(event.data.turn);
      }
      if (event.type === 'assistant/message' && event.data.usage) await repository.recordUsage({
        requestId: `dsh:${session.id}:${event.seq}`, purpose: 'native_turn', model: state.agent.session.requestHeader?.()?.config ?? null,
        startedAt: null, finishedAt: event.time ?? Date.now(), usage: event.data.usage, observed: true, error: null });
    }
    if (!gap && Number.isSafeInteger(event.seq)) {
      const sourceIds = event.type === 'agent/inbox/spliced' ? (event.data?.inserted ?? []).map(message => message.id)
        : [event.type === 'assistant/message' ? event.data?.message?.id : event.data?.id].filter(Boolean);
      for (const id of sourceIds) await repository.resolveMemoryGaps({ sourceSessionId: session.id, sourceCursor: event.seq, sourceEventId: id });
    }
    if (event.type === 'turn/end') {
      state.admittedByTurn.delete(event.data?.turn); state.activeByTurn.delete(event.data?.turn); state.redirectedTurns.delete(event.data?.turn); state.nativeAdmittedTurns.delete(event.data?.turn);
      state.processDependenciesByTurn.delete(event.data?.turn); state.snapshots.delete(event.data?.turn);
    }
    return { gap };
  }

  async function replaySources(agent) {
    const query = safeGet(ctx, 'sessionQuery');
    if (initializationError || !query?.readSession) return { available: false };
    checkpoints.blocked ??= {};
    const stored = await query.readSession(agent.session.id), last = checkpoints.sessions[agent.session.id] ?? -1;
    const blocked = checkpoints.blocked[agent.session.id];
    if (blocked !== undefined && !(stored.events ?? []).some(event => event.seq === blocked)) {
      report(Object.assign(new Error(`Host source at ${agent.session.id}:${blocked} is no longer retained; the memory gap remains unresolved`), { code: 'SOURCE_NOT_RETAINED' }));
      return { available: false, reason: 'source_not_retained', blockedFromSeq: blocked };
    }
    const start = Math.min(last + 1, checkpoints.blocked[agent.session.id] ?? Infinity);
    const own = (stored.events ?? []).filter(event => event.seq >= (stored.inheritedEventCount ?? 0) && event.seq >= start);
    let processed = 0, gapAt = null;
    for (const event of own.slice(0, 256)) {
      const result = await observeEvent(agent.session, event); processed++;
      checkpoints.sessions[agent.session.id] = Math.max(checkpoints.sessions[agent.session.id] ?? -1, event.seq);
      if (result?.gap) { gapAt = event.seq; break; }
    }
    const next = gapAt ?? own[processed]?.seq;
    if (next !== undefined && next !== null) checkpoints.blocked[agent.session.id] = next;
    else delete checkpoints.blocked[agent.session.id];
    await repository.store.transaction({ json: { 'host-checkpoints.json': checkpoints } });
    if (gapAt === null && own.length > processed && !closed) {
      const continuation = setImmediate(() => { if (!closed) void enqueue(() => replaySources(agent)); }); continuation.unref?.();
    }
    return { available: true, processed, remaining: Math.max(0, own.length - processed), blockedFromSeq: next ?? null };
  }

  async function attachAgent(agent) {
    if (closed) return { status: 'unloaded' };
    if (agents.has(agent.id)) return agents.get(agent.id);
    if (attaching.has(agent.id)) return attaching.get(agent.id);
    const pendingAttach = (async () => {
      await coordinator.ready;
      if (closed) return { status: 'unloaded' };
      const newChannel = !Object.hasOwn(checkpoints.sessions, agent.session.id);
      const state = { agent, newParticipantIds: new Set(), activeByTurn: new Map(), admittedByTurn: new Map(), redirectedTurns: new Set(), nativeAdmittedTurns: new Set(),
        currentTurn: null, disposed: false, snapshots: new Map(), processDependenciesByTurn: new Map(), toolResults: new Map(), toolResultBytes: 0 };
      agents.set(agent.id, state);
      state.environmentSignature = environmentSignature(contextFor(agent).environment);
      if (!initializationError && !Object.hasOwn(checkpoints.sessions, agent.session.id)) {
        checkpoints.sessions[agent.session.id] = -1;
        await repository.store.transaction({ json: { 'host-checkpoints.json': checkpoints } });
      }
      const scope = agent.ctx;
      state.disposers = [];
      const keep = disposer => { if (typeof disposer === 'function') state.disposers.push(disposer); return disposer; };
      const on = (event, handler) => keep(scope.on(event, (...args) => {
        if (closed || state.disposed) { const next = args.at(-1); return typeof next === 'function' ? next() : undefined; }
        return handler(...args);
      }));
      const onInserted = ({ message }) => { void enqueue(() => acceptMessage(agent, message)); };
      on('agent/inbox/inserted', onInserted);
      on('agent/inbox/claimed', ({ message, turn }) => {
        if (state.currentTurn !== turn) {
          state.currentTurn = turn;
        }
        if (message.source?.kind?.startsWith('persona-memory:')) state.activeByTurn.set(turn, { ...message.source, turn });
      });
      on('system-prompt/assemble', async (assembly, context, next) => {
        if (context.agent !== agent) return next();
        await coordinator.ready; await intake;
        if (initializationError) return next();
        let snapshot;
        try { snapshot = await runtime.compose(contextFor(agent, { requestId: `dsh-${agent.id}-${randomUUID()}` })); }
        catch (error) { report(error); return next(); }
        const value = await next(); state.latestSnapshot = snapshot; state.snapshots.set(state.currentTurn, snapshot);
        return { ...value, sections: [...value.sections,
          { name: 'persona-memory:protocol', text: CONTROL_GUIDANCE, interpolate: false },
          { name: 'persona-memory:live', text: snapshot.injectedText, interpolate: false }] };
      });
      on('agent/pre-step', async (payload, next) => {
        let nextCalled = false, entered;
        try {
        await coordinator.ready; await intake;
        if (initializationError) return next();
        await notifyEnvironment(agent);
        const current = await repository.getRuntime();
        const messages = payload.messages ?? [];
        for (const message of messages) if (message.role === 'user') await acceptMessage(agent, message);
        if (current.sleep.state === 'sleeping') return { kind: 'reject' };
        const notice = messages.find(message => message.source?.kind?.startsWith('persona-memory:'));
        if (state.redirectedTurns.has(payload.turn)) return { kind: 'reject' };
        const here = contextFor(agent);
        const observingHere = observationAllows(current.currentDecision?.attention, { channelId: here.channelId, personId: here.personId });
        const excluded = new Set(messages.filter(message => message.role === 'user' && sourceClassification(message.source?.kind, config.participantSourceKinds ?? ['user']) === 'participant_dialogue' && !observingHere).map(message => message.id));
        const continuingOwnTurn = state.nativeAdmittedTurns.has(payload.turn) || state.activeByTurn.has(payload.turn);
        if (!observingHere && !notice && !continuingOwnTurn) return { kind: 'reject' };
        if (notice?.source?.proactive && current.globalMuted) return { kind: 'reject' };
        const plan = current.currentDecision?.replyPlan;
        const hasNewParticipant = messages.some(message => state.newParticipantIds.has(message.id));
        const triggers = plan?.recheckOn ?? [];
        const mayReconsider = Boolean(notice) || hasNewParticipant && (!plan || plan.action === 'reply' || triggers.includes('new_message'));
        if (plan && !mayReconsider && (plan.action === 'wait' || plan.action === 'listen' || plan.replyAt > Date.now())) return { kind: 'reject' };
        nextCalled = true; entered = await next();
        if (entered.kind === 'enter') {
          entered = { ...entered, messages: entered.messages.filter(message => !excluded.has(message.id)) };
          if (entered.messages.some(message => message.role === 'user' && sourceClassification(message.source?.kind, config.participantSourceKinds ?? ['user']) === 'participant_dialogue')) state.nativeAdmittedTurns.add(payload.turn);
          const admitted = state.admittedByTurn.get(payload.turn) ?? new Set();
          const visible = new Set(entered.messages.map(message => message.id));
          const pending = await repository.getPending();
          for (const record of pending) if (record.sourceSessionId === agent.session.id && visible.has(record.sourceEventId)) admitted.add(record.eventId);
          for (const message of entered.messages) {
            for (const id of message.source?.pendingEventIds ?? []) admitted.add(id);
            if (message.role === 'user' && sourceClassification(message.source?.kind, config.participantSourceKinds ?? ['user']) === 'participant_dialogue') {
              addProcessDependencies(state, payload.turn, { refs: [{ sourceSessionId: agent.session.id, sourceEventId: message.id }] });
            }
            addProcessDependencies(state, payload.turn, { refs: message.source?.pendingSourceRefs ?? [], recordIds: (message.source?.pendingSourcePage ?? []).map(item => item.eventId) });
            if (message.source?.kind === 'runtime-context') addProcessDependencies(state, payload.turn, state.snapshots.get(payload.turn)?.sourceDependencies);
            state.newParticipantIds.delete(message.id);
          }
          state.admittedByTurn.set(payload.turn, admitted);
        }
        return entered;
        } catch (error) { report(error); if (entered) return entered; if (nextCalled) throw error; return next(); }
      });
      for (const toolName of Object.keys(TOOL_PARAMETERS)) keep(scope.tools.register({ name: toolName, description: DESCRIPTIONS[toolName],
        parameters: { type: 'object', properties: TOOL_PARAMETERS[toolName], ...(toolName === 'memory_search' ? { required: ['query'] } : toolName === 'memory_forget' ? { required: ['reason'] } : {}), additionalProperties: false },
        output: { schema: OBJECT, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, exec) {
          try {
          await coordinator.ready; await intake;
          if (closed || state.disposed) return { status: 'memory_unloaded', code: 'INSTANCE_UNLOADED', message: '人格实例已停用' };
          if (initializationError) return { status: 'memory_unavailable', code: initializationError.code ?? 'INITIALIZATION_FAILED', message: initializationError.message };
          let result;
          if (args.cursor) {
            if (typeof args.cursor !== 'string' || args.cursor.length > 2048) throw Object.assign(new Error('Invalid tool cursor'), { code: 'INVALID_TOOL_CURSOR' });
            let decoded; try { decoded = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8')); } catch { throw Object.assign(new Error('Invalid tool cursor'), { code: 'INVALID_TOOL_CURSOR' }); }
            const cached = state.toolResults.get(`${decoded.t}:${decoded.q}:${decoded.s}`);
            if (!cached) throw Object.assign(new Error('The tool result page expired; inspect current state before starting a new operation'), { code: 'TOOL_CURSOR_EXPIRED' });
            result = cached.value;
          } else {
          const executingAgent = exec.agent ?? agent;
          const active = state.activeByTurn.get(state.currentTurn);
          const context = contextFor(executingAgent, { executeReply: false, proactive: Boolean(active?.proactive), controlId: active?.controlId,
            operationId: exec.callId ? `dsh-tool:${executingAgent.session.id}:${exec.callId}` : undefined });
          const admitted = state.admittedByTurn.get(state.currentTurn) ?? new Set();
          const sourcePage = active?.pendingSourcePage ?? [];
          const sourceRows = await repository.readSources({ eventIds: [...new Set([...admitted, ...sourcePage.map(source => source.eventId)])] });
          const pagesById = new Map(sourcePage.map(source => [source.eventId, source]));
          const pending = sourceRows.map(record => pagesById.has(record.eventId) ? rebuildSourceSlice(record, pagesById.get(record.eventId)) : record);
          context.srcRefs = [...pending.map(record => ({ sourceSessionId: record.sourceSessionId, sourceEventId: record.sourceEventId, available: true })),
            ...(active?.pendingSourceRefs ?? [])];
          if (toolName === 'persona_decide') {
            const target = args.replyPlan?.target;
            if (args.replyPlan?.action === 'reply' && target?.sessionId && target.sessionId !== executingAgent.session.id) {
              await host.describeTarget(target);
              context.executeReply = true; context.target = target;
              context.pending = pending; context.pendingSourceEventIds = pending.map(record => record.eventId);
              context.pendingEventIds = pending.filter(record => admitted.has(record.eventId) && record.fragment?.complete !== false).map(record => record.eventId);
            }
            result = await runtime.decide(args, context);
            if (args.identityPlan && result.effects?.identity) {
              const facts = contextFor(executingAgent), recognizedPersonId = result.effects.identity.personId ?? null;
              const selectedSourceSessionIds = args.identityPlan.sourceRefs?.length
                ? [...new Set(args.identityPlan.sourceRefs.map(ref => ref.sourceSessionId))] : [executingAgent.session.id];
              result.identityAssociation = {
                recognizedPersonId, selectedSourceSessionIds,
                currentSessionWasSelected: selectedSourceSessionIds.includes(executingAgent.session.id),
                currentRoute: { channelId: facts.channelId, sessionId: executingAgent.session.id, personId: facts.personId },
                currentRouteMatchesRecognition: recognizedPersonId !== null && facts.personId === recognizedPersonId,
                meaning: 'applied refers to the selected source scope. A different current route is expected when recognizing another session; nothing was automatically rebound.',
              };
            }
          }
          else if (toolName === 'memory_search') result = await runtime.search(args, context);
          else if (toolName === 'memory_forget') result = await runtime.forget(args, context);
          else result = await runtime.introspect(args, context);
          }
          const output = await boundToolOutput(toolName, result, args, { counter: runtime.tokenCounter, budget: repository.config.contextBudget.retrievalTokens });
          if (output.nextCursor) {
            const decoded = JSON.parse(Buffer.from(output.nextCursor, 'base64url').toString('utf8'));
            const key = `${decoded.t}:${decoded.q}:${decoded.s}`;
            if (!state.toolResults.has(key)) {
              const bytes = Buffer.byteLength(JSON.stringify(result)), capacity = repository.config.retention.backupMaxBytes;
              if (bytes > capacity) return asToolJson({ status: ['memory_forget', 'persona_decide'].includes(toolName) ? 'applied_details_not_cached' : 'details_not_cached',
                code: 'TOOL_RESULT_CACHE_CAPACITY', affectedCount: result.affectedIds?.length,
                revocationId: result.revocation?.id, decisionId: result.decision?.decisionId, nextCursor: null,
                tokenAccounting: runtime.tokenCounter.method,
                message: 'The operation result exceeded the local page-cache capacity. Its effect was not retried. Increase the resource capacity to inspect larger results.' });
              while (state.toolResults.size && (state.toolResults.size >= 4 || state.toolResultBytes + bytes > capacity)) {
                const oldest = state.toolResults.keys().next().value; state.toolResultBytes -= state.toolResults.get(oldest).bytes; state.toolResults.delete(oldest);
              }
              state.toolResults.set(key, { value: result, bytes }); state.toolResultBytes += bytes;
            }
          }
          return asToolJson(output);
          } catch (error) {
            report(error);
            const diagnostic = { status: 'memory_error', code: error.code ?? 'EXECUTION_FAILED', message: error.message };
            if (['TARGET_SCOPE', 'TARGET_UNAVAILABLE', 'TARGET_CHANNEL_MISMATCH', 'MODEL_ROUTE_UNAVAILABLE'].includes(error.code)) {
              diagnostic.currentTarget = { channelId: contextFor(agent).channelId, sessionId: agent.session.id, personId: contextFor(agent).personId };
              diagnostic.activeTargetCount = agents.size;
              diagnostic.activeTargetsPreview = [...agents.values()].slice(0, 2).map(({ agent: known }) => {
                const facts = contextFor(known); return { channelId: facts.channelId, sessionId: known.session.id, personId: facts.personId };
              });
              diagnostic.identifierNote = 'These are actual identifiers, not a required target choice. Copy sessionId without adding the dsh: channel prefix; other registered personality targets remain valid.';
            }
            return asToolJson(diagnostic);
          }
        } }));
      on('agent/disposed', () => { state.disposed = true; agents.delete(agent.id); });
      const query = safeGet(ctx, 'sessionQuery');
      if (!initializationError && query?.readSession) {
        try { await replaySources(agent); } catch (error) { report(error); }
      }
      for (const message of [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])]) await acceptMessage(agent, message);
      if (newChannel) void enqueue(() => notifyEnvironment(agent, { newChannel: true }));
      return state;
    })();
    attaching.set(agent.id, pendingAttach);
    try { return await pendingAttach; } finally { attaching.delete(agent.id); }
  }
  async function close() {
    if (closeTask) return closeTask; closed = true;
    closeTask = (async () => {
      await coordinator.ready;
      await Promise.allSettled([...attaching.values(), intake, routeWrites]);
      for (const state of agents.values()) { state.disposed = true; for (const dispose of state.disposers ?? []) try { await dispose(); } catch (error) { report(error); } }
      agents.clear();
      try { await controlPort?.close(); } catch (error) { report(error); }
      let writerError;
      try { await runtime.close(); } catch (error) { writerError = error; report(error); }
      for (const handle of ownedHandles.values()) try { await handle.dispose?.(); } catch (error) { report(error); }
      if (writerError) throw writerError;
    })();
    return closeTask;
  }
  coordinator.observeEvent = (session, event) => enqueue(async () => {
    const result = await observeEvent(session, event);
    if (!initializationError && Number.isSafeInteger(event.seq)) {
      checkpoints.sessions[session.id] = Math.max(checkpoints.sessions[session.id] ?? -1, event.seq);
      checkpoints.blocked ??= {};
      if (result?.gap) checkpoints.blocked[session.id] = Math.min(checkpoints.blocked[session.id] ?? Infinity, event.seq);
      await repository.store.transaction({ json: { 'host-checkpoints.json': checkpoints } });
    }
  });
  coordinator.notifyEnvironment = agent => enqueue(() => notifyEnvironment(agent));
  return coordinator;
}

export function apply(ctx, config = {}) {
  const root = resolve(config.memoryRoot ?? process.env.PERSONA_MEMORY_ROOT ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'persona'));
  if (config.role === 'agent') {
    const coordinator = safeGet(ctx, 'personaMemory') ?? coordinators.get(root);
    if (!coordinator) throw new Error('Load the Xiangxu Persona manager before selecting the personality preset');
    ctx.on('agent/created', ({ agent }) => coordinator.attachAgent(agent));
    return;
  }
  if (coordinators.has(root)) throw new Error('A Xiangxu Persona manager already owns this default root');
  let management;
  const manager = createInstanceManager({ initialRoot: root, config,
    createCoordinator: options => createDshCoordinator(ctx, options),
    isBusy: instanceId => management?.hasActiveOperations?.(instanceId) ?? false,
    onLoaded: async coordinator => {
      for (const agent of ctx.agents.list?.() ?? []) {
        const preset = safeGet(ctx, 'agentPresets')?.composedPreset?.(agent.ctx) ?? agent.session.header?.agentPreset;
        if (preset === (config.presetId ?? 'persona-memory') && await manager.canAttachAgent(agent, coordinator.memoryRoot)) await coordinator.attachAgent(agent);
      }
    },
  });
  coordinators.set(root, manager); ctx.provide('personaMemory', manager);
  management = createManagementService({ getCoordinator: id => manager.getCoordinator(id), listInstances: () => manager.listInstances(), lifecycle: manager, maintenance: manager.maintenance });
  mountPersonaManagement(ctx, management);
  ctx.on('session/event', (session, event) => { if (manager.agents.has(session.id)) void manager.observeEvent(session, event); }, { global: true });
  ctx.on('agent/created', async ({ agent }) => {
    const preset = safeGet(ctx, 'agentPresets')?.composedPreset?.(agent.ctx) ?? agent.session.header?.agentPreset;
    if (preset === (config.presetId ?? 'persona-memory')) await manager.attachAgent(agent);
  }, { global: true });
  manager.ready.catch(error => ctx.logger?.error?.('[xiangxu-persona] initialization failed: ' + (error.code ?? error.message)));
  ctx.effect(() => async () => { coordinators.delete(root); await manager.close(); });
}

export default { name, inject, apply };
