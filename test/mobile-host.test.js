import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshMobileChannelPort } from '../adapters/dsh/mobile-host.js';

function fixture() {
  const agents = new Map(), events = new Map(), scopes = [], calls = { create: 0, resume: 0, flush: 0, followup: 0, attach: 0, dispose: 0, read: 0 }, readSeqs = [];
  let current = { memoryRoot: '/isolated/persona', ready: Promise.resolve(), attachAgent: async () => { calls.attach++; }, repository: { getRuntime: async () => ({ sleep: { state: 'sleeping', wakeCondition: 'explicit_wake' }, currentDecision: { replyPlan: { action: 'listen' } } }) } };
  const presets = { mount: async scope => { scope.localPersonaTools = true; } };
  const scope = () => { const value = { localPersonaTools: false, tools: { restrict: args => { value.restricted = args; } } }; scopes.push(value); return value; };
  async function construct({ sessionId, resumeSessionId, setup }) {
    const id = sessionId ?? resumeSessionId, ctx = scope(), log = events.get(id) ?? []; events.set(id, log);
    const agent = { ctx, status: 'idle', session: { id, get seq() { return log.length; }, deriveMessages: () => log.filter(event => event.type === 'user/message').map(event => event.data) }, inbox: { nextTurn: [], nextStep: [] }, followup(message) { calls.followup++; this.inbox.nextTurn.push(message); log.push({ type: 'agent/inbox/spliced', seq: log.length, time: 1, data: { inserted: [message] } }); } };
    await setup(ctx, agent); agents.set(id, agent);
    return { agent, async dispose() { calls.dispose++; agents.delete(id); } };
  }
  const ctx = { agents: { get: id => agents.get(id), create: options => { calls.create++; return construct(options); }, resume: options => { calls.resume++; return construct(options); } },
    get: key => key === 'agentPresets' ? presets : key === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'fixture-only', model: 'fixture-v1' }) } : key === 'sessions' ? { flush: async () => { calls.flush++; } } : key === 'sessionQuery' ? { readEvent: async ({ sessionId, seq, before, after }) => { assert.equal(before, 0); assert.equal(after, 0); calls.read++; readSeqs.push(seq); return { target: events.get(sessionId)?.[seq] }; } } : undefined };
  const port = createDshMobileChannelPort({ ctx, getCoordinator: () => current });
  return { port, calls, scopes, agents, events, readSeqs, current: () => current, setCurrent: value => { current = value; } };
}

test('native phone port creates an isolated persona scope without prompting or forcing a reply', async () => {
  const f = fixture(), channel = await f.port.create(); assert(channel.sessionId.startsWith('xiangxu-mobile-')); assert.equal(channel.memoryRoot, '/isolated/persona'); assert.equal(f.calls.followup, 0); assert.equal(f.scopes[0].localPersonaTools, true); assert.deepEqual(f.scopes[0].restricted, { allow: [] });
  const state = await f.port.status(channel); assert.equal(state.waiting, 'sleeping'); assert.equal(state.sleep.wakeCondition, 'explicit_wake'); assert.equal(f.calls.followup, 0); await f.port.close();
});

test('native phone followup keeps actual user role/source and confirms host durability without duplicate delivery', async () => {
  const f = fixture(), channel = await f.port.create(), args = { messageId: 'stable-input', text: '原话🙂', deviceId: 'phone' };
  await f.port.send(channel, args); await f.port.send(channel, args); assert.equal(f.calls.followup, 1); assert(f.calls.flush >= 3);
  const message = f.agents.get(channel.sessionId).inbox.nextTurn[0]; assert.equal(message.role, 'user'); assert.equal(message.source.kind, 'user'); assert.equal(message.source.deviceId, 'phone'); assert.equal(message.content[0].text, args.text); assert.equal(message.source.personId, undefined);
  await assert.rejects(f.port.send(channel, { ...args, text: '不同文本' }), { code: 'MOBILE_REQUEST_CONFLICT' }); await f.port.close();
});

test('native phone history includes queued user originals, visible assistant text and no reasoning/tool/control data', async () => {
  const f = fixture(), channel = await f.port.create();
  await f.port.send(channel, { messageId: 'queued-user', text: '睡眠时到达', deviceId: 'phone' });
  const events = f.events.get(channel.sessionId);
  events.push({ type: 'user/message', seq: 1, time: 2, data: { id: 'control', source: { kind: 'persona-memory:control' }, content: [{ type: 'text', text: 'hidden-control' }] } });
  events.push({ type: 'assistant/message', seq: 2, time: 3, data: { message: { id: 'answer', content: [{ type: 'reasoning', text: 'hidden-reasoning' }, { type: 'text', text: '可见回复' }, { type: 'tool-call', name: 'hidden-tool' }] } } });
  const page = await f.port.read(channel); assert.deepEqual(page.messages.map(row => [row.role, row.text]), [['user', '睡眠时到达'], ['assistant', '可见回复']]); assert.equal(page.nextAfter, 3); assert.equal(page.hasMore, false); await f.port.close();
});

test('native phone fragments preserve every Unicode code point and multiple messages in one native event', async () => {
  const f = fixture(), channel = await f.port.create(), text = '🙂相续'.repeat(20000), log = f.events.get(channel.sessionId);
  log.push({ type: 'agent/inbox/spliced', seq: 0, time: 1, data: { inserted: [{ id: 'first', source: { kind: 'user' }, content: [{ type: 'text', text }] }, { id: 'second', source: { kind: 'user' }, content: [{ type: 'text', text: '同一事件的第二条' }] }] } });
  const fragments = []; let cursor = { after: 0, offset: 0, messageIndex: 0 }, count = 0, sawSecond = false;
  while (true) { const page = await f.port.read(channel, { ...cursor, limit: 1 }); count++; for (const row of page.messages) if (row.id === 'first') fragments.push(row.text); else if (row.id === 'second') sawSecond = true; if (!page.hasMore) break; cursor = { after: page.nextAfter, offset: page.nextOffset, messageIndex: page.nextIndex }; assert(count < 20); }
  assert.equal(fragments.join(''), text); assert(sawSecond); assert.equal(count, 5); await f.port.close();
});

test('native phone resumes its original session and refuses a different active personality root', async () => {
  const f = fixture(), channel = await f.port.create(); await f.port.close(); await f.port.status(channel); assert.equal(f.calls.resume, 1); assert.equal(f.calls.followup, 0);
  f.setCurrent({ ...f.current(), memoryRoot: '/isolated/other' }); await assert.rejects(f.port.send(channel, { messageId: 'no-cross-instance', text: 'test', deviceId: 'phone' }), { code: 'MOBILE_INSTANCE_MISMATCH' }); assert.equal(f.calls.followup, 0); await f.port.close();
});

test('native phone first view reads only recent events and earlier history requires explicit bounded pages', async () => {
  const f = fixture(), channel = await f.port.create(), log = f.events.get(channel.sessionId);
  for (let seq = 0; seq < 300; seq++) log.push({ type: seq === 150 || seq === 299 ? 'assistant/message' : 'tool/result', seq, time: seq, data: { message: { id: 'visible-' + seq, content: [{ type: 'text', text: '第' + seq + '条' }] } } });
  const recent = await f.port.read(channel); assert.equal(f.calls.read, 128); assert.equal(recent.windowStart, 172); assert.equal(recent.earlierBefore, 172); assert.equal(recent.nextAfter, 300); assert.deepEqual(recent.messages.map(row => row.id), ['visible-299']); assert.equal(recent.history, false);
  const old = await f.port.read(channel, { before: recent.earlierBefore }); assert.equal(f.calls.read, 256); assert.equal(old.history, true); assert.equal(old.previousBefore, 44); assert.equal(old.nextAfter, 172); assert.deepEqual(old.messages.map(row => row.id), ['visible-150']);
  const idle = await f.port.read(channel, { after: recent.nextAfter }); assert.equal(idle.messages.length, 0); assert.equal(f.calls.read, 256); await f.port.close();
});

test('native phone fixed history fragment boundary does not consume new live replies', async () => {
  const f = fixture(), channel = await f.port.create(), log = f.events.get(channel.sessionId);
  log.push({ type: 'assistant/message', seq: 0, time: 1, data: { message: { id: 'long-old', content: [{ type: 'text', text: '旧'.repeat(20000) }] } } });
  const first = await f.port.read(channel, { before: 1 }); assert(first.nextOffset); assert.equal(first.history, true);
  log.push({ type: 'assistant/message', seq: 1, time: 2, data: { message: { id: 'new-live', content: [{ type: 'text', text: '新回复' }] } } });
  const tail = await f.port.read(channel, { after: first.nextAfter, until: first.windowEnd, windowStart: first.windowStart, offset: first.nextOffset, messageIndex: first.nextIndex }); assert.equal(tail.windowEnd, 1); assert.equal(tail.nextAfter, 1); assert.equal(tail.messages.length, 1); assert.equal(tail.messages[0].id, 'long-old');
  const live = await f.port.read(channel, { after: 1 }); assert.equal(live.messages[0].id, 'new-live'); await f.port.close();
});
