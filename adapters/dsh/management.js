import { createHash, randomUUID } from 'node:crypto';
import { defaultConfig, mergeConfig, validateConfig } from '../../core/schema.js';

const MAX_RESPONSE = 131072, DETAIL_CHARS = 16000, OPS_PATH = 'ops/management.json', OPS_BYTES = 262144;
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const points = value => Array.from(String(value ?? ''));
const short = (value, size = 240) => points(value).slice(0, size).join('');
const error = (code, message) => Object.assign(new Error(message), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireObject = value => { if (!object(value)) throw error('BAD_MANAGEMENT_REQUEST', 'An object is required'); return value; };
const boundedString = (value, name, maximum = 512) => {
  if (typeof value !== 'string' || !value || points(value).length > maximum) throw error('BAD_MANAGEMENT_REQUEST', `${name} must be a bounded nonempty string`);
  return value;
};
const optionalPerson = args => args.personId ?? args.targetPersonId ?? null;
const selection = args => Object.fromEntries(Object.entries(args).filter(([key]) => !['cursor', 'pageSize', 'pageChars'].includes(key)));
function decodeCursor(cursor, action, fingerprint) {
  if (cursor === undefined || cursor === null) return 0;
  if (typeof cursor !== 'string' || cursor.length > 2048) throw error('INVALID_MANAGEMENT_CURSOR', 'Invalid result cursor');
  let value; try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw error('INVALID_MANAGEMENT_CURSOR', 'Invalid result cursor'); }
  if (value.v !== 1 || value.action !== action || value.fingerprint !== fingerprint || !Number.isSafeInteger(value.offset) || value.offset < 0) throw error('MANAGEMENT_CURSOR_STALE', 'The result or selection changed; reload this view');
  return value.offset;
}
const encodeCursor = (action, fingerprint, offset) => Buffer.from(JSON.stringify({ v: 1, action, fingerprint, offset })).toString('base64url');
function pageList(action, args, rows, revision = hash(rows)) {
  const size = args.pageSize ?? 30;
  if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw error('BAD_MANAGEMENT_REQUEST', 'pageSize must be 1..100');
  const fingerprint = hash({ selection: selection(args), revision }), from = decodeCursor(args.cursor, action, fingerprint);
  if (from > rows.length) throw error('INVALID_MANAGEMENT_CURSOR', 'Cursor exceeds this result');
  const items = rows.slice(from, from + size);
  while (items.length > 1 && Buffer.byteLength(JSON.stringify(items)) > MAX_RESPONSE - 2048) items.pop();
  const to = from + items.length;
  return { items, total: rows.length, offset: from, pageSize: size, revision, nextCursor: to < rows.length ? encodeCursor(action, fingerprint, to) : null };
}
function pageDetail(action, args, value) {
  const json = JSON.stringify(value, null, 2), characters = points(json), size = args.pageChars ?? DETAIL_CHARS;
  if (!Number.isSafeInteger(size) || size < 1 || size > DETAIL_CHARS) throw error('BAD_MANAGEMENT_REQUEST', 'pageChars must be 1..16000');
  const revision = hash(json), fingerprint = hash({ selection: selection(args), revision }), from = decodeCursor(args.cursor, action, fingerprint);
  if (from > characters.length) throw error('INVALID_MANAGEMENT_CURSOR', 'Cursor exceeds this detail');
  const to = Math.min(characters.length, from + size);
  return { format: 'json_text_fragment', text: characters.slice(from, to).join(''), revision,
    fragment: { from, to, total: characters.length, complete: to === characters.length }, nextCursor: to < characters.length ? encodeCursor(action, fingerprint, to) : null };
}
function memorySummary(row) {
  return { id: row.id, recordType: row.recordType, personId: row.personId ?? null, scope: row.scope ?? null,
    role: row.role ?? null, speakerId: row.speakerId ?? null, createdAt: row.createdAt ?? row.sourceAt ?? null, updatedAt: row.updatedAt ?? null,
    title: row.title ?? null, reference: row.reference == null ? null : short(row.reference), textPreview: short(row.text ?? row.reference ?? row.experience ?? row.meaning ?? row.desc ?? row.label ?? row.if ?? ''), chars: row.chars ?? points(row.text ?? '').length,
    sourceCount: row.srcRefs?.length ?? (row.sourceEventId ? 1 : 0), sourceSessionId: row.sourceSessionId ?? null, sourceEventId: row.sourceEventId ?? null };
}
function runSummary(run) {
  return { kind: 'run', id: run.runId, runId: run.runId, status: run.status, personId: run.personId ?? null,
    commitMarker: run.commitMarker ?? null, inputEndEventId: run.inputEndEventId, modelCalls: run.reviewState?.modelCalls ?? 0,
    pauseReason: run.reviewState?.pauseReason ?? run.validationError?.code ?? null, progressUpdatedAt: run.progressUpdatedAt ?? null,
    patchCount: run.validatedPatch?.length ?? 0, candidateCount: run.candidatePatch?.entries?.length ?? run.candidatePatch?.length ?? 0 };
}
function jobSummary(job) {
  return { kind: 'job', id: job.jobId, jobId: job.jobId, status: job.status, createdAt: job.createdAt, targets: job.targets,
    children: (job.children ?? []).map(child => ({ runId: child.runId, personId: child.personId, status: child.status, modelCalls: child.modelCalls ?? 0 })),
    error: job.error ? { code: job.error.code, message: short(job.error.message, 600) } : null };
}
function decisionSummary(decision) {
  if (!decision) return null;
  const plan = value => value ? { action: value.action, reason: short(value.reason, 400), target: value.target ?? null,
    wakeCondition: value.wakeCondition ?? null, wakeAt: value.wakeAt ?? null, replyAt: value.replyAt ?? null } : null;
  return { decisionId: decision.decisionId, decidedAt: decision.decidedAt, nextCheckAt: decision.nextCheckAt ?? null,
    identityPlan: decision.identityPlan ? { action: decision.identityPlan.action, personId: decision.identityPlan.personId ?? null } : null,
    replyPlan: plan(decision.replyPlan), sleepPlan: plan(decision.sleepPlan), consolidationPlan: plan(decision.consolidationPlan) };
}
function safeConfig(config) {
  const defaults = defaultConfig(), result = {};
  for (const key of Object.keys(defaults)) {
    if (object(defaults[key])) result[key] = Object.fromEntries(Object.keys(defaults[key]).map(child => [child, config[key]?.[child] ?? defaults[key][child]]));
    else result[key] = config[key] ?? defaults[key];
  }
  return result;
}
function configPatch(value, current) {
  const partial = requireObject(value), shape = defaultConfig();
  for (const [key, item] of Object.entries(partial)) {
    if (key === 'schemaVersion' || !Object.hasOwn(shape, key)) throw error('BAD_MANAGEMENT_CONFIG', 'Only documented technical configuration may be changed');
    if (object(shape[key])) {
      requireObject(item);
      for (const child of Object.keys(item)) if (!Object.hasOwn(shape[key], child)) throw error('BAD_MANAGEMENT_CONFIG', `Unknown configuration field ${key}.${child}`);
    }
  }
  validateConfig(mergeConfig(current, partial));
  return structuredClone(partial);
}
function operationResult(result) {
  if (result == null || typeof result !== 'object') return { value: result ?? null };
  return { committed: result.committed ?? null, duplicate: result.duplicate ?? null, status: result.status ?? null,
    runId: result.run?.runId ?? result.runId ?? null, jobId: result.jobId ?? null, pauseReason: result.pauseReason ?? null,
    modelCalls: result.modelCalls ?? result.run?.reviewState?.modelCalls ?? null,
    message: short(result.message ?? '', 600), resultCount: Array.isArray(result) ? result.length : null };
}

/** Local, authenticated DSH operator surface. It does not change personality policy. */
export function createManagementService({ getCoordinator, listInstances, lifecycle = {}, maintenance = {}, clock = Date.now } = {}) {
  if (typeof getCoordinator !== 'function') throw new TypeError('getCoordinator is required');
  const initialized = new WeakSet(), active = new Map(); let operationQueue = Promise.resolve();
  const serializeOps = callback => { const task = operationQueue.then(callback); operationQueue = task.catch(() => {}); return task; };
  const instanceList = async () => typeof listInstances === 'function' ? listInstances() : { items: [], activeInstanceId: null };
  async function coordinator(args, optional = false) {
    const value = await getCoordinator(args.instanceId);
    if (!value) { if (optional) return null; throw error('PERSONA_NOT_LOADED', 'Load a personality instance before this operation'); }
    await value.ready;
    if (value.initializationError && !optional) throw value.initializationError;
    return value;
  }
  async function command(c, name, args) {
    if (typeof c.executeCommand !== 'function') throw error('MANAGEMENT_CONTROL_UNAVAILABLE', 'The coordinator control port is unavailable');
    return c.executeCommand(name, args);
  }
  async function operationDocument(c) {
    const doc = await c.repository.store.readJson(OPS_PATH, { version: 0, records: [] });
    if (!initialized.has(c)) {
      const unfinished = doc.records.filter(row => ['queued', 'running'].includes(row.status));
      for (const row of unfinished) { row.status = 'unknown'; row.updatedAt = clock(); row.error = { code: 'OPERATION_OUTCOME_UNKNOWN', message: 'The prior process ended before the outcome was recorded; this request was not replayed.' }; }
      if (unfinished.length) await saveOperations(c, doc);
      initialized.add(c);
    }
    return doc;
  }
  async function saveOperations(c, doc) {
    const terminal = new Set(['completed', 'failed', 'unknown']);
    const finished = doc.records.filter(row => terminal.has(row.status));
    const remove = new Set(finished.slice(0, Math.max(0, finished.length - 50)).map(row => row.id));
    doc.records = doc.records.filter(row => !remove.has(row.id));
    if (Buffer.byteLength(JSON.stringify(doc)) > OPS_BYTES) throw error('MANAGEMENT_OPERATION_CAPACITY', 'Operation receipts reached their bounded storage capacity');
    const previous = doc.version ?? 0; doc.version = previous + 1;
    await c.repository.store.transaction({ json: { [OPS_PATH]: doc }, expectedVersions: { [OPS_PATH]: previous } });
  }
  async function startOperation(c, args) {
    const action = args.action;
    if (!['control.consolidate', 'control.backfill'].includes(action)) throw error('BAD_MANAGEMENT_REQUEST', 'Only consolidation and backfill use background operation receipts');
    const input = requireObject(args.args ?? {}), allowed = action === 'control.consolidate' ? ['personId', 'runId'] : ['sessionId'];
    for (const key of Object.keys(input)) if (!allowed.includes(key)) throw error('BAD_MANAGEMENT_REQUEST', 'Unsupported background operation argument');
    for (const value of Object.values(input)) if (value !== null) boundedString(value, 'operation argument', 200);
    const id = args.requestId ?? randomUUID(); boundedString(id, 'requestId', 100);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw error('BAD_MANAGEMENT_REQUEST', 'requestId must be a stable identifier');
    const receipt = await serializeOps(async () => {
      const doc = await operationDocument(c), previous = doc.records.find(row => row.id === id);
      if (previous) { if (previous.action !== action || hash(previous.args) !== hash(input)) throw error('OPERATION_ID_REUSED', 'This request ID belongs to different operation arguments'); return { previous: true, value: structuredClone(previous) }; }
      if (doc.records.filter(row => ['queued', 'running'].includes(row.status)).length >= (c.repository.config.processingLimits?.maxQueuedConsolidations ?? 8)) throw error('MANAGEMENT_OPERATION_CAPACITY', 'The bounded management work queue is full');
      const row = { id, action, args: structuredClone(input), status: 'queued', createdAt: clock(), updatedAt: clock() }; doc.records.push(row); await saveOperations(c, doc);
      return { previous: false, value: structuredClone(row) };
    });
    if (!receipt.previous) {
      const key = c;
      const pending = (async () => {
        await serializeOps(async () => { const doc = await operationDocument(c), row = doc.records.find(row => row.id === id); row.status = 'running'; row.updatedAt = clock(); await saveOperations(c, doc); });
        let result, failure;
        try { result = await command(c, action.slice(8), input); } catch (cause) { failure = { code: cause.code ?? 'OPERATION_FAILED', message: short(cause.message, 600) }; }
        await serializeOps(async () => { const doc = await operationDocument(c), row = doc.records.find(row => row.id === id); row.status = failure ? 'failed' : 'completed'; row.updatedAt = clock(); if (failure) row.error = failure; else row.result = operationResult(result); await saveOperations(c, doc); });
      })();
      const set = active.get(key) ?? new Set(); set.add(pending); active.set(key, set);
      pending.catch(cause => c.errors?.push?.({ at: clock(), code: cause.code ?? 'MANAGEMENT_RECEIPT_ERROR', message: short(cause.message, 600) })).finally(() => { set.delete(pending); if (!set.size) active.delete(key); });
    }
    return receipt.value;
  }
  async function perform(action, args) {
    if (action === 'instances.list') return instanceList();
    if (action.startsWith('instances.') && ['load', 'unload', 'select'].includes(action.slice(10))) {
      const method = lifecycle[action.slice(10)]; if (!method) throw error('MANAGEMENT_LIFECYCLE_UNAVAILABLE', 'Instance lifecycle port unavailable'); return method(args);
    }
    if (action.startsWith('maintenance.') && ['validate', 'backup', 'restore', 'recover'].includes(action.slice(12))) {
      const method = maintenance[action.slice(12)]; if (!method) throw error('MANAGEMENT_MAINTENANCE_UNAVAILABLE', 'Maintenance port unavailable'); return method(args);
    }
    const c = await coordinator(args, action === 'status');
    if (action === 'status') {
      const instances = await instanceList();
      if (!c) return { available: false, unloaded: true, instances, instanceId: args.instanceId ?? instances.activeInstanceId ?? null, runtime: null, capacity: null, agents: [], errors: [] };
      if (c.initializationError) return { available: false, instances, memoryRoot: c.memoryRoot, errors: [{ code: c.initializationError.code ?? 'INITIALIZATION_FAILED', message: short(c.initializationError.message, 600) }] };
      const state = await c.repository.getRuntime(), capacity = await c.repository.getCapacity(), jobs = Object.values(state.execution?.consolidationJobs ?? {});
      const counts = {}; for (const job of jobs) counts[job.status] = (counts[job.status] ?? 0) + 1;
      return { available: true, instances, instanceId: args.instanceId ?? instances.activeInstanceId ?? null, memoryRoot: c.memoryRoot,
        runtime: { version: state.version, updatedAt: state.updatedAt, globalMuted: state.globalMuted, sleep: state.sleep, schedule: state.schedule,
          activeRunId: state.activeRunId ?? null, currentDecision: decisionSummary(state.currentDecision), pendingControl: Boolean(state.execution?.pendingControl), pendingWake: Boolean(state.execution?.pendingWake),
          jobCounts: counts, memoryGapCounts: { total: state.memoryGaps?.length ?? 0, unresolved: state.memoryGaps?.filter(row => !row.resolvedAt).length ?? 0 } },
        capacity, config: safeConfig(c.repository.config), agents: [...(c.agents?.values() ?? [])].slice(0, 100).map(item => {
          const agent = item.agent ?? item, context = c.contextFor?.(agent) ?? {}; return { sessionId: agent.session?.id ?? agent.id, personId: context.personId ?? null, channelId: context.channelId ?? null };
        }), errors: (c.errors ?? []).slice(-20).map(row => ({ at: row.at, code: row.code, message: short(row.message, 600) })) };
    }
    const repo = c.repository;
    if (action === 'config.get') return safeConfig(repo.config);
    if (action === 'config.update') return safeConfig(await command(c, 'config', configPatch(args.config ?? args.partial ?? {}, repo.config)));
    if (action === 'state.get') return pageDetail(action, args, await repo.getRuntime());
    if (action === 'people.list') {
      const needle = String(args.query ?? '').toLocaleLowerCase(), people = (await repo.listPeople()).filter(row => !needle || JSON.stringify(row).toLocaleLowerCase().includes(needle));
      return pageList(action, args, people.map(row => ({ id: row.personId, personId: row.personId, displayName: short(row.displayName, 160), aliases: (row.aliases ?? []).slice(0, 10).map(value => short(value, 80)), updatedAt: row.updatedAt })));
    }
    if (action === 'persona.get') {
      if (args.section === 'deep') return pageDetail(action, args, await repo.introspect({ section: 'deep' }));
      const persona = await repo.getPersona(), section = args.section ?? 'all';
      if (!['all', 'anchor', 'axes', 'facets', 'signatures', 'habits', 'retired'].includes(section)) throw error('BAD_MANAGEMENT_REQUEST', 'Unknown persona section');
      return pageDetail(action, args, section === 'all' ? persona : { version: persona.version, section, value: persona[section] });
    }
    if (action === 'relation.get') {
      const personId = optionalPerson(args), section = args.section ?? 'all';
      if (personId !== null && !(await repo.listPeople()).some(row => row.personId === personId)) throw error('UNKNOWN_PERSON_TARGET', 'Selected person does not exist');
      if (!['all', 'impression', 'codes', 'interpretations', 'state'].includes(section)) throw error('BAD_MANAGEMENT_REQUEST', 'Unknown relationship section');
      const context = await repo.getContext({ personId }), value = section === 'all' ? { identity: context.identity, impression: context.impression, codes: context.codes, interpretations: context.interpretations } : context[section];
      return pageDetail(action, args, value);
    }
    if (action === 'memory.list') {
      const size = args.pageSize ?? 30; if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw error('BAD_MANAGEMENT_REQUEST', 'pageSize must be 1..100');
      let offset = 0, cursor;
      if (args.cursor) { try { cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8')); offset = cursor.offset; } catch { throw error('INVALID_MANAGEMENT_CURSOR', 'Invalid memory cursor'); } }
      const result = await repo.browseMemory({ query: args.query ?? '', scope: args.scope ?? 'all', targetPersonId: optionalPerson(args), recordType: args.recordType || null, offset, limit: size });
      const fingerprint = hash({ selection: selection(args), revision: result.revision }); decodeCursor(args.cursor, action, fingerprint);
      return { items: result.items.map(memorySummary), total: result.total, offset: result.offset, pageSize: size, revision: result.revision, nextCursor: result.nextOffset === null ? null : encodeCursor(action, fingerprint, result.nextOffset) };
    }
    if (action === 'memory.detail') { const row = await repo.getMemoryRecord(boundedString(args.id, 'id', 200)); if (!row) throw error('MEMORY_UNAVAILABLE', 'The selected record is no longer retained'); return pageDetail(action, args, row); }
    if (action === 'sources.read') {
      const refs = args.sourceRefs ?? [], ids = args.eventIds ?? [];
      if (!Array.isArray(refs) || refs.length > 50 || !Array.isArray(ids) || ids.length > 50) throw error('BAD_MANAGEMENT_REQUEST', 'Select at most 50 source roots');
      return pageDetail(action, args, await repo.readSources({ sourceRefs: refs, eventIds: ids }));
    }
    if (action === 'jobs.list') {
      const state = await repo.getRuntime(), jobs = Object.values(state.execution?.consolidationJobs ?? {}).map(jobSummary), runs = (await repo.listConsolidationRuns()).map(runSummary);
      const rows = [...jobs, ...runs].filter(row => !args.status || row.status === args.status).sort((a, b) => (b.createdAt ?? b.progressUpdatedAt ?? 0) - (a.createdAt ?? a.progressUpdatedAt ?? 0)); return pageList(action, args, rows);
    }
    if (action === 'jobs.detail') {
      let value;
      if (args.runId) value = await repo.getConsolidationRun(boundedString(args.runId, 'runId', 200));
      else if (args.jobId) value = (await repo.getRuntime()).execution?.consolidationJobs?.[boundedString(args.jobId, 'jobId', 200)];
      else throw error('BAD_MANAGEMENT_REQUEST', 'Select runId or jobId');
      if (!value) throw error('MANAGEMENT_JOB_UNAVAILABLE', 'This bounded job record is no longer retained'); return pageDetail(action, args, value);
    }
    if (action === 'history.list') {
      const rows = await repo.getPersonaHistory(), current = await repo.getPersona();
      return pageList(action, args, [...rows.map(row => ({ version: row.version, updatedAt: row.updatedAt, anchorPreview: short(row.anchor?.text), current: false })), { version: current.version, updatedAt: current.updatedAt, anchorPreview: short(current.anchor?.text), current: true }].sort((a, b) => b.version - a.version));
    }
    if (action === 'history.diff') {
      const history = [...await repo.getPersonaHistory(), await repo.getPersona()];
      const from = history.find(row => row.version === args.fromVersion), to = history.find(row => row.version === (args.toVersion ?? history.at(-1).version));
      if (!from || !to) throw error('VERSION_UNAVAILABLE', 'Select versions still present in bounded personality history');
      const changes = [];
      for (const key of ['anchor', 'axes', 'facets', 'signatures', 'habits', 'retired']) if (hash(from[key]) !== hash(to[key])) changes.push({ field: key, before: from[key], after: to[key] });
      return pageDetail(action, args, { fromVersion: from.version, toVersion: to.version, changes, scope: 'Retained common-personality versions only; other document changes are visible in retained consolidation patches.' });
    }
    if (action === 'diagnostics.list') {
      const kind = args.kind ?? 'usage'; let rows;
      if (kind === 'usage') rows = await repo.getUsage(); else if (kind === 'snapshots') rows = await repo.getSnapshots(); else if (kind === 'outbox') rows = await repo.getOutbox();
      else if (kind === 'errors') rows = c.errors ?? []; else if (kind === 'gaps') rows = (await repo.getRuntime()).memoryGaps ?? [];
      else throw error('BAD_MANAGEMENT_REQUEST', 'Unknown diagnostic kind');
      return pageList(action, args, rows.map((row, index) => ({ id: row.id ?? row.requestId ?? row.deliveryId ?? `${kind}_${index}`, kind, at: row.at ?? row.createdAt ?? row.startedAt ?? row.now ?? null,
        summary: short(JSON.stringify(row), 1600) })).reverse(), hash(rows));
    }
    if (action === 'operations.start') return startOperation(c, args);
    if (action === 'operations.get') return serializeOps(async () => { const row = (await operationDocument(c)).records.find(row => row.id === boundedString(args.id, 'id', 100)); if (!row) throw error('OPERATION_UNAVAILABLE', 'Operation receipt is no longer retained'); return structuredClone(row); });
    if (action === 'operations.list') return serializeOps(async () => pageList(action, args, [...(await operationDocument(c)).records].reverse()));
    if (action === 'memory.forget') {
      if (args.scope !== undefined && !['person', 'unknown', 'global'].includes(args.scope)) throw error('BAD_MANAGEMENT_REQUEST', 'Choose a person, unknown or global deletion scope');
      const ids = args.ids ?? (args.id ? [args.id] : []);
      if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !id || id.length > 200)) throw error('BAD_MANAGEMENT_REQUEST', 'Select at most 100 record IDs');
      if (!ids.length && args.before === undefined) throw error('MEMORY_SELECTION_REQUIRED', 'Select records or an explicit before time');
      const result = await command(c, 'forget', { ids, targetPersonId: args.targetPersonId, scope: args.scope, before: args.before, reason: short(args.reason, 2000), action: args.action ?? 'forget', replacementIds: args.replacementIds ?? [] });
      if (result.needsTarget) throw error('MEMORY_TARGET_REQUIRED', 'Select the relationship target or an explicit unknown/global record scope');
      if (result.needsSelection) throw error('MEMORY_SELECTION_REQUIRED', 'Select the records to forget');
      return { revocation: result.revocation ? { id: result.revocation.id, eventId: result.revocation.eventId, personId: result.revocation.personId, scope: result.revocation.scope ?? 'person', action: result.revocation.action } : null,
        affectedIds: (result.affectedIds ?? []).slice(0, 100), affectedCount: result.affectedIds?.length ?? 0, affectedIdsComplete: (result.affectedIds?.length ?? 0) <= 100 };
    }
    if (action === 'memory.assign') {
      const result = await command(c, 'assign', { sourceSessionId: boundedString(args.sourceSessionId, 'sourceSessionId'), sourceEventId: boundedString(args.sourceEventId, 'sourceEventId'), personId: boundedString(args.personId, 'personId', 200), reason: short(args.reason, 2000) });
      return { assignmentId: result.assignment?.id ?? null, duplicate: result.duplicate ?? false, record: result.record ? memorySummary(result.record) : null };
    }
    if (action === 'persona.rollback') { if (!Number.isSafeInteger(args.version) || args.version < 0) throw error('BAD_MANAGEMENT_REQUEST', 'Select a retained version'); return operationResult(await command(c, 'rollback', { version: args.version })); }
    if (action.startsWith('control.') && ['wake', 'mute', 'resume', 'consolidate', 'backfill'].includes(action.slice(8))) {
      if (['control.consolidate', 'control.backfill'].includes(action)) throw error('USE_OPERATION_RECEIPT', 'Use operations.start for a visible durable long-operation receipt');
      return operationResult(await command(c, action.slice(8), {}));
    }
    throw error('UNKNOWN_MANAGEMENT_ACTION', 'Unknown management operation');
  }
  return {
    async dispatch(action, args = {}) {
      if (typeof action !== 'string' || action.length > 80) throw error('BAD_MANAGEMENT_REQUEST', 'A known management action is required');
      requireObject(args); let input; try { input = JSON.stringify(args, (_key, value) => { if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Nonfinite JSON'); return value; }); } catch { throw error('BAD_MANAGEMENT_REQUEST', 'Request must be finite JSON'); }
      if (Buffer.byteLength(input) > 65536) throw error('BAD_MANAGEMENT_REQUEST', 'Management request exceeds 64 KiB');
      const result = await perform(action, args);
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESPONSE) throw error('MANAGEMENT_RESPONSE_CAPACITY', 'The management result exceeded its response budget; select a narrower page');
      return result;
    },
    async hasActiveOperations(instanceId) { const c = await getCoordinator(instanceId); return Boolean(c && active.get(c)?.size); },
  };
}
