import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createDshCoordinator } from '../adapters/dsh/index.js';
import { createDelegationService } from '../adapters/dsh/delegation/service.js';
import { createPersonaSurfaces } from '../adapters/dsh/surfaces.js';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'xiangxu-task-consumer-')), events = [], tools = new Map(), handlers = new Map();
  const session = { id: 'parent-' + base.split(/[\\/]/).pop(), header: { cwd: base }, deriveMessages: () => [] };
  const scope = { on: (name, handler) => { handlers.set(name, handler); return () => { if (handlers.get(name) === handler) handlers.delete(name); }; }, tools: { restrict: () => () => {}, register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } } };
  const agent = { id: session.id, session, ctx: scope, inbox: { nextTurn: [], nextStep: [] }, status: 'idle' };
  const query = { readSession: async () => ({ events }), readEvent: async ({ seq, before = 0 }) => ({ target: events.find(e => e.seq === seq), before: events.filter(e => e.seq < seq).slice(-before), after: [] }) };
  const c = createDshCoordinator({ agents: { get: id => id === agent.id ? agent : null }, get: name => name === 'sessionQuery' ? query : undefined, llm: {} }, { memoryRoot: join(base, 'persona'), taskArchiveRoot: join(base, 'original-tasks'), operatorControl: false, tempTargetChars: 32 });
  await c.ready; const original = c.tasks;
  const report = 'UNREAD_ENGINEERING_RESULT_😀_'.repeat(2200), prompt = 'AI_DELEGATED_INSTRUCTION_ONLY_😀';
  let child, childEvents = [];
  const host = { registerTask: value => c.taskHost.registerTask(value), start: async args => { child = args; childEvents = [{ seq: 0, type: 'user/message', data: { id: 'initial-delegation', source: { kind: 'user' }, content: [{ type: 'text', text: args.prompt }] } }]; return { sessionId: args.sessionId, status: 'completed' }; }, inspect: async () => ({ exists: true, status: 'completed', result: report }), readEvents: async ({ afterSeq, limit }) => ({ events: childEvents.filter(e => e.seq > afterSeq).slice(0, limit), hasMore: false, complete: true }), cancel: async () => ({ status: 'cancelled' }), close: async () => {} };
  c.tasks = createDelegationService({ archiveRoot: join(base, 'tasks'), host, getRevocations: async () => { const meta = await c.repository.store.readJson('meta/state.json', { revokedSources: [], revokedIds: [] }); return { sourceKeys: meta.revokedSources ?? [], recordIds: meta.revokedIds ?? [] }; } }); await c.tasks.ready;
  t.after(async () => { await c.close(); await original.close(); assert(resolve(base).startsWith(resolve(tmpdir()) + sep + 'xiangxu-task-consumer-')); await rm(base, { recursive: true, force: true }); });
  await c.attachAgent(agent);
  const emit = async event => { const value = { time: Date.now(), seq: events.length, ...event }; events.push(value); await c.observeEvent(session, value); return value; };
  await emit({ type: 'user/message', data: { id: 'real-human-source', source: { kind: 'user' }, content: [{ type: 'text', text: 'ACTUAL_HUMAN_REQUEST' }] } });
  const task = await c.tasks.create({ requestId: 'fixture-create', parentSessionId: session.id, prompt }, { sourceRefs: [{ sourceSessionId: session.id, sourceEventId: 'real-human-source' }] });
  const saved = await c.tasks.get({ taskId: task.taskId });
  return { c, agent, session, tools, handlers, events, emit, task: saved, prompt, report, child: () => child };
}

test('actual coordinator keeps task bodies out of memory including cold host-trace rereads, but retains the human request', async t => {
  const f = await fixture(t), doc = f.task.documents.find(d => d.kind === 'final_report'); assert(doc);
  await f.emit({ type: 'assistant/message', data: { message: { id: 'main-task-call', content: [{ type: 'tool-call', id: 'call-task-read', name: 'persona_task', arguments: JSON.stringify({ action: 'read', taskId: f.task.taskId, documentId: doc.documentId, prompt: f.prompt }) }] } } });
  const value = await f.tools.get('persona_task').execute({ action: 'read', taskId: f.task.taskId, documentId: doc.documentId, maxChars: 4000 }, { agent: f.agent, callId: 'call-task-read' });
  assert(JSON.stringify(value).includes('UNREAD_ENGINEERING_RESULT'));
  await f.emit({ type: 'tool/result', data: { message: { toolCallId: 'call-task-read', role: 'tool', content: [{ type: 'text', text: JSON.stringify(value) }] } } });
  const run = await f.c.repository.prepareConsolidation({ maxInputChars: 16000 }); let material = '';
  f.c.taskIsolation.forgetSession(f.session); // Cold lookup must use the actual stored call rather than a result-provided tag.
  for await (const page of f.c.runtime._consolidationPages(run, { maxInputChars: 4000 })) material += JSON.stringify(page);
  assert(material.includes('ACTUAL_HUMAN_REQUEST')); assert(material.includes(f.task.taskId)); assert(!material.includes(f.prompt)); assert(!material.includes('UNREAD_ENGINEERING_RESULT'));
  const worker = { id: f.child().sessionId, session: { id: f.child().sessionId, header: { agentPreset: 'persona-memory' } }, ctx: f.agent.ctx };
  assert.equal((await f.c.attachAgent(worker)).status, 'task_worker_isolated');
  assert.equal((await f.c.observeEvent(worker.session, { seq: 0, type: 'user/message', data: { id: 'native-user-envelope', source: { kind: 'user' }, content: [{ type: 'text', text: f.prompt }] } })).isolatedTask, true);
  assert.equal(f.c.agents.has(worker.id), false);
});

test('actual retain offers only the selected archive range to autonomous review, and forgetting its human source revokes both', async t => {
  const f = await fixture(t), doc = f.task.documents.find(d => d.kind === 'final_report'), from = 11, count = 39;
  const result = await f.tools.get('persona_task').execute({ action: 'retain', taskId: f.task.taskId, documentId: doc.documentId, offset: from, maxChars: count, expectedSha256: doc.sha256 }, { agent: f.agent, callId: 'actual-retain' });
  assert.equal(result.capturedForReview, true); assert.equal(result.longTermMemoryWritten, false);
  const run = await f.c.repository.prepareConsolidation({ maxInputChars: 16000 }), selected = Array.from(f.report).slice(from, from + count).join('');
  const pages = []; for await (const page of f.c.runtime._consolidationPages(run, { maxInputChars: 7 })) pages.push(page);
  const restored = pages.flatMap(page => page.traceMaterial ?? []).filter(p => p.locator?.startsWith('persona-task-material:')).map(p => p.text).join('');
  assert.equal(restored, selected);
  const largePages = []; for await (const page of f.c.runtime._consolidationPages(run, { maxInputChars: 16000 })) largePages.push(page); assert.equal(largePages.flatMap(page => page.traceMaterial ?? []).filter(p => p.locator?.startsWith('persona-task-material:')).map(p => p.text).join(''), selected); assert(!JSON.stringify(run.input.chat).includes('UNREAD_ENGINEERING_RESULT')); assert(!JSON.stringify(run).includes(f.prompt));
  const originals = await f.c.repository.readSources({ sourceRefs: [{ sourceSessionId: f.session.id, sourceEventId: 'real-human-source' }] }); assert.equal(originals.length, 1);
  const forgotten = await f.c.executeCommand('forget', { ids: [originals[0].id], scope: 'unknown', reason: 'explicit fixture forgetting' }); assert(forgotten.taskCleanup.revokedTaskIds.includes(f.task.taskId));
  await assert.rejects(f.c.tasks.read({ taskId: f.task.taskId, documentId: doc.documentId }), { code: 'TASK_SOURCE_REVOKED' });
  const after = await f.c.repository.prepareConsolidation(); assert(!JSON.stringify(after).includes('persona-task:retained'));
});

test('owner task routes are bounded read/resource controls and cannot forge delegation or write personality memory', async () => {
  const calls = [], c = { ready: Promise.resolve(), tasks: { inspect: async () => ({ limits: {} }), read: async args => { calls.push(args); return { text: 'actual page' }; }, configureLimits: async args => { calls.push(args); return args; } }, taskHost: { capabilities: () => ({ available: true }) } };
  const service = createPersonaSurfaces({ management: { dispatch: async () => null }, getCoordinator: () => c });
  const result = await service.dispatch('tasks.read', { taskId: 'owned', documentId: 'owned-doc', actor: 'persona', sourceRefs: [{ bad: true }], parentSessionId: 'fake', instanceId: 'selected' }); assert.equal(result.text, 'actual page');
  assert.deepEqual(calls[0], { taskId: 'owned', documentId: 'owned-doc' });
  await assert.rejects(service.dispatch('tasks.create', { prompt: 'do not dispatch from an owner read path' }), { code: 'BAD_MANAGEMENT_REQUEST' });
  await assert.rejects(service.dispatch('tasks.material'), { code: 'BAD_MANAGEMENT_REQUEST' });
});

test('task tool results invalidated by concurrent forgetting cannot repopulate the cursor cache', async t => {
  const f = await fixture(t), doc = f.task.documents.find(d => d.kind === 'final_report'); let release, announce;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { announce = resolve; }), originalRead = f.c.tasks.read.bind(f.c.tasks);
  f.c.tasks.read = async args => { const value = await originalRead(args); announce(); await gate; return value; };
  const pending = f.tools.get('persona_task').execute({ action: 'read', taskId: f.task.taskId, documentId: doc.documentId, maxChars: 8000 }, { agent: f.agent, callId: 'racing-read' });
  await started;
  const originals = await f.c.repository.readSources({ sourceRefs: [{ sourceSessionId: f.session.id, sourceEventId: 'real-human-source' }] });
  await f.c.executeCommand('forget', { ids: [originals[0].id], scope: 'unknown', reason: 'concurrent explicit forgetting' });
  release(); const output = await pending;
  assert.equal(output.code, 'TASK_RESULT_INVALIDATED'); assert(!JSON.stringify(output).includes('UNREAD_ENGINEERING_RESULT'));
  assert.equal(f.c.agents.get(f.agent.id).toolResults.size, 0);
});

test('task archives cannot be configured inside the personality text store or as its ancestor', async t => {
  const base = await mkdtemp(join(tmpdir(), 'xiangxu-task-path-')); t.after(async () => { assert(resolve(base).startsWith(resolve(tmpdir()) + sep + 'xiangxu-task-path-')); await rm(base, { recursive: true, force: true }); });
  for (const archiveRoot of [join(base, 'persona', 'tasks'), base]) {
    const c = createDshCoordinator({ agents: { get: () => null }, get: () => undefined, llm: {} }, { memoryRoot: join(base, 'persona'), taskArchiveRoot: archiveRoot, operatorControl: false });
    await c.ready; assert.equal(c.initializationError, null); assert.equal(c.taskInitializationError.code, 'TASK_UNSAFE_PATH'); assert.equal(c.tasks, undefined); await c.close();
  }
});

test('the real first pre-step recovers its claimed turn so subsequent delegated tasks retain actual human provenance', async t => {
  const f = await fixture(t), assembly = await f.c.preparePersonaAssembly(f.agent, { sections: [], tools: [] });
  const state = f.c.agents.get(f.agent.id), previousSnapshot = state.latestSnapshot; assert.equal(state.currentTurn, null);
  const refreshed = await f.c.preparePersonaAssembly(f.agent, assembly), snapshot = state.latestSnapshot;
  assert.notStrictEqual(refreshed, assembly); assert.notStrictEqual(snapshot, previousSnapshot);
  assert.notEqual(snapshot.requestId, previousSnapshot.requestId); assert.equal(snapshot.personaVersion, previousSnapshot.personaVersion);
  assert.equal(snapshot.mandatoryContext.complete, true);
  for (const name of ['conversation', 'protocol', 'live']) assert.equal(refreshed.sections.filter(section => section.name === 'persona-memory:' + name).length, 1);
  assert.equal(refreshed.sections.find(section => section.name === 'persona-memory:live').text, snapshot.injectedText);
  assert.deepEqual(refreshed.tools, assembly.tools);
  const human = { id: 'real-human-source', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'ACTUAL_HUMAN_REQUEST' }] };
  const entered = await f.handlers.get('agent/pre-step')({ agent: f.agent, turn: 23, messages: [human] }, async () => ({ kind: 'enter', messages: [human] }));
  assert.equal(entered.kind, 'enter'); assert.equal(state.currentTurn, 23); assert.equal(state.eventTurn, 23); assert.equal(state.snapshots.get(23), snapshot); assert.equal(state.snapshots.has(null), false);
  assert(state.admittedByTurn.get(23).size > 0);
  f.c.taskHost.capabilities = () => ({ available: true }); // This isolated service port starts no native model.
  const output = await f.tools.get('persona_task').execute({ action: 'create', prompt: 'SECOND_GENERATED_TASK', title: 'task' }, { agent: f.agent, callId: 'create-after-claim' });
  assert.match(output.taskId, /^task-[a-f0-9]{32}$/); assert.equal(output.documents, undefined);
  const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(f.c.tasks.archiveRoot, output.taskId, 'manifest.json'), 'utf8'));
  assert(manifest.sourceRefs.some(ref => ref.sourceSessionId === f.session.id && ref.sourceEventId === 'real-human-source'));
  const status = await f.tools.get('persona_task').execute({ action: 'status', taskId: output.taskId }, { agent: f.agent, callId: 'status-only' });
  assert.equal(status.documents, undefined); assert.equal(status.taskId, output.taskId);
});

test('forgetting a deep memory of retained task material blocks task rereads while lossless source archival does not', async t => {
  const f = await fixture(t), doc = f.task.documents.find(d => d.kind === 'final_report');
  const retained = await f.tools.get('persona_task').execute({ action: 'retain', taskId: f.task.taskId, documentId: doc.documentId, offset: 7, maxChars: 27 }, { agent: f.agent, callId: 'retain-for-deep-revocation' });
  assert.equal(retained.capturedForReview, true);
  const run = await f.c.repository.prepareConsolidation({ maxInputChars: 16000 });
  const hot = run.input.hot.find(record => record.sourceKind === 'persona-task:retained'); assert(hot);
  await f.c.repository.applyConsolidation(run, [{ documentKey: 'global:deep', expectedVersion: run.inputVersions['global:deep'], recordId: 'task-experience', operation: 'upsert', value: {
    title: '独立研究的经历', reference: '我保留的任务经历', experience: '选中的研究片段', feltThen: '有兴趣', meaningNow: '我现在的理解', cues: [], aboutPersonIds: [], relatedMemoryIds: [], supersedesIds: [], srcRefs: [hot.sourceRef],
  } }]);
  const original = (await f.c.repository.readSources({ sourceRefs: [{ sourceSessionId: f.session.id, sourceEventId: 'real-human-source' }] }))[0]; assert(original);
  await f.c.repository.clearPending([original.eventId]);
  assert.equal((await f.c.repository.evictSources([original.id])).removed.length, 1);
  const archived = await f.c.repository.readSources({ eventIds: [original.eventId] });
  assert.equal(archived.length, 1); assert.equal(archived[0].tier, 'archive');
  assert.equal(archived[0].text, original.text); assert.equal(archived[0].sourceEventId, original.sourceEventId);
  assert.equal(archived[0].role, 'user');
  assert.equal((await f.c.repository.getContext()).records.some(record => record.id === original.id), false);
  assert.equal((await f.c.tasks.read({ taskId: f.task.taskId, documentId: doc.documentId, offset: 7, maxChars: 27 })).text, Array.from(f.report).slice(7, 34).join(''));
  assert.equal((await f.c.repository.getMemoryRecord('task-experience')).srcRefs[0].sourceEventId, hot.sourceRef.sourceEventId);
  const forgotten = await f.c.executeCommand('forget', { scope: 'global', ids: ['task-experience'], reason: 'explicit selected task experience forgetting' });
  assert(forgotten.taskCleanup.revokedTaskIds.includes(f.task.taskId));
  assert.equal(await f.c.repository.getMemoryRecord('task-experience'), null);
  await assert.rejects(f.c.tasks.read({ taskId: f.task.taskId, documentId: doc.documentId }), { code: 'TASK_SOURCE_REVOKED' });
  await assert.rejects(f.c.tasks.retain({ taskId: f.task.taskId, documentId: doc.documentId, offset: 0, maxChars: 100 }), { code: 'TASK_SOURCE_REVOKED' });
  const archiveRoot = f.c.tasks.archiveRoot; await f.c.tasks.close();
  f.c.tasks = createDelegationService({ archiveRoot, host: { start: async () => { throw Error('must not restart work'); }, inspect: async () => ({ exists: false }), readEvents: async () => ({ events: [], complete: true }), registerTask: value => f.c.taskHost.registerTask(value) },
    getRevocations: async () => { const meta = await f.c.repository.store.readJson('meta/state.json'); return { sourceKeys: meta.revokedSources, recordIds: meta.revokedIds }; } });
  await f.c.tasks.ready;
  await assert.rejects(f.c.tasks.material({ taskId: f.task.taskId, documentId: doc.documentId, offset: 2, maxChars: 20 }), { code: 'TASK_SOURCE_REVOKED' });
});
