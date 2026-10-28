import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildSnapshot } from '../core/prompts.js';
import { defaultConfig } from '../core/schema.js';
import { MemoryRepository } from '../core/repository.js';
import { PersonaRuntime } from '../core/runtime.js';
import { createDshCoordinator } from '../adapters/dsh/index.js';

const counter = { method: 'test_characters', count: async text => Array.from(text).length };
const baseContext = { personId: null, sessionId: 'test-session', channelId: 'dsh:test-session' };
const config = overrides => defaultConfig(overrides);
const original = (id, text, extra = {}) => ({ id, eventId: 1, sourceSessionId: 'test-session', sourceEventId: id,
  sourceKind: 'user', contentClass: 'participant_dialogue', role: 'user', origin: 'user', personId: null,
  speakerId: null, channelId: 'dsh:test-session', text, chars: Array.from(text).length, sourceAt: 100, observedAt: 100, ...extra });
const snapshot = (material, extra = {}) => buildSnapshot({ material, state: {}, context: baseContext,
  config: config(), now: 200, counter, ...extra });

test('the complete anchor, axes and current self description survive local caps without changing the total cap', async () => {
  const anchor = 'The same continuing self. '.repeat(8), axis = 'My own description. '.repeat(9), selfDescription = '我当前对自己的完整理解。'.repeat(12);
  const result = await snapshot({ persona: { anchor: { text: anchor }, axes: { own: { desc: axis } } },
    selfProfile: { version: 1, mode: 'together', current: { name: '相续', selfDescription }, initial: {} } },
  { config: config({ contextBudget: { anchorTokens: 3, personaTokens: 3, selfProfileTokens: 3 } }) });
  assert.ok(result.injectedText.includes(anchor)); assert.ok(result.injectedText.includes(axis)); assert.ok(result.injectedText.includes(selfDescription));
  assert.equal(result.mandatoryContext.complete, true); assert.ok(result.tokens <= 2970);
  assert.ok(result.budgetAdjustments.some(item => item.reason === 'preserve_complete_personality_core'));
  for (const name of ['anchor', 'persona', 'self_profile']) assert.equal(result.segments.find(item => item.name === name).truncated, false);
});

test('an oversized current self description is a technical failure rather than an omitted identity', async () => {
  await assert.rejects(snapshot({ persona: { anchor: { text: '' } },
    selfProfile: { version: 1, mode: 'together', current: { selfDescription: '我'.repeat(6000) }, initial: {} } }), { code: 'PERSONA_CONTEXT_BUDGET' });
});

test('empty new identities are valid and explicit recent availability is still included', async () => {
  const result = await snapshot({ persona: { anchor: { text: '' }, axes: {} }, selfProfile: { version: 0, current: {}, initial: {} } });
  assert.equal(result.mandatoryContext.complete, true); assert.equal(result.recentMemoryReference.shown, 0);
  assert.deepEqual(result.selfProfileReference.shown, []); assert.ok(result.injectedText.includes('[recent_memory]'));
});

test('whole optional facets and habits report their actual shown and omitted identities', async () => {
  const result = await snapshot({ persona: { anchor: { text: 'Stable' }, axes: {},
    facets: [{ id: 'fits', desc: 'A complete brief trait.' }, { id: 'large', desc: 'A long trait '.repeat(1000) }],
    habits: [{ id: 'habit', text: 'A complete habit.' }] } });
  assert.ok(result.injectedText.includes('A complete brief trait.')); assert.ok(result.injectedText.includes('A complete habit.'));
  assert.ok(!result.injectedText.includes('A long trait'));
  assert.deepEqual(result.mandatoryContext.optional.persona.omitted, ['facets:large']);
  assert.ok(result.injectedIds.includes('fits')); assert.ok(!result.injectedIds.includes('large'));
});

test('recent originals carry actual speakers and bounded Unicode ranges without consuming their source', async () => {
  const record = original('long-original', '开始😀' + '记忆细节'.repeat(1000), { role: 'assistant', origin: 'ai_reply', speakerId: 'assistant-self' });
  const before = structuredClone(record);
  const result = await snapshot({ persona: { anchor: { text: '' } }, recentMemory: { items: [record], total: 1, omitted: 0, preferredDays: 3, asOf: 200 } });
  const segment = result.segments.find(item => item.name === 'recent_memory'), value = JSON.parse(segment.text.split('\n')[1]), visible = value.items[0];
  assert.equal(visible.role, 'assistant'); assert.equal(visible.speakerId, 'assistant-self'); assert.equal(visible.sourceEventId, record.sourceEventId);
  assert.equal(visible.text, Array.from(record.text).slice(visible.fragment.from, visible.fragment.to).join(''));
  assert.equal(visible.fragment.complete, false); assert.equal(visible.fragment.total, Array.from(record.text).length);
  assert.equal(result.recentMemoryReference.truncated, true); assert.deepEqual(record, before);
  assert.ok(result.sourceDependencies.refs.some(ref => ref.sourceEventId === record.sourceEventId));
});

test('current pending input is referenced without adding its text twice or claiming it was read', async () => {
  const record = original('pending-original', 'THIS_ONLY_BELONGS_IN_THE_PENDING_PAGE');
  const result = await snapshot({ persona: { anchor: { text: '' } }, recentMemory: { items: [record], total: 1, preferredDays: 3, asOf: 200 } },
    { context: { ...baseContext, pending: [record] } });
  assert.equal(result.recentMemoryReference.pendingInputReferences, 1); assert.equal(result.recentMemoryReference.shown, 0);
  assert.equal(result.recentMemoryReference.omitted, 1);
  assert.ok(!result.injectedText.includes(record.text)); assert.deepEqual(record, original('pending-original', record.text));
});

test('recent memory never crosses a different actual relationship partition', async () => {
  const result = await snapshot({ persona: { anchor: { text: '' } }, recentMemory: { items: [original('other', 'OTHER_PERSON_PRIVATE_TEXT', { personId: 'other' })], total: 1 } });
  assert.ok(!result.injectedText.includes('OTHER_PERSON_PRIVATE_TEXT')); assert.equal(result.recentMemoryReference.shown, 0);
});

test('a shown annotation retains its separate original roots without treating those roots as newly spoken dialogue', async () => {
  const record = original('source-a', '原始消息A', { timeline: { feltThen: '当时保存的感受', provenance: {
    feltThen: { refs: [{ sourceSessionId: 'other-session', sourceEventId: 'source-b' }], recordIds: ['record-b'] } } } });
  const result = await snapshot({ persona: { anchor: { text: '' } }, recentMemory: { items: [record], total: 1 } });
  assert.ok(result.injectedText.includes('当时保存的感受'));
  assert.ok(result.sourceDependencies.refs.some(ref => ref.sourceEventId === 'source-a'));
  assert.ok(result.sourceDependencies.refs.some(ref => ref.sourceEventId === 'source-b'));
  assert.ok(result.sourceDependencies.recordIds.includes('record-b'));
  const visible = JSON.parse(result.segments.find(item => item.name === 'recent_memory').text.split('\n')[1]);
  assert.equal(visible.items.length, 1); assert.equal(visible.items[0].sourceEventId, 'source-a');
});

async function runtimeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiangxu-mandatory-runtime-')), calls = [];
  const repository = new MemoryRepository({ root, clock: () => 200 });
  const runtime = new PersonaRuntime({ repository, clock: () => 200, autoSchedule: false,
    model: { countTokens: counter.count, complete: async request => { calls.push(request); return { decision: {} }; } } });
  await runtime.open();
  t.after(async () => { await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, repository, runtime, calls };
}

test('missing personality material stops before a model call and retains pending originals', async t => {
  const f = await runtimeFixture(t), accepted = await f.runtime.accept(original('kept-source', '仍然保留的来信'));
  const actual = f.repository.getContext.bind(f.repository);
  f.repository.getContext = async input => ({ ...await actual(input), persona: null });
  await assert.rejects(f.runtime.handleSignal('new_message', { ...baseContext, incoming: accepted.record }), { code: 'PERSONA_CONTEXT_UNAVAILABLE' });
  assert.equal(f.calls.length, 0); assert.equal((await f.repository.getSnapshots()).length, 0);
  assert.equal((await f.repository.getPending())[0].sourceEventId, 'kept-source');
});

test('an impossible core budget does not make a paid call or advance pending offsets', async t => {
  const f = await runtimeFixture(t), accepted = await f.runtime.accept(original('budget-source', '预算失败后这条来信仍可继续'));
  await f.repository.updateSelfProfile({ current: { selfDescription: '我'.repeat(2300) } }, { actor: 'persona' });
  const before = await f.repository.getRuntime();
  await assert.rejects(f.runtime.handleSignal('new_message', { ...baseContext, incoming: accepted.record }), { code: 'PERSONA_CONTEXT_BUDGET' });
  assert.equal(f.calls.length, 0); assert.equal((await f.repository.getPending())[0].sourceEventId, 'budget-source');
  assert.deepEqual((await f.repository.getRuntime()).execution?.pendingOffsets, before.execution?.pendingOffsets);
});

async function dshFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiangxu-mandatory-dsh-')), agents = new Map(), handlers = new Map(), globalHandlers = new Map();
  const coordinator = createDshCoordinator({ agents: { get: id => agents.get(id) }, get: () => undefined, llm: {},
    on(name, callback) { globalHandlers.set(name, callback); return () => globalHandlers.delete(name); } }, { memoryRoot: root });
  await coordinator.ready;
  for (const id of ['first', 'second']) {
    const events = new Map(), scope = { on(name, callback) { events.set(name, callback); }, tools: { restrict() { return () => {}; }, register() {} } };
    const agent = { id, ctx: scope, session: { id, header: {}, deriveMessages: () => [], requestHeader: () => undefined }, inbox: { nextTurn: [], nextStep: [] }, followup() {} };
    agents.set(id, agent); handlers.set(id, events); await coordinator.attachAgent(agent);
  }
  t.after(async () => { await coordinator.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { coordinator, agents, handlers, globalHandlers };
}

test('an existing assembled persona section cannot skip a fresh snapshot after a shared-personality change', async t => {
  const f = await dshFixture(t), agent = f.agents.get('first');
  await f.coordinator.repository.updateSelfProfile({ current: { name: '相续', selfDescription: '旧的自我描述' } }, { actor: 'persona' });
  const first = await f.coordinator.preparePersonaAssembly(agent, { sections: [{ name: 'host', text: 'HOST' }] });
  await f.coordinator.repository.updateSelfProfile({ current: { selfDescription: '更新后的自我描述' } }, { actor: 'persona' });
  const second = await f.coordinator.preparePersonaAssembly(agent, first);
  assert.equal(second.sections.filter(item => item.name === 'persona-memory:live').length, 1);
  assert.equal(second.sections.filter(item => item.name === 'persona-memory:conversation').length, 1);
  assert.equal(second.sections.find(item => item.name === 'host').text, 'HOST');
  assert.ok(!second.sections.find(item => item.name === 'persona-memory:live').text.includes('旧的自我描述'));
  assert.ok(second.sections.find(item => item.name === 'persona-memory:live').text.includes('更新后的自我描述'));
  const other = await f.coordinator.preparePersonaAssembly(f.agents.get('second'), { sections: [] });
  assert.ok(other.sections.find(item => item.name === 'persona-memory:live').text.includes('更新后的自我描述'));
});

test('the native claimed source remains in the native input rather than being duplicated in recent background', async t => {
  const f = await dshFixture(t), record = original('claimed-source', 'CLAIMED_BODY_IS_ONLY_IN_NATIVE_INPUT', {
    sourceSessionId: 'first', channelId: 'dsh:first', sourceAt: f.coordinator.runtime.now(), observedAt: f.coordinator.runtime.now() });
  await f.coordinator.runtime.accept(record);
  f.handlers.get('first').get('agent/inbox/claimed')({ turn: 1, message: { id: 'claimed-source', role: 'user', source: { kind: 'user' } } });
  const assembly = await f.coordinator.preparePersonaAssembly(f.agents.get('first'), { sections: [] });
  const live = assembly.sections.find(item => item.name === 'persona-memory:live').text;
  assert.ok(!live.includes(record.text));
  assert.equal(f.coordinator.agents.get('first').latestSnapshot.recentMemoryReference.pendingInputReferences, 1);
});

test('assembly storage failure cannot return an ordinary request and exposes a clear technical error', async t => {
  const f = await dshFixture(t); f.coordinator.runtime.compose = async () => { throw Object.assign(new Error('fixture unreadable memory'), { code: 'EIO' }); };
  await assert.rejects(f.coordinator.preparePersonaAssembly(f.agents.get('first'), { sections: [{ name: 'host', text: 'HOST' }] }), error => {
    assert.equal(error.code, 'PERSONA_CONTEXT_UNAVAILABLE'); assert.equal(error.reason, 'EIO'); assert.match(error.message, /本次未调用模型/); return true;
  });
});

test('assembly budget failures stay budget failures and are not silently enlarged', async t => {
  const f = await dshFixture(t); f.coordinator.runtime.compose = async () => { throw Object.assign(new Error('fixture core too large'), { code: 'PERSONA_CONTEXT_BUDGET' }); };
  await assert.rejects(f.coordinator.preparePersonaAssembly(f.agents.get('first'), { sections: [] }), error => {
    assert.equal(error.code, 'PERSONA_CONTEXT_BUDGET'); assert.match(error.message, /调整容量与模型预算/); return true;
  });
});

test('pre-step storage failure does not call the native admission callback or fall back to an ordinary turn', async t => {
  const f = await dshFixture(t); let nextCalls = 0;
  f.coordinator.repository.getRuntime = async () => { throw Object.assign(new Error('fixture storage failure'), { code: 'EIO' }); };
  await assert.rejects(f.handlers.get('first').get('agent/pre-step')({ messages: [], turn: 1 }, async () => { nextCalls++; return { kind: 'enter', messages: [] }; }), { code: 'PERSONA_CONTEXT_UNAVAILABLE' });
  assert.equal(nextCalls, 0);
});

test('a failure after native admission still stops before the model without invoking admission twice', async t => {
  const f = await dshFixture(t); let nextCalls = 0, modelCalls = 0;
  await f.coordinator.preparePersonaAssembly(f.agents.get('first'), { sections: [] });
  f.coordinator.repository.getPending = async () => { throw Object.assign(new Error('fixture post-admission read failure'), { code: 'EIO' }); };
  await assert.rejects((async () => {
    const decision = await f.handlers.get('first').get('agent/pre-step')({ messages: [], turn: 1 }, async () => { nextCalls++; return { kind: 'enter', messages: [] }; });
    if (decision.kind === 'enter') modelCalls++;
  })(), { code: 'PERSONA_CONTEXT_UNAVAILABLE' });
  assert.equal(nextCalls, 1); assert.equal(modelCalls, 0);
});

test('the final native request cannot lose the actual personality sections after another plugin overrides assembly', async t => {
  const f = await dshFixture(t), assembly = await f.coordinator.preparePersonaAssembly(f.agents.get('first'), { sections: [] });
  const guard = f.globalHandlers.get('llm/stream'); let providerCalls = 0;
  const next = () => { providerCalls++; return 'fixture-stream'; };
  assert.throws(() => guard({ sessionId: 'first', messages: [{ role: 'system', content: 'A foreign complete section' }] }, next), { code: 'PERSONA_CONTEXT_UNAVAILABLE' });
  assert.equal(providerCalls, 0);
  const text = assembly.sections.map(section => section.text).join('\n').trim();
  assert.equal(guard({ sessionId: 'first', messages: [{ role: 'system', content: [{ type: 'text', text }] }] }, next), 'fixture-stream');
  assert.equal(providerCalls, 1);
  assert.throws(() => guard({ sessionId: 'first', messages: [{ role: 'user', content: text }] }, next), { code: 'PERSONA_CONTEXT_UNAVAILABLE' });
  assert.equal(providerCalls, 1);
  assert.equal(guard({ sessionId: 'unrelated-session', messages: [] }, next), 'fixture-stream'); assert.equal(providerCalls, 2);
});

test('request-scoped projections accept legitimate retries and concurrent sessions without using a newer unrelated snapshot', async t => {
  const f = await dshFixture(t), firstSignal = new AbortController().signal, secondSignal = new AbortController().signal, otherSignal = new AbortController().signal;
  await f.coordinator.repository.updateSelfProfile({ current: { name: '相续', selfDescription: '本次已冻结的描述' } }, { actor: 'persona' });
  const first = await f.coordinator.preparePersonaAssembly(f.agents.get('first'), { sections: [] }, { signal: firstSignal });
  await f.coordinator.repository.updateSelfProfile({ current: { selfDescription: '下一次请求的新描述' } }, { actor: 'persona' });
  const second = await f.coordinator.preparePersonaAssembly(f.agents.get('first'), { sections: [] }, { signal: secondSignal });
  const other = await f.coordinator.preparePersonaAssembly(f.agents.get('second'), { sections: [] }, { signal: otherSignal });
  const request = (id, signal, assembly) => ({ sessionId: id, signal, messages: [{ role: 'system', content: assembly.sections.map(item => item.text).join('\n') }] });
  const oldRequest = request('first', firstSignal, first), guard = f.globalHandlers.get('llm/stream'); let calls = 0;
  const next = () => ++calls;
  assert.equal(guard(oldRequest, next), 1); assert.equal(guard(oldRequest, next), 2);
  assert.equal(guard(request('first', secondSignal, second), next), 3);
  assert.equal(guard(request('second', otherSignal, other), next), 4);
  assert.throws(() => guard(request('first', secondSignal, first), next), { code: 'PERSONA_CONTEXT_UNAVAILABLE' });
  assert.throws(() => guard(request('first', new AbortController().signal, second), next), { code: 'PERSONA_CONTEXT_UNAVAILABLE' });
  assert.equal(calls, 4);
});
