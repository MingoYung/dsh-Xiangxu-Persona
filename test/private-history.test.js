import assert from 'node:assert/strict';
import test from 'node:test';
import { readPrivateHistory } from '../adapters/dsh/private-history.js';

const sessionId = 'qq-private';
const ref = sourceEventId => ({ sourceSessionId: sessionId, sourceEventId, available: true });
const user = (seq, id, text, kind = 'user') => ({ seq, time: 100 + seq, type: 'user/message',
  data: { id, role: 'user', source: { kind }, content: [{ type: 'text', text }] } });
const processRow = (id, sourceEventId, kind, content, blockIndex = 0) => ({ id, sourceRef: ref(sourceEventId), kind, blockIndex, content });

test('QQ private archive windows keep visible dialogue separate from retained, non-delegated process', async () => {
  const events = [
    user(0, 'inherited', 'from parent'),
    user(1, 'forgotten', 'withdrawn'),
    { seq: 2, type: 'assistant/message', data: { message: { id: 'delivered', role: 'assistant', content: [
      { type: 'reasoning', text: 'old reasoning' }, { type: 'text', text: 'transport draft' },
    ] } } },
    { seq: 3, type: 'tool/result', data: { result: 'retained result' } },
    { seq: 4, type: 'tool/result', data: { result: 'delegated result' } },
    { seq: 5, type: 'assistant/message', data: { message: { id: 'undelivered', role: 'assistant', content: [
      { type: 'text', text: 'unconfirmed answer' },
    ] } } },
    user(6, 'runtime', 'automatic context', 'runtime-context'),
    user(7, 'current', 'actual message'),
  ];
  const readCalls = [];
  let processReads = 0;
  const options = {
    sessionId, latestSeq: 7,
    query: { readEvent({ seq, before, ...rest }) {
      readCalls.push({ seq, before, ...rest });
      return { session: { id: sessionId }, inheritedEventCount: 1, events: events.slice(seq - before, seq + 1) };
    } },
    isRevoked: sourceRef => sourceRef.sourceEventId === 'forgotten',
    readVisibleMessage: message => message.id === 'delivered' ? 'confirmed platform text'
      : message.role === 'user' ? message.content[0].text : null,
    readProcess: ({ sessionId: current, sourceRefs }) => {
      processReads++;
      assert.equal(current, sessionId);
      assert.deepEqual(sourceRefs.map(source => source.sourceEventId), ['delivered', '3', '4', 'undelivered']);
      return [processRow('h-2', 'delivered', 'reasoning', { mode: 'cached', text: 'old reasoning' }),
        processRow('h-3', '3', 'tool_result', { mode: 'host_trace', available: true }),
        processRow('h-4', '4', 'tool_result', { mode: 'cached', text: 'delegated result' })];
    },
    projectProcessEvent: event => ({ event, isolated: event.seq === 4 }),
  };

  const recent = await readPrivateHistory({ ...options, args: { historyLimit: 5 } });
  assert.deepEqual(recent.items.map(item => item.text), ['actual message']);
  assert.equal(recent.nextBeforeSeq, 3);
  const prior = await readPrivateHistory({ ...options, args: { beforeSeq: recent.nextBeforeSeq } });
  assert.deepEqual(prior.items.map(item => item.text), ['confirmed platform text']);
  assert.equal(prior.nextBeforeSeq, null);
  assert.equal(processReads, 0);

  const detail = await readPrivateHistory({ ...options, args: { includeProcess: true } });
  assert.deepEqual(detail.items.map(item => [item.kind, item.text]), [
    ['dialogue', 'confirmed platform text'], ['reasoning', 'old reasoning'],
    ['tool_result', '{"result":"retained result"}'], ['dialogue', 'actual message'],
  ]);
  assert.deepEqual(detail.items[2].sourceRef, ref('3'));
  assert.deepEqual(detail.items[2].sourceRecordIds, ['h-3']);
  assert.deepEqual(readCalls.map(({ seq, before, after }) => [seq, before, after]), [[7, 4, 0], [2, 2, 0], [7, 7, 0]]);

  const archival = await readPrivateHistory({ ...options, readVisibleMessage: message => message.role === 'user' ? message.content[0].text : null,
    readDialogueSources({ sourceRefs }) {
      assert.deepEqual(sourceRefs, [ref('delivered'), ref('undelivered')]);
      const row = { ...ref('delivered'), role: 'assistant', channelId: `dsh:${sessionId}`, origin: 'ai_reply', contentClass: 'participant_dialogue' };
      return [{ ...row, text: 'archived platform text' }, { ...row, ...ref('undelivered'), channelId: 'other', text: 'wrong scope' }];
    } });
  assert.deepEqual(archival.items.map(item => [item.role, item.text]), [['assistant', 'archived platform text'], ['user', 'actual message']]);
});

test('QQ private archive rejects a mismatched host page and out-of-range cursor', async () => {
  const options = { sessionId, latestSeq: 0, query: { readEvent: () => ({ session: { id: 'other-private' }, events: [user(0, 'foreign', 'secret')] }) },
    isRevoked: () => false, readVisibleMessage: () => { throw new Error('wrong session reached the reader'); } };
  await assert.rejects(readPrivateHistory(options), { code: 'QQ_PRIVATE_HISTORY_UNAVAILABLE' });
  await assert.rejects(readPrivateHistory({ ...options, args: { beforeSeq: 2 } }), { code: 'QQ_PRIVATE_HISTORY_CURSOR' });
});
