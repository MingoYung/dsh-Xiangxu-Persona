import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { decodeOneBotSegments, decodeForwardMessages, resolveBridgeMedia, normalizeForwardId } from './rich-media.js';

// Official protocol evidence, pinned before implementing this adapter.
export const ONEBOT_STANDARD_SOURCES = Object.freeze({
  onebot11: 'https://github.com/botuniverse/onebot-11/tree/d4456ee706f9ada9c2dfde56a2bcfc69752600e4',
  onebot12: 'https://github.com/botuniverse/onebot/tree/d533f0fca3bd14781d4461776dba8d907d9de253',
  checkedOn: '2026-10-26',
});
export const ONEBOT_LIMITS = Object.freeze({ eventBytes: 262144, segments: 256, textChars: 16000, responseBytes: 65536, mediaResponseBytes:12582912, audioBytes: 8388608, receipts: 128 });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code, message) => Object.assign(new Error(message), { code });
const fail = (code, message) => { throw failure(code, message); };
const hash = value => createHash('sha256').update(value).digest('hex');
function identifier(value, { numeric = false, message = false } = {}) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || !message && value < 1) fail('ONEBOT_ID_INVALID', 'OneBot标识必须是保真的稳定值');
    value = String(value);
  }
  if (typeof value !== 'string' || !value || value.length > 256 || value.trim() !== value || /[\u0000-\u0020\u007f]/.test(value)) fail('ONEBOT_ID_INVALID', 'OneBot标识缺失或无效');
  if (numeric) {
    if (!(message ? /^-?\d+$/ : /^\d+$/).test(value)) fail('ONEBOT_ID_INVALID', 'OneBot11需要数字标识');
    const number = Number(value); if (!Number.isSafeInteger(number) || !message && number < 1) fail('ONEBOT_ID_INVALID', 'OneBot11数字标识超出保真范围');
    return String(number);
  }
  return value;
}
function routeProfile(profile) {
  if (!record(profile) || !['qq', 'wechat'].includes(profile.platform) || !['onebot11', 'onebot12'].includes(profile.protocol) || profile.protocol === 'onebot11' && profile.platform !== 'qq') fail('ONEBOT_PROFILE_INVALID', '请选择QQ OneBot11或微信OneBot12桥接配置');
  return { platform: profile.platform, protocol: profile.protocol, accountId: identifier(profile.accountId, { numeric: profile.protocol === 'onebot11' }) };
}
const clue = value => typeof value === 'string' && value && Array.from(value).length <= 256 && !/[\u0000-\u001f]/.test(value) ? value : undefined;
function textParts(message, protocol) {
  if (!Array.isArray(message)) fail('ONEBOT_MESSAGE_FORMAT', '请把OneBot入站消息配置为消息段数组；不从CQ码或alt_message猜原话');
  if (message.length > ONEBOT_LIMITS.segments) fail('ONEBOT_EVENT_CAPACITY', 'OneBot消息段超过技术容量');
  const texts = [], unsupported = new Set();
  for (const segment of message) {
    if (!record(segment) || typeof segment.type !== 'string' || !segment.type || segment.type.length > 64 || !record(segment.data)) fail('ONEBOT_MESSAGE_FORMAT', 'OneBot消息段无效');
    if (segment.type === 'text') {
      if (typeof segment.data.text !== 'string') fail('ONEBOT_MESSAGE_FORMAT', 'OneBot文字消息段缺少原文');
      texts.push(segment.data.text);
    } else unsupported.add(segment.type);
  }
  const text = texts.join('');
  if (Array.from(text).length > ONEBOT_LIMITS.textChars) fail('ONEBOT_EVENT_CAPACITY', '入站文字超过单条技术容量；原文没有被截断或标为已消费');
  return decodeOneBotSegments(message,{protocol});
}

/** Data-only normalization: stable actor and room IDs remain separate. No recognition or nickname parsing. */
export function decodeOneBotEvent(profile, payload) {
  const selected = routeProfile(profile);
  if (!record(payload)) fail('ONEBOT_EVENT_INVALID', 'OneBot事件必须是对象');
  if (selected.protocol === 'onebot11' ? payload.post_type !== 'message' : payload.type !== 'message') return null;
  let bytes; try { bytes = Buffer.byteLength(JSON.stringify(payload)); } catch { fail('ONEBOT_EVENT_INVALID', 'OneBot事件不是有限JSON'); }
  if (bytes > ONEBOT_LIMITS.eventBytes) fail('ONEBOT_EVENT_CAPACITY', 'OneBot事件超过技术容量');
  const v11 = selected.protocol === 'onebot11', type = v11 ? payload.message_type : payload.detail_type;
  if (!['private', 'group'].includes(type)) return null;
  if (v11 && (payload.sub_type === 'notice' || payload.sub_type === 'anonymous' || payload.anonymous)) return null;
  const self = identifier(v11 ? payload.self_id : payload.self?.user_id, { numeric: v11 });
  if (self !== selected.accountId || !v11 && payload.self?.platform !== selected.platform) fail('ONEBOT_ACCOUNT_MISMATCH', '此事件不属于配置的机器人账号或平台');
  const sender = identifier(payload.user_id, { numeric: v11 });
  if (sender === self) return null;
  if (v11 && payload.sender?.user_id !== undefined && identifier(payload.sender.user_id, { numeric: true }) !== sender) fail('ONEBOT_ACTOR_MISMATCH', 'OneBot发言者标识相互冲突');
  const id = identifier(payload.message_id, { numeric: v11, message: true });
  const conversationId = type === 'group' ? identifier(payload.group_id, { numeric: v11 }) : sender;
  if (typeof payload.time !== 'number' || !Number.isFinite(payload.time) || payload.time < 0 || !Number.isSafeInteger(Math.round(payload.time * 1000)) || v11 && !Number.isSafeInteger(payload.time)) fail('ONEBOT_EVENT_TIME', 'OneBot事件必须保留真实发生时间');
  const { text, unsupportedSegments, rich } = textParts(payload.message, selected.protocol);
  const name = v11 ? clue(payload.sender?.card) ?? clue(payload.sender?.nickname) : clue(payload.user_name) ?? clue(payload[selected.platform + '.user_name']);
  let rawReceiptId;
  if (!v11) rawReceiptId = identifier(payload.id);
  return { ...selected, conversation: { id: conversationId, type }, sender: { id: sender, ...(name ? { name } : {}) },
    message: { id, text, createdAt: Math.round(payload.time * 1000) }, rich, ...(rawReceiptId ? { rawReceiptId } : {}),
    ...(unsupportedSegments.length ? { unsupportedSegments, textComplete: false } : { textComplete: true }) };
}

function privateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  const address = host.startsWith('::ffff:') ? host.slice(7) : host;
  if (isIP(address) === 4) { const [a, b] = address.split('.').map(Number); return a === 127 || a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a === 169 && b === 254; }
  return isIP(host) === 6 && /^(?:fc|fd)[0-9a-f]{2}:|^fe[89ab][0-9a-f]:/.test(host);
}
function apiEndpoint(profile) {
  if (typeof profile.apiUrl !== 'string' || profile.apiUrl.length > 1024) fail('ONEBOT_API_URL', 'OneBot API地址无效');
  let url; try { url = new URL(profile.apiUrl); } catch { fail('ONEBOT_API_URL', 'OneBot API地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('ONEBOT_API_URL', 'API地址不能包含凭据、查询令牌或片段');
  if (!privateHost(url.hostname) && !(profile.allowRemote === true && url.protocol === 'https:')) fail('ONEBOT_API_REMOTE_DISABLED', '默认仅连接本机/私网；远程API需明确允许并使用HTTPS');
  return url;
}
function targetRoute(target, profile) {
  if (!record(target) || target.platform !== undefined && target.platform !== profile.platform || target.accountId !== undefined && identifier(target.accountId, { numeric: profile.protocol === 'onebot11' }) !== profile.accountId) fail('ONEBOT_TARGET_MISMATCH', '发送目标不属于当前平台账号');
  const conversation = target.conversation ?? target;
  if (!record(conversation) || !['private', 'group'].includes(conversation.type)) fail('ONEBOT_TARGET_INVALID', '发送目标必须是明确私聊或群聊');
  return { type: conversation.type, id: identifier(conversation.id, { numeric: profile.protocol === 'onebot11' }) };
}
async function readResponse(response, maximum = ONEBOT_LIMITS.responseBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maximum) fail('ONEBOT_RESPONSE_CAPACITY', 'OneBot响应超过技术容量');
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = []; let total = 0;
    try { while (true) { const { value, done } = await reader.read(); if (done) break; total += value.byteLength; if (total > maximum) { await reader.cancel(); fail('ONEBOT_RESPONSE_CAPACITY', 'OneBot响应超过技术容量'); } chunks.push(Buffer.from(value)); } text = Buffer.concat(chunks).toString('utf8'); }
    finally { reader.releaseLock(); }
  } else { text = await response.text(); if (Buffer.byteLength(text) > maximum) fail('ONEBOT_RESPONSE_CAPACITY', 'OneBot响应超过技术容量'); }
  let value; try { value = JSON.parse(text); } catch { fail('ONEBOT_RESPONSE_INVALID', 'OneBot没有返回有效JSON回执'); }
  if (!record(value)) fail('ONEBOT_RESPONSE_INVALID', 'OneBot回执无效');
  return value;
}
const accepted = response => response?.status === 'ok' && response.retcode === 0;

/** HTTP actions only. The caller owns secrets, listener, durable delivery state and platform driver. */
export function createOneBotClient(profile, { fetchImpl = fetch, clock = Date.now, timeoutMs = 15000 } = {}) {
  const selected = routeProfile(profile), endpoint = apiEndpoint(profile);
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail('ONEBOT_CLIENT_OPTIONS', 'OneBot客户端参数无效');
  const accessToken = profile.accessToken;
  if (accessToken !== undefined && (typeof accessToken !== 'string' || accessToken.length > 4096 || /[\u0000-\u001f\u007f]/.test(accessToken))) fail('ONEBOT_TOKEN_INVALID', 'OneBot令牌格式无效');
  let canVoice = false;
  const receipts = new Map();
  async function action(name, params = {}, { echo, mutate = false, responseBytes = ONEBOT_LIMITS.responseBytes, signal:outerSignal } = {}) {
    if(!Number.isSafeInteger(responseBytes)||responseBytes<1||responseBytes>ONEBOT_LIMITS.mediaResponseBytes)fail('ONEBOT_CLIENT_OPTIONS','OneBot响应容量设置无效');
    const v11 = selected.protocol === 'onebot11', url = v11 ? new URL(name, endpoint.href.replace(/\/?$/, '/')) : endpoint;
    const payload = v11 ? params : { action: name, params, self: { platform: selected.platform, user_id: selected.accountId }, ...(echo ? { echo } : {}) };
    const controller = new AbortController(); let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure('ONEBOT_TIMEOUT', 'OneBot请求超时，结果未知，不会自动重发')); }, timeoutMs); });
    try {
      return await Promise.race([(async () => {
        const response = await fetchImpl(url.href, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: 'Bearer ' + accessToken } : {}) }, body: JSON.stringify(payload), signal: outerSignal?AbortSignal.any([controller.signal,outerSignal]):controller.signal });
        if (response.status === 401 || response.status === 403) return { status: 'failed', code: 'ONEBOT_API_AUTH', retcode: null };
        if (!response.ok) return { status: 'unknown', code: 'ONEBOT_HTTP_STATUS', httpStatus: response.status };
        const result = await readResponse(response, responseBytes);
        if (!v11 && echo !== undefined && result.echo !== undefined && result.echo !== echo) return { status: 'unknown', code: 'ONEBOT_ECHO_MISMATCH' };
        if (accepted(result)) return { status: 'ok', data: result.data };
        if (result.status === 'failed' && Number.isSafeInteger(result.retcode) && result.retcode !== 0) return { status: 'failed', code: 'ONEBOT_ACTION_REJECTED', retcode: result.retcode };
        return { status: 'unknown', code: result.status === 'async' ? 'ONEBOT_ASYNC_RESULT' : 'ONEBOT_ACK_UNCONFIRMED' };
      })(), timeout]);
    } catch (error) { return { status: 'unknown', code: ['ONEBOT_TIMEOUT', 'ONEBOT_RESPONSE_CAPACITY', 'ONEBOT_RESPONSE_INVALID'].includes(error?.code) ? error.code : mutate ? 'ONEBOT_DELIVERY_UNKNOWN' : 'ONEBOT_PROBE_UNKNOWN' }; }
    finally { clearTimeout(timer); }
  }
  async function probe() {
    canVoice = false;
    const v11 = selected.protocol === 'onebot11', info = await action(v11 ? 'get_login_info' : 'get_self_info');
    if (info.status !== 'ok') return { ...selected, connected: false, status: info.status, code: info.code, capabilities: { text: true, voice: false }, driverRequired: true, livePlatformVerified: false };
    let actual; try { actual = identifier(info.data?.user_id, { numeric: v11 }); } catch { return { ...selected, connected: false, status: 'unknown', code: 'ONEBOT_SELF_UNCONFIRMED', capabilities: { text: true, voice: false }, driverRequired: true, livePlatformVerified: false }; }
    if (actual !== selected.accountId) return { ...selected, connected: false, status: 'failed', code: 'ONEBOT_ACCOUNT_MISMATCH', capabilities: { text: true, voice: false }, driverRequired: true, livePlatformVerified: false };
    const status = await action('get_status');
    const bot = !v11 && Array.isArray(status.data?.bots) ? status.data.bots.find(item => item.self?.platform === selected.platform && item.self?.user_id === selected.accountId) : null;
    const online = v11 ? status.data?.online : bot?.online;
    if (v11) { const voice = await action('can_send_record'); canVoice = voice.status === 'ok' && voice.data?.yes === true; }
    const connected = status.status === 'ok' && status.data?.good === true && online === true;
    return { ...selected, connected, status: connected ? 'connected' : online === false || status.data?.good === false ? 'offline' : 'unknown',
      capabilities: { text: true, voice: canVoice }, messageTypes: ['private', 'group'], driverRequired: true, livePlatformVerified: false,
      ...(selected.platform === 'wechat' ? { bridgeCapabilityRequired: 'wechat-private-and-group-support-must-be-verified-on-the-configured-driver' } : {}), checkedAt: clock() };
  }
  function receiptId(value) { if (typeof value !== 'string' || !value || value.length > 160 || /[\u0000-\u0020\u007f]/.test(value)) fail('ONEBOT_DELIVERY_ID', '发送需要稳定且有界的deliveryId'); return value; }
  function makeRoom() {
    if (receipts.size < ONEBOT_LIMITS.receipts) return;
    for (const [id, entry] of receipts) if (entry.result && entry.result.status !== 'unknown') { receipts.delete(id); break; }
    if (receipts.size >= ONEBOT_LIMITS.receipts) fail('ONEBOT_RECEIPT_CAPACITY', '尚未确认的发送收据已满，请由调用方对账，不会丢弃未知结果或自动重发');
  }
  async function send(target, segment, deliveryId) {
    const route = targetRoute(target, selected), id = receiptId(deliveryId), fingerprint = hash(JSON.stringify({ route, segment }));
    const previous = receipts.get(id);
    if (previous) { if (previous.fingerprint !== fingerprint) fail('ONEBOT_DELIVERY_CONFLICT', '同一deliveryId不能发送不同目标或内容'); return { ...await previous.promise, duplicate: true }; }
    makeRoom();
    const entry = { fingerprint, result: null };
    entry.promise = (async () => {
      const v11 = selected.protocol === 'onebot11';
      const params = { ...(v11 ? { [route.type === 'group' ? 'group_id' : 'user_id']: Number(route.id) } : { detail_type: route.type, [route.type === 'group' ? 'group_id' : 'user_id']: route.id }), message: Array.isArray(segment)?segment:[segment] };
      const result = await action(v11 ? route.type === 'group' ? 'send_group_msg' : 'send_private_msg' : 'send_message', params, { echo: id, mutate: true });
      let messageId;
      if (result.status === 'ok') try { messageId = identifier(result.data?.message_id, { numeric: v11, message: true }); } catch { /* A successful HTTP/API response is not a confirmed message delivery without an ID. */ }
      const observedTime = Number.isFinite(result.data?.time) && Number.isSafeInteger(Math.round(result.data.time * 1000)) && result.data.time >= 0 ? Math.round(result.data.time * 1000) : clock();
      const value = messageId !== undefined ? { status: 'delivered', deliveryId: id, messageId, receiptId: 'onebot:' + messageId, deliveredAt: observedTime, confirmedBy: 'onebot-message-id' }
        : { status: result.status === 'failed' ? 'failed' : 'unknown', deliveryId: id, code: result.code ?? 'ONEBOT_MESSAGE_ID_MISSING', ...(result.retcode !== undefined ? { retcode: result.retcode } : {}) };
      entry.result = value; return value;
    })();
    receipts.set(id, entry); return entry.promise;
  }
  async function sendText(target, text, { deliveryId } = {}) {
    if (typeof text !== 'string' || !text || Array.from(text).length > ONEBOT_LIMITS.textChars) fail('ONEBOT_TEXT_CAPACITY', '发送原文为空或超过单条技术容量；没有截断原文');
    return send(target, { type: 'text', data: { text } }, deliveryId);
  }
  async function sendVoice(target, audio, { deliveryId } = {}) {
    if (selected.protocol !== 'onebot11' || !canVoice) return { status: 'unsupported', code: 'ONEBOT_VOICE_UNCONFIRMED', deliveryId: receiptId(deliveryId) };
    const bytes = audio instanceof Uint8Array ? audio : audio?.bytes;
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > ONEBOT_LIMITS.audioBytes) fail('ONEBOT_AUDIO_CAPACITY', '语音需要调用方提供的有界音频字节，不读取路径或URL');
    return send(target, { type: 'record', data: { file: 'base64://' + Buffer.from(bytes).toString('base64') } }, deliveryId);
  }
  async function sendSegments(target, segments, {deliveryId}={}) {
    if(selected.protocol!=='onebot11')return{status:'unsupported',code:'ONEBOT_SEGMENTS_UNSUPPORTED',deliveryId:receiptId(deliveryId)};
    if(!Array.isArray(segments)||!segments.length||segments.length>64)fail('ONEBOT_SEGMENTS_INVALID','出站消息段数量无效');let chars=0,mediaTotal=0;
    for(const segment of segments){if(!record(segment)||!record(segment.data)||Object.keys(segment).some(key=>!['type','data'].includes(key)))fail('ONEBOT_SEGMENTS_INVALID','出站消息段格式无效');const data=segment.data,keys=Object.keys(data);if(segment.type==='text'){if(keys.some(key=>key!=='text')||typeof data.text!=='string')fail('ONEBOT_SEGMENTS_INVALID','出站文字段无效');chars+=Array.from(data.text).length;}
      else if(segment.type==='face'){if(keys.some(key=>key!=='id')||!['number','string'].includes(typeof data.id)||!/^\d{1,6}$/.test(String(data.id))||!Number.isSafeInteger(Number(data.id))||Number(data.id)<0||Number(data.id)>100000)fail('ONEBOT_SEGMENTS_INVALID','出站表情段无效');}
      else if(segment.type==='at'){if(keys.some(key=>key!=='qq'))fail('ONEBOT_SEGMENTS_INVALID','出站提及段无效');if(data.qq!=='all')identifier(data.qq,{numeric:true});}
      else if(segment.type==='reply'){if(keys.some(key=>key!=='id'))fail('ONEBOT_SEGMENTS_INVALID','出站引用段无效');identifier(data.id,{numeric:true,message:true});}
      else if(['image','video','record'].includes(segment.type)){if(keys.some(key=>key!=='file')||typeof data.file!=='string'||!data.file.startsWith('base64://')||data.file.length>Math.ceil(16777216/3)*4+12||!/^[A-Za-z0-9+/]+={0,2}$/.test(data.file.slice(9))||data.file.slice(9).length%4!==0)fail('ONEBOT_SEGMENTS_INVALID','出站媒体只接受有界Base64字节');const encoded=data.file.slice(9),bytes=Buffer.from(encoded,'base64');mediaTotal+=bytes.byteLength;if(mediaTotal>16777216||bytes.toString('base64')!==encoded)fail('ONEBOT_SEGMENTS_INVALID','出站媒体总字节超过容量或编码无效');}
      else fail('ONEBOT_SEGMENTS_INVALID','不支持此出站消息段');}
    if(chars>ONEBOT_LIMITS.textChars)fail('ONEBOT_TEXT_CAPACITY','出站文字超过单条技术容量');return send(target,cloneSegments(segments),deliveryId);
  }
  async function getMessage({messageId}={}) {
    if(selected.protocol!=='onebot11')return{status:'unsupported',code:'ONEBOT_READ_UNSUPPORTED'};const requested=identifier(messageId,{numeric:true,message:true}),result=await action('get_msg',{message_id:Number(requested)},{responseBytes:ONEBOT_LIMITS.eventBytes});if(result.status!=='ok')return{status:result.status,code:result.code??'ONEBOT_READ_UNCONFIRMED'};const data=result.data;if(!record(data)||identifier(data.message_id,{numeric:true,message:true})!==requested)fail('ONEBOT_MESSAGE_MISMATCH','引用读取回执的消息ID不一致');
    if(!Array.isArray(data.message))return{status:'unparsed',messageId:requested,reason:'bridge_returned_non_segment_content',rawMessageSha256:hash(JSON.stringify(data.message??null))};const decoded=decodeOneBotSegments(data.message,{protocol:selected.protocol});let senderId=null;if(data.sender?.user_id!==undefined)senderId=identifier(data.sender.user_id,{numeric:true});
    if(data.time!==undefined&&(!Number.isFinite(data.time)||data.time<0||!Number.isSafeInteger(Math.round(data.time*1000))))fail('ONEBOT_MESSAGE_TIME','引用读取时间无效');return{status:'completed',messageId:requested,text:decoded.text,rich:decoded.rich,claimedSender:{id:senderId,displayName:clue(data.sender?.nickname)??null,identityVerified:false},createdAt:data.time!==undefined?Math.round(data.time*1000):null,source:'onebot-get-msg',currentSenderIsQuotedAuthor:false};
  }
  async function getForward({forwardId}={}) {if(selected.protocol!=='onebot11')return{status:'unsupported',code:'ONEBOT_READ_UNSUPPORTED'};if(!normalizeForwardId(forwardId))fail('ONEBOT_FORWARD_ID','合并转发需要实际桥资源ID');const result=await action('get_forward_msg',{id:forwardId},{responseBytes:ONEBOT_LIMITS.eventBytes});if(result.status!=='ok')return{status:result.status,code:result.code??'ONEBOT_FORWARD_UNCONFIRMED'};return{...decodeForwardMessages(result.data,{protocol:selected.protocol}),forwardId};}
  async function resolveMedia(reference,ports={}) {if(selected.protocol!=='onebot11')return{status:'unsupported',code:'ONEBOT_MEDIA_UNSUPPORTED'};return resolveBridgeMedia(async(name,params)=>{const result=await action(name,params,{responseBytes:ONEBOT_LIMITS.mediaResponseBytes,signal:ports.signal});if(result.status!=='ok')fail(result.code??'ONEBOT_MEDIA_UNCONFIRMED','桥未确认媒体读取');return result.data;},reference,ports);}
  return { probe, sendText, sendVoice, sendSegments, getMessage, getForward, resolveMedia, get capabilities() { return { text: true, voice: canVoice && selected.protocol === 'onebot11' }; } };
}

const cloneSegments=value=>JSON.parse(JSON.stringify(value));
