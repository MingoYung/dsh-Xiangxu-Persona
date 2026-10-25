import { randomBytes, createDecipheriv } from 'node:crypto';
import { CONNECTION_LIMITS, capabilities, digest, endpoint, fail, identifier, mediaBytes, normalizedEvent, requestJson, targetRoute } from './common.js';

export const QQ_SOURCES = Object.freeze({ binding: 'https://www.npmjs.com/package/@tencent-connect/qqbot-connector/v/1.2.0', transport: 'https://github.com/tencent-connect/qqbot-nodejs/tree/main/src/protocol', checkedOn: '2026-10-26' });
export const QQ_CAPABILITIES = Object.freeze(capabilities(['chat.text', 'chat.image', 'chat.video', 'chat.file', 'message.retract'], { 'chat.voice': '当前本地语音是 PCM WAV，尚无经过验证的 QQ 官方语音编码转换链' }));
const DEFAULTS = { binding: 'https://q.qq.com', api: 'https://api.bot.qq.com' };
export async function beginQqLogin({ fetchImpl = fetch, endpoints = {}, signal } = {}) {
  const key = randomBytes(32).toString('base64'), base = endpoint(endpoints.binding ?? DEFAULTS.binding, { domains: ['q.qq.com'], local: Boolean(endpoints.binding) });
  const value = await requestJson(fetchImpl, new URL('/lite/create_bind_task', base), { body: { key }, signal });
  if (value.retcode !== 0) fail('QQ_BIND_REJECTED'); const taskId = identifier(value.data?.task_id, '绑定任务');
  return { key, taskId, pollBase: base.href, qrContent: 'https://q.qq.com/qqbot/openclaw/connect.html?task_id=' + encodeURIComponent(taskId) + '&source=xiangxu-persona&_wv=2' };
}
export async function pollQqLogin(flow, { fetchImpl = fetch, signal } = {}) {
  const value = await requestJson(fetchImpl, new URL('/lite/poll_bind_result', flow.pollBase), { body: { task_id: flow.taskId }, signal });
  if (value.retcode !== 0) fail('QQ_BIND_REJECTED'); const data = value.data;
  if (data?.status === 3) return { phase: 'expired' };
  if (data?.status !== 2) return { phase: 'waiting' };
  const encrypted = Buffer.from(identifier(data.bot_encrypt_secret, '绑定密文', 16384), 'base64');
  if (encrypted.length < 29) fail('QQ_BIND_INVALID');
  let secret; try { const decipher = createDecipheriv('aes-256-gcm', Buffer.from(flow.key, 'base64'), encrypted.subarray(0, 12)); decipher.setAuthTag(encrypted.subarray(-16)); secret = Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]).toString('utf8'); } catch { fail('QQ_BIND_DECRYPT_FAILED'); }
  return { phase: 'authorized', credentials: { accountId: identifier(String(data.bot_appid ?? ''), '机器人账号'), appSecret: identifier(secret, '机器人凭据', 4096), pairedUserId: typeof data.user_openid === 'string' ? identifier(data.user_openid) : null, transport: { contexts: {}, lastSeq: null, sessionId: null } } };
}
export function decodeQqEvent(accountId, type, data) {
  if (!['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(type) || data?.author?.bot === true) return null;
  const group = type !== 'C2C_MESSAGE_CREATE', sender = identifier(group ? data.author?.member_openid : data.author?.user_openid), room = group ? identifier(data.group_openid) : sender;
  const text = typeof data.content === 'string' ? data.content : ''; if (Array.from(text).length > CONNECTION_LIMITS.textChars) fail('CONNECTION_EVENT_CAPACITY');
  const createdAt = Date.parse(data.timestamp); const unsupportedSegments = Array.isArray(data.attachments) ? data.attachments.slice(0, 256).map(item => String(item.content_type ?? 'media').slice(0, 64)) : [];
  return normalizedEvent({ platform: 'qq', accountId, sender: { id: sender, ...(typeof data.author?.username === 'string' ? { name: data.author.username.slice(0, 120) } : {}) }, conversation: { id: room, type: group ? 'group' : 'private' }, message: { id: identifier(data.id), text, createdAt }, textComplete: unsupportedSegments.length === 0, unsupportedSegments });
}
export function createQqClient(credentials, { fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, endpoints = {}, clock = Date.now, onCheckpoint = async () => {}, onError = () => {} } = {}) {
  const accountId = identifier(credentials.accountId), api = endpoint(endpoints.api ?? DEFAULTS.api, { domains: ['qq.com'], local: Boolean(endpoints.api) });
  let access = null, accessUntil = 0, tokenPromise = null, socket = null, heartbeat = null, awaitingHeartbeat = false, reconnect = null, lifetime = null, connected = false, stopped = true, inputTail = Promise.resolve(), queued = 0, rejectWaiting = null;
  const state = structuredClone(credentials.transport ?? { contexts: {}, lastSeq: null, sessionId: null }); state.contexts = Object.assign(Object.create(null), state.contexts ?? {});
  state.lastSeq ??= null; state.sessionId ??= null;
  const supported = QQ_CAPABILITIES;
  async function token(signal) {
    if (access && clock() < accessUntil) return access;
    if (tokenPromise) return tokenPromise;
    tokenPromise = (async () => { const result = await requestJson(fetchImpl, new URL('/app/getAppAccessToken', api), { body: { appId: accountId, clientSecret: credentials.appSecret }, signal }); access = identifier(result.access_token, '平台访问凭据', 8192); const seconds = Number(result.expires_in); if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86400) fail('QQ_TOKEN_EXPIRY'); accessUntil = clock() + Math.max(0, seconds - 30) * 1000; return access; })();
    try { return await tokenPromise; } finally { tokenPromise = null; }
  }
  async function action(method, path, body, signal) {
    const result = await requestJson(fetchImpl, new URL(path, api), { method, body, headers: { Authorization: 'QQBot ' + await token(signal), 'User-Agent': 'dsh-Xiangxu-Persona/0.5.0' }, signal });
    if (Number.isFinite(result.code) && result.code !== 0) fail('QQ_ACTION_REJECTED'); return result;
  }
  async function probe() { try { await action('GET', '/users/@me'); return { connected: true, accountId, platform: 'qq', status: 'connected', capabilities: { text: true, voice: false, group: true }, supportedCapabilities: supported, chatTypes: ['private', 'group'], platformPermissions: '平台账号需开通相应权限，拒绝以实际API回执为准' }; } catch (error) { return { connected: false, accountId, platform: 'qq', status: 'disconnected', code: error.code ?? 'QQ_PROBE_FAILED', supportedCapabilities: supported, chatTypes: ['private', 'group'] }; } }
  function route(target) { return targetRoute(target, 'qq', accountId); }
  function messagePath(selected) { return '/v2/' + (selected.type === 'group' ? 'groups/' : 'users/') + encodeURIComponent(selected.id) + '/messages'; }
  function passive(selected, deliveryId) {
    const context = state.contexts[selected.type + ':' + selected.id], ttl = selected.type === 'group' ? 300000 : 1800000;
    // These are upstream passive-reply token windows; they do not decide when
    // the personality may initiate. Outside the window the API is called in active mode.
    return { ...(context && clock() - context.at < ttl ? { msg_id: context.messageId } : {}), msg_seq: parseInt(digest(deliveryId).slice(0, 4), 16) };
  }
  function ack(result, deliveryId) { return typeof result?.id === 'string' && result.id ? { status: 'delivered', deliveryId, messageId: result.id, receiptId: 'qqbot:' + result.id, messageIdKind: 'server_id', deliveredAt: Number.isFinite(Date.parse(result.timestamp)) ? Date.parse(result.timestamp) : clock(), confirmedBy: 'qqbot-message-id' } : { status: 'unknown', deliveryId, code: 'QQ_MESSAGE_ID_MISSING' }; }
  async function sendText(target, text, { deliveryId } = {}) {
    identifier(deliveryId, '交付编号', 160); if (typeof text !== 'string' || !text || Array.from(text).length > CONNECTION_LIMITS.textChars) fail('CONNECTION_TEXT_CAPACITY');
    try { const selected = route(target); return ack(await action('POST', messagePath(selected), { content: text, msg_type: 0, ...passive(selected, deliveryId) }), deliveryId); } catch (error) { return { status: ['QQ_ACTION_REJECTED', 'CONNECTION_AUTH_REJECTED'].includes(error.code) ? 'failed' : 'unknown', deliveryId, code: error.code ?? 'QQ_DELIVERY_UNKNOWN' }; }
  }
  async function execute(target, capability, payload, { deliveryId } = {}) {
    identifier(deliveryId, '交付编号', 160); const selected = route(target); if (!supported[capability]?.supported) return { status: 'unsupported', code: capability === 'chat.voice' ? 'QQ_VOICE_CODEC_UNAVAILABLE' : 'CONNECTION_CAPABILITY_UNSUPPORTED' };
    if (capability === 'chat.text') return sendText(target, payload.text, { deliveryId });
    try {
      if (capability === 'message.retract') { const messageId = identifier(payload.messageId); await action('DELETE', messagePath(selected) + '/' + encodeURIComponent(messageId)); return { status: 'completed', receiptId: 'qqbot-retract:' + deliveryId, confirmedBy: 'qqbot-api-success', affectedMessageId: messageId }; }
      const fileType = { 'chat.image': 1, 'chat.video': 2, 'chat.file': 4 }[capability], bytes = mediaBytes(payload);
      const upload = await action('POST', messagePath(selected).replace(/\/messages$/, '/files'), { file_type: fileType, file_data: bytes.toString('base64'), srv_send_msg: false, ...(capability === 'chat.file' ? { file_name: String(payload.filename ?? 'asset').replace(/[\u0000-\u001f\\/]/g, '_').slice(0, 128) } : {}) });
      identifier(upload.file_info, '媒体上传回执', 65536);
      return ack(await action('POST', messagePath(selected), { msg_type: 7, content: '', media: { file_info: upload.file_info }, ...passive(selected, deliveryId) }), deliveryId);
    } catch (error) { return { status: ['QQ_ACTION_REJECTED', 'CONNECTION_AUTH_REJECTED'].includes(error.code) ? 'failed' : 'unknown', deliveryId, code: error.code ?? 'QQ_MEDIA_UNKNOWN' }; }
  }
  const sendVoice = (target, bytes, options) => execute(target, 'chat.voice', { bytes }, options);
  async function closeSocket() { clearInterval(heartbeat); heartbeat = null; clearTimeout(reconnect); reconnect = null; const previous = socket; socket = null; connected = false; if (previous) try { previous.close(1000, 'owner-stop'); } catch {} }
  async function stop() { stopped = true; lifetime?.abort(); if (rejectWaiting) { rejectWaiting(Object.assign(new Error('连接已停止'), { code: 'QQ_GATEWAY_STOPPED' })); rejectWaiting = null; } await closeSocket(); }
  async function close() { await stop(); await inputTail.catch(() => {}); }
  async function listen(onEvent) {
    if (!stopped) return; if (typeof WebSocketImpl !== 'function') fail('QQ_WEBSOCKET_UNAVAILABLE'); stopped = false; lifetime = new AbortController(); const ownLifetime = lifetime;
    let resolveInitial, rejectInitial, initialSettled = false;
    const initial = new Promise((resolve, reject) => { resolveInitial = resolve; rejectInitial = reject; });
    rejectWaiting = rejectInitial;
    const initialTimeout = setTimeout(() => { if (!initialSettled) { initialSettled = true; rejectInitial(Object.assign(new Error('QQ网关未确认'), { code: 'QQ_GATEWAY_TIMEOUT' })); if (lifetime === ownLifetime) void stop(); } }, 20000); initialTimeout.unref?.();
    async function connect() {
      if (stopped || lifetime !== ownLifetime || ownLifetime.signal.aborted) return;
      try {
        const gateway = await action('GET', '/gateway', undefined, ownLifetime.signal), accessToken = await token(ownLifetime.signal);
        if (stopped || lifetime !== ownLifetime || ownLifetime.signal.aborted) return;
        const url = endpoint(gateway.url, { domains: ['qq.com'], local: Boolean(endpoints.api), websocket: true }); socket = new WebSocketImpl(url.href); const current = socket;
        const handshake = setTimeout(() => { if (!connected && socket === current) { current.close(); if (!initialSettled) { initialSettled = true; rejectInitial(Object.assign(new Error('QQ网关未确认'), { code: 'QQ_GATEWAY_TIMEOUT' })); } } }, 20000); handshake.unref?.();
        current.addEventListener('message', event => {
          if (stopped || lifetime !== ownLifetime || socket !== current) return;
          if (queued >= CONNECTION_LIMITS.queue) { onError(Object.assign(new Error('QQ入站队列已满'), { code: 'CONNECTION_QUEUE_CAPACITY' })); void stop(); return; }
          queued++; inputTail = inputTail.then(async () => {
            if (stopped || lifetime !== ownLifetime || socket !== current) return;
            let text = typeof event.data === 'string' ? event.data : typeof event.data?.text === 'function' ? await event.data.text() : Buffer.from(event.data).toString('utf8');
            if (Buffer.byteLength(text) > CONNECTION_LIMITS.responseBytes) fail('CONNECTION_RESPONSE_CAPACITY'); const packet = JSON.parse(text);
            if (packet.op === 10) { current.send(JSON.stringify({ op: state.sessionId && state.lastSeq !== null ? 6 : 2, d: { token: 'QQBot ' + accessToken, ...(state.sessionId && state.lastSeq !== null ? { session_id: state.sessionId, seq: state.lastSeq } : { intents: 1 << 25, shard: [0, 1] }) } })); const interval = packet.d?.heartbeat_interval; if (!Number.isInteger(interval) || interval < 1000 || interval > 120000) fail('QQ_GATEWAY_HEARTBEAT'); clearInterval(heartbeat); awaitingHeartbeat = false; heartbeat = setInterval(() => { if (!stopped && socket === current && current.readyState === 1) { if (awaitingHeartbeat) { current.close(); return; } awaitingHeartbeat = true; current.send(JSON.stringify({ op: 1, d: state.lastSeq })); } }, interval); heartbeat.unref?.(); return; }
            if (packet.op === 11) { awaitingHeartbeat = false; return; }
            if (packet.op === 1) { current.send(JSON.stringify({ op: 1, d: state.lastSeq })); return; }
            if (packet.op === 7 || packet.op === 9) { if (packet.op === 9) { state.sessionId = null; state.lastSeq = null; } current.close(); return; }
            if (packet.op !== 0) return;
            if (packet.t === 'READY' || packet.t === 'RESUMED') { if (packet.t === 'READY') state.sessionId = identifier(packet.d?.session_id); connected = true; clearTimeout(handshake); if (!initialSettled) { initialSettled = true; rejectWaiting = null; resolveInitial(); } }
            else {
              const normalized = decodeQqEvent(accountId, packet.t, packet.d);
              if (normalized) { state.contexts[normalized.conversation.type + ':' + normalized.conversation.id] = { messageId: normalized.message.id, at: normalized.message.createdAt }; while (Object.keys(state.contexts).length > CONNECTION_LIMITS.contexts) delete state.contexts[Object.keys(state.contexts)[0]]; const result = await onEvent(normalized); if (result?.status === 'unknown') fail('CONNECTION_INBOUND_UNKNOWN'); }
            }
            if (stopped || lifetime !== ownLifetime || socket !== current) return;
            if (Number.isSafeInteger(packet.s)) state.lastSeq = packet.s; await onCheckpoint(structuredClone(state));
          }).catch(error => { if (stopped || lifetime !== ownLifetime) return; onError(error); if (!initialSettled) { initialSettled = true; rejectInitial(error); } stopped = true; ownLifetime.abort(); void closeSocket(); }).finally(() => { queued--; });
        });
        current.addEventListener('close', event => { clearTimeout(handshake); if (socket !== current) return; connected = false; clearInterval(heartbeat); heartbeat = null; if ([4004, 4013, 4014, 4914, 4915].includes(event.code)) { stopped = true; const error = Object.assign(new Error('QQ平台拒绝此账号或订阅权限'), { code: 'QQ_GATEWAY_AUTHORITY_REJECTED' }); onError(error); if (!initialSettled) { initialSettled = true; rejectInitial(error); } return; } if (!stopped) { reconnect = setTimeout(() => { void connect(); }, 3000); reconnect.unref?.(); } });
        current.addEventListener('error', () => { onError(Object.assign(new Error('QQ网关连接异常'), { code: 'QQ_GATEWAY_ERROR' })); });
      } catch (error) { if (lifetime !== ownLifetime || ownLifetime.signal.aborted) return; if (!initialSettled) { initialSettled = true; rejectInitial(error); } onError(error); await stop(); }
    }
    void connect(); try { await initial; } catch (error) { if (lifetime === ownLifetime) await stop(); throw error; } finally { clearTimeout(initialTimeout); if (lifetime === ownLifetime) rejectWaiting = null; }
  }
  return { probe, sendText, sendVoice, execute, listen, stop, close, inspectCapabilities: async () => supported, get capabilities() { return { text: true, voice: false, group: true }; }, get listening() { return !stopped && connected; } };
}
