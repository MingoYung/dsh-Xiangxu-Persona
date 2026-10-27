import test from 'node:test';
import assert from 'node:assert/strict';
import { createQQNativeClient, QQ_NATIVE_ABI, QQ_NATIVE_PROTOCOL, QQ_NATIVE_CLIENT_LIMITS } from '../adapters/dsh/connections/qq-native-client.js';
const runtime = () => ({ enabled: true, protocol: QQ_NATIVE_PROTOCOL, baseUrl: 'http://127.0.0.1:39001', token: 'isolated-token-do-not-display', bootId: 'boot-isolated-1', expectedAccountId: '12345678', abiVersion: QQ_NATIVE_ABI });
const envelope = (own, body = {}) => ({ protocol: QQ_NATIVE_PROTOCOL, bootId: own.bootId, accountId: own.expectedAccountId, ...body });
const caps = { query: { supported: true, available: true }, request: { supported: true, available: true }, respond: { supported: false, available: false } };
const refs = { targetRef: 'qqtarget_' + 'a'.repeat(32), optionsRef: 'qqopts_' + 'b'.repeat(32) };

test('native client uses authenticated loopback POST and validates inspect identity and capabilities', async () => {
  const own = runtime(), calls = [], client = createQQNativeClient({ fetchImpl: async (url, request) => { calls.push({ url, request }); return Response.json(envelope(own, { ready: true, abiVersion: QQ_NATIVE_ABI, capabilities: caps })); } });
  const result = await client.inspect(own); assert.equal(result.ready, true); assert.equal(calls.length, 1); assert.equal(calls[0].url, own.baseUrl + '/v1/inspect'); assert.equal(calls[0].request.method, 'POST'); assert.equal(calls[0].request.redirect, 'error'); assert.equal(calls[0].request.headers.authorization, 'Bearer ' + own.token); assert.equal(calls[0].request.headers['x-xiangxu-boot-id'], own.bootId); assert.deepEqual(JSON.parse(calls[0].request.body), {}); assert.equal(JSON.stringify(result).includes(own.token), false);
});
test('native query preserves exact decimal target and opaque references without DTO or UID synthesis', async () => {
  const own = runtime(); let sent; const client = createQQNativeClient({ fetchImpl: async (_url, request) => { sent = JSON.parse(request.body); return Response.json(envelope(own, { ...refs, userId: '987654321', relationship: 'not_friend', addFriendSetting: 1, requirements: { supported: true, verificationText: true, questionCount: 0 }, expiresAt: 123456 })); } });
  const result = await client.query(own, { userId: '987654321' }); assert.deepEqual(sent, { userId: '987654321' }); assert.equal(result.optionsRef, refs.optionsRef); assert.equal(Object.hasOwn(result, 'uid'), false);
});
for (const field of ['bootId', 'accountId']) test('native client rejects mismatched ' + field + ' before consuming successful data', async () => {
  const own = runtime(), client = createQQNativeClient({ fetchImpl: async () => Response.json(envelope(own, { [field]: field === 'accountId' ? '87654321' : 'another-boot', ready: true, abiVersion: QQ_NATIVE_ABI, capabilities: caps })) }); await assert.rejects(client.inspect(own), { code: 'QQ_NATIVE_IDENTITY' });
});
test('explicit native error may omit confirmed account but cannot masquerade as another account success', async () => {
  const own = runtime(), client = createQQNativeClient({ fetchImpl: async () => Response.json(envelope(own, { accountId: null, error: { code: 'NATIVE_NOT_READY', message: own.token } }), { status: 503 }) });
  await assert.rejects(client.inspect(own), error => error.code === 'NATIVE_NOT_READY' && !error.message.includes(own.token));
});
test('native mutation transport has no retry and never echoes credential-bearing exceptions', async () => {
  const own = runtime(); let requests = 0; const client = createQQNativeClient({ fetchImpl: async () => { requests++; throw Error(own.token); } }); await assert.rejects(client.request(own, { operationId: 'op-one', optionsRef: refs.optionsRef, text: '测试' }), error => error.code === 'QQ_NATIVE_TRANSPORT_UNKNOWN' && !error.message.includes(own.token)); assert.equal(requests, 1);
});
test('unknown native count remains null after interruption, and positive states require actual confirmation source', async () => {
  const own = runtime(); let result = { operationId: 'op-one', state: 'unknown', nativeCalls: null, nativeCallUpperBound: 1 }; const client = createQQNativeClient({ fetchImpl: async () => Response.json(envelope(own, result)) }); assert.equal((await client.status(own, { operationId: 'op-one' })).nativeCalls, null); result = { operationId: 'op-one', state: 'submitted', nativeCalls: 1 }; await assert.rejects(client.status(own, { operationId: 'op-one' }), { code: 'QQ_NATIVE_RECEIPT' }); result.confirmedBy = 'native-result-zero'; assert.equal((await client.status(own, { operationId: 'op-one' })).state, 'submitted');
});
test('native status rejects a mismatched trusted operation id', async () => {
  const own = runtime(), client = createQQNativeClient({ fetchImpl: async () => Response.json(envelope(own, { operationId: 'another-op', state: 'unknown', nativeCalls: null })) }); await assert.rejects(client.status(own, { operationId: 'op-one' }), { code: 'QQ_NATIVE_RECEIPT' });
});
test('submitted and accepted status retain their exact confirmation meanings', async () => {
  const own = runtime(); let result = { operationId: 'op-one', state: 'submitted', nativeCalls: 0, confirmedBy: 'native-result-zero' }; const client = createQQNativeClient({ fetchImpl: async () => Response.json(envelope(own, result)) });
  await assert.rejects(client.status(own, { operationId: 'op-one' }), { code: 'QQ_NATIVE_RECEIPT' });
  result = { operationId: 'op-one', state: 'accepted', nativeCalls: 0, alreadyFriend: true, confirmedBy: 'arbitrary-ack' };
  await assert.rejects(client.status(own, { operationId: 'op-one' }), { code: 'QQ_NATIVE_RECEIPT' });
  result.confirmedBy = 'friend_list'; assert.equal((await client.status(own, { operationId: 'op-one' })).state, 'accepted');
});
test('native descriptor rejects remote origins, credentials, extra paths, disabled state and unknown ABI without fetch', async () => {
  let calls = 0; const client = createQQNativeClient({ fetchImpl: async () => { calls++; throw Error('must not fetch'); } });
  for (const change of [{ baseUrl: 'https://example.invalid' }, { baseUrl: 'http://secret@127.0.0.1:39001' }, { baseUrl: 'http://127.0.0.1:39001/path' }, { enabled: false }, { abiVersion: 'unverified' }]) await assert.rejects(client.inspect({ ...runtime(), ...change })); assert.equal(calls, 0);
});
test('native response byte capacity is enforced before exposing payloads', async () => {
  const client = createQQNativeClient({ fetchImpl: async () => new Response('x', { headers: { 'content-length': String(QQ_NATIVE_CLIENT_LIMITS.responseBytes + 1) } }) }); await assert.rejects(client.inspect(runtime()), { code: 'QQ_NATIVE_RESPONSE_CAPACITY' });
});
test('unconfirmed initial scan can be inspected but cannot query or request an account', async () => {
  const own = { ...runtime(), expectedAccountId: null }, client = createQQNativeClient({ fetchImpl: async () => Response.json(envelope(own, { ready: false, abiVersion: QQ_NATIVE_ABI, capabilities: caps })) }); assert.equal((await client.inspect(own)).ready, false); await assert.rejects(client.query(own, { userId: '987654321' }), { code: 'QQ_NATIVE_ARGUMENT' });
});
