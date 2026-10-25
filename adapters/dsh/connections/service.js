import { randomUUID } from 'node:crypto';
import { createChannelRegistryStorage } from '../channels/service.js';
import { CONNECTION_LIMITS, capabilities, digest, fail, identifier, object, safeError } from './common.js';
import { beginQqLogin, pollQqLogin, createQqClient, QQ_CAPABILITIES } from './qq.js';
import { beginWechatLogin, pollWechatLogin, createWechatClient } from './wechat.js';

const IDS = ['qq', 'wechat'];
const SCHEMA = 'xiangxu-connections/1';
function validate(value) {
  if (!object(value) || value.schemaVersion !== SCHEMA || !object(value.accounts) || Object.keys(value.accounts).some(id => !IDS.includes(id)) || Buffer.byteLength(JSON.stringify(value)) > 1048576) fail('CONNECTION_REGISTRY_INVALID');
  for (const [id, account] of Object.entries(value.accounts)) {
    identifier(account.accountId); if (id === 'qq') identifier(account.appSecret, '机器人凭据', 4096); else { identifier(account.token, '微信连接凭据', 8192); identifier(account.apiBase, '平台地址', 2048); identifier(account.pairedUserId); }
    if (!object(account.transport) || !object(account.transport.contexts) || Object.keys(account.transport.contexts).length > CONNECTION_LIMITS.contexts) fail('CONNECTION_REGISTRY_INVALID');
    if (account.transport.cursor !== undefined && (typeof account.transport.cursor !== 'string' || Buffer.byteLength(account.transport.cursor) > CONNECTION_LIMITS.cursorBytes)) fail('CONNECTION_REGISTRY_INVALID');
  }
  return value;
}
/** Native owner-managed authentication. No credentials or context tokens leave this service. */
export function createConnectionService({ registryPath, storage, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, clock = Date.now, endpoints = {}, onEvent = async () => ({ status: 'unsupported' }), onError = () => {} } = {}) {
  const persistence = storage ?? createChannelRegistryStorage(registryPath), flows = new Map(), clients = new Map(), errors = new Map(); let registry, closed = false, tail = Promise.resolve();
  const queue = work => { const result = tail.then(async () => { if (closed) fail('CONNECTION_CLOSED'); await ready; return work(); }); tail = result.catch(() => {}); return result; };
  const ready = (async () => { const stored = await persistence.read(); registry = stored ? validate(stored) : { schemaVersion: SCHEMA, accounts: {} }; })();
  const selectedId = value => { if (!IDS.includes(value)) fail('CONNECTION_NOT_FOUND'); return value; };
  const report = (id, error) => { const safe = safeError(error); errors.set(id, safe); try { onError(Object.assign(new Error(safe.message), { code: safe.code })); } catch {} return safe; };
  async function save(next) { validate(next); await persistence.write(next); registry = next; }
  function publicStatus(id) {
    const account = registry.accounts[id], flow = flows.get(id), adapter = clients.get(id)?.adapter;
    return { id, mode: 'official', phase: flow?.phase ?? (account ? 'authorized' : 'idle'), ...(flow ? { flowId: flow.id, expiresAt: flow.expiresAt, ...(flow.qrContent && ['waiting', 'scanned', 'verify'].includes(flow.phase) ? { qrContent: flow.qrContent } : {}) } : {}), accountId: account?.accountId ?? null, pairedUserId: account?.pairedUserId ?? null, connected: adapter?.listening === true, hasCredentials: Boolean(account), chatTypes: id === 'qq' ? ['private', 'group'] : ['private'], supportedCapabilities: id === 'qq' ? QQ_CAPABILITIES : capabilities(['chat.text', 'chat.image', 'chat.video', 'chat.file']), platformPermissions: '可用范围仍取决于平台账号实际权限及API回执', error: errors.get(id) ?? null, qrScanByUserRequired: true, desktopPersonalAccountTakenOver: false, livePlatformVerified: false };
  }
  async function status() { await ready; return { connections: IDS.map(publicStatus), limits: { flowMs: CONNECTION_LIMITS.flowMs, mediaBytes: CONNECTION_LIMITS.mediaBytes } }; }
  async function start({ id } = {}) { return queue(async () => {
    selectedId(id); if (clients.get(id)?.adapter.listening) fail('CONNECTION_STOP_BEFORE_BIND', '先停止当前渠道再重新扫码');
    const previous = flows.get(id); if (previous && ['waiting', 'scanned', 'verify'].includes(previous.phase) && clock() < previous.expiresAt) return status();
    previous?.controller.abort(); const controller = new AbortController(), flow = { id: randomUUID(), phase: 'starting', expiresAt: clock() + CONNECTION_LIMITS.flowMs, controller };
    flows.set(id, flow); errors.delete(id);
    try { const data = await (id === 'qq' ? beginQqLogin : beginWechatLogin)({ fetchImpl, endpoints: endpoints[id] ?? {}, signal: controller.signal }); Object.assign(flow, data, { phase: 'waiting' }); }
    catch (error) { flow.phase = 'failed'; errors.set(id, report(id, error)); }
    return status();
  }); }
  async function poll({ id, flowId, verifyCode } = {}) { return queue(async () => {
    selectedId(id); const flow = flows.get(id); if (!flow || flow.id !== flowId) fail('CONNECTION_FLOW_STALE', '扫码任务已更换，请刷新连接状态');
    if (!['waiting', 'scanned', 'verify'].includes(flow.phase)) return status();
    if (clock() >= flow.expiresAt) { flow.phase = 'expired'; flow.controller.abort(); return status(); }
    try {
      const result = await (id === 'qq' ? pollQqLogin : pollWechatLogin)(flow, { fetchImpl, endpoints: endpoints[id] ?? {}, signal: flow.controller.signal, verifyCode });
      if (result.pollBase) flow.pollBase = result.pollBase;
      if (result.phase === 'authorized') { await clients.get(id)?.adapter.stop(); clients.delete(id); await save({ ...registry, accounts: { ...registry.accounts, [id]: result.credentials } }); flow.phase = 'authorized'; flow.qrContent = null; flow.key = null; flow.qrcode = null; errors.delete(id); }
      else { flow.phase = result.phase; if (result.code) errors.set(id, { code: result.code, message: '平台未完成绑定，请重新扫码或检查账号状态。' }); }
    } catch (error) { if (!flow.controller.signal.aborted) { flow.phase = 'failed'; report(id, error); } }
    return status();
  }); }
  async function cancel({ id, flowId } = {}) {
    await ready; selectedId(id); const current = flows.get(id); if (current && (!flowId || current.id === flowId)) current.controller.abort();
    return queue(async () => { const flow = flows.get(id); if (flowId && flow && flow.id !== flowId) fail('CONNECTION_FLOW_STALE'); if (flow) { flow.controller.abort(); flows.delete(id); } return status(); });
  }
  async function disconnect({ id } = {}) { await cancel({ id }); return queue(async () => { await clients.get(id)?.adapter.stop(); clients.delete(id); const accounts = { ...registry.accounts }; delete accounts[id]; await save({ ...registry, accounts }); errors.delete(id); return { ...await status(), localCredentialsDeleted: true, remoteAuthorizationRevoked: false }; }); }
  function client(id) {
    selectedId(id); if (!registry) fail('CONNECTION_NOT_READY'); const account = registry.accounts[id]; if (!account) fail('CONNECTION_NOT_AUTHORIZED', '先完成扫码授权');
    const signature = digest({ ...account, transport: undefined }); let entry = clients.get(id); if (entry?.signature === signature) return entry.adapter;
    const onCheckpoint = state => queue(async () => { const current = registry.accounts[id]; if (!current || digest({ ...current, transport: undefined }) !== signature) return; await save({ ...registry, accounts: { ...registry.accounts, [id]: { ...current, transport: state } } }); });
    const adapter = (id === 'qq' ? createQqClient : createWechatClient)(account, { fetchImpl, WebSocketImpl, endpoints: endpoints[id] ?? {}, clock, onCheckpoint, onError: error => report(id, error) });
    entry = { signature, adapter }; clients.set(id, entry); return adapter;
  }
  async function listen({ id } = {}) { await ready; const adapter = client(id); await adapter.listen(event => onEvent(id, event)); return status(); }
  async function stop({ id } = {}) { await ready; if (id) await clients.get(selectedId(id))?.adapter.stop(); else for (const entry of clients.values()) await entry.adapter.stop(); return status(); }
  async function close() { for (const flow of flows.values()) flow.controller.abort(); await stop(); await tail; closed = true; for (const entry of clients.values()) await entry.adapter.close(); clients.clear(); flows.clear(); }
  return { ready, status, start, poll, cancel, disconnect, client, listen, stop, close };
}
