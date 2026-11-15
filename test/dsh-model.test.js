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


test('auxiliary accounting follows explicit and persisted routing without changing model input or native projection fields', async () => {
  const received = [];
  const selection = { provider: 'fixed-provider', model: 'fixed-model', reasoningEffort: 'high' };
  const port = createDshModelPort({ llm: { async *stream(config) {
    received.push(config);
    const text = config.xiangxuAccounting.purpose === 'control' ? '{"replyPlan":{"action":"wait"}}'
      : config.xiangxuAccounting.purpose === 'consolidation' ? '{"entries":[]}' : 'own chosen response';
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'usage', usage: { totalTokens: 0 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } } }, { memoryRoot: 'C:/isolated/persona', getSelection: () => selection });
  const cases = [
    ['control', { sessionId: 'incoming', target: { sessionId: 'selected-target' } }, 'selected-target'],
    ['consolidation', JSON.parse(JSON.stringify({ sessionId: 'persisted-job', environment: { sessionId: 'old-environment' } })), 'persisted-job'],
    ['memory_assistant', { environment: { sessionId: 'environment-owner' } }, 'environment-owner'],
    ['reply', { sessionId: 'proactive-owner', proactive: true }, 'proactive-owner'],
  ];
  const messages = [{ id: 'source-1', role: 'user', content: 'original user words' }];
  const before = structuredClone(messages);
  const signal = new AbortController().signal;
  for (const [purpose, context, sessionId] of cases) {
    context.memoryRoot = 'untrusted-context-root';
    const result = await port.complete({ purpose, context, messages, signal, maxOutputTokens: 3072 });
    const config = received.at(-1);
    assert.deepEqual(config.xiangxuAccounting, { sessionId, memoryRoot: 'C:/isolated/persona', purpose });
    assert.equal(Object.hasOwn(config, 'sessionId'), false, 'auxiliary metadata cannot enter native reply projection guard');
    assert.equal(Object.hasOwn(config, 'purpose'), false, 'native purpose semantics remain unchanged');
    assert.equal(config.signal, signal);
    assert.equal(config.provider, selection.provider); assert.equal(config.model, selection.model);
    assert.equal(config.reasoningEffort, 'high'); assert.equal(config.maxTokens, 3072);
    assert.deepEqual(config.messages, [{ id: 'source-1', role: 'user', content: [{ type: 'text', text: 'original user words' }] }]);
    assert.equal(result.usage.totalTokens, 0);
    if (purpose === 'control') assert.equal(result.decision.replyPlan.action, 'wait');
    if (purpose === 'consolidation') assert.deepEqual(result.patch.entries, []);
  }
  assert.deepEqual(messages, before, 'routing evidence must not rewrite message objects');
});

test('missing auxiliary routing remains explicit null and cannot inherit a previous request or context root', async () => {
  const received = [];
  const port = createDshModelPort({ llm: { async *stream(config) {
    received.push(config);
    yield { type: 'text-delta', index: 0, text: 'fixed' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } } }, { getSelection: () => ({ provider: 'fixed', model: 'fixed' }) });
  await port.complete({ purpose: 'reply', context: { sessionId: 'prior-owner' }, messages: [] });
  await port.complete({ purpose: 'reply', context: { memoryRoot: 'must-not-be-trusted' }, messages: [] });
  assert.deepEqual(received[0].xiangxuAccounting, { sessionId: 'prior-owner', memoryRoot: null, purpose: 'reply' });
  assert.deepEqual(received[1].xiangxuAccounting, { sessionId: null, memoryRoot: null, purpose: 'reply' });
});

test('an explicitly resolved host agent supplies its actual route when context has no session', async () => {
  let received;
  const agent = { session: { id: 'resolved-host-session', requestHeader: () => ({ config: { provider: 'host', model: 'host-model' } }) }, ctx: { llm: { async *stream(config) {
    received = config;
    yield { type: 'text-delta', index: 0, text: 'fixed' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } } } };
  const port = createDshModelPort({ llm: { stream() { throw Error('Wrong global llm service'); } } }, { memoryRoot: 'C:/fixed/root', getAgent: () => agent });
  await port.complete({ purpose: 'reply', messages: [] });
  assert.deepEqual(received.xiangxuAccounting, { sessionId: 'resolved-host-session', memoryRoot: 'C:/fixed/root', purpose: 'reply' });
  assert.equal(received.provider, 'host'); assert.equal(received.model, 'host-model');
});
