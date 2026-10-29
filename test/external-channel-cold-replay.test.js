import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDshCoordinator } from '../adapters/dsh/index.js';
import { createChannelService } from '../adapters/dsh/channels/service.js';
import { createDshChannelPort } from '../adapters/dsh/channels/native.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const timeout = (promise, milliseconds = 5000) => Promise.race([promise, new Promise(resolve => { const timer = setTimeout(() => resolve({ timedOut: true }), milliseconds); timer.unref?.(); })]);

async function fixture(t, receiptStatus = 'delivered') {
  const parent = await fs.realpath(os.tmpdir()), base = await fs.realpath(await fs.mkdtemp(path.join(parent, 'xiangxu-cold-replay-'))), root = path.join(base, 'memory');
  const agents = new Map(), history = new Map(), calls = { create: 0, resume: 0, output: 0, reconcile: 0, sends: 0, model: 0, followups: [], flushes: 0 };
  let coordinator, channels, native, disk = null, phase = 'initial'; const blockedOutput = deferred(), release = deferred();
  const ctx = { agents: { get: id => agents.get(id), list: () => [...agents.values()],
    async create(options) { calls.create++; return make(options.sessionId, options); },
    async resume(options) { calls.resume++; return make(options.resumeSessionId, options); } },
    get: key => ({ sessionQuery: { async readSession(id) { return { events: history.get(id) ?? [] }; }, async readEvent({ sessionId, seq }) { return { target: history.get(sessionId)?.find(event => event.seq === seq) }; } },
      sessions: { async flush() { calls.flushes++; } }, agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture-only' }) },
      agentPresets: { composedPreset: () => 'persona-memory', async mount() {} } })[key],
    llm: { async stream() { calls.model++; throw new Error('This isolated test must not request a model'); } } };
  async function make(id, options) {
    const handlers = new Map(), tools = new Map();
    const scope = { on(name, handler) { handlers.set(name, handler); return () => { if (handlers.get(name) === handler) handlers.delete(name); }; },
      tools: { restrict() { return () => {}; }, register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } } };
    const agent = { id, ctx: scope, session: { id, header: {}, deriveMessages: () => (history.get(id) ?? []).filter(event => event.type === 'user/message').map(event => event.data), requestHeader: () => ({ config: { provider: 'fixture', model: 'fixture-only' } }) },
      inbox: { nextTurn: [], nextStep: [] }, followup(message) { calls.followups.push({ phase, id, message }); this.inbox.nextTurn.push(message); handlers.get('agent/inbox/inserted')?.({ message }); }, cancel() {}, status: 'idle' };
    agents.set(id, agent); await options.setup?.(scope, agent);
    return { agent, async dispose() { agents.delete(id); } };
  }
  async function open() {
    coordinator = createDshCoordinator(ctx, { memoryRoot: root, operatorControl: false, provider: 'fixture', model: 'fixture-only' }); await coordinator.ready;
    assert.equal(coordinator.initializationError, null);
    native = createDshChannelPort({ ctx, getCoordinator: () => coordinator });
    channels = createChannelService({ getCoordinator: () => coordinator, channelPort: native, port: 0,
      storage: { read: async () => structuredClone(disk), write: async value => { disk = structuredClone(value); } },
      clientFactory: () => ({ async probe() { return { connected: true, capabilities: { text: true, group: true } }; },
        async sendText(_facts, _text, args) { calls.sends++; return receiptStatus === 'unknown' && phase === 'initial' ? { status: 'unknown', code: 'FIXTURE_UNKNOWN' }
          : { status: 'delivered', deliveryId: args.deliveryId, messageId: 'platform-' + calls.sends, receiptId: 'receipt-' + calls.sends, confirmedBy: 'fixture-platform', deliveredAt: Date.now() }; } }) });
    await channels.ready;
    coordinator.externalDelivery = { async output(args) {
      calls.output++;
      const pending = channels.output(args);
      // Teardown can release the old implementation's deterministic queue cycle.
      if (phase === 'cold' && args.sourceEventId === 'retained-final') { blockedOutput.resolve(args); return Promise.race([pending, release.promise.then(() => channels.reconcile(args))]); }
      return pending;
    }, async reconcile(args) { calls.reconcile++; return channels.reconcile(args); } };
  }
  await open();
  await channels.configure({ id: 'qq', config: { apiUrl: 'http://127.0.0.1:12345', accountId: '100', allowedPrivateIds: ['*'], allowedGroupIds: ['*'] } });
  const ingress = await channels.rotateIngress({ id: 'qq' }); let status = await channels.start({ id: 'qq' });
  let callbackUrl = status.connections.find(value => value.id === 'qq').callbackUrl;
  async function incoming(messageId) { const response = await fetch(callbackUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ingress.ingressToken },
    body: JSON.stringify({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 100, user_id: 11, sender: { user_id: 11, nickname: 'Fixture' }, message_id: messageId, time: 1800000000 + messageId, message: [{ type: 'text', data: { text: 'isolated input ' + messageId } }] }) }); return response.json(); }
  assert.equal((await incoming(1)).status, 'accepted'); const binding = disk.bindings[0], sessionId = binding.sessionId;
  const retainedUser = { id: 'retained-user', role: 'user', source: { kind: 'user', xiangxuChannel: binding.facts, platformMessageId: 'retained-platform-input', platformSourceAt: 1800000000000 }, content: [{ type: 'text', text: 'retained input before restart' }] };
  const oldFinal = { type: 'assistant/message', seq: 34, time: 1800000001000, data: { turn: 1, message: { id: 'retained-final', role: 'assistant', content: [{ type: 'text', text: 'retained output before restart' }] } } };
  if (receiptStatus !== 'missing') await channels.output({ sessionId, sourceEventId: 'retained-final', seq: 34, text: oldFinal.data.message.content[0].text, at: oldFinal.time });
  await channels.close(); await coordinator.close(); agents.clear();
  history.set(sessionId, [{ type: 'turn/start', seq: 32, data: { turn: 1 } }, { type: 'user/message', seq: 33, time: 1800000000000, data: retainedUser }, oldFinal]);
  await fs.writeFile(path.join(root, 'host-checkpoints.json'), JSON.stringify({ schemaVersion: 'persona-memory/3', sessions: { [sessionId]: 215 }, blocked: { [sessionId]: 33 } }));
  phase = 'cold'; await open(); status = await channels.resume(); callbackUrl = status.connections.find(value => value.id === 'qq').callbackUrl;
  let pending;
  t.after(async () => { release.resolve(); await pending?.catch(() => {}); await channels.close(); await coordinator.close(); assert.ok(base.startsWith(parent + path.sep)); await fs.rm(base, { recursive: true, force: true }); });
  return { root, calls, binding, oldFinal, coordinator: () => coordinator, channels: () => channels, disk: () => structuredClone(disk), blockedOutput,
    incoming(id) { pending = incoming(id); return pending; }, agent: () => agents.get(sessionId) };
}

test('cold QQ intake resumes blocked history without enqueueing old delivered output behind its own receive', async t => {
  const f = await fixture(t), before = { ...f.calls }, pending = f.incoming(2), result = await timeout(pending);
  if (result.timedOut) {
    assert.equal(f.disk().receipts.filter(row => row.kind === 'inbound').at(-1).status, 'prepared');
    assert.equal(f.calls.resume, 1); assert.equal(f.calls.output, before.output + 1);
    assert.equal(f.calls.followups.filter(row => row.phase === 'cold').length, 0);
  }
  assert.notEqual(result.timedOut, true, 'receive -> native.create -> attach -> replay -> output must not wait on the occupied receive queue');
  assert.equal(result.status, 'accepted'); assert.equal(f.calls.resume, 1); assert.equal(f.calls.sends, before.sends);
  assert.equal(f.calls.output, before.output, 'historical final must use receipt reconciliation only'); assert.ok(f.calls.reconcile > before.reconcile);
  assert.equal(f.disk().receipts.filter(row => row.kind === 'inbound').at(-1).status, 'accepted');
  assert.equal(f.agent().inbox.nextTurn.some(message => message.id === result.messageId), true); assert.equal(f.calls.model, 0);
  await f.coordinator().readyState();
  const rows = (await f.coordinator().repository.getContext({ personId: null })).records;
  assert.equal(rows.some(row => row.sourceEventId === result.messageId && row.role === 'user'), true, 'the newly accepted native input still reaches participant memory');
  assert.equal(rows.some(row => row.sourceEventId === 'retained-user'), true, 'the blocked participant source is still processed');
  assert.equal(rows.some(row => row.sourceEventId === 'retained-final' && row.role === 'assistant'), true);
  const checkpoint = await f.coordinator().repository.store.readJson('host-checkpoints.json');
  assert.equal(checkpoint.sessions[f.binding.sessionId], 215); assert.equal(checkpoint.blocked[f.binding.sessionId], undefined);
});

for (const receiptStatus of ['missing', 'unknown']) test(`cold replay keeps ${receiptStatus} historical delivery as a draft and never sends it`, async t => {
  const f = await fixture(t, receiptStatus), sends = f.calls.sends, result = await timeout(f.incoming(2));
  assert.notEqual(result.timedOut, true); assert.equal(result.status, 'accepted'); assert.equal(f.calls.sends, sends); assert.equal(f.calls.output, 0); assert.ok(f.calls.reconcile > 0);
  const rows = (await f.coordinator().repository.getContext({ personId: null })).records;
  assert.equal(rows.some(row => row.sourceEventId === 'retained-user'), true);
  assert.equal(rows.some(row => row.sourceEventId === 'retained-final' && row.role === 'assistant'), false);
  const hot = await f.coordinator().repository.store.readLines('staging/hot.jsonl');
  assert.ok(hot.some(row => row.sourceRef?.sourceEventId === 'retained-final' && row.kind === 'plugin_state' && JSON.parse(row.content.text).state === 'generated_not_confirmed_on_platform'));
  assert.equal(f.calls.model, 0);
});

test('a real-time final after cold resume still sends once and duplicate observation uses its existing receipt', async t => {
  const f = await fixture(t), result = await timeout(f.incoming(2)); assert.equal(result.status, 'accepted');
  const agent = f.agent(), sends = f.calls.sends, event = { type: 'assistant/message', seq: 216, time: 1800000002000, data: { turn: 2, message: { id: 'new-live-final', role: 'assistant', content: [{ type: 'text', text: 'new live output' }] } } };
  await f.coordinator().observeEvent(agent.session, event); await f.coordinator().observeEvent(agent.session, event);
  assert.equal(f.calls.sends, sends + 1); assert.equal(f.calls.output, 2); assert.equal(f.calls.model, 0);
});
