import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshCoordinator, scanProcessDependencies } from '../adapters/dsh/index.js';

// Zero-model fixture: a real coordinator with the actual registered memory_search
// execute (review 10.2-10.4). The over-long-source deferral itself is covered by
// the pure-function suite and the D0-copy host-path walk; here retrievalTokens is
// lowered so ordinary rows defer, exercising the SAME detail channel end to end:
// no re-search on continuation, tamper rejection, explicit revocation expiry,
// frozen snapshot across unrelated additions, EVERY source delivered, and
// dependency scanning of partial detail pages stays honest.

const factText = '跨会话两来源事实：' + '豆包在键盘上踩过气闸。'.repeat(4);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'persona-dsh-detail-cursor-')), handlers = new Map(), tools = new Map();
  const scope = {on(name, handler) { handlers.set(name, handler); }, tools: { restrict() { return () => {}; }, register(tool) { tools.set(tool.name, tool); } }};
  const session = { id: 'session-detail', header: {}, deriveMessages: () => [], requestHeader: () => ({ config: { provider: 'test', model: 'fixture' } }) };
  const agent = { id: session.id, session, ctx: scope, inbox: { nextTurn: [], nextStep: [] }, followup(message) { this.inbox.nextTurn.push(message); } };
  const coordinator = createDshCoordinator({ agents: { get: () => agent }, llm: {}, get: () => undefined },
    { memoryRoot: root, operatorControl: false });
  await coordinator.ready; await coordinator.attachAgent(agent);
  await coordinator.repository.upsertPerson({ personId: 'person_detail' });
  await coordinator.runtime.decide({ identityPlan: { action: 'associate', personId: 'person_detail', sourceRefs: [] } },
    { ...coordinator.contextFor(agent), executeReply: false });
  t.after(async () => { await coordinator.close(); await rm(root, { recursive: true, force: true }); });
  let seq = 0;
  const observe = (type, data) => coordinator.observeEvent(session, { type, seq: seq++, time: Date.now(), data });
  const enter = async (id, text, turn) => {
    const message = { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
    await observe('turn/start', { turn }); handlers.get('agent/inbox/claimed')({ message, turn });
    const entered = await handlers.get('agent/pre-step')({ messages: [message], turn }, async () => ({ kind: 'enter', messages: [message] }));
    assert.equal(entered.kind, 'enter'); await observe('user/message', message);
  };
  return { coordinator, repository: coordinator.repository, runtime: coordinator.runtime, agent, tools, observe, enter };
}

test('registered memory_search detail continuation reads the frozen snapshot without re-searching', async t => {
  const f = await fixture(t);
  await f.enter('src-1', '原话：豆包踩过气闸的第一现场记录。', 1);
  await f.observe('assistant/message', { turn: 1, message: { id: 'src-2', role: 'assistant', content: [
    { type: 'text', text: '补充的第二来源原话。' }] } });
  const srcRefs = [
    { sourceSessionId: 'session-detail', sourceEventId: 'src-1', available: true },
    { sourceSessionId: 'session-detail', sourceEventId: 'src-2', available: true },
  ];
  const run = await f.repository.prepareConsolidation({ personId: 'person_detail' });
  const documentKey = 'person:person_detail:index';
  await f.repository.applyConsolidation(run, { entries: [{ documentKey, expectedVersion: run.inputVersions[documentKey],
    operation: 'upsert', recordId: 'fact_two_sources', value: { kind: 'fact', text: factText, srcRefs } }] });

  // Force the deferred path with a small page budget (same code path an
  // over-long identity envelope takes at the default budget).
  f.repository.config.contextBudget.retrievalTokens = 800;

  let searches = 0;
  const originalSearch = f.runtime.search.bind(f.runtime);
  f.runtime.search = async (...callArgs) => { searches++; return originalSearch(...callArgs); };

  const tool = f.tools.get('memory_search');
  const call = (payload, callId) => tool.execute(payload, { agent: f.agent, callId });
  const listArgs = { scope: 'all', limit: 8 };
  listArgs.query = '两来源';

  const first = await call({...listArgs}, 'list-one');
  assert.equal(searches, 1);
  const deferredRow = (first.items ?? []).find(item => item.textDeferred === 'budget' && item.id === 'fact_two_sources');
  assert.ok(deferredRow && deferredRow.detailCursor, 'fact row defers with a detail cursor');
  assert.equal(deferredRow.personId, 'person_detail');
  assert.equal(deferredRow.schemaVersion, 'persona-memory/3', 'fragment keeps scanner-recognizable identity');

  // Sequential detail continuation: same snapshot from cache, search count unchanged.
  let detailJson = '';
  let detailCursor = deferredRow.detailCursor;
  let pages = 0;
  let firstPage = null;
  while (detailCursor) {
    const stepArgs = {...listArgs, detailCursor};
    const page = await call(stepArgs, 'detail-' + pages);
    assert.equal(searches, 1, 'detail continuation never re-runs runtime.search');
    assert.equal(page.status, 'bounded_detail');
    if (!firstPage) firstPage = page;
    detailJson += page.detail.text;
    detailCursor = page.nextCursor;
    assert.ok(pages < 40, 'detail walk terminates');
    pages++;
  }
  const rebuilt = JSON.parse(detailJson);

  // 10.4: EVERY source of the record, field-exact.
  assert.equal(rebuilt.srcRefs.length, 2);
  assert.equal(rebuilt.srcRefs[0].sourceSessionId, 'session-detail');
  assert.equal(rebuilt.srcRefs[0].sourceEventId, 'src-1');
  assert.equal(rebuilt.srcRefs[1].sourceSessionId, 'session-detail');
  assert.equal(rebuilt.srcRefs[1].sourceEventId, 'src-2');
  assert.equal(rebuilt.text, factText, 'full text rebuilt through the detail channel');

  // 10.3: a partial detail page scans as incomplete with real memory identity kept,
  // and a transport id in the same envelope does not become a memory dependency.
  const envelopeText = JSON.stringify({...firstPage, transportId: 'transport-envelope'});
  const envelope = {message: {id: 'transport-envelope', role: 'tool', source: {kind: 'tool'},
    content: [{type: 'text', text: envelopeText}]}};
  const scan = scanProcessDependencies({kind: 'tool_result', sourceKind: 'tool/result', content: {mode: 'cached', text: JSON.stringify(envelope)}});
  assert.equal(scan.complete, false, 'partial detail must not scan as complete');
  assert.ok(scan.recordIds.includes('fact_two_sources'), 'memory identity survives the fragment');
  assert.ok(!scan.recordIds.includes('transport-envelope'), 'transport id stays a transport id');

  // 10.2: tampered arguments are rejected against the frozen snapshot binding.
  const tamperArgs = {scope: 'all', limit: 8, detailCursor: deferredRow.detailCursor};
  tamperArgs.query = '别的查询';
  const tampered = await call(tamperArgs, 'tamper');
  assert.equal(tampered.status, 'memory_error');
  assert.equal(tampered.code, 'INVALID_TOOL_CURSOR');

  // Unrelated additions between pages do not disturb the frozen snapshot.
  const otherRun = await f.repository.prepareConsolidation({ personId: 'person_detail' });
  await f.repository.applyConsolidation(otherRun, { entries: [{ documentKey, expectedVersion: otherRun.inputVersions[documentKey],
    operation: 'upsert', recordId: 'fact_unrelated', value: { kind: 'fact', text: '完全无关的新事实，只是让库继续长大。', srcRefs: [] } }] });
  const listAgain = await call({...listArgs}, 'list-two');
  assert.equal(searches, 2);
  const deferredAgain = (listAgain.items ?? []).find(item => item.textDeferred === 'budget' && item.id === 'fact_two_sources');
  assert.ok(deferredAgain, 'deferred row still present after unrelated additions');

  // Revocation expires the cached snapshot explicitly (no fresh result mixed in).
  const forgetArgs = {ids: ['fact_two_sources'], scope: 'person', targetPersonId: 'person_detail', reason: 'detail snapshot revocation check'};
  const forgotten = await f.coordinator.executeCommand('forget', forgetArgs);
  assert.ok(forgotten.affectedIds.includes('fact_two_sources'));
  const expiredArgs = {...listArgs, detailCursor: deferredRow.detailCursor};
  const afterForget = await call(expiredArgs, 'detail-after-forget');
  assert.equal(afterForget.status, 'memory_error');
  assert.equal(afterForget.code, 'TOOL_CURSOR_EXPIRED');
  assert.equal(searches, 2, 'expiry is served from the cache state, not by re-searching');
});
