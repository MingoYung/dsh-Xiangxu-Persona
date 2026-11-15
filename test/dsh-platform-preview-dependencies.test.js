import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createDshCoordinator } from '../adapters/dsh/index.js';

const platformArgs = { platform: 'qq', action: 'read', capability: 'message.read' };
const tail = '超过工具分页上限的资料。'.repeat(200);

async function fixture(t, { readEvent = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'xiangxu-preview-'));
  const handlers = new Map(), tools = new Map(), events = [];
  const scope = { on(name, handler) { handlers.set(name, handler); }, tools: {
    restrict: () => () => {}, register(tool) { tools.set(tool.name, tool); },
  } };
  const session = { id: 'preview-session', header: {}, deriveMessages: () => [], requestHeader: () => ({ config: { provider: 'fixture', model: 'fixture' } }) };
  const agent = { id: session.id, session, ctx: scope, inbox: { nextTurn: [], nextStep: [] } };
  const query = { readSession: async () => ({ events }) };
  if (readEvent) query.readEvent = async ({ seq }) => ({ target: events.find(event => event.seq === seq) });
  const coordinator = createDshCoordinator({ agents: { get: () => agent }, llm: {}, get: name => name === 'sessionQuery' ? query : undefined }, { memoryRoot: root, operatorControl: false });
  t.after(async () => { await coordinator.close(); await rm(root, { recursive: true, force: true }); });
  await coordinator.ready;
  await coordinator.attachAgent(agent);
  const original = await coordinator.repository.ingest({ sourceSessionId: 'original-session', sourceEventId: 'original-source', channelId: 'original-channel',
    sourceKind: 'user', contentClass: 'participant_dialogue', role: 'user', text: '可明确撤销的原件' });
  const ref = { sourceSessionId: original.record.sourceSessionId, sourceEventId: original.record.sourceEventId };
  const full = { details: tail, original: { schemaVersion: 'persona-memory/3', id: original.record.id, srcRefs: [ref] }, platformMessage: { id: 'platform-message' } };
  coordinator.platformPort = async () => full;
  const tool = tools.get('persona_platform');
  let seq = 0;
  const eventFor = (type, data) => {
    const event = { type, data, seq: seq++, time: Date.now() };
    events.push(event);
    return event;
  };
  const observe = (type, data) => coordinator.observeEvent(session, eventFor(type, data));
  const preStep = turn => handlers.get('agent/pre-step')({ messages: [], turn }, async () => ({ kind: 'enter', messages: [] }));
  const begin = async turn => {
    await observe('turn/start', { turn });
    await preStep(turn);
  };
  const preview = async callId => {
    const output = await tool.execute(platformArgs, { agent, callId });
    assert.equal(output.status, 'bounded_preview');
    assert.equal(output.preview.fragment.complete, false);
    assert.ok(!JSON.stringify(output).includes(original.record.id), 'revocable reference is beyond the displayed page');
    return tool.output.render(platformArgs, output);
  };
  const data = (turn, callId, content) => ({ turn, message: { id: 'tool-transport', role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, isError: false, content } });
  const hot = () => coordinator.repository.store.readLines('staging/hot.jsonl');
  const gaps = async () => (await coordinator.repository.getRuntime()).memoryGaps.filter(row => row.resolvedAt == null);
  const forget = () => coordinator.executeCommand('forget', { ids: [original.record.id], scope: 'unknown', reason: '测试来源撤销' });
  return { coordinator, session, full, original, ref, begin, preStep, preview, observe, eventFor, data, hot, gaps, forget };
}

test('native platform preview stores bounded display trace and complete private provenance, then forget removes the dependent turn', async t => {
  const f = await fixture(t);
  await f.begin(1);
  const content = await f.preview('real-call');
  await f.observe('tool/result', f.data(1, 'real-call', content));
  await f.observe('assistant/message', { turn: 1, message: { id: 'assistant-1', role: 'assistant', source: { kind: 'model' },
    content: [{ type: 'reasoning', text: '这次工具读取后的过程。' }] } });
  const rows = await f.hot();
  const recorded = rows.find(row => row.kind === 'tool_result');
  assert.equal(recorded?.content.mode, 'host_trace');
  assert.deepEqual(recorded.dependencyRecordIds, [f.original.record.id]);
  assert.deepEqual(recorded.dependencyRefs, [f.ref]);
  assert.equal(recorded.dependencyScanComplete, true);
  assert.ok(rows.some(row => row.kind === 'reasoning' && row.dependencyRecordIds.includes(f.original.record.id)));
  assert.deepEqual(await f.gaps(), []);
  const trace = await f.coordinator.runtime.host.readTrace(recorded.content.locator);
  assert.equal(trace.available, true);
  assert.deepEqual(JSON.parse(trace.text).message.content, content);
  assert.ok(!trace.text.includes(tail));
  assert.ok((await f.forget()).affectedIds.includes(f.original.record.id));
  assert.ok(!(await f.hot()).some(row => ['tool_result', 'reasoning'].includes(row.kind)));
});

test('platform preview proof rejects stale, unaddressable, mismatched and genuinely incomplete results', async t => {
  for (const scenario of ['wrong-call', 'conflicting-call', 'wrong-turn', 'turn-ended', 'wrong-text', 'extra-block', 'source-revoked', 'historical-replay', 'no-read-event', 'nested-partial']) {
    await t.test(scenario, async child => {
      const f = await fixture(child, { readEvent: scenario !== 'no-read-event' });
      await f.begin(1);
      if (scenario === 'nested-partial') f.full.original.preview = { format: 'json_text_fragment', fragment: { from: 0, to: 1, total: 3, complete: false } };
      let content = await f.preview('real-call');
      if (scenario === 'wrong-call') f.coordinator.taskIsolation.registerCall(f.session, 'other-call', { name: 'persona_platform', arguments: platformArgs });
      if (scenario === 'turn-ended') await f.observe('turn/end', { turn: 1 });
      if (scenario === 'source-revoked') assert.ok((await f.forget()).affectedIds.includes(f.original.record.id));
      if (scenario === 'wrong-text') content = [{ ...content[0], text: content[0].text + ' ' }];
      if (scenario === 'extra-block') content = [...content, { type: 'text', text: '未验证的附加材料' }];
      const result = f.data(scenario === 'wrong-turn' ? 2 : 1, scenario === 'wrong-call' ? 'other-call' : 'real-call', content);
      if (scenario === 'conflicting-call') result.message.source.callId = 'other-call';
      if (scenario === 'historical-replay') {
        const event = f.eventFor('tool/result', result);
        const replay = await f.coordinator.replaySources({ session: f.session });
        assert.equal(replay.blockedFromSeq, event.seq);
      } else await f.observe('tool/result', result);
      assert.ok(!(await f.hot()).some(row => row.kind === 'tool_result'));
      assert.ok((await f.gaps()).some(row => row.reason === 'hot_dependency_scan_incomplete'));
    });
  }
});

test('unconsumed preview proofs are bounded and the latest result remains traceable', async t => {
  const f = await fixture(t);
  await f.begin(1);
  const first = await f.preview('first-call');
  let latest;
  for (let i = 0; i < 8; i++) latest = await f.preview('call-' + i);
  await f.observe('tool/result', f.data(1, 'call-7', latest));
  await f.observe('tool/result', f.data(1, 'first-call', first));
  assert.equal((await f.hot()).filter(row => row.kind === 'tool_result').length, 1);
  assert.ok((await f.gaps()).some(row => row.reason === 'hot_dependency_scan_incomplete'));
});

test('a delayed result after turn end cannot create or use a new turn’s proof', async t => {
  const f = await fixture(t);
  await f.begin(1);
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  f.coordinator.platformPort = () => { started.resolve(); return release.promise; };
  const late = f.preview('shared-call');
  await started.promise;
  await f.observe('turn/end', { turn: 1 });
  release.resolve(f.full);
  const oldPage = await late;
  await f.begin(2);
  const newPage = await f.preview('shared-call');
  assert.deepEqual(oldPage, newPage, 'the exact same call ID and bytes still cannot cross turns');
  await f.observe('tool/result', f.data(1, 'shared-call', oldPage));
  assert.ok((await f.gaps()).some(row => row.reason === 'hot_dependency_scan_incomplete'));
  await f.observe('tool/result', f.data(2, 'shared-call', newPage));
  assert.equal((await f.hot()).filter(row => row.kind === 'tool_result').length, 1);
});

test('the next pre-step drains the preceding native result before rotating proof storage', async t => {
  const f = await fixture(t);
  await f.begin(1);
  const page = await f.preview('last-call');
  await Promise.all([
    f.observe('tool/result', f.data(1, 'last-call', page)),
    f.observe('turn/end', { turn: 1 }),
    f.observe('turn/start', { turn: 2 }),
    f.preStep(2),
  ]);
  assert.equal((await f.hot()).find(row => row.kind === 'tool_result')?.content.mode, 'host_trace');
  assert.deepEqual(await f.gaps(), []);
});

async function archivedPlatformTurn(f, { damage } = {}) {
  const serialized = JSON.stringify(f.full);
  const points = Array.from(serialized), split = 500;
  const hash = text => createHash('sha256').update(text).digest('base64url');
  const sortedArgs = { action: platformArgs.action, capability: platformArgs.capability, platform: platformArgs.platform };
  const cursor = Buffer.from(JSON.stringify({ v: 1, t: 'persona_platform', q: hash(JSON.stringify(sortedArgs)), s: hash(serialized), i: 0, o: split })).toString('base64url');
  const page = (from, to, nextCursor) => [{ type: 'text', text: JSON.stringify({ status: 'bounded_preview', detailRef: { tool: 'persona_platform' },
    preview: { format: 'json_text_fragment', text: points.slice(from, to).join(''), fragment: { from, to, total: points.length, complete: nextCursor === null } }, nextCursor }) }];
  await f.begin(1);
  await f.observe('tool/call', { turn: 1, step: 1, callId: 'archive-1', name: 'persona_platform', arguments: JSON.stringify(sortedArgs) });
  await f.observe('tool/result', { ...f.data(1, 'archive-1', page(0, split, cursor)), step: 1 });
  if (damage !== 'missing-page') {
    const continuation = page(split, points.length, null);
    let nextCursor = cursor;
    if (damage === 'wrong-query') {
      const fields = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      nextCursor = Buffer.from(JSON.stringify({ ...fields, q: hash('{}') })).toString('base64url');
    }
    if (damage === 'changed-text') {
      const value = JSON.parse(continuation[0].text);
      const originalText = value.preview.text;
      value.preview.text = originalText.replace('资料', '材料');
      assert.notEqual(value.preview.text, originalText);
      assert.equal(value.preview.text.length, originalText.length);
      continuation[0].text = JSON.stringify(value);
    }
    await f.observe('tool/call', { turn: 1, step: 2, callId: 'archive-2', name: 'persona_platform', arguments: JSON.stringify({ ...sortedArgs, cursor: nextCursor }) });
    await f.observe('tool/result', { ...f.data(1, 'archive-2', continuation), step: 2 });
  }
  await f.observe('assistant/message', { turn: 1, message: { id: 'archived-thought', role: 'assistant', source: { kind: 'model' },
    content: [{ type: 'reasoning', text: '根据历史平台结果思考。' }] } });
  await f.observe('turn/end', { turn: 1 });
  f.coordinator.platformPort = () => { throw new Error('Archive repair must never execute a platform operation'); };
  return () => f.coordinator.executeCommand('backfill', { sessionId: f.session.id, repairPlatformHistory: true });
}

test('explicit historical repair verifies retained pages, preserves original traces and retries after interruption', async t => {
  const f = await fixture(t);
  const repair = await archivedPlatformTurn(f);
  const before = await f.gaps();
  assert.equal(before.length, 3);
  const repository = f.coordinator.repository;
  const capture = repository.captureHot.bind(repository);
  let attempts = 0;
  repository.captureHot = record => ++attempts === 2 ? Promise.reject(new Error('interrupted capture')) : capture(record);
  await assert.rejects(repair(), /interrupted capture/);
  assert.equal((await f.gaps()).length, 2);
  repository.captureHot = capture;

  const commit = repository.store.transaction.bind(repository.store);
  repository.store.transaction = transaction => transaction.json?.['host-checkpoints.json'] ? Promise.reject(new Error('interrupted checkpoint')) : commit(transaction);
  await assert.rejects(repair(), /interrupted checkpoint/);
  assert.deepEqual(await f.gaps(), []);
  repository.store.transaction = commit;
  assert.deepEqual(await repair(), { resolved: 0, remaining: 0, blockedFromSeq: null });
  assert.deepEqual(await repair(), { resolved: 0, remaining: 0, blockedFromSeq: null });

  const rows = await f.hot();
  const toolRows = rows.filter(row => row.kind === 'tool_result');
  assert.equal(toolRows.length, 2);
  for (const row of toolRows) {
    assert.equal(row.content.mode, 'host_trace');
    assert.deepEqual(row.dependencyRecordIds, [f.original.record.id]);
    const trace = await f.coordinator.runtime.host.readTrace(row.content.locator);
    assert.equal(JSON.parse(trace.text).message.content[0].text.includes('bounded_preview'), true);
  }
  assert.ok((await f.forget()).affectedIds.includes(f.original.record.id));
  assert.ok(!(await f.hot()).some(row => ['tool_result', 'reasoning'].includes(row.kind)));
});

test('historical repair preserves gaps and checkpoints when evidence cannot be verified', async t => {
  for (const damage of ['missing-page', 'wrong-query', 'changed-text']) {
    await t.test(damage, async t => {
      const f = await fixture(t);
      const repair = await archivedPlatformTurn(f, { damage });
      const before = await f.gaps();
      const checkpoint = await f.coordinator.repository.store.readJson('host-checkpoints.json');
      await assert.rejects(repair(), { code: 'HISTORICAL_PLATFORM_RESULT_UNVERIFIED' });
      assert.deepEqual(await f.gaps(), before);
      assert.deepEqual(await f.coordinator.repository.store.readJson('host-checkpoints.json'), checkpoint);
      assert.ok(!(await f.hot()).some(row => ['tool_result', 'reasoning'].includes(row.kind)));
    });
  }
});
