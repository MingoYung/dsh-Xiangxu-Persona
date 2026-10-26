import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicReplaceWithRetry } from '../../core/store.js';

export const SOCIAL_IDENTITY_LIMITS = Object.freeze({ perInstance: 32, total: 256, registryBytes: 262144, capabilities: 64, pageSize: 32 });
const SCHEMA = 'xiangxu-social-identities/1';
const FIELDS = ['platform', 'accountId', 'displayName', 'accountType', 'profileUrl', 'avatarUrl', 'notes'];
const KNOWN = Object.freeze({ qq: { label: 'QQ', accountType: 'bot' }, wechat: { label: '微信', accountType: 'personal' }, bilibili: { label: 'B站', accountType: 'creator' }, douyin: { label: '抖音', accountType: 'creator' } });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const failure = (code, message) => Object.assign(new Error(message), { code });
const fail = (code, message) => { throw failure(code, message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const normalizedRoot = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const identityId = (root, platform, accountId) => 'social-' + hash(JSON.stringify([normalizedRoot(root), platform, accountId])).slice(0, 32);
const safeCode = value => /^[A-Z][A-Z0-9_]{0,79}$/.test(value ?? '') ? value : 'SOCIAL_ADAPTER_UNAVAILABLE';
function text(value, label, max, empty = false) {
  if (typeof value !== 'string' || !value.isWellFormed() || !empty && !value || Array.from(value).length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail('SOCIAL_INVALID', label + '格式无效');
  return value;
}
function platformId(value) { text(value, '平台', 48); if (!/^[a-z][a-z0-9_-]{0,47}$/.test(value) || ['constructor', 'prototype', '__proto__'].includes(value)) fail('SOCIAL_INVALID', '平台标识无效'); return value; }
function url(value, label) {
  if (value === null || value === '') return null;
  text(value, label, 2048); let parsed; try { parsed = new URL(value); } catch { fail('SOCIAL_INVALID', label + '无效'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) fail('SOCIAL_INVALID', label + '不能包含凭据、查询或片段');
  return parsed.href;
}
function profile(input, previous = {}) {
  const value = { ...previous, ...input };
  return { platform: platformId(value.platform), accountId: text(value.accountId, '账号', 256),
    displayName: text(value.displayName ?? '', '显示名', 120, true),
    accountType: text(value.accountType ?? KNOWN[value.platform]?.accountType ?? 'other', '账号类型', 48),
    profileUrl: url(value.profileUrl ?? null, '主页链接'), avatarUrl: url(value.avatarUrl ?? null, '头像链接'),
    notes: text(value.notes ?? '', '备注', 1000, true) };
}
function validTime(value) { return Number.isSafeInteger(value) && value >= 0; }
function validateRegistry(value, limits) {
  if (!object(value) || Object.keys(value).some(key => !['schemaVersion', 'version', 'items'].includes(key)) || value.schemaVersion !== SCHEMA || !Number.isSafeInteger(value.version) || value.version < 0 || !Array.isArray(value.items) || value.items.length > limits.total) fail('SOCIAL_REGISTRY_INVALID', '社交身份登记格式或容量无效');
  const ids = new Set(), counts = new Map();
  for (const item of value.items) {
    if (!object(item) || Object.keys(item).some(key => ![...FIELDS, 'identityId', 'memoryRoot', 'bindingSource', 'createdAt', 'updatedAt'].includes(key)) || typeof item.memoryRoot !== 'string' || !path.isAbsolute(item.memoryRoot) || item.memoryRoot.length > 4096 || !['manual', 'current_connection'].includes(item.bindingSource) || !validTime(item.createdAt) || !validTime(item.updatedAt)) fail('SOCIAL_REGISTRY_INVALID', '社交身份登记条目无效');
    profile(item);
    if (item.identityId !== identityId(item.memoryRoot, item.platform, item.accountId) || ids.has(item.identityId)) fail('SOCIAL_REGISTRY_INVALID', '社交身份标识无效或重复');
    ids.add(item.identityId); const key = normalizedRoot(item.memoryRoot); counts.set(key, (counts.get(key) ?? 0) + 1);
    if (counts.get(key) > limits.perInstance) fail('SOCIAL_CAPACITY', '当前人格的社交身份达到容量');
  }
  if (Buffer.byteLength(JSON.stringify(value, null, 2) + '\n') > limits.registryBytes) fail('SOCIAL_CAPACITY', '社交身份登记达到字节容量');
  return value;
}
async function safePath(file) {
  const full = path.resolve(file); let cursor = path.parse(full).root;
  for (const part of full.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) fail('SOCIAL_UNSAFE_PATH', '社交身份登记不能经过符号链接或目录联接'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return full;
}

/** Owner metadata only. The separate lazy lease prevents competing registry writers. */
export function createSocialIdentityStorage(file, { maxBytes = SOCIAL_IDENTITY_LIMITS.registryBytes } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new TypeError('Social identity registry needs an absolute path');
  const owner = randomUUID(), lockPath = file + '.writer.lock'; let lease = false, closed = false, closeTask;
  async function read() {
    const full = await safePath(file); let handle;
    try {
      handle = await fs.open(full, 'r'); const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) fail('SOCIAL_CAPACITY', '社交身份登记不是普通文件或超过容量');
      const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1)); let length = 0;
      while (length < buffer.length) { const part = await handle.read(buffer, length, buffer.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
      const after = await handle.stat();
      if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) fail('SOCIAL_SOURCE_CHANGED', '社交身份登记读取期间发生变化');
      try { return JSON.parse(buffer.subarray(0, length).toString('utf8')); } catch { fail('SOCIAL_REGISTRY_INVALID', '社交身份登记不是有效JSON'); }
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; } finally { await handle?.close(); }
  }
  async function acquire() {
    if (closed) fail('SOCIAL_CLOSED', '社交身份登记已关闭'); if (lease) return false;
    await safePath(file); await fs.mkdir(path.dirname(file), { recursive: true }); await safePath(file);
    for (let attempt = 0; attempt < 2; attempt++) {
      await safePath(lockPath); let handle;
      try { handle = await fs.open(lockPath, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid, owner })); await handle.sync(); await handle.close(); lease = true; return true; }
      catch (error) {
        await handle?.close(); if (error.code !== 'EEXIST') throw error;
        const stat = await fs.lstat(lockPath); if (!stat.isFile() || stat.size > 4096) fail('SOCIAL_WRITER_LOCKED', '社交身份登记写锁无效');
        let lock; try { lock = JSON.parse(await fs.readFile(lockPath, 'utf8')); } catch { fail('SOCIAL_WRITER_LOCKED', '社交身份登记写锁无效'); }
        if (!Number.isSafeInteger(lock.pid) || lock.pid < 1) fail('SOCIAL_WRITER_LOCKED', '社交身份登记写锁无效');
        let alive = true; try { process.kill(lock.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
        if (alive) fail('SOCIAL_WRITER_LOCKED', '另一个进程正在写社交身份登记'); await fs.unlink(lockPath);
      }
    }
    fail('SOCIAL_WRITER_LOCKED', '社交身份登记写锁无法取得');
  }
  async function write(value) {
    if (!lease || closed) fail('SOCIAL_WRITER_LOCKED', '尚未取得社交身份登记写锁');
    const bytes = JSON.stringify(value, null, 2) + '\n'; if (Buffer.byteLength(bytes) > maxBytes) fail('SOCIAL_CAPACITY', '社交身份登记达到字节容量');
    await safePath(file); const temporary = file + '.next'; await safePath(temporary); const handle = await fs.open(temporary, 'w', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await atomicReplaceWithRetry(temporary, file);
  }
  function close() { if (closeTask) return closeTask; closed = true; closeTask = (async () => { if (lease) { const lock = JSON.parse(await fs.readFile(lockPath, 'utf8')); if (lock.owner === owner) await fs.unlink(lockPath); lease = false; } })(); return closeTask; }
  return { read, acquire, write, close };
}

function limitsFor(input = {}) {
  if (!object(input) || Object.keys(input).some(key => !Object.hasOwn(SOCIAL_IDENTITY_LIMITS, key))) fail('SOCIAL_INVALID', '未知社交身份容量设置');
  const limits = { ...SOCIAL_IDENTITY_LIMITS, ...input };
  for (const [key, min, max] of [['perInstance', 1, 256], ['total', 1, 4096], ['registryBytes', 4096, 1048576], ['capabilities', 1, 128], ['pageSize', 1, 64]]) if (!Number.isSafeInteger(limits[key]) || limits[key] < min || limits[key] > max) fail('SOCIAL_INVALID', '社交身份容量设置无效');
  if (limits.perInstance > limits.total) fail('SOCIAL_INVALID', '单人格身份数量不能超过总量'); return Object.freeze(limits);
}
const rootArgs = new Set(['instanceId']);
function strictArgs(args, permitted) { if (!object(args) || Object.keys(args).some(key => !permitted.has(key))) fail('SOCIAL_INVALID', '社交身份操作包含未知字段'); if (args.instanceId !== undefined) text(args.instanceId, '人格实例', 160); }
function capabilityItems(raw, maximum) {
  const input = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw?.capabilities) ? raw.capabilities : object(raw?.capabilities) ? Object.entries(raw.capabilities).map(([id, item]) => ({ id, ...(typeof item === 'boolean' ? { supported: item } : item) })) : [];
  if (input.length > maximum) fail('SOCIAL_ADAPTER_CAPACITY', '平台能力目录超过容量');
  const result = new Map();
  for (const item of input) {
    if (!object(item) || typeof item.id !== 'string' || !/^[a-z][a-z0-9_.-]{0,79}$/.test(item.id)) continue;
    result.set(item.id, { id: item.id, supported: item.supported === true, ...(typeof item.allowed === 'boolean' ? { allowed: item.allowed } : {}), driverAvailable: item.driverAvailable !== false && item.available !== false });
  }
  return [...result.values()];
}

/** Account identity does not grant tool authority or make a platform adapter exist. */
export function createSocialIdentityService({ registryPath, storage, getCoordinator, getConnectionStatus, getChannelCapabilities, getPermissionStatus, adapters = {}, clock = Date.now, limits: initialLimits = {} } = {}) {
  if (typeof getCoordinator !== 'function' || !storage && !registryPath || !object(adapters)) throw new TypeError('Social identities need a coordinator and registry');
  const limits = limitsFor(initialLimits), persistence = storage ?? createSocialIdentityStorage(registryPath, { maxBytes: limits.registryBytes });
  for (const [id, adapter] of Object.entries(adapters)) { platformId(id); if (!object(adapter) || typeof adapter.inspect !== 'function') throw new TypeError('Social identity adapters need inspect'); }
  let registry, closed = false, closing = false, closeTask, tail = Promise.resolve();
  const ready = (async () => { registry = validateRegistry(await persistence.read() ?? { schemaVersion: SCHEMA, version: 0, items: [] }, limits); })();
  const queue = work => { if (closed || closing) return Promise.reject(failure('SOCIAL_CLOSED', '社交身份服务已关闭')); const result = tail.then(async () => { await ready; if (closed) fail('SOCIAL_CLOSED', '社交身份服务已关闭'); return work(); }); tail = result.catch(() => {}); return result; };
  async function context(args) {
    const coordinator = await getCoordinator(args.instanceId); if (!coordinator) fail('INSTANCE_UNLOADED', '先加载人格实例再管理社交身份'); await coordinator.ready;
    if (coordinator.initializationError) throw coordinator.initializationError;
    if (typeof coordinator.memoryRoot !== 'string' || !path.isAbsolute(coordinator.memoryRoot) || coordinator.memoryRoot.length > 4096) fail('SOCIAL_INSTANCE_INVALID', '当前人格目录无效');
    return { memoryRoot: coordinator.memoryRoot, instanceId: args.instanceId };
  }
  async function current(expected) { const actual = await context(expected); if (normalizedRoot(actual.memoryRoot) !== normalizedRoot(expected.memoryRoot)) fail('SOCIAL_INSTANCE_CHANGED', '人格实例已切换，请重新读取'); }
  async function writable() {
    if (typeof persistence.acquire === 'function' && await persistence.acquire()) registry = validateRegistry(await persistence.read() ?? { schemaVersion: SCHEMA, version: 0, items: [] }, limits);
  }
  async function save(next) { validateRegistry(next, limits); await persistence.write(next); registry = next; }
  const selected = ctx => registry.items.filter(item => normalizedRoot(item.memoryRoot) === normalizedRoot(ctx.memoryRoot));
  const adapterAvailable = platform => ['qq', 'wechat'].includes(platform) ? typeof getConnectionStatus === 'function' && typeof getChannelCapabilities === 'function' : Object.hasOwn(adapters, platform);
  async function facts(item, ctx, refresh = false) {
    const native = ['qq', 'wechat'].includes(item.platform); let connection = null, channel = null, permission = null, diagnostic = null;
    const availableAdapter = adapterAvailable(item.platform);
    if (availableAdapter) {
      try {
        if (native) {
          [connection, channel] = await Promise.all([getConnectionStatus(item.platform), getChannelCapabilities(item.platform)]);
        } else {
          const adapter = adapters[item.platform];
          const inspect = refresh && typeof adapter.refresh === 'function' ? adapter.refresh : adapter.inspect;
          connection = await inspect.call(adapter, { platform: item.platform, accountId: item.accountId, memoryRoot: ctx.memoryRoot, instanceId: ctx.instanceId }); channel = connection;
        }
        if (typeof getPermissionStatus === 'function') permission = await getPermissionStatus(item.platform, { instanceId: ctx.instanceId, accountId: item.accountId, memoryRoot: ctx.memoryRoot });
      } catch (error) { diagnostic = { code: safeCode(error?.code) }; }
    }
    const currentAccount = Boolean(connection?.accountId === item.accountId && (channel?.accountId === undefined || channel.accountId === item.accountId));
    const connected = Boolean(currentAccount && connection?.connected === true && channel?.connected === true);
    let supported = [], grants = [];
    try { supported = capabilityItems(channel, limits.capabilities); grants = permission?.accountId === item.accountId ? capabilityItems(permission, limits.capabilities) : []; }
    catch (error) { diagnostic = { code: safeCode(error?.code) }; }
    const capabilityState = supported.map(item => {
      const grant = grants.find(value => value.id === item.id), allowed = typeof grant?.allowed === 'boolean' ? grant.allowed : null;
      const available = Boolean(item.supported && item.driverAvailable && connected && allowed === true && grant?.driverAvailable !== false);
      const status = !item.supported ? 'unsupported' : !connected ? 'unavailable' : allowed === false ? 'needs_grant' : allowed === null ? 'unverified' : available ? 'available' : 'unavailable';
      return { id: item.id, supported: item.supported, allowed, available, status,
        reason: status === 'available' ? null : status === 'unsupported' ? '当前适配器没有提供此能力' : !connected ? '此登记账号尚未通过当前连接核实' : status === 'needs_grant' ? '尚未获用户授权' : status === 'unverified' ? '用户授权状态尚未核实' : '当前能力未就绪' };
    });
    const data = Object.fromEntries([...FIELDS, 'identityId', 'bindingSource', 'createdAt', 'updatedAt'].map(key => [key, item[key]]));
    return { ...data, connection: { adapterAvailable: availableAdapter, currentAccount, connected,
      status: !availableAdapter ? 'unsupported' : connected ? 'connected' : connection?.accountId && !currentAccount ? 'account_changed' : currentAccount ? 'disconnected' : 'unverified',
      verification: connected ? 'verified' : 'unverified', credentialReference: native && currentAccount ? (channel?.mode === 'bridge' ? 'channel:' : 'connection:') + item.platform : null,
      samePlatformConcurrentAccounts: false, ...(diagnostic ? { diagnostic } : {}),
      ...(object(channel?.deliveryPolicy ?? connection?.deliveryPolicy) ? { deliveryPolicy: (() => { const policy = channel?.deliveryPolicy ?? connection.deliveryPolicy; return { proactive: policy.proactive === true,
        passiveReplyRequired: policy.passiveReplyRequired === true,
        ...(Number.isSafeInteger(policy.privateReplyWindowMs) ? { privateReplyWindowMs: policy.privateReplyWindowMs } : {}),
        ...(Number.isSafeInteger(policy.groupReplyWindowMs) ? { groupReplyWindowMs: policy.groupReplyWindowMs } : {}),
        reason: policy.proactive === false && policy.passiveReplyRequired === true ? '当前驱动只支持有效上下文内的被动回复，不支持主动推送' : null }; })() } : {}) }, capabilities: capabilityState };
  }
  function platforms() { return [...new Set([...Object.keys(KNOWN), ...Object.keys(adapters)])].map(id => ({ id, label: KNOWN[id]?.label ?? id, adapterAvailable: adapterAvailable(id), samePlatformConcurrentAccounts: false, credentialsManagedByConnector: ['qq', 'wechat'].includes(id) })); }
  async function listInner(args = {}, refresh = false) {
    if (refresh) registry = validateRegistry(await persistence.read() ?? { schemaVersion: SCHEMA, version: 0, items: [] }, limits);
    const ctx = await context(args), records = selected(ctx).filter(item => args.platform === undefined || item.platform === args.platform), offset = args.offset ?? 0, limit = args.limit ?? limits.pageSize;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > limits.pageSize) fail('SOCIAL_INVALID', '社交身份分页参数无效');
    const page = records.slice(offset, offset + limit), items = await Promise.all(page.map(item => facts(item, ctx, refresh))); await current(ctx);
    return { items, total: records.length, offset, limit, nextOffset: offset + page.length < records.length ? offset + page.length : null, complete: offset + page.length >= records.length,
      limits: { ...limits }, platforms: platforms(), ownerMetadataOnly: true, executionGrantedByRegistration: false };
  }
  function list(args = {}) { strictArgs(args, new Set([...rootArgs, 'platform', 'offset', 'limit'])); if (args.platform !== undefined) platformId(args.platform); return queue(() => listInner(args)); }
  function inspect(args = {}) {
    strictArgs(args, new Set([...rootArgs, 'identityId', 'platform', 'offset', 'limit']));
    if (args.platform !== undefined) platformId(args.platform);
    return queue(async () => {
      if (args.identityId === undefined) return listInner(args);
      const ctx = await context(args), item = selected(ctx).find(item => item.identityId === args.identityId); if (!item) fail('SOCIAL_NOT_FOUND', '当前人格没有这条社交身份');
      const result = await facts(item, ctx); await current(ctx); return { item: result, limits: { ...limits }, ownerMetadataOnly: true, executionGrantedByRegistration: false };
    });
  }
  async function upsertInner(args, bindingSource = 'manual') {
    const ctx = await context(args); await writable(); const id = identityId(ctx.memoryRoot, platformId(args.platform), text(args.accountId, '账号', 256)), previous = registry.items.find(item => item.identityId === id), clean = profile(args, previous);
    const same = previous && FIELDS.every(key => previous[key] === clean[key]);
    if (same && (bindingSource === 'manual' || previous.bindingSource === bindingSource)) { const item = await facts(previous, ctx); await current(ctx); return { item, changed: false }; }
    const now = clock(); if (!validTime(now)) fail('SOCIAL_INVALID', '当前时间无效');
    const record = { ...clean, identityId: id, memoryRoot: ctx.memoryRoot, bindingSource: bindingSource === 'manual' && previous ? previous.bindingSource : bindingSource, createdAt: previous?.createdAt ?? now, updatedAt: now };
    await current(ctx); await save({ schemaVersion: SCHEMA, version: registry.version + 1, items: [...registry.items.filter(item => item.identityId !== id), record] });
    const item = await facts(record, ctx); await current(ctx); return { item, changed: true };
  }
  function upsert(args = {}) { strictArgs(args, new Set([...rootArgs, ...FIELDS])); return queue(() => upsertInner(args)); }
  function remove(args = {}) {
    strictArgs(args, new Set([...rootArgs, 'identityId'])); text(args.identityId, '社交身份编号', 128);
    return queue(async () => { const ctx = await context(args); await writable(); const item = selected(ctx).find(item => item.identityId === args.identityId); if (!item) fail('SOCIAL_NOT_FOUND', '当前人格没有这条社交身份');
      await current(ctx); await save({ schemaVersion: SCHEMA, version: registry.version + 1, items: registry.items.filter(value => value.identityId !== item.identityId) });
      return { identityId: item.identityId, removed: true, platformAccountLoggedOut: false, permissionsChanged: false, memoriesDeleted: false }; });
  }
  function linkCurrent(args = {}) {
    strictArgs(args, new Set([...rootArgs, 'platform', 'displayName', 'accountType', 'profileUrl', 'avatarUrl', 'notes']));
    if (!['qq', 'wechat'].includes(args.platform)) fail('SOCIAL_CONNECTOR_UNAVAILABLE', '此平台请先使用实际接入的适配器完成账号连接');
    return queue(async () => { if (typeof getConnectionStatus !== 'function' || typeof getChannelCapabilities !== 'function') fail('SOCIAL_CONNECTOR_UNAVAILABLE', '当前没有此平台的连接适配器');
      const ctx = await context(args), [connection, channel] = await Promise.all([getConnectionStatus(args.platform), getChannelCapabilities(args.platform)]);
      const actual = connection;
      if (!actual?.accountId || actual.accountId !== channel?.accountId || actual.connected !== true || channel.connected !== true) fail('SOCIAL_ACCOUNT_UNVERIFIED', '先连接实际账号，再登记当前账号身份');
      await current(ctx); return upsertInner({ ...args, accountId: actual.accountId, accountType: args.accountType ?? (channel?.mode === 'bridge' ? 'personal' : KNOWN[args.platform].accountType) }, 'current_connection'); });
  }
  function refresh(args = {}) { strictArgs(args, new Set([...rootArgs, 'platform', 'offset', 'limit'])); if (args.platform !== undefined) platformId(args.platform); return queue(() => listInner(args, true)); }
  function close() { if (closeTask) return closeTask; closing = true; closeTask = (async () => { await tail; closed = true; await persistence.close?.(); })(); return closeTask; }
  return { ready, inspect, list, upsert, remove, linkCurrent, refresh, close };
}
