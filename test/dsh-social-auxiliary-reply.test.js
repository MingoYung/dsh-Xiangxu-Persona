import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshModelPort } from '../adapters/dsh/model.js';
import { groupDialogueGuidance } from '../adapters/dsh/social-dialogue.js';

const messages = () => [{ role: 'system', content: 'existing personality and memory' },
  { role: 'user', content: JSON.stringify({ pending: [{ text: '阿岚在吗？', sourceEventId: 'actual-original' }] }) }];
const context = { target: { sessionId: 'registered-qq-group', channelId: 'dsh:registered-qq-group', personId: null } };
const route = { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'high' };
const stripHostIds = request => request.map(({ id, ...message }) => ({ ...message,
  content: typeof message.content === 'string' ? message.content : message.content.map(block => block.text).join('\n') }));

function fixture({ replyContext, response = 'ordinary draft' } = {}) {
  const requests = [], counters = [];
  const port = createDshModelPort({ llm: { async *stream(config) {
    requests.push(config);
    yield { type: 'text-delta', index: 0, text: response };
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } } }, { memoryRoot: 'C:/isolated/personality', getSelection: async () => route,
    replyContext: replyContext === undefined ? undefined : current => replyContext(current, counters) });
  return { port, requests, counters };
}

test('auxiliary reply passes the same group interpretation contract and source facts to the actual model port', async () => {
  const original = messages(), before = structuredClone(original);
  const reference = groupDialogueGuidance() + '\n[current_group_observation]\n' + JSON.stringify({
    accountId: '10001', groupId: '30001', sender: { id: '20001' }, platformMessageId: '-88',
  });
  const response = '```xiangxu-social\n' + JSON.stringify({ understanding: { addressee: 'other', reference: '阿岚' },
    participation: 'join', messages: ['我也在这儿，阿岚还没应声。'] }) + '\n```';
  let callbackCalls = 0;
  const f = fixture({ response, replyContext: async (current, counters) => {
    callbackCalls++; assert.equal(current, context);
    return { text: reference, maxInputTokens: 1000000, countTokens: value => { counters.push(value); return Buffer.byteLength(value); } };
  } });
  const controller = new AbortController();
  const result = await f.port.complete({ purpose: 'reply', messages: original, context, signal: controller.signal, maxOutputTokens: 2048 });
  assert.equal(callbackCalls, 1); assert.equal(f.requests.length, 1); assert.equal(f.counters.length, 1);
  const request = f.requests[0], logical = stripHostIds(request.messages);
  assert.deepEqual(logical.slice(0, original.length), original); assert.deepEqual(original, before);
  assert.equal(logical.length, original.length + 1); assert.equal(logical.at(-1).role, 'system');
  assert.equal(logical.at(-1).source.kind, 'persona-memory:auxiliary-group-context');
  assert.ok(logical.at(-1).content.endsWith(reference)); assert.match(logical.at(-1).content, /不是人类新发言/);
  assert.deepEqual(JSON.parse(f.counters[0]), logical, 'The complete augmented logical request is the one budgeted');
  assert.equal(request.provider, route.provider); assert.equal(request.model, route.model); assert.equal(request.reasoningEffort, 'high');
  assert.equal(request.maxTokens, 2048); assert.equal(request.signal, controller.signal);
  assert.equal(request.xiangxuAccounting.sessionId, context.target.sessionId);
  assert.equal(request.xiangxuAccounting.purpose, 'reply');
  assert.equal(result.text, response, 'The port retains the draft envelope rather than changing identity or projecting visible dialogue');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3, totalTokens: 15 });
});

test('unselected replies and non-reply purposes keep their existing request messages and route', async () => {
  const ordinary = fixture();
  await ordinary.port.complete({ purpose: 'reply', messages: messages(), context });
  assert.deepEqual(stripHostIds(ordinary.requests[0].messages), messages());
  let callbackCalls = 0;
  const unselected = fixture({ replyContext: () => { callbackCalls++; return null; } });
  await unselected.port.complete({ purpose: 'reply', messages: messages(), context: { target: { sessionId: 'private-or-unregistered' } } });
  assert.equal(callbackCalls, 1); assert.deepEqual(stripHostIds(unselected.requests[0].messages), messages());
  for (const purpose of ['control', 'consolidation', 'memory_assistant']) {
    const f = fixture({ response: purpose === 'consolidation' ? '{"entries":[]}' : '{}',
      replyContext: () => { throw new Error('A non-reply purpose must not consult the group scene'); } });
    await f.port.complete({ purpose, messages: messages(), context });
    assert.deepEqual(stripHostIds(f.requests[0].messages), messages());
    assert.equal(f.requests[0].provider, route.provider); assert.equal(f.requests[0].reasoningEffort, 'high');
  }
});

test('the augmented group request cannot bypass the existing input limit or dispatch a partial context', async () => {
  const original = messages(), limit = Buffer.byteLength(JSON.stringify(original));
  const f = fixture({ replyContext: (_current, counters) => ({ text: groupDialogueGuidance(), maxInputTokens: limit,
    countTokens: value => { counters.push(value); return Buffer.byteLength(value); } }) });
  await assert.rejects(f.port.complete({ purpose: 'reply', messages: original, context }), { code: 'MODEL_INPUT_BUDGET' });
  assert.equal(f.requests.length, 0); assert.equal(f.counters.length, 1);
  assert.ok(JSON.parse(f.counters[0]).at(-1).content.includes(groupDialogueGuidance()));
});

test('incomplete scene-budget contracts fail before provider dispatch instead of silently omitting required facts', async () => {
  for (const scene of [
    { text: 'group facts', maxInputTokens: 10000 },
    { text: 'group facts', maxInputTokens: null, countTokens: () => 1 },
    { text: '', maxInputTokens: 10000, countTokens: () => 1 },
    { text: 'group facts', maxInputTokens: 10000, countTokens: () => NaN },
  ]) {
    const f = fixture({ replyContext: () => scene });
    await assert.rejects(f.port.complete({ purpose: 'reply', messages: messages(), context }), { code: 'MODEL_REPLY_CONTEXT_INVALID' });
    assert.equal(f.requests.length, 0);
  }
  const rejected = fixture({ replyContext: async () => { throw Object.assign(new Error('No current registered scene'), { code: 'GROUP_CONTEXT_UNAVAILABLE' }); } });
  await assert.rejects(rejected.port.complete({ purpose: 'reply', messages: messages(), context }), { code: 'GROUP_CONTEXT_UNAVAILABLE' });
  assert.equal(rejected.requests.length, 0);
});
