import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRepository, PersonaRuntime } from '../core/index.js';

const env = (id = 'a') => ({ version: 1, channelId: `channel_${id}`, sessionId: `session_${id}`, platform: 'test', timezone: 'UTC' });
const chat = (id, who = 'a') => ({ sourceSessionId: `session_${who}`, sourceEventId: id, sourceKind: 'user', contentClass: 'participant_dialogue',
  role: 'user', origin: 'user', text: `message ${id}`, personId: who, channelId: `channel_${who}`, sourceAt: 100, observedAt: 100 });
const target = (id = 'a') => ({ channelId: `channel_${id}`, sessionId: `session_${id}`, personId: id });
const listen = () => ({ replyPlan: { action: 'listen', target: null, replyAt: null, pendingEventIds: [], recheckOn: ['new_message'], reason: 'I choose to listen.' } });
function fakeClock(start = 1000) {
  let value = start, next = 0; const timers = new Map();
  return { now: () => value, set: n => { value = n; }, timers,
    setTimeout: (fn, ms) => { const id = ++next; timers.set(id, { fn, at: value + ms }); return id; }, clearTimeout: id => timers.delete(id) };
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function fixture(t, { clock = fakeClock(), model = {}, host = {}, config = {}, autoSchedule = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'persona-runtime-'));
  const repository = new MemoryRepository({ root, clock, config });
  const complete = model.complete ?? (async request => request.purpose === 'control' ? { decision: listen() } : request.purpose === 'reply' ? { text: 'hello' } : { patch: [] });
  const runtime = new PersonaRuntime({ repository, clock, config, model: { countTokens: text => Array.from(text).length, ...model, complete }, host, autoSchedule });
  await runtime.open(); await repository.upsertPerson({ personId: 'a' }); await repository.upsertPerson({ personId: 'b' });
  t.after(async () => { if (runtime.opened) await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { root, repository, runtime, clock };
}

test('partial decisions preserve complete effective state and restart restores selected timers/listeners', async t => {
  const clock = fakeClock(), calls = [];
  const f = await fixture(t, { clock, autoSchedule: true, model: { complete: async r => { calls.push(r); return { decision: listen() }; } } });
  await f.runtime.decide({ attention: { observeChannelIds: ['channel_a'] }, replyPlan: { action: 'wait', target: target(), replyAt: 5000, pendingEventIds: [], reason: 'wait' } }, { environment: env(), personId: 'a' });
  await f.runtime.decide({ nextCheckAt: 7000 }, { environment: env(), personId: 'a' });
  let state = await f.repository.getRuntime();
  assert.equal(state.currentDecision.replyPlan.target.personId, 'a'); assert.equal(state.currentDecision.replyPlan.replyAt, 5000);
  await f.runtime.close(); await f.runtime.open();
  assert.equal(clock.timers.size, 1); assert.equal([...clock.timers.values()][0].at, 5000);
  clock.set(5000); await f.runtime.handleDue(); assert.equal(calls.length, 1);
  state = await f.repository.getRuntime(); assert.equal(state.currentDecision.replyPlan.action, 'listen'); assert.equal(state.schedule.nextCheckAt, 7000);
  await f.runtime.decide({ nextCheckAt: null }); assert.equal(clock.timers.size, 0);
  clock.set(900000); await f.runtime.handleDue(); assert.equal(calls.length, 1);
  await f.runtime.handleSignal('environment_change'); assert.equal(calls.length, 1);
  await f.runtime.handleSignal('new_message'); assert.equal(calls.length, 2);
});

test('sleep keeps arrivals while model consolidation is running, is silent, and wake groups real subjects', async t => {
  const entered = deferred(), finish = deferred(), wake = [];
  let first = true;
  const f = await fixture(t, { model: { complete: async request => {
    if (request.purpose === 'consolidation') { if (first) { first = false; entered.resolve(); await finish.promise; } return { patch: [] }; }
    return { decision: listen() };
  } }, host: { deliver: () => { throw new Error('sleep must prevent delivery'); }, onWake: summary => { wake.push(summary); return { accepted: true }; } } });
  await f.repository.upsertPerson({ personId: 'a' }); await f.repository.upsertPerson({ personId: 'b' });
  await f.runtime.accept(chat('before'), env());
  await f.runtime.decide({ sleepPlan: { action: 'sleep', wakeAt: null, wakeCondition: 'explicit_wake', reason: 'my choice' },
    consolidationPlan: { action: 'run', targetPersonIds: ['a'] } }, { environment: env(), personId: 'a' });
  await entered.promise;
  await f.runtime.accept(chat('during', 'b'), env('b'));
  assert.equal((await f.repository.getPending()).length, 2);
  const blocked = await f.runtime.deliver('not now', { target: target(), proactive: true }); assert.equal(blocked.blockedBy, 'sleeping');
  finish.resolve(); await f.runtime.idle();
  assert.equal((await f.repository.getRuntime()).sleep.state, 'sleeping');
  await f.runtime.handleSignal('new_message'); assert.equal(wake.length, 0);
  await f.runtime.handleSignal('explicit_wake'); assert.equal(wake.length, 1);
  assert.deepEqual(wake[0].groups.map(g => g.personId).sort(), ['a', 'b']);
  assert.equal((await f.repository.getPending()).length, 0);
});

test('failed model consolidation does not consume source/hot, next successful batch consumes only selected increment', async t => {
  let fail = true;
  const f = await fixture(t, { model: { complete: async () => { if (fail) throw new Error('network failed'); return { patch: [] }; } } });
  await f.runtime.accept(chat('raw'), env());
  await f.repository.captureHot({ personId: 'a', sourceRef: { sourceSessionId: 'session_a', sourceEventId: 'trace', available: true },
    sourceKind: 'reasoning', origin: 'ai_reply', kind: 'reasoning', content: { mode: 'cached', text: 'reason', chars: 6 }, sourceAt: 100, observedAt: 100 });
  await assert.rejects(f.runtime.consolidate({ personId: 'a' }), /network failed/);
  const retained = await f.repository.prepareConsolidation({ personId: 'a' }); assert.equal(retained.input.hot.length, 1); assert.equal(retained.input.chat.length, 1);
  fail = false; await f.runtime.consolidate({ personId: 'a' });
  const next = await f.repository.prepareConsolidation({ personId: 'a' }); assert.equal(next.input.hot.length, 0); assert.equal(next.input.chat.length, 0);
  const usage = await f.repository.getUsage(); assert.equal(usage.filter(x => x.purpose === 'consolidation').length, 2);
});

test('request snapshots are detached, frozen, separately attributed and counted with the actual supplied counter', async t => {
  const f = await fixture(t);
  await f.runtime.accept(chat('A', 'a'), env('a')); await f.runtime.accept(chat('B', 'b'), env('b'));
  const [a, b] = await Promise.all([
    f.runtime.compose({ requestId: 'request_a', environment: env('a'), personId: 'a', memories: [{ id: 'm_a', personId: 'a', text: 'A material' }] }),
    f.runtime.compose({ requestId: 'request_b', environment: env('b'), personId: 'b', memories: [{ id: 'm_b', personId: 'b', text: 'B material' }] }),
  ]);
  assert.equal(a.personId, 'a'); assert.equal(b.personId, 'b'); assert.ok(a.injectedText.includes('A material')); assert.ok(!a.injectedText.includes('B material'));
  assert.equal(a.tokens, Array.from(a.injectedText).length); assert.ok(a.tokens <= 2970); assert.equal(a.tokenAccounting, 'port');
  assert.ok(Object.isFrozen(a)); assert.ok(Object.isFrozen(a.segments));
  await f.runtime.decide({ attention: { observeChannelIds: ['elsewhere'] } }); assert.equal(a.personId, 'a');
});

test('unknown delivery is reconciled after restart without resending and only actual receipt enters C1', async t => {
  let sent = 0, delivered = false;
  const f = await fixture(t, { host: { deliver: async () => { sent++; throw new Error('connection lost after submit'); },
    reconcileDelivery: async () => delivered ? { status: 'delivered', receiptId: 'receipt', sourceEventId: 'actual_outgoing', text: 'actual message' } : null } });
  await assert.rejects(f.runtime.deliver('planned text', { target: target(), proactive: true }), /connection lost/);
  assert.equal((await f.repository.getOutbox())[0].status, 'unknown'); assert.equal((await f.repository.getContext({ personId: 'a' })).records.length, 0);
  await f.runtime.close(); delivered = true; await f.runtime.open();
  assert.equal(sent, 1); assert.equal((await f.repository.getOutbox())[0].status, 'delivered');
  const records = (await f.repository.getContext({ personId: 'a' })).records; assert.equal(records.length, 1); assert.equal(records[0].text, 'actual message');
  await f.runtime.reconcileOutbox(); assert.equal((await f.repository.getContext({ personId: 'a' })).records.length, 1);
});

test('a due control model error remains recoverable without inventing a retry interval', async t => {
  let fail = true, calls = 0;
  const f = await fixture(t, { model: { complete: async () => { calls++; if (fail) throw new Error('provider down'); return { decision: listen() }; } } });
  await f.runtime.decide({ nextCheckAt: 2000 }, { environment: env(), personId: 'a' }); f.clock.set(2000);
  await assert.rejects(f.runtime.handleDue(), /provider down/);
  assert.ok((await f.repository.getRuntime()).execution.pendingControl);
  assert.equal(f.clock.timers.size, 0);
  fail = false; await f.runtime.retryPendingControl(); assert.equal(calls, 2); assert.ok(!(await f.repository.getRuntime()).execution.pendingControl);
});

test('on_write and sleep mode switching shares source cursor, records write opportunities, and does not force model work or sleep', async t => {
  let calls = 0;
  const f = await fixture(t, { config: { consolidationMode: 'on_write' }, model: { complete: async request => { if (request.purpose === 'consolidation') calls++; return { patch: [] }; } } });
  await f.runtime.accept(chat('one'), env()); await f.runtime.idle(); assert.equal(calls, 0);
  assert.equal((await f.repository.getRuntime()).execution.consolidationOpportunity.writesObserved, 1);
  await f.runtime.decide({ consolidationPlan: { action: 'run', targetPersonIds: ['a'] } }, { personId: 'a' }); await f.runtime.idle(); assert.equal(calls, 1);
  await f.runtime.updateConfig({ consolidationMode: 'sleep' }); await f.runtime.accept(chat('two'), env()); await f.runtime.idle(); assert.equal(calls, 1);
  assert.equal((await f.repository.getRuntime()).sleep.state, 'awake');
  await f.runtime.consolidate({ personId: 'a' }); assert.equal(calls, 2);
  await f.runtime.updateConfig({ consolidationMode: 'on_write' }); await f.runtime.accept(chat('two'), env()); await f.runtime.idle(); assert.equal(calls, 2);
});

test('queued host controls survive restart and only a matching actual control acknowledgement clears them', async t => {
  const queued = [];
  const f = await fixture(t, { host: { requestDecision: payload => { queued.push(payload); return { queued: true }; } } });
  await f.runtime.handleSignal('new_message', { environment: env(), personId: 'a' });
  const id = queued[0].controlId; assert.ok(id);
  await f.runtime.decide(listen(), { controlId: 'unrelated', executeReply: false });
  assert.equal((await f.repository.getRuntime()).execution.pendingControl.controlId, id);
  await f.runtime.close(); await f.runtime.open(); await f.runtime.idle();
  assert.equal(queued[1].controlId, id);
  await f.runtime.decide(listen(), { controlId: id, executeReply: false });
  assert.ok(!(await f.repository.getRuntime()).execution.pendingControl);
});

test('queued wake is acknowledged once and late arrivals remain pending', async t => {
  const queued = [];
  const f = await fixture(t, { host: { onWake: payload => { queued.push(payload); return { accepted: true, status: 'queued' }; } } });
  await f.runtime.accept(chat('first'), env());
  await f.runtime.decide({ sleepPlan: { action: 'sleep', wakeAt: null, wakeCondition: 'explicit_wake', reason: 'I choose it' } });
  await f.runtime.idle(); await f.runtime.handleSignal('explicit_wake');
  assert.equal((await f.repository.getPending()).length, 1);
  await f.runtime.accept(chat('late'), env());
  const wakeId = queued[0].wakeId; await f.runtime.acknowledgeWake(wakeId);
  assert.deepEqual((await f.repository.getPending()).map(x => x.sourceEventId), ['late']);
  assert.equal((await f.runtime.acknowledgeWake(wakeId)).accepted, false);
});

test('timed wake is selected by the personality and explicit-only sleep never gains a fixed clock deadline', async t => {
  let wakes = 0;
  const f = await fixture(t, { autoSchedule: true, host: { onWake: () => { wakes++; return { accepted: true }; } } });
  await f.runtime.decide({ sleepPlan: { action: 'sleep', wakeAt: null, wakeCondition: 'explicit_wake', reason: 'waiting for a wake signal' } });
  await f.runtime.idle(); assert.equal(f.clock.timers.size, 0);
  f.clock.set(1_000_000); await f.runtime.handleDue(); assert.equal(wakes, 0);
  await f.runtime.decide({ sleepPlan: { action: 'sleep', wakeAt: 1_005_000, wakeCondition: 'at_time', reason: 'my chosen time' } });
  await f.runtime.idle(); f.clock.set(1_005_000); await f.runtime.handleDue(); assert.equal(wakes, 1);
});

test('host trace pagination is fully consumed only after every page succeeds', async t => {
  let failure = true; const cursors = [], observed = [];
  const f = await fixture(t, { model: { complete: async request => {
    const material = JSON.parse(request.messages.at(-1).content).traceMaterial; observed.push(...material.map(x => x.text)); return { patch: [] };
  } }, host: { readTrace: async (locator, options) => {
    cursors.push(options.cursor);
    if (options.cursor === 'page2' && failure) throw new Error('trace read interrupted');
    return options.cursor === null ? { text: 'page one', available: true, nextCursor: 'page2' } : { text: 'page two', available: true, nextCursor: null };
  } } });
  await f.repository.captureHot({ personId: 'a', sourceRef: { sourceSessionId: 'session_a', sourceEventId: 'trace_pages', available: true },
    sourceKind: 'reasoning', origin: 'ai_reply', kind: 'reasoning', content: { mode: 'host_trace', locator: 'trace:test', available: true, chars: null }, sourceAt: 100, observedAt: 100 });
  await assert.rejects(f.runtime.consolidate({ personId: 'a', maxInputChars: 8 }), /trace read interrupted/);
  assert.equal((await f.repository.prepareConsolidation({ personId: 'a' })).input.hot.length, 1);
  failure = false; await f.runtime.consolidate({ personId: 'a', maxInputChars: 8 });
  assert.ok(observed.includes('page two')); assert.equal((await f.repository.prepareConsolidation({ personId: 'a' })).input.hot.length, 0);
  assert.deepEqual(cursors, [null, 'page2', null, 'page2']);
});

test('truncated trace without a continuation cursor is reported and not silently consumed', async t => {
  const f = await fixture(t, { host: { readTrace: async () => ({ text: 'partial', truncated: true, available: true }) } });
  await f.repository.captureHot({ personId: 'a', sourceRef: { sourceSessionId: 'session_a', sourceEventId: 'broken_trace', available: true }, sourceKind: 'tool', origin: 'system', kind: 'tool_result',
    content: { mode: 'host_trace', locator: 'trace:broken', available: true, chars: null }, sourceAt: 100, observedAt: 100 });
  await assert.rejects(f.runtime.consolidate({ personId: 'a' }), error => error.code === 'TRACE_INCOMPLETE');
  assert.equal((await f.repository.prepareConsolidation({ personId: 'a' })).input.hot.length, 1);
});

test('reused delivery ID never causes concurrent or repeated external sending', async t => {
  const entered = deferred(), finish = deferred(); let calls = 0;
  const f = await fixture(t, { host: { deliver: async () => { calls++; entered.resolve(); await finish.promise; return { status: 'delivered', receiptId: 'same_id' }; } } });
  const first = f.runtime.deliver('one chosen message', { deliveryId: 'stable', target: target() }); await entered.promise;
  await f.runtime.deliver('one chosen message', { deliveryId: 'stable', target: target() });
  finish.resolve(); await first; await f.runtime.deliver('one chosen message', { deliveryId: 'stable', target: target() }); assert.equal(calls, 1);
});

test('delivered receipt survives a crash between clearing pending and C1 projection, startup completes locally without sending again', async t => {
  let sends = 0;
  const f = await fixture(t, { host: { deliver: async r => ({ status: 'delivered', receiptId: `real_${++sends}`, sourceEventId: 'actual_reply', text: r.text }) } });
  const incoming = await f.runtime.accept(chat('waiting'), env());
  const clear = f.repository.clearPending.bind(f.repository); let once = true;
  f.repository.clearPending = async ids => { const result = await clear(ids); if (once) { once = false; throw new Error('power loss after pending commit'); } return result; };
  await assert.rejects(f.runtime.deliver('actual words', { target: target(), pendingEventIds: [incoming.eventId] }), /power loss/);
  const interrupted = (await f.repository.getOutbox())[0]; assert.equal(interrupted.status, 'delivered'); assert.equal(interrupted.projectionPending, true);
  assert.equal((await f.repository.getContext({ personId: 'a' })).records.length, 1);
  f.repository.clearPending = clear; await f.runtime.close(); await f.runtime.open(); await f.runtime.idle();
  assert.equal(sends, 1); assert.equal((await f.repository.getOutbox())[0].projectionPending, false);
  const records = (await f.repository.getContext({ personId: 'a' })).records; assert.equal(records.filter(x => x.sourceEventId === 'actual_reply').length, 1);
  assert.equal((await f.repository.getPending()).length, 0);
});

test('durable decision effect journal resumes an immediate reply after interruption and same control does not regenerate or resend', async t => {
  let sends = 0, replies = 0;
  const f = await fixture(t, { model: { complete: async r => { if (r.purpose === 'reply') replies++; return { text: 'one resumed reply' }; } },
    host: { deliver: async () => ({ status: 'delivered', receiptId: `receipt_${++sends}` }) } });
  const save = f.repository.patchRuntime.bind(f.repository); let once = true;
  f.repository.patchRuntime = async (...args) => { const result = await save(...args);
    if (once && Object.keys(result.execution?.pendingEffects ?? {}).length) { once = false; throw new Error('power loss after decision journal'); } return result; };
  const input = { replyPlan: { action: 'reply', target: target(), replyAt: null, pendingEventIds: [], reason: 'my spontaneous choice' } };
  await assert.rejects(f.runtime.decide(input, { controlId: 'same_control', personId: 'a' }), /power loss/);
  assert.equal(replies, 0); assert.equal(sends, 0);
  f.repository.patchRuntime = save; await f.runtime.close(); await f.runtime.open(); await f.runtime.idle();
  assert.equal(replies, 1); assert.equal(sends, 1);
  const repeated = await f.runtime.decide(input, { controlId: 'same_control', personId: 'a' });
  assert.equal(repeated.duplicate, true); assert.equal(replies, 1); assert.equal(sends, 1);
});

test('native host decide executeReply:false recovers identity effects without creating another person or double-applying a control', async t => {
  let fail = true, identified = 0;
  const f = await fixture(t, { host: { onIdentity: () => { identified++; }, onDecision: () => { if (fail) throw new Error('native adapter interrupted'); } } });
  await f.runtime.accept({ ...chat('new_person'), personId: null }, env());
  const input = { identityPlan: { action: 'new', displayName: 'My interpreted acquaintance', sourceRefs: [{ sourceSessionId: 'session_a', sourceEventId: 'new_person', available: true }] }, ...listen() };
  await assert.rejects(f.runtime.decide(input, { controlId: 'native_control', executeReply: false }), /adapter interrupted/);
  const peopleBefore = (await f.repository.listPeople()).map(x => x.personId);
  fail = false; await f.runtime.close(); await f.runtime.open(); await f.runtime.idle();
  assert.deepEqual((await f.repository.listPeople()).map(x => x.personId), peopleBefore); assert.equal(identified, 1);
  const result = await f.runtime.decide(input, { controlId: 'native_control', executeReply: false }); assert.equal(result.duplicate, true); assert.equal(identified, 1);
});

test('bounded pending pages and reference-only wake summaries keep unseen tails pending', async t => {
  const seen = [];
  const f = await fixture(t, { model: { maxInputTokens: 5000, complete: async r => { seen.push(r); return { decision: listen() }; } } });
  const one = await f.runtime.accept({ ...chat('long'), text: 'BEGIN_TEXT_' + '很长的一段原话'.repeat(3000) }, env());
  await f.runtime.accept(chat('unseen_tail'), env());
  const all = await f.repository.getPending();
  const result = await f.runtime.handleSignal('new_message', { personId: 'a', environment: env(), incoming: one.record,
    wakeSummary: [{ personId: 'a', channelId: 'channel_a', sessionId: 'session_a', records: all }] });
  assert.equal(seen.length, 1); const text = seen[0].messages.map(x => x.content).join('\n'); assert.ok(Array.from(JSON.stringify(seen[0].messages)).length <= 5000);
  assert.equal(text.split('BEGIN_TEXT_').length - 1, 1);
  const payload = JSON.parse(seen[0].messages.at(-1).content); assert.ok(payload.pending[0].fragment); assert.equal(payload.pending.length, 1);
  assert.ok(!JSON.stringify(payload.wakeSummary).includes('BEGIN_TEXT_')); assert.equal(result.pendingPage.completeEventIds.length, 0);
  assert.equal((await f.repository.getPending()).length, 2);
  assert.ok((await f.repository.getRuntime()).execution.pendingOffsets[one.eventId] > 0);
});

test('a nonempty model patch forms a subjective impression, free signature and searchable pattern after one real source', async t => {
  const f = await fixture(t, { model: { complete: async r => {
    const body = JSON.parse(r.messages.at(-1).content); assert.ok(r.messages.some(x => x.content.includes('Value shape guide')));
    const example = JSON.parse(r.messages.find(x => x.content.startsWith('Value shape guide:')).content.slice('Value shape guide: '.length));
    const ref = { sourceSessionId: body.input.chat[0].sourceSessionId, sourceEventId: body.input.chat[0].sourceEventId, available: true };
    return { patch: { entries: [
      { documentKey: 'persona', expectedVersion: body.inputVersions.persona, operation: 'upsert', recordId: 'signatures:sig_first', value: { ...example.signature, personId: null, scope: 'global', if: '深夜又遇见他', then: '我也许更愿意慢慢聊', observations: 1, srcRefs: [ref] } },
      { documentKey: 'person:a:impression', expectedVersion: body.inputVersions['person:a:impression'], operation: 'upsert', recordId: 'summary', value: '我主观觉得和他相处有点放松，也可能判断错了。' },
      { documentKey: 'person:a:index', expectedVersion: body.inputVersions['person:a:index'], operation: 'upsert', recordId: 'first_pattern', value: { ...example.memoryItem, personId: 'a', scope: 'person', text: '与他相处让我放松的主观印象', keys: ['放松'], srcRefs: [ref], aboutPersonIds: ['a'] } },
    ] } };
  } } });
  await f.runtime.accept({ ...chat('first_experience'), text: '今天想慢慢说点事' }, env()); await f.runtime.consolidate({ personId: 'a' });
  const persona = await f.repository.getPersona(); assert.equal(persona.signatures.length, 1); assert.equal(persona.signatures[0].observations, 1);
  assert.ok((await f.repository.getContext({ personId: 'a' })).impression.summary.includes('也可能判断错了'));
  const found = await f.runtime.search({ query: '放松', targetPersonId: 'a', scope: 'person' }); assert.ok(found.items.some(x => x.id === 'first_pattern'));
});

test('effect recovery after actual sending but before reply-effect marker never regenerates or resends', async t => {
  let sends = 0, replies = 0, once = true;
  const f = await fixture(t, { model: { complete: async () => { replies++; return { text: 'already sent once' }; } },
    host: { deliver: async () => ({ status: 'delivered', receiptId: `sent_${++sends}` }) } });
  const save = f.repository.patchRuntime.bind(f.repository);
  f.repository.patchRuntime = async (base, state) => {
    if (once && Object.values(state.execution?.pendingEffects ?? {}).some(x => x.completed.includes('reply'))) { once = false; throw new Error('power loss before effect marker'); }
    return save(base, state);
  };
  const input = { replyPlan: { action: 'reply', target: target(), pendingEventIds: [], replyAt: null, reason: 'I choose to say it' } };
  await assert.rejects(f.runtime.decide(input, { controlId: 'sent_effect', personId: 'a' }), /before effect marker/);
  assert.equal(sends, 1); assert.equal(replies, 1);
  f.repository.patchRuntime = save; await f.runtime.close(); await f.runtime.open(); await f.runtime.idle();
  assert.equal(sends, 1); assert.equal(replies, 1); assert.equal(Object.keys((await f.repository.getRuntime()).execution.pendingEffects).length, 0);
});

test('a newer personality reply plan supersedes an older in-flight generated reply', async t => {
  const entered = deferred(), finish = deferred(); let sends = 0;
  const f = await fixture(t, { model: { complete: async () => { entered.resolve(); await finish.promise; return { text: 'old unfinished choice' }; } },
    host: { deliver: async () => { sends++; return { status: 'delivered', receiptId: 'should_not_happen' }; } } });
  const first = f.runtime.decide({ replyPlan: { action: 'reply', target: target(), pendingEventIds: [], replyAt: null, reason: 'initially I wanted to reply' } }, { personId: 'a' });
  await entered.promise; await f.runtime.decide(listen(), { personId: 'a' }); finish.resolve();
  const result = await first; assert.equal(result.effects.reply.status, 'superseded'); assert.equal(sends, 0);
  assert.equal((await f.repository.getRuntime()).currentDecision.replyPlan.action, 'listen');
});

test('unknown-person control and reply pending are staging-only instead of all known people', async t => {
  const observed = [];
  const f = await fixture(t, { model: { complete: async r => { observed.push(JSON.parse(r.messages.at(-1).content)); return r.purpose === 'control' ? { decision: listen() } : { text: 'a response' }; } },
    host: { deliver: async () => ({ status: 'delivered', receiptId: 'staged_reply' }) } });
  await f.runtime.accept(chat('known_a'), env());
  await f.runtime.accept({ ...chat('unknown'), personId: null }, env());
  await f.runtime.handleSignal('new_message', { personId: null, environment: env() });
  assert.deepEqual(observed[0].pending.map(x => x.sourceEventId), ['unknown']);
  await f.runtime.decide({ replyPlan: { action: 'reply', target: { ...target(), personId: null }, pendingEventIds: [], replyAt: null, reason: 'reply to this unknown person' } }, { personId: null });
  assert.deepEqual(observed[1].pending.map(x => x.sourceEventId), ['unknown']);
});

test('UTF-8 fallback never cuts a long actual session/channel route to fit the initial 120-unit environment allocation', async t => {
  const f = await fixture(t);
  // Exercise an explicitly labelled estimator, not an assumed provider tokenizer.
  const { createTokenCounter } = await import('../core/prompts.js'); f.runtime.tokenCounter = createTokenCounter();
  const sessionId = 'a_real_session_' + 'a'.repeat(90), channelId = 'the_real_channel_' + 'b'.repeat(90);
  const snapshot = await f.runtime.compose({ personId: 'a', sessionId, channelId,
    environment: { sessionId, channelId, placeDescription: 'some optional environment description'.repeat(50) } });
  assert.equal(snapshot.tokenAccounting, 'utf8_bytes_estimate'); assert.ok(snapshot.injectedText.includes(sessionId)); assert.ok(snapshot.injectedText.includes(channelId));
  assert.ok(snapshot.budgetAdjustments.some(x => x.reason === 'preserve_complete_route_and_time')); assert.ok(snapshot.tokens <= 2970);
  assert.deepEqual(snapshot.routeFacts, { sessionId, channelId, personId: 'a' });
});

test('wake state commits across a real ingestion between refresh and patch without dropping the late source or admitting it to the older wake page', async t => {
  const queued = [];
  const f = await fixture(t, { host: { onWake: wake => { queued.push(wake); return { accepted: true, status: 'queued' }; } } });
  const first = await f.runtime.accept(chat('before_wake'), env());
  await f.runtime.decide({ sleepPlan: { action: 'sleep', wakeAt: null, wakeCondition: 'explicit_wake', reason: 'my choice' } }, { personId: 'a', environment: env() });
  await f.runtime.idle();
  const patch = f.repository.patchRuntime.bind(f.repository); let inserted;
  f.repository.patchRuntime = async (base, next) => {
    if (!inserted && base.sleep.state === 'sleeping' && next.sleep.state === 'awake') {
      inserted = await f.repository.ingest({ ...chat('arriving_during_wake_commit', 'b'), sourceCursor: 88 });
    }
    return patch(base, next);
  };
  await f.runtime.handleSignal('explicit_wake');
  const stored = await f.repository.getRuntime();
  assert.equal(stored.sleep.state, 'awake'); assert.equal(queued.length, 1);
  assert.equal(stored.ingestCursors.find(row => row.sourceSessionId === 'session_b').recordedThroughCursor, '88');
  assert.deepEqual(queued[0].pendingEventIds, [first.eventId]);
  assert.deepEqual((await f.repository.getPending()).map(row => row.eventId), [first.eventId, inserted.eventId]);
  await f.runtime.acknowledgeWake(queued[0].wakeId);
  assert.deepEqual((await f.repository.getPending()).map(row => row.sourceEventId), ['arriving_during_wake_commit']);
  assert.deepEqual(f.runtime.errors, []);
});

test('accept context commits across a real consolidation commit without reverting its cursor or consuming the new input', async t => {
  const f = await fixture(t);
  await f.runtime.accept(chat('consolidated_before_new_input'), env());
  const run = await f.repository.prepareConsolidation({ personId: 'a' });
  const patch = f.repository.patchRuntime.bind(f.repository); let committed = false;
  f.repository.patchRuntime = async (base, next) => {
    if (!committed && next.execution?.lastContext?.sessionId === 'session_b') {
      committed = true; await f.repository.applyConsolidation(run, []);
    }
    return patch(base, next);
  };
  await f.runtime.accept({ ...chat('new_input_during_context_commit', 'b'), sourceCursor: 92 }, env('b'));
  const stored = await f.repository.getRuntime();
  assert.equal(committed, true); assert.equal(stored.consolidationCursors['person:a'].lastRunId, run.runId);
  assert.equal(stored.execution.lastContext.personId, 'b');
  assert.equal(stored.ingestCursors.find(row => row.sourceSessionId === 'session_b').recordedThroughCursor, '92');
  assert.deepEqual((await f.repository.prepareConsolidation({ personId: 'a' })).input.chat, []);
  assert.deepEqual((await f.repository.prepareConsolidation({ personId: 'b' })).input.chat.map(row => row.sourceEventId), ['new_input_during_context_commit']);
});

test('a simultaneous change to the actual decision still conflicts before identity effects and is never blindly retried', async t => {
  let notifications = 0;
  const f = await fixture(t, { host: { onDecision: () => { notifications++; } } });
  await f.runtime.decide(listen(), { executeReply: false }); notifications = 0;
  const patch = f.repository.patchRuntime.bind(f.repository); let attempts = 0;
  f.repository.patchRuntime = async (base, next) => {
    attempts++;
    const current = await f.repository.getRuntime();
    current.currentDecision = { ...current.currentDecision, decisionId: 'independent_committed_decision' };
    await f.repository.saveRuntime(current);
    return patch(base, next);
  };
  const beforePeople = (await f.repository.listPeople()).map(row => row.personId);
  await assert.rejects(f.runtime.decide({ identityPlan: { action: 'new', displayName: 'Must not be created on a conflict' } }, { executeReply: false }), error => error.code === 'VERSION_CONFLICT');
  assert.equal(attempts, 1); assert.equal(notifications, 0);
  assert.deepEqual((await f.repository.listPeople()).map(row => row.personId), beforePeople);
  assert.equal((await f.repository.getRuntime()).currentDecision.decisionId, 'independent_committed_decision');
  assert.deepEqual(Object.keys((await f.repository.getRuntime()).execution.pendingEffects), []);
});

test('legacy repository ports retain full-version compare and swap when patchRuntime is unavailable', async t => {
  const f = await fixture(t); f.repository.patchRuntime = undefined;
  const save = f.repository.saveRuntime.bind(f.repository); let expected;
  f.repository.saveRuntime = async (state, options) => { expected = options.expectedVersion; return save(state, options); };
  const before = await f.repository.getRuntime(); await f.runtime.resumeProactive();
  assert.equal(expected, before.version);
  assert.equal((await f.repository.getRuntime()).version, before.version + 1);
});
