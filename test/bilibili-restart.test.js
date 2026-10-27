import test from 'node:test';
import assert from 'node:assert/strict';
import { createBilibiliService } from '../adapters/dsh/bilibili/service.js';

const AUTH = { accountId: '1234', sessdata: 'restart-fixture-session', csrf: 'restart-fixture-csrf' };
const saved = (enabled = true, credential = { ...AUTH }) => ({ schemaVersion: 'xiangxu-bilibili/1', enabled, credential, receipts: [] });
const json = data => new Response(JSON.stringify({ code: 0, data }), { headers: { 'content-type': 'application/json' } });
const nav = () => json({ isLogin: true, mid: 1234, uname: 'Restart fixture' });
function persistence(value) {
  let stored = structuredClone(value), writes = 0, releases = 0;
  return { async acquire() {}, async read() { return structuredClone(stored); }, async write(next) { writes++; stored = structuredClone(next); }, async release() { releases++; },
    get writes() { return writes; }, get releases() { return releases; }, get value() { return structuredClone(stored); } };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(t, value, handle = async () => nav()) {
  const storage = persistence(value), requests = [], errors = [];
  const service = createBilibiliService({ storage, authorize: async () => false, onError: error => errors.push({ code: error.code, message: error.message }),
    fetchImpl: async (input, options) => { const url = new URL(input); requests.push({ method: options.method, pathname: url.pathname, signal: options.signal }); return handle(url, options); } });
  t.after(() => service.close());
  return { service, storage, requests, errors };
}

test('persistently enabled and authorized Bilibili performs one startup account check without granting operation permissions', async t => {
  const { service, storage, requests } = fixture(t, saved());
  assert.equal(service.capabilitySnapshot().ready, false);
  await service.ready;
  assert.deepEqual(requests.map(row => [row.method, row.pathname]), [['GET', '/x/web-interface/nav']]);
  const status = await service.inspect(), caps = service.capabilitySnapshot();
  assert.equal(status.connected, true); assert.equal(status.accountName, 'Restart fixture'); assert.equal(caps.ready, true);
  assert.ok(caps.items.every(item => item.available && item.defaultAllowed === false));
  assert.equal(storage.writes, 0); assert.deepEqual(storage.value, saved());
  assert.ok(!JSON.stringify(status).includes(AUTH.sessdata)); assert.ok(!JSON.stringify(status).includes(AUTH.csrf));
  await assert.rejects(service.read({ operation: 'video', bvid: 'BV1234567890' }, { memoryRoot: process.cwd(), accountId: AUTH.accountId }), { code: 'BILI_PERMISSION_DENIED' });
  await service.inspect(); service.capabilitySnapshot();
  assert.equal(requests.length, 1);
});

test('disabled saved authorization remains offline when the service is opened and inspected', async t => {
  const { service, storage, requests } = fixture(t, saved(false)); await service.ready;
  const status = await service.inspect(); await service.inspect();
  assert.equal(status.enabled, false); assert.equal(status.authorized, true); assert.equal(status.connected, false);
  assert.ok(service.capabilitySnapshot().items.every(item => !item.available)); assert.equal(requests.length, 0); assert.equal(storage.writes, 0);
});

test('an enabled registry without credentials and a new registry make no startup requests', async t => {
  for (const value of [saved(true, null), null]) {
    const { service, storage, requests } = fixture(t, value); await service.ready; const status = await service.inspect();
    assert.equal(status.connected, false); assert.equal(status.hasCredentials, false); assert.equal(requests.length, 0); assert.equal(storage.writes, 0);
    await service.close();
  }
});

test('a failed startup account check is reported as unavailable without retrying or discarding saved credentials', async t => {
  const { service, storage, requests, errors } = fixture(t, saved(), async () => { throw new Error('private-restart-network-detail'); });
  await service.ready;
  for (let n = 0; n < 3; n++) { const status = await service.inspect(); assert.equal(status.connected, false); assert.equal(status.hasCredentials, true); assert.equal(status.error.code, 'BILI_REQUEST_FAILED'); assert.ok(!JSON.stringify(status).includes('private-restart')); }
  assert.equal(service.capabilitySnapshot().ready, true); assert.ok(service.capabilitySnapshot().items.every(item => !item.available));
  assert.equal(requests.length, 1); assert.equal(errors.length, 1); assert.equal(storage.writes, 0); assert.deepEqual(storage.value, saved());
});

test('startup verification rejects a different account rather than accepting stored authorization as connected', async t => {
  const { service, storage, requests } = fixture(t, saved(), async () => json({ isLogin: true, mid: 5678, uname: 'Different account' }));
  await service.ready; const status = await service.inspect();
  assert.equal(status.connected, false); assert.equal(status.accountId, AUTH.accountId); assert.equal(status.error.code, 'BILI_AUTH_REJECTED');
  assert.equal(requests.length, 1); assert.equal(storage.writes, 0); assert.deepEqual(storage.value, saved());
});

test('closing aborts an in-flight startup check and cannot expose usable capabilities afterwards', async t => {
  const entered = deferred(); let signal;
  const { service, storage, requests, errors } = fixture(t, saved(), async (_url, options) => { signal = options.signal; entered.resolve(); return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }); });
  await entered.promise; const closing = service.close(); await closing; await service.ready;
  const caps = service.capabilitySnapshot(); assert.equal(signal.aborted, true); assert.equal(caps.phase, 'closed'); assert.equal(caps.connected, false); assert.equal(caps.enabled, false);
  assert.ok(caps.items.every(item => !item.available)); assert.equal(requests.length, 1); assert.equal(storage.releases, 1); assert.equal(errors.length, 0);
  await assert.rejects(service.inspect(), { code: 'BILI_CLOSED' }); await service.close(); assert.equal(storage.releases, 1);
});

test('a late successful startup response cannot revive a service which is already closing', async t => {
  const entered = deferred(), result = deferred();
  const { service, storage, requests, errors } = fixture(t, saved(), async () => { entered.resolve(); return result.promise; });
  await entered.promise; const closing = service.close();
  assert.equal(service.capabilitySnapshot().connected, false);
  result.resolve(nav()); await closing; await service.ready;
  const caps = service.capabilitySnapshot(); assert.equal(caps.phase, 'closed'); assert.equal(caps.connected, false); assert.ok(caps.items.every(item => !item.available));
  assert.equal(requests.length, 1); assert.equal(storage.releases, 1); assert.equal(errors.length, 0);
});

test('closing before persisted account state is read prevents the startup request entirely', async t => {
  const gate = deferred(), storage = persistence(saved()), requests = [];
  storage.read = async () => gate.promise;
  const service = createBilibiliService({ storage, fetchImpl: async () => { requests.push('request'); return nav(); } }); t.after(() => service.close());
  const closing = service.close(); gate.resolve(saved()); await closing; await service.ready;
  assert.equal(requests.length, 0); assert.equal(service.capabilitySnapshot().phase, 'closed'); assert.equal(storage.releases, 1);
});
