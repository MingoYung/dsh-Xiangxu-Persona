import { createHash } from 'node:crypto';
import { validateRichEvent } from '../channels/rich-media.js';

export const CONNECTION_LIMITS = Object.freeze({ responseBytes: 1048576, mediaBytes: 16777216, textChars: 16000, contexts: 128, cursorBytes: 16384, queue: 32, flowMs: 600000 });
export const CAPABILITY_IDS = Object.freeze(['chat.text', 'chat.image', 'chat.video', 'chat.file', 'chat.voice', 'chat.sticker', 'chat.mention', 'message.read', 'message.forward.read', 'media.cover', 'message.reply', 'message.retract', 'contacts.read', 'groups.read', 'friend.query', 'friend.request', 'friend.manage', 'group.manage', 'profile.update', 'feed.read', 'feed.publish', 'feed.react', 'call.voice', 'call.video']);
export const fail = (code, message = '连接服务未完成操作') => { throw Object.assign(new Error(message), { code }); };
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function identifier(value, name = '标识', max = 512) { if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u0020\u007f]/u.test(value)) fail('CONNECTION_IDENTIFIER', name + '无效'); return value; }
export function endpoint(value, { domains = [], local = false, websocket = false } = {}) {
  let url; try { url = new URL(value); } catch { fail('CONNECTION_ENDPOINT'); }
  const protocol = websocket ? ['wss:'] : ['https:'];
  const ownLocal = local && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) && (websocket ? ['ws:', 'wss:'] : ['http:', 'https:']).includes(url.protocol);
  if ((!protocol.includes(url.protocol) || !domains.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) && !ownLocal || url.username || url.password || url.hash) fail('CONNECTION_ENDPOINT', '平台返回了未受信任的连接地址');
  return url;
}
export async function readLimited(response, max = CONNECTION_LIMITS.responseBytes) {
  const declared = Number(response.headers?.get?.('content-length')); if (Number.isFinite(declared) && declared > max) fail('CONNECTION_RESPONSE_CAPACITY');
  if (!response.body?.getReader) { const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > max) fail('CONNECTION_RESPONSE_CAPACITY'); return bytes; }
  const reader = response.body.getReader(), chunks = []; let total = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > max) { await reader.cancel(); fail('CONNECTION_RESPONSE_CAPACITY'); } chunks.push(Buffer.from(value)); } return Buffer.concat(chunks); }
  finally { reader.releaseLock(); }
}
export async function requestJson(fetchImpl, url, { method = 'POST', body, headers = {}, signal, timeoutMs = 15000 } = {}) {
  const timer = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, timer]) : timer;
  const response = await fetchImpl(String(url), { method, redirect: 'error', headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: combined });
  if (!response.ok) fail(response.status === 401 || response.status === 403 ? 'CONNECTION_AUTH_REJECTED' : 'CONNECTION_HTTP_STATUS');
  if (response.status === 204 && method === 'DELETE') return {};
  let result; try { result = JSON.parse((await readLimited(response)).toString('utf8')); } catch (error) { if (error.code) throw error; fail('CONNECTION_RESPONSE_INVALID'); }
  if (!object(result)) fail('CONNECTION_RESPONSE_INVALID'); return result;
}
export function capabilities(supported = [], reasons = {}) { return Object.fromEntries(CAPABILITY_IDS.map(id => [id, { supported: supported.includes(id), reason: supported.includes(id) ? null : reasons[id] ?? (id.startsWith('feed.') ? '当前连接器没有朋友圈／动态接口' : id.startsWith('call.') ? '当前连接器没有实时通话接口' : '当前连接器没有实现此操作') }])); }
export function normalizedEvent(event) {
  if (!object(event) || !['qq', 'wechat'].includes(event.platform) || !['private', 'group'].includes(event.conversation?.type)) fail('CONNECTION_EVENT_INVALID');
  identifier(event.accountId); identifier(event.sender?.id); identifier(event.conversation.id); identifier(event.message?.id);
  if (typeof event.message.text !== 'string' || Array.from(event.message.text).length > CONNECTION_LIMITS.textChars || !Number.isSafeInteger(event.message.createdAt) || event.message.createdAt < 0 || !Array.isArray(event.unsupportedSegments) || event.unsupportedSegments.length > 256) fail('CONNECTION_EVENT_INVALID');
  if (event.rich !== undefined) validateRichEvent(event.rich, { text: event.message.text });
  return event;
}
export function targetRoute(target, platform, accountId) {
  if (!object(target) || target.platform !== platform || target.accountId !== accountId || !['private', 'group'].includes(target.conversation?.type)) fail('CONNECTION_TARGET_MISMATCH');
  return { type: target.conversation.type, id: identifier(target.conversation.id) };
}
export function mediaBytes(payload) { const bytes = payload?.bytes; if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > CONNECTION_LIMITS.mediaBytes) fail('CONNECTION_MEDIA_CAPACITY', '发送需要调用方提供的有界媒体字节'); return Buffer.from(bytes); }
export const safeError = error => ({ code: /^[A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'CONNECTION_FAILED', message: '连接操作未完成，请查看连接状态并重新授权或稍后重试。' });
