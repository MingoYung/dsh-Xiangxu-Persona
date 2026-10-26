import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDshCoordinator } from '../adapters/dsh/index.js';
import { createManagementService } from '../adapters/dsh/management.js';
import { SELF_PROFILE_LIMITS, SELF_PROFILE_PATH, selfProfileLinks } from '../core/self-profile.js';
import { extractProcessDependencies, hotSourceDependencies } from '../core/source-dependencies.js';

// Real plugin functions with isolated host ports. This is a contract fixture,
// not evidence that a native DSH SDK or a real model completed the same path.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiangxu-self-dsh-'));
  const agents = new Map(), records = new Map();
  const query = { readSession: async id => ({ events: records.get(id) ?? [] }), readEvent: async ({ sessionId, seq }) => ({ target: records.get(sessionId)?.find(event => event.seq === seq) }) };
  let modelCalls = 0;
  const ctx = { agents: { get: id => agents.get(id) }, get: key => key === 'sessionQuery' ? query : undefined,
    llm: { async *stream() { modelCalls++; throw new Error('This contract fixture must not call a model'); } } };
  const coordinator = createDshCoordinator(ctx, { memoryRoot: root }); await coordinator.ready;
  const service = createManagementService({ getCoordinator: () => coordinator, listInstances: () => ({ items: [{ instanceId: 'one', name: '隔离样本', loaded: true }], activeInstanceId: 'one' }) });
  async function attach(id) {
    const handlers = new Map(), tools = new Map();
    const scope = { on(name, handler) { handlers.set(name, handler); return () => { if (handlers.get(name) === handler) handlers.delete(name); }; },
      tools: { restrict() { return () => {}; }, register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } } };
    const session = { id, header: {}, deriveMessages: () => [], requestHeader: () => ({ config: { provider: 'fixture', model: 'unused' } }) };
    const agent = { id, session, ctx: scope, inbox: { nextTurn: [], nextStep: [] }, followup(message) { this.inbox.nextTurn.push(message); } };
    agents.set(id, agent); records.set(id, []); await coordinator.attachAgent(agent); await coordinator.readyState();
    const enter = async (sourceId, text, turn = 1) => {
      const message = { id: sourceId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
      handlers.get('agent/inbox/claimed')({ message, turn });
      const admitted = await handlers.get('agent/pre-step')({ messages: [message], turn }, async () => ({ kind: 'enter', messages: [message] }));
      assert.equal(admitted.kind, 'enter'); return message;
    };
    const assemble = () => handlers.get('system-prompt/assemble')({}, { agent }, async () => ({ sections: [{ name: 'fixture-host', text: '宿主已有内容' }] }));
    return { agent, handlers, tools, enter, assemble };
  }
  t.after(async () => { await coordinator.close(); await fs.rm(root, { recursive: true, force: true }); assert.equal(modelCalls, 0); });
  return { root, coordinator, repository: coordinator.repository, service, attach };
}
async function fullTool(client, args, callId = 'self-contract') {
  const tool = client.tools.get('persona_introspect');
  let cursor, joined = '', direct;
  do {
    const page = await tool.execute({ ...args, ...(cursor ? { cursor } : {}) }, { agent: client.agent, callId });
    if (page.preview?.format === 'json_text_fragment') {
      assert.equal(page.preview.fragment.from, Array.from(joined).length);
      joined += page.preview.text;
    } else { direct = page; break; }
    cursor = page.nextCursor;
  } while (cursor);
  return joined ? JSON.parse(joined) : direct;
}

test('management self actions use owner CAS, expose setup status and keep initial wishes distinct from current identity', async t => {
  const f = await fixture(t), client = await f.attach('session-a');
  const empty = await f.service.dispatch('self.get');
  assert.equal(empty.version, 0); assert.equal(empty.createdAt, null);
  await assert.rejects(f.service.dispatch('self.update', { patch: { mode: 'together' } }), { code: 'SELF_VERSION_REQUIRED' });
  const proposed = await f.service.dispatch('self.update', { patch: { mode: 'together', onboardingAcknowledged: true, initial: { name: '小续', ageDescription: '成年形象' } }, expectedVersion: empty.version });
  assert.equal(proposed.initial.name, '小续'); assert.equal(proposed.current.name, '');
  const status = await f.service.dispatch('status');
  assert.deepEqual(status.selfProfile, { mode: 'together', version: proposed.version, onboardingAcknowledged: true });
  const adopted = await fullTool(client, { action: 'update_self', expectedVersion: proposed.version, selfPatch: { name: '相续', gender: '暂未确定' } });
  assert.notEqual(adopted.status, 'memory_error'); assert.equal(adopted.current.name, '相续');
  assert.equal(adopted.initial.name, '小续'); assert.equal(adopted.current.ageDescription, '');
  await assert.rejects(f.service.dispatch('self.update', { patch: { initial: { name: '迟到修改' } }, expectedVersion: proposed.version }), { code: 'VERSION_CONFLICT' });
  assert.equal((await f.service.dispatch('self.get')).current.name, '相续');
});

test('persona self schema requires valid version at execution and offers only current text fields, not owner preferences', async t => {
  const f = await fixture(t), client = await f.attach('session-a'), props = client.tools.get('persona_introspect').parameters.properties;
  assert.ok(props.section.enum.includes('self')); assert.ok(props.action.enum.includes('update_self'));
  assert.equal(props.selfPatch.additionalProperties, false);
  assert.equal(props.selfPatch.properties.background.maxLength, SELF_PROFILE_LIMITS.sectionChars);
  assert.equal(props.selfPatch.properties.mode, undefined); assert.equal(props.selfPatch.properties.initial, undefined);
  const initial = await f.service.dispatch('self.update', { patch: { mode: 'autonomous', onboardingAcknowledged: true }, expectedVersion: 0 });
  const missing = await fullTool(client, { action: 'update_self', selfPatch: { name: '无版本写入' } });
  assert.equal(missing.status, 'memory_error'); assert.equal(missing.code, 'SELF_VERSION_REQUIRED');
  for (const selfPatch of [{ mode: 'unset' }, { initial: { name: '越界' } }, { onboardingAcknowledged: false }]) {
    const rejected = await fullTool(client, { action: 'update_self', expectedVersion: initial.version, selfPatch });
    assert.equal(rejected.status, 'memory_error'); assert.equal(rejected.code, 'SCHEMA_INVALID');
  }
  assert.deepEqual(await f.service.dispatch('self.get'), initial);
});

test('shared self identity crosses attached windows and a saved update appears in the next prompt without altering host sections', async t => {
  const f = await fixture(t), first = await f.attach('session-a'), second = await f.attach('session-b');
  await f.service.dispatch('self.update', { patch: { initial: { name: '初始建议' } }, expectedVersion: 0 });
  const changed = await fullTool(first, { action: 'update_self', expectedVersion: 1, selfPatch: { name: '连续名字', pronouns: '她' } });
  const other = await fullTool(second, { section: 'self' });
  assert.equal(other.current.name, changed.current.name); assert.equal(other.version, changed.version);
  const assembled = await second.assemble();
  assert.equal(assembled.sections.find(section => section.name === 'fixture-host').text, '宿主已有内容');
  const live = assembled.sections.find(section => section.name === 'persona-memory:live').text;
  assert.ok(live.includes('连续名字')); assert.ok(live.includes('初始建议')); assert.ok(live.includes('initialWishes'));
  assert.ok(assembled.sections.some(section => section.name === 'persona-memory:conversation'));
  const saved = await fs.readFile(path.join(f.root, SELF_PROFILE_PATH));
  await first.assemble(); await second.assemble();
  assert.deepEqual(await fs.readFile(path.join(f.root, SELF_PROFILE_PATH)), saved);
});

test('self mutation retains admitted original source identities and management forgetting clears them and old tool pages', async t => {
  const f = await fixture(t), client = await f.attach('session-a');
  await client.enter('real-original', '我建议名字可以叫相续。');
  const original = (await f.repository.getPending())[0];
  const changed = await fullTool(client, { action: 'update_self', expectedVersion: 0, selfPatch: { name: '相续', background: '保真资料😀'.repeat(180) } });
  assert.notEqual(changed.status, 'memory_error');
  assert.ok(changed.provenance.current.name.sourceRefs.some(ref => ref.sourceSessionId === 'session-a' && ref.sourceEventId === 'real-original'));
  assert.equal((await f.repository.readSources({ eventIds: [original.eventId] }))[0].role, 'user');
  const firstPage = await client.tools.get('persona_introspect').execute({ section: 'self' }, { agent: client.agent, callId: 'paged-self' });
  assert.ok(firstPage.nextCursor);
  await f.service.dispatch('memory.forget', { ids: [original.id], scope: 'unknown', reason: '明确撤销这份初始建议' });
  const clean = await f.service.dispatch('self.get');
  assert.equal(clean.current.name, ''); assert.equal(clean.current.background, '');
  assert.ok(clean.history.every(item => item.current.name === '' && item.current.background === ''));
  const expired = await client.tools.get('persona_introspect').execute({ section: 'self', cursor: firstPage.nextCursor }, { agent: client.agent, callId: 'paged-self' });
  assert.equal(expired.status, 'memory_error'); assert.equal(expired.code, 'TOOL_CURSOR_EXPIRED');
});

test('maximum single-field profile text survives owner API, tool schema and paged mutation receipt without repeat writes', async t => {
  const f = await fixture(t), client = await f.attach('session-a'), text = '😀'.repeat(SELF_PROFILE_LIMITS.sectionChars);
  const proposed = await f.service.dispatch('self.update', { patch: { initial: { background: text } }, expectedVersion: 0 });
  assert.equal(proposed.initial.background, text);
  const result = await fullTool(client, { action: 'update_self', expectedVersion: proposed.version, selfPatch: { background: text } }, 'one-large-self-update');
  assert.notEqual(result.status, 'memory_error'); assert.equal(result.current.background, text); assert.equal(result.version, proposed.version + 1);
  const observed = await f.service.dispatch('self.get');
  assert.equal(observed.current.background, text); assert.equal(observed.initial.background, text); assert.equal(observed.version, proposed.version + 1);
  assert.ok(Buffer.byteLength(JSON.stringify(observed)) < 131072);
});

test('source-link overflow reports each real limit and leaves the prior profile untouched without trimming sources', async t => {
  assert.throws(() => selfProfileLinks({ sourceRefs: Array.from({ length: 17 }, (_, i) => ({ sourceSessionId: 's', sourceEventId: String(i) })) }), error => error.resource === 'selfProfileSourceRefs' && error.actual === 17 && error.limit === 16);
  assert.throws(() => selfProfileLinks({ sourceRecordIds: Array.from({ length: 33 }, (_, i) => 'record-' + i) }), error => error.resource === 'selfProfileSourceRecordIds' && error.actual === 33 && error.limit === 32);
  const f = await fixture(t), client = await f.attach('session-a');
  await f.service.dispatch('self.update', { patch: { current: { name: '应当保留的名字' } }, expectedVersion: 0 });
  const saved = await fs.readFile(path.join(f.root, SELF_PROFILE_PATH)), refs = [];
  for (let i = 0; i < 17; i++) {
    await f.repository.ingest({ personId: null, sourceSessionId: 'extra-sources', sourceEventId: 'original-' + i, sourceKind: 'user', contentClass: 'participant_dialogue', channelId: 'fixture-extra', role: 'user', text: '实际接收原件' + i });
    refs.push({ sourceSessionId: 'extra-sources', sourceEventId: 'original-' + i });
  }
  const state = f.coordinator.agents.get(client.agent.id);
  state.currentTurn = 9;
  state.processDependenciesByTurn.set(9, { refs: new Map(refs.map(ref => [JSON.stringify([ref.sourceSessionId, ref.sourceEventId]), ref])), recordIds: new Set(), complete: true });
  const result = await fullTool(client, { action: 'update_self', expectedVersion: 1, selfPatch: { name: '不可截断来源后偷偷保存' } });
  assert.equal(result.status, 'memory_error'); assert.equal(result.code, 'CAPACITY_EXCEEDED');
  assert.ok(result.message.includes('17 > 16'));
  assert.deepEqual(await fs.readFile(path.join(f.root, SELF_PROFILE_PATH)), saved);
});

test('owner endpoint returns complete bounded source metadata and does not silently drop extension data', async t => {
  const f = await fixture(t);
  await f.repository.ingest({ personId: null, sourceSessionId: 'source-metadata', sourceEventId: 'actual', sourceKind: 'user', contentClass: 'participant_dialogue', channelId: 'fixture-extra', role: 'user', text: '实际原文' });
  const source = { sourceSessionId: 'source-metadata', sourceEventId: 'actual', sourceRole: 'user', sourceKind: 'user', available: false, summary: '原件已自然离开近期视图，保留来源摘要', extension: { tag: 'bounded source metadata' } };
  await f.repository.updateSelfProfile({ current: { name: '有来源的自我资料' } }, { actor: 'persona', sourceRefs: [source] });
  const response = await f.service.dispatch('self.get');
  assert.deepEqual(response.provenance.current.name.sourceRefs, [source]);
  assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 131072);
});

test('admitted human, real-shaped self-inspection tool result and update preserve host envelope identity without treating it as memory', async t => {
  const f = await fixture(t), client = await f.attach('session-a');
  await f.service.dispatch('self.update', { patch: { initial: { name: '初始建议' }, onboardingAcknowledged: true }, expectedVersion: 0 });
  await client.enter('onboarding-human-start', '你好，先看看你自己的资料。', 1);
  const inspected = await fullTool(client, { section: 'self' }, 'native-inspect-call');
  const envelopeId = '5146c897-04a1-4f76-a582-408218db3a60';
  const event = { type: 'tool/result', seq: 16, time: 1000, data: { turn: 1, step: 1, message: {
    id: envelopeId, role: 'tool', source: { kind: 'tool', callId: 'native-inspect-call' }, toolCallId: 'native-inspect-call',
    content: [{ type: 'text', text: JSON.stringify(inspected) }],
  } } };
  await f.coordinator.observeEvent(client.agent.session, event);
  const state = f.coordinator.agents.get(client.agent.id);
  assert.ok(!state.processDependenciesByTurn.get(1).recordIds.has(envelopeId));
  const changed = await fullTool(client, { action: 'update_self', expectedVersion: inspected.version, selfPatch: { name: '相续' } }, 'native-update-call');
  assert.notEqual(changed.status, 'memory_error'); assert.equal(changed.current.name, '相续'); assert.equal(changed.initial.name, '初始建议');
  const process = (await f.repository.store.readLines('staging/hot.jsonl')).find(item => item.kind === 'tool_result' && item.sourceRef.sourceEventId === '16');
  assert.ok(process);
  assert.equal(JSON.parse(process.content.text).message.id, envelopeId);
  const fromProcess = await f.repository.updateSelfProfile({ current: { selfDescription: '参考这次实际工具过程形成的描述' } }, { actor: 'persona', expectedVersion: changed.version,
    sourceRefs: [process.sourceRef], sourceRecordIds: [process.id] });
  assert.equal(fromProcess.current.selfDescription, '参考这次实际工具过程形成的描述');
  const participants = (await f.repository.getContext()).records;
  assert.equal(participants.length, 1); assert.equal(participants[0].sourceEventId, 'onboarding-human-start');
  assert.equal(process.sourceRef.sourceRole, 'assistant'); assert.equal(process.origin, 'system');
  await f.service.dispatch('memory.forget', { ids: [participants[0].id], scope: 'unknown', reason: '撤销实际用户来源' });
  const withdrawn = await f.service.dispatch('self.get');
  assert.equal(withdrawn.current.name, ''); assert.equal(withdrawn.current.selfDescription, '');
});

test('one process scanner keeps explicit memory domains through capture while excluding transport and platform bare IDs', async t => {
  const f = await fixture(t);
  const original = (await f.repository.ingest({ personId: null, sourceSessionId: 'fixture-source', sourceEventId: 'real', sourceKind: 'user', contentClass: 'participant_dialogue', channelId: 'fixture', role: 'user', text: '实际记忆' })).record;
  const sourceRef = { sourceSessionId: 'fixture-source', sourceEventId: 'real' };
  const payload = { platform: { id: 'qq-platform-id' }, memory: { schemaVersion: 'persona-memory/3', id: original.id, srcRefs: [sourceRef] },
    recordId: original.id, sourceRecordIds: [original.id], sources: [sourceRef] };
  const text = JSON.stringify({ turn: 1, step: 1, message: { role: 'tool', id: 'host-envelope-id', source: { kind: 'tool' }, content: [{ type: 'text', text: JSON.stringify(payload) }] } });
  const record = { personId: null, sourceRef: { sourceSessionId: 'host', sourceEventId: 'actual-tool-root', sourceRole: 'assistant', sourceOrigin: 'system' },
    kind: 'tool_result', sourceKind: 'tool/result', origin: 'system', content: { mode: 'cached', text } };
  const scanned = extractProcessDependencies(record);
  assert.equal(scanned.complete, true); assert.deepEqual(scanned.recordIds, [original.id]); assert.deepEqual(scanned.refs, [sourceRef]);
  assert.equal(record.content.text, text);
  const stored = (await f.repository.captureHot(record)).record;
  assert.deepEqual(stored.dependencyRecordIds, [original.id]); assert.deepEqual(hotSourceDependencies(stored).recordIds, [original.id]);
  assert.equal(stored.content.text, text);
  const profile = await f.repository.updateSelfProfile({ current: { selfDescription: '有实际过程依据的描述' } }, { actor: 'persona', sourceRecordIds: [stored.id] });
  assert.ok(profile.provenance.current.selfDescription.sourceRefs.some(ref => ref.sourceEventId === 'real'));
  await f.repository.forget({ ids: [original.id], scope: 'unknown' });
  assert.equal((await f.repository.getSelfProfile()).current.selfDescription, '');
});

test('trusted process scanning reports incomplete at depth, content, node and explicit ID limits without altering originals', () => {
  const record = data => ({ kind: 'tool_result', sourceKind: 'tool/result', content: { mode: 'cached', text: JSON.stringify({ message: { role: 'tool', source: { kind: 'tool' }, content: data } }) } });
  let deep = { recordId: 'never-claim-full-read' }; for (let i = 0; i < 40; i++) deep = { nested: deep };
  const cases = [record(deep), record('x'.repeat(2000001)), record(Array.from({ length: 100001 }, () => null)), record({ sourceRecordIds: Array.from({ length: 16385 }, (_, i) => 'id-' + i) })];
  for (const input of cases) { const before = input.content.text; assert.equal(extractProcessDependencies(input).complete, false); assert.equal(input.content.text, before); }
});
