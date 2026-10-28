import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { atomicReplaceWithRetry } from '../../../core/store.js';
import { createOneBotClient, decodeOneBotEvent } from './onebot.js';
import { CAPABILITY_IDS, capabilities as capabilityMap, normalizedEvent } from '../connections/common.js';
import { QQ_DELIVERY_POLICY } from '../connections/qq.js';
import { createBridgeClient } from '../connections/bridge.js';
import { EXTERNAL_OUTPUT_FORMAT, projectExternalOutput, resolveExternalOutput } from '../external-output.js';

export const CHANNEL_LIMITS = Object.freeze({ registryBytes: 1048576, bindings: 128, receipts: 2048, unresolved: 256, terminalReceipts: 1024, scopeIds: 256, bodyBytes: 65536, queued: 32, excluded: 8 });
const SCHEMA = 'xiangxu-channels/1', IDS = ['qq', 'wechat'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value)).digest('hex');
const failure = (code, message) => Object.assign(new Error(message), { code });
const fail = (code, message) => { throw failure(code, message); };
const bounded = (value, name, max = 256, empty = false) => { if (typeof value !== 'string' || !empty && !value || Array.from(value).length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail('CHANNEL_BAD_REQUEST', name + '格式无效'); return value; };
const normalizedRoot = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const terminal = receipt => !['prepared', 'unknown'].includes(receipt.status);
const cleanError = error => ({ code: /^[A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'CHANNEL_OPERATION_FAILED', message: '渠道操作未完成，请检查本地桥、连接设置和诊断。' });
const DEFAULT_CONFIG = { mode: 'bridge', apiUrl: '', accountId: '', accessToken: '', allowedPrivateIds: [], allowedGroupIds: [], voiceMode: 'text', allowRemote: false, resolveIncomingMedia: true, transcribeIncomingAudio: false };
function retainedRoute(value) {
  if (!object(value) || Object.keys(value).some(key => !['provider', 'model', 'reasoningEffort', 'maxTokens'].includes(key))) fail('CHANNEL_ROUTE_INVALID', '宿主模型路由无效');
  bounded(value.provider, '模型提供方'); bounded(value.model, '模型');
  if (value.reasoningEffort !== undefined) bounded(value.reasoningEffort, '推理配置', 64);
  if (value.maxTokens !== undefined && (!Number.isSafeInteger(value.maxTokens) || value.maxTokens < 1 || value.maxTokens > 10000000)) fail('CHANNEL_ROUTE_INVALID', '宿主模型输出预算无效');
  return clone(value);
}
function profileDefaults(id) { return { id, platform: id, protocol: id === 'qq' ? 'onebot11' : 'onebot12', enabled: false, config: clone(DEFAULT_CONFIG), ingressHash: null, recentExcluded: [] }; }
function configuration(patch, previous = DEFAULT_CONFIG) {
  if (!object(patch)) fail('CHANNEL_BAD_CONFIG', '渠道配置必须是对象');
  for (const key of Object.keys(patch)) if (!Object.hasOwn(DEFAULT_CONFIG, key) && key !== 'clearAccessToken') fail('CHANNEL_BAD_CONFIG', '未知渠道配置字段');
  const next = { ...clone(DEFAULT_CONFIG), ...clone(previous), ...clone(patch) }; delete next.clearAccessToken;
  if (patch.accessToken === '') next.accessToken = previous.accessToken;
  if (patch.clearAccessToken !== undefined && typeof patch.clearAccessToken !== 'boolean') fail('CHANNEL_BAD_CONFIG', '清除令牌标记无效');
  if (patch.clearAccessToken) { if (patch.accessToken) fail('CHANNEL_BAD_CONFIG', '不能同时设置并清除令牌'); next.accessToken = ''; }
  bounded(next.apiUrl, 'API地址', 1024, true); bounded(next.accountId, '账号', 256, true); bounded(next.accessToken, 'API令牌', 4096, true);
  if (next.apiUrl) {
    let url; try { url = new URL(next.apiUrl); } catch { fail('CHANNEL_BAD_CONFIG', 'API地址无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('CHANNEL_BAD_CONFIG', 'API地址不能包含凭据、查询或片段');
    if (next.allowRemote === true && url.protocol !== 'https:') fail('CHANNEL_BAD_CONFIG', '明确启用远程API时必须使用HTTPS');
  }
  for (const key of ['allowedPrivateIds', 'allowedGroupIds']) {
    if (!Array.isArray(next[key]) || next[key].length > CHANNEL_LIMITS.scopeIds) fail('CHANNEL_BAD_CONFIG', '接入范围超过技术容量');
    next[key] = [...new Set(next[key].map(value => bounded(value, '接入ID')))];
  }
  for (const key of ['resolveIncomingMedia','transcribeIncomingAudio']) if (typeof next[key] !== 'boolean') fail('CHANNEL_BAD_CONFIG','入站媒体设置必须为开关');
  if (!['text', 'both', 'voice'].includes(next.voiceMode) || typeof next.allowRemote !== 'boolean' || !['bridge', 'official'].includes(next.mode)) fail('CHANNEL_BAD_CONFIG', '回复形式、连接方式或远程许可无效');
  return next;
}
function validateRegistry(value) {
  if (!object(value) || value.schemaVersion !== SCHEMA || !Array.isArray(value.profiles) || value.profiles.length !== 2 || !Array.isArray(value.bindings) || value.bindings.length > CHANNEL_LIMITS.bindings || !Array.isArray(value.receipts) || value.receipts.length > CHANNEL_LIMITS.receipts || !Array.isArray(value.generations) || value.generations.length > CHANNEL_LIMITS.bindings || Buffer.byteLength(JSON.stringify(value)) > CHANNEL_LIMITS.registryBytes) fail('CHANNEL_REGISTRY_INVALID', '渠道登记格式或容量无效');
  if (!Number.isSafeInteger(value.port) || value.port < 0 || value.port > 65535) fail('CHANNEL_REGISTRY_INVALID', '渠道监听端口无效');
  for (const id of IDS) {
    const selected = value.profiles.filter(profile => profile?.id === id);
    if (selected.length !== 1 || selected[0].platform !== id || selected[0].protocol !== (id === 'qq' ? 'onebot11' : 'onebot12') || typeof selected[0].enabled !== 'boolean' || selected[0].ingressHash !== null && !/^[0-9a-f]{64}$/.test(selected[0].ingressHash) || !Array.isArray(selected[0].recentExcluded) || selected[0].recentExcluded.length > CHANNEL_LIMITS.excluded) fail('CHANNEL_REGISTRY_INVALID', '渠道档案无效');
    configuration(selected[0].config);
    if (selected[0].ingressHmacSecret !== undefined && (typeof selected[0].ingressHmacSecret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(selected[0].ingressHmacSecret) || hash(selected[0].ingressHmacSecret) !== selected[0].ingressHash)) fail('CHANNEL_REGISTRY_INVALID', '渠道签名凭据无效');
    if (selected[0].generation !== undefined && (!Number.isSafeInteger(selected[0].generation) || selected[0].generation < 0)) fail('CHANNEL_REGISTRY_INVALID', '渠道代次无效');
  }
  const sessions = new Set();
  for (const binding of value.bindings) {
    if (!object(binding) || !IDS.includes(binding.profileId) || typeof binding.memoryRoot !== 'string' || !path.isAbsolute(binding.memoryRoot) || binding.memoryRoot.length > 4096 || typeof binding.sessionId !== 'string' || !/^xiangxu-social-[0-9a-f]{32}$/.test(binding.sessionId) || sessions.has(binding.sessionId) || !object(binding.facts) || !object(binding.facts.sender) || !object(binding.facts.conversation) || !['private', 'group'].includes(binding.facts.conversation.type) || typeof binding.retired !== 'boolean' || !Number.isSafeInteger(binding.outboundWatermark) || binding.outboundWatermark < -1 || !Number.isSafeInteger(binding.inboundFloorAt) || binding.inboundFloorAt < -1) fail('CHANNEL_REGISTRY_INVALID', '渠道会话登记无效');
    bounded(binding.facts.sender.id, '发言者'); bounded(binding.facts.conversation.id, '群或对象'); bounded(binding.facts.accountId, '账号'); sessions.add(binding.sessionId);
    if (binding.agentOptions !== undefined) retainedRoute(binding.agentOptions);
  }
  const receiptIds = new Set();
  for (const receipt of value.receipts) {
    if (!object(receipt) || !/^[0-9a-f]{64}$/.test(receipt.id) || receiptIds.has(receipt.id) || !sessions.has(receipt.sessionId) || !['inbound', 'outbound'].includes(receipt.kind) || !['prepared', 'unknown', 'accepted', 'delivered', 'failed'].includes(receipt.status) || !/^[0-9a-f]{64}$/.test(receipt.textHash) || !Number.isSafeInteger(receipt.at) || receipt.at < 0 || receipt.text !== undefined || receipt.payload !== undefined) fail('CHANNEL_REGISTRY_INVALID', '渠道回执无效');
    if (receipt.formatVersion === undefined ? receipt.sourceTextHash !== undefined : receipt.kind !== 'outbound' || receipt.formatVersion !== EXTERNAL_OUTPUT_FORMAT || !/^[0-9a-f]{64}$/.test(receipt.sourceTextHash)) fail('CHANNEL_REGISTRY_INVALID', '渠道文字投影回执无效');
    receiptIds.add(receipt.id);
  }
  if (value.receipts.filter(receipt => !terminal(receipt)).length > CHANNEL_LIMITS.unresolved) fail('CHANNEL_RECEIPT_CAPACITY', '未确认渠道回执已达到技术容量');
  for (const generation of value.generations) if (!object(generation) || typeof generation.memoryRoot !== 'string' || !path.isAbsolute(generation.memoryRoot) || !Number.isSafeInteger(generation.value) || generation.value < 0) fail('CHANNEL_REGISTRY_INVALID', '渠道代次无效');
  return value;
}
async function safePath(file) {
  const full = path.resolve(file); let current = path.parse(full).root;
  for (const part of full.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) fail('CHANNEL_REGISTRY_PATH', '渠道登记不能经过符号链接或目录联接'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return full;
}
export function createChannelRegistryStorage(file) {
  return {
    async read() {
      const full = await safePath(file);
      try {
        const stat = await fs.lstat(full); if (!stat.isFile() || stat.size > CHANNEL_LIMITS.registryBytes) fail('CHANNEL_REGISTRY_CAPACITY', '渠道登记不是普通文件或超过1MiB');
        const handle = await fs.open(full, 'r');
        try { const buffer = Buffer.alloc(CHANNEL_LIMITS.registryBytes + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); if (bytesRead > CHANNEL_LIMITS.registryBytes) fail('CHANNEL_REGISTRY_CAPACITY', '渠道登记超过1MiB'); return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); }
        finally { await handle.close(); }
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async write(value) {
      const text = JSON.stringify(value, null, 2) + '\n'; if (Buffer.byteLength(text) > CHANNEL_LIMITS.registryBytes) fail('CHANNEL_REGISTRY_CAPACITY', '渠道登记超过1MiB');
      const full = await safePath(file); await fs.mkdir(path.dirname(full), { recursive: true }); await safePath(full);
      const temporary = full + '.next'; await safePath(temporary); const handle = await fs.open(temporary, 'w', 0o600);
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      await atomicReplaceWithRetry(temporary, full);
    },
  };
}

/** Optional IM transport. This registry stores routing metadata and receipts, never dialogue text. */
export function createChannelService({ getCoordinator, channelPort, registryPath, storage, clientFactory = createBridgeClient, speechPort, connectionPort, incomingMediaPort, authorizeAction = async ({ capability }) => { if (!['chat.text', 'chat.voice'].includes(capability)) fail('CAPABILITY_PERMISSION_DENIED', '此操作尚未获得用户授权'); }, clock = Date.now, onError = () => {}, port = 17654 } = {}) {
  if (typeof getCoordinator !== 'function' || typeof channelPort?.create !== 'function' || typeof channelPort?.send !== 'function' || typeof channelPort?.close !== 'function' || !storage && !registryPath || typeof clientFactory !== 'function') throw new TypeError('Channels need a coordinator, native port and external registry');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) fail('CHANNEL_BAD_CONFIG', '渠道监听端口无效');
  const persistence = storage ?? createChannelRegistryStorage(registryPath), clients = new Map(), probes = new Map(), sockets = new Set();
  let registry, listener = null, livePort = null, closed = false, suspended = false, boundRoot = null, tail = Promise.resolve(), queued = 0;
  const report = error => { const safe = cleanError(error); try { onError(Object.assign(new Error(safe.message), { code: safe.code })); } catch {} return safe; };
  const queue = work => { if (queued >= CHANNEL_LIMITS.queued) return Promise.reject(failure('CHANNEL_QUEUE_CAPACITY', '渠道操作队列已满，请稍后重试')); queued++; const result = tail.then(async () => { if (closed) fail('CHANNEL_CLOSED', '渠道服务已关闭'); return work(); }); tail = result.catch(() => {}); return result.finally(() => { queued--; }); };
  const ready = (async () => {
    const stored = await persistence.read(); registry = stored ? validateRegistry(clone(stored)) : { schemaVersion: SCHEMA, port, profiles: IDS.map(profileDefaults), generations: [], bindings: [], receipts: [] };
    const interrupted = registry.receipts.some(receipt => receipt.status === 'prepared');
    if (interrupted) { registry.receipts = registry.receipts.map(receipt => receipt.status === 'prepared' ? { ...receipt, status: 'unknown', code: 'CHANNEL_INTERRUPTED_UNKNOWN' } : receipt); await persistence.write(registry); }
  })();
  function profile(id) { if (!IDS.includes(id)) fail('CHANNEL_NOT_FOUND', '未找到这个聊天渠道'); return registry.profiles.find(value => value.id === id); }
  async function save(next) { validateRegistry(next); await persistence.write(next); registry = next; }
  function compact(next) {
    let entries = next.receipts;
    while (entries.filter(terminal).length > CHANNEL_LIMITS.terminalReceipts || entries.length >= CHANNEL_LIMITS.receipts || Buffer.byteLength(JSON.stringify(next)) > CHANNEL_LIMITS.registryBytes - 8192) {
      const removable = entries.filter(value => terminal(value) && !value.capability).sort((a, b) => a.at - b.at)[0];
      if (!removable) fail('CHANNEL_RECEIPT_CAPACITY', '渠道元数据已满；未确认回执没有被删除');
      if (removable.kind === 'inbound') {
        const binding = next.bindings.find(value => value.sessionId === removable.sessionId);
        if (binding) binding.inboundFloorAt = Math.max(binding.inboundFloorAt, removable.sourceAt ?? removable.at);
      }
      entries = entries.filter(value => value.id !== removable.id); next.receipts = entries;
    }
    return next;
  }
  async function current() {
    await ready; const coordinator = await getCoordinator();
    if (!coordinator) fail('CHANNEL_INSTANCE_UNLOADED', '请先加载人格实例');
    await coordinator.ready; if (coordinator.initializationError) fail('CHANNEL_INSTANCE_UNAVAILABLE', '当前人格实例暂不可用');
    if (typeof coordinator.memoryRoot !== 'string' || !path.isAbsolute(coordinator.memoryRoot)) fail('CHANNEL_INSTANCE_UNAVAILABLE', '人格实例目录无效');
    return coordinator;
  }
  function activeRoot() { try { const value = getCoordinator(); if (value && typeof value.then !== 'function') return value.memoryRoot; if (value === null) return null; } catch {} return boundRoot; }
  function sameRoot(a, b) { return typeof a === 'string' && typeof b === 'string' && normalizedRoot(a) === normalizedRoot(b); }
  function handles(sessionId) { const root = activeRoot(); return Boolean(registry && root && registry.bindings.some(binding => binding.sessionId === sessionId && sameRoot(binding.memoryRoot, root))); }
  async function ensureIdle(id) {
    const coordinator = await getCoordinator(); if (!coordinator) return;
    const sessions = new Set(registry.bindings.filter(binding => sameRoot(binding.memoryRoot, coordinator.memoryRoot) && (!id || binding.profileId === id)).map(binding => binding.sessionId));
    if ([...(coordinator.agents?.values?.() ?? [])].some(value => { const agent = value.agent ?? value; return sessions.has(agent?.session?.id) && agent.status === 'running'; })) fail('CHANNEL_BUSY', '当前渠道对话仍在执行，请完成后再停用或切换');
  }
  function asClientProfile(value) { return { platform: value.platform, protocol: value.protocol, ...value.config }; }
  function client(value) {
    const fingerprint = hash(asClientProfile(value)); let entry = clients.get(value.id);
    const official = value.config.mode === 'official' ? connectionPort?.client(value.id) : null;
    if (value.config.mode === 'official' && !official) fail('CHANNEL_OFFICIAL_UNAVAILABLE', '扫码连接服务尚未就绪');
    if (!entry || entry.fingerprint !== fingerprint || official && entry.value !== official) { entry = { fingerprint, value: official ?? clientFactory(asClientProfile(value)), verified: false }; clients.set(value.id, entry); }
    return entry;
  }
  async function runProbe(selected) {
    if (selected.config.mode === 'official') await connectionPort?.ready;
    if (!selected.config.accountId || selected.config.mode !== 'official' && !selected.config.apiUrl) fail('CHANNEL_NOT_CONFIGURED', '请先完成扫码授权，或保存已有兼容桥配置');
    const entry = client(selected); let result;
    try { result = await entry.value.probe(); } catch (error) { report(error); result = { connected: false, status: 'unknown', code: cleanError(error).code }; }
    if (selected.config.mode === 'official' && result?.accountId !== selected.config.accountId) result = { connected: false, status: 'failed', code: 'CHANNEL_ACCOUNT_MISMATCH' };
    entry.verified = result?.connected === true; probes.set(selected.id, clone(result ?? { connected: false, status: 'unknown' })); return result;
  }
  function callbackUrl(id) { return 'http://127.0.0.1:' + (livePort ?? registry.port) + '/channels/' + id + '/events'; }
  async function speechCatalog() {
    try { return speechPort?.catalog ? await speechPort.catalog() : { supported: false, voices: [], reason: 'speech_provider_missing' }; }
    catch (error) { report(error); return { supported: false, voices: [], reason: 'speech_provider_unavailable' }; }
  }
  async function status() {
    await ready; const root = activeRoot(), speech = await speechCatalog();
    return { connections: registry.profiles.map(selected => {
      const official = selected.config.mode === 'official', last = probes.get(selected.id), connected = Boolean(selected.enabled && !suspended && (official ? clients.get(selected.id)?.value.listening : listener) && last?.connected), capabilities = last?.capabilities ?? {};
      return { id: selected.id, platform: selected.platform, ...(official && selected.id === 'qq' ? { deliveryPolicy: QQ_DELIVERY_POLICY } : {}), mode: official ? 'official' : 'bridge', protocol: official ? selected.id === 'qq' ? 'qqbot' : 'ilink' : selected.protocol, configured: Boolean(selected.config.accountId && (official || selected.config.apiUrl)), enabled: selected.enabled, connected,
        status: suspended && selected.enabled ? 'suspended' : !selected.enabled ? 'disabled' : connected ? 'connected' : last?.status ?? 'disconnected',
        error: last?.code ? { code: last.code, message: '本地桥未确认连接，请检查桥运行状态、账号和鉴权。' } : null,
        capabilities: { private: connected, group: connected && (selected.platform === 'qq' || capabilities.group === true), text: connected && capabilities.text !== false, voice: connected && capabilities.voice === true && speech.supported === true }, chatTypes: official && selected.id === 'wechat' ? ['private'] : ['private', 'group'],
        config: Object.fromEntries(Object.entries(selected.config).filter(([key]) => key !== 'accessToken')), hasAccessToken: Boolean(selected.config.accessToken), hasIngressToken: Boolean(selected.ingressHash), ingressAuthMode: selected.ingressHmacSecret ? 'onebot-hmac' : 'bearer', callbackUrl: callbackUrl(selected.id), recentExcluded: clone(selected.recentExcluded), currentInstance: root ?? null,
        driverRequired: !official, livePlatformVerified: false };
    }), listener: { running: Boolean(listener), host: '127.0.0.1', port: livePort }, voice: { supported: speech.supported === true, provider: speech.provider ?? null, catalog: { voices: speech.voices ?? [] }, capabilities: speech.capabilities ?? {} }, limits: { ...CHANNEL_LIMITS }, extensions: { telegram: 'reserved', mobileWeb: 'reserved' } };
  }
  async function closeListener() {
    const previous = listener; listener = null; livePort = null;
    if (!previous) return;
    const completion = new Promise(resolve => previous.close(resolve)); for (const socket of sockets) socket.destroy(); sockets.clear(); await completion;
  }
  function reply(response, statusCode, value) { if (response.destroyed) return; response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value)); }
  async function body(request) {
    const declared = Number(request.headers['content-length']); if (Number.isFinite(declared) && declared > CHANNEL_LIMITS.bodyBytes) fail('CHANNEL_BODY_CAPACITY', '渠道事件超过64KiB');
    if (String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') fail('CHANNEL_CONTENT_TYPE', '渠道事件必须是JSON');
    return new Promise((resolve, reject) => {
      let size = 0, chunks = [], done = false;
      request.on('data', chunk => { if (done) return; size += chunk.length; if (size > CHANNEL_LIMITS.bodyBytes) { done = true; chunks = []; reject(failure('CHANNEL_BODY_CAPACITY', '渠道事件超过64KiB')); } else chunks.push(chunk); });
      request.once('end', () => { if (done) return; done = true; resolve(Buffer.concat(chunks)); });
      request.once('error', () => { if (!done) { done = true; reject(failure('CHANNEL_REQUEST_ABORTED', '渠道事件读取中断')); } });
    });
  }
  async function callback(request, response) {
    try {
      const host = String(request.headers.host ?? '').toLowerCase(), acceptedHosts = ['127.0.0.1:' + livePort, 'localhost:' + livePort];
      if (!acceptedHosts.includes(host)) fail('CHANNEL_HOST_REJECTED', '渠道回调Host无效');
      const origin = request.headers.origin;
      if (origin !== undefined && !acceptedHosts.map(value => 'http://' + value).includes(origin)) fail('CHANNEL_ORIGIN_REJECTED', '渠道回调不接受跨站请求');
      const url = new URL(request.url, 'http://' + host), match = /^\/channels\/(qq|wechat)\/events$/.exec(url.pathname);
      if (!match || url.search) return reply(response, 404, { ok: false, error: { code: 'CHANNEL_ROUTE_NOT_FOUND', message: '未找到渠道回调' } });
      if (request.method !== 'POST') return reply(response, 405, { ok: false, error: { code: 'CHANNEL_METHOD', message: '渠道事件只接受POST' } });
      const selected = profile(match[1]), authorization = request.headers.authorization;
      if (selected.config.mode === 'official') fail('CHANNEL_TRANSPORT_MISMATCH', '此渠道已选择官方连接，不接收兼容桥回调');
      const incoming = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? hash(authorization.slice(7)) : null;
      const signature = request.headers['x-signature'], hmac = !incoming && selected.protocol === 'onebot11' && selected.ingressHmacSecret;
      if (!selected.ingressHash || (incoming ? !timingSafeEqual(Buffer.from(selected.ingressHash), Buffer.from(incoming)) : !hmac || typeof signature !== 'string' || !/^sha1=[a-fA-F0-9]{40}$/.test(signature) || String(request.headers['x-self-id'] ?? '') !== selected.config.accountId)) fail('CHANNEL_AUTH_REQUIRED', '渠道事件鉴权失败');
      const raw = await body(request);
      if (hmac && !timingSafeEqual(createHmac('sha1', hmac).update(raw).digest(), Buffer.from(signature.slice(5), 'hex'))) fail('CHANNEL_AUTH_REQUIRED', '渠道事件签名无效');
      let payload; try { payload = JSON.parse(raw.toString('utf8')); } catch { fail('CHANNEL_EVENT_INVALID', '渠道事件不是有效JSON'); }
      const authorizedHash = selected.ingressHash, result = await queue(() => {
        if (profile(selected.id).ingressHash !== authorizedHash || hmac && profile(selected.id).ingressHmacSecret !== hmac) fail('CHANNEL_AUTH_REQUIRED', '渠道事件令牌已经更新');
        return ingest(selected.id, payload);
      }); reply(response, 200, result);
    } catch (error) {
      const code = error.code ?? 'CHANNEL_CALLBACK_FAILED', statusCode = code === 'CHANNEL_AUTH_REQUIRED' ? 401 : /HOST|ORIGIN/.test(code) ? 403 : /CAPACITY/.test(code) ? 413 : /DISABLED|SUSPENDED|INSTANCE|BUSY|WINDOW/.test(code) ? 409 : 400;
      reply(response, statusCode, { ok: false, error: { code, message: /^CHANNEL_|^ONEBOT_/.test(code) ? error.message : '渠道事件未接收' } });
    }
  }
  async function listen() {
    if (listener) return;
    const server = http.createServer((request, response) => { void callback(request, response); }); server.maxConnections = 16; server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 3000;
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(registry.port, '127.0.0.1', resolve); });
    listener = server; livePort = server.address().port; server.on('error', report);
  }
  async function configure({ id, config } = {}) { return queue(async () => { await ready; const selected = profile(id); if (selected.enabled) fail('CHANNEL_STOP_BEFORE_CONFIG', '请先停用此渠道再修改接入配置'); const next = configuration(config, selected.config); if (next.mode !== 'official' && next.apiUrl && next.accountId) createOneBotClient({ platform: selected.platform, protocol: selected.protocol, ...next }); const changedIdentity = (selected.config.mode ?? 'bridge') !== next.mode || selected.config.accountId !== next.accountId; await save({ ...registry, profiles: registry.profiles.map(value => value.id === id ? { ...value, config: next, ...(changedIdentity ? { generation: (value.generation ?? 0) + 1 } : {}) } : value), bindings: changedIdentity ? registry.bindings.map(value => value.profileId === id ? { ...value, retired: true } : value) : registry.bindings }); clients.delete(id); probes.delete(id); return status(); }); }
  async function probe({ id } = {}) { return queue(async () => { await ready; await runProbe(profile(id)); return status(); }); }
  async function rotateIngress({ id, authMode = 'bearer' } = {}) { return queue(async () => { await ready; const selected = profile(id); if (!['bearer', 'onebot-hmac'].includes(authMode) || authMode === 'onebot-hmac' && selected.protocol !== 'onebot11') fail('CHANNEL_BAD_CONFIG', '此渠道不支持所选上报鉴权方式'); const value = randomBytes(32).toString('base64url'); await save({ ...registry, profiles: registry.profiles.map(item => { if (item.id !== id) return item; const { ingressHmacSecret, ...rest } = item; return { ...rest, ingressHash: hash(value), ...(authMode === 'onebot-hmac' ? { ingressHmacSecret: value } : {}) }; }) }); return { callbackUrl: callbackUrl(selected.id), ingressToken: value, authMode }; }); }
  async function start({ id, port: selectedPort } = {}) { return queue(async () => {
    await ready; const selected = profile(id), coordinator = await current();
    if (selectedPort !== undefined) {
      if (!Number.isSafeInteger(selectedPort) || selectedPort < 0 || selectedPort > 65535 || listener && selectedPort !== 0 && selectedPort !== livePort) fail('CHANNEL_BAD_CONFIG', '请在监听关闭时选择有效端口');
      if (!listener) await save({ ...registry, port: selectedPort });
    }
    if (selected.config.mode !== 'official' && !selected.ingressHash) fail('CHANNEL_INGRESS_REQUIRED', '请先生成并配置事件上报令牌');
    const checked = await runProbe(selected); if (!checked?.connected) fail('CHANNEL_BRIDGE_UNAVAILABLE', '本地桥尚未确认账号在线，请检查连接后启用');
    if (selected.config.mode !== 'official') await listen(); boundRoot = coordinator.memoryRoot; suspended = false;
    try { await save({ ...registry, profiles: registry.profiles.map(value => value.id === id ? { ...value, enabled: true } : value) }); }
    catch (error) { if (!registry.profiles.some(value => value.enabled)) await closeListener(); throw error; }
    if (selected.config.mode === 'official') try { await connectionPort.listen({ id }); } catch (error) { await save({ ...registry, profiles: registry.profiles.map(value => value.id === id ? { ...value, enabled: false } : value) }); report(error); throw error; }
    return status();
  }); }
  async function stop({ id } = {}) { return queue(async () => {
    await ready; profile(id); await ensureIdle(id);
    await save({ ...registry, profiles: registry.profiles.map(value => value.id === id ? { ...value, enabled: false } : value) });
    if (profile(id).config.mode === 'official') await connectionPort?.stop({ id });
    for (const binding of registry.bindings.filter(value => value.profileId === id)) await channelPort.closeChannel?.(binding);
    if (!registry.profiles.some(value => value.enabled && value.config.mode !== 'official')) await closeListener(); return status();
  }); }
  function allowed(selected, event) { const list = event.conversation.type === 'group' ? selected.config.allowedGroupIds : selected.config.allowedPrivateIds; const id = event.conversation.type === 'group' ? event.conversation.id : event.sender.id; return list.includes('*') || list.includes(id); }
  async function ingest(id, payload, normalized = false) {
    const selected = profile(id); if (suspended || selected.config.mode !== 'official' && !listener) fail('CHANNEL_SUSPENDED', '渠道当前未接收事件'); if (!selected.enabled) fail('CHANNEL_DISABLED', '这个渠道尚未启用');
    if (normalized !== (selected.config.mode === 'official')) fail('CHANNEL_TRANSPORT_MISMATCH', '渠道传输方式不匹配');
    const coordinator = await current(); if (!sameRoot(coordinator.memoryRoot, boundRoot)) fail('CHANNEL_INSTANCE_CHANGED', '人格实例已经切换，请重新启用渠道');
    if (!client(selected).verified && !(await runProbe(selected))?.connected) fail('CHANNEL_BRIDGE_UNAVAILABLE', '本地桥尚未确认当前账号在线，事件未接收');
    const event = normalized ? normalizedEvent(payload) : decodeOneBotEvent(asClientProfile(selected), payload); if (!event) return { status: 'ignored', accepted: false };
    if (event.platform !== selected.platform || event.accountId !== selected.config.accountId) fail('CHANNEL_ACCOUNT_MISMATCH', '事件不属于当前连接账号');
    if (!allowed(selected, event)) {
      const metadata = { senderId: event.sender.id, ...(event.conversation.type === 'group' ? { groupId: event.conversation.id } : {}), at: clock() };
      await save({ ...registry, profiles: registry.profiles.map(value => value.id === id ? { ...value, recentExcluded: [...value.recentExcluded, metadata].slice(-CHANNEL_LIMITS.excluded) } : value) });
      return { status: 'outside_scope', accepted: false };
    }
    if (!event.message.text && !event.rich?.hasStructuredContent) return { status: 'unsupported', accepted: false, unsupportedSegments: event.unsupportedSegments ?? [] };
    const root = coordinator.memoryRoot, generation = registry.generations.find(value => sameRoot(value.memoryRoot, root))?.value ?? 0;
    const facts = { platform: event.platform, accountId: event.accountId, conversation: event.conversation, sender: event.sender }, stable = hash([normalizedRoot(root), generation, facts.platform, facts.accountId, facts.conversation.type, facts.conversation.id, facts.sender.id, ...(selected.generation ? [selected.generation] : [])]);
    let binding = registry.bindings.find(value => value.sessionId === 'xiangxu-social-' + stable.slice(0, 32));
    const guardIntake = async () => { const live = await current(); if (!sameRoot(live.memoryRoot, root) || !sameRoot(root, boundRoot) || suspended || closed || !profile(id).enabled) fail('CHANNEL_INSTANCE_CHANGED', '人格实例或当前渠道已经切换，事件未继续派发'); };
    const sourceId = 'im-' + hash([event.platform, event.accountId, event.message.id, ...(normalized ? ['official'] : [])]), receiptId = hash([normalizedRoot(root), 'inbound', sourceId]), textHash = event.rich?.hasStructuredContent ? hash({ text:event.message.text,rich:event.rich }) : hash(event.message.text);
    const previous = registry.receipts.find(value => value.id === receiptId);
    if (previous) { if (previous.textHash !== textHash) fail('CHANNEL_MESSAGE_CONFLICT', '同一平台消息ID不能替换原文'); return { status: previous.status === 'prepared' ? 'unknown' : previous.status, accepted: previous.status === 'accepted', duplicate: true, messageId: previous.messageId }; }
    if (!binding && registry.bindings.length >= CHANNEL_LIMITS.bindings) fail('CHANNEL_BINDING_CAPACITY', '渠道会话登记已达到128条技术上限');
    if (binding) {
      if (binding.facts.platform !== facts.platform || binding.facts.accountId !== facts.accountId || binding.facts.conversation.type !== facts.conversation.type || binding.facts.conversation.id !== facts.conversation.id || binding.facts.sender.id !== facts.sender.id) fail('CHANNEL_BINDING_MISMATCH', '通道稳定来源与本次实际发言者不符');
      // Display clues may change; stable routing and all prior message originals remain untouched.
      binding = { ...binding, facts: clone(facts) };
    }
    binding ??= { profileId: id, sessionId: 'xiangxu-social-' + stable.slice(0, 32), memoryRoot: root, facts: clone(facts), generation, retired: false, createdAt: clock(), outboundWatermark: -1, inboundFloorAt: -1 };
    const receipt = { id: receiptId, kind: 'inbound', sessionId: binding.sessionId, messageId: sourceId, textHash, status: 'prepared', at: clock(), sourceAt: event.message.createdAt };
    const next = compact(clone(registry));
    const previousFloor = Math.max(-1, ...next.bindings.filter(value => sameRoot(value.memoryRoot, root) && value.facts.platform === facts.platform && value.facts.accountId === facts.accountId && value.facts.conversation.type === facts.conversation.type && value.facts.conversation.id === facts.conversation.id && value.facts.sender.id === facts.sender.id).map(value => value.inboundFloorAt));
    if (event.message.createdAt <= previousFloor) {
      next.profiles = next.profiles.map(value => value.id === id ? { ...value, recentExcluded: [...value.recentExcluded, { senderId: event.sender.id, ...(event.conversation.type === 'group' ? { groupId: event.conversation.id } : {}), at: clock(), code: 'CHANNEL_EVENT_OUTSIDE_DEDUPE_WINDOW' }].slice(-CHANNEL_LIMITS.excluded) } : value);
      await save(next); fail('CHANNEL_EVENT_OUTSIDE_DEDUPE_WINDOW', '此事件早于已保留去重窗口，未接收且没有送入模型');
    }
    if (!next.bindings.some(value => value.sessionId === binding.sessionId)) next.bindings.push({ ...binding, inboundFloorAt: previousFloor });
    else next.bindings = next.bindings.map(value => value.sessionId === binding.sessionId ? { ...value, facts: clone(binding.facts) } : value);
    next.receipts.push(receipt); await guardIntake(); await save(next);
    try {
      await guardIntake();
      const native = await channelPort.create(clone(binding));
      await guardIntake();
      if (native?.agentOptions) {
        binding = { ...binding, agentOptions: retainedRoute(native.agentOptions) };
        await save({ ...registry, bindings: registry.bindings.map(value => value.sessionId === binding.sessionId ? { ...value, agentOptions: binding.agentOptions } : value) });
      }
      await guardIntake();
      const incoming = event.rich?.hasStructuredContent ? await incomingMediaPort?.prepare(event,{client:client(selected).value,binding,config:selected.config}) : null;
      await guardIntake();
      await channelPort.send(clone(binding), { messageId: sourceId, text: event.message.text, ...(incoming ? { structured: incoming } : event.rich?.hasStructuredContent ? { structured: { rich:event.rich,derived:[],images:[] } } : {}), sourceFacts: { ...clone(facts), messageId: event.message.id, sourceMessageId: event.message.id, sourceAt: event.message.createdAt, textComplete: event.textComplete, ...(event.unsupportedSegments ? { unsupportedSegments: event.unsupportedSegments } : {}) } });
    } catch (error) {
      const safe = report(error);
      try { await save({ ...registry, receipts: registry.receipts.map(value => value.id === receiptId ? { ...value, status: 'unknown', code: safe.code } : value) }); } catch (persistError) { report(persistError); }
      return { status: 'unknown', accepted: false, messageId: sourceId, code: safe.code };
    }
    try { await save({ ...registry, receipts: registry.receipts.map(value => value.id === receiptId ? { ...value, status: 'accepted' } : value) }); }
    catch (error) {
      report(error);
      try { await save({ ...registry, receipts: registry.receipts.map(value => value.id === receiptId ? { ...value, status: 'unknown', code: 'CHANNEL_INBOUND_RECEIPT_UNKNOWN' } : value) }); } catch (persistError) { report(persistError); }
      return { status: 'unknown', accepted: false, messageId: sourceId, code: 'CHANNEL_INBOUND_RECEIPT_UNKNOWN' };
    }
    return { status: 'accepted', accepted: true, messageId: sourceId, sessionId: binding.sessionId };
  }
  function resultFor(receipt, duplicate = false) {
    if (receipt.operationResult) return { ...clone(receipt.operationResult), duplicate };
    if (receipt.status !== 'delivered') return { status: receipt.status === 'prepared' ? 'unknown' : receipt.status, duplicate, code: receipt.code ?? null, deliveryId: receipt.deliveryId ?? null };
    return { status: 'delivered', duplicate, deliveryId: receipt.deliveryId, receiptId: receipt.platformReceiptId, messageId: receipt.platformMessageId, ...(receipt.messageIdKind ? { messageIdKind: receipt.messageIdKind } : {}), deliveredAt: receipt.deliveredAt,
      sourceSessionId: receipt.sessionId, sourceEventId: receipt.sourceEventId, sourceSeq: receipt.seq, seq: receipt.seq, textHash: receipt.textHash, sourceKind: 'model', confirmedBy: receipt.confirmedBy,
      ...(receipt.formatVersion ? { formatVersion: receipt.formatVersion, sourceTextHash: receipt.sourceTextHash } : {}),
      ...(receipt.voiceUnavailable ? { voiceUnavailable: true } : {}), ...(receipt.voiceDelivery ? { voiceDelivery: clone(receipt.voiceDelivery) } : {}) };
  }
  const confirmedDelivery = value => value?.status === 'delivered' && typeof value.messageId === 'string' && typeof value.receiptId === 'string';
  const ackFields = value => ({ platformMessageId: value.messageId, platformReceiptId: value.receiptId, ...(value.messageIdKind ? { messageIdKind: value.messageIdKind } : {}), deliveredAt: value.deliveredAt ?? clock(), confirmedBy: value.confirmedBy ?? 'platform-receipt' });
  async function authorize(binding, capability) { await authorizeAction({ memoryRoot: binding.memoryRoot, platform: binding.facts.platform, accountId: binding.facts.accountId, capability }); }
  async function voiceDelivery(entry, binding, text, deliveryId) {
    await authorize(binding, 'chat.voice');
    if (!speechPort?.synthesize || !entry.value.sendVoice || entry.value.capabilities?.voice !== true) return { status: 'failed', code: 'CHANNEL_VOICE_UNAVAILABLE' };
    const coordinator = await current(), preferences = await coordinator.voice?.inspect?.('channel-voice');
    if (!preferences?.effective?.available) return { status: 'failed', code: 'CHANNEL_VOICE_UNAVAILABLE' };
    const selected = preferences.effective;
    let deliveredResult;
    try {
      const generated = await speechPort.synthesize({ text, voiceId: selected.resolvedVoiceId, rate: selected.rate, pitch: selected.pitch }, { requestId: deliveryId });
      if (generated.status !== 'generated') return { status: 'failed', code: generated.status === 'unsupportedPitch' ? 'CHANNEL_VOICE_PITCH_UNSUPPORTED' : 'CHANNEL_VOICE_GENERATION_UNAVAILABLE' };
      const stat = await fs.lstat(generated.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8388608) return { status: 'failed', code: 'CHANNEL_VOICE_CAPACITY' };
      const handle = await fs.open(generated.path, 'r'); let bytes;
      try { const buffer = Buffer.alloc(8388609), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); if (bytesRead > 8388608) fail('CHANNEL_VOICE_CAPACITY', '音频超出技术容量'); bytes = buffer.subarray(0, bytesRead); } finally { await handle.close(); }
      if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return { status: 'failed', code: 'CHANNEL_VOICE_FORMAT' };
      // Recheck the live binding after local synthesis. No generated bytes are
      // sent to a different instance or a subsequently retired connection.
      if (binding.retired || suspended || !sameRoot(binding.memoryRoot, activeRoot())) return { status: 'failed', code: 'CHANNEL_VOICE_CANCELLED' };
      await runProbe(profile(binding.profileId));
      if (!entry.verified || entry.value.capabilities?.voice !== true) return { status: 'failed', code: 'CHANNEL_VOICE_ACCOUNT_UNCONFIRMED' };
      deliveredResult = await entry.value.sendVoice(binding.facts, bytes, { deliveryId });
      return deliveredResult;
    } finally {
      try { await speechPort.cleanup?.(); }
      catch (error) { const safe = report(error); if (deliveredResult) deliveredResult.cacheCleanupFailed = safe.code; }
    }
  }
  async function output(args = {}) { return queue(async () => {
    await ready; bounded(args.sessionId, '会话'); bounded(args.sourceEventId, '来源事件');
    if (typeof args.text !== 'string' || !args.text || Array.from(args.text).length > 16000 || !Number.isSafeInteger(args.seq) || args.seq < 0) fail('CHANNEL_OUTPUT_CAPACITY', '外发原文或事件序号无效，没有截断或发送');
    const binding = registry.bindings.find(value => value.sessionId === args.sessionId); if (!binding) return { status: 'unknown', code: 'CHANNEL_BINDING_NOT_FOUND' };
    const id = hash([normalizedRoot(binding.memoryRoot), 'outbound', args.sessionId, args.sourceEventId]), previous = registry.receipts.find(value => value.id === id);
    if (previous) { const actual = resolveExternalOutput(args.text, previous); if (!actual) fail('CHANNEL_OUTPUT_CONFLICT', '同一来源事件不能替换外发原文'); return { ...resultFor(previous, true), ...(previous.status === 'delivered' ? { text: actual.text } : {}) }; }
    if (args.seq <= binding.outboundWatermark) return { status: 'unknown', code: 'CHANNEL_RECEIPT_EXPIRED', duplicate: true };
    const projection = projectExternalOutput(args.text), text = projection.text;
    if (!text || Array.from(text).length > 16000) fail('CHANNEL_OUTPUT_CAPACITY', '平台显示文字超过外发容量，没有截断或发送');
    const selected = profile(binding.profileId), deliveryId = args.deliveryId || 'im-out-' + id.slice(0, 48), receipt = { id, kind: 'outbound', sessionId: args.sessionId, sourceEventId: args.sourceEventId, seq: args.seq, textHash: projection.deliveryTextHash, sourceTextHash: projection.sourceTextHash, formatVersion: projection.formatVersion, deliveryId, status: 'prepared', at: clock() };
    bounded(deliveryId, '交付编号', 160);
    const next = compact(clone(registry)); next.receipts.push(receipt); await save(next);
    let outcome, audioOutcome = null;
    if (binding.retired || suspended || !selected.enabled || !sameRoot(binding.memoryRoot, activeRoot()) || !allowed(selected, binding.facts)) outcome = { status: 'unknown', code: binding.retired ? 'CHANNEL_BINDING_RETIRED' : 'CHANNEL_DISABLED' };
    else {
      try {
        const entry = client(selected); await runProbe(selected);
        if (!entry.verified) outcome = { status: 'unknown', code: 'CHANNEL_BRIDGE_UNAVAILABLE' };
        else if (selected.config.voiceMode === 'voice') outcome = audioOutcome = await voiceDelivery(entry, binding, text, deliveryId + '-voice');
        else {
          await authorize(binding, 'chat.text');
          outcome = await entry.value.sendText(binding.facts, text, { deliveryId });
          if (selected.config.voiceMode === 'both' && confirmedDelivery(outcome)) {
            const checkpoint = clone(registry), partial = { ...receipt, status: 'delivered', ...ackFields(outcome), voiceDelivery: { status: 'unknown', code: 'CHANNEL_VOICE_NOT_CONFIRMED' } };
            checkpoint.receipts = checkpoint.receipts.map(value => value.id === id ? partial : value);
            checkpoint.bindings.find(value => value.sessionId === binding.sessionId).outboundWatermark = Math.max(binding.outboundWatermark, args.seq);
            // Persist the already-known text receipt before beginning another
            // delivery. A process failure cannot erase that acknowledged fact.
            await save(checkpoint);
            try { audioOutcome = await voiceDelivery(entry, binding, text, deliveryId + '-voice'); }
            catch (error) { report(error); audioOutcome = { status: 'unknown', code: 'CHANNEL_VOICE_OUTCOME_UNKNOWN' }; }
          }
        }
      } catch (error) { const safe = report(error); outcome = { status: 'unknown', code: safe.code }; }
    }
    const confirmed = confirmedDelivery(outcome);
    const audioSummary = audioOutcome ? { status: confirmedDelivery(audioOutcome) ? 'delivered' : audioOutcome.status === 'failed' ? 'failed' : 'unknown', ...(confirmedDelivery(audioOutcome) ? ackFields(audioOutcome) : { code: audioOutcome.code ?? 'CHANNEL_VOICE_NOT_CONFIRMED' }), ...(audioOutcome.cacheCleanupFailed ? { cacheCleanupFailed: audioOutcome.cacheCleanupFailed } : {}) } : null;
    const finished = { ...receipt, status: confirmed ? 'delivered' : outcome?.status === 'failed' ? 'failed' : 'unknown', ...(confirmed ? ackFields(outcome) : { code: outcome?.code ?? 'CHANNEL_DELIVERY_UNKNOWN' }), ...(selected.config.voiceMode !== 'text' && !confirmedDelivery(audioOutcome) ? { voiceUnavailable: true } : {}), ...(audioSummary ? { voiceDelivery: audioSummary } : {}) };
    const final = clone(registry); final.receipts = final.receipts.map(value => value.id === id ? finished : value);
    const storedBinding = final.bindings.find(value => value.sessionId === binding.sessionId); storedBinding.outboundWatermark = Math.max(storedBinding.outboundWatermark, args.seq);
    try { await save(final); } catch (error) {
      report(error);
      const retained = registry.receipts.find(value => value.id === id);
      if (retained?.status === 'delivered') return { ...resultFor(retained), text, voiceUnavailable: true, voiceDelivery: { status: 'unknown', code: 'CHANNEL_VOICE_RECEIPT_PERSIST_UNKNOWN' } };
      return { status: 'unknown', code: 'CHANNEL_RECEIPT_PERSIST_UNKNOWN', deliveryId };
    }
    return { ...resultFor(finished), ...(finished.status === 'delivered' ? { text } : {}), ...(finished.voiceUnavailable ? { voiceUnavailable: true } : {}) };
  }); }
  async function reconcile(record = {}) { await ready; const sessionId = record.target?.sessionId ?? record.sessionId;
    const found = registry.receipts.find(value => value.kind === 'outbound' && value.sessionId === sessionId && (record.sourceEventId ? value.sourceEventId === record.sourceEventId : record.deliveryId && value.deliveryId === record.deliveryId));
    return found ? resultFor(found, true) : { status: 'unknown', code: 'CHANNEL_RECEIPT_UNAVAILABLE' };
  }
  async function receive({ id, event } = {}) { return queue(async () => { await ready; return ingest(id, event, true); }); }
  async function getAccountBridge() {
    await ready;
    const selected = profile('qq');
    if (closed || suspended || !selected.enabled || selected.config.mode === 'official' || !selected.config.accountId || !selected.config.apiUrl) return null;
    const sourceCoordinator=getCoordinator();if(!sourceCoordinator)return null;
    const entry = client(selected), connectionId = hash([entry.fingerprint, selected.generation ?? 0]);
    const unchanged = () => { const current=profile('qq'); return !closed && !suspended && getCoordinator()===sourceCoordinator && current.enabled && current.config.mode !== 'official' && current.config.accountId === selected.config.accountId && client(current) === entry && hash([entry.fingerprint,current.generation??0]) === connectionId; };
    const result = await runProbe(selected);
    if (!unchanged()) fail('CHANNEL_ACCOUNT_MISMATCH', 'QQ连接已切换');
    const connected=result?.connected===true, identityVerified=connected&&result.accountId===selected.config.accountId;
    await entry.value.inspectCapabilities?.();
    if (!unchanged()) fail('CHANNEL_ACCOUNT_MISMATCH', 'QQ连接已切换');
    const accountCapabilities=await entry.value.inspectAccountCapabilities?.(), operations=accountCapabilities?.operations ?? {};
    if (!unchanged()) fail('CHANNEL_ACCOUNT_MISMATCH', 'QQ连接已切换');
    return { accountId:selected.config.accountId, enabled:true, connected, identityVerified, connectionId, operations,
      async executeAccount(operation,payload,context) {
        if (!unchanged()) fail('CHANNEL_ACCOUNT_MISMATCH','QQ连接已切换');
        if(typeof entry.value.executeAccount!=='function')fail('CAPABILITY_UNSUPPORTED','QQ桥未提供此账号操作');
        const checked=await runProbe(profile('qq'));
        if(!unchanged()||checked?.connected!==true||checked.accountId!==selected.config.accountId)fail('CHANNEL_ACCOUNT_MISMATCH','QQ账号未在线或已切换');
        return entry.value.executeAccount(operation,payload,{...context,assertCurrent:()=>{
          context?.signal?.throwIfAborted();
          if(!unchanged())fail('CHANNEL_ACCOUNT_MISMATCH','QQ连接或人格已停止或切换');
          context?.assertCurrent?.();
        }});
      }
    };
  }
  async function capabilities({ id, sessionId } = {}) {
    await ready;
    const binding = sessionId ? registry.bindings.find(value => value.sessionId === sessionId) : null;
    const selected = profile(id ?? binding?.profileId), known = probes.get(selected.id); let supported;
    try { const entry = client(selected); supported = await entry.value.inspectCapabilities?.(); supported ??= capabilityMap(['chat.text', ...(entry.value.capabilities?.voice ? ['chat.voice'] : [])]); }
    catch { supported = capabilityMap([]); }
    const live = (await status()).connections.find(value => value.id === selected.id);
    const verifiedAccountId = known?.connected === true && typeof known.accountId === 'string' && known.accountId ? known.accountId : null;
    const identityVerified = verifiedAccountId !== null && verifiedAccountId === selected.config.accountId;
    return { id: selected.id, platform: selected.platform, accountId: selected.config.accountId, verifiedAccountId, identityVerified, ...(selected.config.mode === 'official' && selected.id === 'qq' ? { deliveryPolicy: QQ_DELIVERY_POLICY } : {}), mode: selected.config.mode ?? 'bridge', connected: live.connected, voiceMode: selected.config.voiceMode, chatTypes: live.chatTypes, items: CAPABILITY_IDS.map(id => ({ id, supported: supported[id]?.supported === true, available: supported[id]?.supported === true && live.connected, reason: supported[id]?.reason ?? (live.connected ? null : known?.code ?? '连接后才可使用') })) };
  }
  async function execute({ sessionId, capability, payload = {}, requestId } = {}) { return queue(async () => {
    await ready; bounded(sessionId, '会话'); bounded(requestId, '操作编号', 160);
    if (!CAPABILITY_IDS.includes(capability) || !object(payload) || Object.keys(payload).some(key => !['text', 'bytes', 'mime', 'filename', 'messageId', 'stickerId', 'quoteMessageId', 'mentionUserId', 'mentionAll', 'forwardId'].includes(key))) fail('CHANNEL_CAPABILITY_REQUEST', '平台操作参数无效');
    const metadata = {}; for (const [key, value] of Object.entries(payload)) { if (key === 'bytes') { if (!(value instanceof Uint8Array) || !value.byteLength || value.byteLength > 16777216) fail('CHANNEL_MEDIA_CAPACITY', '媒体字节超过技术容量'); metadata.bytesSha256 = hash(value); metadata.bytesLength = value.byteLength; } else if (key === 'mentionAll') { if (typeof value !== 'boolean') fail('CHANNEL_CAPABILITY_REQUEST','提及全体标记必须为开关'); metadata[key]=value; } else { bounded(value, key, key === 'text' ? 16000 : 512, key === 'text'); metadata[key] = value; } }
    const binding = registry.bindings.find(value => value.sessionId === sessionId); if (!binding) fail('CHANNEL_BINDING_NOT_FOUND', '没有对应的平台会话');
    const id = hash([normalizedRoot(binding.memoryRoot), 'capability', sessionId, requestId]), textHash = hash({ capability, metadata }), previous = registry.receipts.find(value => value.id === id);
    if (previous) { if (previous.textHash !== textHash) fail('CHANNEL_OUTPUT_CONFLICT', '同一操作编号不能替换动作或内容'); return resultFor(previous, true); }
    const selected = profile(binding.profileId);
    if (binding.retired || suspended || !selected.enabled || !sameRoot(binding.memoryRoot, activeRoot()) || !allowed(selected, binding.facts)) fail('CHANNEL_DISABLED', '此目标当前未接入');
    const checked = await runProbe(selected); if (!checked.connected) fail('CHANNEL_BRIDGE_UNAVAILABLE', '平台连接尚未确认');
    const entry = client(selected), available = await capabilities({ id: selected.id }); if (!available.items.find(item => item.id === capability)?.supported) fail('CAPABILITY_UNSUPPORTED', '当前连接器没有实现这个能力');
    await authorize(binding, capability);
    if (['contacts.read', 'groups.read', 'message.read', 'message.forward.read'].includes(capability)) { const read = await entry.value.execute(binding.facts, capability, payload, { deliveryId: 'im-read-' + id.slice(0, 48) }); if (Buffer.byteLength(JSON.stringify(read)) > 32768) fail('CHANNEL_READ_CAPACITY', '读取结果超过单次技术容量'); return read; }
    const deliveryId = 'im-cap-' + id.slice(0, 48), receipt = { id, kind: 'outbound', sessionId, sourceEventId: 'capability:' + requestId, textHash, deliveryId, capability, status: 'prepared', at: clock() };
    const next = compact(clone(registry)); next.receipts.push(receipt); await save(next);
    let outcome;
    try { if (entry.value.execute) outcome = await entry.value.execute(binding.facts, capability, payload, { deliveryId }); else if (capability === 'chat.text') outcome = await entry.value.sendText(binding.facts, payload.text, { deliveryId }); else if (capability === 'chat.voice') outcome = await entry.value.sendVoice(binding.facts, payload.bytes, { deliveryId }); else outcome = { status: 'unsupported', code: 'CAPABILITY_UNSUPPORTED' }; }
    catch (error) { outcome = { status: 'unknown', code: report(error).code }; }
    const result = Object.fromEntries(Object.entries(outcome ?? { status: 'unknown' }).filter(([key]) => ['status', 'deliveryId', 'messageId', 'messageIdKind', 'receiptId', 'deliveredAt', 'confirmedBy', 'affectedMessageId', 'code'].includes(key)));
    const accepted = confirmedDelivery(result) || result.status === 'completed' && typeof result.receiptId === 'string';
    if (!accepted && !['failed', 'unsupported'].includes(result.status)) result.status = 'unknown';
    const final = { ...receipt, status: accepted ? 'delivered' : result.status === 'unknown' ? 'unknown' : 'failed', ...(accepted && result.messageId ? ackFields(result) : {}), operationResult: result };
    await save({ ...registry, receipts: registry.receipts.map(value => value.id === id ? final : value) }); return result;
  }); }
  async function suspend() { return queue(async () => { await ready; await ensureIdle(); suspended = true; await connectionPort?.stop(); await closeListener(); await channelPort.close(); return status(); }); }
  async function resume() { return queue(async () => {
    await ready; const coordinator = await getCoordinator(); if (!coordinator) { suspended = true; return status(); }
    await coordinator.ready; boundRoot = coordinator.memoryRoot; suspended = false;
    const enabled = registry.profiles.filter(value => value.enabled);
    for (const selected of enabled) await runProbe(selected);
    if (enabled.some(value => value.config.mode !== 'official')) await listen();
    for (const selected of enabled.filter(value => value.config.mode === 'official')) if (probes.get(selected.id)?.connected) await connectionPort?.listen({ id: selected.id }); return status();
  }); }
  async function invalidateForRoot(input) { return queue(async () => {
    await ready; const root = typeof input === 'string' ? input : input?.memoryRoot; if (!root || !path.isAbsolute(root)) fail('CHANNEL_BAD_REQUEST', '需要明确实例目录');
    const affectsActive = Boolean(boundRoot && sameRoot(boundRoot, root)); if (affectsActive) await ensureIdle();
    const affected = new Set(registry.bindings.filter(value => sameRoot(value.memoryRoot, root)).map(value => value.profileId)), next = clone(registry);
    next.bindings = next.bindings.map(value => sameRoot(value.memoryRoot, root) ? { ...value, retired: true } : value);
    const old = next.generations.find(value => sameRoot(value.memoryRoot, root)); if (old) old.value++; else next.generations.push({ memoryRoot: root, value: 1 });
    if (affectsActive) next.profiles = next.profiles.map(value => affected.has(value.id) ? { ...value, enabled: false } : value);
    await save(next); if (affectsActive) { await connectionPort?.stop(); await closeListener(); await channelPort.close(); suspended = true; }
    return { invalidated: true, profiles: [...affected], stopped: affectsActive };
  }); }
  async function close() { if (closed) return; await tail; closed = true; suspended = true; await connectionPort?.stop(); await closeListener(); await channelPort.close(); }
  return { ready, status, configure, start, stop, probe, rotateIngress, suspend, resume, invalidateForRoot, close, output, reconcile, handles, receive, capabilities, execute, getAccountBridge };
}
