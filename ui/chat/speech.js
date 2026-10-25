// Device speech uses the browser's existing voices; no model, download or external TTS request is added.
const MAX_VOICES = 32, MAX_TEXT = 16000;
const clone = value => JSON.parse(JSON.stringify(value));
const bounded = value => Array.from(String(value ?? '')).slice(0, 256).join('').replace(/[\u0000-\u001f]/g, '');
function voiceId(voice) {
  const value = [voice.voiceURI, voice.name, voice.lang, voice.localService === true ? 'local' : 'remote'].map(bounded).join('\u0000');
  let hash = 0xcbf29ce484222325n;
  for (const point of value) { hash ^= BigInt(point.codePointAt(0)); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
  // A stable catalog identifier, not an authentication credential.
  return 'web-' + hash.toString(16).padStart(16, '0');
}
export function createSpeechController({ scope = globalThis, onState = () => {}, onCatalog = () => {} } = {}) {
  const synth = scope.speechSynthesis, Utterance = scope.SpeechSynthesisUtterance;
  const supported = Boolean(synth && typeof synth.getVoices === 'function' && typeof synth.speak === 'function' && typeof Utterance === 'function');
  let disposed = false, unlocked = false, enabled = false, preferences = { mode: 'persona', allowRemoteVoices: false,
    userSelection: { voiceId: null, rate: 1, pitch: 1 }, personaSelection: { voiceId: null, rate: 1, pitch: 1 } };
  let catalog = { supported, voices: [] }, actual = new Map(), status = supported ? 'disabled' : 'unsupported', error = null, active = null, generation = 0;
  const notify = callback => { try { const result = callback(); if (result?.catch) result.catch(() => {}); } catch {} };
  const state = () => ({ supported, unlocked, enabled, status, error, voiceCount: catalog.voices.length, speaking: Boolean(active) });
  const emit = () => notify(() => onState(state()));
  function refresh() {
    if (disposed) return;
    if (!supported) { notify(() => onCatalog(clone(catalog))); emit(); return; }
    let voices; try { voices = Array.from(synth.getVoices()); } catch { voices = []; }
    const languages = (scope.navigator?.languages ?? [scope.navigator?.language]).filter(value => typeof value === 'string').slice(0, 32).map(value => value.toLowerCase().replaceAll('_', '-'));
    const languageRank = voice => {
      const lang = String(voice.lang ?? '').toLowerCase().replaceAll('_', '-');
      const exact = languages.indexOf(lang); if (exact >= 0) return exact;
      const primary = languages.findIndex(value => value.split('-')[0] === lang.split('-')[0]);
      return primary >= 0 ? 32 + primary : 64;
    };
    // Preserve device defaults and preferred languages inside the bounded catalog.
    // This is availability ordering, never a personality-to-voice assignment.
    voices.sort((a, b) => Number(b.localService === true) - Number(a.localService === true) || Number(b.default === true) - Number(a.default === true) || languageRank(a) - languageRank(b));
    const next = [], mapped = new Map();
    for (const voice of voices) {
      const id = voiceId(voice); if (mapped.has(id) || !bounded(voice.name)) continue;
      mapped.set(id, voice); next.push({ id, name: bounded(voice.name), lang: bounded(voice.lang), localService: voice.localService === true, default: voice.default === true });
      if (next.length >= MAX_VOICES) break;
    }
    actual = mapped; const changed = JSON.stringify(next) !== JSON.stringify(catalog.voices); catalog = { supported, voices: next };
    if (enabled && !active) status = next.some(voice => voice.localService || preferences.allowRemoteVoices) ? 'ready' : 'no_permitted_voice';
    if (changed) notify(() => onCatalog(clone(catalog))); emit();
  }
  function selectedVoice() {
    const selection = preferences.mode === 'user' ? preferences.userSelection : preferences.personaSelection;
    const allowed = catalog.voices.filter(voice => voice.localService || preferences.allowRemoteVoices);
    const selected = selection.voiceId === null ? allowed.find(voice => voice.default && voice.localService) ?? allowed.find(voice => voice.localService) ?? (preferences.allowRemoteVoices ? allowed.find(voice => voice.default) ?? allowed[0] : null)
      : allowed.find(voice => voice.id === selection.voiceId);
    return { selection, selected, voice: selected ? actual.get(selected.id) : null };
  }
  function stop() { generation++; active = null; try { synth?.cancel(); } catch {} status = disposed ? 'closed' : enabled ? selectedVoice().voice ? 'ready' : 'voice_unavailable' : supported ? 'disabled' : 'unsupported'; emit(); }
  const changed = () => refresh();
  if (supported) synth.addEventListener?.('voiceschanged', changed);
  refresh();
  return {
    getState: () => state(), getCatalog: () => clone(catalog),
    setPreferences(value = {}) {
      if (disposed) return state();
      const next = { ...preferences, mode: value.mode ?? preferences.mode, allowRemoteVoices: value.allowRemoteVoices ?? preferences.allowRemoteVoices };
      if (!['persona', 'user'].includes(next.mode) || typeof next.allowRemoteVoices !== 'boolean') throw new TypeError('Invalid speech preferences');
      for (const name of ['userSelection', 'personaSelection']) {
        const candidate = { ...preferences[name], ...value[name] };
        if (candidate.voiceId !== null && (typeof candidate.voiceId !== 'string' || candidate.voiceId.length > 256)) throw new TypeError('Invalid speech voice');
        if (!Number.isFinite(candidate.rate) || candidate.rate < 0.1 || candidate.rate > 10 || !Number.isFinite(candidate.pitch) || candidate.pitch < 0 || candidate.pitch > 2) throw new TypeError('Invalid speech delivery');
        next[name] = candidate;
      }
      const playbackKey = config => JSON.stringify([config.mode, config.allowRemoteVoices, config.mode === 'user' ? config.userSelection : config.personaSelection]);
      if (active && playbackKey(preferences) !== playbackKey(next)) stop(); preferences = next;
      if (value.enabled === false) { enabled = false; stop(); }
      if (enabled && !active) { const selected = selectedVoice(); status = selected.voice ? 'ready' : 'voice_unavailable'; }
      emit(); return state();
    },
    enableFromGesture() {
      if (disposed || !supported) return { ok: false, reason: disposed ? 'closed' : 'unsupported' };
      if (scope.navigator?.userActivation && scope.navigator.userActivation.isActive === false) { status = 'gesture_required'; emit(); return { ok: false, reason: status }; }
      unlocked = true; enabled = true; error = null;
      try { synth.resume?.(); } catch {}
      const selected = selectedVoice(); status = selected.voice ? 'ready' : 'no_permitted_voice'; emit();
      return { ok: Boolean(selected.voice), reason: selected.voice ? null : status };
    },
    speak(text, { id = null } = {}) {
      if (disposed || !supported || !enabled || !unlocked) return { ok: false, reason: disposed ? 'closed' : !supported ? 'unsupported' : 'gesture_required' };
      if (typeof text !== 'string' || !text.trim() || Array.from(text).length > MAX_TEXT) { status = 'invalid_text'; emit(); return { ok: false, reason: status }; }
      const { selection, voice } = selectedVoice();
      if (!voice) { status = 'voice_unavailable'; emit(); return { ok: false, reason: status }; }
      stop(); const utterance = new Utterance(text), ticket = ++generation;
      utterance.voice = voice; utterance.lang = voice.lang; utterance.rate = selection.rate; utterance.pitch = selection.pitch; utterance.volume = 1;
      active = { id, utterance }; status = 'queued'; error = null;
      utterance.onstart = () => { if (disposed || generation !== ticket) return; status = 'speaking'; emit(); };
      utterance.onend = () => { if (disposed || generation !== ticket) return; active = null; status = 'ready'; emit(); };
      utterance.onerror = event => { if (disposed || generation !== ticket) return; active = null; status = 'error'; error = bounded(event?.error || 'speech_failed'); emit(); };
      try { synth.speak(utterance); emit(); return { ok: true, status: 'queued', id }; }
      catch { active = null; status = 'error'; error = 'speech_failed'; emit(); return { ok: false, reason: error }; }
    },
    stop,
    dispose() { if (disposed) return; disposed = true; enabled = false; stop(); synth?.removeEventListener?.('voiceschanged', changed); actual.clear(); },
  };
}
