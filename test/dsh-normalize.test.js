import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDshEvent, dshEnvironment } from '../adapters/dsh/normalize.js';

const session = { id: 's1', header: { cwd: 'C:/dedicated-test' } };
test('DSH source envelope excludes automatic user-role injections from C1 without text heuristics', () => {
  for (const kind of ['runtime-context', 'agent-instructions', 'plugin:clearai', 'agent-message', 'subagent-settled']) {
    const output = normalizeDshEvent(session, { type: 'user/message', seq: 7, time: 10, data: { source: { kind }, content: [{ type: 'text', text: 'automatic material' }] } }, { now: 20 });
    assert.equal(output.dialogue, null);
    assert.equal(output.hot.length, 1);
    assert.equal(output.hot[0].sourceRef.sourceEventId, '7');
  }
  const output = normalizeDshEvent(session, { type: 'user/message', seq: 8, time: 10, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '<system-reminder>literal user text</system-reminder>' }] } }, { now: 20 });
  assert.equal(output.dialogue.text, '<system-reminder>literal user text</system-reminder>');
  assert.equal(output.dialogue.sourceAt, 10);
  assert.equal(output.dialogue.observedAt, 20);
});
test('DSH final assistant text and available process blocks are distinct', () => {
  const output = normalizeDshEvent(session, { type: 'assistant/message', seq: 11, time: 40, data: { message: { source: { kind: 'model' }, content: [
    { type: 'reasoning', text: 'available trace' }, { type: 'tool-call', id: 'c1', name: 'lookup', arguments: '{}' }, { type: 'text', text: 'Hello 🌙' },
  ] } } }, { proactiveId: 'pr1', now: 50 });
  assert.equal(output.dialogue.text, 'Hello 🌙');
  assert.equal(output.dialogue.chars, 7);
  assert.equal(output.dialogue.origin, 'ai_initiated');
  assert.deepEqual(output.hot.map(record => record.kind), ['reasoning', 'tool_call', 'dialogue']);
});
test('source classification can be explicitly mapped by a channel adapter', () => {
  const output = normalizeDshEvent(session, { type: 'user/message', seq: 9, time: 10, data: { source: { kind: 'im-bridge' }, content: [{ type: 'text', text: 'from a real participant' }] } }, { participantSourceKinds: ['user', 'im-bridge'] });
  assert.equal(output.dialogue.sourceKind, 'im-bridge');
});
test('an event without a stable sequence is not given an invented stable key', () => {
  assert.equal(normalizeDshEvent(session, { type: 'user/message', data: {} }).ignored, 'missing_stable_source');
  const environment = dshEnvironment({ session }, { now: 123, timezone: 'Asia/Shanghai' });
  assert.equal(environment.sessionId, 's1');
  assert.equal(environment.visual.available, false);
});
test('an inbox message retains its root identity when the final host event is published', () => {
  const message = { id: 'stable-message-id', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'received while sleeping' }] };
  const inbox = normalizeDshEvent(session, { type: 'user/message', data: message }, { now: 10 });
  const committed = normalizeDshEvent(session, { type: 'user/message', seq: 99, time: 10, data: message }, { now: 20 });
  assert.equal(inbox.dialogue.sourceEventId, 'stable-message-id');
  assert.equal(inbox.dialogue.sourceEventId, committed.dialogue.sourceEventId);
});

test('relationship routing never becomes the assistant or automatic-material speaker', () => {
  const event = { type: 'assistant/message', seq: 12, data: { message: { content: [{ type: 'text', text: '我在这段关系里说的话。' }] } } };
  const output = normalizeDshEvent(session, event, { personId: 'person_b', speakerId: 'person_b' });
  assert.equal(output.dialogue.personId, 'person_b');
  assert.equal(output.dialogue.speakerId, null); assert.equal(output.dialogue.role, 'assistant');
  assert.equal(output.hot[0].speakerId, null);
  const explicit = normalizeDshEvent(session, event, { personId: 'person_b', assistantSpeakerId: 'ai_instance' });
  assert.equal(explicit.dialogue.speakerId, 'ai_instance');
  const automatic = normalizeDshEvent(session, { type: 'user/message', seq: 13,
    data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'historical instructions' }] } }, { personId: 'person_b' });
  assert.equal(automatic.dialogue, null); assert.equal(automatic.hot[0].speakerId, null);
  const user = normalizeDshEvent(session, { type: 'user/message', seq: 14,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '真人自己的话' }] } }, { personId: 'person_b' });
  assert.equal(user.dialogue.speakerId, 'person_b');
});
