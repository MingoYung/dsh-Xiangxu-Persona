import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

export const WINDOWS_SPEECH_LIMITS = Object.freeze({ textChars: 2000, fileBytes: 8388608, cacheBytes: 16777216, audioFiles: 4, timeoutMs: 60000, metadataBytes: 32768 });
const SCHEMA = 'xiangxu-windows-speech-cache/1', MANIFEST = 'windows-speech-cache.json', LOCK = 'windows-speech.lock';
const SCRIPT = fileURLToPath(new URL('./windows-speech.ps1', import.meta.url));
const NAME = /^xiangxu-speech-[0-9a-f-]{36}\.wav$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const error = code => Object.assign(new Error('Local Windows speech operation could not complete: ' + code), { code });
const unavailable = reason => ({ status: 'unavailable', reason });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeString = value => typeof value === 'string' && Array.from(value).length <= 256 && !/[\u0000-\u001f]/.test(value);
const capabilities = { mime: 'audio/wav', rate: 'approximate_sapi_step', pitch: false, network: false };
function metadataJson(bytes, code) { try { return JSON.parse(bytes.toString('utf8')); } catch { throw error(code); } }

async function safePath(input) {
  const target = path.resolve(input); let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw error('WINDOWS_SPEECH_UNSAFE_PATH'); }
    catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
  }
  return target;
}
async function ordinary(file, maximum) {
  await safePath(file);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > maximum) throw error('WINDOWS_SPEECH_CAPACITY');
  return stat;
}
async function readBounded(file, maximum) {
  await ordinary(file, maximum); const handle = await fs.open(file, 'r');
  try { const buffer = Buffer.alloc(maximum + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); if (bytesRead > maximum) throw error('WINDOWS_SPEECH_CAPACITY'); return buffer.subarray(0, bytesRead); }
  finally { await handle.close(); }
}
function manifestValue(value) {
  if (!plain(value) || value.schemaVersion !== SCHEMA || !Array.isArray(value.files) || value.files.length > WINDOWS_SPEECH_LIMITS.audioFiles) throw error('WINDOWS_SPEECH_CACHE_INVALID');
  const names = new Set(); let bytes = 0;
  for (const file of value.files) {
    if (!plain(file) || !NAME.test(file.name) || names.has(file.name) || !['pending', 'generated'].includes(file.state) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > WINDOWS_SPEECH_LIMITS.fileBytes ||
      !Number.isFinite(file.createdAt) || !/^[0-9a-f]{64}$/.test(file.inputHash) || file.requestHash !== null && !/^[0-9a-f]{64}$/.test(file.requestHash) ||
      file.state === 'generated' && !/^[0-9a-f]{64}$/.test(file.sha256)) throw error('WINDOWS_SPEECH_CACHE_INVALID');
    names.add(file.name); bytes += file.bytes;
  }
  if (bytes > WINDOWS_SPEECH_LIMITS.cacheBytes) throw error('WINDOWS_SPEECH_CAPACITY');
  return value;
}
function inspectWave(bytes) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw error('WINDOWS_SPEECH_INVALID_WAVE');
  let format, dataLength = 0, offset = 12, chunks = 0;
  while (offset + 8 <= bytes.length && chunks++ < 64) {
    const name = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (start + length > bytes.length) throw error('WINDOWS_SPEECH_INVALID_WAVE');
    if (name === 'fmt ') {
      if (format || length < 16) throw error('WINDOWS_SPEECH_INVALID_WAVE');
      const codec = bytes.readUInt16LE(start), channels = bytes.readUInt16LE(start + 2), sampleRate = bytes.readUInt32LE(start + 4), byteRate = bytes.readUInt32LE(start + 8), blockAlign = bytes.readUInt16LE(start + 12), bits = bytes.readUInt16LE(start + 14);
      if (codec !== 1 || channels < 1 || channels > 2 || sampleRate < 8000 || sampleRate > 96000 || bits !== 16 || blockAlign !== channels * 2 || byteRate !== sampleRate * blockAlign) throw error('WINDOWS_SPEECH_INVALID_WAVE');
      format = { codec: 'pcm_s16le', channels, sampleRate, byteRate };
    }
    if (name === 'data') dataLength += length;
    offset = start + length + (length % 2);
  }
  if (!format || !dataLength || offset !== bytes.length) throw error('WINDOWS_SPEECH_INVALID_WAVE');
  const { byteRate, ...result } = format; return { ...result, durationMs: Math.round(dataLength / byteRate * 1000) };
}

/** Local System.Speech generation only. Sending to a platform is a separate injected capability. */
export function createWindowsSpeechPort({ cacheRoot, spawnImpl = spawn, platform = process.platform, timeoutMs = WINDOWS_SPEECH_LIMITS.timeoutMs } = {}) {
  if (typeof cacheRoot !== 'string' || !path.isAbsolute(cacheRoot) || path.resolve(cacheRoot) === path.parse(path.resolve(cacheRoot)).root || typeof spawnImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > WINDOWS_SPEECH_LIMITS.timeoutMs) throw error('WINDOWS_SPEECH_OPTIONS');
  const root = path.resolve(cacheRoot), token = randomUUID(), executable = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let manifest, ownsLock = false, closed = false, tail = Promise.resolve(), activeChild = null, retainedCatalog = null;
  const queue = work => { const result = tail.then(() => closed ? unavailable('closed') : work()); tail = result.catch(() => {}); return result; };
  const target = name => { if (!NAME.test(name)) throw error('WINDOWS_SPEECH_CACHE_INVALID'); return path.join(root, name); };
  async function save(next) {
    manifestValue(next); const location = path.join(root, MANIFEST), temporary = location + '.next';
    await safePath(temporary); const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(next) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await safePath(location); await fs.rename(temporary, location); manifest = next;
  }
  async function releaseLock() {
    if (!ownsLock) return;
    const file = path.join(root, LOCK), current = metadataJson(await readBounded(file, 2048), 'WINDOWS_SPEECH_CACHE_LOCK_CHANGED');
    if (current.token !== token || current.pid !== process.pid) throw error('WINDOWS_SPEECH_CACHE_LOCK_CHANGED');
    await fs.unlink(file); ownsLock = false;
  }
  async function removeFile(file) {
    for (const suffix of ['', '.part']) {
      const location = target(file.name) + suffix; let bytes;
      try {
        await ordinary(location, file.state === 'pending' ? Number.MAX_SAFE_INTEGER : WINDOWS_SPEECH_LIMITS.fileBytes);
        if (file.state === 'pending') { await fs.unlink(location); continue; }
        if (suffix) throw error('WINDOWS_SPEECH_CACHE_CHANGED');
        bytes = await readBounded(location, WINDOWS_SPEECH_LIMITS.fileBytes);
      } catch (failure) { if (failure.code === 'ENOENT') continue; throw failure; }
      if (file.state === 'generated' && !suffix && (bytes.length !== file.bytes || hash(bytes) !== file.sha256)) throw error('WINDOWS_SPEECH_CACHE_CHANGED');
      await fs.unlink(location);
    }
  }
  async function ensureCache() {
    if (ownsLock) return;
    await safePath(root); await fs.mkdir(root, { recursive: true }); await safePath(root);
    const lockPath = path.join(root, LOCK);
    let locked;
    try { locked = await fs.open(lockPath, 'wx', 0o600); }
    catch (failure) {
      if (failure.code !== 'EEXIST') throw failure;
      const previous = metadataJson(await readBounded(lockPath, 2048), 'WINDOWS_SPEECH_CACHE_LOCKED');
      if (previous.schemaVersion !== SCHEMA || !Number.isSafeInteger(previous.pid) || previous.pid < 1 || typeof previous.token !== 'string') throw error('WINDOWS_SPEECH_CACHE_LOCKED');
      let alive = true; try { process.kill(previous.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; }
      if (alive) throw error('WINDOWS_SPEECH_CACHE_LOCKED');
      await fs.unlink(lockPath); locked = await fs.open(lockPath, 'wx', 0o600);
    }
    try { await locked.writeFile(JSON.stringify({ schemaVersion: SCHEMA, pid: process.pid, token })); await locked.sync(); } finally { await locked.close(); }
    ownsLock = true;
    try {
      const location = path.join(root, MANIFEST); let stored;
      try { stored = manifestValue(metadataJson(await readBounded(location, WINDOWS_SPEECH_LIMITS.metadataBytes), 'WINDOWS_SPEECH_CACHE_INVALID')); }
      catch (failure) { if (failure.code !== 'ENOENT') throw failure; stored = { schemaVersion: SCHEMA, files: [] }; }
      const allowed = new Set([MANIFEST, MANIFEST + '.next', LOCK, ...stored.files.flatMap(file => [file.name, file.name + '.part'])]);
      for (const name of await fs.readdir(root)) {
        if (!allowed.has(name)) throw error('WINDOWS_SPEECH_CACHE_UNOWNED');
        const owner = stored.files.find(file => name === file.name || name === file.name + '.part');
        await ordinary(path.join(root, name), owner?.state === 'pending' ? Number.MAX_SAFE_INTEGER : owner ? WINDOWS_SPEECH_LIMITS.fileBytes : WINDOWS_SPEECH_LIMITS.metadataBytes);
      }
      try { const nextPath = location + '.next'; manifestValue(metadataJson(await readBounded(nextPath, WINDOWS_SPEECH_LIMITS.metadataBytes), 'WINDOWS_SPEECH_CACHE_INVALID')); await fs.unlink(nextPath); }
      catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
      manifest = stored;
      for (const file of stored.files.filter(file => file.state === 'pending')) await removeFile(file);
      await save({ ...stored, files: stored.files.filter(file => file.state === 'generated') });
    } catch (failure) { await releaseLock(); throw failure; }
  }
  async function invoke(payload, outputPath) {
    if (closed) return unavailable('closed');
    // Execute only the bundled static helper. No payload field is interpolated
    // into code/arguments, and the OS execution policy is never changed.
    let encoded;
    try { const script = (await fs.readFile(SCRIPT, 'utf8')).replace(/^\uFEFF/, ''); encoded = Buffer.from(script, 'utf16le').toString('base64'); if (encoded.length > 24000) return unavailable('helper_capacity'); }
    catch { return unavailable('helper_unavailable'); }
    return new Promise(resolve => {
      let child, outputBytes = 0, reason = null, settled = false; const stdout = [];
      const finish = value => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(monitor); if (activeChild === child) activeChild = null; resolve(value); };
      const abort = code => { reason ??= code; try { child?.kill(); } catch {} };
      let timer, monitor;
      try {
        child = spawnImpl(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); activeChild = child;
        child.stdout.on('data', chunk => { outputBytes += chunk.length; if (outputBytes > WINDOWS_SPEECH_LIMITS.metadataBytes) abort('process_output_capacity'); else stdout.push(Buffer.from(chunk)); });
        child.stderr.on('data', () => {}); // Never reflect an engine's potentially sensitive error text.
        child.once('error', () => finish(unavailable('process_unavailable')));
        child.once('close', code => {
          if (closed) return finish(unavailable('closed'));
          if (reason) return finish(unavailable(reason));
          if (code !== 0) return finish(unavailable('system_speech_unavailable'));
          let result; try { result = JSON.parse(Buffer.concat(stdout).toString('utf8').trim().replace(/^\uFEFF/, '')); } catch { return finish(unavailable('invalid_engine_response')); }
          finish(result);
        });
        child.stdin.on('error', () => abort('process_input_failed'));
        timer = setTimeout(() => abort('timeout'), timeoutMs);
        if (outputPath) monitor = setInterval(() => { void fs.lstat(outputPath).then(stat => { if (stat.isSymbolicLink() || !stat.isFile()) abort('unsafe_output'); else if (stat.size > WINDOWS_SPEECH_LIMITS.fileBytes) abort('audio_capacity'); }).catch(failure => { if (failure.code !== 'ENOENT') abort('output_unavailable'); }); }, 25);
        child.stdin.end(JSON.stringify(payload));
      } catch { finish(unavailable('process_unavailable')); }
    });
  }
  async function getCatalog(refresh = false) {
    if (platform !== 'win32') return { ...unavailable('unsupported_platform'), supported: false, provider: 'win-sapi', voices: [], capabilities: { ...capabilities } };
    if (retainedCatalog && !refresh) return structuredClone(retainedCatalog);
    const result = await invoke({ action: 'catalog' });
    if (result.status !== 'available' || !Array.isArray(result.voices)) return { ...unavailable(typeof result.reason === 'string' && /^[a-z_]{1,64}$/.test(result.reason) ? result.reason : 'system_speech_unavailable'), supported: false, provider: 'win-sapi', voices: [], capabilities: { ...capabilities } };
    const voices = [];
    for (const voice of result.voices.slice(0, 32)) {
      if (!plain(voice) || !safeString(voice.name) || !voice.name || !safeString(voice.lang) || voice.id !== 'win-sapi:' + voice.name || !safeString(voice.id) || typeof voice.default !== 'boolean') continue;
      const next = { id: voice.id, name: voice.name, lang: voice.lang, default: voice.default, localService: true };
      if (voices.some(item => item.id === next.id) || Buffer.byteLength(JSON.stringify([...voices, next])) > WINDOWS_SPEECH_LIMITS.metadataBytes - 1024) continue;
      voices.push(next);
    }
    retainedCatalog = { status: voices.length ? 'available' : 'unavailable', supported: voices.length > 0, provider: 'win-sapi', voices, capabilities: { ...capabilities }, ...(voices.length ? {} : { reason: 'no_installed_voice' }) };
    return structuredClone(retainedCatalog);
  }
  async function cleanOwned() {
    if (!ownsLock) return { removedFiles: 0, remainingBytes: 0 };
    const old = manifest.files; for (const file of old) await removeFile(file); await save({ ...manifest, files: [] }); return { removedFiles: old.length, remainingBytes: 0 };
  }
  return {
    catalog: ({ refresh = false } = {}) => queue(() => getCatalog(refresh)),
    synthesize(args, { requestId } = {}) { return queue(async () => {
      if (platform !== 'win32') return unavailable('unsupported_platform');
      if (!plain(args) || Object.keys(args).some(key => !['text', 'voiceId', 'rate', 'pitch'].includes(key)) || typeof args.text !== 'string' || !args.text.trim() || Array.from(args.text).length > WINDOWS_SPEECH_LIMITS.textChars || !safeString(args.voiceId) || !args.voiceId?.startsWith('win-sapi:')) return unavailable('invalid_input');
      const rate = args.rate ?? 1, pitch = args.pitch ?? 1;
      if (!Number.isFinite(rate) || rate < 0.1 || rate > 10 || !Number.isFinite(pitch) || pitch < 0 || pitch > 2 || requestId !== undefined && (typeof requestId !== 'string' || requestId.length > 160 || !requestId)) return unavailable('invalid_input');
      if (pitch !== 1) return { status: 'unsupportedPitch', pitchSupported: false, requestedPitch: pitch };
      const list = await getCatalog(); if (!list.supported) return unavailable(list.reason);
      if (!list.voices.some(voice => voice.id === args.voiceId)) return unavailable('voice_unavailable');
      const sapiRate = Math.max(-10, Math.min(10, Math.round(Math.log2(rate) * 10))), inputHash = hash(JSON.stringify([args.text, args.voiceId, rate, pitch])), requestHash = requestId === undefined ? null : hash(requestId);
      await ensureCache();
      const previous = requestHash ? manifest.files.find(file => file.requestHash === requestHash) : null;
      if (previous) {
        if (previous.inputHash !== inputHash) return unavailable('request_conflict');
        if (previous.state === 'generated') {
          const location = target(previous.name), bytes = await readBounded(location, WINDOWS_SPEECH_LIMITS.fileBytes);
          if (hash(bytes) !== previous.sha256) throw error('WINDOWS_SPEECH_CACHE_CHANGED');
          return { status: 'generated', path: location, mime: 'audio/wav', bytes: bytes.length, wave: inspectWave(bytes), voiceId: args.voiceId, rateRequested: rate, sapiRate, rateMapping: 'approximate_sapi_step', pitch: 1, duplicate: true };
        }
      }
      let retained = [...manifest.files];
      while (retained.length >= WINDOWS_SPEECH_LIMITS.audioFiles || retained.reduce((sum, file) => sum + file.bytes, 0) + WINDOWS_SPEECH_LIMITS.fileBytes > WINDOWS_SPEECH_LIMITS.cacheBytes) {
        const oldest = retained.shift(); await removeFile(oldest);
      }
      const entry = { name: 'xiangxu-speech-' + randomUUID() + '.wav', state: 'pending', bytes: 0, sha256: null, createdAt: Date.now(), inputHash, requestHash };
      await save({ ...manifest, files: [...retained, entry] });
      const location = target(entry.name), temporary = location + '.part';
      try {
        await safePath(temporary); const handle = await fs.open(temporary, 'wx', 0o600); await handle.close();
        const result = await invoke({ action: 'synthesize', text: args.text, voiceName: args.voiceId.slice(9), sapiRate, path: temporary, cacheToken: token, maxBytes: WINDOWS_SPEECH_LIMITS.fileBytes }, temporary);
        if (result.status !== 'generated') { await removeFile(entry); await save({ ...manifest, files: retained }); return unavailable(typeof result.reason === 'string' && /^[a-z_]{1,64}$/.test(result.reason) ? result.reason : 'generation_failed'); }
        const bytes = await readBounded(temporary, WINDOWS_SPEECH_LIMITS.fileBytes), wave = inspectWave(bytes);
        await safePath(location); await fs.rename(temporary, location);
        const generated = { ...entry, state: 'generated', bytes: bytes.length, sha256: hash(bytes) };
        await save({ ...manifest, files: [...retained, generated] });
        return { status: 'generated', path: location, mime: 'audio/wav', bytes: bytes.length, wave, voiceId: args.voiceId, rateRequested: rate, sapiRate, rateMapping: 'approximate_sapi_step', pitch: 1, duplicate: false };
      } catch (failure) {
        await removeFile(entry); await save({ ...manifest, files: retained });
        if (['WINDOWS_SPEECH_CAPACITY', 'WINDOWS_SPEECH_INVALID_WAVE'].includes(failure.code)) return unavailable(failure.code === 'WINDOWS_SPEECH_CAPACITY' ? 'audio_capacity' : 'invalid_wave');
        throw failure;
      }
    }); },
    cleanup: () => queue(cleanOwned),
    async close() { if (closed) return; closed = true; try { activeChild?.kill(); } catch {} await tail; try { await cleanOwned(); } finally { await releaseLock(); } },
  };
}
