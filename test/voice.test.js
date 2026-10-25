import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../core/store.js';
import { createVoiceService, VOICE_PROFILE_PATH, VOICE_LIMITS } from '../adapters/dsh/voice.js';
import { createSpeechController } from '../ui/chat/speech.js';

const catalog = { supported: true, voices: [
  { id: 'local-a', name: 'Local A', lang: 'zh-CN', localService: true, default: false },
  { id: 'local-b', name: 'Local B', lang: 'en-US', localService: true, default: false },
  { id: 'remote', name: 'Remote', lang: 'zh-CN', localService: false, default: true },
] };
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'xiangxu-voice-')), store = new JsonStore(root); await store.open();
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  return { store, root };
}

test('voice inspection and device metadata do not generate audio or write a profile', async t => {
  const { store } = await setup(t), service = createVoiceService({ store });
  const empty = await service.inspect('device-session');
  assert.equal(empty.catalog.supported, false); assert.equal(empty.effective.reason, 'device_speech_unavailable');
  const registered = await service.registerCatalog('device-session', catalog);
  assert.equal(registered.mode, 'persona'); assert.equal(registered.allowRemoteVoices, false);
  assert.equal(registered.effective.resolvedVoiceId, 'local-a');
  assert.equal(await store.readJson(VOICE_PROFILE_PATH, null), null);
});

test('persona chooses a voice explicitly, user selection wins, and preferences survive reload', async t => {
  const { store } = await setup(t); let service = createVoiceService({ store, clock: () => 123 });
  await service.registerCatalog('session', catalog);
  await assert.rejects(service.decide({ action: 'select', voiceId: 'remote' }, { sessionKey: 'session' }), { code: 'VOICE_REMOTE_DISABLED' });
  const selected = await service.decide({ action: 'select', voiceId: 'local-b', rate: 0.95, pitch: 1.1, reason: 'I prefer this available voice.' }, { sessionKey: 'session' });
  assert.equal(selected.effective.resolvedVoiceId, 'local-b');
  assert.equal(selected.selectionReason, 'I prefer this available voice.'); assert.equal(JSON.stringify(await store.readJson(VOICE_PROFILE_PATH)).includes('I prefer'), false, 'technical voice preferences do not create an untracked narrative memory');
  await service.configure({ mode: 'user', userSelection: { voiceId: 'local-a', rate: 1.2 } }, { sessionKey: 'session' });
  const dormant = await service.decide({ action: 'select', rate: 1.05 }, { sessionKey: 'session' });
  assert.equal(dormant.status, 'saved_for_persona_mode'); assert.equal(dormant.effective.resolvedVoiceId, 'local-a');
  assert.equal(dormant.effective.rate, 1.2); assert.equal(dormant.personaSelection.rate, 1.05);
  await service.close(); service = createVoiceService({ store });
  const cold = await service.inspect('session');
  assert.equal(cold.mode, 'user'); assert.equal(cold.userSelection.voiceId, 'local-a'); assert.equal(cold.personaSelection.voiceId, 'local-b');
  assert.equal(cold.catalog.supported, false);
  await service.registerCatalog('session', catalog);
  assert.equal((await service.inspect('session')).effective.resolvedVoiceId, 'local-a');
  const resumed = await service.configure({ mode: 'persona' }, { sessionKey: 'session' });
  assert.equal(resumed.effective.resolvedVoiceId, 'local-b'); assert.equal(resumed.effective.rate, 1.05);
});

test('unavailable selected voice stays unavailable instead of falling back to a cloud default', async t => {
  const { store } = await setup(t), service = createVoiceService({ store });
  await service.registerCatalog('session', catalog); await service.decide({ action: 'select', voiceId: 'local-a' }, { sessionKey: 'session' });
  const missing = await service.registerCatalog('session', { supported: true, voices: [catalog.voices[2]] });
  assert.equal(missing.effective.available, false); assert.equal(missing.effective.resolvedVoiceId, null); assert.equal(missing.effective.reason, 'selected_voice_unavailable');
  await service.configure({ allowRemoteVoices: true });
  assert.equal((await service.inspect('session')).effective.available, false);
});

test('voice writes serialize without lost settings, and a failed persistence does not change live preferences', async t => {
  const { store } = await setup(t); let rejectNext = false;
  const port = { readJson: (...args) => store.readJson(...args), transaction: (...args) => {
    if (rejectNext) { rejectNext = false; throw Object.assign(new Error('injected disk refusal'), { code: 'EIO' }); }
    return store.transaction(...args);
  } };
  const service = createVoiceService({ store: port }); await service.registerCatalog('session', catalog);
  await Promise.all([service.configure({ mode: 'user' }), service.decide({ action: 'select', voiceId: 'local-b' }, { sessionKey: 'session' })]);
  const committed = await store.readJson(VOICE_PROFILE_PATH);
  assert.equal(committed.version, 2); assert.equal(committed.mode, 'user'); assert.equal(committed.personaSelection.voiceId, 'local-b');
  rejectNext = true;
  await assert.rejects(service.configure({ allowRemoteVoices: true }), { code: 'EIO' });
  assert.equal((await service.inspect('session')).allowRemoteVoices, false); assert.equal((await store.readJson(VOICE_PROFILE_PATH)).version, 2);
  await service.configure({ allowRemoteVoices: true }); assert.equal((await store.readJson(VOICE_PROFILE_PATH)).version, 3);
});

test('voice metadata has bounded count, byte size, field types and session retention', async t => {
  const { store } = await setup(t), service = createVoiceService({ store });
  await assert.rejects(service.registerCatalog('s', { ...catalog, voices: Array.from({ length: 33 }, (_, i) => ({ ...catalog.voices[0], id: 'v-' + i })) }), { code: 'VOICE_INVALID' });
  await assert.rejects(service.registerCatalog('s', { supported: true, voices: [{ ...catalog.voices[0], localService: 'true' }] }), { code: 'VOICE_INVALID' });
  await assert.rejects(service.registerCatalog('s', { ...catalog, voices: [catalog.voices[0], catalog.voices[0]] }), { code: 'VOICE_INVALID' });
  await assert.rejects(service.configure({ endpoint: 'https://example.invalid' }), { code: 'VOICE_INVALID' });
  await assert.rejects(service.decide({ action: 'select', rate: 11 }), { code: 'VOICE_INVALID' });
  for (let i = 0; i < VOICE_LIMITS.sessions + 1; i++) await service.registerCatalog('session-' + i, catalog);
  assert.equal((await service.inspect('session-0')).catalog.supported, false);
  const large = { supported: true, voices: Array.from({ length: 32 }, (_, i) => ({ id: 'v' + i, name: '音'.repeat(200), lang: 'zh-CN', localService: true, default: false })) };
  await service.registerCatalog('large-a', large); await service.registerCatalog('large-b', large);
  assert.equal((await service.inspect('large-a')).catalog.supported, false);
  assert.equal((await service.inspect('large-b')).catalog.voices.length, 32);
  await service.close(); await assert.rejects(service.inspect('session'), { code: 'VOICE_CLOSED' });
});

function fakeBrowser(voices, { active = true, supported = true } = {}) {
  const listeners = new Map(), spoken = [];
  const synth = { getVoices: () => voices, speak: utterance => spoken.push(utterance), cancel() {}, resume() {},
    addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) };
  const scope = { navigator: { userActivation: { isActive: active } }, ...(supported ? { speechSynthesis: synth, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } } } : {}) };
  return { scope, spoken, listeners };
}
const nativeVoices = [
  { voiceURI: 'cloud', name: 'Cloud default', lang: 'zh-CN', localService: false, default: true },
  { voiceURI: 'local', name: 'Local device', lang: 'zh-CN', localService: true, default: false },
];

test('device speech needs user activation and pins the actual local voice object', () => {
  const browser = fakeBrowser(nativeVoices), speech = createSpeechController({ scope: browser.scope });
  assert.equal(speech.speak('hello').reason, 'gesture_required'); assert.equal(browser.spoken.length, 0);
  assert.equal(speech.enableFromGesture().ok, true);
  assert.equal(speech.speak('你好', { id: 'message-1' }).ok, true);
  assert.equal(browser.spoken[0].voice, nativeVoices[1]); assert.equal(browser.spoken[0].text, '你好');
  const playing = browser.spoken[0]; playing.onstart(); assert.equal(speech.getState().status, 'speaking');
  speech.setPreferences({ mode: 'persona', allowRemoteVoices: false, personaSelection: { voiceId: null, rate: 1, pitch: 1 }, version: 7 });
  assert.equal(speech.getState().status, 'speaking', 'unchanged poll preferences must not stop audio');
  playing.onend(); assert.equal(speech.getState().status, 'ready'); speech.dispose(); assert.equal(speech.getState().status, 'closed');
});

test('device speech handles unsupported, denied activation, unavailable and remote-only voices honestly', () => {
  const unavailable = createSpeechController({ scope: fakeBrowser([], { supported: false }).scope });
  assert.equal(unavailable.enableFromGesture().reason, 'unsupported');
  const denied = createSpeechController({ scope: fakeBrowser(nativeVoices, { active: false }).scope });
  assert.equal(denied.enableFromGesture().reason, 'gesture_required');
  const browser = fakeBrowser([nativeVoices[0]]), speech = createSpeechController({ scope: browser.scope });
  assert.equal(speech.enableFromGesture().reason, 'no_permitted_voice'); assert.equal(speech.speak('secret').reason, 'voice_unavailable'); assert.equal(browser.spoken.length, 0);
  speech.setPreferences({ allowRemoteVoices: true }); assert.equal(speech.speak('explicitly allowed').ok, true); assert.equal(browser.spoken[0].voice.localService, false);
  speech.setPreferences({ personaSelection: { voiceId: 'missing' } }); assert.equal(speech.speak('do not fall back').reason, 'voice_unavailable'); assert.equal(browser.spoken.length, 1);
  speech.setPreferences({ personaSelection: { voiceId: null } });
  assert.equal(speech.speak('x'.repeat(16001)).reason, 'invalid_text'); assert.equal(browser.spoken.length, 1);
  speech.dispose(); denied.dispose(); unavailable.dispose();
});

test('device catalog identifiers are stable, metadata is bounded and late browser voices are observed', () => {
  const browser = fakeBrowser([]), catalogs = [], speech = createSpeechController({ scope: browser.scope, onCatalog: catalog => catalogs.push(catalog) });
  browser.scope.speechSynthesis.getVoices = () => nativeVoices; browser.listeners.get('voiceschanged')();
  const id = speech.getCatalog().voices.find(voice => voice.localService).id;
  assert.match(id, /^web-[0-9a-f]{16}$/); assert.equal(catalogs.length, 1);
  browser.listeners.get('voiceschanged')(); assert.equal(catalogs.length, 1);
  const another = createSpeechController({ scope: browser.scope }); assert.equal(another.getCatalog().voices.find(voice => voice.localService).id, id);
  browser.scope.speechSynthesis.getVoices = () => Array.from({ length: 40 }, (_, i) => ({ ...nativeVoices[1], name: '音'.repeat(300) + i, voiceURI: String(i) }));
  browser.listeners.get('voiceschanged')(); assert.equal(another.getCatalog().voices.length, 32); assert.equal(Array.from(another.getCatalog().voices[0].name).length, 256);
  speech.dispose(); another.dispose();
});

test('a bounded catalog retains the local system default and preferred language when more than 32 voices exist', () => {
  const voices = Array.from({ length: 38 }, (_, index) => ({ voiceURI: 'other-' + index, name: 'Other ' + index, lang: 'fr-FR', localService: true, default: false }));
  voices.push({ voiceURI: 'preferred', name: 'Preferred Chinese', lang: 'zh-CN', localService: true, default: false });
  voices.push({ voiceURI: 'default', name: 'System Default', lang: 'en-US', localService: true, default: true });
  const browser = fakeBrowser(voices); browser.scope.navigator.languages = ['zh-CN', 'en-US'];
  const speech = createSpeechController({ scope: browser.scope }), advertised = speech.getCatalog().voices;
  assert.equal(advertised.length, 32); assert.equal(advertised[0].name, 'System Default'); assert.equal(advertised[1].name, 'Preferred Chinese');
  speech.dispose();
});
