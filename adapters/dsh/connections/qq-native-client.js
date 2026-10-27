export const QQ_NATIVE_PROTOCOL = 'xiangxu-qq-native/1';
export const QQ_NATIVE_ABI = 'qq-win-53644-req-to-friend/1';
export const QQ_NATIVE_CLIENT_LIMITS = Object.freeze({ responseBytes: 65536, requestBytes: 8192, timeoutMs: 15000, textChars: 512, operationIdChars: 160 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const id = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
const token = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u0020\u007f]/.test(value);
const ref = (value, kind) => typeof value === 'string' && new RegExp('^qq' + kind + '_[a-f0-9]{32}$').test(value);
function descriptor(value) {
  if (!object(value) || value.enabled !== true) fail('QQ_NATIVE_UNAVAILABLE', 'QQ原生账号服务尚未启用');
  if (value.protocol !== QQ_NATIVE_PROTOCOL || value.abiVersion !== QQ_NATIVE_ABI || !token(value.bootId, 160) || !token(value.token, 4096) || value.expectedAccountId !== null && !id(value.expectedAccountId)) fail('QQ_NATIVE_DESCRIPTOR', 'QQ原生服务身份或ABI尚未确认');
  let url; try { url = new URL(value.baseUrl); } catch { fail('QQ_NATIVE_ENDPOINT', 'QQ原生服务地址无效'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('QQ_NATIVE_ENDPOINT', 'QQ原生服务必须使用独立本机回环地址');
  return { ...value, baseUrl: url.origin };
}
function identity(body, runtime, error = false) {
  if (!object(body) || body.protocol !== QQ_NATIVE_PROTOCOL || body.bootId !== runtime.bootId || body.accountId !== runtime.expectedAccountId && runtime.expectedAccountId !== null && !(error && body.accountId === null) || body.accountId !== null && !id(body.accountId)) fail('QQ_NATIVE_IDENTITY', 'QQ原生服务的启动或账号身份发生变化');
}
async function bytes(response, max) {
  const declared = response.headers?.get?.('content-length'); if (declared && /^\d+$/.test(declared) && Number(declared) > max) fail('QQ_NATIVE_RESPONSE_CAPACITY', 'QQ原生响应超过技术容量');
  if (!response.body?.getReader) { const value = Buffer.from(await response.arrayBuffer()); if (value.length > max) fail('QQ_NATIVE_RESPONSE_CAPACITY', 'QQ原生响应超过技术容量'); return value; }
  const reader = response.body.getReader(), parts = []; let length = 0;
  try { for (;;) { const value = await reader.read(); if (value.done) break; length += value.value.byteLength; if (length > max) { await reader.cancel(); fail('QQ_NATIVE_RESPONSE_CAPACITY', 'QQ原生响应超过技术容量'); } parts.push(Buffer.from(value.value)); } } finally { reader.releaseLock(); }
  return Buffer.concat(parts);
}
function operationId(value) { if (!token(value, QQ_NATIVE_CLIENT_LIMITS.operationIdChars)) fail('QQ_NATIVE_ARGUMENT', '账号操作编号无效'); return value; }
function receipt(value, requestId) {
  if (value.operationId !== requestId || !['prepared', 'unknown', 'submitted', 'accepted', 'failed', 'unsupported'].includes(value.state) || ![null, 0, 1].includes(value.nativeCalls) || value.nativeCallUpperBound !== undefined && ![0, 1].includes(value.nativeCallUpperBound) || value.userId !== undefined && !id(value.userId) || value.targetRef !== undefined && !ref(value.targetRef, 'target') || value.optionsRef !== undefined && !ref(value.optionsRef, 'opts')) fail('QQ_NATIVE_RECEIPT', 'QQ原生操作回执字段未确认');
  if (value.state === 'submitted' && (value.confirmedBy !== 'native-result-zero' || value.nativeCalls !== 1) || value.state === 'accepted' && value.confirmedBy !== 'friend_list') fail('QQ_NATIVE_RECEIPT', 'QQ原生回执缺少实际确认来源');
  return value;
}

/** Local authenticated transport only. It never starts QQ, fabricates a message binding or retries a mutation. */
export function createQQNativeClient({ fetchImpl = fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('QQ native fetch port required');
  async function call(runtime, route, payload, { signal } = {}) {
    const own = descriptor(runtime), body = JSON.stringify(payload); if (Buffer.byteLength(body) > QQ_NATIVE_CLIENT_LIMITS.requestBytes) fail('QQ_NATIVE_ARGUMENT', 'QQ原生请求超过技术容量');
    const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(QQ_NATIVE_CLIENT_LIMITS.timeoutMs)]); combined.throwIfAborted();
    let response; try { response = await fetchImpl(own.baseUrl + route, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + own.token, 'x-xiangxu-boot-id': own.bootId }, body, signal: combined }); } catch { fail('QQ_NATIVE_TRANSPORT_UNKNOWN', 'QQ原生请求未获得可确认回执'); }
    let value; try { value = JSON.parse((await bytes(response, QQ_NATIVE_CLIENT_LIMITS.responseBytes)).toString('utf8')); } catch (error) { if (error.code === 'QQ_NATIVE_RESPONSE_CAPACITY') throw error; fail('QQ_NATIVE_RESPONSE', 'QQ原生响应无法核实'); }
    identity(value, own, !response.ok || Boolean(value.error));
    if (!response.ok || value.error) { const code = typeof value.error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.error.code) ? value.error.code : 'QQ_NATIVE_REJECTED'; const error = Object.assign(new Error('QQ原生服务未完成此操作'), { code, nativeRejected: true }); throw error; }
    return value;
  }
  return {
    async inspect(runtime, options) {
      const value = await call(runtime, '/v1/inspect', {}, options);
      if (typeof value.ready !== 'boolean' || value.abiVersion !== QQ_NATIVE_ABI || !object(value.capabilities) || ['query', 'request', 'respond'].some(name => !object(value.capabilities[name]) || typeof value.capabilities[name].supported !== 'boolean' || typeof value.capabilities[name].available !== 'boolean')) fail('QQ_NATIVE_CAPABILITIES', 'QQ原生能力尚未确认');
      return value;
    },
    async query(runtime, { userId } = {}, options) {
      if (!id(userId) || runtime?.expectedAccountId === null) fail('QQ_NATIVE_ARGUMENT', '请使用真实QQ号并确认当前账号'); const value = await call(runtime, '/v1/friend/query', { userId }, options);
      if (value.userId !== userId || !ref(value.targetRef, 'target') || !ref(value.optionsRef, 'opts') || !['friend', 'not_friend'].includes(value.relationship) || value.addFriendSetting !== null && (!Number.isSafeInteger(value.addFriendSetting) || value.addFriendSetting < -2147483648 || value.addFriendSetting > 2147483647) || !object(value.requirements) || typeof value.requirements.supported !== 'boolean' || typeof value.requirements.verificationText !== 'boolean' || !Number.isInteger(value.requirements.questionCount) || value.requirements.questionCount < 0 || value.requirements.questionCount > 16 || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0) fail('QQ_NATIVE_QUERY', 'QQ目标设置未取得可确认的身份和覆盖');
      return value;
    },
    async request(runtime, { operationId: key, optionsRef, text = '' } = {}, options) {
      operationId(key); if (!ref(optionsRef, 'opts') || typeof text !== 'string' || [...text].length > QQ_NATIVE_CLIENT_LIMITS.textChars || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || runtime?.expectedAccountId === null) fail('QQ_NATIVE_ARGUMENT', '好友请求参数无效');
      return receipt(await call(runtime, '/v1/friend/request', { operationId: key, optionsRef, text }, options), key);
    },
    async status(runtime, { operationId: key } = {}, options) { operationId(key); return receipt(await call(runtime, '/v1/friend/status', { operationId: key }, options), key); },
  };
}
