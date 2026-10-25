import http from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { atomicReplaceWithRetry } from '../../core/store.js';

const SCHEMA = 'xiangxu-mobile/1', MAX_REGISTRY = 131072, MAX_DEVICES = 8, MAX_REQUESTS = 256;
const PAIR_TTL = 300000, DEVICE_TTL = 30 * 86400000, REQUEST_TTL = 600000, MAX_BODY = 98304, MAX_RESPONSE = 131072;
const DEFAULTS = Object.freeze({ host: '127.0.0.1', port: 17653, publicBaseUrl: '', autoStart: false });
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = text => createHash('sha256').update(text).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const safeId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
const bounded = (value, length, code = 'MOBILE_BAD_REQUEST') => { if (typeof value !== 'string' || Array.from(value).length > length) fail(code, '输入长度无效'); return value; };
function configuration(partial, previous = DEFAULTS) {
  if (!object(partial)) fail('MOBILE_BAD_CONFIG', '聊天连接配置必须是对象');
  for (const key of Object.keys(partial)) if (!Object.hasOwn(DEFAULTS, key)) fail('MOBILE_BAD_CONFIG', '未知聊天连接配置');
  const result = { ...previous, ...partial };
  if (!['127.0.0.1', '0.0.0.0'].includes(result.host) || !Number.isSafeInteger(result.port) || result.port < 0 || result.port > 65535 || typeof result.autoStart !== 'boolean') fail('MOBILE_BAD_CONFIG', '请选择本机或局域网地址及有效端口');
  if (typeof result.publicBaseUrl !== 'string' || result.publicBaseUrl.length > 256) fail('MOBILE_BAD_CONFIG', '外部地址无效');
  if (result.publicBaseUrl) {
    let url; try { url = new URL(result.publicBaseUrl); } catch { fail('MOBILE_BAD_CONFIG', '外部地址必须是HTTPS源地址'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) fail('MOBILE_BAD_CONFIG', '外部地址必须是无路径与凭据的HTTPS源地址');
    result.publicBaseUrl = url.origin;
  }
  return result;
}
function privateIpv4(address) {
  const values = address.split('.').map(Number);
  return values.length === 4 && values.every(value => Number.isInteger(value) && value >= 0 && value <= 255) &&
    (values[0] === 10 || values[0] === 192 && values[1] === 168 || values[0] === 172 && values[1] >= 16 && values[1] <= 31);
}
function localPeer(address) {
  if (typeof address !== 'string') return false;
  const value = address.startsWith('::ffff:') ? address.slice(7) : address;
  return value === '::1' || value.startsWith('127.') || privateIpv4(value) || /^(?:fc|fd)[0-9a-f]{2}:|^fe[89ab][0-9a-f]:/i.test(value);
}
function validateRegistry(value) {
  if (!object(value) || value.schemaVersion !== SCHEMA || !Array.isArray(value.devices) || value.devices.length > MAX_DEVICES || !Array.isArray(value.requests) || value.requests.length > MAX_REQUESTS || Buffer.byteLength(JSON.stringify(value)) > MAX_REGISTRY) fail('MOBILE_REGISTRY_INVALID', '聊天连接登记格式或容量不兼容');
  const ids = new Set(), hashes = new Set(), timestamp = item => Number.isSafeInteger(item) && item >= 0;
  for (const device of value.devices) {
    const channel = device?.channel, selection = channel?.agentOptions;
    if (!object(device) || !safeId(device.id) || ids.has(device.id) || typeof device.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(device.tokenHash) || hashes.has(device.tokenHash) ||
      typeof device.label !== 'string' || !device.label.trim() || Array.from(device.label).length > 80 || !timestamp(device.createdAt) || !timestamp(device.expiresAt) || !timestamp(device.lastSeenAt) || device.expiresAt < device.createdAt || device.lastSeenAt < device.createdAt ||
      !object(channel) || !safeId(channel.sessionId) || !channel.sessionId.startsWith('xiangxu-mobile-') || typeof channel.memoryRoot !== 'string' || channel.memoryRoot.length > 4096 || channel.memoryRoot.includes('\0') || !path.isAbsolute(channel.memoryRoot) || !object(selection) ||
      Object.keys(selection).some(key => !['provider', 'model', 'reasoningEffort', 'maxTokens'].includes(key)) || !['provider', 'model'].every(key => typeof selection[key] === 'string' && selection[key].length > 0 && selection[key].length <= 256) ||
      selection.reasoningEffort !== undefined && (typeof selection.reasoningEffort !== 'string' || selection.reasoningEffort.length > 64) || selection.maxTokens !== undefined && (!Number.isSafeInteger(selection.maxTokens) || selection.maxTokens < 1 || selection.maxTokens > 10000000)) fail('MOBILE_REGISTRY_INVALID', '聊天设备登记无效');
    ids.add(device.id); hashes.add(device.tokenHash);
  }
  const requests = new Set();
  for (const receipt of value.requests) {
    const key = receipt?.deviceId + ':' + receipt?.requestId;
    if (!object(receipt) || Object.keys(receipt).some(name => !['deviceId', 'requestId', 'textHash', 'messageId', 'status', 'at'].includes(name)) || !ids.has(receipt.deviceId) || !safeId(receipt.requestId) || requests.has(key) ||
      typeof receipt.textHash !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.textHash) || receipt.messageId !== 'mobile-' + receipt.deviceId + '-' + receipt.requestId || !['prepared', 'accepted', 'unknown'].includes(receipt.status) || !timestamp(receipt.at)) fail('MOBILE_REGISTRY_INVALID', '聊天发送收据无效');
    requests.add(key);
  }
  return value;
}
async function ordinaryPath(file) {
  const full = path.resolve(file); let current = path.parse(full).root;
  for (const part of full.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) fail('MOBILE_REGISTRY_PATH', '聊天连接登记不能经过符号链接或目录联接'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return full;
}
export function createMobileRegistryStorage(file) {
  let tail = Promise.resolve();
  return {
    async read() {
      const full = await ordinaryPath(file);
      try {
        const stat = await fs.lstat(full); if (!stat.isFile() || stat.size > MAX_REGISTRY) fail('MOBILE_REGISTRY_CAPACITY', '聊天登记超过128KiB或不是普通文件');
        const handle = await fs.open(full, 'r');
        try { const buffer = Buffer.alloc(MAX_REGISTRY + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); if (bytesRead > MAX_REGISTRY) fail('MOBILE_REGISTRY_CAPACITY', '聊天登记超过128KiB'); return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); }
        finally { await handle.close(); }
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    write(value) {
      const result = tail.then(async () => {
        const text = JSON.stringify(value, null, 2) + '\n'; if (Buffer.byteLength(text) > MAX_REGISTRY) fail('MOBILE_REGISTRY_CAPACITY', '聊天连接登记超过128KiB');
        const full = await ordinaryPath(file); await fs.mkdir(path.dirname(full), { recursive: true }); await ordinaryPath(file);
        const temporary = full + '.next';
        try { if ((await fs.lstat(temporary)).isSymbolicLink()) fail('MOBILE_REGISTRY_PATH', '临时登记文件不能是链接'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const handle = await fs.open(temporary, 'w', 0o600);
        try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
        await atomicReplaceWithRetry(temporary, full);
      }); tail = result.catch(() => {}); return result;
    },
  };
}

/** Optional phone-only transport. The registry is outside persona backups and contains no chat text. */
export function createMobileChatService({ getCoordinator, channelPort, registryPath, storage, assetsDir, getVoice, clock = Date.now, interfaces = networkInterfaces, onError = () => {} } = {}) {
  if (typeof getCoordinator !== 'function' || !channelPort?.create || !assetsDir || !storage && !registryPath) throw new TypeError('Mobile service needs a coordinator, native channel, registry and assets');
  const persistence = storage ?? createMobileRegistryStorage(registryPath);
  let registry, server = null, boundCoordinator = null, livePort = null, pairing = null, lastError = null, closed = false, wanted = false, tail = Promise.resolve();
  const sockets = new Set();
  const queue = work => { const result = tail.then(work); tail = result.catch(() => {}); return result; };
  const ready = (async () => {
    const stored = await persistence.read();
    registry = stored ? validateRegistry(structuredClone(stored)) : { schemaVersion: SCHEMA, configuration: { ...DEFAULTS }, devices: [], requests: [] };
    registry.configuration = configuration(registry.configuration);
    const interrupted = registry.requests.some(receipt => receipt.status === 'prepared');
    for (const receipt of registry.requests) if (receipt.status === 'prepared') receipt.status = 'unknown';
    if (interrupted) await persistence.write(registry);
  })();
  async function save(next) { validateRegistry(next); await persistence.write(next); registry = next; }
  async function current() {
    await ready;
    const value = await getCoordinator();
    if (!value) fail('MOBILE_INSTANCE_UNLOADED', '请在电脑端加载人格实例');
    await value.ready;
    if (value.initializationError) fail('MOBILE_INSTANCE_UNAVAILABLE', '人格实例暂不可用');
    return value;
  }
  function addresses() {
    if (!server || livePort === null) return [];
    const result = ['http://127.0.0.1:' + livePort];
    if (registry.configuration.host === '0.0.0.0') for (const rows of Object.values(interfaces())) for (const item of rows ?? []) if ((item.family === 'IPv4' || item.family === 4) && !item.internal && privateIpv4(item.address)) result.push('http://' + item.address + ':' + livePort);
    return [...new Set(result)];
  }
  const origins = () => [...addresses(), ...(server ? ['http://localhost:' + livePort] : []), ...(registry.configuration.publicBaseUrl ? [registry.configuration.publicBaseUrl] : [])];
  async function status() {
    await ready; const active = await getCoordinator(), same = Boolean(server && active && active === boundCoordinator);
    return { enabled: same, listening: Boolean(server), port: livePort, addresses: addresses(), publicBaseUrl: registry.configuration.publicBaseUrl,
      configuration: { ...registry.configuration }, instanceAvailable: Boolean(active), boundToCurrentInstance: same, wanted,
      devices: registry.devices.filter(device => device.expiresAt > clock()).map(({ id, label, createdAt, expiresAt, lastSeenAt, channel }) => ({ id, label, createdAt, expiresAt, lastSeenAt, currentInstance: channel.memoryRoot === active?.memoryRoot })),
      pairing: pairing && pairing.expiresAt > clock() ? { active: true, expiresAt: pairing.expiresAt } : null,
      limits: { devices: MAX_DEVICES, registryBytes: MAX_REGISTRY, pairingExpiresMs: PAIR_TTL, deviceExpiresMs: DEVICE_TTL, requestWindowMs: REQUEST_TTL, messageChars: 16000, pageMessages: 100, responseBytes: MAX_RESPONSE }, error: lastError };
  }
  async function configure(args) {
    return queue(async () => { await ready; if (server) fail('MOBILE_STOP_BEFORE_CONFIG', '请先停用聊天连接再更改监听配置'); const value = configuration(args, registry.configuration); await save({ ...registry, configuration: value }); return status(); });
  }
  async function closeListener() {
    pairing = null; const previous = server; server = null; livePort = null; boundCoordinator = null;
    if (!previous) return;
    const completion = new Promise(resolve => previous.close(resolve));
    for (const socket of sockets) socket.destroy(); sockets.clear(); await completion;
  }
  async function start(args = {}) {
    return queue(async () => {
      await ready; if (closed) fail('MOBILE_CLOSED', '聊天连接管理已关闭');
      if (server) return status();
      const desired = configuration(args, registry.configuration), active = await current();
      await save({ ...registry, configuration: desired });
      const listener = http.createServer((request, response) => { void handle(request, response).catch(error => { onError(error); if (!response.headersSent) respond(response, 500, { ok: false, error: { code: 'MOBILE_INTERNAL', message: '聊天服务暂不可用，请在电脑端查看诊断' } }); else response.destroy(); }); });
      listener.maxHeadersCount = 32; listener.headersTimeout = 10000; listener.requestTimeout = 15000; listener.keepAliveTimeout = 5000;
      listener.on('connection', socket => { if (sockets.size >= 32) { socket.destroy(); return; } sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      listener.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
      try { await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(desired.port, desired.host, () => { listener.removeListener('error', reject); resolve(); }); }); }
      catch (error) { lastError = { code: error.code ?? 'MOBILE_LISTEN_FAILED', message: '聊天端口未能启动，请检查端口或本机网络' }; listener.close(); throw Object.assign(new Error(lastError.message), { code: lastError.code }); }
      server = listener; livePort = listener.address().port; boundCoordinator = active; lastError = null; wanted = true;
      listener.on('error', error => { lastError = { code: error.code ?? 'MOBILE_SERVER_FAILED', message: '聊天监听器出错' }; onError(error); });
      return status();
    });
  }
  const stop = () => queue(async () => { await ready; wanted = false; await closeListener(); return status(); });
  const assertLifecycleIdle = () => {
    if ([...(boundCoordinator?.agents?.values?.() ?? [])].some(value => value.agent?.status === 'running')) fail('INSTANCE_BUSY', '当前有正在执行的对话，请在完成后停用或切换实例');
  };
  const suspend = () => queue(async () => {
    await ready;
    // A phone send may enter between the manager's initial idle check and this
    // queued boundary. Refuse before changing transport/handles if it started a turn.
    if (server) assertLifecycleIdle();
    wanted ||= Boolean(server); await closeListener(); await channelPort.close?.(); return status();
  });
  async function resume() { await ready; if (closed || !await getCoordinator()) return status(); if (wanted || registry.configuration.autoStart) return start(); return status(); }
  async function pair(args = {}) {
    return queue(async () => {
      await ready; const active = await current();
      if (!server || active !== boundCoordinator) fail('MOBILE_NOT_STARTED', '请先启动当前实例的聊天连接');
      const label = bounded(args.label ?? '我的手机', 80).trim() || '我的手机', baseUrl = args.baseUrl ?? addresses().find(url => !url.includes('127.0.0.1')) ?? addresses()[0];
      if (!origins().includes(baseUrl)) fail('MOBILE_BASE_URL', '请选择当前可用连接地址或已配置的HTTPS外部地址');
      const raw = token(), expiresAt = clock() + PAIR_TTL, id = randomUUID();
      pairing = { id, tokenHash: digest(raw), expiresAt, label, memoryRoot: active.memoryRoot };
      return { pairUrl: baseUrl + '/#pair=' + raw, expiresAt, pairId: id };
    });
  }
  async function revoke({ deviceId } = {}) {
    return queue(async () => { await ready; if (!safeId(deviceId)) fail('MOBILE_BAD_REQUEST', '设备标识无效'); const device = registry.devices.find(item => item.id === deviceId); if (!device) fail('MOBILE_DEVICE_NOT_FOUND', '设备已撤销或不存在'); await save({ ...registry, devices: registry.devices.filter(item => item.id !== deviceId), requests: registry.requests.filter(item => item.deviceId !== deviceId) }); return status(); });
  }
  async function invalidateForRoot(memoryRoot) {
    return queue(async () => {
      await ready;
      // Restore invalidation runs before the manager's stopping hook. Keep its
      // late busy check ahead of authorization changes, not after clearing the binding.
      if (boundCoordinator?.memoryRoot === memoryRoot) assertLifecycleIdle();
      pairing = null; const ids = new Set(registry.devices.filter(device => device.channel.memoryRoot === memoryRoot).map(device => device.id));
      await save({ ...registry, devices: registry.devices.filter(device => !ids.has(device.id)), requests: registry.requests.filter(item => !ids.has(item.deviceId)) });
      if (boundCoordinator?.memoryRoot === memoryRoot) await closeListener(); return { revokedDevices: ids.size, stopped: !server };
    });
  }
  function respond(response, statusCode, value, extra = {}) {
    const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value);
    if (Buffer.byteLength(bytes) > MAX_RESPONSE) fail('MOBILE_RESPONSE_CAPACITY', '聊天响应超过容量');
    response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', ...extra }); response.end(bytes);
  }
  async function body(request) {
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') fail('MOBILE_CONTENT_TYPE', '请发送JSON聊天请求');
    const declared = Number(request.headers['content-length']); if (Number.isFinite(declared) && declared > MAX_BODY) fail('MOBILE_BODY_CAPACITY', '聊天请求超过容量');
    const chunks = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; if (bytes > MAX_BODY) fail('MOBILE_BODY_CAPACITY', '聊天请求超过容量'); chunks.push(chunk); }
    let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('MOBILE_BAD_REQUEST', '聊天请求JSON无效'); }
    if (!object(value)) fail('MOBILE_BAD_REQUEST', '聊天请求必须是对象'); return value;
  }
  async function authenticate(request) {
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) fail('MOBILE_UNAUTHORIZED', '请从电脑端重新配对此设备');
    const hash = digest(authorization.slice(7)), device = registry.devices.find(item => safeEqual(item.tokenHash, hash));
    if (!device || device.expiresAt <= clock()) fail('MOBILE_UNAUTHORIZED', '此设备连接已过期或被撤销');
    const active = await current();
    if (active !== boundCoordinator || device.channel.memoryRoot !== active.memoryRoot) fail('MOBILE_INSTANCE_MISMATCH', '当前加载的不是此设备绑定的人格实例');
    return device;
  }
  async function assertCurrentDevice(device) {
    const active = await current(), saved = registry.devices.find(item => item.id === device.id);
    if (!saved || saved.expiresAt <= clock() || !safeEqual(saved.tokenHash, device.tokenHash)) fail('MOBILE_UNAUTHORIZED', '此设备连接已过期或被撤销');
    if (!server || active !== boundCoordinator || saved.channel.memoryRoot !== active.memoryRoot) fail('MOBILE_INSTANCE_MISMATCH', '聊天连接已停用或人格实例已切换');
    return saved;
  }
  const withDevice = (device, work) => queue(async () => { const saved = await assertCurrentDevice(device); const result = await work(saved); await assertCurrentDevice(saved); return result; });
  async function state(device) {
    const value = await channelPort.status(device.channel), voice = getVoice?.() ?? boundCoordinator?.voice;
    if (voice?.inspect) value.voice = await voice.inspect(device.channel.sessionId);
    return value;
  }
  async function paired(args) {
    return queue(async () => {
      if (!pairing || pairing.expiresAt <= clock() || typeof args.token !== 'string' || !safeEqual(pairing.tokenHash, digest(args.token))) fail('MOBILE_PAIR_EXPIRED', '配对链接已使用或过期，请在电脑端生成新链接');
      const active = await current(); if (!server || active !== boundCoordinator || pairing.memoryRoot !== active.memoryRoot) fail('MOBILE_INSTANCE_MISMATCH', '人格实例已切换或连接已停用');
      const admitted = registry.devices.filter(device => device.expiresAt > clock());
      if (admitted.length >= MAX_DEVICES) fail('MOBILE_DEVICE_CAPACITY', '已达到8台设备上限，请在电脑端撤销不再使用的设备');
      const invitation = pairing; pairing = null;
      const id = randomUUID(), raw = token(), at = clock(), label = bounded(args.label ?? invitation.label, 80).trim() || invitation.label;
      const channel = await channelPort.create();
      const device = { id, label, tokenHash: digest(raw), createdAt: at, expiresAt: at + DEVICE_TTL, lastSeenAt: at, channel };
      try { await save({ ...registry, devices: [...admitted, device], requests: registry.requests.filter(receipt => admitted.some(existing => existing.id === receipt.deviceId)) }); }
      catch (error) { await channelPort.closeChannel?.(channel).catch(() => {}); throw error; }
      return { deviceToken: raw, device: { id, label, expiresAt: device.expiresAt }, state: await state(device) };
    });
  }
  async function send(device, args) {
    return queue(async () => {
      device = await assertCurrentDevice(device);
      const requestId = args.requestId;
      if (!safeId(requestId)) fail('MOBILE_BAD_REQUEST', '发送标识无效');
      const text = bounded(args.text, 16000); if (!text.trim()) fail('MOBILE_BAD_REQUEST', '请输入聊天内容');
      const hash = digest(text), previous = registry.requests.find(receipt => receipt.deviceId === device.id && receipt.requestId === requestId);
      if (previous) { if (previous.textHash !== hash) fail('MOBILE_REQUEST_CONFLICT', '同一个发送标识不能用于不同原文'); return { requestId, messageId: previous.messageId, status: previous.status === 'prepared' ? 'unknown' : previous.status, duplicate: true }; }
      const now = clock();
      if (!Number.isSafeInteger(args.createdAt) || args.createdAt < now - REQUEST_TTL || args.createdAt > now + 30000) fail('MOBILE_REQUEST_EXPIRED', '发送重试窗口已过期，请先核对聊天记录，不能自动重发');
      const retained = registry.requests.filter(receipt => receipt.status === 'unknown' || receipt.status === 'prepared' || receipt.at >= now - REQUEST_TTL);
      if (retained.length >= MAX_REQUESTS) fail('MOBILE_RECEIPT_CAPACITY', '发送收据工作区已满，请稍后查询结果或在电脑端处理未知收据');
      const receipt = { deviceId: device.id, requestId, textHash: hash, messageId: 'mobile-' + device.id + '-' + requestId, status: 'prepared', at: now };
      await save({ ...registry, requests: [...retained, receipt] });
      let result;
      try { result = await channelPort.send(device.channel, { messageId: receipt.messageId, text, deviceId: device.id }); }
      catch (error) {
        const next = { ...receipt, status: 'unknown' }; await save({ ...registry, requests: registry.requests.map(item => item === receipt ? next : item) });
        onError(error); return { requestId, messageId: receipt.messageId, status: 'unknown', code: 'MOBILE_DELIVERY_UNKNOWN' };
      }
      const accepted = { ...receipt, status: 'accepted' };
      try { await save({ ...registry, devices: registry.devices.map(item => item.id === device.id ? { ...item, lastSeenAt: now } : item), requests: registry.requests.map(item => item === receipt ? accepted : item) }); }
      catch (error) { onError(error); return { requestId, messageId: receipt.messageId, status: 'unknown', code: 'MOBILE_RECEIPT_UNKNOWN' }; }
      return { requestId, messageId: receipt.messageId, status: 'accepted', duplicate: Boolean(result?.duplicate) };
    });
  }
  async function handle(request, response) {
    try {
      await ready;
      if (!server) fail('MOBILE_NOT_STARTED', '聊天连接已停用');
      if (!registry.configuration.publicBaseUrl && !localPeer(request.socket?.remoteAddress)) fail('MOBILE_ORIGIN_REJECTED', '此连接仅接受本机或私网设备');
      const known = origins(), host = request.headers.host;
      if (typeof host !== 'string' || !known.some(origin => new URL(origin).host === host)) fail('MOBILE_HOST_REJECTED', '聊天连接地址不匹配');
      const origin = request.headers.origin;
      if (origin !== undefined && !known.includes(origin)) fail('MOBILE_ORIGIN_REJECTED', '聊天请求来源不匹配');
      if (request.headers['sec-fetch-site'] === 'cross-site') fail('MOBILE_ORIGIN_REJECTED', '不接受跨站聊天请求');
      const url = new URL(request.url, known[0]), route = url.pathname;
      if (request.method === 'GET' && ['/', '/index.html', '/app.js', '/style.css', '/speech.js'].includes(route)) {
        if (url.search) fail('MOBILE_BAD_REQUEST', '聊天页面不接收URL查询凭据');
        const file = route === '/' ? 'index.html' : route.slice(1), types = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'speech.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8' };
        const bytes = await fs.readFile(path.join(assetsDir, file));
        return respond(response, 200, bytes, { 'content-type': types[file], 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
      }
      if (route === '/api/pair' && request.method === 'POST' && !url.search) return respond(response, 200, await paired(await body(request)));
      if (route === '/api/send' && request.method === 'POST' && !url.search) { const device = await authenticate(request); return respond(response, 200, await send(device, await body(request))); }
      const device = await authenticate(request);
      if (route === '/api/state' && request.method === 'GET' && !url.search) return respond(response, 200, await withDevice(device, saved => state(saved)));
      if (route === '/api/messages' && request.method === 'GET') {
        for (const key of url.searchParams.keys()) if (!['after', 'before', 'limit', 'cursor'].includes(key)) fail('MOBILE_BAD_REQUEST', '未知聊天读取参数');
        if (url.searchParams.has('before') && (url.searchParams.has('after') || url.searchParams.has('cursor'))) fail('MOBILE_BAD_REQUEST', '旧页与新消息读取参数不能混用');
        if (url.searchParams.has('cursor') && url.searchParams.has('after')) fail('MOBILE_BAD_REQUEST', '片段游标与新消息读取位置不能混用');
        let after = url.searchParams.has('after') ? Number(url.searchParams.get('after')) : undefined, before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined, offset = 0, messageIndex = 0, until, windowStart;
        const cursor = url.searchParams.get('cursor');
        if (cursor) { let decoded; try { if (cursor.length > 512) throw new Error(); decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { fail('MOBILE_CURSOR_INVALID', '聊天片段游标无效'); } if (decoded.device !== device.id || !Number.isSafeInteger(decoded.after) || !Number.isSafeInteger(decoded.offset) || !Number.isSafeInteger(decoded.index ?? 0) || decoded.until !== undefined && !Number.isSafeInteger(decoded.until) || decoded.windowStart !== undefined && !Number.isSafeInteger(decoded.windowStart)) fail('MOBILE_CURSOR_INVALID', '聊天片段游标不属于此设备'); after = decoded.after; offset = decoded.offset; messageIndex = decoded.index ?? 0; until = decoded.until; windowStart = decoded.windowStart; }
        const limit = Number(url.searchParams.get('limit') ?? 30);
        if (after !== undefined && (!Number.isSafeInteger(after) || after < 0) || before !== undefined && (!Number.isSafeInteger(before) || before < 0) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('MOBILE_BAD_REQUEST', '聊天分页参数无效');
        return respond(response, 200, await withDevice(device, async saved => {
          const result = await channelPort.read(saved.channel, { after, before, until, windowStart, offset, messageIndex, limit });
          const { nextOffset, nextIndex, ...page } = result;
          return { ...page, nextCursor: nextOffset || nextIndex || result.history && result.hasMore ? Buffer.from(JSON.stringify({ device: saved.id, after: result.nextAfter, offset: nextOffset, index: nextIndex ?? 0, windowStart: result.windowStart, ...(result.history ? { until: result.windowEnd } : {}) })).toString('base64url') : null, state: await state(saved) };
        }));
      }
      if (route === '/api/receipt' && request.method === 'GET') {
        if ([...url.searchParams.keys()].some(key => key !== 'requestId') || !safeId(url.searchParams.get('requestId'))) fail('MOBILE_BAD_REQUEST', '发送查询标识无效');
        return respond(response, 200, await withDevice(device, saved => { const requestId = url.searchParams.get('requestId'), receipt = registry.requests.find(item => item.deviceId === saved.id && item.requestId === requestId); return receipt ? { requestId, messageId: receipt.messageId, status: receipt.status === 'prepared' ? 'unknown' : receipt.status, at: receipt.at } : { requestId, status: 'not_found' }; }));
      }
      if (route === '/api/wake' && request.method === 'POST' && !url.search) {
        const args = await body(request); if (Object.keys(args).length) fail('MOBILE_BAD_REQUEST', '唤醒接口不接受额外指令');
        return respond(response, 200, await withDevice(device, async saved => { if (typeof boundCoordinator.executeCommand !== 'function') fail('MOBILE_WAKE_UNAVAILABLE', '当前人格实例不能接收明确唤醒'); await boundCoordinator.executeCommand('wake', {}); return { signaled: true, state: await state(saved) }; }));
      }
      if (route === '/api/disconnect' && request.method === 'POST' && !url.search) { await body(request); await revoke({ deviceId: device.id }); return respond(response, 200, { disconnected: true }); }
      const voice = getVoice?.() ?? boundCoordinator?.voice;
      if (route === '/api/voice' && request.method === 'GET' && !url.search) { if (!voice?.inspect) fail('MOBILE_VOICE_UNAVAILABLE', '语音功能暂不可用'); return respond(response, 200, await withDevice(device, saved => voice.inspect(saved.channel.sessionId))); }
      if (route === '/api/voice/catalog' && request.method === 'POST' && !url.search) { if (!voice?.registerCatalog) fail('MOBILE_VOICE_UNAVAILABLE', '语音功能暂不可用'); const args = await body(request); return respond(response, 200, await withDevice(device, saved => voice.registerCatalog(saved.channel.sessionId, args))); }
      if (route === '/api/voice/config' && request.method === 'POST' && !url.search) { if (!voice?.configure) fail('MOBILE_VOICE_UNAVAILABLE', '语音功能暂不可用'); const args = await body(request); return respond(response, 200, await withDevice(device, saved => voice.configure(args, { sessionKey: saved.channel.sessionId }))); }
      respond(response, 404, { ok: false, error: { code: 'MOBILE_NOT_FOUND', message: '此聊天接口不存在' } });
    } catch (error) {
      const code = typeof error.code === 'string' ? error.code : 'MOBILE_REQUEST_FAILED';
      const httpStatus = code === 'MOBILE_UNAUTHORIZED' ? 401 : /(?:HOST|ORIGIN)_REJECTED|INSTANCE_MISMATCH/.test(code) ? 403 : code === 'MOBILE_NOT_STARTED' || code === 'MOBILE_INSTANCE_UNLOADED' ? 503 : /CAPACITY/.test(code) ? 413 : /EXPIRED|CONFLICT|UNAVAILABLE|GAP/.test(code) ? 409 : 400;
      respond(response, httpStatus, { ok: false, error: { code, message: String(error.message ?? '聊天请求未完成').slice(0, 240) } });
    }
  }
  async function restoreStartup() { return resume(); }
  async function close() { if (closed) return; closed = true; await stop(); await channelPort.close?.(); }
  return { ready, status, configure, start, stop, suspend, resume, pair, revoke, invalidateForRoot, restoreStartup, close, handle };
}
