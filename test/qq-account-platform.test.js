import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { executeQQAccountOperation, mergeQQAccountCapabilities } from '../adapters/dsh/connections/qq-account-platform.js';
import { TOOL_PARAMETERS } from '../adapters/dsh/tool-schema.js';
import { createPersonaSurfaces } from '../adapters/dsh/surfaces.js';
import { createPermissionService } from '../adapters/dsh/permissions.js';
import path from 'node:path';

async function productionPort(qqAccounts, coordinator) {
  const source = (await fs.readFile(new URL('../adapters/dsh/index.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const marker = 'coordinator.platformPort = ', start = source.indexOf(marker), end = source.indexOf(';\n      return coordinator;', start);
  assert.ok(start >= 0 && end > start);
  return new Function('coordinator', 'channels', 'permissions', 'platformCapabilities', 'bilibili', 'social', 'qqAccounts', 'executeQQAccountOperation', 'return (' + source.slice(start + marker.length, end) + ');')(
    coordinator, { handles() { throw Error('account tools must not need a chat binding'); } }, {}, null, null, null, qqAccounts, executeQQAccountOperation);
}
test('the production platform port routes QQ account operations before conversation binding checks', async () => {
  const calls = [], service = Object.fromEntries(['inspect', 'read', 'execute'].map(name => [name, async (...args) => { calls.push({ name, args }); return { status: 'fixture-' + name }; }]));
  const coordinator = { memoryRoot: path.resolve('isolated-current-persona') }, port = await productionPort(service, coordinator);
  for (const action of ['inspect','read','execute']) {
    const result = await port({ scope: 'account', platform: 'qq', action, accountOperation: 'friend.query', memoryRoot: '/model-forged-root', requestId: 'host-tool-call', sessionId: 'actual-dsh-session', sourceOptions: { sourceRefs: [{ sourceSessionId: 'real-session', sourceEventId: 'real-event' }] } });
    assert.equal(result.status, 'fixture-' + action);
    assert.equal(calls.at(-1).args[0].memoryRoot, coordinator.memoryRoot);
  }
  const context = calls.at(-1).args[1];
  assert.equal(context.operationId, 'host-tool-call');
  assert.equal(context.sourceSessionId, 'actual-dsh-session');
  assert.equal(context.memoryRoot, coordinator.memoryRoot);
  assert.deepEqual(context.sourceRefs, [{ sourceSessionId: 'real-session', sourceEventId: 'real-event' }]);
});
test('account routing rejects invented conversation targets, missing host IDs and other platforms', async () => {
  let executions = 0;
  const base = { service: { execute() { executions++; } }, coordinator: { memoryRoot: path.resolve('fixture') } };
  await assert.rejects(executeQQAccountOperation({ ...base, args: { platform: 'qq', action: 'execute', target: {} } }), { code: 'QQ_ACCOUNT_TARGET' });
  await assert.rejects(executeQQAccountOperation({ ...base, args: { platform: 'wechat', action: 'execute' } }), { code: 'QQ_ACCOUNT_PLATFORM' });
  await assert.rejects(executeQQAccountOperation({ ...base, args: { platform: 'qq', action: 'execute' } }), { code: 'QQ_ACCOUNT_OPERATION_ID_REQUIRED' });
  assert.equal(executions, 0);
});
test('friend capabilities require matching real accounts and an available supported native runtime', () => {
  const native = { accountId: '10001', connected: true, items: [{ id: 'friend.query', supported: true, driverAvailable: true }, { id: 'friend.request', supported: true, driverAvailable: true }] };
  const facts = { accountId: '10001', items: [{ id: 'chat.text', supported: true }] };
  assert.equal(mergeQQAccountCapabilities(facts, native).items.find(x => x.id === 'friend.request').driverAvailable, true);
  for (const changed of [{ ...native, accountId: '10002' }, { ...native, connected: false }, { ...native, items: [{ id: 'friend.request', supported: false, driverAvailable: true }] }]) {
    assert.equal(mergeQQAccountCapabilities(facts, changed).items.find(x => x.id === 'friend.request').driverAvailable, false);
  }
  assert.equal(facts.items.length, 1, 'base connector capability facts remain independent');
});
test('owner account surfaces expose reads and status without a friend-request execution endpoint', async () => {
  const calls = [], surfaces = createPersonaSurfaces({ management: { dispatch() {} }, getCoordinator() {}, qqAccounts: { inspect: async args => ({ args }), read: async args => { calls.push(args); return { items: [] }; }, execute() { throw Error('not exposed'); } } });
  await surfaces.dispatch('qqAccount.read', { accountOperation: 'receipts', instanceId: 'current' });
  assert.equal(calls[0].instanceId, 'current');
  await assert.rejects(surfaces.dispatch('qqAccount.execute', {}), { code: 'BAD_MANAGEMENT_REQUEST' });
  await assert.rejects(surfaces.dispatch('qqAccount.read', { accountOperation: 'friend.request' }), { code: 'BAD_MANAGEMENT_REQUEST' });
});
test('new friend permissions stay account and persona scoped and require one capability grant', async () => {
  let saved, accountId = '10001';
  const coordinator = { memoryRoot: path.resolve('isolated-permission-persona'), ready: Promise.resolve() };
  const permissions = createPermissionService({ getCoordinator: () => coordinator, getCapabilities: async () => ({ platform: 'qq', accountId, connected: true, items: ['chat.text','friend.query','friend.request'].map(id => ({ id, supported: true, driverAvailable: true })) }), storage: { read: async () => saved, write: async value => { saved = value; } } });
  const input = { memoryRoot: coordinator.memoryRoot, platform: 'qq', accountId, capability: 'friend.request' };
  await assert.rejects(permissions.authorize(input), { code: 'CAPABILITY_PERMISSION_DENIED' });
  await permissions.configure({ id: 'qq', allowed: ['chat.text','friend.query','friend.request'] });
  assert.equal(await permissions.authorize(input), true);
  assert.equal(await permissions.authorize(input), true, 'there is no per-request approval or personality frequency policy');
  accountId = '10002';
  await assert.rejects(permissions.authorize(input), { code: 'CAPABILITY_PERMISSION_DENIED' });
  await permissions.close();
});
test('QQ account schema exposes references and bounded receipt reads without accepting model operation IDs', () => {
  const schema = TOOL_PARAMETERS.persona_platform;
  assert.deepEqual(schema.scope.enum, ['conversation','account']);
  assert.ok(schema.accountOperation.enum.includes('friend.request'));
  assert.ok(schema.accountOperation.enum.includes('receipts'));
  assert.equal(schema.maxChars.maximum, 8000);
  assert.equal(schema.requestId, undefined);
  assert.equal(schema.memoryRoot, undefined);
  assert.equal(schema.operationId, undefined);
});
