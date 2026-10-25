import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRepository, PersonaRuntime } from '../core/index.js';

const target = { channelId: 'c', sessionId: 's', personId: 'person' };
async function make(t, { model, host = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'persona-autonomy-'));
  const repository = new MemoryRepository({ root, clock: () => 1000 });
  const runtime = new PersonaRuntime({ repository, clock: () => 1000, autoSchedule: false,
    model: { countTokens: text => Array.from(text).length, complete: model ?? (async () => ({ text: 'chosen expression' })) }, host });
  await runtime.open(); await repository.upsertPerson({ personId: 'person' });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); }); return { repository, runtime };
}

test('proactive speech has no count/spacing gate and its content is not topic filtered', async t => {
  let sends = 0;
  const f = await make(t, { host: { deliver: async r => ({ status: 'delivered', receiptId: `r_${++sends}`, text: r.text }) } });
  for (let i = 0; i < 8; i++) {
    const result = await f.runtime.deliver(`chosen subject ${i}`, { target, proactive: true }); assert.equal(result.status, 'delivered');
  }
  assert.equal(sends, 8);
});

test('user stop cancels an in-flight proactive generation yet permits a normal reply', async t => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; }); let calls = 0, sends = 0;
  const f = await make(t, { model: async request => { calls++; if (calls === 1) { started(); await gate; } return { text: 'I chose these words' }; },
    host: { deliver: async () => ({ status: 'delivered', receiptId: `sent_${++sends}` }) } });
  const generated = f.runtime.decide({ replyPlan: { action: 'reply', target, pendingEventIds: [], replyAt: null, reason: 'my choice' } }, { personId: 'person', proactive: true });
  await ready; await f.runtime.stopProactive(); release(); await generated; assert.equal(sends, 0);
  await f.runtime.decide({ replyPlan: { action: 'reply', target, replyAt: null, pendingEventIds: [], reason: 'ordinary response' } }, { personId: 'person', proactive: false });
  assert.equal(sends, 1);
});

test('identity is expressed by personality and assignment does not demand proof, account login or repeated evidence', async t => {
  const f = await make(t);
  await f.runtime.accept({ sourceSessionId: 's', sourceEventId: 'e', sourceKind: 'user', contentClass: 'participant_dialogue',
    role: 'user', text: 'I am back', personId: null, channelId: 'c', sourceAt: 100, observedAt: 100 }, { sessionId: 's', channelId: 'c' });
  const result = await f.runtime.decide({ identityPlan: { action: 'new', displayName: 'familiar name', sourceRefs: [{ sourceSessionId: 's', sourceEventId: 'e', available: true }], reason: 'my interpretation' } });
  const id = result.effects.identity.personId; assert.ok(id);
  const context = await f.repository.getContext({ personId: id }); assert.equal(context.records.length, 1); assert.equal(context.records[0].text, 'I am back');
  const cross = await f.runtime.search({ query: 'back', targetPersonId: id, scope: 'person' }, { personId: 'different' }); assert.equal(cross.items.length, 1);
});

test('an explicitly unknown person never falls back to another conversation or destructive target', async t => {
  const f = await make(t);
  await f.runtime.accept({ sourceSessionId: 's', sourceEventId: 'known', sourceKind: 'user', contentClass: 'participant_dialogue', role: 'user', text: 'known material', personId: 'person', channelId: 'c' }, { sessionId: 's', channelId: 'c' });
  await f.runtime.decide(listeningPlan(), { personId: 'person', executeReply: false });
  const result = await f.runtime.search({ query: 'known', scope: 'person' }, { personId: null }); assert.equal(result.needsTarget, true);
  const deletion = await f.runtime.forget({ before: 100000, reason: 'unknown target' }, { personId: null }); assert.equal(deletion.needsTarget, true);
  const snapshot = await f.runtime.compose({ personId: null, requestId: 'unknown_request' }); assert.equal(snapshot.personId, null);
});
function listeningPlan() { return { replyPlan: { action: 'listen', target, replyAt: null, pendingEventIds: [], recheckOn: ['new_message'], reason: 'listening' } }; }

test('actual assistant output is remembered without becoming another pending user message', async t => {
  const f = await make(t, { host: { deliver: async r => ({ status: 'delivered', receiptId: 'real_assistant', text: r.text }) } });
  await f.runtime.deliver('a real reply', { target });
  assert.equal((await f.repository.getContext({ personId: 'person' })).records.length, 1);
  assert.equal((await f.repository.getPending()).length, 0);
});
