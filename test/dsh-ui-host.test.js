import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonaManagementRoute, mountPersonaManagement, PERSONA_UI_PATH } from '../adapters/dsh/ui-host.js';
const envelope = (payload, extra = {}) => ({ type: 'client-request', rpcId: 'actual-request-1', method: 'persona-memory.manage', payload, ...extra });
const request = body => new Request('http://127.0.0.1' + PERSONA_UI_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('native management route preserves real results and correlation through the Connection envelope', async () => {
  const calls = [];
  const route = createPersonaManagementRoute({ dispatch: async (...args) => { calls.push(args); return { available: false, capacity: null, text: '真实原话😀' }; } });
  assert.equal(route.path, '/api/persona-memory.manage'); assert.deepEqual(route.methods, ['POST']); assert.equal(route.requestBody, 'buffered');
  const response = await route.fetch(request(envelope({ action: 'overview', args: { instanceId: 'a' } })));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { type: 'server-response', rpcId: 'actual-request-1', result: { ok: true, value: { available: false, capacity: null, text: '真实原话😀' } } });
  assert.deepEqual(calls, [['overview', { instanceId: 'a' }]]);
});

test('management route rejects malformed envelopes, wrong methods and oversized requests before effects', async () => {
  let effects = 0;
  const route = createPersonaManagementRoute({ dispatch: async () => { effects++; } });
  for (const body of [envelope({ action: 'overview' }, { method: 'other.endpoint' }), envelope({ action: '../any', args: {} }), envelope({ action: 'config', args: [] }), { payload: { action: 'overview' } }]) {
    assert.equal((await (await route.fetch(request(body))).json()).result.ok, false);
  }
  const oversized = await route.fetch(request(envelope({ action: 'config', args: { text: '中'.repeat(30000) } })));
  assert.equal(oversized.status, 413);
  assert.equal((await route.fetch(new Request('http://localhost' + PERSONA_UI_PATH))).status, 405);
  assert.equal(effects, 0);
});

test('mutation refusal is returned as an error and never presented as saved or retried', async () => {
  let attempts = 0;
  const route = createPersonaManagementRoute({ dispatch: async () => { attempts++; throw Object.assign(new Error('版本已经改变'), { code: 'VERSION_CONFLICT' }); } });
  const output = await (await route.fetch(request(envelope({ action: 'config.update', args: { expectedVersion: 1 } })))).json();
  assert.equal(output.result.ok, false); assert.equal(output.result.error.code, 'VERSION_CONFLICT'); assert.equal(output.result.error.message, '版本已经改变'); assert.equal(attempts, 1);
});

test('management registration uses authenticated shared Fetch and does not open an independent server', () => {
  const registrations = [], dependencies = [];
  const ctx = { inject(names, run) { dependencies.push(names); run({ connection: { fetch: { register(route) { registrations.push(route); return 'native-disposer'; } } } }); } };
  mountPersonaManagement(ctx, { dispatch: async () => ({}) });
  assert.deepEqual(dependencies, [['connection']]); assert.equal(registrations[0].path, PERSONA_UI_PATH);
});

test('an aborted management request dispatches no action; oversized results report their boundary', async () => {
  let effects = 0;
  const route = createPersonaManagementRoute({ dispatch: async () => { effects++; return 'a'.repeat(2097152); } });
  const aborted = new AbortController(); aborted.abort();
  const input = new Request('http://localhost' + PERSONA_UI_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope({ action: 'overview' })), signal: aborted.signal });
  assert.equal((await (await route.fetch(input)).json()).result.ok, false); assert.equal(effects, 0);
  const response = await (await route.fetch(request(envelope({ action: 'overview' })))).json();
  assert.equal(response.result.error.code, 'UI_RESULT_TOO_LARGE'); assert.equal(effects, 1);
});
