import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicReplaceWithRetry } from '../../core/store.js';

export const INSTANCE_LIMITS = Object.freeze({ active: 16, cleared: 256, listedCleared: 20, registryBytes: 262144,
  ownershipBytes: 2097152, previewTtlMs: 300000, previews: 8, files: 20000, scanBytes: 268435456 });
export const CLEAR_SCOPE = Object.freeze(['当前人格文本库内的记忆、共同人格、自我档案、关系与暂存资料',
  '当前库内的运行状态、journal／WAL、形象与声音文字档案、宿主接入检查点和操作收据']);
export const CLEAR_EXCLUDED = Object.freeze(['目录外的图片、视频、音频及其他作品文件', '目录外的独立任务原件与完整任务档案',
  '共享平台账号、连接配置、API密钥与权限配置', 'DSH宿主的聊天历史与日志', '外部备份与导出副本', '实例登记和无正文的会话归属墓碑']);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sha = value => createHash('sha256').update(value).digest('hex');
export const sessionOwnershipKey = id => sha(id);
export function rootsOverlap(a, b) {
  a = path.resolve(a); b = path.resolve(b);
  return same(a, b) || (process.platform === 'win32' ? a.toLowerCase().startsWith(b.toLowerCase() + path.sep) || b.toLowerCase().startsWith(a.toLowerCase() + path.sep) : a.startsWith(b + path.sep) || b.startsWith(a + path.sep));
}
export async function safeInstanceRoot(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) fail('INSTANCE_PATH', '请选择绝对记忆目录');
  const root = path.resolve(input); if (same(root, path.parse(root).root)) fail('INSTANCE_PATH', '不能把磁盘根目录作为记忆库');
  let current = path.parse(root).root;
  for (const part of root.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const info = await fs.lstat(current);
      if (info.isSymbolicLink() || !same(await fs.realpath(current), current)) fail('INSTANCE_PATH', '记忆路径不能经过符号链接、目录联接或重定向');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return root;
}
export async function readInstanceMetadata(file, limit) {
  await safeInstanceRoot(path.dirname(file));
  const info = await fs.lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) fail('INSTANCE_PATH', '实例元数据必须是普通文件');
  if (info.size > limit) fail('INSTANCE_METADATA_CAPACITY', '实例元数据超过读取上限');
  const handle = await fs.open(file, 'r');
  try { const buffer = Buffer.alloc(limit + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) fail('INSTANCE_METADATA_CAPACITY', '实例元数据超过读取上限'); return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}
export async function writeInstanceMetadata(file, value, limit) {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(text) > limit) fail('INSTANCE_METADATA_CAPACITY', '实例管理资料超过技术容量；未删除人格资料');
  await safeInstanceRoot(path.dirname(file)); await fs.mkdir(path.dirname(file), { recursive: true });
  try { const info = await fs.lstat(file); if (info.isSymbolicLink() || !info.isFile()) fail('INSTANCE_PATH', '实例管理文件不能是链接或目录'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = file + '.next-' + randomUUID(), handle = await fs.open(temporary, 'wx');
  try {
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await atomicReplaceWithRetry(temporary, file);
  } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
}
async function removeUninitializedLock(file, identity) {
  // Only the wx-created inode from this attempt may be removed after an init
  // failure. A replacement path, link or somebody else's existing lock stays.
  try { const current = await fs.lstat(file);
    if (identity && current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) await fs.unlink(file);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function knownFile(name) {
  return ['config.json', 'registry.json', 'host-checkpoints.json', 'host-channels.json', 'extensions/qq-social/state.json'].includes(name)
    || /^(?:meta\/state|self\/(?:persona|history|profile)|global\/(?:state|index|codes|deep|usage-checkpoints)|identity\/profile|voice\/profile|ops\/management|operator\/(?:request|response|receipt))\.json$/.test(name)
    || /^global\/(?:outbox|snapshots|usage|revocations)\.jsonl$/.test(name)
    || /^staging\/(?:events|hot)\.jsonl$/.test(name)
    || /^people\/[A-Za-z0-9_-]{1,160}\/(?:identity|index|codes|impression|pending|state)\.json$/.test(name)
    || /^people\/[A-Za-z0-9_-]{1,160}\/(?:stream|hot)\.jsonl$/.test(name)
    || /^journal\/runs\/[A-Za-z0-9_-]{1,160}\.json$/.test(name)
    || /^\.wal\/[a-f0-9]{64}\.json$/.test(name)
    || name === 'extensions/qq-account/index.json'
    || /^extensions\/qq-account\/queries\/qqquery-[a-f0-9]{32}\.json$/.test(name)
    || /^extensions\/qq-account\/\.wal\/[a-f0-9]{64}\.json$/.test(name)
    || /^extensions\/qq-account\/receipts\/qqop-[a-f0-9]{32}\/(?:00000[0-9]|0000[1-5][0-9]|00006[0-4])\.json$/.test(name);
}
const knownDirectory = name => ['meta', 'self', 'global', 'identity', 'voice', 'ops', 'operator', 'staging', 'people', 'journal', 'journal/runs', '.wal', 'extensions', 'extensions/qq-social'].includes(name)
  || /^people\/[A-Za-z0-9_-]{1,160}$/.test(name)
  || ['extensions/qq-account','extensions/qq-account/queries','extensions/qq-account/receipts','extensions/qq-account/.wal'].includes(name)
  || /^extensions\/qq-account\/receipts\/qqop-[a-f0-9]{32}$/.test(name);
export async function hashManagedFile(root, relative) {
  await safeInstanceRoot(root);
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) fail('INSTANCE_PATH', '清除目标越过已确认的人格目录');
  await safeInstanceRoot(path.dirname(file));
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) fail('INSTANCE_PATH', '清除目标不是普通文件');
  const handle = await fs.open(file, 'r'), hash = createHash('sha256'); let total = 0;
  try { const buffer = Buffer.alloc(65536); for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; total += bytesRead; if (total > INSTANCE_LIMITS.scanBytes) fail('INSTANCE_CLEAR_CAPACITY', '单文件超过安全清除预览容量'); hash.update(buffer.subarray(0, bytesRead)); } }
  finally { await handle.close(); }
  const after = await fs.lstat(file);
  if (after.isSymbolicLink() || !after.isFile() || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || total !== after.size) fail('INSTANCE_CLEAR_STALE', '资料在预览时发生变化，请重新预览');
  return { path: relative, bytes: total, sha256: hash.digest('hex') };
}
export async function scanManagedText(root, items, instanceId, protectedFiles = []) {
  root = await safeInstanceRoot(root);
  for (const item of items) if (item.instanceId !== instanceId && rootsOverlap(root, item.memoryRoot)) fail('INSTANCE_ROOT_OVERLAP', '目标目录与其他登记人格目录重叠，不能清除');
  for (const file of protectedFiles) if (rootsOverlap(root, file)) fail('INSTANCE_ROOT_OVERLAP', '管理归属资料必须位于人格文本目录之外');
  const files = []; let bytes = 0;
  async function visit(relative = '') {
    const directory = relative ? path.join(root, relative) : root;
    let entries; try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT' && !relative) return; throw error; }
    for (const entry of entries) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) fail('INSTANCE_PATH', '目录包含链接或目录联接，未开始清除');
      const info = await fs.lstat(path.join(root, name));
      if (info.isSymbolicLink()) fail('INSTANCE_PATH', '目录包含链接或目录联接，未开始清除');
      if (info.isDirectory()) { if (!knownDirectory(name)) fail('INSTANCE_CLEAR_UNKNOWN_FILE', '人格目录中有不属于受管文本库的目录，未开始清除'); await safeInstanceRoot(path.join(root, name)); await visit(name); continue; }
      if (!info.isFile()) fail('INSTANCE_CLEAR_UNKNOWN_FILE', '人格目录中有未知文件类型，未开始清除');
      if (['writer.lock','extensions/qq-social/state.json.writer.lock','extensions/qq-account/writer.lock'].includes(name)) continue; // Active owner removes its own lock on close; it is never unlinked here.
      if (!knownFile(name)) fail('INSTANCE_CLEAR_UNKNOWN_FILE', '人格目录中有不属于受管文本库的文件，未开始清除');
      if (files.length >= INSTANCE_LIMITS.files) fail('INSTANCE_CLEAR_CAPACITY', '文件数量超过安全清除预览容量');
      const item = await hashManagedFile(root, name); files.push(item); bytes += item.bytes;
      if (bytes > INSTANCE_LIMITS.scanBytes) fail('INSTANCE_CLEAR_CAPACITY', '资料超过安全清除预览容量');
    }
  }
  await visit(); files.sort((a, b) => a.path.localeCompare(b.path));
  return { root, files, bytes, fingerprint: sha(JSON.stringify(files)) };
}
export function clearVersion(item, plan, registryVersion) {
  return sha(JSON.stringify({ instanceId: item.instanceId, name: item.name, root: plan.root, archivedAt: item.archivedAt ?? null,
    clearStatus: item.clearStatus ?? null, clearedAt: item.clearedAt ?? null, registryVersion, files: plan.files }));
}
export async function acquireClearGate(root) {
  await safeInstanceRoot(root);
  await fs.mkdir(path.dirname(root), { recursive: true });
  try { await fs.lstat(path.join(path.dirname(root), '.' + path.basename(root) + '.restore-journal.json')); fail('RESTORE_PENDING', '该人格有待恢复的维护记录，未开始清除'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const file = path.join(path.dirname(root), '.' + path.basename(root) + '.maintenance.lock'), token = randomUUID();
  let handle; try { handle = await fs.open(file, 'wx'); } catch (error) { if (error.code === 'EEXIST') fail('MEMORY_MAINTENANCE', '该人格已有维护操作，未开始清除'); throw error; }
  const identity = await handle.stat();
  try { try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, root })); await handle.sync(); } finally { await handle.close(); } }
  catch (error) { await removeUninitializedLock(file, identity).catch(() => {}); throw error; }
  return { async release() { try { const owner = JSON.parse(await readInstanceMetadata(file, 65536)); if (owner.token === token) await fs.unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } } };
}
export async function requireNoWriter(root) {
  for(const name of ['writer.lock','extensions/qq-social/state.json.writer.lock','extensions/qq-account/writer.lock']) {
    try { await fs.lstat(path.join(root, name)); fail('INSTANCE_WRITER_ACTIVE', '人格或扩展服务的写入锁仍存在，未开始清除；请先确认实例已停用'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
export async function deleteManagedPlan(plan, { unlink = fs.unlink } = {}) {
  const errors = []; let deletedFiles = 0;
  for (const expected of plan.files) {
    try {
      const actual = await hashManagedFile(plan.root, expected.path);
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) fail('INSTANCE_CLEAR_STALE', '清除时发现资料变化，已停止后续删除');
      await safeInstanceRoot(path.dirname(path.join(plan.root, expected.path)));
      await unlink(path.join(plan.root, expected.path)); deletedFiles++;
    } catch (error) { if (errors.length < 32) errors.push({ path: expected.path, code: error.code ?? 'UNLINK_FAILED' }); if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) break; }
  }
  return { deletedFiles, errors };
}
const OWNERSHIP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sameOwnershipIdentity = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
const sameOwnershipVersion = (a, b) => sameOwnershipIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function ownershipBusy(reason, ownerPid = null, ownerState = 'unknown') {
  throw Object.assign(new Error('会话归属暂时无法保存：' + reason + '；未清除或改写人格资料。'), { code: 'INSTANCE_OWNERSHIP_BUSY', ownerPid, ownerState });
}
function ownershipPidState(pid) {
  try { process.kill(pid, 0); return 'alive'; } catch (error) { return error.code === 'ESRCH' ? 'dead' : 'unknown'; }
}
function ownershipLockOwner(bytes) {
  let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { ownershipBusy('归属锁格式无法核实'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'pid') || !Object.hasOwn(value, 'token') || !Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 2147483647 || typeof value.token !== 'string' || !OWNERSHIP_UUID.test(value.token)) ownershipBusy('归属锁的持有者信息无法核实');
  return value;
}
async function ownershipLockSnapshot(file) {
  await safeInstanceRoot(path.dirname(file)); const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > 4096n) ownershipBusy('归属锁不是可核实的独立普通文件');
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat({ bigint: true }); if (!sameOwnershipVersion(before, opened)) ownershipBusy('归属锁在读取前已发生变化');
    const buffer = Buffer.alloc(4097), result = await handle.read(buffer, 0, buffer.length, 0), bytes = buffer.subarray(0, result.bytesRead);
    if (result.bytesRead > 4096 || BigInt(result.bytesRead) !== opened.size) ownershipBusy('归属锁读取不完整或超过技术容量');
    const after = await handle.stat({ bigint: true }); await safeInstanceRoot(path.dirname(file)); const current = await fs.lstat(file, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || !sameOwnershipVersion(opened, after) || !sameOwnershipVersion(after, current)) ownershipBusy('归属锁在核对期间已发生变化');
    return { bytes, identity: current, owner: ownershipLockOwner(bytes) };
  } finally { await handle.close(); }
}
async function createOwnershipLock(file, token) {
  let handle; try { handle = await fs.open(file, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  const created = await handle.stat();
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync(); const identity = await handle.stat({ bigint: true }); await handle.close(); handle = null;
    return { async release() {
      try { const current = await ownershipLockSnapshot(file); if (sameOwnershipIdentity(current.identity, identity) && current.owner.token === token && current.owner.pid === process.pid) await fs.unlink(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    } };
  } catch (error) { await handle?.close().catch(() => {}); await removeUninitializedLock(file, created).catch(() => {}); throw error; }
}
/** Recover only a stable record whose process is confirmed gone, never by age. */
async function acquireOwnershipLock(file) {
  const recoveryFile = file + '.recovery';
  try { await fs.lstat(recoveryFile); ownershipBusy('已有归属锁恢复记录，需要先核实该操作是否完成'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const direct = await createOwnershipLock(file, randomUUID()); if (direct) return direct;
  const guard = await createOwnershipLock(recoveryFile, randomUUID()); if (!guard) ownershipBusy('另一归属锁恢复操作正在执行');
  let recovered;
  try {
    let first; try { first = await ownershipLockSnapshot(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (first) {
      const state = ownershipPidState(first.owner.pid);
      if (state !== 'dead') ownershipBusy('归属锁持有进程PID ' + first.owner.pid + (state === 'alive' ? '仍在运行' : '的状态无法确认'), first.owner.pid, state);
      const second = await ownershipLockSnapshot(file);
      if (!sameOwnershipVersion(first.identity, second.identity) || !first.bytes.equals(second.bytes) || first.owner.token !== second.owner.token || first.owner.pid !== second.owner.pid) ownershipBusy('待恢复的归属锁已经被替换，保留当前锁');
      const secondState = ownershipPidState(second.owner.pid);
      if (secondState !== 'dead') ownershipBusy('归属锁持有进程PID ' + second.owner.pid + '已不再能确认退出', second.owner.pid, secondState);
      await fs.unlink(file);
    }
    // A normal wx acquirer may have won the now-empty path. Never reap again.
    recovered = await createOwnershipLock(file, randomUUID());
    if (!recovered) ownershipBusy('另一写者已取得新的归属锁，保留该锁');
    return recovered;
  } finally {
    try { await guard.release(); } catch (error) { await recovered?.release().catch(() => {}); throw error; }
  }
}

export function createSessionOwnershipStore(file, getItems) {
  let state = { schemaVersion: 'xiangxu-session-owners/1', version: 0, owners: {} };
  let captureTail = Promise.resolve();
  const validate = value => {
    if (!value || value.schemaVersion !== 'xiangxu-session-owners/1' || !Number.isSafeInteger(value.version) || value.version < 0 || !value.owners || Array.isArray(value.owners)) fail('INSTANCE_OWNERSHIP_SCHEMA', '会话归属记录格式无效');
    for (const [key, owner] of Object.entries(value.owners)) if (!/^[a-f0-9]{64}$/.test(key) || typeof owner !== 'string' || !owner || owner.length > 256) fail('INSTANCE_OWNERSHIP_SCHEMA', '会话归属记录字段无效');
    return value;
  };
  async function load() {
    for (const item of getItems()) if (rootsOverlap(item.memoryRoot, file)) fail('INSTANCE_ROOT_OVERLAP', '会话归属记录必须位于人格文本目录之外');
    try { state = validate(JSON.parse(await readInstanceMetadata(file, INSTANCE_LIMITS.ownershipBytes))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = { schemaVersion: 'xiangxu-session-owners/1', version: 0, owners: {} }; }
    return state;
  }
  async function capture(item, extraIds = []) {
      await safeInstanceRoot(path.dirname(file)); await fs.mkdir(path.dirname(file), { recursive: true });
      const lease = await acquireOwnershipLock(file + '.lock');
      try {
        await load(); const ids = [...extraIds];
        try { const checkpoint = JSON.parse(await readInstanceMetadata(path.join(item.memoryRoot, 'host-checkpoints.json'), 8388608));
          if (checkpoint.sessions && (typeof checkpoint.sessions !== 'object' || Array.isArray(checkpoint.sessions))) fail('INSTANCE_OWNERSHIP_SCHEMA', '宿主检查点的会话索引无效');
          ids.push(...Object.keys(checkpoint.sessions ?? {}));
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const next = structuredClone(state); let changed = false;
        for (const id of ids) {
          if (typeof id !== 'string' || !id || id.length > 4096) fail('INSTANCE_OWNERSHIP_SCHEMA', '会话归属标识无效');
          const key = sessionOwnershipKey(id), owner = next.owners[key];
          if (owner && owner !== item.instanceId) fail('INSTANCE_SESSION_CONFLICT', '同一会话已属于另一个人格，未覆盖归属');
          if (!owner) { next.owners[key] = item.instanceId; changed = true; }
        }
        if (changed) { next.version++; await writeInstanceMetadata(file, next, INSTANCE_LIMITS.ownershipBytes); state = next; }
        return Object.values(state.owners).filter(owner => owner === item.instanceId).length;
      } finally { await lease.release(); }
  }
  return { file, load,
    async ownerOf(sessionId) { await load(); return state.owners[sessionOwnershipKey(sessionId)] ?? null; },
    capture(item, extraIds = []) {
      const ids = [...extraIds], operation = captureTail.then(() => capture(item, ids));
      captureTail = operation.catch(() => {}); return operation;
    },
  };
}
