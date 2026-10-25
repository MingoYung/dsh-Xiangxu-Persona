import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshModelPort, parseStructuredReply, normalizeConsolidationReply } from '../adapters/dsh/model.js';

test('model stream accumulation replaces terminal blocks and uses the host route', async () => {
  let config;
  const port = createDshModelPort({ llm: { async *stream(input) {
    config = input;
    yield { type: 'text-delta', index: 0, text: '{"next' };
    yield { type: 'text-delta', index: 0, text: 'CheckAt":null}' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"nextCheckAt":null}' } };
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 6 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }, get: () => ({ currentSelection: () => ({ provider: 'test', model: 'fixture' }) }) });
  const output = await port.complete({ purpose: 'control', messages: [{ role: 'user', content: 'fixture' }] });
  assert.deepEqual(output.decision, { nextCheckAt: null });
  assert.equal(config.provider, 'test');
  assert.equal(config.messages[0].content[0].type, 'text');
  assert.equal(output.usage.inputTokens, 12);
});
test('a truncated control response is not a successful personality decision', async () => {
  const port = createDshModelPort({ llm: { async *stream() {
    yield { type: 'text-delta', index: 0, text: '{"replyPlan":' };
    yield { type: 'finish', reason: { kind: 'max-tokens' } };
  } } }, { getSelection: () => ({ provider: 'test', model: 'fixture' }) });
  await assert.rejects(port.complete({ purpose: 'control', messages: [] }), { code: 'MODEL_INCOMPLETE' });
  assert.throws(() => parseStructuredReply('unfinished', 'control'), { code: 'INVALID_MODEL_JSON' });
});

test('a model patch wrapper is decoded without changing any model-selected record values or silently fixing enum errors', () => {
  const entries = [{ documentKey: 'global:index', expectedVersion: 0, operation: 'upsert', recordId: 'subjective', value: { kind: 'interpretation', text: 'its own view' } }];
  const result = normalizeConsolidationReply({ name: 'persona_memory_patch', arguments: { patch: entries } });
  assert.deepEqual(result.entries, entries); assert.equal(result.entries[0].value.kind, 'interpretation');
  assert.throws(() => normalizeConsolidationReply({ name: 'unknown_command', arguments: { patch: entries } }), { code: 'INVALID_MODEL_PATCH' });
});

test('actual provider usage survives a structured-response parse failure', async () => {
  const port = createDshModelPort({ llm: { async *stream() {
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{incomplete' } };
    yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 7 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } } }, { getSelection: () => ({ provider: 'real-route', model: 'selected-model' }) });
  await assert.rejects(port.complete({ purpose: 'consolidation', messages: [] }), error => error.code === 'INVALID_MODEL_JSON' && error.usage.outputTokens === 7 && error.model === 'real-route/selected-model');
});
