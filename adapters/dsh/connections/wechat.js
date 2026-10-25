import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { CONNECTION_LIMITS, capabilities, endpoint, fail, identifier, mediaBytes, normalizedEvent, requestJson, targetRoute } from './common.js';

export const WECHAT_SOURCES = Object.freeze({ login: 'https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts', protocol: 'https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md', checkedOn: '2026-10-26' });
const DEFAULTS = { api: 'https://ilinkai.weixin.qq.com', cdn: 'https://novac2c.cdn.weixin.qq.com/c2c' };
const appHeaders = () => ({ 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(0x000500) });
const headers = token => ({ ...appHeaders(), AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'), ...(token ? { Authorization: 'Bearer ' + token } : {}) });
const baseInfo = () => ({ channel_version: '0.5.0', bot_agent: 'XiangxuPersona/0.5.0' });
export async function beginWechatLogin({ fetchImpl = fetch, endpoints = {}, signal } = {}) {
  const base = endpoint(endpoints.api ?? DEFAULTS.api, { domains: ['weixin.qq.com'], local: Boolean(endpoints.api) });
  const value = await requestJson(fetchImpl, new URL('/ilink/bot/get_bot_qrcode?bot_type=3', base), { body: { local_token_list: [] }, headers: headers(), signal });
  return { qrcode: identifier(value.qrcode, '微信绑定任务', 8192), qrContent: identifier(value.qrcode_img_content, '二维码内容', 8192), pollBase: base.href };
}
export async function pollWechatLogin(flow, { fetchImpl = fetch, endpoints = {}, signal, verifyCode } = {}) {
  const url = new URL('/ilink/bot/get_qrcode_status', flow.pollBase); url.searchParams.set('qrcode', flow.qrcode); if (verifyCode) { if (!/^[A-Za-z0-9 -]{1,32}$/.test(verifyCode)) fail('WECHAT_VERIFY_CODE'); url.searchParams.set('verify_code', verifyCode); }
  const value = await requestJson(fetchImpl, url, { method: 'GET', headers: appHeaders(), signal, timeoutMs: 35000 });
  if (value.status === 'scaned_but_redirect') { const raw = String(value.redirect_host ?? ''), base = endpoint(raw.includes('://') ? raw : 'https://' + raw, { domains: ['weixin.qq.com'], local: Boolean(endpoints.api) }); return { phase: 'scanned', pollBase: base.href }; }
  if (value.status === 'expired') return { phase: 'expired' };
  if (value.status === 'verify_code_blocked') return { phase: 'failed', code: 'WECHAT_VERIFY_BLOCKED' };
  if (value.status === 'need_verifycode') return { phase: 'verify' };
  if (value.status === 'binded_redirect') return { phase: 'failed', code: 'WECHAT_ALREADY_BOUND' };
  if (value.status !== 'confirmed') return { phase: value.status === 'scaned' ? 'scanned' : 'waiting' };
  const base = endpoint(value.baseurl ?? flow.pollBase, { domains: ['weixin.qq.com'], local: Boolean(endpoints.api) });
  return { phase: 'authorized', credentials: { accountId: identifier(value.ilink_bot_id), token: identifier(value.bot_token, '微信连接凭据', 8192), apiBase: base.href, pairedUserId: identifier(value.ilink_user_id), transport: { cursor: '', contexts: {} } } };
}
export function decodeWechatEvent(accountId, data) {
  if (data?.message_type !== 1 || data.group_id) return null;
  const sender = identifier(data.from_user_id), parts = Array.isArray(data.item_list) ? data.item_list : [];
  if (parts.length > 256) fail('CONNECTION_EVENT_CAPACITY');
  const text = parts.filter(item => item?.type === 1 && typeof item.text_item?.text === 'string').map(item => item.text_item.text).join('');
  const unsupportedSegments = parts.filter(item => item?.type !== 1).map(item => ({ 2: 'image', 3: 'voice', 4: 'file', 5: 'video' })[item.type] ?? 'unknown');
  const rawId = data.message_id ?? data.client_id; const id = typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : rawId;
  return normalizedEvent({ platform: 'wechat', accountId, sender: { id: sender }, conversation: { id: sender, type: 'private' }, message: { id: identifier(id), text, createdAt: data.create_time_ms }, textComplete: unsupportedSegments.length === 0, unsupportedSegments });
}
export function createWechatClient(credentials, { fetchImpl = fetch, endpoints = {}, clock = Date.now, onCheckpoint = async () => {}, onError = () => {} } = {}) {
  const accountId = identifier(credentials.accountId), base = endpoint(credentials.apiBase ?? endpoints.api ?? DEFAULTS.api, { domains: ['weixin.qq.com'], local: Boolean(endpoints.api) });
  const state = structuredClone(credentials.transport ?? { cursor: '', contexts: {} }); state.contexts = Object.assign(Object.create(null), state.contexts ?? {}); let stopped = true, lifetime = null, running = null;
  const supported = capabilities(['chat.text', 'chat.image', 'chat.video', 'chat.file'], { 'chat.voice': '当前微信发送器尚未实现可验证的语音编码流程' });
  async function action(path, body, { signal, timeoutMs } = {}) { const result = await requestJson(fetchImpl, new URL('/ilink/bot/' + path, base), { body: { ...body, base_info: baseInfo() }, headers: headers(credentials.token), signal, timeoutMs }); if (path !== 'getuploadurl' && result.ret === undefined) fail('WECHAT_ACK_UNCONFIRMED'); if (result.ret !== undefined && result.ret !== 0 || result.errcode !== undefined && result.errcode !== 0) fail(result.ret === -14 || result.errcode === -14 ? 'WECHAT_SESSION_EXPIRED' : 'WECHAT_ACTION_REJECTED'); return result; }
  async function probe() { try { await action('getconfig', { ilink_user_id: credentials.pairedUserId }); return { connected: true, accountId, platform: 'wechat', status: 'connected', capabilities: { text: true, voice: false, group: false }, supportedCapabilities: supported, chatTypes: ['private'] }; } catch (error) { return { connected: false, accountId, platform: 'wechat', status: 'disconnected', code: error.code ?? 'WECHAT_PROBE_FAILED', supportedCapabilities: supported, chatTypes: ['private'] }; } }
  async function sendItems(target, items, deliveryId) {
    const route = targetRoute(target, 'wechat', accountId); if (route.type !== 'private') return { status: 'unsupported', code: 'WECHAT_PRIVATE_ONLY' };
    if (!state.contexts[route.id]?.token) return { status: 'failed', code: 'WECHAT_CONTEXT_UNAVAILABLE', deliveryId };
    identifier(deliveryId, '交付编号', 160); const context = state.contexts[route.id];
    if (!context?.token) return { status: 'failed', code: 'WECHAT_CONTEXT_UNAVAILABLE', deliveryId };
    try {
      await action('sendmessage', { msg: { from_user_id: '', to_user_id: route.id, client_id: deliveryId, message_type: 2, message_state: 2, context_token: context.token, item_list: items } });
      // The upstream successful response contains ret:0, not a server message ID.
      // Retain the exact submitted client_id and label that provenance explicitly.
      return { status: 'delivered', deliveryId, messageId: deliveryId, messageIdKind: 'client_id', receiptId: 'ilink-client:' + deliveryId, deliveredAt: clock(), confirmedBy: 'ilink-ret0' };
    } catch (error) { return { status: ['WECHAT_ACTION_REJECTED', 'WECHAT_SESSION_EXPIRED', 'CONNECTION_AUTH_REJECTED'].includes(error.code) ? 'failed' : 'unknown', deliveryId, code: error.code ?? 'WECHAT_DELIVERY_UNKNOWN' }; }
  }
  async function sendText(target, text, { deliveryId } = {}) { if (typeof text !== 'string' || !text || Array.from(text).length > CONNECTION_LIMITS.textChars) fail('CONNECTION_TEXT_CAPACITY'); return sendItems(target, [{ type: 1, text_item: { text } }], deliveryId); }
  async function execute(target, capability, payload, { deliveryId } = {}) {
    if (!supported[capability]?.supported) return { status: 'unsupported', code: 'CONNECTION_CAPABILITY_UNSUPPORTED' };
    if (capability === 'chat.text') return sendText(target, payload.text, { deliveryId });
    const route = targetRoute(target, 'wechat', accountId); if (route.type !== 'private') return { status: 'unsupported', code: 'WECHAT_PRIVATE_ONLY' };
    identifier(deliveryId, '交付编号', 160); if (!state.contexts[route.id]?.token) return { status: 'failed', code: 'WECHAT_CONTEXT_UNAVAILABLE', deliveryId };
    const bytes = mediaBytes(payload), key = randomBytes(16), filekey = randomBytes(16).toString('hex'), md5 = createHash('md5').update(bytes).digest('hex');
    const cipher = createCipheriv('aes-128-ecb', key, null), encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    try {
      const upload = await action('getuploadurl', { filekey, media_type: { 'chat.image': 1, 'chat.video': 2, 'chat.file': 3 }[capability], to_user_id: route.id, rawsize: bytes.length, rawfilemd5: md5, filesize: encrypted.length, no_need_thumb: true, aeskey: key.toString('hex') });
      let uploadUrl;
      if (upload.upload_full_url) uploadUrl = endpoint(upload.upload_full_url, { domains: ['weixin.qq.com'], local: Boolean(endpoints.cdn) });
      else { uploadUrl = endpoint((endpoints.cdn ?? DEFAULTS.cdn).replace(/\/$/, '') + '/upload', { domains: ['weixin.qq.com'], local: Boolean(endpoints.cdn) }); uploadUrl.searchParams.set('encrypted_query_param', identifier(upload.upload_param, '媒体上传参数', 32768)); uploadUrl.searchParams.set('filekey', filekey); }
      const response = await fetchImpl(uploadUrl.href, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/octet-stream' }, body: encrypted, signal: AbortSignal.timeout(30000) });
      if (!response.ok) fail('WECHAT_UPLOAD_UNKNOWN'); const parameter = identifier(response.headers.get('x-encrypted-param'), '媒体上传回执', 32768); await response.body?.cancel?.();
      const media = { encrypt_query_param: parameter, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 };
      const item = capability === 'chat.image' ? { type: 2, image_item: { media, mid_size: encrypted.length } } : capability === 'chat.video' ? { type: 5, video_item: { media, video_size: encrypted.length, video_md5: md5 } } : { type: 4, file_item: { media, file_name: String(payload.filename ?? 'asset').replace(/[\u0000-\u001f\\/]/g, '_').slice(0, 128), len: String(bytes.length), md5 } };
      return sendItems(target, [item], deliveryId);
    } catch (error) { return { status: ['WECHAT_ACTION_REJECTED', 'WECHAT_SESSION_EXPIRED', 'CONNECTION_AUTH_REJECTED'].includes(error.code) ? 'failed' : 'unknown', deliveryId, code: error.code ?? 'WECHAT_MEDIA_UNKNOWN' }; }
  }
  async function stop() { stopped = true; lifetime?.abort(); }
  async function close() { await stop(); await running?.catch(() => {}); running = null; }
  async function listen(onEvent) {
    if (!stopped) return; const checked = await probe(); if (!checked.connected) fail(checked.code); stopped = false; lifetime = new AbortController(); const ownLifetime = lifetime;
    running = (async () => {
      while (!stopped && lifetime === ownLifetime && !ownLifetime.signal.aborted) {
        try {
          const result = await action('getupdates', { get_updates_buf: state.cursor ?? '' }, { signal: ownLifetime.signal, timeoutMs: 40000 });
          if (stopped || lifetime !== ownLifetime || ownLifetime.signal.aborted) break;
          if (!Array.isArray(result.msgs) || result.msgs.length > 256) fail('WECHAT_UPDATES_INVALID');
          if (result.get_updates_buf !== undefined && (typeof result.get_updates_buf !== 'string' || Buffer.byteLength(result.get_updates_buf) > CONNECTION_LIMITS.cursorBytes)) fail('WECHAT_CURSOR_CAPACITY');
          for (const raw of result.msgs) {
            if (stopped || lifetime !== ownLifetime || ownLifetime.signal.aborted) break;
            const event = decodeWechatEvent(accountId, raw); if (!event) continue;
            if (typeof raw.context_token === 'string' && raw.context_token.length > 0 && raw.context_token.length <= 8192) { state.contexts[event.sender.id] = { token: raw.context_token }; while (Object.keys(state.contexts).length > CONNECTION_LIMITS.contexts) delete state.contexts[Object.keys(state.contexts)[0]]; }
            const accepted = await onEvent(event); if (accepted?.status === 'unknown') fail('CONNECTION_INBOUND_UNKNOWN');
          }
          if (stopped || lifetime !== ownLifetime || ownLifetime.signal.aborted) break;
          if (typeof result.get_updates_buf === 'string' && result.get_updates_buf && Buffer.byteLength(result.get_updates_buf) <= CONNECTION_LIMITS.cursorBytes) state.cursor = result.get_updates_buf;
          await onCheckpoint(structuredClone(state));
          if (!result.msgs.length) await new Promise(resolve => { const signal = ownLifetime.signal; const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); }; const timer = setTimeout(finish, 500); timer.unref?.(); signal.addEventListener('abort', finish, { once: true }); if (signal.aborted) finish(); });
        } catch (error) { if (stopped || lifetime !== ownLifetime || ownLifetime.signal.aborted) break; if (error.name === 'TimeoutError') continue; stopped = true; onError(error); break; }
      }
    })();
  }
  return { probe, sendText, sendVoice: async () => ({ status: 'unsupported', code: 'WECHAT_VOICE_ENCODING_UNAVAILABLE' }), execute, listen, stop, close, inspectCapabilities: async () => supported, get capabilities() { return { text: true, voice: false, group: false }; }, get listening() { return !stopped; } };
}
