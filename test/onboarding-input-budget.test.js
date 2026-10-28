import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MemoryRepository } from '../core/repository.js';
import { PersonaRuntime } from '../core/runtime.js';

const environment = { version: 1, channelId: 'channel_a', sessionId: 'session_a', platform: 'fixture', timezone: 'UTC' };
const target = { channelId: 'channel_a', sessionId: 'session_a', personId: 'a' };
const listen = () => ({ replyPlan: { action: 'listen', target: null, replyAt: null, pendingEventIds: [], recheckOn: ['new_message'] } });
const original = (id, text) => ({ sourceSessionId: 'session_a', sourceEventId: id, sourceKind: 'user', contentClass: 'participant_dialogue',
  role: 'user', origin: 'user', text, personId: 'a', channelId: 'channel_a', sourceAt: 100, observedAt: 100 });
async function fixture(t, { inputBudget = 5000, hostDecision = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiangxu-input-budget-'));
  const repository = new MemoryRepository({ root, clock: () => 1000 });
  const requests = [], hostRequests = [], deliveries = [];
  const model = { maxInputTokens: inputBudget, countTokens: text => Array.from(text).length,
    complete: async request => { requests.push(request); return request.purpose === 'reply' ? { text: '实际回复' } : { decision: listen() }; } };
  const host = { deliver: async record => { deliveries.push(record); return { status: 'delivered', receiptId: 'fixture:' + record.deliveryId }; },
    ...(hostDecision ? { requestDecision: async request => { hostRequests.push(request); return { queued: true }; } } : {}) };
  const runtime = new PersonaRuntime({ repository, clock: () => 1000, model, host, autoSchedule: false });
  await runtime.open(); await repository.upsertPerson({ personId: 'a' }); await repository.upsertPerson({ personId: 'b' });
  t.after(async () => {
    if (runtime.opened) await runtime.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('xiangxu-input-budget-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { repository, runtime, requests, hostRequests, deliveries, model };
}
function actualEnvironment(snapshotText) {
  assert.ok(snapshotText.startsWith('[environment]\n'));
  return JSON.parse(snapshotText.split('\n')[1]);
}

test('small control requests fit actual framing while retaining full route, availability and unconsumed source tails', async t => {
  const f = await fixture(t, { inputBudget: 6000 });
  await f.repository.updateSelfProfile({ current: { name: '相续' } }, { actor: 'persona' });
  const source = await f.runtime.accept(original('long', 'BEGIN_TEXT_' + '很长的原始消息😀'.repeat(3000)), environment);
  await f.runtime.accept(original('unseen_tail', '这条尚未被这一页读取'), environment);
  const pending = await f.repository.getPending();
  const result = await f.runtime.handleSignal('new_message', { personId: 'a', environment, incoming: source.record,
    wakeSummary: [{ personId: 'a', channelId: 'channel_a', sessionId: 'session_a', records: pending }] });
  assert.equal(f.requests.length, 1);
  const request = f.requests[0], serialized = JSON.stringify(request.messages);
  assert.ok(Array.from(serialized).length <= 6000);
  assert.equal(serialized.split('BEGIN_TEXT_').length - 1, 1);
  const payload = JSON.parse(request.messages.at(-1).content);
  assert.equal(payload.pending.length, 1); assert.equal(payload.pending[0].fragment.complete, false);
  assert.equal(payload.pendingPage.originalsRemainQueryable, true);
  assert.ok(!JSON.stringify(payload.wakeSummary).includes('BEGIN_TEXT_'));
  assert.equal(result.pendingPage.completeEventIds.length, 0);
  assert.equal((await f.repository.getPending()).length, 2);
  const snapshots = await f.repository.getSnapshots(); assert.equal(snapshots.length, 1);
  const snapshot = snapshots[0]; assert.equal(snapshot.injectedText, request.messages[1].content);
  assert.ok(snapshot.tokens <= 2970); assert.equal(f.runtime.config.contextBudget.totalTokens, 2970);
  const facts = actualEnvironment(snapshot.injectedText);
  assert.deepEqual(facts.target, target); assert.equal(facts.timezone, 'UTC'); assert.equal(facts.now, 1000);
  assert.equal(facts.memoryAvailability.retrieval, 'not_requested'); assert.equal(facts.memoryAvailability.storeContent, 'not_assessed');
  assert.ok(snapshot.injectedText.includes('相续')); assert.ok(snapshot.selfProfileReference.shown.includes('current.name'));
  assert.equal(snapshot.mandatoryContext.complete, true);
});

test('a tight control envelope cannot drop required identity and recent facts merely to admit a source fragment', async t => {
  const f = await fixture(t, { inputBudget: 5000 });
  await f.repository.updateSelfProfile({ current: { name: '相续' } }, { actor: 'persona' });
  const source = await f.runtime.accept(original('tight-long', 'BEGIN_TEXT_' + '很长的原始消息😀'.repeat(3000)), environment);
  await f.runtime.accept(original('tight-tail', '这条尚未被这一页读取'), environment);
  const pending = await f.repository.getPending();
  await assert.rejects(f.runtime.handleSignal('new_message', { personId: 'a', environment, incoming: source.record,
    wakeSummary: [{ personId: 'a', channelId: 'channel_a', sessionId: 'session_a', records: pending }] }), { code: 'MODEL_INPUT_BUDGET' });
  assert.equal(f.requests.length, 0); assert.equal((await f.repository.getSnapshots()).length, 0);
  assert.equal((await f.repository.getPending()).length, 2);
});

test('reply requests count the actual outgoing framing and include a long incoming original only in the selected pending fragment', async t => {
  const f = await fixture(t);
  const source = await f.runtime.accept(original('reply-original', 'REPLY_BEGIN_' + '原始长消息😀'.repeat(3000)), environment);
  await f.runtime.accept(original('reply-tail', '还没读到的下一条'), environment);
  await f.runtime._reply({ personId: 'a', environment, target, incoming: source.record, pending: await f.repository.getPending() });
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].purpose, 'reply');
  const request = f.requests[0], serialized = JSON.stringify(request.messages), payload = JSON.parse(request.messages.at(-1).content);
  assert.ok(Array.from(serialized).length <= 5000);
  assert.equal(serialized.split('REPLY_BEGIN_').length - 1, 1);
  assert.deepEqual(payload.incoming, { eventId: source.eventId, sourceSessionId: 'session_a', sourceEventId: 'reply-original' });
  assert.equal(payload.pending.length, 1); assert.equal(payload.pending[0].fragment.complete, false);
  assert.equal(f.deliveries.length, 1); assert.deepEqual(f.deliveries[0].pendingEventIds, []);
  assert.equal((await f.repository.getPending()).length, 2);
  assert.equal((await f.repository.getSnapshots()).length, 1);
});

test('impossible framing keeps sources and offsets untouched, does not call the model, and does not save probe snapshots', async t => {
  const f = await fixture(t, { inputBudget: 256 });
  const source = await f.runtime.accept(original('too-small', '原文仍需保留'), environment);
  const before = await f.repository.getRuntime();
  await assert.rejects(f.runtime.handleSignal('new_message', { personId: 'a', environment, incoming: source.record }), { code: 'MODEL_INPUT_BUDGET' });
  assert.equal(f.requests.length, 0); assert.equal((await f.repository.getSnapshots()).length, 0);
  assert.equal((await f.repository.getPending())[0].text, source.record.text);
  assert.deepEqual((await f.repository.getRuntime()).execution?.pendingOffsets, before.execution?.pendingOffsets);
});

test('native decision port receives exactly the single persisted fitted snapshot without an extra model call', async t => {
  const f = await fixture(t, { hostDecision: true });
  const source = await f.runtime.accept(original('host-control', 'HOST_BEGIN_' + '原始消息'.repeat(3000)), environment);
  const result = await f.runtime.handleSignal('new_message', { personId: 'a', environment, incoming: source.record });
  assert.equal(result.status, 'queued'); assert.equal(f.requests.length, 0); assert.equal(f.hostRequests.length, 1);
  const snapshots = await f.repository.getSnapshots(); assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0], f.hostRequests[0].snapshot);
  assert.equal(f.hostRequests[0].pending.length, 1); assert.ok(f.hostRequests[0].pending[0].text.startsWith('HOST_BEGIN_'));
  assert.equal((await f.repository.getPending()).length, 1);
});
