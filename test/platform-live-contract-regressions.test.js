import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createDshCoordinator } from '../adapters/dsh/index.js';
import { createPermissionService } from '../adapters/dsh/permissions.js';
import { createBilibiliService } from '../adapters/dsh/bilibili/service.js';
import { TOOL_PARAMETERS } from '../adapters/dsh/tool-schema.js';

// Run the exact composition closure and the registered coordinator tool. This
// covers the boundary omitted by service-only tests without copying its logic.
async function platformPort(coordinator, channels, permissions, bilibili) {
  const source = (await fs.readFile(new URL('../adapters/dsh/index.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const marker = 'coordinator.platformPort = ', start = source.indexOf(marker), end = source.indexOf(';\n      return coordinator;', start);
  assert.ok(start >= 0 && end > start, 'Review the production composition if this boundary moves');
  return new Function('coordinator', 'channels', 'permissions', 'bilibili', 'social', 'qqAccounts', 'executeQQAccountOperation', 'platformCapabilities',
    'return (' + source.slice(start + marker.length, end) + ');')(coordinator, channels, permissions, bilibili, null, null, null, null);
}

async function fixture(t, { bilibili, supported = true, allowed = true, handles = true } = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'xiangxu-platform-live-contract-')), tools = new Map();
  const scope = { on: () => () => {}, tools: { restrict: () => () => {}, register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } } };
  const agent = { id: 'isolated-platform-agent', ctx: scope, status: 'idle', inbox: { nextTurn: [], nextStep: [] },
    session: { id: 'isolated-platform-agent', header: {}, deriveMessages: () => [] } };
  const c = createDshCoordinator({ agents: { get: () => agent }, get: () => undefined, llm: {} }, { memoryRoot: path.join(root, 'persona'), operatorControl: false });
  await c.ready; await c.attachAgent(agent);
  const reads = ['contacts.read', 'groups.read', 'message.read', 'message.forward.read'];
  const permissions = createPermissionService({ getCoordinator: () => c,
    getCapabilities: async () => ({ accountId: '10001', connected: true, items: reads.map(id => ({ id, supported, available: true })) }),
    storage: { read: async () => null, write: async () => {} } });
  await permissions.ready;
  if (allowed && supported) await permissions.configure({ id: 'qq', allowed: reads });
  const executions = [], channels = { handles: () => handles, capabilities: async () => ({ id: 'qq', platform: 'qq', accountId: '10001' }),
    execute: async args => { executions.push(structuredClone(args)); return { capability: args.capability, items: [] }; } };
  c.platformPort = await platformPort(c, channels, permissions, bilibili);
  t.after(async () => { await permissions.close(); await c.close(); assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep + 'xiangxu-platform-live-contract-')); await fs.rm(root, { recursive: true, force: true }); });
  return { c, agent, tool: tools.get('persona_platform'), executions };
}

test('the real registered tool carries the trusted host call ID through QQ conversation read', async t => {
  const f = await fixture(t);
  const result = await f.tool.execute({ action: 'read', platform: 'qq', scope: 'conversation', capability: 'groups.read', requestId: 'not-a-host-id',
    target: { sessionId: f.agent.session.id, channelId: 'dsh:' + f.agent.session.id, personId: null } }, { agent: f.agent, callId: 'actual-dsh-call-98' });
  assert.equal(result.capability, 'groups.read'); assert.equal(f.executions.length, 1);
  assert.equal(f.executions[0].requestId, 'dsh-tool:isolated-platform-agent:actual-dsh-call-98');
  assert.equal(f.executions[0].sessionId, f.agent.session.id);
});

test('conversation read permits only the four actual read capabilities; execute compatibility is retained', async t => {
  const f = await fixture(t);
  for (const capability of ['contacts.read', 'groups.read', 'message.read', 'message.forward.read']) {
    const result = await f.tool.execute({ action: 'read', platform: 'qq', capability, messageId: 'real-message-reference', forwardId: 'real-forward-reference' }, { agent: f.agent, callId: 'host-' + capability });
    assert.equal(result.capability, capability);
  }
  const legacy = await f.tool.execute({ action: 'execute', platform: 'qq', capability: 'groups.read' }, { agent: f.agent, callId: 'host-existing-execute-read' });
  assert.equal(legacy.capability, 'groups.read');
  const before = f.executions.length;
  for (const capability of ['chat.text', 'message.retract', 'profile.update']) {
    const result = await f.tool.execute({ action: 'read', platform: 'qq', capability, text: 'must not be sent' }, { agent: f.agent, callId: 'host-denied-' + capability });
    assert.equal(result.code, 'CHANNEL_CAPABILITY_REQUEST');
  }
  assert.equal(f.executions.length, before);
});

test('missing host identity is not fabricated from model arguments', async t => {
  const f = await fixture(t);
  const result = await f.tool.execute({ action: 'read', platform: 'qq', capability: 'groups.read', requestId: 'forged-by-model' }, { agent: f.agent });
  assert.equal(result.code, 'CHANNEL_OPERATION_ID_REQUIRED'); assert.equal(f.executions.length, 0);
});

test('the read routing fix preserves unsupported-driver and permission failures', async t => {
  for (const options of [{ supported: false }, { allowed: false }]) {
    const f = await fixture(t, options);
    const result = await f.tool.execute({ action: 'read', platform: 'qq', capability: 'groups.read' }, { agent: f.agent, callId: 'host-unavailable' });
    assert.equal(result.code, options.supported === false ? 'CAPABILITY_UNSUPPORTED' : 'CAPABILITY_PERMISSION_DENIED');
    assert.equal(f.executions.length, 0);
  }
});

test('capability-filtered QQ inspection keeps account and permission facts without the full catalog', async t => {
  const f = await fixture(t);
  for (const capability of ['groups.read', 'chat.video']) {
    const result = await f.tool.execute({ action: 'inspect', platform: 'qq', capability }, { agent: f.agent, callId: 'inspect-' + capability });
    assert.equal(result.accountId, '10001'); assert.equal(result.connected, true); assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, capability); assert.equal(result.nextCursor, undefined);
    assert.equal(result.items[0].supported, capability === 'groups.read');
    assert.equal(result.items[0].available, capability === 'groups.read');
  }
  const all = await f.c.platformPort({ action: 'inspect', platform: 'qq', sessionId: f.agent.session.id });
  assert.ok(all.items.length > 20, 'Omission retains the complete existing catalog');
  const unknown = await f.c.platformPort({ action: 'inspect', platform: 'qq', capability: 'not-a-real-capability', sessionId: f.agent.session.id });
  assert.deepEqual(unknown.items, []); assert.equal(unknown.accountId, '10001');
});

test('unbound filtered inspection does not fetch unrelated optional provider details', async t => {
  const f = await fixture(t, { handles: false }); let optionalReads = 0;
  const inspect = f.c.socialProviders.inspect.bind(f.c.socialProviders);
  f.c.socialProviders.inspect = async (...args) => { optionalReads++; return inspect(...args); };
  const selected = await f.tool.execute({ action: 'inspect', platform: 'qq', capability: 'groups.read' }, { agent: f.agent, callId: 'inspect-no-binding' });
  assert.equal(selected.targetRequiredForMessages, true); assert.equal(selected.items.length, 1); assert.equal(selected.optional, undefined); assert.equal(optionalReads, 0);
  const complete = await f.c.platformPort({ action: 'inspect', platform: 'qq', sessionId: f.agent.session.id });
  assert.ok(complete.optional); assert.equal(optionalReads, 1);
});

function biliFixture(enabled, credential) {
  const requests = [], credentials = { accountId: '1234', sessdata: 'isolated-session', csrf: 'isolated-csrf' };
  const service = createBilibiliService({ storage: { read: async () => ({ schemaVersion: 'xiangxu-bilibili/1', enabled, credential: credential ? credentials : null, receipts: [] }), write: async () => {} },
    authorize: async () => true, fetchImpl: async url => {
      const u = new URL(url); requests.push(u.pathname);
      const data = u.pathname === '/x/web-interface/nav' ? { isLogin: true, mid: 1234, uname: 'isolated-fixture', wbi_img: { img_url: 'https://i0.hdslb.com/0123456789abcdef0123456789abcdef.png', sub_url: 'https://i0.hdslb.com/fedcba9876543210fedcba9876543210.png' } }
        : u.pathname === '/x/web-interface/wbi/search/type' ? { result: [{ bvid: 'BV1234567890', title: 'isolated search' }], numResults: 1, numPages: 1 }
          : u.pathname === '/x/web-interface/index/top/feed/rcmd' ? { item: [{ bvid: 'BV1234567890', title: 'isolated recommendation', goto: 'av' }] } : null;
      assert.ok(data, 'No unrecognized or write request is allowed');
      return new Response(JSON.stringify({ code: 0, data }), { headers: { 'content-type': 'application/json' } });
    } });
  return { service, requests };
}

test('unconfigured Bilibili tool calls report disabled or missing login before null account validation', async t => {
  for (const [enabled, code] of [[false, 'BILI_DISABLED'], [true, 'BILI_NOT_AUTHORIZED']]) {
    const b = biliFixture(enabled, false); await b.service.ready; t.after(() => b.service.close());
    const f = await fixture(t, { bilibili: b.service });
    for (const operation of ['search', 'recommend']) {
      const result = await f.tool.execute({ action: 'read', platform: 'bilibili', operation, ...(operation === 'search' ? { keyword: '猫咪 日常' } : {}), limit: operation === 'search' ? 3 : 2 }, { agent: f.agent, callId: 'real-' + operation });
      assert.equal(result.code, code); assert.notEqual(result.code, 'BILI_ARGUMENT');
    }
    assert.equal(b.requests.length, 0);
  }
});

test('configured Bilibili search and recommendations pass actual small limits through the registered tool', async t => {
  const b = biliFixture(true, true); await b.service.ready; t.after(() => b.service.close());
  const f = await fixture(t, { bilibili: b.service }); const contexts = [], read = b.service.read.bind(b.service);
  b.service.read = (args, context) => { contexts.push(context); return read(args, context); };
  for (const [operation, limit] of [['search', 3], ['recommend', 2]]) {
    const result = await f.tool.execute({ action: 'read', platform: 'bilibili', operation, ...(operation === 'search' ? { keyword: '猫咪 日常' } : {}), limit }, { agent: f.agent, callId: 'trusted-' + operation });
    assert.equal(result.operation, operation); assert.equal(result.items.length, 1);
    assert.equal(contexts.at(-1).deliveryId, 'dsh-tool:isolated-platform-agent:trusted-' + operation);
    assert.equal(contexts.at(-1).accountId, '1234');
  }
  assert.ok(b.requests.includes('/x/web-interface/wbi/search/type')); assert.ok(b.requests.includes('/x/web-interface/index/top/feed/rcmd'));
});

test('the model-visible schema describes inspect filtering and the read versus execute contract', () => {
  assert.match(TOOL_PARAMETERS.persona_platform.capability.description, /inspect/);
  for (const capability of ['contacts.read', 'groups.read', 'message.read', 'message.forward.read']) assert.ok(TOOL_PARAMETERS.persona_platform.action.description.includes(capability));
  assert.match(TOOL_PARAMETERS.persona_platform.action.description, /execute for sending or changes/);
});
