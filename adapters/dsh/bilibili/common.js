import { createHash } from 'node:crypto';
import { readLimited } from '../connections/common.js';

export const BILIBILI_LIMITS = Object.freeze({ registryBytes: 524288, responseBytes: 1048576, imageBytes: 4194304, imageTotalBytes: 12582912, resultChars: 16000, messageChars: 500, commentChars: 1000, queue: 32, receipts: 512, flowMs: 180000, frames: 6, pages: 128, timeoutMs: 15000 });
export const BILIBILI_OPERATIONS = Object.freeze({ search: 'feed.read', recommend: 'feed.read', video: 'feed.read', subtitles: 'feed.read', comments: 'feed.read', frames: 'feed.read', comment: 'feed.publish', reply: 'message.reply', share: 'chat.text', message: 'chat.text' });
export const BILIBILI_SOURCES = Object.freeze({ checkedOn: '2026-10-27', protocol: 'Bilibili public website endpoints; not Bilibili Open Platform OAuth', passport: 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate', account: 'https://api.bilibili.com/x/web-interface/nav', reference: 'https://github.com/c1overzz/dsh-bili-scroll/tree/4af98392ee078e02f50a7fd0bf0491033f4675ed', scope: 'Independent JavaScript implementation; no third-party source copied' });
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const fail = (code, message = 'B站操作未完成') => { throw Object.assign(new Error(message), { code }); };
export const hash = value => createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value)).digest('hex');
export const copy = value => structuredClone(value);
export const safeError = error => ({ code: /^BILI_[A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'BILI_REQUEST_FAILED', message: 'B站操作未完成，请检查账号授权、连接状态或技术容量。' });
export function text(value, max = BILIBILI_LIMITS.resultChars, empty = false) { if (typeof value !== 'string' || !empty && !value.trim() || value.length > max || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail('BILI_ARGUMENT'); return value; }
export function id(value, max = 160) { const result = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value; text(result, max); if (/\s/u.test(result)) fail('BILI_IDENTIFIER'); return result; }
export function uid(value) { const result = id(value, 20); if (!/^[1-9][0-9]{0,19}$/.test(result)) fail('BILI_UID'); return result; }
export function bvid(value) { if (typeof value !== 'string' || !/^BV[0-9A-Za-z]{10}$/.test(value)) fail('BILI_BVID'); return value; }
export const videoUrl = value => 'https://www.bilibili.com/video/' + bvid(value);
export function integer(value, fallback, min, max) { const result = value === undefined ? fallback : value; if (!Number.isSafeInteger(result) || result < min || result > max) fail('BILI_ARGUMENT'); return result; }
export function fields(value, allowed) { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('BILI_ARGUMENT'); return value; }
export function trustedUrl(value, hosts, localBases = []) {
  let url; try { url = new URL(String(value).startsWith('//') ? 'https:' + value : value); } catch { fail('BILI_ENDPOINT'); }
  const local = localBases.some(base => { try { const target = new URL(base); return ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && url.origin === target.origin; } catch { return false; } });
  if (url.username || url.password || url.hash || !(url.protocol === 'https:' && hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host)) || local && ['http:', 'https:'].includes(url.protocol))) fail('BILI_ENDPOINT');
  return url;
}
export function externalSource(operation, value, clock, coverage) { return { sourceKind: 'external_content', contentClass: 'external_material', platform: 'bilibili', operation, url: value ? videoUrl(value) : 'https://www.bilibili.com/', fetchedAt: clock(), ...(value ? { bvid: value } : {}), ...(coverage ? { coverage } : {}), instructionsTrusted: false }; }
export const cookieHeader = credential => credential ? `SESSDATA=${credential.sessdata}; bili_jct=${credential.csrf}; DedeUserID=${credential.accountId}${credential.buvid3 ? '; buvid3=' + credential.buvid3 : ''}` : '';
export function credential(value) {
  if (!object(value) || Object.keys(value).some(key => !['accountId', 'sessdata', 'csrf', 'buvid3'].includes(key))) fail('BILI_CREDENTIAL_INVALID');
  uid(value.accountId);
  for (const key of ['sessdata', 'csrf']) if (typeof value[key] !== 'string' || !value[key] || value[key].length > 8192 || /[\u0000-\u0020\u007f;]/u.test(value[key])) fail('BILI_CREDENTIAL_INVALID');
  if (value.buvid3 !== undefined && (typeof value.buvid3 !== 'string' || value.buvid3.length > 256 || /[\u0000-\u0020\u007f;]/u.test(value.buvid3))) fail('BILI_CREDENTIAL_INVALID');
  return value;
}
export function cookiesFrom(response) {
  const values = response.headers?.getSetCookie?.() ?? [], picked = {};
  for (const item of values) { const first = String(item).split(';', 1)[0], at = first.indexOf('='); if (at < 1) continue; const key = first.slice(0, at).trim(), value = first.slice(at + 1); const field = { SESSDATA: 'sessdata', bili_jct: 'csrf', DedeUserID: 'accountId', buvid3: 'buvid3' }[key]; if (field) picked[field] = value; }
  return credential(picked);
}
export function createHttp({ fetchImpl = fetch, lifetime, endpoints = {} } = {}) {
  const bases = { api: endpoints.api ?? 'https://api.bilibili.com', passport: endpoints.passport ?? 'https://passport.bilibili.com', message: endpoints.message ?? 'https://api.vc.bilibili.com' };
  for (const [name, value] of Object.entries(bases)) trustedUrl(value, [name === 'passport' ? 'passport.bilibili.com' : name === 'message' ? 'api.vc.bilibili.com' : 'api.bilibili.com'], Object.values(endpoints));
  function url(base, path, query = {}) { const result = new URL(path, bases[base]); for (const [key, value] of Object.entries(query)) if (value !== undefined) result.searchParams.set(key, String(value)); return result; }
  async function raw(target, { method = 'GET', form, auth, signal, max = BILIBILI_LIMITS.responseBytes, image = false } = {}) {
    const timeout = AbortSignal.timeout(BILIBILI_LIMITS.timeoutMs), combined = AbortSignal.any([timeout, ...(lifetime ? [lifetime] : []), ...(signal ? [signal] : [])]);
    const response = await fetchImpl(String(target), { method, redirect: 'error', signal: combined, headers: { 'user-agent': 'Xiangxu-Persona-Bilibili/0.10', Referer: 'https://www.bilibili.com/', ...(auth ? { Cookie: cookieHeader(auth) } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, ...(form ? { body: new URLSearchParams(form).toString() } : {}) });
    if (!response.ok) { await response.body?.cancel?.(); fail(response.status === 401 || response.status === 403 ? 'BILI_AUTH_REJECTED' : 'BILI_HTTP_STATUS'); }
    const bytes = await readLimited(response, max).catch(error => { if (error.code === 'CONNECTION_RESPONSE_CAPACITY') fail('BILI_RESPONSE_CAPACITY'); throw error; });
    if (combined.aborted) fail('BILI_ABORTED');
    if (image) return { response, bytes };
    let data; try { data = JSON.parse(bytes.toString('utf8')); } catch { fail('BILI_RESPONSE_INVALID'); }
    if (!object(data) || !Number.isSafeInteger(data.code)) fail('BILI_ACK_UNCONFIRMED');
    return { response, value: data };
  }
  async function json(base, path, query, options) { const result = await raw(url(base, path, query), options); if (result.value.code !== 0) fail([-101, -111, -400, -403].includes(result.value.code) ? 'BILI_AUTH_REJECTED' : 'BILI_PLATFORM_REJECTED'); if (!object(result.value.data) && !Array.isArray(result.value.data)) fail('BILI_RESPONSE_INVALID'); return result.value.data; }
  return { bases, url, raw, json, localBases: Object.values(endpoints) };
}
