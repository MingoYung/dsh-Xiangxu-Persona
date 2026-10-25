import { randomUUID } from 'node:crypto';

export const VOICE_PROFILE_PATH = 'voice/profile.json';
export const VOICE_LIMITS = Object.freeze({ sessions: 8, voices: 32, catalogBytes: 32768, profileBytes: 16384, stringChars: 256 });
const schemaVersion = 'xiangxu-voice/1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const failure = (code, message) => Object.assign(new Error(message), { code });
const fail = message => { throw failure('VOICE_INVALID', message); };
const text = (value, name, { empty = false } = {}) => {
  if (typeof value !== 'string' || (!empty && !value) || Array.from(value).length > VOICE_LIMITS.stringChars || /[\u0000-\u001f]/.test(value)) fail(`${name} must be bounded plain text`);
  return value;
};
function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('Unexpected voice fields');
}
function bounded(value, limit, label) { if (Buffer.byteLength(JSON.stringify(value)) > limit) fail(`${label} exceeds its technical capacity`); }
function selection(value, previous = { voiceId: null, rate: 1, pitch: 1 }) {
  fields(value, ['voiceId', 'rate', 'pitch']);
  const next = { ...previous, ...value };
  if (next.voiceId !== null) text(next.voiceId, 'voiceId');
  if (!Number.isFinite(next.rate) || next.rate < 0.1 || next.rate > 10) fail('rate must be 0.1..10');
  if (!Number.isFinite(next.pitch) || next.pitch < 0 || next.pitch > 2) fail('pitch must be 0..2');
  return next;
}
function initial() {
  return { schemaVersion, version: 0, updatedAt: 0, mode: 'persona', allowRemoteVoices: false,
    userSelection: { voiceId: null, rate: 1, pitch: 1 }, personaSelection: { voiceId: null, rate: 1, pitch: 1 } };
}
function validateProfile(value) {
  fields(value, ['schemaVersion', 'version', 'updatedAt', 'mode', 'allowRemoteVoices', 'userSelection', 'personaSelection']);
  if (value.schemaVersion !== schemaVersion || !Number.isSafeInteger(value.version) || value.version < 0 || !Number.isFinite(value.updatedAt) ||
    !['persona', 'user'].includes(value.mode) || typeof value.allowRemoteVoices !== 'boolean') fail('Invalid voice profile');
  const next = { ...value, userSelection: selection(value.userSelection), personaSelection: selection(value.personaSelection) };
  bounded(next, VOICE_LIMITS.profileBytes, 'Voice profile'); return next;
}
function catalogInput(value) {
  fields(value, ['supported', 'voices']);
  if (typeof value.supported !== 'boolean' || !Array.isArray(value.voices) || value.voices.length > VOICE_LIMITS.voices || (!value.supported && value.voices.length)) fail('Invalid device voice catalog');
  const ids = new Set();
  const voices = value.voices.map(voice => {
    fields(voice, ['id', 'name', 'lang', 'localService', 'default']);
    const result = { id: text(voice.id, 'voice.id'), name: text(voice.name, 'voice.name'), lang: text(voice.lang, 'voice.lang', { empty: true }),
      localService: voice.localService, default: voice.default };
    if (typeof result.localService !== 'boolean' || typeof result.default !== 'boolean' || ids.has(result.id)) fail('Invalid or duplicate voice catalog entry');
    ids.add(result.id); return result;
  });
  const next = { supported: value.supported, voices }; bounded(next, VOICE_LIMITS.catalogBytes, 'Voice catalog'); return next;
}

/** Presentation preferences only. No generation, model call, network endpoint or personality classification. */
export function createVoiceService({ store, clock = Date.now } = {}) {
  if (typeof store?.readJson !== 'function' || typeof store?.transaction !== 'function') throw new TypeError('A voice service uses the current coordinator store');
  const catalogs = new Map(); let profile, tail = Promise.resolve(), closed = false;
  const queue = work => { const result = tail.then(async () => { if (closed) throw failure('VOICE_CLOSED', 'Voice preferences are closed'); return work(); }); tail = result.catch(() => {}); return result; };
  const load = async () => { if (!profile) profile = validateProfile(await store.readJson(VOICE_PROFILE_PATH, initial())); return profile; };
  function sessionId(value) { return text(value, 'sessionKey'); }
  function currentCatalog(key) { return catalogs.get(key) ?? { supported: false, voices: [] }; }
  function selectedForDevice(key) {
    const selected = profile.mode === 'user' ? profile.userSelection : profile.personaSelection;
    const catalog = currentCatalog(key), candidates = catalog.voices.filter(voice => voice.localService || profile.allowRemoteVoices);
    const voice = selected.voiceId === null ? candidates.find(voice => voice.default && voice.localService) ?? candidates.find(voice => voice.localService) ?? (profile.allowRemoteVoices ? candidates.find(voice => voice.default) ?? candidates[0] : null)
      : candidates.find(voice => voice.id === selected.voiceId);
    return { ...selected, source: profile.mode, available: Boolean(catalog.supported && voice), resolvedVoiceId: voice?.id ?? null,
      reason: !catalog.supported ? 'device_speech_unavailable' : !voice ? selected.voiceId === null ? 'no_permitted_voice' : 'selected_voice_unavailable' : null };
  }
  function snapshot(key) { return copy({ ...profile, catalog: currentCatalog(key), effective: selectedForDevice(key) }); }
  function validateSelectedVoice(voiceId, key, allowRemote = profile.allowRemoteVoices) {
    if (voiceId === null) return;
    const voice = currentCatalog(key).voices.find(item => item.id === voiceId);
    if (!voice) throw failure('VOICE_UNAVAILABLE', 'The selected voice is unavailable on this device');
    if (!voice.localService && !allowRemote) throw failure('VOICE_REMOTE_DISABLED', 'Online voices require the user to enable them');
  }
  async function persist(next) {
    const checked = validateProfile(next);
    if (JSON.stringify({ ...checked, version: 0, updatedAt: 0 }) === JSON.stringify({ ...profile, version: 0, updatedAt: 0 })) return;
    checked.version = profile.version + 1; checked.updatedAt = clock(); validateProfile(checked);
    await store.transaction({ runId: 'voice-' + randomUUID(), expectedVersions: { [VOICE_PROFILE_PATH]: profile.version }, json: { [VOICE_PROFILE_PATH]: checked } });
    profile = checked;
  }
  return {
    registerCatalog(key, value) { return queue(async () => {
      sessionId(key); await load(); const catalog = catalogInput(value);
      bounded([[key, catalog]], VOICE_LIMITS.catalogBytes, 'Device voice catalog');
      // Keep only the most recently advertised device metadata; no transcript or credential is stored here.
      catalogs.delete(key); catalogs.set(key, catalog);
      while (catalogs.size > VOICE_LIMITS.sessions) catalogs.delete(catalogs.keys().next().value);
      while (Buffer.byteLength(JSON.stringify([...catalogs])) > VOICE_LIMITS.catalogBytes && catalogs.size > 1) catalogs.delete(catalogs.keys().next().value);
      return snapshot(key);
    }); },
    inspect(key) { return queue(async () => { if (key !== undefined && key !== null) sessionId(key); await load(); return snapshot(key); }); },
    configure(patch, { sessionKey } = {}) { return queue(async () => {
      fields(patch, ['mode', 'allowRemoteVoices', 'userSelection']); if (sessionKey !== undefined) sessionId(sessionKey); await load();
      const next = { ...profile, ...patch };
      if (patch.userSelection !== undefined) {
        next.userSelection = selection(patch.userSelection, profile.userSelection);
        if (sessionKey !== undefined) validateSelectedVoice(next.userSelection.voiceId, sessionKey, next.allowRemoteVoices);
      }
      await persist(next); return snapshot(sessionKey);
    }); },
    decide(args = {}, { sessionKey } = {}) { return queue(async () => {
      fields(args, ['action', 'voiceId', 'rate', 'pitch', 'reason']); if (sessionKey !== undefined) sessionId(sessionKey); await load();
      if (args.action === undefined || args.action === 'inspect') {
        if (Object.keys(args).some(key => key !== 'action')) fail('Inspect does not accept a selection');
        return snapshot(sessionKey);
      }
      if (args.action !== 'select') fail('Unknown voice action');
      const proposed = Object.fromEntries(['voiceId', 'rate', 'pitch'].filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]]));
      if (!Object.keys(proposed).length) fail('Select requires a voice or delivery preference');
      const nextSelection = selection(proposed, profile.personaSelection);
      validateSelectedVoice(nextSelection.voiceId, sessionKey);
      const reason = args.reason === undefined ? null : text(args.reason, 'reason', { empty: true });
      const next = { ...profile, personaSelection: nextSelection };
      await persist(next); return { status: profile.mode === 'user' ? 'saved_for_persona_mode' : 'selected', ...snapshot(sessionKey), ...(reason === null ? {} : { selectionReason: reason }) };
    }); },
    forgetCatalog(key) { sessionId(key); catalogs.delete(key); },
    async close() { closed = true; await tail; catalogs.clear(); },
  };
}
