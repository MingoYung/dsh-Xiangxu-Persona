import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import packageInfo from '../package.json' with { type: 'json' };
import { MemoryRepository } from '../core/repository.js';
import { createManagementService } from '../adapters/dsh/management.js';

const secret = 'PRIVATE_SENTINEL_ACCOUNT_0000000000_C:\\Users\\Owner\\persona_https://user:token@local.example';
const service = coordinator => createManagementService({ getCoordinator: () => coordinator, clock: () => 5000 });
const report = coordinator => service(coordinator).dispatch('support.summary', { instanceId: 'private-persona-instance' });
async function snapshot(root, relative = '') {
  const result = [];
  for (const item of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = join(relative, item.name);
    if (item.isDirectory()) result.push(...await snapshot(root, path));
    else result.push([path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')]);
  }
  return result.sort(([a], [b]) => a.localeCompare(b));
}

test('support builds a small allowlisted summary without serializing persona, source data or arbitrary error codes', async () => {
  const coordinator = {
    memoryRoot: secret, initializationError: null, accountId: secret, apiKey: secret,
    errors: [{ code: 'ECONNREFUSED', message: secret, stack: secret, accountId: secret }, { code: secret, message: secret }, { code: 'ECONNREFUSED', data: { secret } }],
    repository: {
      config: { persona: secret, apiKey: secret },
      getRuntime: async () => ({ globalMuted: false, sleep: { state: 'awake', wakeCondition: secret }, currentDecision: { reason: secret }, activeRunId: secret,
        execution: { pendingControl: { secret }, pendingWake: null, consolidationJobs: { [secret]: { status: 'running', text: secret }, second: { status: secret } } }, memoryGaps: [{ text: secret }] }),
      getCapacity: () => assert.fail('support must not scan retained content to calculate capacity'),
      getPersona: () => assert.fail('must not read persona'), getSelfProfile: () => assert.fail('must not read self profile'), listPeople: () => assert.fail('must not read people'),
    },
    executeCommand: () => assert.fail('support must not execute operations'),
  };
  const summary = await report(coordinator), text = JSON.stringify(summary);
  assert.equal(summary.plugin.version, packageInfo.version);
  assert.deepEqual(summary.instance, { loaded: true, initialization: 'ready' });
  assert.deepEqual(summary.runtime.jobs, { queued: 0, running: 1, paused: 0, completed: 0, failed: 0, other: 1 });
  assert.deepEqual(summary.storage, { read: 'not_collected' });
  assert.deepEqual(summary.errors.counts, [{ code: 'ECONNREFUSED', count: 2 }, { code: 'OTHER', count: 1 }]);
  assert.equal(summary.generatedAt, '1970-01-01T00:00:05.000Z');
  assert.doesNotMatch(text, /PRIVATE_SENTINEL|0000000000|private-persona-instance|physicalBytes|memoryRoot|apiKey|message|stack|currentDecision|memoryGaps|wakeCondition/);
  assert.ok(Buffer.byteLength(text) < 16384);
  assert.deepEqual(Object.keys(summary), ['schemaVersion', 'generatedAt', 'plugin', 'environment', 'instance', 'runtime', 'storage', 'errors']);
});

test('support is available while unloaded, initialization failed or the repository is unreadable', async () => {
  const unloaded = await report(null);
  assert.deepEqual(unloaded.instance, { loaded: false, initialization: 'unloaded' });
  assert.equal(unloaded.runtime.read, 'not_loaded');
  const failed = await report({ ready: Promise.reject(Object.assign(new Error(secret), { code: secret })), errors: [], repository: { getRuntime: () => assert.fail('must not inspect failed initialization') } });
  assert.equal(failed.instance.initialization, 'failed');
  assert.deepEqual(failed.errors.counts, [{ code: 'OTHER', count: 1 }]);
  const unavailable = await report({ repository: { getRuntime: async () => { throw Object.assign(new Error(secret), { code: 'EACCES' }); }, getCapacity: () => assert.fail('support must not scan retained content') } });
  assert.equal(unavailable.runtime.read, 'unavailable'); assert.equal(unavailable.storage.read, 'not_collected');
  assert.equal(unavailable.errors.counts.find(row => row.code === 'SUPPORT_RUNTIME_UNAVAILABLE').count, 1);
  assert.equal(unavailable.errors.counts.find(row => row.code === 'EACCES').count, 1);
  assert.doesNotMatch(JSON.stringify({ failed, unavailable }), /PRIVATE_SENTINEL|0000000000/);
  const lookupFailed = await createManagementService({ getCoordinator: () => { throw Object.assign(new Error(secret), { code: 'ENOENT' }); } }).dispatch('support.summary');
  assert.equal(lookupFailed.instance.initialization, 'failed'); assert.equal(lookupFailed.errors.counts[0].code, 'ENOENT');
});

test('support error sampling and groups are bounded and unknown strings stay OTHER', async () => {
  const errors = Array.from({ length: 10000 }, (_, index) => ({ code: index % 2 ? secret + index : 'ETIMEDOUT', message: secret }));
  const summary = await report({ initializationError: Object.assign(new Error(secret), { code: secret }), errors });
  assert.equal(summary.errors.sourceWindow, 100); assert.equal(summary.errors.sampled, 101); assert.equal(summary.errors.truncated, true);
  assert.deepEqual(summary.errors.counts, [{ code: 'ETIMEDOUT', count: 50 }, { code: 'OTHER', count: 51 }]);
  assert.ok(summary.errors.counts.length <= 20); assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_SENTINEL|0000000000/);
  const codes = ['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'MODEL_ROUTE_UNAVAILABLE', 'PLATFORM_UNAVAILABLE', 'INSTANCE_UNLOADED', 'CAPACITY_EXCEEDED', 'SOURCE_UNKNOWN', 'SOURCE_UNAVAILABLE', 'SOURCE_REVOKED', 'SOURCE_NOT_RETAINED', 'SOURCE_PAGE_INVALID', 'CHANNEL_CONTEXT_INVALID', 'CHANNEL_CONTEXT_CAPACITY', 'TASK_UNAVAILABLE', 'MEDIA_UNAVAILABLE'];
  const grouped = await report({ initializationError: new Error(secret), errors: codes.map(code => ({ code })) });
  assert.equal(grouped.errors.counts.length, 20); assert.equal(grouped.errors.truncated, true);
  assert.equal(grouped.errors.counts.reduce((total, item) => total + item.count, 0), codes.length + 1);
});

test('support accepts only a bounded optional instance selector, with no arbitrary content, URL or file operation', async () => {
  const api = service(null);
  for (const args of [{ url: 'https://example.org' }, { text: secret }, { filename: secret }, { instanceId: [] }, { instanceId: '' }, { instanceId: 'x'.repeat(129) }]) await assert.rejects(api.dispatch('support.summary', args), { code: 'BAD_MANAGEMENT_REQUEST' });
  assert.equal((await api.dispatch('support.summary')).instance.loaded, false);
});

test('support reads a real isolated memory repository without changing retained data or including it in the report', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiangxu-support-')), repository = new MemoryRepository({ root, clock: () => 5000 });
  t.after(async () => { await repository.close(); await rm(root, { recursive: true, force: true }); });
  await repository.open();
  repository.getCapacity = () => assert.fail('support must not scan real retained content to calculate capacity');
  await repository.ingest({ personId: null, sourceSessionId: 'private-session', sourceEventId: 'private-event', sourceKind: 'user', contentClass: 'participant_dialogue', channelId: 'private-channel', role: 'user', text: secret, sourceAt: 1000, observedAt: 1000 });
  const before = await snapshot(root), summary = await report({ repository, memoryRoot: root, errors: [] });
  assert.equal(summary.runtime.read, 'available'); assert.equal(summary.storage.read, 'not_collected');
  assert.deepEqual(await snapshot(root), before);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_SENTINEL|private-session|private-event|private-channel|xiangxu-support-/);
});
