import test from 'node:test';
import assert from 'node:assert/strict';
import { consolidationContextPage, consolidationMessages } from '../core/prompts.js';
import { createDshModelPort, normalizeConsolidationReply, parseStructuredReply } from '../adapters/dsh/model.js';
import { TOOL_PARAMETERS } from '../adapters/dsh/tool-schema.js';

test('frozen memory context pages preserve Unicode and disclose every unread tail', () => {
  const context = { persona: { anchor: { text: '甲🙂乙'.repeat(2000) }, axes: {} }, identity: null,
    impression: { summary: '旧关系不能被截断后冒充空白' }, codes: [{ label: '河堤', meaning: '慢慢走' }] };
  const run = { input: { context }, inputVersions: { persona: 4 } };
  const before = structuredClone(run), pages = [];
  let cursor = 0;
  do {
    const page = consolidationContextPage(run, { cursor, maxChars: 173 });
    assert.ok(Array.from(page.text).length <= 173);
    assert.equal(page.fragment.from, cursor);
    assert.equal(page.fragment.complete, page.nextCursor === null);
    pages.push(page.text); cursor = page.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(JSON.parse(pages.join('')), context);
  assert.deepEqual(run, before);
  const first = consolidationContextPage(run, { maxChars: 173 });
  const payload = JSON.parse(consolidationMessages(run, { memoryContext: first }).at(-1).content);
  assert.deepEqual(payload.input.context, first);
  assert.equal(payload.input.context.fragment.complete, false);
  assert.ok(!JSON.stringify(payload).includes(context.persona.anchor.text));
  assert.throws(() => consolidationContextPage(run, { cursor: -1 }), { code: 'CONTEXT_CURSOR_INVALID' });
});

test('actual per-request output budget reaches DSH instead of its provider default', async () => {
  const seen = [];
  const port = createDshModelPort({ llm: { async *stream(config) {
    seen.push(config);
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"entries":[],"readContext":{"cursor":4000}}' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } } }, { getSelection: () => ({ provider: 'selected', model: 'selected' }), maxTokens: 20000 });
  const result = await port.complete({ purpose: 'consolidation', messages: [], maxOutputTokens: 4096 });
  assert.equal(seen[0].maxTokens, 4096);
  assert.deepEqual(result.patch, { entries: [], readContext: { cursor: 4000 } });
  await assert.rejects(port.complete({ purpose: 'consolidation', messages: [], maxOutputTokens: 0 }), { code: 'MODEL_OUTPUT_BUDGET' });
  assert.equal(seen.length, 1);
  const fallback = createDshModelPort({ llm: { async *stream(config) {
    seen.push(config);
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"entries":[]}' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } } }, { getSelection: () => ({ provider: 'selected', model: 'selected' }) });
  await fallback.complete({ purpose: 'consolidation', messages: [] });
  assert.equal(seen[1].maxTokens, 16384);
});

test('context reads preserve model proposals through supported JSON wrappers', () => {
  const entries = [{ documentKey: 'persona', recordId: 'anchor', operation: 'upsert', expectedVersion: 4,
    value: { text: '可以改变，也可以暂时不变', srcRefs: [] } }];
  const parsed = normalizeConsolidationReply({ patch: { entries }, readContext: { cursor: 4000 } });
  assert.deepEqual(parsed, { entries, readContext: { cursor: 4000 } });
  assert.deepEqual(normalizeConsolidationReply({ readContext: { cursor: 4000 } }), { entries: [], readContext: { cursor: 4000 } });
  assert.deepEqual(normalizeConsolidationReply({ patch: { entries: [] }, replaceDraft: true }), { entries: [], replaceDraft: true });
  assert.deepEqual(normalizeConsolidationReply({ name: 'persona_memory_patch', arguments: { patch: [] }, replaceDraft: true }), { entries: [], replaceDraft: true });
  const plan = TOOL_PARAMETERS.persona_decide.consolidationPlan.oneOf[0];
  assert.deepEqual(plan.properties.action.enum, ['run', 'defer']);
  assert.ok(plan.properties.targetPersonIds.items.oneOf.some(schema => schema.type === 'null'));
  const run = { input: { context: {} }, inputVersions: { persona: 4 }, candidatePatch: { entries }, validationError: { code: 'SCHEMA_INVALID' } };
  const payload = JSON.parse(consolidationMessages(run, { candidatePatch: null, validationError: null, previousProposedPatch: entries }).at(-1).content);
  assert.equal(payload.candidatePatch, null);
  assert.equal(payload.validationError, null);
  assert.deepEqual(payload.previousProposedPatch, entries);
});

test('a malformed empty choice retains the exact model output for an explicit format correction', () => {
  const value = '{}\n\n**判断**：本页只有工程材料，所以我不改变人格。';
  const run = { input: { chat: [], hot: [], context: {} }, inputVersions: { persona: 0 } };
  assert.ok(consolidationMessages(run).some(message => message.content.includes('For no changes return {"entries":[]}')));
  try {
    // The parser reports the raw response instead of manufacturing an empty patch.
    parseMalformed(value);
    assert.fail('Expected the protocol error');
  } catch (error) { assert.equal(error.code, 'INVALID_MODEL_JSON'); assert.equal(error.responseText, value); }
});

function parseMalformed(value) { return parseStructuredReply(value, 'consolidation'); }
