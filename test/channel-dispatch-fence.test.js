import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import * as fs from 'node:fs/promises';
import { createChannelService } from '../adapters/dsh/channels/service.js';
import { createPermissionService } from '../adapters/dsh/permissions.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, { voiceMode = 'text' } = {}) {
  let disk = null, account = '100', current = { memoryRoot: path.join(tmpdir(), 'xiangxu-dispatch-fence-a'), ready: Promise.resolve(), agents: new Map() };
  let capabilityGate = null, writeGate = null, probeGate = null, voiceGate = null;
  const audioRoot = voiceMode === 'text' ? null : await fs.mkdtemp(path.join(tmpdir(), 'xiangxu-dispatch-voice-'));
  const audioPath = audioRoot ? path.join(audioRoot, 'owned-test.wav') : null;
  if (audioRoot) current.voice = { inspect: async () => ({ effective: { available: true, resolvedVoiceId: 'win-sapi:test', rate: 1, pitch: 1 } }) };
  const writes = [], bindings = [], gates = [];
  const gate = kind => { const value = { began: deferred(), finish: deferred() }; gates.push(value); if (kind === 'capability') capabilityGate = value; else if (kind === 'write') writeGate = value; else if (kind === 'voice') voiceGate = value; else probeGate = value; return value; };
  const capabilities = () => ({ platform: 'qq', accountId: account, connected: true, voiceMode, items: ['chat.text', ...(audioRoot ? ['chat.voice'] : [])].map(id => ({ id, supported: true, driverAvailable: true })) });
  const permissions = createPermissionService({ storage: { read: async () => null, write: async () => {} }, getCoordinator: () => current,
    getCapabilities: async () => { const result = capabilities(); if (capabilityGate) { const own = capabilityGate; capabilityGate = null; own.began.resolve(); await own.finish.promise; } return result; } });
  const client = {
    capabilities: { voice: Boolean(audioRoot) },
    probe: async () => { if (probeGate) { const own = probeGate; probeGate = null; own.began.resolve(); await own.finish.promise; } return { connected: account === '100', accountId: account, status: account === '100' ? 'connected' : 'failed', capabilities: { text: true } }; },
    sendText: async (target, text, args) => { writes.push({ target, text, args, root: current?.memoryRoot ?? null }); return { status: 'delivered', deliveryId: args.deliveryId, messageId: 'sent-' + writes.length, receiptId: 'onebot:sent-' + writes.length }; },
    sendVoice: async (target, bytes, args) => { writes.push({ target, bytes: bytes.length, args }); return { status: 'delivered', deliveryId: args.deliveryId, messageId: 'voice-' + writes.length, receiptId: 'onebot:voice-' + writes.length }; },
  };
  const service = createChannelService({
    storage: { read: async () => disk, write: async value => { if (writeGate && value.receipts.some(row => row.kind === 'outbound' && row.status === 'prepared')) { const own = writeGate; writeGate = null; own.began.resolve(); await own.finish.promise; } disk = structuredClone(value); } },
    getCoordinator: () => current, channelPort: { create: async binding => { bindings.push(binding); return binding; }, send: async () => ({ status: 'accepted' }), close: async () => {} },
    clientFactory: () => client, authorizeAction: args => permissions.authorize(args), port: 0,
    speechPort: audioRoot ? { catalog: async () => ({ supported: true, voices: [] }), synthesize: async () => {
      if (voiceGate) { const own = voiceGate; voiceGate = null; own.began.resolve(); await own.finish.promise; }
      const wave = Buffer.alloc(46); wave.write('RIFF'); wave.writeUInt32LE(38, 4); wave.write('WAVE', 8); await fs.writeFile(audioPath, wave);
      return { status: 'generated', path: audioPath };
    }, cleanup: async () => { await fs.rm(audioPath, { force: true }); } } : undefined,
  });
  t.after(async () => { for (const item of gates) item.finish.resolve(); await service.close(); await permissions.close(); if (audioRoot) { assert.ok(path.resolve(audioRoot).startsWith(path.resolve(tmpdir()) + path.sep + 'xiangxu-dispatch-voice-')); await fs.rm(audioRoot, { recursive: true, force: true }); } });
  await service.configure({ id: 'qq', config: { apiUrl: 'http://127.0.0.1:1', accountId: '100', allowedPrivateIds: ['*'], allowedGroupIds: ['*'], voiceMode } });
  const ingress = await service.rotateIngress({ id: 'qq' }), status = await service.start({ id: 'qq' });
  const response = await fetch(status.connections.find(row => row.id === 'qq').callbackUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ingress.ingressToken },
    body: JSON.stringify({ post_type: 'message', message_type: 'private', self_id: 100, user_id: 11, sender: { user_id: 11 }, message_id: 1, time: 1, message: [{ type: 'text', data: { text: 'isolated input' } }] }) });
  assert.equal((await response.json()).accepted, true);
  const args = { sessionId: bindings[0].sessionId, sourceEventId: 'reply-1', seq: 10, text: 'isolated answer' };
  const send = mode => mode === 'output' ? service.output(args) : service.execute({ sessionId: args.sessionId, capability: 'chat.text', payload: { text: args.text }, requestId: 'tool-1' });
  return { service, permissions, writes, args, send, gate, disk: () => disk, setAccount: value => { account = value; },
    unload: () => { current = null; }, replace: () => { current = { ...current }; }, switch: () => { current = { ...current, memoryRoot: path.join(tmpdir(), 'xiangxu-dispatch-fence-b') }; } };
}

for (const mode of ['output', 'execute']) {
  for (const change of ['unload', 'replace', 'switch']) test(mode + ' rejects a source ' + change + ' during real permission capability lookup', async t => {
    const f = await fixture(t), gate = f.gate('capability'), pending = f.send(mode).then(value => value, error => ({ status: 'rejected', code: error.code }));
    await gate.began.promise; f[change](); gate.finish.resolve(); const result = await pending;
    assert.notEqual(result.status, 'delivered'); assert.equal(f.writes.length, 0);
    assert.equal(f.disk().receipts.some(row => row.kind === 'outbound' && row.status === 'delivered'), false);
  });
  for (const change of ['stop', 'suspend', 'close']) test(mode + ' respects a pending connection ' + change + ' before driver invocation', async t => {
    const f = await fixture(t), gate = f.gate('capability'), pending = f.send(mode).then(value => value, error => ({ status: 'rejected', code: error.code }));
    await gate.began.promise;
    const stopped = change === 'stop' ? f.service.stop({ id: 'qq' }) : f.service[change]();
    gate.finish.resolve(); const result = await pending; await stopped;
    assert.notEqual(result.status, 'delivered'); assert.equal(f.writes.length, 0);
    assert.equal(f.disk().receipts.some(row => row.kind === 'outbound' && row.status === 'delivered'), false);
  });
  test(mode + ' rechecks the actual account after a stale permission capability response', async t => {
    const f = await fixture(t), gate = f.gate('capability'), pending = f.send(mode).then(value => value, error => ({ status: 'rejected', code: error.code }));
    await gate.began.promise; f.setAccount('200'); gate.finish.resolve(); const result = await pending;
    assert.notEqual(result.status, 'delivered'); assert.equal(f.writes.length, 0);
  });
  test(mode + ' sees a permission revoked while capability lookup was pending', async t => {
    const f = await fixture(t), gate = f.gate('capability'), pending = f.send(mode).then(value => value, error => ({ status: 'rejected', code: error.code }));
    await gate.began.promise; await f.permissions.configure({ id: 'qq', allowed: [] }); gate.finish.resolve(); const result = await pending;
    assert.notEqual(result.status, 'delivered'); assert.equal(f.writes.length, 0);
  });
  test(mode + ' performs one legitimate unchanged send and reuses its delivered receipt', async t => {
    const f = await fixture(t); assert.equal((await f.send(mode)).status, 'delivered'); assert.equal(f.writes.length, 1);
    assert.equal((await f.send(mode)).duplicate, true); assert.equal(f.writes.length, 1);
  });
}

test('execute checks its captured grant again after durable preparation and the final account probe', async t => {
  const f = await fixture(t), gate = f.gate('write'), pending = f.send('execute');
  await gate.began.promise; await f.permissions.configure({ id: 'qq', allowed: [] }); gate.finish.resolve(); const result = await pending;
  assert.notEqual(result.status, 'delivered'); assert.equal(f.writes.length, 0);
  assert.equal(f.disk().receipts.find(row => row.kind === 'outbound').status, 'unknown');
});

test('output final probe cannot create a permission gap before driver invocation', async t => {
  const f = await fixture(t), authorization = f.gate('capability'), pending = f.send('output');
  await authorization.began.promise; const finalProbe = f.gate('probe'); authorization.finish.resolve();
  await finalProbe.began.promise; await f.permissions.configure({ id: 'qq', allowed: [] }); finalProbe.finish.resolve();
  assert.notEqual((await pending).status, 'delivered'); assert.equal(f.writes.length, 0);
});

test('permission Boolean authorization stays compatible with stable coordinator wrappers and detects closing during lookup', async () => {
  const c = { memoryRoot: path.join(tmpdir(), 'xiangxu-permission-wrapper'), ready: Promise.resolve() };
  const lookup = deferred(); let wait = false;
  const p = createPermissionService({ getCoordinator: () => ({ memoryRoot: c.memoryRoot, coordinator: c }), storage: { read: async () => null, write: async () => {} },
    getCapabilities: async () => { if (wait) await lookup.promise; return { accountId: '100', connected: true, items: [{ id: 'chat.text', supported: true, driverAvailable: true }] }; } });
  const args = { memoryRoot: c.memoryRoot, platform: 'qq', accountId: '100', capability: 'chat.text' };
  assert.equal(await p.authorize(args), true);
  wait = true; const pending = p.authorize(args); await new Promise(resolve => setImmediate(resolve)); await p.close(); lookup.resolve();
  await assert.rejects(pending, { code: 'PERMISSION_CLOSED' });
});

for (const change of ['replace', 'stop', 'permission']) test('voice-only output applies its final dispatch fence after local synthesis: ' + change, async t => {
  const f = await fixture(t, { voiceMode: 'voice' }), gate = f.gate('voice'), pending = f.send('output');
  await gate.began.promise; let stopped;
  if (change === 'replace') f.replace();
  else if (change === 'stop') stopped = f.service.stop({ id: 'qq' });
  else await f.permissions.configure({ id: 'qq', allowed: ['chat.text'] });
  gate.finish.resolve(); assert.notEqual((await pending).status, 'delivered'); await stopped;
  assert.equal(f.writes.length, 0); assert.equal(f.disk().receipts.some(row => row.kind === 'outbound' && row.status === 'delivered'), false);
});
