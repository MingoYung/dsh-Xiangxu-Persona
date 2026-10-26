import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { acquireTaskWorkerScope, TASK_WORKER_PRESET } from './worker.js';

export { TASK_WORKER_PRESET } from './worker.js';
const workers = new Map();
const get = (ctx, key) => { try { return ctx.get?.(key, false) ?? ctx[key]; } catch { return undefined; } };
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const missing = error => ['SESSION_QUERY_SESSION_NOT_FOUND', 'SESSION_NOT_FOUND', 'ENOENT'].includes(error?.code);
const absentEvent = error => error?.code === 'SESSION_QUERY_EVENT_NOT_FOUND';
const statusOf = result => result?.stopReason === 'completed' ? 'completed' : result?.stopReason === 'aborted' ? 'cancelled' : 'failed';
const copy = value => value === undefined ? undefined : structuredClone(value);

/** A host-owned registry, never populated from message fields or model arguments. */
export function lookupTaskWorker(sessionId) {
  const entry = workers.get(sessionId);
  return entry ? copy(entry.metadata) : null;
}

function validateMetadata(value) {
  if (!value || !id(value.sessionId) || !id(value.taskId) || !id(value.parentSessionId) || value.sessionId === value.parentSessionId) fail('TASK_HOST_BINDING', '任务需要稳定且独立的父子会话标识');
  if (value.workspace !== undefined && value.workspace !== null && (typeof value.workspace !== 'string' || !path.isAbsolute(value.workspace))) fail('TASK_HOST_WORKSPACE', '工作目录必须是绝对路径');
  return { taskId: value.taskId, sessionId: value.sessionId, parentSessionId: value.parentSessionId,
    origin: 'assistant_delegation', workerPresetId: TASK_WORKER_PRESET, workspace: value.workspace ?? null };
}

async function checkedPath(target) {
  const resolved = path.resolve(target); let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) fail('TASK_ARTIFACT_PATH', '任务资料路径不能经过符号链接或目录联接');
  }
  return resolved;
}
const fileIdentity = stat => digest(JSON.stringify(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key]))));

/** Native DSH continuable children, with caller-owned results and exact child IDs.
 * The DSH service retains its own delegated user permission/sandbox policy.
 * A worker preset is a logical tool/process boundary, not an OS sandbox.
 */
export function createDelegationHost({ ctx, workerPresetId = TASK_WORKER_PRESET, provider = 'spawn', maxArtifactFileBytes = 67108864, onError = () => {} } = {}) {
  if (!ctx || workerPresetId !== TASK_WORKER_PRESET || provider !== 'spawn') throw new TypeError('A host context and the independent task worker preset are required');
  if (!Number.isSafeInteger(maxArtifactFileBytes) || maxArtifactFileBytes < 1 || maxArtifactFileBytes > 1073741824) throw new TypeError('Invalid task artifact capacity');
  const owner = { closed: false }, records = new Map(), listeners = new Set(); let closed = false;
  const report = error => { try { onError(error); } catch {} };
  const check = () => { if (closed) fail('TASK_HOST_CLOSED', '任务宿主已关闭'); };
  const emit = entry => {
    if (closed) return;
    const event = { taskId: entry.metadata.taskId, sessionId: entry.metadata.sessionId, status: entry.status ?? 'unknown' };
    for (const listener of listeners) try { Promise.resolve(listener(event)).catch(report); } catch (error) { report(error); }
  };
  function ensureScope(entry, agent) {
    if (!agent || entry.scopedAgent === agent) return;
    entry.releaseScope?.();
    entry.releaseScope = acquireTaskWorkerScope(agent, entry.metadata);
    entry.scopedAgent = agent;
  }
  function registerTask(value) {
    check(); const metadata = validateMetadata(value), previous = workers.get(metadata.sessionId);
    if (previous && previous.owner !== owner && (!previous.owner.closed || previous.metadata.taskId !== metadata.taskId || previous.metadata.parentSessionId !== metadata.parentSessionId)) fail('TASK_SESSION_OWNED', '任务会话已由另一个任务宿主持有');
    let entry = records.get(metadata.sessionId);
    if (entry && (entry.metadata.taskId !== metadata.taskId || entry.metadata.parentSessionId !== metadata.parentSessionId)) fail('TASK_HOST_BINDING', '同一任务会话的真实父级不能改变');
    if (!entry) records.set(metadata.sessionId, entry = { metadata, status: 'unknown', attempted: false });
    else entry.metadata = { ...metadata, workspace: metadata.workspace ?? entry.metadata.workspace };
    if (value.status === 'revoked' || previous?.metadata.revoked === true) { entry.revoked = true; entry.status = 'revoked'; entry.metadata = tombstone(entry, true); }
    workers.set(metadata.sessionId, { owner, metadata: entry.metadata });
    ensureScope(entry, ctx.agents?.get?.(metadata.sessionId)); return copy(entry.metadata);
  }
  function entryFor(sessionId) {
    check(); const entry = records.get(sessionId);
    if (!entry || workers.get(sessionId)?.owner !== owner) fail('TASK_HOST_NOT_OWNED', '只能访问这个任务宿主持有的工作会话');
    return entry;
  }
  function tombstone(entry, revoked = entry.revoked === true) {
    return { taskId: entry.metadata.taskId, sessionId: entry.metadata.sessionId, parentSessionId: entry.metadata.parentSessionId,
      origin: 'assistant_delegation', workerPresetId, roleTombstone: true, ...(revoked ? { revoked: true } : {}) };
  }
  function assertReadable(entry) { if (entry.revoked) fail('TASK_SOURCE_REVOKED', '任务来源已明确撤销，保留角色标记但不再读取任务正文'); }
  function validateHeader(entry, header) {
    if (header?.id !== entry.metadata.sessionId || header.parentSession !== entry.metadata.parentSessionId || header.agentPreset !== workerPresetId || header.isSeeded === true) fail('TASK_HOST_SOURCE_CONFLICT', '宿主工作会话的父级、预设或独立上下文与任务登记不符');
    if (!entry.revoked && typeof header.cwd === 'string' && path.isAbsolute(header.cwd)) {
      entry.metadata.workspace = header.cwd; workers.set(entry.metadata.sessionId, { owner, metadata: entry.metadata });
    }
  }
  async function observeStored(entry) {
    const query = get(ctx, 'sessionQuery');
    if (typeof query?.readSession !== 'function') fail('TASK_TRACE_UNAVAILABLE', '宿主未提供持久任务资料读取接口');
    let saved; try { saved = await query.readSession(entry.metadata.sessionId); } catch (error) { if (missing(error)) return null; throw error; }
    validateHeader(entry, saved.session ?? saved.header);
    const events = saved.events ?? [];
    let lastStart = -1, end = null, output = [];
    for (const event of events) {
      if (event.type === 'turn/start') lastStart = event.seq;
      if (event.type === 'turn/end') end = event;
      if (event.type === 'assistant/message' && Array.isArray(event.data?.message?.content) && event.data.message.content.length) output = event.data.message.content;
    }
    const kind = end && end.seq > lastStart ? end.data?.reason?.kind : null;
    return { exists: true, status: kind === 'completed' ? 'completed' : ['user', 'parent', 'aborted', 'cancelled'].includes(kind) ? 'cancelled' : kind ? 'failed' : 'unknown',
      ...(kind ? { result: { output, stopReason: kind === 'completed' ? 'completed' : ['user', 'parent', 'aborted', 'cancelled'].includes(kind) ? 'aborted' : 'error' } } : {}),
      sourceRead: 'host-session-query-full-log', lastSeq: events.at(-1)?.seq ?? -1 };
  }
  async function start(value = {}) {
    check(); registerTask(value); const entry = entryFor(value.sessionId);
    assertReadable(entry);
    if (typeof value.prompt !== 'string' || !value.prompt.trim()) fail('TASK_HOST_PROMPT', '任务指令不能为空');
    const requestDigest = digest(JSON.stringify([value.prompt, value.workspace ?? null, value.title ?? null]));
    if (entry.requestDigest && entry.requestDigest !== requestDigest) fail('TASK_HOST_REQUEST_CONFLICT', '同一任务会话不能提交不同任务内容');
    if (entry.starting) return entry.starting;
    if (entry.attempted) return { sessionId: value.sessionId, status: entry.status, duplicate: true, messageId: entry.messageId ?? null };
    entry.requestDigest = requestDigest;
    entry.starting = (async () => {
      const controller = new AbortController(); entry.controller = controller;
      if (entry.cancelRequested) controller.abort({ kind: 'parent' });
      const subagents = get(ctx, 'subagents'), presetRegistry = get(ctx, 'agentPresets');
      const backend = subagents?.getProvider?.(provider);
      if (typeof ctx.agents?.get !== 'function' || typeof subagents?.startActivation !== 'function' || !backend || backend.inheritsParentContext !== false || backend.capabilities?.agentPreset !== true || typeof backend.prepareContinuable !== 'function') fail('TASK_HOST_UNAVAILABLE', '宿主没有提供支持独立预设和新上下文的原生spawn服务');
      if (!presetRegistry?.mount) fail('TASK_WORKER_PRESET_UNAVAILABLE', '宿主未提供独立工作预设');
      const parent = ctx.agents.get(entry.metadata.parentSessionId);
      if (!parent) fail('TASK_PARENT_UNAVAILABLE', '任务所属的主会话当前不可用');
      entry.parent = parent;
      if (lookupTaskWorker(parent.id)) fail('TASK_WORKER_ROUTE', '工作会话通过主会话的任务入口回收结果');
      if (ctx.agents.get(entry.metadata.sessionId)) {
        validateHeader(entry, ctx.agents.get(entry.metadata.sessionId).session?.header);
        entry.attempted = true; entry.status = 'unknown'; return { sessionId: entry.metadata.sessionId, status: 'unknown', duplicate: true };
      }
      const existing = await observeStored(entry);
      if (existing) { entry.attempted = true; entry.status = existing.status; return { sessionId: entry.metadata.sessionId, status: existing.status, duplicate: true }; }
      check();
      if (entry.cancelRequested || controller.signal.aborted) { entry.status = 'cancelled'; fail('TASK_CANCELLED', '任务在原生派发前已取消'); }
      const maxDepth = subagents.resolveMaxDepth?.();
      entry.attempted = true; entry.status = 'starting';
      try {
        const receipt = await subagents.startActivation({ provider, childId: entry.metadata.sessionId, label: typeof value.title === 'string' && value.title ? value.title : '相续独立任务',
          request: { parent, prompt: [{ type: 'text', text: value.prompt }], agentPreset: workerPresetId,
            ...(entry.metadata.workspace ? { cwd: entry.metadata.workspace } : {}), ...(maxDepth === undefined ? {} : { maxDepth }) },
          signal: controller.signal, delivery: 'caller' });
        if (receipt?.childId !== entry.metadata.sessionId || typeof receipt?.dispose !== 'function' || !receipt?.result?.then) {
          if (typeof receipt?.dispose === 'function') await receipt.dispose().catch(report);
          fail('TASK_NATIVE_RECEIPT', '原生派发没有返回已保留编号的任务回执');
        }
        entry.receipt = receipt; entry.messageId = receipt.messageId ?? null; entry.status = 'running';
        const child = ctx.agents.get(entry.metadata.sessionId);
        if (child) { validateHeader(entry, child.session?.header); ensureScope(entry, child); }
        entry.settlement = Promise.resolve(receipt.result).then(result => { if (!entry.revoked) { entry.result = result; entry.status = statusOf(result); } emit(entry); }, error => { if (!entry.revoked) { entry.status = 'unknown'; entry.errorCode = error?.code ?? 'TASK_RESULT_UNKNOWN'; } emit(entry); });
        emit(entry); return { sessionId: entry.metadata.sessionId, messageId: entry.messageId, status: entry.status, workspace: entry.metadata.workspace };
      } catch (error) { entry.status = 'unknown'; entry.errorCode = error?.code ?? 'TASK_START_UNKNOWN'; if (entry.receipt) await entry.receipt.dispose().catch(report); emit(entry); throw error; }
    })();
    try { return await entry.starting; } finally { entry.starting = null; }
  }
  async function inspect({ sessionId } = {}) {
    const entry = entryFor(sessionId), agent = ctx.agents?.get?.(sessionId);
    if (entry.revoked) return { exists: Boolean(agent), status: 'revoked', sessionId, sourceRoleRetained: true };
    if (agent) validateHeader(entry, agent.session?.header);
    if (entry.result) return { exists: true, status: entry.status, sessionId, result: copy(entry.result), workspace: entry.metadata.workspace, ...(agent ? { lastSeq: agent.session.seq - 1 } : {}) };
    if (agent) return { exists: true, status: entry.status === 'cancelled' ? 'cancelled' : 'running', sessionId, lastSeq: agent.session.seq - 1, workspace: entry.metadata.workspace };
    const saved = await observeStored(entry);
    return saved ? { ...saved, sessionId, workspace: entry.metadata.workspace } : { exists: false, status: entry.status === 'starting' ? 'starting' : 'unknown', sessionId, workspace: entry.metadata.workspace };
  }
  async function readEvents({ sessionId, afterSeq = -1, limit = 50 } = {}) {
    const entry = entryFor(sessionId), query = get(ctx, 'sessionQuery');
    assertReadable(entry);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < -1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail('TASK_TRACE_CURSOR', '任务原件读取游标或页长无效');
    if (typeof query?.readEvent !== 'function') fail('TASK_TRACE_UNAVAILABLE', '宿主未提供原件分页接口');
    let page;
    try { page = await query.readEvent({ sessionId, seq: afterSeq + 1, before: 0, after: limit - 1 }); }
    catch (error) { if (!absentEvent(error) && !missing(error)) throw error; const state = await inspect({ sessionId }); return { events: [], hasMore: false, complete: state.exists && ['completed', 'failed', 'cancelled'].includes(state.status) }; }
    validateHeader(entry, page.session ?? page.header);
    const events = page.events ?? (page.target ? [page.target] : []);
    if (events.length > limit || events.some((event, index) => event.seq !== afterSeq + index + 1)) fail('TASK_TRACE_ORDER', '任务宿主原件序号不连续');
    const lastSeq = events.at(-1)?.seq ?? afterSeq, live = ctx.agents?.get?.(sessionId), total = live?.session?.seq;
    const hasMore = Number.isSafeInteger(total) ? lastSeq + 1 < total : events.length === limit;
    const terminal = !hasMore && (Boolean(entry.result) || !live) ? await inspect({ sessionId }) : null;
    return { events: copy(events), hasMore,
      complete: terminal ? ['completed', 'failed', 'cancelled'].includes(terminal.status) : false, sourceRead: 'host-session-query-window' };
  }
  async function releaseEntry(entry) {
    const sessionId = entry.metadata.sessionId;
    entry.cancelRequested = true;
    entry.controller?.abort({ kind: 'parent' });
    if (entry.starting) await entry.starting.catch(() => {});
    if (entry.receipt) { await entry.receipt.dispose(); await entry.settlement; emit(entry); return { sessionId, status: entry.status }; }
    const agent = ctx.agents?.get?.(sessionId);
    if (agent) {
      validateHeader(entry, agent.session?.header); const parent = ctx.agents.get(entry.metadata.parentSessionId), subagents = get(ctx, 'subagents');
      if (!parent || typeof subagents?.drainChildren !== 'function') fail('TASK_CANCEL_UNAVAILABLE', '任务不在当前宿主可释放的实际父级下');
      await subagents.drainChildren(parent, [sessionId]);
    }
    return { sessionId, status: entry.attempted ? 'unknown' : 'cancelled' };
  }
  async function cancel({ sessionId } = {}) {
    return releaseEntry(entryFor(sessionId));
  }
  async function readArtifact({ sessionId, path: requestedPath, cursor = 0, maxBytes = 65536, expectedFingerprint } = {}) {
    const entry = entryFor(sessionId);
    assertReadable(entry);
    if (!entry.metadata.workspace) await inspect({ sessionId });
    const root = entry.metadata.workspace;
    if (!root || typeof requestedPath !== 'string' || !requestedPath || requestedPath.includes('\0') || requestedPath.split(/[\\/]/).includes('..')) fail('TASK_ARTIFACT_PATH', '任务资料需要工作目录内的明确文件路径');
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536) fail('TASK_ARTIFACT_CURSOR', '资料分页游标或字节数无效');
    const resolvedRoot = await checkedPath(root), full = path.resolve(root, requestedPath), relativePath = path.relative(resolvedRoot, full);
    if (!relativePath || relativePath === '..' || relativePath.startsWith('..' + path.sep) || path.isAbsolute(relativePath)) fail('TASK_ARTIFACT_PATH', '资料文件超出任务工作目录');
    await checkedPath(full); const before = await fs.lstat(full, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxArtifactFileBytes)) fail('TASK_ARTIFACT_CAPACITY', '资料必须是容量上限内的普通文件');
    const handle = await fs.open(full, 'r');
    try {
      const initial = await handle.stat({ bigint: true }), fingerprint = fileIdentity(initial), size = Number(initial.size);
      if (!initial.isFile() || fileIdentity(before) !== fingerprint || expectedFingerprint !== undefined && expectedFingerprint !== fingerprint) fail('TASK_ARTIFACT_CHANGED', '任务资料已改变，请重新读取');
      if (cursor > size) fail('TASK_ARTIFACT_CURSOR', '资料读取位置超过文件末尾');
      const bytes = Buffer.alloc(Math.min(maxBytes, size - cursor)); let offset = 0;
      while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, cursor + offset); if (!read.bytesRead) break; offset += read.bytesRead; }
      await checkedPath(full); const after = await handle.stat({ bigint: true }), pathAfter = await fs.lstat(full, { bigint: true });
      if (offset !== bytes.length || fileIdentity(after) !== fingerprint || fileIdentity(pathAfter) !== fingerprint) fail('TASK_ARTIFACT_CHANGED', '任务资料在读取期间变化，未返回假完整副本');
      const next = cursor + bytes.length;
      return { bytes, size, filename: path.basename(full), relativePath: relativePath.split(path.sep).join('/'), fingerprint,
        fingerprintKind: 'stat-identity-sha256', nextCursor: next === size ? null : next, complete: next === size };
    } finally { await handle.close(); }
  }
  const unwatch = typeof ctx.on === 'function' ? ctx.on('session/event', (session) => { const entry = records.get(session?.id); if (entry) emit(entry); }, { global: true }) : null;
  const unwatchCreation = typeof ctx.on === 'function' ? ctx.on('agent/created', ({ agent }) => { const entry = records.get(agent?.id); if (entry) ensureScope(entry, agent); }, { global: true }) : null;
  function forgetTask({ taskId, sessionId } = {}) {
    const entry = entryFor(sessionId);
    if (taskId !== undefined && taskId !== entry.metadata.taskId) fail('TASK_HOST_BINDING', '撤销对象与实际任务不符');
    entry.revoked = true; entry.status = 'revoked'; entry.result = null; entry.metadata = tombstone(entry, true);
    workers.set(sessionId, { owner, metadata: entry.metadata }); return { sessionId, taskId: entry.metadata.taskId, sourceRoleRetained: true, hostCopiesDeleted: false };
  }
  async function close() {
    if (closed) return; closed = true; owner.closed = true; unwatch?.(); unwatchCreation?.(); listeners.clear();
    for (const entry of records.values()) entry.controller?.abort({ kind: 'parent' });
    const outcomes = await Promise.allSettled([...records.values()].map(releaseEntry));
    for (const [sessionId, entry] of records) {
      if (!ctx.agents?.get?.(sessionId)) entry.releaseScope?.();
      if (workers.get(sessionId)?.owner === owner) workers.set(sessionId, { owner, metadata: tombstone(entry) });
    }
    records.clear();
    const failures = outcomes.filter(item => item.status === 'rejected').map(item => item.reason);
    if (failures.length) throw new AggregateError(failures, '任务宿主未能确认全部工作会话已释放');
  }
  function capabilities() { const subagents = get(ctx, 'subagents'), backend = subagents?.getProvider?.(provider), query = get(ctx, 'sessionQuery');
    const traceAvailable = typeof query?.readEvent === 'function' && typeof query?.readSession === 'function';
    const nativeAvailable = typeof ctx.agents?.get === 'function' && typeof subagents?.startActivation === 'function' && backend?.inheritsParentContext === false && backend?.capabilities?.agentPreset === true && typeof backend?.prepareContinuable === 'function';
    return { available: !closed && nativeAvailable && traceAvailable && typeof get(ctx, 'agentPresets')?.mount === 'function', nativeAvailable, traceAvailable,
      workerPresetId, provider, resultDelivery: 'caller', permissionBoundary: 'inherited-dsh-user-policy' }; }
  return { registerTask, lookupWorker: sessionId => records.has(sessionId) ? lookupTaskWorker(sessionId) : null, capabilities, start, inspect, readEvents, cancel, readArtifact, forgetTask,
    onChange(listener) { check(); if (typeof listener !== 'function') throw new TypeError('Task change listener required'); listeners.add(listener); return () => listeners.delete(listener); }, close };
}
