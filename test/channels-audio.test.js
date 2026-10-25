import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChannelService } from '../adapters/dsh/channels/service.js';

function wave() {
  const value = Buffer.alloc(46);
  value.write('RIFF'); value.writeUInt32LE(38, 4); value.write('WAVEfmt ', 8); value.writeUInt32LE(16, 16);
  value.writeUInt16LE(1, 20); value.writeUInt16LE(1, 22); value.writeUInt32LE(22050, 24); value.writeUInt32LE(44100, 28);
  value.writeUInt16LE(2, 32); value.writeUInt16LE(16, 34); value.write('data', 36); value.writeUInt32LE(2, 40); return value;
}
async function fixture(t, { voiceMode = 'voice', generationFailure = false, finalWriteFailure = false, cleanupFailure = false } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'xiangxu-channel-audio-')), audioPath = join(base, 'owned-test.wav');
  let disk = null, current = { memoryRoot: join(base, 'A'), ready: Promise.resolve(), agents: new Map(),
    voice: { inspect: async () => ({ effective: { available: true, resolvedVoiceId: 'win-sapi:test', rate: 1, pitch: 1 } }) } };
  const received = [], texts = [], voices = []; let generated = 0, cleaned = 0, closed = 0, savedBeforeGeneration = null;
  const storage = { read: async () => structuredClone(disk), write: async next => {
    if (finalWriteFailure && next.receipts.some(row => row.voiceDelivery?.status === 'delivered')) throw Object.assign(new Error('test audio receipt fault'), { code: 'TEST_AUDIO_RECEIPT' });
    disk = structuredClone(next);
  } };
  const speechPort = {
    catalog: async () => ({ supported: true, provider: 'win-sapi', voices: [{ id: 'win-sapi:test', name: 'Test', lang: 'zh-CN', localService: true, default: true }] }),
    async synthesize(args) { generated++; savedBeforeGeneration = structuredClone(disk.receipts.find(row => row.kind === 'outbound')); if (generationFailure) return { status: 'unavailable', reason: 'isolated_failure' }; await writeFile(audioPath, wave()); return { status: 'generated', path: audioPath, bytes: 46, mime: 'audio/wav' }; },
    async cleanup() { cleaned++; if (cleanupFailure) throw Object.assign(new Error('isolated cache lock'), { code: 'TEST_AUDIO_CACHE_LOCKED' }); await rm(audioPath, { force: true }); },
  };
  const service = createChannelService({ getCoordinator: () => current, storage, speechPort, port: 0,
    channelPort: { create: async value => value, send: async (binding, message) => { received.push({ binding, message }); return { status: 'accepted' }; }, close: async () => { closed++; }, closeChannel: async () => {} },
    clientFactory: profile => ({ capabilities: { text: true, voice: profile.platform === 'qq' },
      probe: async () => ({ connected: true, status: 'connected', capabilities: { text: true, group: true, voice: profile.platform === 'qq' } }),
      sendText: async (_target, text) => { texts.push(text); return { status: 'delivered', messageId: 'text-' + texts.length, receiptId: 'text:' + texts.length, deliveredAt: Date.now() }; },
      sendVoice: async (_target, bytes) => { voices.push(Buffer.from(bytes)); return { status: 'delivered', messageId: 'voice-' + voices.length, receiptId: 'voice:' + voices.length, deliveredAt: Date.now() }; },
    }),
  });
  await service.ready;
  t.after(async () => { await service.close(); await rm(base, { recursive: true, force: true }); });
  await service.configure({ id: 'qq', config: { accountId: '100', apiUrl: 'http://127.0.0.1:12345', allowedPrivateIds: ['*'], allowedGroupIds: ['*'], voiceMode } });
  const secret = await service.rotateIngress({ id: 'qq' }); await service.start({ id: 'qq' });
  async function inbound(id = 1) {
    const url = (await service.status()).connections[0].callbackUrl;
    const result = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret.ingressToken }, body: JSON.stringify({ post_type: 'message', message_type: 'private', self_id: 100, user_id: 11, message_id: id, time: Math.floor(Date.now() / 1000), sender: { user_id: 11 }, message: [{ type: 'text', data: { text: 'actual input' } }] }) });
    const value = await result.json(); assert.equal(value.status, 'accepted'); return value;
  }
  const accepted = await inbound();
  const output = (extra = {}) => service.output({ sessionId: accepted.sessionId, sourceEventId: 'assistant-real-id', seq: 20, text: '本轮实际生成的正文', deliveryId: 'chosen-delivery', ...extra });
  return { service, output, inbound, texts, voices, received, disk: () => structuredClone(disk), generated: () => generated, cleaned: () => cleaned, checkpoint: () => savedBeforeGeneration,
    audioPath, current: () => current, setCurrent: value => { current = value; }, closed: () => closed, accepted };
}

test('QQ voice-only uses real generated WAV bytes, confirms the voice receipt and cleans its cache without text fallback', async t => {
  const f = await fixture(t), result = await f.output();
  assert.equal(result.status, 'delivered'); assert.equal(result.messageId, 'voice-1'); assert.equal(result.voiceDelivery.status, 'delivered');
  assert.equal(f.texts.length, 0); assert.equal(f.voices.length, 1); assert.deepEqual(f.voices[0], wave());
  assert.equal(f.generated(), 1); assert.equal(f.cleaned(), 1); await assert.rejects(access(f.audioPath));
  assert.equal((await f.output()).duplicate, true); assert.equal(f.generated(), 1); assert.equal(f.voices.length, 1);
  assert.equal(JSON.stringify(f.disk()).includes('本轮实际生成'), false);
  assert.equal((await f.service.status()).connections[0].capabilities.voice, true);
});

test('both persists acknowledged text before synthesis and never claims a failed voice was delivered', async t => {
  const f = await fixture(t, { voiceMode: 'both', generationFailure: true }), result = await f.output();
  assert.equal(f.checkpoint().status, 'delivered'); assert.equal(f.checkpoint().platformMessageId, 'text-1');
  assert.equal(result.status, 'delivered'); assert.equal(result.voiceUnavailable, true); assert.equal(result.voiceDelivery.status, 'failed');
  assert.equal(f.texts.length, 1); assert.equal(f.voices.length, 0); assert.equal(f.cleaned(), 1);
  assert.equal((await f.output()).voiceUnavailable, true); assert.equal(f.generated(), 1);
});

test('an audio receipt write failure preserves already durable text delivery and never replays the voice', async t => {
  const f = await fixture(t, { voiceMode: 'both', finalWriteFailure: true }), result = await f.output();
  assert.equal(result.status, 'delivered'); assert.equal(result.messageId, 'text-1'); assert.equal(result.voiceDelivery.status, 'unknown');
  assert.equal(f.texts.length, 1); assert.equal(f.voices.length, 1);
  assert.equal((await f.service.reconcile({ target: { sessionId: f.accepted.sessionId }, deliveryId: 'chosen-delivery' })).status, 'delivered');
  await f.output(); assert.equal(f.voices.length, 1); assert.equal(f.generated(), 1);
});

test('voice generation failure in voice-only mode is explicit and emits no substitute text', async t => {
  const f = await fixture(t, { generationFailure: true }), result = await f.output();
  assert.equal(result.status, 'failed'); assert.equal(f.texts.length, 0); assert.equal(f.voices.length, 0); assert.equal(result.voiceUnavailable, true);
});

test('cache cleanup failure cannot erase an already acknowledged platform voice delivery', async t => {
  const f = await fixture(t, { cleanupFailure: true }), result = await f.output();
  assert.equal(result.status, 'delivered'); assert.equal(result.messageId, 'voice-1');
  assert.equal(result.voiceDelivery.status, 'delivered'); assert.equal(result.voiceDelivery.cacheCleanupFailed, 'TEST_AUDIO_CACHE_LOCKED');
  assert.equal(f.disk().receipts.find(row => row.kind === 'outbound').status, 'delivered');
  await f.output(); assert.equal(f.voices.length, 1); assert.equal(f.generated(), 1);
});

test('restoring an inactive old instance retires only its bindings and leaves the active busy connection intact', async t => {
  const f = await fixture(t, { voiceMode: 'text' }), A = f.current(), B = { ...A, memoryRoot: join(tmpdir(), 'xiangxu-old-instance-B'), agents: new Map() };
  await f.service.suspend(); f.setCurrent(B); await f.service.resume(); await f.inbound(2);
  await f.service.suspend(); f.setCurrent(A); await f.service.resume();
  A.agents.set('busy-other', { agent: { status: 'running' } });
  const before = await f.service.status(), closed = f.closed();
  const result = await f.service.invalidateForRoot(B.memoryRoot), after = await f.service.status();
  assert.equal(result.stopped, false); assert.equal(after.listener.running, true); assert.equal(after.connections[0].enabled, before.connections[0].enabled); assert.equal(f.closed(), closed);
  assert(f.disk().bindings.filter(row => row.memoryRoot === B.memoryRoot).every(row => row.retired));
  A.agents.clear();
});
