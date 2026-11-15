import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshCoordinator } from '../adapters/dsh/index.js';
import { externalConversationReference } from '../adapters/dsh/conversation-reference.js';
import { formatLocalTime } from '../core/decision-time.js';

const channel = { platform: 'qq', accountId: 'time-bot', conversation: { type: 'private', id: 'time-chat' }, sender: { id: 'time-sender' } };
const parseReference = text => JSON.parse(text.split('[conversation_identity_reference]\n')[1].split('\n')[0]);

test('local clock uses the configured date boundary and preserves DST offsets in a repeated hour', () => {
  const shanghai = Date.parse('2026-11-10T16:00:00Z');
  assert.equal(formatLocalTime(shanghai, 'Asia/Shanghai'), '2026-11-11T00:00:00+08:00');
  assert.equal(formatLocalTime(shanghai, 'UTC'), '2026-11-10T16:00:00+00:00');
  assert.equal(formatLocalTime(Date.parse('2026-11-01T05:30:00Z'), 'America/New_York'), '2026-11-01T01:30:00-04:00');
  assert.equal(formatLocalTime(Date.parse('2026-11-01T06:30:00Z'), 'America/New_York'), '2026-11-01T01:30:00-05:00');
  assert.equal(formatLocalTime(null, 'Asia/Shanghai'), null);
  assert.equal(formatLocalTime(shanghai, 'unknown-zone'), null);
});

test('DSH assembles the clock and keeps each accepted platform source on its own calendar date across midnight', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiangxu-time-'));
  const session = { id: 'xiangxu-social-' + 'a'.repeat(32), header: {}, deriveMessages: () => [] };
  const agent = { id: session.id, session, inbox: { nextTurn: [], nextStep: [] },
    ctx: { on: () => () => {}, tools: { restrict: () => () => {}, register: () => () => {} } } };
  const coordinator = createDshCoordinator({ agents: { get: () => agent }, llm: {} },
    { memoryRoot: root, operatorControl: false, timezone: 'UTC' });
  t.after(async () => { await coordinator.close(); await rm(root, { recursive: true, force: true }); });
  await coordinator.ready;
  await coordinator.attachAgent(agent);
  let now = Date.parse('2026-11-10T16:00:00Z');
  coordinator.runtime.clock = () => now;
  const environment = async () => {
    const result = await coordinator.preparePersonaAssembly(agent, { sections: [] });
    return JSON.parse(result.sections.find(section => section.name === 'persona-memory:live').text.split('\n')[1]);
  };
  assert.equal((await environment()).localTime, '2026-11-10T16:00:00+00:00');
  await coordinator.executeCommand('config', { timezone: 'Asia/Shanghai' });
  const facts = await environment();
  assert.equal(facts.now, now);
  assert.equal(facts.timezone, 'Asia/Shanghai');
  assert.equal(facts.localTime, '2026-11-11T00:00:00+08:00');
  const sourceAt = Date.parse('2001-11-07T18:00:00Z'), observedAfter = Date.now();
  await coordinator.observeEvent(session, { type: 'user/message', seq: 1, time: sourceAt,
    data: { id: 'source', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '恢复时读到的旧来信' }] } }, { reconcileOnly: true });
  const [record] = await coordinator.repository.getPending();
  assert.equal(record.sourceAt, sourceAt);
  assert.ok(record.observedAt >= observedAfter && record.observedAt <= Date.now());
  assert.equal(record.timezone, 'Asia/Shanghai');

  await coordinator.registerExternalChannel(session.id, channel);
  now = Date.parse('2026-11-10T16:03:00Z');
  const platformSourceAt = Date.parse('2026-11-10T15:58:00Z');
  await coordinator.observeEvent(session, { type: 'user/message', seq: 2, time: now,
    data: { id: 'midnight', role: 'user', source: { kind: 'user', xiangxuChannel: channel, platformMessageId: 'midnight-platform',
      platformSourceAt }, content: [{ type: 'text', text: '我发这条算昨天还是今天？' }] } });
  const request = await coordinator.preparePersonaAssembly(agent, { sections: [] });
  const { inputSource } = parseReference(request.sections.find(section => section.name === 'persona-memory:channel-output').text);
  assert.equal(inputSource.platformMessageId, 'midnight-platform');
  assert.equal(inputSource.sourceAt, platformSourceAt);
  assert.equal(inputSource.sourceAtLocal, '2026-11-10T23:58:00+08:00');
  assert.deepEqual(inputSource.relativeToRequest, { status: 'computed', calendarDaysAgo: 1, elapsedMs: 300_000,
    summary: '按 Asia/Shanghai 的日历，这条来信的平台日期是昨天，与本次请求相隔 5 分钟。' });
  const accepted = (await coordinator.repository.getPending()).find(item => item.sourceEventId === 'midnight');
  assert.equal(accepted.sourceAt, platformSourceAt);
  assert.notEqual(accepted.observedAt, accepted.sourceAt);
});

test('platform timing uses elapsed milliseconds across DST and does not invent missing or future ages', () => {
  const timezone = 'America/New_York', now = Date.parse('2026-11-01T06:30:00Z');
  const snapshot = { timezone, now, localTime: formatLocalTime(now, timezone) };
  const reference = sourceAt => parseReference(externalConversationReference(channel, snapshot, { platformMessageId: 'event', sourceAt })).inputSource;
  const repeated = reference(Date.parse('2026-11-01T05:30:00Z'));
  assert.equal(repeated.sourceAtLocal, '2026-11-01T01:30:00-04:00');
  assert.equal(repeated.relativeToRequest.calendarDaysAgo, 0);
  assert.equal(repeated.relativeToRequest.elapsedMs, 3_600_000);
  assert.match(repeated.relativeToRequest.summary, /今天.*1 小时/);
  assert.equal(reference(undefined).relativeToRequest, undefined);
  const future = reference(now + 60_000).relativeToRequest;
  assert.equal(future.status, 'source_after_request');
  assert.equal(future.elapsedMs, undefined);
  assert.equal(future.calendarDaysAgo, undefined);
});
