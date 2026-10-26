import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshCoordinator } from '../adapters/dsh/index.js';
import { createPersonaSurfaces } from '../adapters/dsh/surfaces.js';
import { VOICE_PROFILE_PATH } from '../adapters/dsh/voice.js';

test('actual coordinator exposes voice choices, preserves user playback selection, and unloads the tool', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiangxu-voice-tool-')), tools = new Map();
  const scope = { on() { return () => {}; }, tools: { restrict() { return () => {}; }, register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } } };
  const agent = { id: 'voice-chat', session: { id: 'voice-chat', header: {}, deriveMessages: () => [] }, ctx: scope, inbox: { nextTurn: [], nextStep: [] }, status: 'idle' };
  const c = createDshCoordinator({ agents: { get: () => agent }, get: () => undefined, llm: {} }, { memoryRoot: root, operatorControl: false });
  t.after(async () => { await c.close(); await rm(root, { recursive: true, force: true }); });
  await c.ready; await c.attachAgent(agent);
  assert.deepEqual([...tools.keys()].sort(), ['memory_forget', 'memory_search', 'persona_decide', 'persona_introspect', 'persona_media', 'persona_platform', 'persona_task', 'persona_voice']);
  const catalog = { supported: true, voices: [{ id: 'local-a', name: '本地甲', lang: 'zh-CN', localService: true, default: true }, { id: 'local-b', name: '本地乙', lang: 'zh-CN', localService: true, default: false }] };
  await c.voice.registerCatalog(agent.session.id, catalog);
  const tool = tools.get('persona_voice');
  const selected = await tool.execute({ action: 'select', voiceId: 'local-b', rate: 0.9, pitch: 1.1, reason: '一个当下的选择' }, { agent, callId: 'voice-selection' });
  assert.equal(selected.status, 'selected');
  assert.equal((await c.voice.inspect(agent.session.id)).effective.resolvedVoiceId, 'local-b');
  await c.voice.configure({ mode: 'user', userSelection: { voiceId: 'local-a' } }, { sessionKey: agent.session.id });
  await tool.execute({ action: 'select', rate: 1.15 }, { agent, callId: 'voice-selection-2' });
  const saved = await c.repository.store.readJson(VOICE_PROFILE_PATH);
  assert.equal(saved.personaSelection.rate, 1.15); assert.equal(saved.mode, 'user'); assert.equal(saved.userSelection.voiceId, 'local-a');
  assert.equal(JSON.stringify(saved).includes('当下'), false);
  await c.close(); assert.equal(tools.size, 0);
  assert.equal((await tool.execute({ action: 'inspect' }, { agent })).code, 'INSTANCE_UNLOADED');
});

test('owner surface keeps management, mobile and voice ports distinct and returns a local pairing QR', async () => {
  const calls = [], pairUrl = 'http://192.168.1.4:17653/#pair=' + 'x'.repeat(43);
  const voice = { inspect: async key => ({ key }), configure: async (patch, context) => ({ patch, context }), registerCatalog: async (key, catalog) => ({ key, catalog }) };
  const surfaces = createPersonaSurfaces({ management: { dispatch: async (...args) => { calls.push(args); return 'base'; } },
    mobile: { pair: async () => ({ pairUrl, expiresAt: 123 }), status: async () => ({ enabled: false }) }, getCoordinator: () => ({ ready: Promise.resolve(), voice }) });
  assert.equal(await surfaces.dispatch('status'), 'base');
  assert.deepEqual(await surfaces.dispatch('mobile.status'), { enabled: false });
  const pair = await surfaces.dispatch('mobile.pair'); assert.equal(pair.pairUrl, pairUrl); assert.match(pair.qrDataUrl, /^data:image\/svg\+xml;base64,/);
  assert.deepEqual(await surfaces.dispatch('voice.configure', { sessionKey: 'known', patch: { mode: 'user' } }), { patch: { mode: 'user' }, context: { sessionKey: 'known' } });
  assert.deepEqual(calls, [['status', {}]]);
  await assert.rejects(surfaces.dispatch('mobile.execute', { command: 'not-a-chat-action' }), { code: 'BAD_MANAGEMENT_REQUEST' });
  await assert.rejects(surfaces.dispatch('voice.select'), { code: 'BAD_MANAGEMENT_REQUEST' });
});

test('owner voice settings require a loaded instance; a QR rendering boundary does not repeat pairing', async () => {
  let pairs = 0;
  const surfaces = createPersonaSurfaces({ management: { dispatch: async () => null }, getCoordinator: () => null,
    mobile: { pair: async () => { pairs++; return { pairUrl: 'https://example.com/not-a-pair-link', expiresAt: 123 }; } } });
  await assert.rejects(surfaces.dispatch('voice.inspect'), { code: 'INSTANCE_UNLOADED' });
  const result = await surfaces.dispatch('mobile.pair'); assert.equal(result.qrUnavailable, true); assert.equal(result.qrDataUrl, null); assert.equal(pairs, 1);
});

test('coordinator-restored phone agents retain a dedicated chat scope and personality tools', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiangxu-phone-scope-')), calls = [], tools = new Map();
  let released = false;
  const scope = { on() { return () => {}; }, tools: {
    restrict(value) { calls.push(value); return () => { released = true; }; },
    register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); },
  } };
  const agent = { id: 'xiangxu-mobile-restored', session: { id: 'xiangxu-mobile-restored', header: {}, deriveMessages: () => [] }, ctx: scope, inbox: { nextTurn: [], nextStep: [] }, status: 'idle' };
  const c = createDshCoordinator({ agents: { get: () => agent }, get: () => undefined, llm: {} }, { memoryRoot: root, operatorControl: false });
  t.after(async () => { await c.close(); await rm(root, { recursive: true, force: true }); });
  await c.ready; await c.attachAgent(agent); await c.attachAgent(agent);
  assert.deepEqual(calls, [{ allow: [] }]); assert.ok(tools.has('persona_decide')); assert.ok(tools.has('persona_voice'));
  await c.close(); assert.equal(released, true); assert.equal(tools.size, 0);
});
