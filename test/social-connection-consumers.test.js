import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createChannelService } from '../adapters/dsh/channels/service.js';
import { createPermissionService } from '../adapters/dsh/permissions.js';
import { createSocialIdentityService } from '../adapters/dsh/social-identities.js';
import { createSocialConnectionPorts } from '../adapters/dsh/index.js';

const memory = () => { let data = null; return { async read() { return structuredClone(data); }, async write(value) { data = structuredClone(value); } }; };
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'xiangxu-social-consumer-')), sockets = new Set(), requests = []; let actualAccount = '111', officialCalls = 0;
  const server = http.createServer(async (request, response) => {
    const parts = []; for await (const part of request) parts.push(part); requests.push({ path: request.url, body: Buffer.concat(parts).toString('utf8') });
    const action = request.url.slice(1), data = action === 'get_login_info' ? { user_id: Number(actualAccount) } : action === 'get_status' ? { good: true, online: true } : action === 'can_send_record' ? { yes: false } : action === 'get_supported_actions' ? [] : action === 'get_version_info' ? { app_name: 'Fixture Bridge' } : null;
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const coordinator = { ready: Promise.resolve(), memoryRoot: join(root, 'persona'), agents: new Map() }, getCoordinator = () => coordinator;
  const channels = createChannelService({ storage: memory(), getCoordinator, channelPort: { async create() { throw Error('No model conversation is needed for identity checks'); }, async send() { throw Error('No platform messages should be sent'); }, async close() {} }, speechPort: { async catalog() { return { supported: false, voices: [] }; } } });
  const ports = createSocialConnectionPorts({ channels, connections: { async status() { officialCalls++; return { connections: [{ id: 'qq', accountId: 'unrelated-official-bot', connected: false }] }; } } });
  const permissions = createPermissionService({ file: join(root, 'permissions.json'), getCoordinator, getCapabilities: id => channels.capabilities({ id }) });
  const social = createSocialIdentityService({ storage: memory(), getCoordinator, ...ports, getPermissionStatus: (id, args) => permissions.inspect({ id, ...args }) });
  t.after(async () => { await social.close(); await permissions.close(); await channels.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  await channels.configure({ id: 'qq', config: { mode: 'bridge', apiUrl: 'http://127.0.0.1:' + server.address().port, accountId: '111', accessToken: 'fixture-private-token', allowedPrivateIds: ['7'] } });
  return { channels, ports, social, requests, setActualAccount(value) { actualAccount = value; }, officialCalls: () => officialCalls };
}

test('real bridge probe identity reaches the actual index adapter and social linkCurrent without an official bot login', async t => {
  const f = await fixture(t); await f.channels.rotateIngress({ id: 'qq' }); await f.channels.start({ id: 'qq', port: 0 });
  const channel = await f.channels.capabilities({ id: 'qq' }); assert.equal(channel.accountId, '111'); assert.equal(channel.verifiedAccountId, '111'); assert.equal(channel.identityVerified, true);
  const actual = await f.ports.getConnectionStatus('qq'); assert.equal(actual.accountId, '111'); assert.equal(actual.connected, true); assert.equal(f.officialCalls(), 0);
  const linked = await f.social.linkCurrent({ platform: 'qq', displayName: '合成桥接验收账号' }); assert.equal(linked.item.accountId, '111'); assert.equal(linked.item.accountType, 'personal'); assert.equal(linked.item.connection.verification, 'verified'); assert.equal(linked.item.connection.credentialReference, 'channel:qq'); assert.equal(linked.item.capabilities.find(item => item.id === 'chat.text').available, true);
  assert.ok(f.requests.some(item => item.path === '/get_login_info')); assert.doesNotMatch(JSON.stringify(linked), /fixture-private-token|unrelated-official-bot/); assert.equal(linked.item.connection.deliveryPolicy, undefined);
});

test('configuration alone and a mismatched real bridge login cannot be registered as verified identity', async t => {
  const f = await fixture(t);
  let facts = await f.ports.getChannelCapabilities('qq'); assert.equal(facts.accountId, '111'); assert.equal(facts.verifiedAccountId, null); assert.equal(facts.connected, false);
  await assert.rejects(f.social.linkCurrent({ platform: 'qq' }), { code: 'SOCIAL_ACCOUNT_UNVERIFIED' });
  f.setActualAccount('222'); await f.channels.rotateIngress({ id: 'qq' }); await assert.rejects(f.channels.start({ id: 'qq', port: 0 }), { code: 'CHANNEL_BRIDGE_UNAVAILABLE' });
  facts = await f.ports.getChannelCapabilities('qq'); assert.equal(facts.accountId, '111'); assert.equal(facts.identityVerified, false); assert.equal(facts.verifiedAccountId, null); assert.equal(facts.connected, false);
  await assert.rejects(f.social.linkCurrent({ platform: 'qq' }), { code: 'SOCIAL_ACCOUNT_UNVERIFIED' });
  const manual = await f.social.upsert({ platform: 'qq', accountId: '111' }); assert.equal(manual.item.connection.verification, 'unverified'); assert.equal(manual.item.connection.connected, false); assert.ok(f.requests.some(item => item.path === '/get_login_info'));
});

test('the actual adapter does not trust a bridge connected flag without matching probe identity facts', async () => {
  for (const facts of [
    { accountId: 'configured', connected: true },
    { accountId: 'configured', connected: true, identityVerified: true, verifiedAccountId: 'different' },
    { accountId: 'configured', connected: true, identityVerified: false, verifiedAccountId: 'configured' },
  ]) {
    let officialCalls = 0; const ports = createSocialConnectionPorts({ channels: { async capabilities() { return { mode: 'bridge', ...facts }; } }, connections: { async status() { officialCalls++; return { accountId: 'configured', connected: true }; } } });
    assert.equal((await ports.getChannelCapabilities('qq')).connected, false); assert.equal((await ports.getConnectionStatus('qq')).connected, false); assert.equal(officialCalls, 0);
  }
});

test('official identity uses the official connection and retains QQ reply-only policy', async () => {
  let calls = 0; const ports = createSocialConnectionPorts({ channels: { async capabilities() { return { mode: 'official', accountId: 'bot', connected: true }; } }, connections: { async status() { calls++; return { connections: [{ id: 'qq', accountId: 'bot', connected: true }] }; } } });
  const official = await ports.getConnectionStatus('qq'); assert.equal(official.accountId, 'bot'); assert.equal(official.connected, true); assert.equal(calls, 1);
  const capabilities = await ports.getChannelCapabilities('qq'); assert.equal(capabilities.deliveryPolicy.proactive, false); assert.equal(capabilities.deliveryPolicy.passiveReplyRequired, true);
});
