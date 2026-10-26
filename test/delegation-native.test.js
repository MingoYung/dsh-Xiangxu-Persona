import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDelegationHost, lookupTaskWorker, TASK_WORKER_PRESET } from '../adapters/dsh/delegation/native.js';
import { acquireTaskWorkerScope, mountTaskWorkerScope, WORKER_TOOL_NAMES } from '../adapters/dsh/delegation/worker.js';

const binding = n => ({ taskId: 'task-' + n, sessionId: 'worker-' + n, parentSessionId: 'parent-' + n });
const missing = () => Object.assign(Error('not retained'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
function toolsFixture() {
  const names = ['read', 'write', 'pwsh', 'web_fetch', 'send_message', 'subagent', 'subagent_fork', 'memory_search', 'persona_platform', 'workflow'];
  const masks = new Set(), guards = new Set();
  return { masks, guards, schemas: () => names.map(name => ({ name })), restrict: value => { assert(value.allow.every(name => names.includes(name))); masks.add(value); return () => masks.delete(value); },
    guard: value => { guards.add(value); return () => guards.delete(value); } };
}
function fixture(n) {
  const meta = binding(n), agents = new Map(), logs = new Map(), handlers = new Map(), starts = [], requests = [];
  const parent = { id: meta.parentSessionId, session: { id: meta.parentSessionId, header: { id: meta.parentSessionId }, requestHeader: () => ({ config: { provider: 'isolated-fixture', model: 'fixture' } }) } };
  agents.set(parent.id, parent); let settle, disposed = 0, altered;
  const ctx = { agents: { get: key => agents.get(key), list: () => [...agents.values()] }, on: (name, fn) => { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); return () => handlers.set(name, list.filter(x => x !== fn)); } };
  const query = { readSession: async sessionId => { if (!logs.has(sessionId)) throw missing(); return structuredClone(logs.get(sessionId)); },
    readEvent: async request => { requests.push(request); const saved = logs.get(request.sessionId); if (!saved) throw missing(); if (!saved.events[request.seq]) throw Object.assign(Error('end'), { code: 'SESSION_QUERY_EVENT_NOT_FOUND' }); const events = saved.events.slice(request.seq, request.seq + request.after + 1); return { session: saved.session, events, target: events[0] }; } };
  const subagents = { getProvider: () => ({ inheritsParentContext: false, capabilities: { agentPreset: true }, prepareContinuable() {} }), resolveMaxDepth: () => 3,
    startActivation: async spec => {
      starts.push(spec); assert.deepEqual(lookupTaskWorker(spec.childId)?.parentSessionId, parent.id);
      const header = { id: spec.childId, parentSession: parent.id, agentPreset: spec.request.agentPreset, isSeeded: false, ...(spec.request.cwd ? { cwd: spec.request.cwd } : {}) };
      const child = { id: spec.childId, session: { id: spec.childId, header, seq: 2 }, ctx: { tools: toolsFixture() } };
      agents.set(child.id, child); logs.set(child.id, { session: header, events: [{ seq: 0, type: 'agent-preset/selected', data: { agentPreset: TASK_WORKER_PRESET } }, { seq: 1, type: 'user/message', data: { id: 'native-task-envelope', source: { kind: 'user' }, content: [{ type: 'text', text: spec.request.prompt[0].text }] } }] });
      for (const handler of handlers.get('agent/created') ?? []) handler({ agent: child });
      const result = new Promise(resolve => { settle = value => { agents.delete(child.id); resolve(value); }; });
      const receipt = { childId: child.id, messageId: 'native-task-envelope', result, dispose: async () => { disposed++; settle({ output: [], stopReason: 'aborted' }); } };
      return altered ? altered(receipt, child) : receipt;
    } };
  const services = { subagents, sessionQuery: query, agentPresets: { mount() {} } }; ctx.get = name => services[name];
  const host = createDelegationHost({ ctx });
  return { meta, host, ctx, agents, logs, starts, requests, subagents, query, get disposed() { return disposed; }, set altered(fn) { altered = fn; },
    settle: value => settle(value), publish: sessionId => { for (const handler of handlers.get('session/event') ?? []) handler({ id: sessionId }, {}); } };
}

test('task host is lazy when DSH delegation is unavailable and never invents a native session', async () => {
  const host = createDelegationHost({ ctx: {} }); assert.equal(host.capabilities().available, false);
  await assert.rejects(host.start({ ...binding('unavailable'), prompt: 'do the selected task' }), { code: 'TASK_HOST_UNAVAILABLE' });
  assert.equal(lookupTaskWorker('worker-unavailable').origin, 'assistant_delegation'); await host.close(); assert.equal(lookupTaskWorker('worker-unavailable').roleTombstone, true);
});

test('native spawn uses a reserved child ID, independent preset, existing policy and caller-owned full result', async () => {
  const f = fixture('fresh'); let changes = 0; f.host.onChange(() => { changes++; });
  const request = { ...f.meta, prompt: 'complete engineering task', title: 'independent task' };
  const first = await f.host.start(request), spec = f.starts[0];
  assert.equal(first.sessionId, f.meta.sessionId); assert.equal(spec.childId, f.meta.sessionId); assert.equal(spec.provider, 'spawn'); assert.equal(spec.delivery, 'caller');
  assert.equal(spec.request.agentPreset, TASK_WORKER_PRESET); assert.equal(spec.request.parent, f.agents.get(f.meta.parentSessionId)); assert.equal(spec.request.maxDepth, 3);
  assert.equal('seed' in spec, false); assert.equal('agentOptions' in spec.request, false); assert.deepEqual(spec.request.prompt, [{ type: 'text', text: request.prompt }]);
  assert.equal((await f.host.start(request)).duplicate, true); assert.equal(f.starts.length, 1);
  await assert.rejects(f.host.start({ ...request, prompt: 'different task' }), { code: 'TASK_HOST_REQUEST_CONFLICT' });
  const full = { output: [{ type: 'text', text: 'complete result '.repeat(30000) }], stopReason: 'completed' }; f.settle(full); await Promise.resolve();
  const outcome = await f.host.inspect({ sessionId: f.meta.sessionId }); assert.equal(outcome.status, 'completed'); assert.deepEqual(outcome.result, full); assert(changes > 0);
  await f.host.close(); assert.equal(lookupTaskWorker(f.meta.sessionId).roleTombstone, true); assert.equal('workspace' in lookupTaskWorker(f.meta.sessionId), false);
});

test('a lost native start acknowledgement is not automatically submitted again', async () => {
  const f = fixture('lost'); f.altered = () => { throw Error('ack lost after native child created'); };
  await assert.rejects(f.host.start({ ...f.meta, prompt: 'one expensive task' }), /ack lost/);
  assert.equal((await f.host.start({ ...f.meta, prompt: 'one expensive task' })).duplicate, true); assert.equal(f.starts.length, 1);
  assert.equal((await f.host.inspect({ sessionId: f.meta.sessionId })).exists, true);
  f.subagents.drainChildren = async (_parent, ids) => { assert.deepEqual(ids, [f.meta.sessionId]); f.agents.delete(f.meta.sessionId); };
  await f.host.cancel({ sessionId: f.meta.sessionId }); await f.host.close();
});

test('persisted task recovery hydrates trustworthy ownership and does not submit another model request', async () => {
  const f = fixture('cold'); const header = { id: f.meta.sessionId, parentSession: f.meta.parentSessionId, agentPreset: TASK_WORKER_PRESET, isSeeded: false };
  f.logs.set(f.meta.sessionId, { session: header, events: [{ seq: 0, type: 'turn/start', data: {} }, { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'retained full report' }] } } }, { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } }] });
  f.host.registerTask(f.meta); assert.equal(lookupTaskWorker(f.meta.sessionId).origin, 'assistant_delegation');
  assert.equal((await f.host.start({ ...f.meta, prompt: 'retained original request' })).duplicate, true); assert.equal(f.starts.length, 0);
  const state = await f.host.inspect({ sessionId: f.meta.sessionId }); assert.equal(state.status, 'completed'); assert.equal(state.result.output[0].text, 'retained full report');
  const page = await f.host.readEvents({ sessionId: f.meta.sessionId, afterSeq: 0, limit: 50 }); assert.deepEqual(page.events.map(x => x.seq), [1, 2]); assert.equal(page.complete, true);
  await f.host.close();
});

test('source queries reject a foreign parent, inherited history or conflicting actual worker preset', async () => {
  const f = fixture('conflict'); f.host.registerTask(f.meta);
  f.logs.set(f.meta.sessionId, { session: { id: f.meta.sessionId, parentSession: 'someone-else', agentPreset: TASK_WORKER_PRESET }, events: [] });
  await assert.rejects(f.host.inspect({ sessionId: f.meta.sessionId }), { code: 'TASK_HOST_SOURCE_CONFLICT' });
  f.logs.get(f.meta.sessionId).session.parentSession = f.meta.parentSessionId; f.logs.get(f.meta.sessionId).session.isSeeded = true;
  await assert.rejects(f.host.inspect({ sessionId: f.meta.sessionId }), { code: 'TASK_HOST_SOURCE_CONFLICT' });
  f.logs.get(f.meta.sessionId).session.isSeeded = false; f.logs.get(f.meta.sessionId).session.agentPreset = 'persona-memory';
  await assert.rejects(f.host.inspect({ sessionId: f.meta.sessionId }), { code: 'TASK_HOST_SOURCE_CONFLICT' }); await f.host.close();
});

test('full native event bytes stay intact while the query window and task ownership remain bounded', async () => {
  const f = fixture('events'); await f.host.start({ ...f.meta, prompt: 'trace task' });
  const large = '完整日志🙂'.repeat(50000), saved = f.logs.get(f.meta.sessionId); saved.events.push({ seq: 2, type: 'tool/result', data: { message: { content: [{ type: 'text', text: large }] } } }); f.agents.get(f.meta.sessionId).session.seq = 3;
  const page = await f.host.readEvents({ sessionId: f.meta.sessionId, afterSeq: 1, limit: 1 }); assert.equal(page.events[0].data.message.content[0].text, large); assert.equal(page.hasMore, false); assert.deepEqual(f.requests[0], { sessionId: f.meta.sessionId, seq: 2, before: 0, after: 0 });
  await assert.rejects(f.host.readEvents({ sessionId: 'unowned', afterSeq: -1 }), { code: 'TASK_HOST_NOT_OWNED' });
  await assert.rejects(f.host.readEvents({ sessionId: f.meta.sessionId, limit: 51 }), { code: 'TASK_TRACE_CURSOR' });
  saved.events[2].seq = 9; await assert.rejects(f.host.readEvents({ sessionId: f.meta.sessionId, afterSeq: 1 }), { code: 'TASK_TRACE_ORDER' }); await f.host.close();
});

test('worker preset teardown cannot remove the native host claim or expose delegated bypass tools', async () => {
  const meta = binding('claims'), tools = toolsFixture(), agent = { id: meta.sessionId, session: { header: { parentSession: meta.parentSessionId, agentPreset: TASK_WORKER_PRESET } }, ctx: { tools } };
  const releaseHost = acquireTaskWorkerScope(agent, meta), handlers = new Map(), cleanups = [];
  let sectionRegistered = false;
  const ctx = { get: name => name === 'agents' ? { list: () => [agent] } : undefined, on: (name, fn) => handlers.set(name, fn), effect: fn => cleanups.push(fn()),
    systemPrompt: { getSectionOrder: name => { assert.equal(name, 'DEPLOYMENT_PERSONA_PREFIX'); return 101; }, section: value => { assert.equal(value.name, 'xiangxu:task-worker'); assert.equal(value.order, 101); assert(Number.isFinite(value.order)); sectionRegistered = true; } } };
  mountTaskWorkerScope(ctx, { lookupWorker: () => meta }); assert.equal(tools.masks.size, 1); assert.equal(tools.guards.size, 1);
  const filter = [...tools.masks][0]; assert(filter.allow.includes('read')); assert(filter.allow.includes('pwsh')); for (const name of ['send_message', 'subagent', 'subagent_fork', 'memory_search', 'persona_platform', 'workflow']) assert.equal(filter.allow.includes(name), false);
  const guard = [...tools.guards][0]; assert.equal(guard({ name: 'read' }), undefined); assert.equal(guard({ name: 'run_code' }), undefined); assert.match(guard({ name: 'persona_platform' }), /TASK_WORKER_TOOL_SCOPE/);
  cleanups[0](); assert.equal(tools.masks.size, 1); releaseHost(); assert.equal(tools.masks.size, 0); assert.equal(tools.guards.size, 0); releaseHost();
  assert.equal(WORKER_TOOL_NAMES.includes('create_goal'), false); assert.equal(sectionRegistered, true);
});

test('unregistered workers cannot obtain a trusted task scope from their own message claims', () => {
  const tools = toolsFixture(), agent = { id: 'not-owned', session: { header: { parentSession: 'fake-parent' } }, ctx: { tools } };
  assert.throws(() => acquireTaskWorkerScope(agent, null), { code: 'TASK_WORKER_UNREGISTERED' }); assert.equal(tools.masks.size, 0);
});

test('artifact snapshots use real owned-workspace bytes, detect changes, and reject escapes and links', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'xiangxu-native-artifact-')); t.after(async () => { assert(root.startsWith(path.join(tmpdir(), 'xiangxu-native-artifact-'))); await fs.rm(root, { recursive: true, force: true }); });
  const f = fixture('artifact'); t.after(() => f.host.close()); f.host.registerTask({ ...f.meta, workspace: root });
  const data = Buffer.from('完整🙂资料'.repeat(20000)); await fs.writeFile(path.join(root, 'report.txt'), data);
  const first = await f.host.readArtifact({ sessionId: f.meta.sessionId, path: 'report.txt', maxBytes: 12001 });
  assert.deepEqual(first.bytes, data.subarray(0, 12001)); assert.equal(first.complete, false); assert.equal(first.size, data.length); assert.equal(first.fingerprintKind, 'stat-identity-sha256');
  const second = await f.host.readArtifact({ sessionId: f.meta.sessionId, path: 'report.txt', cursor: first.nextCursor, maxBytes: 65536, expectedFingerprint: first.fingerprint }); assert.deepEqual(second.bytes, data.subarray(12001, 12001 + 65536));
  await fs.appendFile(path.join(root, 'report.txt'), 'changed'); await assert.rejects(f.host.readArtifact({ sessionId: f.meta.sessionId, path: 'report.txt', cursor: first.nextCursor, expectedFingerprint: first.fingerprint }), { code: 'TASK_ARTIFACT_CHANGED' });
  await assert.rejects(f.host.readArtifact({ sessionId: f.meta.sessionId, path: '../secret.txt' }), { code: 'TASK_ARTIFACT_PATH' });
  await fs.symlink(root, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(f.host.readArtifact({ sessionId: f.meta.sessionId, path: 'linked/report.txt' }), { code: 'TASK_ARTIFACT_PATH' });
  await assert.rejects(f.host.readArtifact({ sessionId: f.meta.sessionId, path: '.' }), { code: 'TASK_ARTIFACT_PATH' });
});

test('closing the host drains only its owned native activation and releases persistent worker guards', async () => {
  const f = fixture('close'); await f.host.start({ ...f.meta, prompt: 'cancel owned work' }); const child = f.agents.get(f.meta.sessionId);
  assert.equal(child.ctx.tools.masks.size, 1); f.agents.set('unrelated', { id: 'unrelated' }); await f.host.close();
  assert.equal(f.disposed, 1); assert.equal(f.agents.has('unrelated'), true); assert.equal(child.ctx.tools.masks.size, 0); assert.equal(lookupTaskWorker(f.meta.sessionId).roleTombstone, true);
  await assert.rejects(f.host.inspect({ sessionId: f.meta.sessionId }), { code: 'TASK_HOST_CLOSED' });
});

test('concurrent starts share the one reserved native activation', async () => {
  const f = fixture('concurrent'), request = { ...f.meta, prompt: 'one concurrent task' };
  const values = await Promise.all([f.host.start(request), f.host.start(request), f.host.start(request)]);
  assert.equal(f.starts.length, 1); assert(values.every(value => value.sessionId === request.sessionId)); await f.host.close();
});

test('an inheritance-capable backend cannot substitute for fresh independent spawn', async () => {
  const f = fixture('fork-refused'); f.subagents.getProvider = () => ({ inheritsParentContext: true, capabilities: { agentPreset: true }, prepareContinuable() {} });
  assert.equal(f.host.capabilities().available, false);
  await assert.rejects(f.host.start({ ...f.meta, prompt: 'independent task' }), { code: 'TASK_HOST_UNAVAILABLE' }); assert.equal(f.starts.length, 0); await f.host.close();
});

test('a malformed native receipt is disposed instead of leaving an untracked child running', async () => {
  const f = fixture('bad-receipt'); f.altered = receipt => ({ ...receipt, childId: 'wrong-reserved-id' });
  await assert.rejects(f.host.start({ ...f.meta, prompt: 'must have exact identity' }), { code: 'TASK_NATIVE_RECEIPT' });
  assert.equal(f.disposed, 1); assert.equal(f.agents.has(f.meta.sessionId), false); await f.host.close();
});

test('close after a lost acknowledgement uses the exact native parent-child drain', async () => {
  const f = fixture('lost-close'); f.altered = () => { throw Error('ack lost'); }; let drainCalls = 0;
  f.subagents.drainChildren = async (parent, ids) => { drainCalls++; assert.equal(parent.id, f.meta.parentSessionId); assert.deepEqual(ids, [f.meta.sessionId]); f.agents.delete(f.meta.sessionId); };
  await assert.rejects(f.host.start({ ...f.meta, prompt: 'accepted before ack was lost' }), /ack lost/); await f.host.close();
  assert.equal(drainCalls, 1); assert.equal(f.agents.has(f.meta.sessionId), false); assert.equal(lookupTaskWorker(f.meta.sessionId).roleTombstone, true);
});

test('close during source preflight does not start a model after shutdown began', async () => {
  const f = fixture('preflight-close'); let release, started; const waiting = new Promise(resolve => started = resolve);
  f.query.readSession = async () => { started(); await new Promise(resolve => release = resolve); throw missing(); };
  const start = f.host.start({ ...f.meta, prompt: 'not after shutdown' }); await waiting; const close = f.host.close(); release();
  await assert.rejects(start, { code: 'TASK_HOST_CLOSED' }); await close; assert.equal(f.starts.length, 0); assert.equal(lookupTaskWorker(f.meta.sessionId).roleTombstone, true);
});

test('a settled native receipt wins over an idle child remaining in the live registry', async () => {
  const f = fixture('retained-idle'); await f.host.start({ ...f.meta, prompt: 'retained child result' });
  const child = f.agents.get(f.meta.sessionId); f.settle({ output: [{ type: 'text', text: 'full final report' }], stopReason: 'completed' }); await Promise.resolve();
  f.agents.set(f.meta.sessionId, child); child.status = 'idle';
  const result = await f.host.inspect({ sessionId: f.meta.sessionId }); assert.equal(result.status, 'completed'); assert.equal(result.result.output[0].text, 'full final report');
  const events = await f.host.readEvents({ sessionId: f.meta.sessionId }); assert.equal(events.hasMore, false); assert.equal(events.complete, true);
  await f.host.close();
});

test('forget and close retain only provenance tombstones and late results cannot restore revoked contents', async () => {
  const f = fixture('revoked'); await f.host.start({ ...f.meta, prompt: 'private delegated work' });
  const forgotten = f.host.forgetTask({ taskId: f.meta.taskId, sessionId: f.meta.sessionId }); assert.equal(forgotten.hostCopiesDeleted, false);
  f.settle({ output: [{ type: 'text', text: 'late private result' }], stopReason: 'completed' }); await Promise.resolve();
  assert.equal((await f.host.inspect({ sessionId: f.meta.sessionId })).status, 'revoked');
  await assert.rejects(f.host.readEvents({ sessionId: f.meta.sessionId }), { code: 'TASK_SOURCE_REVOKED' });
  await assert.rejects(f.host.readArtifact({ sessionId: f.meta.sessionId, path: 'private.txt' }), { code: 'TASK_SOURCE_REVOKED' }); await f.host.close();
  const marker = lookupTaskWorker(f.meta.sessionId); assert.equal(marker.revoked, true); assert.equal(marker.roleTombstone, true); assert.equal('workspace' in marker, false); assert.equal(JSON.stringify(marker).includes('private'), false);
  const next = createDelegationHost({ ctx: f.ctx }); next.registerTask({ ...f.meta, status: 'revoked' });
  await assert.rejects(next.start({ ...f.meta, prompt: 'try again' }), { code: 'TASK_SOURCE_REVOKED' }); await next.close();
});

test('cancel during asynchronous source preflight cannot admit a new native activation afterward', async () => {
  const f = fixture('preflight-cancel'); let release, entered; const waiting = new Promise(resolve => entered = resolve);
  f.query.readSession = async () => { entered(); await new Promise(resolve => release = resolve); throw missing(); };
  const start = f.host.start({ ...f.meta, prompt: 'cancel before native admission' }); await waiting;
  const cancel = f.host.cancel({ sessionId: f.meta.sessionId }); release();
  await assert.rejects(start, { code: 'TASK_CANCELLED' }); assert.equal((await cancel).status, 'cancelled'); assert.equal(f.starts.length, 0); await f.host.close();
});
