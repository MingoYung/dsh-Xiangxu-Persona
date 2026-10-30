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
      // Whole rows carry the identity envelope; continuation rows re-identify by
      // id only, and preview rows are a marked peek whose text is re-delivered
      // whole on the item's own page, so reconstruction uses non-preview rows.
      if (item.continuesItem) { assert.ok(item.id); assert.equal(item.srcRefs, undefined); }
      else if (item.preview) { assert.equal(item.fragment.from, 0); continue; }
      else { assert.equal(item.srcRefs[0].sourceEventId, 'source_event'); assert.equal(item.personId, 'a'); }
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
  do { const page = await boundToolOutput('memory_search', result, { query: '主动', cursor }, { counter, budget: 1100 }); assert.ok(size(page) <= 1100); all.push(...page.items.filter(item => !item.preview)); cursor = page.nextCursor; } while (cursor);
  const first = all[0];
  for (const key of ['scope', 'role', 'origin', 'proactiveId', 'sourceAt']) assert.equal(first[key], original[key]);
  assert.deepEqual(first.srcRefs[0], original.srcRefs[0]); assert.equal(first.text, original.text);
  assert.deepEqual(JSON.parse(all[1].text), { if: result.items[1].if, then: result.items[1].then });
});

test('a bounded search page surfaces several D0-shaped matches instead of one envelope or a budget error', async () => {
  // Regression shape from run1 D0 (2026-10-30): staging current message ranked
  // first plus person-scoped history; budget 1500 (schema default retrievalTokens).
  const utf8 = { method: 'utf8_bytes_estimate', count: text => Buffer.byteLength(text, 'utf8') };
  const now = 1793362582586;
  const current = { ...row('阿序，早。昨晚说要戒的东西，今天执行第一天，到现在撑住了。倒是那位五公斤监工，早上六点准时把我踩醒，比闹钟管用。'), id: 'm_current', personId: null, scope: 'staging', sourceAt: now,
    retrieval: { channels: ['lexical'], matchedTerms: ['戒', '猫'], temporal: { eligible: true }, lexicalScore: 13.199947020331297, rankScore: 0.01639344262295082 } };
  const history = i => ({ ...row('第' + i + '条：我家猫从键盘上踩过去，差点把气闸踩成气匣，它叫豆包，五公斤。还说好周六高铁回老家看姥姥。'), id: 'm_hist_' + i,
    personId: 'person_2931743d-4a53-4082-96b1-581b929e27af', scope: 'person', sourceAt: now - 3600e3 + i * 60e3,
    srcRefs: [{ sourceSessionId: 'natural_a_00f4754e3ce14fa3bd5642b93783013f', sourceEventId: '0000000' + i + '-0000-0000-0000-000000000000', sourceKind: 'user', sourceRole: 'user', sourceOrigin: 'user', available: true }],
    retrieval: { channels: ['lexical'], matchedTerms: ['猫'], lexicalScore: 9.1 - i, rankScore: 0.01 } });
  const items = [current, ...Array.from({ length: 9 }, (_, i) => history(i + 1))];
  const diagnostics = { method: 'lexical+association', semantic: { enabled: false, configured: false, indexed: 0, eligible: 25, coverageComplete: false, reason: 'disabled' } };
  // Page 1: whole first row with substantially more than the old 20-codepoint
  // fragment, plus at least one preview row; never TOOL_OUTPUT_BUDGET.
  const first = await boundToolOutput('memory_search', { items, diagnostics }, { query: '猫 戒 第一天', scope: 'all', mode: 'auto' }, { counter: utf8, budget: 1500 });
  assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') <= 1500);
  assert.equal(first.totalMatched, 10);
  const whole = first.items.find(item => !item.preview && !item.continuesItem);
  assert.ok(whole, 'page carries a whole identity row');
  assert.ok(Array.from(whole.text).length > 40, 'whole row text exceeds the old 20-codepoint windows');
  assert.ok(first.items.some(item => item.preview), 'page carries a preview of the next match');
  // The query that previously failed all-or-nothing now returns a readable row.
  const lexical = await boundToolOutput('memory_search', { items: items.slice(1), diagnostics }, { query: '猫', scope: 'all', mode: 'lexical' }, { counter: utf8, budget: 1500 });
  assert.ok(lexical.items.length >= 1); assert.ok(Array.from(lexical.items[0].text).length > 20);
  // Cursor walk reaches every item's complete text with full identity rows.
  const seen = new Map();
  for (const item of first.items) if (!item.preview && !item.continuesItem) seen.set(item.id, (seen.get(item.id) ?? '') + item.text);
  let cursor = first.nextCursor, guard = 0;
  while (cursor && guard++ < 60) {
    const page = await boundToolOutput('memory_search', { items, diagnostics }, { query: '猫 戒 第一天', scope: 'all', mode: 'auto', cursor }, { counter: utf8, budget: 1500 });
    for (const item of page.items) {
      if (item.preview || item.continuesItem) continue;
      seen.set(item.id, (seen.get(item.id) ?? '') + item.text);
      assert.ok(item.srcRefs?.[0] || item.personId === null);
    }
    cursor = page.nextCursor;
  }
  for (const item of items) assert.equal(seen.get(item.id), item.text, 'item ' + item.id + ' reconstructed whole');
});

test('a deferred identity row advances the cursor and offers a seedIds re-read instead of looping', async () => {
  const utf8 = { method: 'utf8_bytes_estimate', count: text => Buffer.byteLength(text, 'utf8') };
  const longId = 'm_' + 'x'.repeat(60);
  const mk = (person, i) => ({ ...row('第' + i + '条较长正文。'.repeat(8)), id: longId, personId: person, scope: 'person', recordType: 'chat',
    srcRefs: [{ sourceSessionId: 'sess_' + 's'.repeat(48), sourceEventId: 'evt_' + 'e'.repeat(48), available: true }] });
  const items = [mk('person_a', 1), mk('person_b', 2)];
  let cursor = null, pages = 0, deferred = 0, cursors = new Set(), guard = 0;
  do {
    const page = await boundToolOutput('memory_search', { items }, { query: '正文', scope: 'all', cursor }, { counter: utf8, budget: 560 });
    pages++; assert.ok(pages <= 10, 'pagination must terminate');
    if (cursor) assert.ok(!cursors.has(cursor), 'cursor must change between pages');
    cursors.add(cursor);
    for (const item of page.items) if (item.textDeferred === 'budget') {
      deferred++;
      assert.ok(Array.isArray(item.rereadWithSeedIds) && item.rereadWithSeedIds[0] === longId, 'deferred row offers a seedIds re-read');
      assert.ok(item.personId !== undefined && item.recordType !== undefined && item.scope !== undefined, 'deferred row keeps composite identity');
    }
    cursor = page.nextCursor;
    assert.ok(guard++ < 20);
  } while (cursor);
  assert.ok(deferred >= 1, 'the tiny budget defers text but the walk still finishes');
});

test('row fragments disambiguate composite identity when bare ids collide across persons', async () => {
  const utf8 = { method: 'utf8_bytes_estimate', count: text => Buffer.byteLength(text, 'utf8') };
  const shared = 'm_shared';
  const items = [
    { ...row('阿澈说：这是昨晚的原话，关于猫和行李。'), id: shared, personId: 'person_alice', scope: 'person', recordType: 'chat' },
    { ...row('另一个人说：完全不同的一句原话。'), id: shared, personId: 'person_bob', scope: 'person', recordType: 'chat' },
  ];
  const byComposite = new Map(), originals = new Map(items.map(item => [[item.id, item.personId].join('|'), item.text]));
  let cursor = null, guard = 0;
  do {
    const page = await boundToolOutput('memory_search', { items }, { query: '原话', scope: 'all', cursor }, { counter: utf8, budget: 700 });
    for (const item of page.items) {
      assert.ok(item.personId === 'person_alice' || item.personId === 'person_bob', 'every row names its person');
      const key = [item.id, item.personId].join('|');
      if (!item.preview && !item.continuesItem) byComposite.set(key, (byComposite.get(key) ?? '') + item.text);
    }
    cursor = page.nextCursor; assert.ok(guard++ < 30);
  } while (cursor);
  assert.deepEqual([...byComposite.keys()].sort(), [...originals.keys()].sort());
  for (const [key, text] of originals) assert.equal(byComposite.get(key), text, 'composite ' + key + ' reconstructed distinctly');
});

test('cursor digests are exactly 22 base64url characters; loose or tampered digests are rejected', async () => {
  const utf8 = { method: 'utf8_bytes_estimate', count: text => Buffer.byteLength(text, 'utf8') };
  const items = [row('一段会被分页的较长正文。'.repeat(40))];
  const args = { query: '正文', scope: 'all' };
  const first = await boundToolOutput('memory_search', { items }, args, { counter: utf8, budget: 800 });
  assert.ok(first.nextCursor);
  const decode = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  const encode = cursor => Buffer.from(JSON.stringify(cursor)).toString('base64url');
  const original = decode(first.nextCursor);
  for (const tamper of [
    { label: 'empty digest', q: '', s: '' },
    { label: 'short digest', q: original.q.slice(0, 5), s: original.s.slice(0, 5) },
    { label: 'oversized digest', q: original.q + original.q, s: original.s + original.s },
    { label: 'non-digest charset', q: '***not-base64!!!', s: original.s },
  ]) {
    const cursor = encode({ ...original, q: tamper.q, s: tamper.s });
    await assert.rejects(boundToolOutput('memory_search', { items }, { ...args, cursor }, { counter: utf8, budget: 800 }),
      error => ['INVALID_TOOL_CURSOR', 'TOOL_CURSOR_STALE'].includes(error.code), tamper.label);
  }
  // Even with tampered digests, changing the query or the result stays rejected.
  await assert.rejects(boundToolOutput('memory_search', { items }, { ...args, query: '别的', cursor: first.nextCursor }, { counter: utf8, budget: 800 }), { code: 'INVALID_TOOL_CURSOR' });
  await assert.rejects(boundToolOutput('memory_search', { items: [row('changed')] }, { ...args, cursor: first.nextCursor }, { counter: utf8, budget: 800 }), { code: 'TOOL_CURSOR_STALE' });
  // The untouched cursor still pages forward (strict validation keeps the honest path usable).
  const next = await boundToolOutput('memory_search', { items }, { ...args, cursor: first.nextCursor }, { counter: utf8, budget: 800 });
  assert.ok(Array.isArray(next.items));
});
