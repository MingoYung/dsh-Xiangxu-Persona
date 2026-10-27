import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createQQAccountService, QQ_ACCOUNT_LIMITS } from '../adapters/dsh/connections/qq-account.js';
import { QQ_NATIVE_PROTOCOL, QQ_NATIVE_ABI } from '../adapters/dsh/connections/qq-native-client.js';

const ACCOUNT = '100001', TARGET = '200002', OTHER = '300003';
const ref = (kind, n) => 'qq' + kind + '_' + n.toString(16).padStart(32, '0');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiangxu-qq-account-')), memoryRoot = path.join(root, 'persona'), archiveRoot = path.join(memoryRoot, 'extensions', 'qq-account');
  let now = 1800000000000, queryCount = 0, runtimeError = null, current = { instanceId: 'persona-a', memoryRoot, coordinator: {}, ready: Promise.resolve() };
  let runtime = { enabled: true, protocol: QQ_NATIVE_PROTOCOL, baseUrl: 'http://127.0.0.1:39743', token: 'isolated-test-token', bootId: 'test-boot-a', expectedAccountId: ACCOUNT, abiVersion: QQ_NATIVE_ABI };
  const calls = [], grants = [], operations = new Map(), hooks = {}, services = [];
  const envelope = () => ({ protocol: QQ_NATIVE_PROTOCOL, bootId: runtime.bootId, accountId: runtime.expectedAccountId });
  const fetchImpl = async (url, init) => {
    const route = new URL(url).pathname, payload = JSON.parse(init.body); calls.push({ route, payload, method: init.method });
    if (hooks[route]) { const custom = await hooks[route](payload, init); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom); }
    let body;
    if (route === '/v1/inspect') body = { ...envelope(), ready: true, abiVersion: QQ_NATIVE_ABI, capabilities: { query: { supported: true, available: true }, request: { supported: true, available: true }, respond: { supported: false, available: false } } };
    else if (route === '/v1/friend/query') { queryCount++; body = { ...envelope(), userId: payload.userId, targetRef: ref('target', queryCount), optionsRef: ref('opts', queryCount), relationship: 'not_friend', addFriendSetting: 1, requirements: { supported: true, verificationText: true, questionCount: 0 }, expiresAt: now + 300000 }; }
    else if (route === '/v1/friend/request') { const query = [...calls].reverse().find(v => v.route === '/v1/friend/query'); body = { ...envelope(), operationId: payload.operationId, userId: query.payload.userId, targetRef: ref('target', queryCount), optionsRef: payload.optionsRef, state: 'submitted', nativeCalls: 1, nativeCallUpperBound: 1, confirmedBy: 'native-result-zero' }; operations.set(payload.operationId, body); }
    else if (route === '/v1/friend/status') body = operations.get(payload.operationId) ?? { ...envelope(), operationId: payload.operationId, state: 'unknown', nativeCalls: null, nativeCallUpperBound: 1 };
    else throw new Error('Unexpected local mock route');
    return Response.json(body);
  };
  const ports = { getCoordinator: async () => current && { ...current }, getRuntime: async () => { if (runtimeError) throw runtimeError; return runtime && { ...runtime }; }, authorize: async value => { grants.push(value); return extra.authorize ? extra.authorize(value, grants.length) : true; }, clock: () => now, fetchImpl, archiveFault: extra.archiveFault };
  const makeService = () => { const value = createQQAccountService(ports); services.push(value); return value; }, service = makeService();
  t.after(async () => { await Promise.all(services.map(value => value.close())); await fs.rm(root, { recursive: true, force: true }); });
  return { root, memoryRoot, archiveRoot, calls, grants, hooks, operations, ports, service, makeService, envelope,
    get runtime() { return runtime; }, set runtime(value) { runtime = value; }, get current() { return current; }, set current(value) { current = value; },
    set runtimeError(value) { runtimeError = value; }, advance(value) { now += value; },
    query: (userId = TARGET, s = service) => s.read({ accountOperation: 'friend.query', accountId: ACCOUNT, userId }),
    request: (query, id = 'trusted-call-1', s = service, args = {}, context = {}) => s.execute({ accountOperation: 'friend.request', accountId: ACCOUNT, optionsRef: query.optionsRef, targetRef: query.targetRef, userId: query.userId, text: '这是一条隔离测试验证消息', ...args }, { operationId: id, sourceSessionId: 'source-session-a', memoryRoot, ...context }),
    async index() { return JSON.parse(await fs.readFile(path.join(archiveRoot, 'index.json'), 'utf8')); },
  };
}
const requestCalls = f => f.calls.filter(v => v.route === '/v1/friend/request');

test('capability inspection cannot recurse through permissions or archives and faults leave ordinary QQ capability discovery usable', async t => {
  const f = await fixture(t, { authorize: () => { throw new Error('must not authorize'); } });
  f.runtimeError = new Error('isolated-test-token');
  const unavailable = await f.service.inspectCapabilities();
  assert.equal(unavailable.connected, false); assert.equal(unavailable.items.length, 2); assert.equal(f.grants.length, 0);
  await assert.rejects(fs.stat(f.archiveRoot), { code: 'ENOENT' });
  f.runtimeError = null;
  assert.equal((await f.service.inspectCapabilities()).connected, true);
  assert.equal(f.grants.length, 0); await f.service.close();
  assert.equal((await f.service.inspectCapabilities()).connected, false);
});

test('friend query retains complete scoped technical evidence without synthesizing human conversation or a channel binding', async t => {
  const f = await fixture(t), query = await f.query();
  assert.equal(query.accountId, ACCOUNT); assert.equal(query.userId, TARGET); assert.equal(query.referenceOnly, true); assert.equal(query.bindingCreated, false);
  assert.deepEqual(f.grants[0], { memoryRoot: f.memoryRoot, platform: 'qq', accountId: ACCOUNT, capability: 'friend.query' });
  const index = await f.index(), raw = JSON.parse(await fs.readFile(path.join(f.archiveRoot, 'queries', query.queryId + '.json'), 'utf8'));
  assert.equal(index.queries.length, 1); assert.equal(raw.instanceId, 'persona-a'); assert.equal(raw.response.optionsRef, query.optionsRef);
  assert.equal(JSON.stringify(raw).includes(f.runtime.token), false);
  assert.deepEqual(await fs.readdir(f.memoryRoot), ['extensions']);
});

test('offline options, archived account discovery and receipt browsing do not need grants or live runtime', async t => {
  const f = await fixture(t), query = await f.query(), result = await f.request(query); f.runtimeError = new Error('offline');
  const before = f.calls.length, grants = f.grants.length;
  const options = await f.service.read({ accountOperation: 'friend.options', accountId: ACCOUNT, optionsRef: query.optionsRef });
  assert.equal(options.usable, false); assert.equal(options.immutableQuery, true);
  const state = await f.service.inspect({ memoryRoot: f.memoryRoot });
  assert.equal(state.connected, false); assert.equal(state.accountSource, 'archive'); assert.equal(state.accountId, ACCOUNT);
  assert.deepEqual(state.knownAccounts, [{ accountId: ACCOUNT, receipts: 1, queries: 1 }]);
  const list = await f.service.read({ accountOperation: 'receipts', accountId: ACCOUNT });
  assert.equal(list.items[0].receiptId, result.receiptId); assert.equal(f.calls.length, before); assert.equal(f.grants.length, grants);
});

test('trusted tool operation ID is durably prepared before the sole request and full provenance stays technical', async t => {
  const f = await fixture(t), query = await f.query(); let prepared;
  f.hooks['/v1/friend/request'] = async payload => { const index = await f.index(); prepared = JSON.parse(await fs.readFile(path.join(f.archiveRoot, 'receipts', index.receipts[0].receiptId, '000000.json'), 'utf8')); assert.equal(prepared.status, 'prepared'); assert.equal(payload.operationId, 'real-tool-call'); };
  const result = await f.request(query, 'real-tool-call', f.service, { operationId: 'model-invented-id' }, { sourceRefs: [{ type: 'technical-evidence', id: 'source-1' }], sourceRecordIds: ['record-a'] });
  assert.equal(result.status, 'submitted'); assert.equal(result.confirmedBy, 'native-result-zero'); assert.equal(requestCalls(f).length, 1);
  assert.equal(prepared.operationId, 'real-tool-call'); assert.equal(prepared.source.humanDialogue, false); assert.equal(prepared.source.bindingCreated, false);
  assert.deepEqual(prepared.source.sourceRecordIds, ['record-a']); assert.equal(JSON.stringify(prepared).includes(f.runtime.token), false);
  assert.deepEqual(await fs.readdir(f.memoryRoot), ['extensions']);
});

test('same operation returns retained result without network; different payload or session cannot reuse it', async t => {
  const f = await fixture(t), query = await f.query(), first = await f.request(query), count = f.calls.length;
  const duplicate = await f.request(query); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.receiptId, first.receiptId); assert.equal(f.calls.length, count);
  await assert.rejects(f.request(query, 'trusted-call-1', f.service, { text: 'another text' }), { code: 'QQ_ACCOUNT_OPERATION_CONFLICT' });
  await assert.rejects(f.request(query, 'trusted-call-1', f.service, {}, { sourceSessionId: 'different-session' }), { code: 'QQ_ACCOUNT_OPERATION_CONFLICT' });
  await f.service.close(); const restarted = f.makeService(); f.runtimeError = new Error('offline');
  assert.equal((await f.request(query, 'trusted-call-1', restarted)).status, 'submitted'); assert.equal(f.calls.length, count);
});

test('lost mutation response remains unknown, never replays, and status appends evidence without rewriting the original unknown', async t => {
  const f = await fixture(t), query = await f.query();
  f.hooks['/v1/friend/request'] = () => { throw new Error('private token isolated-test-token'); };
  const result = await f.request(query); assert.equal(result.status, 'unknown'); assert.equal(result.outcomeUnknown, true); assert.equal(requestCalls(f).length, 1);
  const unknown = await fs.readFile(path.join(f.archiveRoot, 'receipts', result.receiptId, '000001.json'));
  f.operations.set('trusted-call-1', { ...f.envelope(), operationId: 'trusted-call-1', userId: TARGET, optionsRef: query.optionsRef, targetRef: query.targetRef, state: 'accepted', nativeCalls: 1, confirmedBy: 'friend_list' });
  const refreshed = await f.service.read({ accountOperation: 'friend.status', accountId: ACCOUNT, receiptId: result.receiptId });
  assert.equal(refreshed.status, 'accepted'); assert.equal(refreshed.replayed, false); assert.equal(requestCalls(f).length, 1);
  assert.deepEqual(await fs.readFile(path.join(f.archiveRoot, 'receipts', result.receiptId, '000001.json')), unknown);
  assert.equal(unknown.toString().includes('isolated-test-token'), false);
  assert.equal((await f.request(query)).status, 'accepted'); assert.equal(requestCalls(f).length, 1);
});

test('account change after request is unknown in the original persona archive and cannot be claimed as a confirmed request', async t => {
  const f = await fixture(t), query = await f.query();
  f.hooks['/v1/friend/request'] = () => { const value = { ...f.envelope(), operationId: 'trusted-call-1', userId: TARGET, optionsRef: query.optionsRef, targetRef: query.targetRef, state: 'submitted', nativeCalls: 1, confirmedBy: 'native-result-zero' }; f.runtime = { ...f.runtime, expectedAccountId: OTHER }; return value; };
  const result = await f.request(query); assert.equal(result.status, 'unknown'); assert.equal(result.accountId, ACCOUNT); assert.equal(requestCalls(f).length, 1);
  assert.equal((await f.index()).receipts[0].accountId, ACCOUNT);
});

test('permission revoked after durable prepare prevents dispatch and records zero calls', async t => {
  let requestGrants = 0; const f = await fixture(t, { authorize: value => value.capability !== 'friend.request' || ++requestGrants < 2 }), query = await f.query();
  await assert.rejects(f.request(query), { code: 'QQ_ACCOUNT_PERMISSION' }); assert.equal(requestCalls(f).length, 0);
  const index = await f.index(), row = index.receipts[0]; assert.equal(row.status, 'failed');
  const event = JSON.parse(await fs.readFile(path.join(f.archiveRoot, 'receipts', row.receiptId, '000001.json'), 'utf8')); assert.equal(event.nativeCalls, 0);
});

test('persona switch during target query cannot save target evidence to a new or old unrelated persona', async t => {
  const f = await fixture(t), old = f.current;
  f.hooks['/v1/friend/query'] = payload => { f.current = { ...old, instanceId: 'persona-b', memoryRoot: path.join(f.root, 'other'), coordinator: {} }; return { ...f.envelope(), userId: payload.userId, targetRef: ref('target', 1), optionsRef: ref('opts', 1), relationship: 'not_friend', addFriendSetting: 1, requirements: { supported: true, verificationText: true, questionCount: 0 }, expiresAt: 1800000300000 }; };
  await assert.rejects(f.query(), { code: 'QQ_ACCOUNT_INSTANCE_CHANGED' });
  await assert.rejects(fs.stat(path.join(f.archiveRoot, 'index.json')), { code: 'ENOENT' }); await assert.rejects(fs.stat(f.current.memoryRoot), { code: 'ENOENT' }); assert.equal(requestCalls(f).length, 0);
});

test('source root, target ownership and trusted operation identity are checked independently of model fields', async t => {
  const f = await fixture(t), query = await f.query();
  await assert.rejects(f.service.read({ accountOperation: 'receipts', accountId: ACCOUNT, memoryRoot: {} }), { code: 'QQ_ACCOUNT_INSTANCE_CHANGED' });
  await assert.rejects(f.request(query, undefined, f.service, {}, { operationId: undefined }), { code: 'QQ_ACCOUNT_ARGUMENT' });
  await assert.rejects(f.request(query, 'trusted-x', f.service, { userId: OTHER }), { code: 'QQ_ACCOUNT_OPTIONS_UNKNOWN' });
  await assert.rejects(f.request(query, 'trusted-x', f.service, {}, { memoryRoot: path.join(f.root, 'unrelated') }), { code: 'QQ_ACCOUNT_INSTANCE_CHANGED' });
  assert.equal(requestCalls(f).length, 0);
});

test('expired or previous boot options and unsupported native settings cannot be requested', async t => {
  const f = await fixture(t), query = await f.query(); f.advance(300001);
  await assert.rejects(f.request(query), { code: 'QQ_ACCOUNT_OPTIONS_EXPIRED' });
  const current = await f.query(); f.runtime = { ...f.runtime, bootId: 'test-boot-b' };
  await assert.rejects(f.request(current), { code: 'QQ_ACCOUNT_OPTIONS_EXPIRED' });
  f.hooks['/v1/friend/query'] = payload => ({ ...f.envelope(), userId: payload.userId, targetRef: ref('target', 8), optionsRef: ref('opts', 8), relationship: 'not_friend', addFriendSetting: 3, requirements: { supported: false, verificationText: false, questionCount: 1, code: 'QQ_NATIVE_SETTING_UNSUPPORTED' }, expiresAt: 1800001000000 });
  const unsupported = await f.query(); await assert.rejects(f.request(unsupported), { code: 'QQ_ACCOUNT_UNSUPPORTED' }); assert.equal(requestCalls(f).length, 0);
});

test('account-scoped pagination is bounded and rejects stale, oversized or cross-account cursors', async t => {
  const f = await fixture(t), query = await f.query(); for (let n = 0; n < 3; n++) await f.request(query, 'page-call-' + n);
  const first = await f.service.read({ accountOperation: 'receipts', accountId: ACCOUNT, limit: 2 }); assert.equal(first.items.length, 2); assert.equal(first.total, 3); assert.ok(first.pageCursor);
  const second = await f.service.read({ accountOperation: 'receipts', accountId: ACCOUNT, limit: 2, pageCursor: first.pageCursor }); assert.equal(second.items.length, 1); assert.equal(second.pageCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(v => v.receiptId)).size, 3);
  await assert.rejects(f.service.read({ accountOperation: 'receipts', accountId: OTHER, pageCursor: first.pageCursor }), { code: 'QQ_ACCOUNT_CURSOR' });
  await assert.rejects(f.service.read({ accountOperation: 'receipts', accountId: ACCOUNT, pageCursor: 'x'.repeat(1025) }), { code: 'QQ_ACCOUNT_CURSOR' });
  await f.request(query, 'page-call-4'); await assert.rejects(f.service.read({ accountOperation: 'receipts', accountId: ACCOUNT, pageCursor: first.pageCursor }), { code: 'QQ_ACCOUNT_CURSOR' });
});

test('complete technical record can be read in bounded unicode chunks with stable hash and cannot leak across archived accounts', async t => {
  const f = await fixture(t), query = await f.query(), result = await f.request(query, 'unicode-call', f.service, { text: '你好🐟'.repeat(50) }); let offset = 0, full = '', sha;
  for (;;) { const part = await f.service.read({ accountOperation: 'receipt', accountId: ACCOUNT, receiptId: result.receiptId, offset, maxChars: 79 }); full += part.text; sha ??= part.sha256; assert.equal(part.sha256, sha); assert.ok([...part.text].length <= 79); if (part.complete) break; offset = part.nextOffset; }
  assert.equal(createHash('sha256').update(full).digest('hex'), sha); assert.equal(JSON.parse(full).prepared.request.text, '你好🐟'.repeat(50));
  await assert.rejects(f.service.read({ accountOperation: 'receipt', accountId: OTHER, receiptId: result.receiptId }), { code: 'QQ_ACCOUNT_RECEIPT_UNKNOWN' });
});

test('releaseRoot drains in-flight read and releases only the archive writer while preserving evidence', async t => {
  const f = await fixture(t), began = deferred(), finish = deferred();
  f.hooks['/v1/friend/query'] = async () => { began.resolve(); await finish.promise; };
  const pending = f.query(); await began.promise; assert.equal(f.service.isBusy('persona-a'), true);
  f.current = null; const releasing = f.service.releaseRoot(f.memoryRoot); let released = false; releasing.then(() => { released = true; }); await Promise.resolve(); assert.equal(released, false);
  finish.resolve(); await assert.rejects(pending, { code: 'QQ_ACCOUNT_INSTANCE_CHANGED' }); await releasing;
  assert.equal(f.service.isBusy('persona-a'), false); await assert.rejects(fs.stat(path.join(f.archiveRoot, 'writer.lock')), { code: 'ENOENT' });
  f.current = { instanceId: 'persona-a', memoryRoot: f.memoryRoot, coordinator: {}, ready: Promise.resolve() }; delete f.hooks['/v1/friend/query'];
  assert.equal((await f.query()).accountId, ACCOUNT); await f.service.releaseRoot(f.memoryRoot); await f.service.releaseRoot(f.memoryRoot);
  assert.equal((await f.index()).queries.length, 1);
});

test('close then releaseRoot and releaseRoot during close are safe idempotent lifecycle operations', async t => {
  const f = await fixture(t); await f.query(); const closing = f.service.close(); await f.service.releaseRoot(f.memoryRoot); await closing; await f.service.releaseRoot(f.memoryRoot);
  await assert.rejects(fs.stat(path.join(f.archiveRoot, 'writer.lock')), { code: 'ENOENT' }); assert.equal((await f.index()).queries.length, 1);
});

test('parent maintenance gate and restore journal block nested archive writers without mutating persona data', async t => {
  const f = await fixture(t); for (const suffix of ['.maintenance.lock', '.restore-journal.json']) { const file = path.join(path.dirname(f.memoryRoot), '.' + path.basename(f.memoryRoot) + suffix); await fs.writeFile(file, '{}'); await assert.rejects(f.query(), { code: 'QQ_ACCOUNT_MAINTENANCE' }); await fs.unlink(file); }
  await assert.rejects(fs.stat(f.archiveRoot), { code: 'ENOENT' }); assert.equal((await f.query()).accountId, ACCOUNT);
});

test('prepared WAL crash is recovered as unknown and same tool call is never dispatched after restart', async t => {
  let crash = false; const f = await fixture(t, { archiveFault: stage => { if (crash && stage === 'after_prepare') { crash = false; throw new Error('simulated power loss'); } } }), query = await f.query(); crash = true;
  await assert.rejects(f.request(query)); assert.equal(requestCalls(f).length, 0); await f.service.close(); const restarted = f.makeService();
  const recovered = await f.request(query, 'trusted-call-1', restarted); assert.equal(recovered.status, 'unknown'); assert.equal(recovered.duplicate, true); assert.equal(requestCalls(f).length, 0);
  const index = await f.index(), event = JSON.parse(await fs.readFile(path.join(f.archiveRoot, 'receipts', index.receipts[0].receiptId, '000001.json'), 'utf8')); assert.equal(event.event, 'interrupted'); assert.equal(event.nativeCalls, null);
});

test('postdispatch journal failure cannot be retried as a fresh request and complete recovered evidence remains available', async t => {
  let crash = false; const f = await fixture(t, { archiveFault: (stage, detail) => { if (crash && stage === 'before_apply' && detail.path.endsWith('000001.json')) { crash = false; throw new Error('result journal interrupted'); } } }), query = await f.query(); crash = true;
  await assert.rejects(f.request(query)); assert.equal(requestCalls(f).length, 1); await f.service.close(); const restarted = f.makeService();
  const recovered = await f.request(query, 'trusted-call-1', restarted); assert.equal(recovered.duplicate, true); assert.equal(requestCalls(f).length, 1);
  const raw = await restarted.read({ accountOperation: 'receipt', accountId: ACCOUNT, receiptId: recovered.receiptId }); assert.equal(JSON.parse(raw.text).prepared.operationId, 'trusted-call-1'); assert.equal(JSON.parse(raw.text).events[0].response.confirmedBy, 'native-result-zero');
});

test('archive byte capacity rejects before native dispatch and never evicts previous complete query evidence', async t => {
  const f = await fixture(t), query = await f.query(), before = await fs.readFile(path.join(f.archiveRoot, 'queries', query.queryId + '.json'));
  const padding = await fs.open(path.join(f.archiveRoot, 'capacity-test.bin'), 'w'); await padding.truncate(QQ_ACCOUNT_LIMITS.archiveBytes); await padding.close();
  await assert.rejects(f.request(query), { code: 'QQ_ACCOUNT_CAPACITY' }); assert.equal(requestCalls(f).length, 0); assert.deepEqual(await fs.readFile(path.join(f.archiveRoot, 'queries', query.queryId + '.json')), before);
});

test('tampered original record identity is rejected before it can supply request or status parameters', async t => {
  const f = await fixture(t), query = await f.query(), queryPath = path.join(f.archiveRoot, 'queries', query.queryId + '.json'), raw = JSON.parse(await fs.readFile(queryPath, 'utf8'));
  raw.response.userId = OTHER; await fs.writeFile(queryPath, JSON.stringify(raw));
  await assert.rejects(f.request(query), { code: 'QQ_ACCOUNT_ARCHIVE_SCOPE' }); assert.equal(requestCalls(f).length, 0);
});

test('oversized/corrupt indexes and linked archive files cannot initialize account operations', async t => {
  const f = await fixture(t); await fs.mkdir(f.archiveRoot, { recursive: true }); await fs.writeFile(path.join(f.archiveRoot, 'index.json'), ' '.repeat(QQ_ACCOUNT_LIMITS.indexBytes + 1));
  await assert.rejects(f.service.inspect(), { code: 'QQ_ACCOUNT_ARCHIVE_INVALID' }); assert.equal(f.calls.length, 0);
  await fs.unlink(path.join(f.archiveRoot, 'index.json')); await fs.writeFile(path.join(f.root, 'outside.json'), '{}'); await fs.link(path.join(f.root, 'outside.json'), path.join(f.archiveRoot, 'index.json'));
  await assert.rejects(f.service.inspect(), { code: 'QQ_ACCOUNT_ARCHIVE_INVALID' }); assert.equal(f.calls.length, 0);
  assert.equal((await f.service.inspectCapabilities()).connected, true);
});

test('index receipt and query count bounds reject additional operations without deleting retained entries', async t => {
  const f = await fixture(t), query = await f.query(); await f.service.releaseRoot(f.memoryRoot);
  const file = path.join(f.archiveRoot, 'index.json'), index = await f.index();
  index.receipts = Array.from({ length: QQ_ACCOUNT_LIMITS.receipts }, (_, n) => ({ receiptId: 'qqop-' + n.toString(16).padStart(32, '0'), accountId: ACCOUNT, userId: TARGET, status: 'failed', revisions: 0, createdAt: 1800000000000, updatedAt: 1800000000000 }));
  await fs.writeFile(file, JSON.stringify(index));
  await assert.rejects(f.request(query), { code: 'QQ_ACCOUNT_CAPACITY' }); assert.equal(requestCalls(f).length, 0); assert.equal((await f.index()).receipts.length, QQ_ACCOUNT_LIMITS.receipts);
  await f.service.releaseRoot(f.memoryRoot); index.receipts = [];
  index.queries = Array.from({ length: QQ_ACCOUNT_LIMITS.queries }, (_, n) => ({ queryId: 'qqquery-' + n.toString(16).padStart(32, '0'), accountId: ACCOUNT, userId: TARGET, optionsRef: ref('opts', n), targetRef: ref('target', n), bootId: 'test-boot-a', expiresAt: 1800000300000, createdAt: 1800000000000 }));
  await fs.writeFile(file, JSON.stringify(index)); const before = f.calls.filter(v => v.route === '/v1/friend/query').length;
  await assert.rejects(f.query(), { code: 'QQ_ACCOUNT_CAPACITY' }); assert.equal(f.calls.filter(v => v.route === '/v1/friend/query').length, before); assert.equal((await f.index()).queries.length, QQ_ACCOUNT_LIMITS.queries);
});

test('close during a dispatched request preserves unknown evidence and blocks any automatic follow-up request', async t => {
  const f = await fixture(t), query = await f.query(), began = deferred(), finish = deferred();
  f.hooks['/v1/friend/request'] = async () => { began.resolve(); await finish.promise; throw new Error('transport interrupted'); };
  const pending = f.request(query); await began.promise; assert.equal(f.service.isBusy('persona-a'), true); const closing = f.service.close(); finish.resolve();
  const result = await pending; assert.equal(result.status, 'unknown'); await closing; assert.equal(requestCalls(f).length, 1);
  const restarted = f.makeService(); assert.equal((await f.request(query, 'trusted-call-1', restarted)).status, 'unknown'); assert.equal(requestCalls(f).length, 1);
});

test('already-friend request records accepted with zero native calls rather than claiming another submission', async t => {
  const f = await fixture(t), query = await f.query();
  f.hooks['/v1/friend/request'] = payload => ({ ...f.envelope(), operationId: payload.operationId, userId: TARGET, optionsRef: query.optionsRef, targetRef: query.targetRef, state: 'accepted', nativeCalls: 0, nativeCallUpperBound: 0, alreadyFriend: true, confirmedBy: 'friend_list' });
  const result = await f.request(query); assert.equal(result.status, 'accepted'); assert.equal(result.native.nativeCalls, 0); assert.equal(result.native.alreadyFriend, true); assert.equal(requestCalls(f).length, 1);
});
