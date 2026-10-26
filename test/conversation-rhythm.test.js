import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRepository, PersonaRuntime } from '../core/index.js';

// Core integration only: the model, transport and clock below are deterministic
// ports. These tests make no native SDK, external-account or live-model claim.
const environment = personId => ({ version: 1, sessionId: `session_${personId}`, channelId: `channel_${personId}`,
  platform: 'test', timezone: 'UTC', placeDescription: `Selected conversation ${personId}` });
const target = personId => ({ personId, sessionId: `session_${personId}`, channelId: `channel_${personId}` });
const input = (sourceEventId, text, personId = 'a') => ({ sourceSessionId: `session_${personId}`, sourceEventId,
  sourceKind: 'user', contentClass: 'participant_dialogue', channelId: `channel_${personId}`, personId,
  role: 'user', origin: 'user', text, sourceAt: 1100, observedAt: 1100 });
const silent = personId => ({ replyPlan: { action: 'listen', target: target(personId), replyAt: null,
  pendingEventIds: [], recheckOn: ['new_message'] }, nextCheckAt: null });
async function fixture(t, choose = () => silent('a')) {
  const root = await mkdtemp(join(tmpdir(), 'xiangxu-rhythm-'));
  let now = 1000;
  const clock = { now: () => now, set: value => { now = value; } };
  const repository = new MemoryRepository({ root, clock });
  const requests = [], deliveries = [];
  const runtime = new PersonaRuntime({ repository, clock, autoSchedule: false,
    model: { countTokens: text => Array.from(text).length, complete: async request => {
      requests.push(request);
      if (request.purpose === 'control') return { decision: await choose(request) };
      if (request.purpose === 'reply') return { text: '最新消息我看到了。' };
      throw new Error('Unexpected model purpose in rhythm fixture: ' + request.purpose);
    } },
    host: { describeTarget: async selected => environment(selected.personId),
      deliver: async record => { deliveries.push(record); return { status: 'delivered', text: record.text,
        sourceSessionId: record.target.sessionId, sourceEventId: `fixture_${record.deliveryId}`, sourceKind: 'model', deliveredAt: now }; } } });
  await runtime.open(); await repository.upsertPerson({ personId: 'a' }); await repository.upsertPerson({ personId: 'b' });
  t.after(async () => { if (runtime.opened) await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { repository, runtime, clock, requests, deliveries };
}
async function reconsiderLater(f, personId = 'a') {
  await f.runtime.decide({ ...silent(personId), nextCheckAt: 2000 }, {
    ...environment(personId), environment: environment(personId), personId, executeReply: false });
}
const controlBody = request => JSON.parse(request.messages.at(-1).content);

test('a chosen reconsideration reads arrivals received after scheduling and may choose not to say anything', async t => {
  const f = await fixture(t);
  await f.runtime.accept(input('before_schedule', '刚才的话题'), environment('a'));
  await reconsiderLater(f);
  const latest = await f.runtime.accept(input('arrived_later', '我刚才说错了，我们换个话题。'), environment('a'));
  f.clock.set(2000); await f.runtime.handleDue();
  const controls = f.requests.filter(request => request.purpose === 'control');
  assert.equal(controls.length, 1);
  assert.equal(controls[0].context.reason, 'recheck_due');
  assert.ok(controlBody(controls[0]).pending.some(record => record.sourceEventId === 'arrived_later' && record.text === latest.record.text));
  assert.equal(f.deliveries.length, 0); assert.equal(f.requests.some(request => request.purpose === 'reply'), false);
  assert.ok((await f.repository.getPending()).some(record => record.eventId === latest.eventId));
  assert.equal((await f.repository.getRuntime()).schedule.nextCheckAt, null);
});

test('a reconsideration keeps its explicit reply target while a different conversation becomes the latest context', async t => {
  const f = await fixture(t);
  await f.runtime.accept(input('source_a', 'A这边尚未回应的话'), environment('a'));
  await reconsiderLater(f, 'a');
  await f.runtime.accept(input('source_b', 'B这边新来的话', 'b'), environment('b'));
  assert.equal((await f.repository.getRuntime()).execution.lastContext.personId, 'b');
  f.clock.set(2000); await f.runtime.handleDue();
  const request = f.requests.find(item => item.purpose === 'control');
  assert.deepEqual(request.context.target, target('a'));
  assert.equal(request.context.sessionId, 'session_a');
  assert.equal(request.context.environment.placeDescription, 'Selected conversation a');
  assert.equal(request.context.eventContext.personId, 'b');
  assert.deepEqual(controlBody(request).pending.map(record => record.sourceEventId), ['source_a']);
  assert.equal(f.deliveries.length, 0);
  assert.ok((await f.repository.getPending()).some(record => record.sourceEventId === 'source_b'));
});

test('one due reconsideration can create one freshly chosen reply and does not enforce additional message parts', async t => {
  const f = await fixture(t, request => ({ nextCheckAt: null, replyPlan: { action: 'reply', target: target('a'), replyAt: null,
    pendingEventIds: controlBody(request).pending.map(record => record.eventId), recheckOn: ['new_message'] } }));
  await reconsiderLater(f);
  await f.runtime.accept(input('fresh_subject', '现在想说的是另一件事。'), environment('a'));
  f.clock.set(2000); await Promise.all([f.runtime.handleDue(), f.runtime.handleDue()]);
  assert.equal(f.requests.filter(request => request.purpose === 'control').length, 1);
  assert.equal(f.requests.filter(request => request.purpose === 'reply').length, 1);
  assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0].text, '最新消息我看到了。');
  const state = await f.repository.getRuntime();
  assert.equal(state.schedule.nextCheckAt, null); assert.equal(state.currentDecision.replyPlan.replyAt, null);
  assert.equal((await f.repository.getOutbox()).filter(record => record.status === 'delivered').length, 1);
  f.clock.set(1000000); assert.equal((await f.runtime.handleDue()).status, 'not_due');
  assert.equal(f.requests.length, 2); assert.equal(f.deliveries.length, 1);
});

test('disabling proactive contact prevents a due continuation without discarding newly received dialogue', async t => {
  const f = await fixture(t);
  await reconsiderLater(f);
  await f.runtime.stopProactive();
  const received = await f.runtime.accept(input('while_muted', '关闭主动联系后收到的来信。'), environment('a'));
  f.clock.set(2000); assert.equal((await f.runtime.handleDue()).status, 'not_due');
  f.clock.set(1000000); await f.runtime.handleDue();
  assert.equal(f.requests.length, 0); assert.equal(f.deliveries.length, 0);
  assert.equal((await f.repository.getRuntime()).globalMuted, true);
  assert.ok((await f.repository.getPending()).some(record => record.eventId === received.eventId));
});
