import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWindowsSpeechPort as makeSpeechPort, WINDOWS_SPEECH_LIMITS } from '../adapters/dsh/channels/windows-speech.js';

const voiceName = "Test Local Voice ' $(untrusted-metadata)", voiceId = 'win-sapi:' + voiceName;
const voiceCatalog = { status: 'available', voices: [{ id: voiceId, name: voiceName, lang: 'zh-CN', default: true }] };
function wave(size = 84) {
  const bytes = Buffer.alloc(size); bytes.write('RIFF', 0); bytes.writeUInt32LE(size - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(size - 44, 40); return bytes;
}
const activePorts = new Set();
function createWindowsSpeechPort(options) { const port = makeSpeechPort(options); activePorts.add({ port, root: path.resolve(options.cacheRoot) }); return port; }
async function directory(t) {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'xiangxu-system-speech-'));
  t.after(async () => {
    try { for (const record of activePorts) if (record.root === base || record.root.startsWith(base + path.sep)) { await record.port.close(); activePorts.delete(record); } }
    finally { await fs.rm(base, { recursive: true, force: true }); }
  });
  return base;
}
function engine({ synthesize = async (request, done) => { await fs.writeFile(request.path, wave()); done({ status: 'generated' }); }, catalog = voiceCatalog } = {}) {
  const calls = []; let active = 0, peak = 0, kills = 0;
  const spawnImpl = (exe, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); let ended = false, input = '';
    active++; peak = Math.max(peak, active);
    const close = code => { if (ended) return; ended = true; active--; child.emit('close', code); };
    const done = (value, code = 0) => { if (ended) return; if (value !== undefined) child.stdout.emit('data', Buffer.from(JSON.stringify(value))); close(code); };
    child.kill = () => { kills++; close(1); return true; };
    child.stdin = new Writable({ write(chunk, _encoding, callback) { input += chunk.toString('utf8'); callback(); }, final(callback) {
      const request = JSON.parse(input); calls.push({ exe, args, options, request }); callback();
      setImmediate(() => { if (request.action === 'catalog') done(catalog); else Promise.resolve(synthesize(request, done, child)).catch(() => done(undefined, 1)); });
    } });
    return child;
  };
  return { spawnImpl, calls, get peak() { return peak; }, get kills() { return kills; }, get active() { return active; } };
}
const input = (text = 'Artificial local speech test') => ({ text, voiceId, rate: 1, pitch: 1 });

test('Windows speech reports unsupported platforms without spawning or creating a cache', async t => {
  const base = await directory(t), fake = engine(), root = path.join(base, 'cache');
  const port = createWindowsSpeechPort({ cacheRoot: root, platform: 'linux', spawnImpl: fake.spawnImpl });
  assert.equal((await port.catalog()).supported, false); assert.equal((await port.synthesize(input())).reason, 'unsupported_platform');
  assert.equal(fake.calls.length, 0); await assert.rejects(fs.access(root), { code: 'ENOENT' }); await port.close();
});

test('static helper code and stdin JSON stay separate, with truthful rate/pitch and idempotent generation', async t => {
  const root = await directory(t), fake = engine(), port = createWindowsSpeechPort({ cacheRoot: root, platform: 'win32', spawnImpl: fake.spawnImpl }); t.after(() => port.close());
  const text = "Synthetic test'; $env:SECRET; <voice/> & $(not-a-command)";
  const catalog = await port.catalog(); assert.equal(catalog.voices[0].id, voiceId); assert.equal(catalog.voices[0].localService, true);
  const result = await port.synthesize({ ...input(text), rate: 1.1 }, { requestId: 'same-technical-request' });
  assert.equal(result.status, 'generated'); assert.equal(result.wave.codec, 'pcm_s16le'); assert.equal(result.bytes, 84); assert.equal(result.rateMapping, 'approximate_sapi_step'); assert.equal(result.sapiRate, 1);
  const call = fake.calls.at(-1); assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true); assert.equal(call.request.text, text); assert.equal(call.request.voiceName, voiceName);
  assert.equal(call.args.includes('-ExecutionPolicy'), false); assert.equal(call.args.includes('Bypass'), false);
  const code = Buffer.from(call.args.at(-1), 'base64').toString('utf16le'); assert.equal(code.includes(text), false); assert.equal(code.includes(voiceName), false); assert.equal(code.includes(root), false);
  const duplicate = await port.synthesize({ ...input(text), rate: 1.1 }, { requestId: 'same-technical-request' }); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.path, result.path); assert.equal(fake.calls.length, 2);
  assert.equal((await port.synthesize(input('different'), { requestId: 'same-technical-request' })).reason, 'request_conflict');
  assert.equal((await port.synthesize({ ...input(), pitch: 1.2 })).status, 'unsupportedPitch');
  assert.equal((await port.synthesize(input('x'.repeat(2001)))).reason, 'invalid_input'); assert.equal(fake.calls.length, 2);
});

test('local generation serializes and bounded cache eviction removes only its own files', async t => {
  const root = await directory(t), fake = engine({ synthesize: async (request, done) => { await new Promise(resolve => setTimeout(resolve, 5)); await fs.writeFile(request.path, wave()); done({ status: 'generated' }); } });
  const port = createWindowsSpeechPort({ cacheRoot: root, platform: 'win32', spawnImpl: fake.spawnImpl }); t.after(() => port.close());
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => port.synthesize(input('Synthetic ' + index), { requestId: 'r-' + index })));
  assert.equal(results.every(result => result.status === 'generated'), true); assert.equal(fake.peak, 1);
  const files = await fs.readdir(root); assert.equal(files.filter(name => name.endsWith('.wav')).length, 4);
  await assert.rejects(fs.access(results[0].path), { code: 'ENOENT' }); assert.equal((await port.cleanup()).removedFiles, 4);
  assert.equal((await fs.readdir(root)).some(name => name.endsWith('.wav') || name.endsWith('.part')), false);
});

test('total cache capacity reserves room before another synthesis', async t => {
  const root = await directory(t), size = 5 * 1024 * 1024;
  const fake = engine({ synthesize: async (request, done) => { await fs.writeFile(request.path, wave(size)); done({ status: 'generated' }); } });
  const port = createWindowsSpeechPort({ cacheRoot: root, platform: 'win32', spawnImpl: fake.spawnImpl }); t.after(() => port.close());
  for (let index = 0; index < 4; index++) assert.equal((await port.synthesize(input('Bounded ' + index))).status, 'generated');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'windows-speech-cache.json'), 'utf8'));
  assert.ok(manifest.files.length <= 4); assert.ok(manifest.files.reduce((sum, file) => sum + file.bytes, 0) <= WINDOWS_SPEECH_LIMITS.cacheBytes);
});

test('oversized output is stopped and owned partial audio is removed', async t => {
  const root = await directory(t), fake = engine({ synthesize: async request => { await fs.writeFile(request.path, Buffer.alloc(WINDOWS_SPEECH_LIMITS.fileBytes + 1)); } });
  const port = createWindowsSpeechPort({ cacheRoot: root, platform: 'win32', spawnImpl: fake.spawnImpl }); t.after(() => port.close());
  const result = await port.synthesize(input()); assert.equal(result.reason, 'audio_capacity'); assert.ok(fake.kills > 0);
  assert.equal((await fs.readdir(root)).some(name => name.endsWith('.wav') || name.endsWith('.part')), false);
});

test('timeout and engine failures never echo the input or engine exception', async t => {
  const root = await directory(t), fake = engine({ synthesize: async (_request, _done, child) => { child.stderr.emit('data', Buffer.from('SECRET synthetic confidential text')); } });
  const port = createWindowsSpeechPort({ cacheRoot: root, platform: 'win32', spawnImpl: fake.spawnImpl, timeoutMs: 40 }); t.after(() => port.close());
  const result = await port.synthesize(input('SECRET synthetic confidential text')); assert.equal(result.reason, 'timeout'); assert.equal(JSON.stringify(result).includes('SECRET'), false); assert.ok(fake.kills > 0);
});

test('unknown cache files and symlink roots are refused without deletion', async t => {
  const base = await directory(t), root = path.join(base, 'unowned'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'unrelated.txt'), 'keep this');
  const fake = engine(), port = createWindowsSpeechPort({ cacheRoot: root, platform: 'win32', spawnImpl: fake.spawnImpl });
  await assert.rejects(port.synthesize(input()), { code: 'WINDOWS_SPEECH_CACHE_UNOWNED' }); assert.equal(await fs.readFile(path.join(root, 'unrelated.txt'), 'utf8'), 'keep this'); await port.close();
  const link = path.join(base, 'linked'); await fs.symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = createWindowsSpeechPort({ cacheRoot: link, platform: 'win32', spawnImpl: fake.spawnImpl });
  await assert.rejects(linked.synthesize(input()), { code: 'WINDOWS_SPEECH_UNSAFE_PATH' }); await linked.close();
});

test('a changed generated file is preserved and concurrent cache owners are refused', async t => {
  const root = await directory(t), fake = engine(), first = createWindowsSpeechPort({ cacheRoot: root, platform: 'win32', spawnImpl: fake.spawnImpl });
  const result = await first.synthesize(input());
  const second = createWindowsSpeechPort({ cacheRoot: root, platform: 'win32', spawnImpl: fake.spawnImpl });
  await assert.rejects(second.synthesize(input()), { code: 'WINDOWS_SPEECH_CACHE_LOCKED' }); await second.close();
  const changed = wave(); changed[changed.length - 1] = 1; await fs.writeFile(result.path, changed);
  await assert.rejects(first.cleanup(), { code: 'WINDOWS_SPEECH_CACHE_CHANGED' }); assert.deepEqual(await fs.readFile(result.path), changed);
  await assert.rejects(first.close(), { code: 'WINDOWS_SPEECH_CACHE_CHANGED' });
});

test('interrupted owned pending files are cleaned on reopening and do not become audio results', async t => {
  const root = await directory(t), name = 'xiangxu-speech-' + randomUUID() + '.wav';
  await fs.writeFile(path.join(root, name + '.part'), 'unfinished owned data');
  await fs.writeFile(path.join(root, 'windows-speech-cache.json'), JSON.stringify({ schemaVersion: 'xiangxu-windows-speech-cache/1', files: [
    { name, state: 'pending', bytes: 0, sha256: null, createdAt: 1, inputHash: 'a'.repeat(64), requestHash: null },
  ] }));
  const fake = engine(), port = createWindowsSpeechPort({ cacheRoot: root, platform: 'win32', spawnImpl: fake.spawnImpl }); t.after(() => port.close());
  assert.equal((await port.synthesize(input())).status, 'generated'); await assert.rejects(fs.access(path.join(root, name + '.part')), { code: 'ENOENT' });
});

test('close stops its active child, drains queued work and clears only owned output', async t => {
  const root = await directory(t); let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const fake = engine({ synthesize: async () => { started(); } }), port = createWindowsSpeechPort({ cacheRoot: root, platform: 'win32', spawnImpl: fake.spawnImpl });
  const generation = port.synthesize(input()); await startedPromise; const queued = port.synthesize(input('queued'));
  await port.close(); assert.equal((await generation).reason, 'closed'); assert.equal((await queued).reason, 'closed'); assert.equal(fake.active, 0);
  assert.equal((await fs.readdir(root)).some(name => name.endsWith('.wav') || name.endsWith('.part') || name.endsWith('.lock')), false);
});

test('damaged cache and lease metadata produce fixed errors without echoing stored fragments', async t => {
  const base = await directory(t), secret = 'SYNTHETIC_PRIVATE_METADATA_DO_NOT_ECHO', damaged = '{"private":"' + secret + '" unexpected}';
  for (const [name, expected] of [['windows-speech-cache.json', 'WINDOWS_SPEECH_CACHE_INVALID'], ['windows-speech.lock', 'WINDOWS_SPEECH_CACHE_LOCKED']]) {
    const root = path.join(base, expected); await fs.mkdir(root); await fs.writeFile(path.join(root, name), damaged);
    const fake = engine(), port = createWindowsSpeechPort({ cacheRoot: root, platform: 'win32', spawnImpl: fake.spawnImpl });
    await assert.rejects(port.synthesize(input()), failure => failure.code === expected && !failure.message.includes(secret));
    assert.equal(await fs.readFile(path.join(root, name), 'utf8'), damaged); await port.close();
  }
  const root = path.join(base, 'changed-owned-lease'), fake = engine(), port = createWindowsSpeechPort({ cacheRoot: root, platform: 'win32', spawnImpl: fake.spawnImpl });
  await port.synthesize(input()); await fs.writeFile(path.join(root, 'windows-speech.lock'), damaged);
  await assert.rejects(port.close(), failure => failure.code === 'WINDOWS_SPEECH_CACHE_LOCK_CHANGED' && !failure.message.includes(secret));
});
