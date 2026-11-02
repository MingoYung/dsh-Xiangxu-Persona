// Optional, test-controller-only budget. No production/personality dependency.
import {open, readFile, rename, unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

const failure = (code, message) => Object.assign(new Error(message), {code});
export const validTokenTotal = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const optionalLimit = value => value === null || positive(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;

export function createWholeBudgetState({attempts, tokens, wallMs, startCumulative = null, now = Date.now()}) {
  if (!optionalLimit(attempts) || !positive(tokens) || !optionalLimit(wallMs) || !timestamp(now))
    throw failure('WHOLE_PARAMS_INVALID', 'Token limit must be positive; attempt/time limits must be positive or explicit null');
  return {schema: attempts === null || wallMs === null ? 2 : 1, wholeAttemptsCap: attempts, wholeTokensCap: tokens, wholeWallMs: wallMs,
    wholeAttemptsUsed: 0, wholeTokensUsed: 0, wholeUsageAttempts: 0, wholePendingUnknown: 0,
    wholeFirstRequestAt: null, wholeDeadline: null, createdAt: now, startCumulative, requests: {}};
}

function totals(state) {
  const rows = Object.entries(state.requests);
  let tokens = 0, known = 0, first = null;
  for (const [id, row] of rows) {
    if (!row || row.requestId !== id || !timestamp(row.startedAt) ||
      !(row.totalTokens === null || validTokenTotal(row.totalTokens)))
      throw failure('WHOLE_STATE_INVALID', 'Invalid request reservation or usage');
    first = first === null ? row.startedAt : Math.min(first, row.startedAt);
    if (row.totalTokens !== null) { known++; tokens += row.totalTokens; }
  }
  if (!validTokenTotal(tokens)) throw failure('WHOLE_STATE_INVALID', 'Token sum is not a safe integer');
  return {attempts: rows.length, tokens, known, unknown: rows.length - known, first};
}

export function validateWholeBudgetState(state) {
  if (!state || ![1, 2].includes(state.schema) ||
    !(state.schema === 2 ? optionalLimit(state.wholeAttemptsCap) : positive(state.wholeAttemptsCap)) ||
    !positive(state.wholeTokensCap) || !(state.schema === 2 ? optionalLimit(state.wholeWallMs) : positive(state.wholeWallMs)) || !timestamp(state.createdAt) ||
    !state.requests || typeof state.requests !== 'object' || Array.isArray(state.requests))
    throw failure('WHOLE_STATE_INVALID', 'Missing or invalid whole budget state');
  const t = totals(state);
  if (state.wholeAttemptsUsed !== t.attempts || state.wholeTokensUsed !== t.tokens ||
    state.wholeUsageAttempts !== t.known || state.wholePendingUnknown !== t.unknown ||
    state.wholeFirstRequestAt !== t.first ||
    state.wholeDeadline !== (t.first === null || state.wholeWallMs === null ? null : t.first + state.wholeWallMs) ||
    (state.wholeDeadline !== null && !timestamp(state.wholeDeadline)))
    throw failure('WHOLE_STATE_INVALID', 'Whole counters or deadline disagree with reservations');
  return state;
}

function refresh(state) {
  const t = totals(state);
  Object.assign(state, {wholeAttemptsUsed: t.attempts, wholeTokensUsed: t.tokens,
    wholeUsageAttempts: t.known, wholePendingUnknown: t.unknown, wholeFirstRequestAt: t.first,
    wholeDeadline: t.first === null || state.wholeWallMs === null ? null : t.first + state.wholeWallMs});
  return validateWholeBudgetState(state);
}

export async function readWholeBudget(file, {allowMissing = false} = {}) {
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' && allowMissing) return null;
    throw failure(error.code === 'ENOENT' ? 'WHOLE_STATE_MISSING' : 'WHOLE_STATE_UNREADABLE', 'Cannot read whole budget');
  }
  let state;
  try { state = JSON.parse(raw); }
  catch { throw failure('WHOLE_STATE_INVALID', 'Whole budget JSON is invalid; dispatch blocked'); }
  return validateWholeBudgetState(state);
}

async function atomicWrite(file, value) {
  const temp = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  let handle;
  try {
    handle = await open(temp, 'wx');
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync(); await handle.close(); handle = null;
    await rename(temp, file);
  } finally {
    await handle?.close();
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function locked(file, operation) {
  // Cross-process serialization. An orphan lock fails closed after a bounded
  // wait; never delete another writer's lock on a guessed timeout/PID.
  const lock = file + '.lock';
  let handle;
  const end = Date.now() + 5000;
  while (!handle) {
    try { handle = await open(lock, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw failure('WHOLE_LOCK_FAILED', 'Whole budget lock unavailable');
      if (Date.now() >= end) throw failure('WHOLE_LOCK_BUSY', 'Whole budget writer is busy; dispatch blocked');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  try { return await operation(); }
  finally { await handle.close(); await unlink(lock); }
}

export async function initializeWholeBudget(file, options) {
  const state = createWholeBudgetState(options);
  return locked(file, async () => {
    // Do not treat malformed existing state as permission to reset a budget.
    if (await readWholeBudget(file, {allowMissing: true}))
      throw failure('WHOLE_ALREADY_STARTED', 'Clear the closed previous whole budget explicitly');
    await atomicWrite(file, state); return state;
  });
}

export async function reserveWholeAttempt(file, {requestId, startedAt}) {
  if (typeof requestId !== 'string' || !requestId || (startedAt !== undefined && !timestamp(startedAt)))
    throw failure('WHOLE_REQUEST_INVALID', 'Invalid provider attempt identity/time');
  return locked(file, async () => {
    const state = await readWholeBudget(file);
    startedAt ??= Date.now(); // after acquiring the writer lock, not before waiting
    if (Object.hasOwn(state.requests, requestId)) throw failure('WHOLE_DUPLICATE_REQUEST', 'Attempt already reserved');
    if (state.wholeDeadline !== null && startedAt >= state.wholeDeadline)
      throw failure('WHOLE_DEADLINE_PASSED', 'Whole-set deadline passed before provider dispatch');
    if (state.wholeAttemptsCap !== null && state.wholeAttemptsUsed >= state.wholeAttemptsCap)
      throw failure('WHOLE_ATTEMPTS_EXCEEDED', 'Whole-set attempt cap reached before provider dispatch');
    if (state.wholeTokensUsed >= state.wholeTokensCap)
      throw failure('WHOLE_TOKENS_EXCEEDED', 'Known token threshold reached before provider dispatch');
    Object.defineProperty(state.requests, requestId, {value: {requestId, startedAt, totalTokens: null}, enumerable: true});
    refresh(state); await atomicWrite(file, state); return state;
  });
}

export async function settleWholeAttempt(file, requestId, usage) {
  return locked(file, async () => {
    const state = await readWholeBudget(file), row = state.requests[requestId];
    if (!Object.hasOwn(state.requests, requestId)) throw failure('WHOLE_REQUEST_UNKNOWN', 'Attempt has no reservation');
    const value = usage?.totalTokens;
    if (validTokenTotal(value)) {
      if (row.totalTokens !== null && row.totalTokens !== value)
        throw failure('WHOLE_USAGE_CONFLICT', 'Conflicting usage for the same attempt');
      row.totalTokens = value;
    }
    // Null/malformed final usage never erases earlier valid usage. A crash or
    // missing usage leaves a counted unknown reservation across restarts.
    refresh(state); await atomicWrite(file, state); return state;
  });
}

export async function clearWholeBudget(file) {
  return locked(file, async () => {
    let raw;
    try { raw = await readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    // Fixed previous slot; do not proliferate timestamped copies on each clear.
    const temp = file + '.previous.tmp';
    const handle = await open(temp, 'w');
    try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file + '.previous.json');
    await unlink(file);
  });
}
