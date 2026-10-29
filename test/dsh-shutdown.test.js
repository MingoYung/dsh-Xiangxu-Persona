import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createDshCoordinator } from '../adapters/dsh/index.js';
import { MemoryRepository, PersonaRuntime } from '../core/index.js';

const deferred = () => Promise.withResolvers();
function within(promise, ms = 3000) {
  let timer;
  return Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Isolated shutdown did not settle within its test deadline')), ms);
  })]).finally(() => clearTimeout(timer));
}
const source = id => ({ sourceSessionId: 'shutdown-session', sourceEventId: id, sourceKind: 'user', contentClass: 'participant_dialogue',
  role: 'user', origin: 'user', channelId: 'shutdown-channel', personId: null, text: 'Original source retained during shutdown: ' + id });
const exists = file => fs.stat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
async function fixture(t, config = {}, ctx = { agents: { get: () => null }, get: () => undefined, llm: {} }) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'xiangxu-shutdown-'))), root = path.join(base, 'memory'), releases = [];
  const coordinator = createDshCoordinator(ctx, { memoryRoot: root, operatorControl: true, reviewAssistant: { enabled: false }, ...config });
  t.after(async () => {
    for (const release of releases) release();
    await within(coordinator.close());
    const relative = path.relative(await fs.realpath(tmpdir()), base);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(base).startsWith('xiangxu-shutdown-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  await coordinator.ready; assert.equal(coordinator.initializationError, null);
  return { base, root, coordinator, releases,
    request: (command, args = {}) => fs.writeFile(path.join(root, 'operator/request.json'), JSON.stringify({ id: 'shutdown-' + command, command, args })),
    response: async () => JSON.parse(await fs.readFile(path.join(root, 'operator/response.json'), 'utf8')) };
}
function abortAwareModel(f) {
  const entered = deferred(), purposes = []; let signal;
  f.coordinator.runtime.model = { complete: request => {
    purposes.push(request.purpose); signal = request.signal; entered.resolve();
    return new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('Isolated model call was cancelled'), { name: 'AbortError', code: 'FIXTURE_ABORTED' }));
      f.releases.push(abort);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
  } };
  return { entered: entered.promise, purposes, get signal() { return signal; } };
}
async function readRetained(root, expected) {
  const repository = new MemoryRepository({ root }); await repository.open();
  try {
    const records = await repository.readSources({ sourceRefs: [{ sourceSessionId: expected.sourceSessionId, sourceEventId: expected.sourceEventId }] });
    assert.equal(records.length, 1); assert.equal(records[0].text, expected.text); return records[0];
  } finally { await repository.close(); }
}

for (const helper of [false, true]) test('coordinator cancels the active operator ' + (helper ? 'memory assistant' : 'consolidation') + ' before draining its watcher', async t => {
  const f = await fixture(t, { reviewAssistant: { enabled: helper } }), input = source(helper ? 'advice-source' : 'main-source');
  await f.coordinator.repository.ingest(input); const model = abortAwareModel(f);
  await f.request('consolidate'); await within(model.entered);
  const one = f.coordinator.close(), two = f.coordinator.close(); await within(Promise.all([one, two]));
  assert.equal(model.signal.aborted, true); assert.equal(f.coordinator.runtime.closed, true);
  assert.deepEqual(model.purposes, [helper ? 'memory_assistant' : 'consolidation'], 'cancelling advice must not start another paid model call');
  assert.equal(await exists(path.join(f.root, 'writer.lock')), false);
  assert.equal((await f.response()).id, 'shutdown-consolidate');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'operator/receipt.json'), 'utf8')).status, 'finished');
  await readRetained(f.root, input);
});

test('shutdown drains an already executing operator assignment before releasing the writer', async t => {
  const f = await fixture(t), input = source('assign-source'); await f.coordinator.repository.ingest(input);
  await f.coordinator.repository.upsertPerson({ personId: 'known_person', displayName: 'An isolated acquaintance' });
  const entered = deferred(), finish = deferred(), original = f.coordinator.repository.assign.bind(f.coordinator.repository);
  f.releases.push(() => finish.resolve());
  f.coordinator.repository.assign = async args => { entered.resolve(); await finish.promise; return original(args); };
  await f.request('assign', { sourceSessionId: input.sourceSessionId, sourceEventId: input.sourceEventId, personId: 'known_person', reason: 'Isolated explicit assignment' });
  await within(entered.promise); let settled = false;
  const closing = f.coordinator.close().then(() => { settled = true; }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(f.coordinator.runtime.closing, true); assert.equal(f.coordinator.runtime.closed, false);
  assert.equal(await exists(path.join(f.root, 'writer.lock')), true);
  finish.resolve(); await within(closing); assert.equal((await f.response()).ok, true);
  assert.equal((await readRetained(f.root, input)).personId, 'known_person');
});

test('shutdown preserves an admitted source write and continues cleanup after a scoped disposer fails', async t => {
  const handlers = new Map(), tools = new Map(), scope = { on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); },
    tools: { restrict() { return () => {}; }, register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } } };
  const session = { id: 'shutdown-session', header: {}, deriveMessages: () => [], requestHeader: () => ({ config: { provider: 'fixture', model: 'not-called' } }) };
  const agent = { id: session.id, session, ctx: scope, inbox: { nextTurn: [], nextStep: [] }, followup() {} };
  const f = await fixture(t, { operatorControl: false }, { agents: { get: () => agent }, get: () => undefined, llm: {} }); await f.coordinator.attachAgent(agent);
  const input = source('admitted-source'), entered = deferred(), finish = deferred(), original = f.coordinator.repository.ingest.bind(f.coordinator.repository);
  f.releases.push(() => finish.resolve()); f.coordinator.repository.ingest = async value => { entered.resolve(); await finish.promise; return original(value); };
  f.coordinator.agents.get(agent.id).disposers.unshift(() => { throw Object.assign(new Error('Isolated disposer failure'), { code: 'FIXTURE_DISPOSER' }); });
  const observed = f.coordinator.observeEvent(session, { type: 'user/message', seq: 1, data: { id: input.sourceEventId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: input.text }] } });
  await within(entered.promise); let settled = false;
  const closing = f.coordinator.close().then(() => { settled = true; }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(await exists(path.join(f.root, 'writer.lock')), true);
  finish.resolve(); await within(Promise.all([observed, closing]));
  assert.ok(f.coordinator.errors.some(error => error.code === 'FIXTURE_DISPOSER')); assert.equal(tools.size, 0); assert.equal(handlers.size, 0);
  assert.equal(await exists(path.join(f.root, 'writer.lock')), false); await readRetained(f.root, input);
});

test('the synchronous cancellation phase is idempotent, retains the writer while draining and resets on reopen', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'xiangxu-shutdown-core-'))), root = path.join(base, 'memory'), timers = new Map(); let timerId = 0, calls = 0;
  const clock = { now: () => 1000, setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) };
  const repository = new MemoryRepository({ root, clock }), runtime = new PersonaRuntime({ repository, clock, model: { complete: async () => { calls++; return { decision: { replyPlan: { action: 'listen', target: null, replyAt: null, pendingEventIds: [], recheckOn: ['new_message'] } } }; } } });
  t.after(async () => { await runtime.close(); const relative = path.relative(await fs.realpath(tmpdir()), base); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await fs.rm(base, { recursive: true, force: true }); });
  await runtime.open(); await runtime.decide({ nextCheckAt: 2000, replyPlan: { action: 'listen', target: null, replyAt: null, pendingEventIds: [], recheckOn: ['new_message'] } }); assert.equal(timers.size, 1);
  runtime.beginClose(); runtime.beginClose(); assert.equal(runtime.closing, true); assert.equal(runtime.closed, false); assert.equal(timers.size, 0);
  const input = source('drained-core-source'); await runtime.accept(input);
  assert.equal((await runtime.handleSignal('new_message')).status, 'closed'); assert.equal((await runtime.handleDue()).status, 'closed'); assert.equal(calls, 0); assert.equal(await exists(path.join(root, 'writer.lock')), true);
  await runtime.close(); await runtime.open(); assert.equal(runtime.closing, false); assert.equal(runtime.closed, false); assert.equal(timers.size, 1);
  await runtime.handleSignal('new_message'); assert.equal(calls, 1);
});
