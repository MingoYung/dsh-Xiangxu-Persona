import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { privateExpressionMessages } from '../adapters/dsh/private-expression.js';

test('private expression keeps actual dialogue and the complete current tool round without replaying old process', () => {
  const text = value => ({ type: 'text', text: value });
  const participant = id => ({ id, role: 'user', source: { platformMessageId: id + '-platform' }, content: [text(id)] });
  const call = id => ({ id, role: 'assistant', content: [{ type: 'reasoning', text: id }, { type: 'tool-call', id }] });
  const result = id => ({ role: 'tool', toolCallId: id, content: [text(id)] });
  const current = participant('current'), currentCall = call('active'), currentResult = result('active');
  const oldUser = participant('old-user'), oldAssistant = { id: 'old-assistant', role: 'assistant',
    source: { provider: 'test', replayState: { private: true } },
    content: [{ type: 'reasoning', text: 'not visible' }, text('delivered')] };
  const messages = [
    { id: 'system', role: 'system', content: [text('identity')] }, oldUser, call('old-call'), result('old-call'),
    { id: 'old-context', role: 'user', content: [text('automatic history')] },
    { id: 'undelivered', role: 'assistant', content: [text('not sent')] }, oldAssistant, participant('forgotten'),
    current, currentCall, currentResult,
  ];
  const before = structuredClone(messages);
  Object.freeze(messages);
  const projection = privateExpressionMessages(messages, {
    currentSources: [{ sourceEventId: 'current', platformMessageId: 'current-platform' }],
    isParticipant: message => message.role === 'user' && Boolean(message.source?.platformMessageId),
    receiptFor: id => id === 'old-assistant' && { status: 'delivered', textHash: createHash('sha256').update('delivered').digest('hex') },
    isRevoked: id => id === 'forgotten',
  });
  assert.deepEqual(projection, [
    messages[0], oldUser, { ...oldAssistant, source: { provider: 'test' }, content: [text('delivered')] },
    current, currentCall, currentResult,
  ]);
  assert.equal(projection.at(-1), currentResult);
  assert.deepEqual(messages, before);
});
