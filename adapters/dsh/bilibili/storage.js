import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicReplaceWithRetry } from '../../../core/store.js';
import { BILIBILI_LIMITS, fail } from './common.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sameIdentity = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
const sameVersion = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function ownerRecord(bytes) {
  let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('BILI_WRITER_LOCKED'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'token') || !Object.hasOwn(value, 'pid') || typeof value.token !== 'string' || !UUID.test(value.token) || !Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 2147483647) fail('BILI_WRITER_LOCKED');
  return value;
}
function confirmedDead(pid) { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }

async function safePath(file) {
  const full = path.resolve(file); let current = path.parse(full).root;
  for (const part of full.slice(current.length).split(path.sep).filter(Boolean)) { current = path.join(current, part); try { const st = await fs.lstat(current); if (st.isSymbolicLink()) fail('BILI_STORAGE_PATH'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  return full;
}
async function readBytes(file, max) {
  const full = await safePath(file), handle = await fs.open(full, 'r');
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > max) fail('BILI_STORAGE_CAPACITY'); const bytes = Buffer.alloc(max + 1), result = await handle.read(bytes, 0, bytes.length, 0); if (result.bytesRead > max) fail('BILI_STORAGE_CAPACITY'); return bytes.subarray(0, result.bytesRead); } finally { await handle.close(); }
}
async function lockSnapshot(file) {
  const full = await safePath(file), before = await fs.lstat(full, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > 4096n) fail('BILI_WRITER_LOCKED');
  const handle = await fs.open(full, 'r');
  try {
    const opened = await handle.stat({ bigint: true }); if (!sameVersion(before, opened)) fail('BILI_WRITER_LOCKED');
    const buffer = Buffer.alloc(4097), read = await handle.read(buffer, 0, buffer.length, 0), bytes = buffer.subarray(0, read.bytesRead);
    if (read.bytesRead > 4096 || BigInt(read.bytesRead) !== opened.size) fail('BILI_WRITER_LOCKED');
    const after = await handle.stat({ bigint: true }); await safePath(full); const current = await fs.lstat(full, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || !sameVersion(opened, after) || !sameVersion(after, current)) fail('BILI_WRITER_LOCKED');
    return { bytes, identity: current, owner: ownerRecord(bytes) };
  } finally { await handle.close(); }
}
async function removeOwned(file, identity, token) {
  try { const current = await lockSnapshot(file); if (sameIdentity(current.identity, identity) && current.owner.token === token && current.owner.pid === process.pid) await fs.unlink(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
/** One live owner. Only a stable, well-formed lock whose PID is confirmed dead may be reclaimed. */
export function createBilibiliStorage(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new TypeError('An absolute Bilibili registry path is required');
  const lockFile = file + '.lock', recoveryFile = lockFile + '.recovery', token = randomUUID(); let lockHandle, identity, held = false;
  async function createLock() {
    await safePath(lockFile); let handle;
    try { handle = await fs.open(lockFile, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    const created = await handle.stat({ bigint: true });
    try { await handle.writeFile(JSON.stringify({ token, pid: process.pid })); await handle.sync(); identity = await handle.stat({ bigint: true }); lockHandle = handle; held = true; return true; }
    catch (error) {
      await handle.close().catch(() => {});
      try { await safePath(lockFile); const current = await fs.lstat(lockFile, { bigint: true }); if (current.isFile() && !current.isSymbolicLink() && sameIdentity(current, created)) await fs.unlink(lockFile); } catch {}
      throw error;
    }
  }
  return {
    async acquire() {
      const full = await safePath(file); await fs.mkdir(path.dirname(full), { recursive: true, mode: 0o700 }); await safePath(lockFile);
      if (await createLock()) return;
      // A second recovering process must not unlink the first process's new live lock.
      // Abnormal recovery guards fail closed; there is no time-based takeover.
      await safePath(recoveryFile); const recoveryToken = randomUUID(); let guard, guardIdentity;
      try { guard = await fs.open(recoveryFile, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') fail('BILI_WRITER_LOCKED'); throw error; }
      try {
        guardIdentity = await guard.stat({ bigint: true }); await guard.writeFile(JSON.stringify({ token: recoveryToken, pid: process.pid })); await guard.sync();
        let first; try { first = await lockSnapshot(lockFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (first) {
          if (!confirmedDead(first.owner.pid)) fail('BILI_WRITER_LOCKED');
          const second = await lockSnapshot(lockFile);
          if (!sameVersion(first.identity, second.identity) || !first.bytes.equals(second.bytes) || first.owner.token !== second.owner.token || first.owner.pid !== second.owner.pid || !confirmedDead(second.owner.pid)) fail('BILI_WRITER_LOCKED');
          await fs.unlink(lockFile);
        }
        // One attempt only: another ordinary wx acquirer may have won the empty path.
        // Never loop back and reap whichever writer appeared after the stale lock.
        if (!await createLock()) fail('BILI_WRITER_LOCKED');
      } finally { await guard.close(); await removeOwned(recoveryFile, guardIdentity, recoveryToken); }
    },
    async read() { try { return JSON.parse((await readBytes(file, BILIBILI_LIMITS.registryBytes)).toString('utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    async write(value) {
      if (!held) fail('BILI_WRITER_LOCKED');
      const bytes = Buffer.from(JSON.stringify(value) + '\n'); if (bytes.length > BILIBILI_LIMITS.registryBytes) fail('BILI_STORAGE_CAPACITY');
      const full = await safePath(file), temporary = await safePath(file + '.next-' + token), handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } catch (error) { await handle.close().catch(() => {}); try { await fs.unlink(temporary); } catch {} throw error; } finally { await handle.close().catch(() => {}); }
      try { await atomicReplaceWithRetry(temporary, full); } catch (error) { try { await fs.unlink(temporary); } catch {} throw error; }
    },
    async release() {
      if (!held) return; held = false; await lockHandle?.close().catch(() => {}); lockHandle = null;
      await removeOwned(lockFile, identity, token);
    },
  };
}
