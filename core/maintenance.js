import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { JsonStore, atomicReplaceWithRetry } from './store.js';
import { temporaryCleanupPlan, runReferencesRevocation } from './source-dependencies.js';
import { SCHEMA_VERSION, validateConfig, validatePersona, validateChat, validateHot,
  validateMemoryItem, validateCode, validateInterpretation, validateImpression, validateDeepMemory } from './schema.js';

const FORMAT = 'persona-memory-backup/1';
const DEFAULT_MAX = 64 * 1024 * 1024;
const MARKER = '.persona-maintenance.json';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const exists = async (file) => { try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const json = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
function absoluteRoot(value) {
  if (typeof value !== 'string' || !value) fail('INVALID_ROOT', 'An explicit directory is required');
  const resolved = path.resolve(value);
  if (same(resolved, path.parse(resolved).root)) fail('UNSAFE_PATH', 'A filesystem root is not a memory directory');
  return resolved;
}
async function noLinks(target) {
  const resolved = absoluteRoot(target); let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) fail('UNSAFE_PATH', 'Maintenance refuses symlinks and junctions'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return resolved;
}
function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.isAbsolute(relative) ||
    relative.split('/').some((p) => !p || p === '.' || p === '..' || p.includes(':'))) fail('UNSAFE_PATH', 'Unsafe manifest path');
  const result = path.resolve(root, relative);
  if (!result.startsWith(root + path.sep)) fail('UNSAFE_PATH', 'Manifest path escaped directory');
  return result;
}
function separate(a, b) {
  const left = process.platform === 'win32' ? a.toLowerCase() : a;
  const right = process.platform === 'win32' ? b.toLowerCase() : b;
  if (left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep)) fail('OVERLAPPING_PATHS', 'Source and destination must be separate directories');
}
async function activeWriter(root) {
  const file = path.join(root, 'writer.lock');
  if (!await exists(file)) return false;
  const lock = await json(file);
  try { process.kill(lock.pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; }
}
async function syncWrite(file, value) {
  const temp = file + '.tmp-' + randomUUID(), handle = await fs.open(temp, 'wx');
  try { await handle.writeFile(typeof value === 'string' ? value : JSON.stringify(value) + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try { await atomicReplaceWithRetry(temp, file); } catch (e) { await fs.unlink(temp).catch(() => {}); throw e; }
}
async function scan(root, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail('INVALID_CAPACITY', 'maxBytes must be a positive safe integer');
  await noLinks(root); const files = []; let totalBytes = 0;
  async function visit(relative) {
    const dir = relative ? inside(root, relative) : root;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) fail('UNSAFE_PATH', 'Maintenance refuses symlinks and junctions');
      if (entry.isDirectory()) { await visit(name); continue; }
      if (!entry.isFile()) fail('UNSUPPORTED_FILE', 'Unexpected non-file in memory root');
      if (name === 'writer.lock' || name === MARKER || name.includes('.tmp-')) continue;
      const data = await fs.readFile(inside(root, name));
      totalBytes += data.length; if (totalBytes > maxBytes) fail('BACKUP_CAPACITY', 'Selected memory exceeds maxBytes');
      files.push({ path: name, bytes: data.length, sha256: sha(data) });
    }
  }
  await visit(''); files.sort((a, b) => a.path.localeCompare(b.path)); return { files, totalBytes };
}
async function validateContent(root, files) {
  const required = ['config.json', 'meta/state.json', 'self/persona.json', 'global/state.json'];
  for (const name of required) if (!files.some((f) => f.path === name)) fail('INVALID_MEMORY', 'Missing required memory file: ' + name);
  let preparedWal = 0;
  for (const file of files) {
    if (!/\.jsonl?$/.test(file.path)) fail('UNSUPPORTED_FILE', 'Unknown non-JSON memory file: ' + file.path);
    const text = await fs.readFile(inside(root, file.path), 'utf8');
    const values = file.path.endsWith('.jsonl') ? text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line)) : [JSON.parse(text)];
    for (const value of values) {
      if (value && typeof value === 'object' && value.schemaVersion && value.schemaVersion !== SCHEMA_VERSION) fail('SCHEMA_UNSUPPORTED', 'Unsupported schema in ' + file.path);
      if (file.path === 'config.json') validateConfig(value);
      else if (file.path === 'self/persona.json') validatePersona(value);
      else if (/^(people\/[^/]+\/stream|staging\/events)\.jsonl$/.test(file.path)) validateChat(value);
      else if (/^(people\/[^/]+\/hot|staging\/hot)\.jsonl$/.test(file.path)) validateHot(value);
      else if (/^(people\/[^/]+|global)\/index\.json$/.test(file.path)) { if (!Array.isArray(value.items)) fail('INVALID_MEMORY', 'Index items missing'); value.items.forEach(validateMemoryItem); }
      else if (/^(people\/[^/]+|global)\/codes\.json$/.test(file.path)) { if (!Array.isArray(value.items)) fail('INVALID_MEMORY', 'Code items missing'); value.items.forEach(validateCode); }
      else if (file.path === 'global/deep.json') {
        if (value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.items) || !Number.isSafeInteger(value.version) || value.version < 0 ||
          !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) fail('INVALID_MEMORY', 'Deep memory document is invalid');
        value.items.forEach(validateDeepMemory);
      }
      else if (/^people\/[^/]+\/pending\.json$/.test(file.path)) value.items.forEach(validateInterpretation);
      else if (/^people\/[^/]+\/impression\.json$/.test(file.path)) validateImpression(value);
      else if (file.path.startsWith('.wal/')) {
        if (value.digest !== sha(JSON.stringify(value.entries))) fail('CORRUPT_WAL', 'WAL checksum mismatch');
        if (value.state === 'prepared') preparedWal++;
      }
    }
  }
  return { preparedWal };
}
export async function validateMemoryRoot(root, { maxBytes = DEFAULT_MAX } = {}) {
  root = await noLinks(root);
  if (await activeWriter(root)) fail('WRITER_LOCKED', 'Stop the memory writer before maintenance');
  const result = await scan(root, maxBytes); const details = await validateContent(root, result.files);
  return { schemaVersion: SCHEMA_VERSION, root, ...result, ...details };
}
export async function validateBackup(source, { maxBytes = DEFAULT_MAX } = {}) {
  source = await noLinks(source); const manifest = await json(path.join(source, 'manifest.json'));
  if (manifest.backupFormat !== FORMAT || manifest.schemaVersion !== SCHEMA_VERSION || !Array.isArray(manifest.files)) fail('INVALID_BACKUP', 'Unsupported backup manifest');
  const dataRoot = path.join(source, 'data'); const actual = await scan(dataRoot, maxBytes);
  if (JSON.stringify(actual.files) !== JSON.stringify(manifest.files) || actual.totalBytes !== manifest.totalBytes) fail('BACKUP_CHECKSUM', 'Backup contents do not match manifest');
  await validateContent(dataRoot, actual.files); return { ...manifest, source, dataRoot };
}
async function copyFiles(from, to, files) {
  await fs.mkdir(to, { recursive: true });
  for (const file of files) {
    const target = inside(to, file.path); await fs.mkdir(path.dirname(target), { recursive: true });
    const data = await fs.readFile(inside(from, file.path));
    if (sha(data) !== file.sha256) fail('SOURCE_CHANGED', 'Source changed while preparing maintenance copy');
    const handle = await fs.open(target, 'wx');
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  }
}
function maintenancePaths(root) {
  const parent = path.dirname(root), base = path.basename(root);
  return { parent, gate: path.join(parent, '.' + base + '.maintenance.lock'), journal: path.join(parent, '.' + base + '.restore-journal.json'), rollback: root + '.rollback' };
}
async function acquireGate(root) {
  const names = maintenancePaths(root); await noLinks(names.parent); await fs.mkdir(names.parent, { recursive: true });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(names.gate, 'wx'); await handle.writeFile(JSON.stringify({ pid: process.pid, token, root })); await handle.sync(); await handle.close();
      return { ...names, token };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const prior = await json(names.gate); let alive = true;
      try { process.kill(prior.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
      if (alive) fail('MEMORY_MAINTENANCE', 'Another maintenance operation is active');
      await fs.unlink(names.gate);
    }
  }
  fail('MEMORY_MAINTENANCE', 'Unable to acquire maintenance gate');
}
async function releaseGate(gate) {
  if (await exists(gate.gate) && (await json(gate.gate)).token === gate.token) await fs.unlink(gate.gate);
}
async function removeManaged(target, parent, predicate) {
  const absolute = await noLinks(target);
  if (!same(path.dirname(absolute), parent) || same(absolute, parent)) fail('UNSAFE_PATH', 'Cleanup target is outside intended parent');
  if (!await exists(absolute)) return;
  if (!await predicate(absolute)) fail('UNMANAGED_TARGET', 'Refusing to remove an unrecognized existing directory');
  await fs.rm(absolute, { recursive: true, force: true });
}
async function backupMarker(dir) {
  try { return (await json(path.join(dir, 'manifest.json'))).backupFormat === FORMAT; } catch { return false; }
}
async function candidateMarker(dir, root) {
  try { const marker = await json(path.join(dir, MARKER)); return marker.root === root && ['candidate', 'rollback'].includes(marker.kind); } catch { return false; }
}
async function offlineStore(root, token) {
  const store = new JsonStore(root);
  await store.open({ maintenanceToken: token, preflight: async reader => {
    const config = await reader.readJson('config.json'); if (!config) fail('INVALID_MEMORY', 'Memory config is missing');
    validateConfig(config);
  } }); return store;
}
async function carryRevocations(currentRoot, candidate, maxBytes) {
  const current = await json(path.join(currentRoot, 'meta', 'state.json'));
  const ids = new Set(current.revokedIds ?? []), roots = new Set(current.revokedSources ?? []);
  if (!ids.size && !roots.size) return;
  const candidateMeta = await json(path.join(candidate, 'meta', 'state.json'));
  candidateMeta.revokedIds = [...new Set([...(candidateMeta.revokedIds ?? []), ...ids])];
  candidateMeta.revokedSources = [...new Set([...(candidateMeta.revokedSources ?? []), ...roots])];
  candidateMeta.invalidatedHotContextGroups = [...new Map([...(candidateMeta.invalidatedHotContextGroups ?? []), ...(current.invalidatedHotContextGroups ?? [])]
    .map(group => [JSON.stringify([group.sourceSessionId, group.contextGroupId]), group])).values()].slice(-256);
  const revokedEvents = new Set(Object.entries(candidateMeta.sources ?? {}).filter(([key]) => roots.has(key)).map(([, source]) => source.eventId));
  const forbidden = (value) => Boolean(value && typeof value === 'object' &&
    (ids.has(value.id) || (value.sourceSessionId && value.sourceEventId && roots.has(JSON.stringify([value.sourceSessionId, value.sourceEventId]))) ||
    value.srcRefs?.some((ref) => roots.has(JSON.stringify([ref.sourceSessionId, ref.sourceEventId])))));
  const walk = (value, key = '') => {
    if (!value || typeof value !== 'object') return value;
    if (forbidden(value)) {
      if (key === 'anchor') return { text: '', changedAt: Date.now(), srcRefs: [] };
      if (key === 'currentDecision') return null;
      return undefined;
    }
    if (Array.isArray(value)) return value.map((entry) => walk(entry)).filter((entry) => entry !== undefined);
    const next = {}; for (const [childKey, item] of Object.entries(value)) {
      const transformed = childKey === 'pendingEventIds' && Array.isArray(item) ? item.filter((id) => !revokedEvents.has(id)) : walk(item, childKey);
      if (transformed !== undefined) next[childKey] = transformed;
    }
    return next;
  };
  for (const file of (await scan(candidate, maxBytes)).files) {
    if (file.path.startsWith('.wal/') || file.path === 'meta/state.json') continue;
    if (file.path.startsWith('journal/runs/')) {
      const run = await json(inside(candidate, file.path)); delete run.input; delete run.candidatePatch; delete run.validationError; delete run.attemptRecordedAt; delete run.reviewState; delete run.progressUpdatedAt; run.validatedPatch = [];
      if (run.status !== 'committed') run.status = 'failed';
      await syncWrite(inside(candidate, file.path), run); continue;
    }
    if (file.path === 'self/history.json') { await syncWrite(inside(candidate, file.path), { schemaVersion: SCHEMA_VERSION, versions: [] }); continue; }
    if (file.path === 'global/snapshots.jsonl') { await syncWrite(inside(candidate, file.path), ''); continue; }
    const raw = await fs.readFile(inside(candidate, file.path), 'utf8');
    if (file.path.endsWith('.jsonl')) {
      const rows = raw.split(/\r?\n/).filter(Boolean).map(JSON.parse).map((value) => walk(value)).filter((value) => value !== undefined);
      await syncWrite(inside(candidate, file.path), rows.map((value) => JSON.stringify(value)).join('\n') + (rows.length ? '\n' : ''));
    } else {
      const value = walk(JSON.parse(raw));
      for (const [field, refs] of Object.entries(candidateMeta.lineage?.[file.path] ?? {})) if (refs.some((key) => roots.has(key))) {
        if (field === 'anchor' && value.anchor) value.anchor = { text: '', changedAt: Date.now(), srcRefs: [] };
        else if (field === 'axes') value.axes = {};
        else if (field === 'summary') value.summary = '';
        else if (field === 'coordinates') value.coordinates = {};
      }
      if (file.path === 'global/state.json') value.activeRunId = null;
      await syncWrite(inside(candidate, file.path), value);
    }
  }
  candidateMeta.pending = (candidateMeta.pending ?? []).filter((eventId) => !revokedEvents.has(eventId));
  await syncWrite(path.join(candidate, 'meta', 'state.json'), candidateMeta);
  const currentLog = path.join(currentRoot, 'global', 'revocations.jsonl');
  if (await exists(currentLog)) {
    const destination = path.join(candidate, 'global', 'revocations.jsonl');
    const rows = (await exists(destination) ? await fs.readFile(destination, 'utf8') : '').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const imported = (await fs.readFile(currentLog, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const combined = [...new Map([...rows, ...imported].map((record) => [record.id, record])).values()];
    await syncWrite(destination, combined.map((value) => JSON.stringify(value)).join('\n') + (combined.length ? '\n' : ''));
  }
}
async function sanitizeTemporaryDependencies(candidate, maxBytes) {
  const metaPath = path.join(candidate, 'meta', 'state.json'), meta = await json(metaPath);
  if (!(meta.revokedSources?.length || meta.revokedIds?.length || meta.invalidatedHotContextGroups?.length)) return;
  const files = (await scan(candidate, maxBytes)).files, hotFiles = new Map(), runs = [];
  for (const file of files) {
    if (/^(people\/[^/]+\/hot|staging\/hot)\.jsonl$/.test(file.path)) {
      const rows = (await fs.readFile(inside(candidate, file.path), 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
      hotFiles.set(file.path, rows);
    } else if (file.path.startsWith('journal/runs/')) { const run = await json(inside(candidate, file.path)); if (run.status === 'prepared') runs.push({ path: file.path, run }); }
  }
  const records = [...hotFiles.values()].flat();
  const plan = temporaryCleanupPlan([...records, ...runs.flatMap(({ run }) => run.input?.hot ?? [])], meta);
  const removed = new Set(plan.removedIds), invalidated = [];
  for (const [name, rows] of hotFiles) {
    const keep = rows.filter(row => !removed.has(row.id));
    if (keep.length !== rows.length) await syncWrite(inside(candidate, name), keep.map(row => JSON.stringify(row)).join('\n') + (keep.length ? '\n' : ''));
  }
  for (const { path: name, run } of runs) if (runReferencesRevocation(run, meta, plan.removedIds)) {
    run.status = 'failed'; run.invalidation = { reason: 'source_revoked' };
    delete run.input; delete run.candidatePatch; delete run.validationError; delete run.attemptRecordedAt; delete run.reviewState; delete run.progressUpdatedAt; run.validatedPatch = [];
    await syncWrite(inside(candidate, name), run); invalidated.push(run.runId);
  }
  const removedCurrent = records.filter(row => removed.has(row.id)).map(row => row.id);
  if (!removedCurrent.length && !invalidated.length) return;
  meta.invalidatedHotContextGroups = plan.contextGroups.slice(-256);
  meta.dependencyCleanups = [...(meta.dependencyCleanups ?? []), { at: Date.now(), reason: 'restore_revocation_cleanup', sourceSessionIds: plan.affectedSessions.slice(0, 64),
    removedHotIds: removedCurrent.slice(0, 128), removedHotCount: removedCurrent.length, invalidatedRunIds: invalidated.slice(0, 128) }].slice(-20);
  await syncWrite(metaPath, meta);
  if (invalidated.length) {
    const file = path.join(candidate, 'global', 'state.json'), state = await json(file);
    if (invalidated.includes(state.activeRunId)) state.activeRunId = null;
    if (invalidated.includes(state.sleep?.wakeRunId)) state.sleep.wakeRunId = null;
    state.version++; state.updatedAt = Date.now(); await syncWrite(file, state);
  }
}
export async function createBackup({ root, destination, maxBytes = DEFAULT_MAX, clock = Date.now, fault } = {}) {
  root = await noLinks(root); destination = await noLinks(destination); separate(root, destination);
  if (!await exists(root)) fail('INVALID_MEMORY', 'Backup source memory root does not exist');
  const gate = await acquireGate(root); let store, candidate;
  try {
    if (await exists(gate.journal)) fail('RESTORE_PENDING', 'Recover the previous restore before backup');
    store = await offlineStore(root, gate.token);
    const deployment = await store.readJson('config.json');
    maxBytes = Math.min(maxBytes, deployment.retention.backupMaxBytes);
    if (maxBytes <= 0) fail('BACKUP_CAPACITY', 'Deployment backupMaxBytes disables backup storage');
    const snapshot = await scan(root, maxBytes); await validateContent(root, snapshot.files);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    candidate = destination + '.candidate-' + randomUUID(); await fs.mkdir(candidate, { recursive: false });
    await syncWrite(path.join(candidate, MARKER), { schemaVersion: SCHEMA_VERSION, kind: 'candidate', root });
    await copyFiles(root, path.join(candidate, 'data'), snapshot.files);
    const manifest = { backupFormat: FORMAT, schemaVersion: SCHEMA_VERSION, createdAt: typeof clock === 'function' ? clock() : clock.now(), files: snapshot.files, totalBytes: snapshot.totalBytes };
    await syncWrite(path.join(candidate, 'manifest.json'), manifest); await validateBackup(candidate, { maxBytes }); await fault?.('backup_candidate_ready');
    const previous = destination + '.previous';
    if (await exists(destination)) {
      if (!await backupMarker(destination)) fail('UNMANAGED_TARGET', 'Backup destination is not a managed backup');
      await removeManaged(previous, path.dirname(destination), backupMarker); await fs.rename(destination, previous);
    }
    await fs.rename(candidate, destination); candidate = null;
    return { ...manifest, destination };
  } finally {
    await store?.close(); await releaseGate(gate);
    if (candidate && await exists(candidate)) await removeManaged(candidate, path.dirname(destination), async (dir) => await backupMarker(dir) || await candidateMarker(dir, root));
  }
}
async function fingerprint(root, maxBytes) { return sha(JSON.stringify((await scan(root, maxBytes)).files)); }
async function finishRestore(root, journal, gate, fault, maxBytes) {
  const { candidate, rollback, hadRoot, candidateHash, oldHash } = journal;
  if (await exists(root)) {
    const currentHash = await fingerprint(root, maxBytes);
    if (currentHash === candidateHash && (journal.phase === 'installed' || await candidateMarker(root, root))) {
      await fs.unlink(path.join(root, MARKER)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
      await fs.unlink(gate.journal); return { root, rollback: hadRoot ? rollback : null, recovered: true };
    }
    if (currentHash !== oldHash) fail('RESTORE_AMBIGUOUS', 'Current root changed after restore preparation; no directory was overwritten');
    if (await activeWriter(root)) fail('WRITER_LOCKED', 'A writer became active before root switch');
    await removeManaged(rollback, gate.parent, (dir) => candidateMarker(dir, root));
    await fs.rename(root, rollback);
    await syncWrite(path.join(rollback, MARKER), { schemaVersion: SCHEMA_VERSION, kind: 'rollback', root });
    journal.phase = 'root_moved'; await syncWrite(gate.journal, journal); await fault?.('after_root_moved');
  } else if (hadRoot && !await exists(rollback)) fail('RESTORE_AMBIGUOUS', 'Original root and rollback are both missing');
  if (!await exists(candidate) || (await fingerprint(candidate, maxBytes)) !== candidateHash) fail('BACKUP_CHECKSUM', 'Restore candidate changed');
  await fs.rename(candidate, root);
  journal.phase = 'installed'; await syncWrite(gate.journal, journal); await fault?.('after_candidate_installed');
  await validateContent(root, (await scan(root, maxBytes)).files);
  await fs.unlink(path.join(root, MARKER)); await fs.unlink(gate.journal);
  return { root, rollback: hadRoot ? rollback : null, recovered: journal.phase !== 'prepared' };
}
export async function restoreBackup({ root, source, maxBytes = DEFAULT_MAX, fault } = {}) {
  root = await noLinks(root); source = await noLinks(source); separate(root, source);
  const backup = await validateBackup(source, { maxBytes });
  const backupConfig = await json(path.join(backup.dataRoot, 'config.json'));
  let configuredLimit = backupConfig.retention.backupMaxBytes;
  if (await exists(path.join(root, 'config.json'))) {
    const deployment = await json(path.join(root, 'config.json')); validateConfig(deployment);
    configuredLimit = Math.min(configuredLimit, deployment.retention.backupMaxBytes);
  }
  maxBytes = Math.min(maxBytes, configuredLimit);
  if (maxBytes <= 0 || backup.totalBytes > maxBytes) fail('BACKUP_CAPACITY', 'Backup exceeds the deployment backupMaxBytes limit');
  const gate = await acquireGate(root); let candidate = null, journalWritten = false, store;
  try {
    if (await exists(gate.journal)) fail('RESTORE_PENDING', 'Recover the previous restore first');
    const hadRoot = await exists(root);
    if (hadRoot) { store = await offlineStore(root, gate.token); await store.close(); store = null; }
    const oldHash = hadRoot ? await fingerprint(root, maxBytes) : null;
    candidate = root + '.candidate-' + randomUUID(); await fs.mkdir(candidate);
    await syncWrite(path.join(candidate, MARKER), { schemaVersion: SCHEMA_VERSION, kind: 'candidate', root });
    await copyFiles(backup.dataRoot, candidate, backup.files);
    if (hadRoot) await carryRevocations(root, candidate, maxBytes);
    await sanitizeTemporaryDependencies(candidate, maxBytes);
    // A historical queued send may already have occurred after the backup. Require reconciliation.
    const outbox = path.join(candidate, 'global', 'outbox.jsonl');
    if (await exists(outbox)) {
      const rows = (await fs.readFile(outbox, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse).map((record) =>
        ['pending', 'submitted'].includes(record.status) ? { ...record, status: 'unknown', restoreRequiresReconciliation: true } : record);
      await syncWrite(outbox, rows.map((record) => JSON.stringify(record)).join('\n') + (rows.length ? '\n' : ''));
    }
    await syncWrite(path.join(candidate, MARKER), { schemaVersion: SCHEMA_VERSION, kind: 'candidate', root });
    await validateContent(candidate, (await scan(candidate, maxBytes)).files);
    const candidateHash = await fingerprint(candidate, maxBytes);
    const journal = { schemaVersion: SCHEMA_VERSION, root, candidate, rollback: gate.rollback, hadRoot, oldHash, candidateHash, maxBytes, phase: 'prepared' };
    await syncWrite(gate.journal, journal); journalWritten = true; await fault?.('after_restore_prepared');
    return await finishRestore(root, journal, gate, fault, maxBytes);
  } finally {
    await store?.close(); await releaseGate(gate);
    if (!journalWritten && candidate && await exists(candidate)) await removeManaged(candidate, gate.parent, (dir) => candidateMarker(dir, root));
  }
}
export async function recoverRestore({ root, maxBytes = DEFAULT_MAX, fault } = {}) {
  root = await noLinks(root); const gate = await acquireGate(root);
  try {
    if (!await exists(gate.journal)) return { root, recovered: false, status: 'no_pending_restore' };
    const journal = await json(gate.journal);
    if (journal.schemaVersion !== SCHEMA_VERSION || !same(journal.root, root) || !same(journal.rollback, gate.rollback) ||
      !same(path.dirname(journal.candidate), gate.parent) || !path.basename(journal.candidate).startsWith(path.basename(root) + '.candidate-')) fail('INVALID_RESTORE_JOURNAL', 'Restore journal paths are invalid');
    await noLinks(journal.candidate); await noLinks(journal.rollback);
    maxBytes = Math.min(maxBytes, journal.maxBytes ?? DEFAULT_MAX);
    return await finishRestore(root, journal, gate, fault, maxBytes);
  } finally { await releaseGate(gate); }
}
export const exportMemory = createBackup;
export const importMemory = restoreBackup;
