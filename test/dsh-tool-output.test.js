import test from 'node:test';
import assert from 'node:assert/strict';
import { boundToolOutput } from '../adapters/dsh/tool-output.js';

const counter = { method: 'test_codepoints', count: text => Array.from(text).length };
const size = value => counter.count(JSON.stringify(value));
const row = text => ({ id: 'long_source', personId: 'a', recordType: 'chat', sourceSessionId: 'source_session', sourceEventId: 'source_event',
  role: 'user', origin: 'user', text });

test('long Chinese and emoji memory pages reconstruct the complete original within the complete JSON budget', async () => {
  const text = '早上好🌿👩🏽‍💻我们聊过这个事。'.repeat(600), result = { items: [row(text), { ...row('第二段真实原文🐈'), id: 'second' }] };
  const original = new Map(result.items.map(item => [item.id, item.text])), joined = new Map();
  let cursor = null, pages = 0;
  do {
    const page = await boundToolOutput('memory_search', result, { query: '我们', scope: 'all', cursor }, { counter, budget: 900 });
    assert.ok(size(page) <= 900); assert.equal(page.totalMatched, 2);
    // A consumer always receives a complete valid JSON object, even when body text is partial.
    assert.deepEqual(JSON.parse(JSON.stringify(page)), page);
    for (const item of page.items) {
      assert.equal(item.srcRefs[0].sourceEventId, 'source_event'); assert.equal(item.personId, 'a');
      assert.equal(item.fragment.from, Array.from(joined.get(item.id) ?? '').length);
      assert.ok(!/[\uD800-\uDBFF]$/.test(item.text));
      joined.set(item.id, (joined.get(item.id) ?? '') + item.text);
    }
    cursor = page.nextCursor; pages++; assert.ok(pages < 200);
  } while (cursor);
  assert.ok(pages > 1); assert.deepEqual(joined, original);
});

test('opaque cursors cannot move between different query, target, tool or changed results', async () => {
  const result = { items: [row('很长的来源🧠'.repeat(400))] }, args = { query: '来源', targetPersonId: 'a', scope: 'person' };
  const first = await boundToolOutput('memory_search', result, args, { counter, budget: 900 }); assert.ok(first.nextCursor);
  await assert.rejects(boundToolOutput('memory_search', result, { ...args, query: '其他', cursor: first.nextCursor }, { counter, budget: 900 }), error => error.code === 'INVALID_TOOL_CURSOR');
  await assert.rejects(boundToolOutput('memory_search', result, { ...args, targetPersonId: 'b', cursor: first.nextCursor }, { counter, budget: 900 }), error => error.code === 'INVALID_TOOL_CURSOR');
  await assert.rejects(boundToolOutput('persona_introspect', result, { ...args, cursor: first.nextCursor }, { counter, budget: 900 }), error => error.code === 'INVALID_TOOL_CURSOR');
  await assert.rejects(boundToolOutput('memory_search', { items: [row('changed')] }, { ...args, cursor: first.nextCursor }, { counter, budget: 900 }), error => error.code === 'TOOL_CURSOR_STALE');
  await assert.rejects(boundToolOutput('memory_search', result, { ...args, cursor: 'not+valid' }, { counter, budget: 900 }), error => error.code === 'INVALID_TOOL_CURSOR');
});

test('forget success count and revocation are preserved while affected IDs are paged without clipping identifiers', async () => {
  const ids = Array.from({ length: 250 }, (_, i) => `memory_${i}_${'a'.repeat(30)}`), result = { revocation: { id: 'revocation_1', action: 'forget', targetSrcRefs: [] }, affectedIds: ids };
  let cursor = null; const actual = [];
  do {
    const page = await boundToolOutput('memory_forget', result, { ids: ['selected_root'], reason: 'the chosen scope', cursor }, { counter, budget: 900 });
    assert.ok(size(page) <= 900); assert.equal(page.affectedCount, ids.length); assert.equal(page.revocationId, 'revocation_1');
    actual.push(...page.affectedIds); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(actual, ids);
});

test('introspection pages are explicitly JSON text fragments and reconstruct the full structured result', async () => {
  const result = { anchor: { text: '我的基调🙂'.repeat(400) }, facets: [{ desc: '我可能会改变。'.repeat(200) }], version: 4 };
  let cursor = null, serialized = '';
  do {
    const page = await boundToolOutput('persona_introspect', result, { section: 'all', targetPersonId: 'a', cursor }, { counter, budget: 900 });
    assert.ok(size(page) <= 900); assert.equal(page.preview.format, 'json_text_fragment'); assert.equal(page.detailRef.targetPersonId, 'a');
    serialized += page.preview.text; cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(JSON.parse(serialized), result);
});

test('decide return contains useful effective metadata without copying entire runtime transcript or snapshots', async () => {
  const result = { decision: { decisionId: 'decision_1', decidedAt: 100, replyPlan: { action: 'listen', target: null, pendingEventIds: ['one'], replyAt: null, recheckOn: ['new_message'] }, nextCheckAt: null },
    state: { version: 2, sleep: { state: 'awake' }, globalMuted: false, execution: { pendingWake: { groups: [{ records: [{ text: 'DO_NOT_ECHO_RAW_TRANSCRIPT'.repeat(10000) }] }] } } }, effects: {} };
  const page = await boundToolOutput('persona_decide', result, {}, { counter, budget: 900 });
  assert.ok(size(page) <= 900); assert.equal(page.decisionId, 'decision_1'); assert.equal(page.effective.replyPlan.action, 'listen');
  assert.ok(!JSON.stringify(page).includes('DO_NOT_ECHO_RAW_TRANSCRIPT'));
});

test('selected consolidation work and the actual job receipt remain in the compact decision return', async () => {
  const result = { decision: { decisionId: 'decision_work', consolidationPlan: { action: 'run', targetPersonIds: ['a', null] } },
    effects: { consolidation: { status: 'queued', jobId: 'job_work', targetPersonIds: ['a', null] } },
    state: { version: 5, sleep: { state: 'sleeping', wakeJobId: 'job_work' }, execution: { raw: 'PRIVATE_TRACE'.repeat(10000) } } };
  const page = await boundToolOutput('persona_decide', result, {}, { counter, budget: 900 });
  assert.ok(size(page) <= 900);
  assert.deepEqual(page.consolidation, result.effects.consolidation);
  assert.deepEqual(page.effective.consolidationPlan, result.decision.consolidationPlan);
  assert.equal(page.runtime.sleep.wakeJobId, 'job_work');
  assert.ok(!JSON.stringify(page).includes('PRIVATE_TRACE'));
});

test('default fallback explicitly labels estimates and too-small metadata budgets fail without partial JSON output', async () => {
  const result = { items: [row('中文🙂'.repeat(40))] };
  const page = await boundToolOutput('memory_search', result, { query: '中文' }, { budget: 1500 });
  assert.equal(page.tokenAccounting, 'utf8_bytes_estimate'); assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 1500);
  await assert.rejects(boundToolOutput('memory_search', result, { query: '中文' }, { counter, budget: 20 }), error => error.code === 'TOOL_OUTPUT_BUDGET');
});

test('search preserves the actual meaning of persona facets, soft boundaries and if/then signatures as well as plain text memories', async () => {
  const result = { items: [
    { id: 'facet', personId: null, recordType: 'facet', kind: 'boundary', policy: 'ask_first', topic: 'family', desc: '我可能会先问愿不愿意谈这个。' },
    { id: 'signature', personId: 'a', recordType: 'signature', if: '深夜又见到他', then: '我也许更想聊很久。' },
    { id: 'habit', personId: null, recordType: 'habit', text: '习惯叫他的昵称。' },
  ] };
  const all = []; let cursor = null;
  do { const page = await boundToolOutput('memory_search', result, { query: '他', scope: 'all', cursor }, { counter, budget: 1000 }); all.push(...page.items); cursor = page.nextCursor; } while (cursor);
  assert.equal(all[0].text, result.items[0].desc); assert.equal(all[0].policy, 'ask_first');
  assert.deepEqual(JSON.parse(all[1].text), { if: result.items[1].if, then: result.items[1].then }); assert.equal(all[1].bodyFormat, 'signature_json');
  assert.equal(all[2].text, result.items[2].text);
});

test('assistant original and source provenance survive a bounded return alongside signature semantics', async () => {
  const original = { ...row('是我先来找你的。'), scope: 'person', role: 'assistant', origin: 'proactive', proactiveId: 'proactive_1', sourceAt: 1234,
    srcRefs: [{ sourceSessionId: 'source_session', sourceEventId: 'source_event', sourceKind: 'assistant', sourceRole: 'assistant', sourceOrigin: 'proactive', blockIndex: 2, available: true }] };
  const result = { items: [original, { id: 'sig', personId: 'a', recordType: 'signature', if: '想起那次主动聊天', then: '可能会再次联系他。' }] };
  const all = []; let cursor = null;
  do { const page = await boundToolOutput('memory_search', result, { query: '主动', cursor }, { counter, budget: 1100 }); assert.ok(size(page) <= 1100); all.push(...page.items); cursor = page.nextCursor; } while (cursor);
  const first = all[0];
  for (const key of ['scope', 'role', 'origin', 'proactiveId', 'sourceAt']) assert.equal(first[key], original[key]);
  assert.deepEqual(first.srcRefs[0], original.srcRefs[0]); assert.equal(first.text, original.text);
  assert.deepEqual(JSON.parse(all[1].text), { if: result.items[1].if, then: result.items[1].then });
});
