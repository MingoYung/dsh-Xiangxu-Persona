import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshCoordinator } from '../adapters/dsh/index.js';
import { boundToolOutput } from '../adapters/dsh/tool-output.js';

async function fixture(t, { config = {}, query } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'persona-dsh-process-deps-')), handlers = new Map(), tools = new Map();
  const scope = { on(name, handler) { handlers.set(name, handler); }, tools: { register(tool) { tools.set(tool.name, tool); } } };
  const session = { id: 'session-a', header: {}, deriveMessages: () => [], requestHeader: () => ({ config: { provider: 'test', model: 'fixture' } }) };
  const agent = { id: session.id, session, ctx: scope, inbox: { nextTurn: [], nextStep: [] }, followup(message) { this.inbox.nextTurn.push(message); } };
  const coordinator = createDshCoordinator({ agents: { get: () => agent }, llm: {}, get: key => key === 'sessionQuery' ? query : undefined },
    { memoryRoot: root, operatorControl: false, ...config });
  await coordinator.ready; await coordinator.attachAgent(agent);
  await coordinator.repository.upsertPerson({ personId: 'a' }); await coordinator.repository.upsertPerson({ personId: 'b' });
  await coordinator.runtime.decide({ identityPlan: { action: 'associate', personId: 'a', sourceRefs: [] } }, { ...coordinator.contextFor(agent), executeReply: false });
  t.after(async () => { await coordinator.close(); await rm(root, { recursive: true, force: true }); });
  let seq = 0;
  const observe = (type, data) => coordinator.observeEvent(session, { type, seq: seq++, time: Date.now(), data });
  const enter = async (id, text, turn) => {
    const message = { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
    await observe('turn/start', { turn }); handlers.get('agent/inbox/claimed')({ message, turn });
    const entered = await handlers.get('agent/pre-step')({ messages: [message], turn }, async () => ({ kind: 'enter', messages: [message] }));
    assert.equal(entered.kind, 'enter'); await observe('user/message', message);
    return (await coordinator.repository.readSources({ sourceRefs: [{ sourceSessionId: session.id, sourceEventId: id }] }))[0];
  };
  return { coordinator, repository: coordinator.repository, runtime: coordinator.runtime, session, agent, observe, enter };
}

test('forgetting a real root removes dependent same-turn H1 copies but preserves independent actual assistant C1 and personality based on that actual output', async t => {
  const f = await fixture(t), privateText = 'PRIVATE_H1_ORIGINAL_NEVER_RECONSOLIDATE';
  const original = await f.enter('private-root', privateText, 1);
  await f.observe('assistant/message', { turn: 1, message: { id: 'independent-actual-output', role: 'assistant', content: [
    { type: 'reasoning', text: `A complete process copy of ${privateText}` }, { type: 'text', text: 'INDEPENDENT_VISIBLE_OUTPUT_TO_KEEP' },
  ] } });
  const ownRef = { sourceSessionId: f.session.id, sourceEventId: 'independent-actual-output', available: true };
  // This separate run models a previously chosen, unrelated shared facet. It
  // does not consume the affected person's temporary process stream.
  const otherRun = await f.repository.prepareConsolidation({ personId: 'b' });
  await f.repository.applyConsolidation(otherRun, { entries: [{ documentKey: 'persona', expectedVersion: otherRun.inputVersions.persona,
    operation: 'upsert', recordId: 'facets:independent_facet', value: { scope: 'global', personId: null, epistemic: 'interpretation',
      kind: 'tendency', desc: 'INDEPENDENT_PERSONALITY_TO_KEEP', srcRefs: [ownRef] } }] });
  await f.observe('tool/result', { turn: 1, message: { id: 'tool-copy', role: 'tool', content: [{ type: 'text', text: JSON.stringify({ items: [
    { id: original.id, text: privateText, srcRefs: [{ sourceSessionId: f.session.id, sourceEventId: 'private-root', available: true }] },
  ] }) }] } });
  const before = await f.repository.prepareConsolidation({ personId: 'a' });
  const reasoning = before.input.hot.find(record => record.kind === 'reasoning');
  assert.ok(reasoning); assert.equal(reasoning.contextGroupId, `dsh:${f.session.id}:turn:1`);
  assert.ok(reasoning.dependencyRefs.some(ref => ref.sourceSessionId === f.session.id && ref.sourceEventId === 'private-root'));
  await f.repository.forget({ targetPersonId: 'a', ids: [original.id], reason: 'Explicit deletion of the selected root only' });
  const after = await f.repository.prepareConsolidation({ personId: 'a' });
  assert.ok(!JSON.stringify(after.input).includes(privateText));
  assert.ok(!after.input.hot.some(record => record.contextGroupId === `dsh:${f.session.id}:turn:1`));
  const remaining = (await f.repository.getContext({ personId: 'a' })).records;
  assert.equal(remaining.find(record => record.sourceEventId === 'independent-actual-output').text, 'INDEPENDENT_VISIBLE_OUTPUT_TO_KEEP');
  assert.equal((await f.repository.getPersona()).facets.find(facet => facet.id === 'independent_facet').desc, 'INDEPENDENT_PERSONALITY_TO_KEEP');
  const meta = await f.repository.store.readJson('meta/state.json');
  assert.ok(meta.revokedSources.includes(JSON.stringify([f.session.id, 'private-root'])));
  assert.ok(!meta.revokedSources.includes(JSON.stringify([f.session.id, 'independent-actual-output'])));
  assert.ok(!meta.revokedSources.includes(JSON.stringify([f.session.id, '3'])));
});

test('a future tool result with nested JSON text references cannot reintroduce an explicitly revoked original under its new temporary sequence', async t => {
  const f = await fixture(t), privateText = 'PRIVATE_NESTED_JSON_COPY';
  const original = await f.enter('selected-root', privateText, 1);
  await f.repository.forget({ targetPersonId: 'a', ids: [original.id], reason: 'Chosen source revocation' });
  await f.observe('tool/result', { turn: 99, message: { id: 'later-copy', role: 'tool', content: [{ type: 'text', text: JSON.stringify({
    output: [{ type: 'text', text: JSON.stringify({ items: [{ id: original.id, text: privateText,
      srcRefs: [{ sourceSessionId: f.session.id, sourceEventId: 'selected-root', available: true }] }] }) }],
  }) }] } });
  const next = await f.repository.prepareConsolidation({ personId: 'a' });
  assert.ok(!JSON.stringify(next.input).includes(privateText));
  assert.ok(!next.input.hot.some(record => record.kind === 'tool_result'));
  const meta = await f.repository.store.readJson('meta/state.json');
  assert.deepEqual(meta.revokedSources, [JSON.stringify([f.session.id, 'selected-root'])]);
});

test('old unlabelled process copies and host-trace pointers in the affected session are conservatively excluded without deleting unrelated real dialogue', async t => {
  const f = await fixture(t), original = await f.enter('legacy-selected-root', 'LEGACY_PRIVATE_SOURCE', 1);
  await f.repository.ingest({ sourceSessionId: f.session.id, sourceEventId: 'legacy-independent-c1', sourceKind: 'model', contentClass: 'participant_dialogue',
    role: 'assistant', origin: 'ai_reply', channelId: `dsh:${f.session.id}`, personId: 'a', text: 'LEGACY_UNRELATED_C1_KEEP' });
  await f.repository.captureHot({ personId: 'a', sourceRef: { sourceSessionId: f.session.id, sourceEventId: 'legacy-process', available: true },
    sourceKind: 'reasoning', origin: 'ai_reply', kind: 'reasoning', content: { mode: 'cached', text: 'LEGACY_PRIVATE_SOURCE process copy', chars: 34 } });
  await f.repository.captureHot({ personId: 'a', sourceRef: { sourceSessionId: f.session.id, sourceEventId: 'legacy-trace', available: true },
    sourceKind: 'tool', origin: 'system', kind: 'tool_result', content: { mode: 'host_trace', locator: 'legacy:unsafe-unlabelled', available: true, chars: null } });
  const rows = await f.repository.store.readLines('people/a/hot.jsonl');
  // Simulate actual pre-upgrade disk records, not new records processed by the
  // upgraded capture path, which would supply dependency metadata.
  for (const row of rows) for (const key of Object.keys(row)) if (key.startsWith('dependency') || key === 'contextGroupId') delete row[key];
  await f.repository.store.transaction({ jsonl: { 'people/a/hot.jsonl': rows } });
  await f.repository.forget({ targetPersonId: 'a', ids: [original.id], reason: 'Explicit source revocation with legacy process data present' });
  const next = await f.repository.prepareConsolidation({ personId: 'a' });
  assert.ok(!next.input.hot.some(record => ['legacy-process', 'legacy-trace'].includes(record.sourceRef.sourceEventId)));
  assert.equal((await f.repository.getContext({ personId: 'a' })).records.find(record => record.sourceEventId === 'legacy-independent-c1').text, 'LEGACY_UNRELATED_C1_KEEP');
  const meta = await f.repository.store.readJson('meta/state.json');
  assert.ok(Array.isArray(meta.dependencyCleanups) && meta.dependencyCleanups.length > 0);
  assert.ok(!meta.revokedSources.includes(JSON.stringify([f.session.id, 'legacy-process'])));
  assert.ok(!meta.revokedSources.includes(JSON.stringify([f.session.id, 'legacy-trace'])));
});

test('an actual bounded JSON preview with an unread dependency tail is diagnosed rather than cached as safe empty provenance', async t => {
  const f = await fixture(t), privateText = 'PRIVATE_PREVIEW_WITH_UNREAD_REFS';
  const original = await f.enter('preview-selected-root', privateText, 1);
  const output = await boundToolOutput('persona_introspect', { summary: privateText.repeat(300), srcRefs: [
    { sourceSessionId: f.session.id, sourceEventId: 'preview-selected-root', available: true },
  ] }, { section: 'all' }, { counter: { method: 'test_codepoints', count: text => Array.from(text).length }, budget: 900 });
  assert.equal(output.preview.format, 'json_text_fragment'); assert.equal(output.preview.fragment.complete, false);
  assert.ok(output.preview.text.includes(privateText)); assert.ok(!output.preview.text.includes('preview-selected-root'));
  await f.observe('tool/result', { turn: 77, message: { id: 'partial-json-tool-copy', role: 'tool', content: [{ type: 'text', text: JSON.stringify(output) }] } });
  await f.repository.forget({ targetPersonId: 'a', ids: [original.id], reason: 'Explicitly forgotten before any future interpretation' });
  const next = await f.repository.prepareConsolidation({ personId: 'a' });
  assert.ok(!JSON.stringify(next.input).includes(privateText));
  assert.ok((await f.repository.getRuntime()).memoryGaps.some(gap => gap.reason.includes('dependency_scan_incomplete')));
});

test('a dependency-incomplete tool result remains unsafe after the adapter converts its oversized text to a host trace pointer', async t => {
  const query = { readSession: async () => ({ events: [] }) };
  const f = await fixture(t, { config: { tempTargetChars: 1 }, query }), privateText = 'PRIVATE_PREVIEW_BEFORE_TRACE_CONVERSION';
  const original = await f.enter('overflow-preview-root', privateText, 1);
  const output = await boundToolOutput('persona_introspect', { summary: privateText.repeat(300), srcRefs: [
    { sourceSessionId: f.session.id, sourceEventId: 'overflow-preview-root', available: true },
  ] }, { section: 'all' }, { counter: { method: 'test_codepoints', count: text => Array.from(text).length }, budget: 900 });
  assert.equal(output.preview.fragment.complete, false);
  await f.observe('tool/result', { turn: 78, message: { id: 'overflow-partial-json', role: 'tool', content: [{ type: 'text', text: JSON.stringify(output) }] } });
  await f.repository.forget({ targetPersonId: 'a', ids: [original.id], reason: 'Selected root must not return through an unlabelled trace' });
  const next = await f.repository.prepareConsolidation({ personId: 'a' });
  assert.ok(!next.input.hot.some(record => record.kind === 'tool_result'));
  assert.ok((await f.repository.getRuntime()).memoryGaps.some(gap => gap.reason.includes('dependency_scan_incomplete')));
});
