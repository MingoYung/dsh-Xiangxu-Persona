import * as fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CAPACITY_LIMITS, capacityError, assertFiniteJson } from './capacity.js';
import { createHash, randomUUID } from 'node:crypto';

const clone = (value) => structuredClone(value);
const hash = (value) => createHash('sha256').update(value).digest('hex');
function error(code, message) { return Object.assign(new Error(message), { code }); }
export async function atomicReplaceWithRetry(source, target, { rename = fs.rename, delays = [5, 20, 50, 100] } = {}) {
  if (path.dirname(source) !== path.dirname(target)) throw error('UNSAFE_PATH', 'Atomic replacement source must be beside its target');
  if (!Array.isArray(delays) || delays.length > 8 || delays.some((n) => !Number.isFinite(n) || n < 0 || n > 1000)) throw error('INVALID_RETRY', 'Replacement retries must be finite and bounded');
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, target); return; }
    catch (failure) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(failure.code) || attempt >= delays.length) throw failure;
      // Retry an existing ordinary-file replacement only. Never unlink the live target.
      let existing;
      try { existing = await fs.lstat(target); } catch { throw failure; }
      if (!existing.isFile() || existing.isSymbolicLink()) throw failure;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

export class JsonStore {
  constructor(root, { fault = null, journalMaxBytes = 8388608, capacityLimits, diskReserveBytes = 0, rename, retryDelays } = {}) {
    if (!root || typeof root !== 'string') throw error('INVALID_ROOT', 'A memory root is required');
    this.root = path.resolve(root); this.fault = fault; this.journalMaxBytes = journalMaxBytes;
    this.capacityLimits = { ...DEFAULT_CAPACITY_LIMITS, ...capacityLimits }; this.diskReserveBytes = diskReserveBytes;
    this._replaceOptions = { ...(rename ? { rename } : {}), ...(retryDelays ? { delays: retryDelays } : {}) };
    this._tail = Promise.resolve(); this._opened = false; this._poisoned = false; this._token = randomUUID();
  }
  _queue(fn) {
    const result = this._tail.then(fn);
    this._tail = result.catch(() => {}); return result;
  }
  async _path(relative) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':')) || relative.includes('\0')) throw error('UNSAFE_PATH', 'Only safe relative paths are permitted');
    const target = path.resolve(this.root, relative);
    if (!target.startsWith(this.root + path.sep)) throw error('UNSAFE_PATH', 'Path escaped memory root');
    let cursor = this.root;
    for (const component of relative.split('/')) {
      cursor = path.join(cursor, component);
      try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw error('UNSAFE_PATH', 'Symbolic links and junctions are refused'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return target;
  }
  _check() {
    if (!this._opened) throw error('STORE_CLOSED', 'Store is not open');
    if (this._poisoned) throw error('RECOVERY_REQUIRED', 'Prepared write interrupted; reopen the store to recover');
  }
  async _syncDir(dir) {
    let handle;
    try { handle = await fs.open(dir, 'r'); await handle.sync(); }
    catch (e) { if (!['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP'].includes(e.code)) throw e; }
    finally { await handle?.close(); }
  }
  async _atomic(relative, text) {
    const target = await this._path(relative); await fs.mkdir(path.dirname(target), { recursive: true });
    await this._path(relative); // Recheck newly-created components before opening.
    const tmp = target + '.tmp-' + this._token + '-' + randomUUID();
    let handle;
    try {
      handle = await fs.open(tmp, 'wx'); await handle.writeFile(text, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      await atomicReplaceWithRetry(tmp, target, this._replaceOptions); await this._syncDir(path.dirname(target));
    } catch (e) { await handle?.close(); await fs.unlink(tmp).catch(() => {}); throw e; }
  }
  async _json(relative, fallback = null) {
    try { return JSON.parse(await fs.readFile(await this._path(relative), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return clone(fallback); throw e; }
  }
  async _lines(relative) {
    let raw;
    try { raw = await fs.readFile(await this._path(relative), 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return raw.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
      try { return JSON.parse(line); } catch { throw error('CORRUPT_JSONL', relative + ':' + (index + 1) + ' is not valid JSON'); }
    });
  }
  async open({ preflight, maintenanceToken } = {}) {
    return this._queue(async () => {
      if (this._opened) return this;
      const restoreJournal = path.join(path.dirname(this.root), '.' + path.basename(this.root) + '.restore-journal.json');
      const maintenanceLock = path.join(path.dirname(this.root), '.' + path.basename(this.root) + '.maintenance.lock');
      if (!maintenanceToken) {
        try { await fs.access(restoreJournal); throw error('RESTORE_PENDING', 'An interrupted restore must be recovered before opening memory'); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      let maintenance;
      try { maintenance = JSON.parse(await fs.readFile(maintenanceLock, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (maintenance && maintenance.token !== maintenanceToken) {
        let live = true; try { process.kill(maintenance.pid, 0); } catch (e) { if (e.code === 'ESRCH') live = false; }
        if (live) throw error('MEMORY_MAINTENANCE', 'Offline maintenance currently owns this memory root');
        await fs.unlink(maintenanceLock);
      }
      await fs.mkdir(this.root, { recursive: true });
      if ((await fs.lstat(this.root)).isSymbolicLink()) throw error('UNSAFE_PATH', 'Memory root cannot be a symlink');
      const lock = await this._path('writer.lock'); let acquired = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const handle = await fs.open(lock, 'wx');
          await handle.writeFile(JSON.stringify({ pid: process.pid, token: this._token }), 'utf8'); await handle.sync(); await handle.close();
          acquired = true; break;
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          const owner = await this._json('writer.lock');
          let alive = true;
          try { process.kill(owner.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
          if (alive) throw error('WRITER_LOCKED', 'Another live writer owns this memory root');
          await fs.unlink(lock);
        }
      }
      if (!acquired) throw error('WRITER_LOCKED', 'Unable to acquire writer lock');
      this._opened = true; this._poisoned = false;
      try {
        if (preflight) await preflight({ readJson: (relative, fallback = null) => this._json(relative, fallback) });
        await this._recover();
      } catch (e) { this._opened = false; await fs.unlink(lock).catch(() => {}); throw e; }
      return this;
    });
  }
  async _recover() {
    const walDir = await this._path('.wal'); await fs.mkdir(walDir, { recursive: true });
    const files = (await fs.readdir(walDir)).filter((name) => name.endsWith('.json')).sort();
    for (const file of files) {
      const manifest = await this._json('.wal/' + file);
      if (manifest.state === 'prepared') {
        if (hash(JSON.stringify(manifest.entries)) !== manifest.digest) throw error('CORRUPT_WAL', 'Prepared WAL checksum failed');
        for (const entry of manifest.entries) await this._apply(entry);
        manifest.state = 'committed'; await this._atomic('.wal/' + file, JSON.stringify(manifest));
      }
    }
    await this._prune();
  }
  async _prune() {
    const directory = await this._path('.wal');
    const entries = [];
    for (const file of await fs.readdir(directory)) if (file.endsWith('.json')) {
      const stat = await fs.stat(path.join(directory, file)); entries.push({ file, bytes: stat.size, time: stat.mtimeMs });
    }
    entries.sort((a, b) => a.time - b.time);
    let bytes = entries.reduce((sum, item) => sum + item.bytes, 0); let retained = entries.length;
    for (const entry of entries) {
      if (bytes <= this.journalMaxBytes && retained <= 128) break;
      const manifest = await this._json('.wal/' + entry.file);
      if (manifest.state === 'committed') { await fs.unlink(path.join(directory, entry.file)); bytes -= entry.bytes; retained--; }
    }
  }
  readJson(relative, fallback = null) { return this._queue(async () => { this._check(); return this._json(relative, fallback); }); }
  readLines(relative) { return this._queue(async () => { this._check(); return this._lines(relative); }); }
  async _apply(entry) {
    if (entry.text === null) {
      const target = await this._path(entry.path);
      let removed = true;
      await fs.unlink(target).catch((e) => { if (e.code !== 'ENOENT') throw e; removed = false; });
      if (removed) await this._syncDir(path.dirname(target));
    } else await this._atomic(entry.path, entry.text);
  }
  async _checkCapacity(entries, manifest) {
    const files = new Map();
    const visit = async (directory, relative = '') => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const name = relative ? relative + '/' + entry.name : entry.name, absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw error('UNSAFE_PATH', 'Symbolic link encountered during store capacity check');
        if (entry.isDirectory()) await visit(absolute, name); else files.set(name, (await fs.stat(absolute)).size);
      }
    };
    await visit(this.root);
    let added = 0, delta = 0;
    for (const entry of entries) {
      const bytes = entry.text == null ? 0 : Buffer.byteLength(entry.text);
      const businessDocument = /^(self\/(persona|history)\.json|global\/(index|codes|deep)\.json|people\/[^/]+\/(identity|index|codes|impression|pending)\.json)$/.test(entry.path);
      const documentLimit = businessDocument ? this.capacityLimits.documentBytes : this.journalMaxBytes;
      if (entry.text != null && entry.path.endsWith('.json') && bytes > documentLimit) throw capacityError(businessDocument ? 'documentBytes' : 'workspaceDocumentBytes', bytes, documentLimit, entry.path);
      if (entry.text != null && entry.path.endsWith('.jsonl')) for (const line of entry.text.split('\n')) {
        const rowBytes = Buffer.byteLength(line); if (rowBytes > this.journalMaxBytes) throw capacityError('workspaceRecordBytes', rowBytes, this.journalMaxBytes, entry.path);
      }
      added += bytes; delta += bytes - (files.get(entry.path) ?? 0);
    }
    const physicalBytes = [...files.values()].reduce((sum, bytes) => sum + bytes, 0), walBytes = Buffer.byteLength(JSON.stringify(manifest));
    const projectedBytes = physicalBytes + delta + walBytes;
    // Conservative peak: prepared WAL + its atomic replacement + replacement file temporaries.
    const peakBytes = physicalBytes + walBytes * 2 + added;
    if (projectedBytes > this.capacityLimits.storeBytes) throw capacityError('storeBytes', projectedBytes, this.capacityLimits.storeBytes);
    if (peakBytes > this.capacityLimits.storeBytes) throw capacityError('storePeakBytes', peakBytes, this.capacityLimits.storeBytes);
    const free = await fs.statfs(this.root), freeBytes = Number(free.bavail) * Number(free.bsize);
    const needed = Math.max(0, peakBytes - physicalBytes) + this.diskReserveBytes;
    if (freeBytes < needed) throw capacityError('diskReserveBytes', needed, freeBytes);
  }
  transaction({ runId = randomUUID(), json = {}, jsonl = {}, expectedVersions = {}, remove = [] }) {
    return this._queue(async () => {
      this._check();
      const entries = [...Object.entries(json).map(([name, value]) => {
        assertFiniteJson(value, { allowUndefined: !/^(self\/(persona|history)\.json|global\/(index|codes|deep)\.json|people\/[^/]+\/(identity|index|codes|impression|pending)\.json)$/.test(name) });
        return { path: name, text: JSON.stringify(value) + '\n' };
      }),
        ...Object.entries(jsonl).map(([name, values]) => {
          if (!Array.isArray(values)) throw error('INVALID_TRANSACTION', 'jsonl values must be arrays');
          assertFiniteJson(values, { allowUndefined: !/^(people\/[^/]+\/(stream|hot)|staging\/(events|hot))\.jsonl$/.test(name) });
          return { path: name, text: values.map((value) => JSON.stringify(value)).join('\n') + (values.length ? '\n' : '') };
        }), ...remove.map((name) => ({ path: name, text: null }))].sort((a, b) => a.path.localeCompare(b.path));
      if (new Set(entries.map((e) => e.path)).size !== entries.length) throw error('INVALID_TRANSACTION', 'Duplicate transaction path');
      for (const entry of entries) {
        await this._path(entry.path);
        if (entry.path === 'writer.lock' || entry.path === '.wal' || entry.path.startsWith('.wal/')) throw error('UNSAFE_PATH', 'Reserved store metadata path');
      }
      const digest = hash(JSON.stringify(entries)); const walFile = '.wal/' + hash(runId) + '.json';
      const previous = await this._json(walFile);
      if (previous) {
        if (previous.digest !== digest) throw error('RUN_ID_REUSED', 'runId was used for different writes');
        if (previous.state === 'committed') return { runId, duplicate: true };
        throw error('RECOVERY_REQUIRED', 'Prepared transaction must be recovered before retry');
      }
      for (const [name, expected] of Object.entries(expectedVersions)) {
        const current = await this._json(name);
        if ((current?.version ?? 0) !== expected) throw error('VERSION_CONFLICT', name + ' changed since input was prepared');
      }
      const manifest = { runId, digest, entries, state: 'prepared' };
      await this._checkCapacity(entries, manifest);
      let prepared = false;
      try {
        await this._atomic(walFile, JSON.stringify(manifest)); prepared = true;
        await this.fault?.('after_prepare', { runId });
        for (const entry of entries) {
          await this.fault?.('before_apply', { runId, path: entry.path });
          await this._apply(entry); await this.fault?.('after_apply', { runId, path: entry.path });
        }
        manifest.state = 'committed'; await this._atomic(walFile, JSON.stringify(manifest));
        await this.fault?.('after_commit', { runId }); await this._prune();
        return { runId, duplicate: false };
      } catch (e) { if (prepared) this._poisoned = true; throw e; }
    });
  }
  listFiles(prefix = '') {
    return this._queue(async () => {
      this._check(); const result = [];
      const visit = async (relative) => {
        const absolute = relative ? await this._path(relative) : this.root;
        for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
          const name = relative ? relative + '/' + entry.name : entry.name;
          if (entry.isSymbolicLink()) throw error('UNSAFE_PATH', 'Symlink encountered in memory root');
          if (entry.isDirectory()) await visit(name);
          else result.push({ path: name, bytes: (await fs.stat(await this._path(name))).size });
        }
      };
      await visit(''); return result.filter((item) => item.path.startsWith(prefix));
    });
  }
  availableBytes() { return this._queue(async () => { this._check(); const stat = await fs.statfs(this.root); return Number(stat.bavail) * Number(stat.bsize); }); }
  close() {
    return this._queue(async () => {
      if (!this._opened) return;
      const owner = await this._json('writer.lock');
      if (owner?.token === this._token) await fs.unlink(await this._path('writer.lock'));
      this._opened = false;
    });
  }
}
