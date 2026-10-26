import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBilibiliStorage } from './storage.js';
import { createBilibiliClient } from './client.js';
import { createLoginQr } from '../login-qr.js';
import { BILIBILI_LIMITS as LIMITS, BILIBILI_OPERATIONS, BILIBILI_SOURCES, bvid, copy, createHttp, credential, cookiesFrom, fail, fields, hash, id, integer, object, safeError, text, trustedUrl, uid } from './common.js';

const SCHEMA = 'xiangxu-bilibili/1';
const READS = ['search', 'recommend', 'video', 'subtitles', 'comments', 'frames'], WRITES = ['comment', 'reply', 'share', 'message'];
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function validate(value) {
  if (!object(value) || Object.keys(value).some(key => !['schemaVersion', 'enabled', 'credential', 'receipts'].includes(key)) || value.schemaVersion !== SCHEMA || typeof value.enabled !== 'boolean' || !Array.isArray(value.receipts) || value.receipts.length > LIMITS.receipts || Buffer.byteLength(JSON.stringify(value)) > LIMITS.registryBytes) fail('BILI_REGISTRY_INVALID');
  if (value.credential !== null) credential(value.credential);
  const keys = new Set();
  for (const receipt of value.receipts) {
    if (!object(receipt) || Object.keys(receipt).some(key => !['key', 'payloadHash', 'scopeHash', 'operation', 'status', 'createdAt', 'updatedAt', 'code', 'messageId', 'messageIdKind', 'receiptId', 'confirmedBy', 'deliveredAt', 'publicVisibility', 'readByRecipient', 'deliveryId', 'accountId', 'target', 'contentHash', 'resolutionReason', 'verifiedAt'].includes(key)) || !/^[a-f0-9]{64}$/.test(receipt.key) || keys.has(receipt.key) || !/^[a-f0-9]{64}$/.test(receipt.payloadHash) || !/^[a-f0-9]{64}$/.test(receipt.scopeHash) || !WRITES.includes(receipt.operation) || !['prepared', 'unknown', 'delivered', 'failed'].includes(receipt.status) || !Number.isSafeInteger(receipt.createdAt) || receipt.createdAt < 0 || !Number.isSafeInteger(receipt.updatedAt) || receipt.updatedAt < 0) fail('BILI_REGISTRY_INVALID');
    keys.add(receipt.key);
    for (const field of ['code', 'messageId', 'messageIdKind', 'receiptId', 'confirmedBy', 'publicVisibility', 'readByRecipient']) if (receipt[field] !== undefined) id(receipt[field], 200);
    if (receipt.deliveredAt !== undefined && (!Number.isSafeInteger(receipt.deliveredAt) || receipt.deliveredAt < 0)) fail('BILI_REGISTRY_INVALID');
    if (receipt.verifiedAt !== undefined && (!Number.isSafeInteger(receipt.verifiedAt) || receipt.verifiedAt < 0)) fail('BILI_REGISTRY_INVALID');
    if (receipt.deliveryId !== undefined) id(receipt.deliveryId);
    if (receipt.accountId !== undefined) uid(receipt.accountId);
    if (receipt.contentHash !== undefined && !/^[a-f0-9]{64}$/.test(receipt.contentHash)) fail('BILI_REGISTRY_INVALID');
    if (receipt.resolutionReason !== undefined) text(receipt.resolutionReason, 256);
    if (receipt.target !== undefined) { fields(receipt.target, ['bvid', 'rootId', 'parentId', 'receiverUid', 'sharingMethod']); if (receipt.target.bvid) bvid(receipt.target.bvid); if (receipt.target.receiverUid) uid(receipt.target.receiverUid); for (const field of ['rootId', 'parentId']) if (receipt.target[field] !== undefined && !/^[0-9]{1,20}$/.test(receipt.target[field])) fail('BILI_REGISTRY_INVALID'); if (receipt.target.sharingMethod !== undefined && receipt.target.sharingMethod !== 'private_video_link') fail('BILI_REGISTRY_INVALID'); }
    if (receipt.status === 'delivered' && (!receipt.messageId || !receipt.receiptId || !receipt.confirmedBy || !['rpid', 'msg_key'].includes(receipt.messageIdKind))) fail('BILI_REGISTRY_INVALID');
  }
  return value;
}
/** Optional account capability. No model, autonomous loop, persona state or memory writer. */
export function createBilibiliService({ registryPath, storage, fetchImpl = fetch, clock = Date.now, endpoints = {}, authorize, onError = () => {}, transformFrames } = {}) {
  if (!storage && !registryPath || typeof fetchImpl !== 'function') throw new TypeError('Bilibili storage and fetch port are required');
  const persistence = storage ?? createBilibiliStorage(registryPath), lifetime = new AbortController(), http = createHttp({ fetchImpl, lifetime: lifetime.signal, endpoints }), client = createBilibiliClient({ http, clock, transformFrames });
  let state, flow, probeStatus = null, initialized = false, closed = false, closing = false, tail = Promise.resolve(), queued = 0, errorStatus = null;
  const report = error => { const safe = safeError(error); errorStatus = safe; try { onError(Object.assign(new Error(safe.message), { code: safe.code })); } catch {} return safe; };
  const ready = (async () => {
    try {
      await persistence.acquire?.(); const saved = await persistence.read(); state = saved ? validate(copy(saved)) : { schemaVersion: SCHEMA, enabled: false, credential: null, receipts: [] };
      if (state.receipts.some(receipt => receipt.status === 'prepared')) { const next = { ...state, receipts: state.receipts.map(receipt => receipt.status === 'prepared' ? { ...receipt, status: 'unknown', code: 'BILI_INTERRUPTED_UNKNOWN', updatedAt: clock() } : receipt) }; await persistence.write(validate(next)); state = next; }
      initialized = true;
    } catch (error) { await persistence.release?.().catch(() => {}); const safe = report(error); throw Object.assign(new Error(safe.message), { code: safe.code }); }
  })();
  async function save(next) { validate(next); await persistence.write(next); state = next; }
  function queue(work) {
    if (closing || closed) return Promise.reject(Object.assign(new Error('B站服务已关闭'), { code: 'BILI_CLOSED' }));
    if (queued >= LIMITS.queue) return Promise.reject(Object.assign(new Error('B站操作队列已满'), { code: 'BILI_QUEUE_CAPACITY' }));
    queued++; const result = tail.then(async () => { await ready; if (closing || closed) fail('BILI_CLOSED'); return work(); }).catch(error => { const safe = report(error); throw Object.assign(new Error(safe.message), { code: safe.code }); }); tail = result.catch(() => {}); return result.finally(() => { queued--; });
  }
  function status() {
    const connected = Boolean(state.credential && probeStatus?.connected && probeStatus.accountId === state.credential.accountId);
    return { id: 'bilibili', platform: 'bilibili', enabled: state.enabled, accountId: state.credential?.accountId ?? null, accountName: connected ? probeStatus.name ?? null : null, connected, authorized: Boolean(state.credential), hasCredentials: Boolean(state.credential), phase: flow?.phase ?? (state.credential ? 'authorized' : 'idle'), ...(flow ? { login: { flowId: flow.id, phase: flow.phase, expiresAt: flow.expiresAt } } : {}), items: [...new Set(Object.values(BILIBILI_OPERATIONS))].map(capability => ({ id: capability, supported: true, available: state.enabled && connected, driverAvailable: state.enabled && connected, operations: Object.keys(BILIBILI_OPERATIONS).filter(operation => BILIBILI_OPERATIONS[operation] === capability), defaultAllowed: false })), operations: { ...BILIBILI_OPERATIONS }, limits: { ...LIMITS }, receipts: { retained: state.receipts.length, unresolved: state.receipts.filter(receipt => ['prepared', 'unknown'].includes(receipt.status)).length, automaticUnknownRetry: false }, error: errorStatus ? { ...errorStatus } : null, authentication: 'public_web_qr', desktopAccountTakenOver: false, livePlatformVerified: false, sources: BILIBILI_SOURCES };
  }
  /** Authorization must not await this service's own queue while an operation holds it. */
  function capabilitySnapshot() {
    if (!initialized) return { id: 'bilibili', platform: 'bilibili', ready: false, enabled: false, connected: false, authorized: false, hasCredentials: false, accountId: null, phase: closed ? 'closed' : closing ? 'closing' : 'initializing', items: [...new Set(Object.values(BILIBILI_OPERATIONS))].map(capability => ({ id: capability, supported: true, available: false, driverAvailable: false, defaultAllowed: false, reason: 'B站账号服务尚未就绪' })), operations: { ...BILIBILI_OPERATIONS }, limits: { ...LIMITS }, error: errorStatus ? { ...errorStatus } : null };
    const current = copy(status()); current.ready = true;
    if (closing || closed) { current.enabled = false; current.connected = false; current.phase = closed ? 'closed' : 'closing'; current.items = current.items.map(item => ({ ...item, available: false, driverAvailable: false, reason: 'B站账号服务已停止' })); }
    return current;
  }
  function inspect(args = {}) { fields(args, ['probe']); if (args.probe !== undefined && typeof args.probe !== 'boolean') fail('BILI_ARGUMENT'); return queue(async () => { if (args.probe && state.credential) { try { probeStatus = await client.probe(state.credential); errorStatus = null; } catch (error) { probeStatus = { connected: false }; report(error); } } return status(); }); }
  function configure(args = {}) { fields(args, ['enabled']); if (typeof args.enabled !== 'boolean') fail('BILI_ARGUMENT'); return queue(async () => { await save({ ...state, enabled: args.enabled }); return status(); }); }
  function loginStart() { return queue(async () => {
    if (flow && ['waiting', 'scanned'].includes(flow.phase) && clock() < flow.expiresAt) return { ...status(), login: { ...status().login, qrContent: flow.qrContent, qrDataUrl: flow.qrDataUrl, scanByUserRequired: true } };
    flow?.controller.abort(); const own = { id: randomUUID(), phase: 'starting', expiresAt: clock() + LIMITS.flowMs, controller: new AbortController() }; flow = own;
    try {
      const data = await http.json('passport', '/x/passport-login/web/qrcode/generate', { source: 'main-fe-header' }, { signal: own.controller.signal });
      const qr = trustedUrl(data.url, ['passport.bilibili.com', 'bilibili.com'], http.localBases); if (qr.href.length > 2048) fail('BILI_QR_CAPACITY');
      own.key = id(data.qrcode_key, 512); own.qrContent = qr.href; own.qrDataUrl = createLoginQr(qr.href); if (Buffer.byteLength(own.qrDataUrl) > 262144) fail('BILI_QR_CAPACITY'); own.phase = 'waiting'; errorStatus = null;
      return { ...status(), login: { ...status().login, qrContent: own.qrContent, qrDataUrl: own.qrDataUrl, scanByUserRequired: true } };
    } catch (error) { own.phase = 'failed'; own.key = null; own.qrContent = null; own.qrDataUrl = null; throw error; }
  }); }
  function loginPoll(args = {}) { fields(args, ['flowId']); const flowId = id(args.flowId); return queue(async () => {
    const own = flow; if (!own || own.id !== flowId) fail('BILI_LOGIN_STALE');
    if (!['waiting', 'scanned'].includes(own.phase)) return status();
    if (clock() >= own.expiresAt) { own.phase = 'expired'; own.key = null; own.qrContent = null; own.qrDataUrl = null; own.controller.abort(); return status(); }
    try {
      const response = await http.raw(http.url('passport', '/x/passport-login/web/qrcode/poll', { qrcode_key: own.key, source: 'main-fe-header' }), { signal: own.controller.signal });
      if (response.value.code !== 0 || !object(response.value.data)) fail('BILI_LOGIN_REJECTED'); const code = response.value.data.code;
      if (code === 86101) own.phase = 'waiting';
      else if (code === 86090) own.phase = 'scanned';
      else if (code === 86038) { own.phase = 'expired'; own.key = null; own.qrContent = null; own.qrDataUrl = null; own.controller.abort(); }
      else if (code === 0) {
        const credentials = cookiesFrom(response.response), checked = await client.probe(credentials, own.controller.signal);
        if (own !== flow || own.controller.signal.aborted || closing) fail('BILI_LOGIN_STALE');
        await save({ ...state, credential: credentials }); probeStatus = checked; client.clearAuthCache(); own.phase = 'authorized'; own.key = null; own.qrContent = null; own.qrDataUrl = null; own.controller.abort(); errorStatus = null;
      } else fail('BILI_LOGIN_REJECTED');
      return status();
    } catch (error) { if (own === flow && !own.controller.signal.aborted) { own.phase = 'failed'; own.key = null; own.qrContent = null; own.qrDataUrl = null; } throw error; }
  }); }
  function loginCancel(args = {}) {
    fields(args, ['flowId']); if (args.flowId !== undefined) id(args.flowId);
    if (flow && (!args.flowId || args.flowId === flow.id)) flow.controller.abort();
    return queue(async () => { if (flow && args.flowId && args.flowId !== flow.id) fail('BILI_LOGIN_STALE'); if (flow) { flow.controller.abort(); flow.key = null; flow.qrContent = null; flow.qrDataUrl = null; flow = null; } return status(); });
  }
  function disconnect() { flow?.controller.abort(); return queue(async () => { await save({ ...state, enabled: false, credential: null }); flow = null; probeStatus = null; client.clearAuthCache(); return { ...status(), localCredentialsDeleted: true, remoteAuthorizationRevoked: false }; }); }
  function contextSnapshot(context) { if (!object(context) || typeof context.memoryRoot !== 'string' || !path.isAbsolute(context.memoryRoot) || context.memoryRoot.length > 4096) fail('BILI_CONTEXT_REQUIRED'); return { memoryRoot: path.resolve(context.memoryRoot), accountId: id(context.accountId), ...(context.deliveryId !== undefined ? { deliveryId: id(context.deliveryId) } : {}), signal: context.signal }; }
  async function allowed(operation, context) {
    if (!state.enabled) fail('BILI_DISABLED'); if (!state.credential) fail('BILI_NOT_AUTHORIZED'); if (context.accountId !== state.credential.accountId) fail('BILI_ACCOUNT_CHANGED');
    if (context.signal?.aborted || lifetime.signal.aborted) fail('BILI_ABORTED');
    if (typeof authorize !== 'function') fail('BILI_PERMISSION_DENIED');
    let permitted; try { permitted = await authorize({ memoryRoot: context.memoryRoot, platform: 'bilibili', accountId: context.accountId, capability: BILIBILI_OPERATIONS[operation], operation }); } catch { fail('BILI_PERMISSION_DENIED'); }
    if (permitted === false) fail('BILI_PERMISSION_DENIED');
  }
  function read(args = {}, context) { const requested = copy(args), scoped = contextSnapshot(context); if (!READS.includes(requested.operation)) fail('BILI_OPERATION_UNSUPPORTED'); return queue(async () => { await allowed(requested.operation, scoped); return client.read(requested, state.credential, scoped.signal); }); }
  function execute(args = {}, context) {
    const requested = copy(args), scoped = contextSnapshot(context); if (!WRITES.includes(requested.operation)) fail('BILI_OPERATION_UNSUPPORTED'); id(scoped.deliveryId);
    return queue(async () => {
      await allowed(requested.operation, scoped);
      const scopeHash = hash([process.platform === 'win32' ? scoped.memoryRoot.toLowerCase() : scoped.memoryRoot, scoped.accountId]), key = hash([scopeHash, scoped.deliveryId]), payloadHash = hash(canonical(requested)), found = state.receipts.find(receipt => receipt.key === key);
      const resultFor = receipt => { const { key: ignored, payloadHash: ignoredPayload, scopeHash: ignoredScope, contentHash: ignoredContent, resolutionReason: ignoredReason, ...result } = receipt; return { platform: 'bilibili', accountId: scoped.accountId, ...result, deliveryId: scoped.deliveryId, receiptRef: receipt.key, status: receipt.status === 'prepared' ? 'unknown' : receipt.status }; };
      if (found) { if (found.payloadHash !== payloadHash) fail('BILI_OUTPUT_CONFLICT'); return { ...resultFor(found), duplicate: true, automaticRetry: false }; }
      const unresolved = state.receipts.find(receipt => receipt.scopeHash === scopeHash && receipt.payloadHash === payloadHash && ['prepared', 'unknown'].includes(receipt.status));
      if (unresolved) return { ...resultFor(unresolved), status: 'unknown', duplicate: true, automaticRetry: false, priorDeliveryId: unresolved.deliveryId ?? null, blockedBy: 'unresolved_equivalent_action', code: 'BILI_PRIOR_DELIVERY_UNKNOWN' };
      if (state.receipts.length >= LIMITS.receipts) fail('BILI_RECEIPT_CAPACITY');
      const prepared = await client.prepare(requested, state.credential, scoped.signal); await allowed(requested.operation, scoped);
      const entry = { key, scopeHash, payloadHash, deliveryId: scoped.deliveryId, accountId: scoped.accountId, target: prepared.public, contentHash: prepared.contentHash, operation: requested.operation, status: 'prepared', createdAt: clock(), updatedAt: clock() };
      await save({ ...state, receipts: [...state.receipts, entry] });
      let result;
      try { await allowed(requested.operation, scoped); result = await client.send(prepared, state.credential, scoped.signal); }
      catch (error) { const safe = report(error); result = { status: ['BILI_PERMISSION_DENIED', 'BILI_ACCOUNT_CHANGED', 'BILI_DISABLED', 'BILI_NOT_AUTHORIZED', 'BILI_AUTH_REJECTED'].includes(safe.code) ? 'failed' : 'unknown', code: safe.code }; }
      const receipt = { ...entry, ...result, updatedAt: clock() };
      try { await save({ ...state, receipts: state.receipts.map(value => value.key === key ? receipt : value) }); }
      catch (error) { report(error); return { ...resultFor({ ...entry, status: 'unknown', code: 'BILI_RECEIPT_SAVE_UNKNOWN' }), automaticRetry: false }; }
      return { ...resultFor(receipt), ...prepared.public, automaticRetry: false };
    });
  }
  const publicReceipt = receipt => { const { key, payloadHash: ignoredPayload, contentHash: ignoredContent, ...value } = receipt; return { receiptRef: key, ...copy(value), status: receipt.status === 'prepared' ? 'unknown' : receipt.status }; };
  function listReceipts(args = {}) { fields(args, ['offset', 'limit', 'status']); const offset = integer(args.offset, 0, 0, LIMITS.receipts), limit = integer(args.limit, 20, 1, 50); if (args.status !== undefined && !['unknown', 'delivered', 'failed'].includes(args.status)) fail('BILI_ARGUMENT'); return queue(async () => { const values = [...state.receipts].reverse().filter(receipt => args.status === undefined || (receipt.status === 'prepared' ? 'unknown' : receipt.status) === args.status); return { platform: 'bilibili', total: values.length, offset, limit, items: values.slice(offset, offset + limit).map(publicReceipt), hasMore: offset + limit < values.length }; }); }
  function resolveReceipt(args = {}) {
    fields(args, ['receiptRef', 'outcome', 'reason', 'messageId', 'confirmNotDelivered']); const receiptRef = id(args.receiptRef, 64), reason = text(args.reason, 256); if (!/^[a-f0-9]{64}$/.test(receiptRef) || !['not_delivered', 'delivered'].includes(args.outcome)) fail('BILI_ARGUMENT');
    if (args.outcome === 'not_delivered' && args.confirmNotDelivered !== true || args.outcome === 'delivered' && !args.messageId) fail('BILI_RESOLUTION_CONFIRMATION');
    const messageId = args.messageId === undefined ? null : id(args.messageId);
    return queue(async () => {
      const entry = state.receipts.find(receipt => receipt.key === receiptRef); if (!entry) fail('BILI_RECEIPT_NOT_FOUND');
      if (!['prepared', 'unknown'].includes(entry.status)) return { changed: false, receipt: publicReceipt(entry) };
      let result;
      if (args.outcome === 'not_delivered') result = { status: 'failed', code: 'BILI_OWNER_CONFIRMED_NOT_DELIVERED', confirmedBy: 'owner-explicit-not-delivered', verifiedAt: clock() };
      else {
        if (!state.credential || state.credential.accountId !== entry.accountId) fail('BILI_ACCOUNT_CHANGED');
        try { result = await client.verifyReceipt(entry, messageId, state.credential); } catch (error) { report(error); }
        if (!result) return { changed: false, receipt: publicReceipt(entry), status: 'unknown', code: 'BILI_RECEIPT_NOT_VERIFIED' };
      }
      const next = { ...entry, ...result, resolutionReason: reason, updatedAt: clock() }; if (next.status === 'delivered') delete next.code;
      await save({ ...state, receipts: state.receipts.map(value => value.key === entry.key ? next : value) }); return { changed: true, receipt: publicReceipt(next) };
    });
  }
  let closePromise;
  function close() {
    if (closePromise) return closePromise; closing = true; lifetime.abort(); flow?.controller.abort();
    closePromise = (async () => { await ready.catch(() => {}); await tail; flow = null; probeStatus = null; client.clearAuthCache(); try { await persistence.release?.(); } finally { closed = true; } })(); return closePromise;
  }
  return { ready, capabilitySnapshot, peekCapabilities: capabilitySnapshot, inspect, configure, loginStart, loginPoll, loginCancel, disconnect, read, execute, listReceipts, resolveReceipt, close };
}
