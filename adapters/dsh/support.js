import packageInfo from '../../package.json' with { type: 'json' };

const SUPPORT_SCHEMA = 'xiangxu-support/1', ERROR_WINDOW = 100, ERROR_GROUPS = 20;
// Only these literal technical codes can leave the local runtime. An arbitrary
// provider's code can itself contain account details, so unknown codes are OTHER.
const ERROR_CODES = new Set([
  'INITIALIZATION_FAILED', 'INSTANCE_UNLOADED', 'PERSONA_NOT_LOADED', 'VERSION_CONFLICT',
  'MEMORY_REQUIRED_DOCUMENT_MISSING', 'CAPACITY_EXCEEDED', 'SOURCE_NOT_RETAINED',
  'SOURCE_UNKNOWN', 'SOURCE_UNAVAILABLE', 'SOURCE_REVOKED', 'SOURCE_DEPENDENCIES_INCOMPLETE',
  'SOURCE_PAGE_INVALID', 'CHANNEL_CONTEXT_INVALID', 'CHANNEL_CONTEXT_CAPACITY',
  'CHANNEL_OUTPUT_UNAVAILABLE', 'CHANNEL_OPERATION_ID_REQUIRED', 'CHANNEL_CAPABILITY_REQUEST',
  'MODEL_ROUTE_UNAVAILABLE', 'TARGET_UNAVAILABLE', 'TARGET_CHANNEL_MISMATCH',
  'PERSONA_CONTEXT_PROJECTION_MISSING', 'PERSONA_SCOPE_UNAVAILABLE', 'TARGET_SCOPE',
  'TASK_UNAVAILABLE', 'TASK_HOST_UNAVAILABLE', 'TASK_UNSAFE_PATH', 'TASK_ACTION_INVALID',
  'MEDIA_UNAVAILABLE', 'MEDIA_ACTION_INVALID', 'PLATFORM_UNAVAILABLE', 'PLATFORM_TARGET_REQUIRED',
  'SOCIAL_UNAVAILABLE', 'BILI_UNAVAILABLE', 'BILI_DISABLED', 'BILI_NOT_AUTHORIZED',
  'NAPCAT_PLATFORM_UNSUPPORTED', 'NAPCAT_QQ_MISSING', 'NAPCAT_NOT_CONNECTED',
  'MANAGEMENT_CONTROL_UNAVAILABLE', 'MANAGEMENT_OPERATION_CAPACITY', 'MANAGEMENT_RECEIPT_ERROR',
  'MANAGEMENT_RESPONSE_CAPACITY', 'MANAGEMENT_CURSOR_STALE', 'COMMAND_OUTCOME_UNKNOWN',
  'OPERATION_OUTCOME_UNKNOWN', 'OPERATION_FAILED', 'TOOL_RESULT_CACHE_CAPACITY',
  'TOOL_CURSOR_EXPIRED', 'INVALID_TOOL_CURSOR', 'EACCES', 'EPERM', 'ENOENT', 'ENOSPC',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND',
  'SUPPORT_RUNTIME_UNAVAILABLE',
]);
const codeOf = value => typeof value === 'string' && ERROR_CODES.has(value) ? value : 'OTHER';
const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageInfo.version) ? packageInfo.version : 'unknown';
const choice = (value, values, fallback = 'unknown') => values.includes(value) ? value : fallback;
const flag = value => typeof value === 'boolean' ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1000000) : 0;

/** Builds a fresh allowlisted report; never serializes source objects or logs. */
export async function createSupportSummary({ getCoordinator, instanceId, clock = Date.now } = {}) {
  const failures = [], timestamp = clock();
  const summary = {
    schemaVersion: SUPPORT_SCHEMA,
    generatedAt: new Date(Number.isFinite(timestamp) ? timestamp : 0).toISOString(),
    plugin: { name: 'dsh-xiangxu-persona', version },
    environment: {
      os: choice(process.platform, ['win32', 'linux', 'darwin'], 'other'),
      architecture: choice(process.arch, ['x64', 'arm64', 'ia32', 'arm'], 'other'),
      nodeVersion: /^v\d+\.\d+\.\d+$/.test(process.version) ? process.version : 'unknown',
    },
    instance: { loaded: false, initialization: 'unloaded' },
    runtime: { read: 'not_loaded', sleep: 'unknown', muted: null, activeWork: null, pendingControl: null, pendingWake: null, jobs: { queued: 0, running: 0, paused: 0, completed: 0, failed: 0, other: 0 } },
    // Capacity calculation scans retained content in MemoryRepository. Support
    // reporting deliberately does not run that scan or export memory amounts.
    storage: { read: 'not_collected' },
    errors: { sourceWindow: ERROR_WINDOW, sampled: 0, truncated: false, counts: [] },
  };
  let coordinator;
  try {
    coordinator = await getCoordinator(instanceId);
    if (coordinator) {
      summary.instance.loaded = true; summary.instance.initialization = 'ready';
      try { await coordinator.ready; } catch (error) { failures.push(error?.code); summary.instance.initialization = 'failed'; }
      if (coordinator.initializationError) { failures.push(coordinator.initializationError.code); summary.instance.initialization = 'failed'; }
    }
  } catch (error) { failures.push(error?.code); summary.instance.initialization = 'failed'; }
  if (coordinator && summary.instance.initialization === 'ready') {
    try {
      const runtime = await coordinator.repository.getRuntime();
      const jobs = Object.values(runtime?.execution?.consolidationJobs ?? {}), counts = summary.runtime.jobs;
      for (const job of jobs) { const key = choice(job?.status, ['queued', 'running', 'paused', 'completed', 'failed'], 'other'); counts[key] = count(counts[key] + 1); }
      summary.runtime = { read: 'available', sleep: choice(runtime?.sleep?.state, ['awake', 'sleeping']), muted: flag(runtime?.globalMuted), activeWork: Boolean(runtime?.activeRunId), pendingControl: Boolean(runtime?.execution?.pendingControl), pendingWake: Boolean(runtime?.execution?.pendingWake), jobs: counts };
    } catch (error) { summary.runtime.read = 'unavailable'; failures.push('SUPPORT_RUNTIME_UNAVAILABLE', error?.code); }
  } else if (summary.instance.initialization === 'failed') {
    summary.runtime.read = 'unavailable';
  }
  const errors = Array.isArray(coordinator?.errors) ? coordinator.errors : [], recent = errors.slice(-ERROR_WINDOW);
  const counts = new Map();
  for (const value of [...recent.map(row => row?.code), ...failures]) { const code = codeOf(value); counts.set(code, (counts.get(code) ?? 0) + 1); }
  const entries = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  let selected = entries;
  if (entries.length > ERROR_GROUPS) {
    selected = entries.filter(([code]) => code !== 'OTHER').slice(0, ERROR_GROUPS - 1);
    const kept = new Set(selected.map(([code]) => code));
    selected.push(['OTHER', entries.filter(([code]) => !kept.has(code)).reduce((total, [, value]) => total + value, 0)]);
  }
  summary.errors = { sourceWindow: ERROR_WINDOW, sampled: recent.length + failures.length, truncated: errors.length > ERROR_WINDOW || entries.length > ERROR_GROUPS, counts: selected.map(([code, value]) => ({ code, count: value })) };
  return summary;
}
