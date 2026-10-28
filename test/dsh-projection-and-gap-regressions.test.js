import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshCoordinator } from '../adapters/dsh/index.js';
import { mountCompanionScope } from '../adapters/dsh/companion-scope.js';
import { projectExternalOutput } from '../adapters/dsh/external-output.js';

async function fixture(t, ids = ['projection-first', 'projection-second'], config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'xiangxu-projection-replay-'));
  const handlers = new Map(), scoped = new Map(), agents = new Map(), events = [], cleanups = [];
  const query = { readSession: async () => ({ events }) };
  const ctx = { agents: { get: id => agents.get(id), list: () => [] }, llm: {},
    get: key => key === 'sessionQuery' ? query : key === 'agentPresets' ? { composedPreset: () => 'persona-memory' } : undefined,
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); }, effect: run => cleanups.push(run()) };
  const coordinator = createDshCoordinator(ctx, { memoryRoot: root, operatorControl: false, ...config });
  await coordinator.ready;
  mountCompanionScope(ctx, { getCoordinator: () => coordinator, attachAgent: agent => coordinator.attachAgent(agent) });
  for (const id of ids) {
    const local = new Map(), agent = { id, session: { id, header: { agentPreset: 'persona-memory' }, deriveMessages: () => [] },
      inbox: { nextTurn: [], nextStep: [] }, followup() {}, ctx: {
        on(name, handler) { local.set(name, handler); return () => local.delete(name); },
        tools: { restrict: () => () => {}, register: () => () => {}, wireSchemas: () => ({ schemas: [] }) },
      } };
    agents.set(id, agent); scoped.set(id, local); await handlers.get('agent/created')({ agent });
  }
  t.after(async () => { for (const cleanup of cleanups) await cleanup?.(); await coordinator.close(); await rm(root, { recursive: true, force: true }); });
  const assemble = async (id, signal, sections = []) => {
    const agent = agents.get(id), context = { agent, scope: agent.ctx, signal }, value = { sections, tools: [] };
    return handlers.get('system-prompt/assemble')(value, context,
      () => scoped.get(id).get('system-prompt/assemble')(value, context, async () => value));
  };
  return { coordinator, handlers, scoped, agents, events, assemble };
}

const externalId = 'xiangxu-social-abcdef0123456789';
const externalFacts = { platform:'qq', accountId:'100', conversation:{id:'200',type:'private'}, sender:{id:'200',name:'test'} };
const uiReply = '我选好了。\n```dsh-ui\n' + JSON.stringify({title:'资料卡草案',items:[{type:'keyvalue',pairs:[{key:'昵称',value:'相续'}]},{type:'callout',content:'等待实际平台结果'}]}) + '\n```';
const finalEvent = (text = uiReply) => ({type:'assistant/message',seq:7,time:Date.now(),data:{turn:1,message:{id:'card-final',role:'assistant',content:[{type:'text',text}]}}});

test('external channels omit only the named desktop UI prompt and declare actual text presentation', async t => {
  const f=await fixture(t,[externalId,'desktop']); await f.coordinator.registerExternalChannel(externalId,externalFacts);
  const sections=[{name:'genui:fence',text:'DESKTOP_CARD_PROMPT'},{name:'unrelated:ui',text:'KEEP_OTHER_PROMPT'}];
  const external=await f.assemble(externalId,new AbortController().signal,sections),desktop=await f.assemble('desktop',new AbortController().signal,sections);
  assert(!external.sections.some(section=>section.name==='genui:fence')); assert(external.sections.some(section=>section.name==='unrelated:ui'));
  assert(desktop.sections.some(section=>section.name==='genui:fence'));
  assert(external.sections.some(section=>section.name==='persona-memory:channel-output'&&section.text.includes('dsh-ui')&&section.text.includes('不可渲染')));
  assert(!desktop.sections.some(section=>section.name==='persona-memory:channel-output'));
  assert.deepEqual(f.coordinator.contextFor(f.agents.get(externalId)).environment.outputCapabilities,{text:true,dshUi:false});
});

test('external delivery, accepted dialogue and delivery ack use the same presented text while the raw host card remains process material', async t => {
  const f=await fixture(t,[externalId]); await f.coordinator.registerExternalChannel(externalId,externalFacts);
  const projected=projectExternalOutput(uiReply),accepted=[],acks=[],accept=f.coordinator.runtime.accept.bind(f.coordinator.runtime);
  f.coordinator.externalDelivery={output:async args=>{assert.equal(args.text,uiReply);return{status:'delivered',receiptId:'platform:one',textHash:projected.deliveryTextHash,sourceTextHash:projected.sourceTextHash,formatVersion:projected.formatVersion,text:projected.text};}};
  f.coordinator.runtime.accept=async(...args)=>{accepted.push(args[0]);return accept(...args);};
  f.coordinator.runtime.acknowledgeDelivery=async(...args)=>{acks.push(args);return{status:'delivered'};};
  f.coordinator.agents.get(externalId).activeByTurn.set(1,{deliveryId:'planned-output'});
  await f.coordinator.observeEvent(f.agents.get(externalId).session,finalEvent());
  assert.equal(accepted.at(-1).text,projected.text); assert.equal(acks.at(-1)[1].text,projected.text);
  const material=await f.coordinator.repository.store.readLines('staging/hot.jsonl');
  const original=material.find(record=>record.kind==='plugin_state'&&record.content?.text?.includes('host_output_before_transport_projection'));
  assert(original); assert(JSON.parse(original.content.text).text.includes('dsh-ui'));
});

test('an inconsistent external projection receipt does not become remembered speech or a delivered ack', async t => {
  const f=await fixture(t,[externalId]); await f.coordinator.registerExternalChannel(externalId,externalFacts); let accepts=0;const acks=[];
  f.coordinator.externalDelivery={output:async()=>({status:'delivered',receiptId:'unverified',textHash:'0'.repeat(64),sourceTextHash:'1'.repeat(64),formatVersion:'dsh-plain/1'})};
  f.coordinator.runtime.accept=async()=>{accepts++;return{gap:false};};f.coordinator.runtime.acknowledgeDelivery=async(_id,value)=>acks.push(value);
  f.coordinator.agents.get(externalId).activeByTurn.set(1,{deliveryId:'planned-output'});
  await f.coordinator.observeEvent(f.agents.get(externalId).session,finalEvent());
  assert.equal(accepts,0);assert.equal(acks[0].status,'unknown');assert.equal(acks[0].code,'CHANNEL_OUTPUT_PROJECTION_MISMATCH');
});

test('restart reconciliation recovers the delivered projection and keeps legacy raw receipts unchanged', async t => {
  const f=await fixture(t,[externalId]);await f.coordinator.registerExternalChannel(externalId,externalFacts);
  const event=finalEvent(),p=projectExternalOutput(uiReply);f.events.push(event);
  let stored={status:'delivered',sourceEventId:'card-final',seq:7,textHash:p.deliveryTextHash,sourceTextHash:p.sourceTextHash,formatVersion:p.formatVersion};
  f.coordinator.externalDelivery={reconcile:async()=>stored};
  const record={target:{sessionId:externalId,channelId:'dsh:'+externalId,personId:null},sourceEventId:'card-final'};
  assert.equal((await f.coordinator.runtime.host.reconcileDelivery(record)).text,p.text);
  stored={status:'delivered',sourceEventId:'card-final',seq:7,textHash:p.sourceTextHash};
  assert.equal((await f.coordinator.runtime.host.reconcileDelivery(record)).text,uiReply);
  stored={...stored,textHash:'0'.repeat(64)};
  assert.equal((await f.coordinator.runtime.host.reconcileDelivery(record)).status,'unknown');
});

for (const limitedBy of ['single-record','combined-cache']) test(`rendered external replies keep their original host trace readable when limited by ${limitedBy}`, async t => {
  const f=await fixture(t,[externalId],{tempTargetChars:limitedBy==='single-record'?100:1000});
  await f.coordinator.registerExternalChannel(externalId,externalFacts);
  if(limitedBy==='combined-cache') {
    const prefill={type:'tool/result',seq:6,time:Date.now(),data:{turn:1,message:{id:'prefill',role:'tool',content:[{type:'text',text:'P'.repeat(700)}]}}};
    f.events.push(prefill);await f.coordinator.observeEvent(f.agents.get(externalId).session,prefill);
  }
  const raw='A'.repeat(300)+'\n```dsh-ui\n'+JSON.stringify({title:'card',items:[{type:'text',content:'visible'}]})+'\n```',event=finalEvent(raw),p=projectExternalOutput(raw);
  f.events.push(event);f.coordinator.externalDelivery={output:async()=>({status:'delivered',formatVersion:p.formatVersion,sourceTextHash:p.sourceTextHash,textHash:p.deliveryTextHash,text:p.text})};
  await f.coordinator.observeEvent(f.agents.get(externalId).session,event);
  const hot=(await f.coordinator.repository.store.readLines('staging/hot.jsonl')).find(record=>record.sourceRef?.sourceEventId==='card-final');
  assert.equal(hot.kind,'plugin_state');assert.equal(hot.content.mode,'host_trace');
  const retained=await f.coordinator.runtime.host.readTrace(hot.content.locator,{maxChars:2000});
  assert.equal(retained.available,true);assert.equal(retained.text,raw);
});

test('the outer companion assembly retains the exact request signal for its final refreshed projection', async t => {
  const f = await fixture(t), compose = f.coordinator.runtime.compose.bind(f.coordinator.runtime);
  let revision = 0;
  f.coordinator.runtime.compose = async (...args) => {
    const snapshot = await compose(...args);
    return { ...snapshot, injectedText: snapshot.injectedText + '\nFIXTURE_ASSEMBLY_REVISION_' + ++revision };
  };
  const firstSignal = new AbortController().signal, secondSignal = new AbortController().signal, otherSignal = new AbortController().signal;
  const first = await f.assemble('projection-first', firstSignal), second = await f.assemble('projection-first', secondSignal), other = await f.assemble('projection-second', otherSignal);
  assert.equal(revision, 6, 'the real two-layer waterfall refreshes twice per assembly');
  const request = (id, signal, assembly) => ({ sessionId: id, signal, messages: [{ role: 'system', content: assembly.sections.map(row => row.text).join('\n') }] });
  const guard = f.handlers.get('llm/stream'); let calls = 0;
  assert.equal(guard(request('projection-first', firstSignal, first), () => ++calls), 1);
  assert.equal(guard(request('projection-first', secondSignal, second), () => ++calls), 2);
  assert.equal(guard(request('projection-second', otherSignal, other), () => ++calls), 3);
  assert.throws(() => guard(request('projection-first', secondSignal, first), () => ++calls), { code: 'PERSONA_CONTEXT_UNAVAILABLE', projectionFailure: 'live_missing' });
  assert.throws(() => guard(request('projection-first', new AbortController().signal, second), () => ++calls), { code: 'PERSONA_CONTEXT_UNAVAILABLE', projectionFailure: 'projection_lookup_missing' });
  assert.equal(calls, 3);
});

test('only the host compaction purpose can reuse a historical prefix without the native reply projection', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  const assembly = await f.assemble('projection-first', signal);
  const guard = f.handlers.get('llm/stream'); let calls = 0;
  const historical = { sessionId: 'projection-first', signal,
    messages: [{ role: 'system', content: 'Historical system prefix retained by the host compactor' }] };
  const next = () => ++calls;
  assert.equal(guard({ ...historical, purpose: 'compaction' }, next), 1);
  // Manual compaction has its own cancellation signal and no prompt assembly.
  assert.equal(guard({ ...historical, signal: new AbortController().signal, purpose: 'compaction' }, next), 2);
  assert.throws(() => guard(historical, next), { code: 'PERSONA_CONTEXT_UNAVAILABLE', projectionFailure: 'protocol_missing' });
  for (const purpose of ['native_turn', 'reply', 'consolidation', 'Compaction', '', null]) {
    assert.throws(() => guard({ ...historical, purpose }, next), { code: 'PERSONA_CONTEXT_UNAVAILABLE', projectionFailure: 'protocol_missing' });
  }
  assert.throws(() => guard({ ...historical, signal: new AbortController().signal }, next),
    { code: 'PERSONA_CONTEXT_UNAVAILABLE', projectionFailure: 'projection_lookup_missing' });
  assert.equal(guard({ sessionId: 'projection-first', signal,
    messages: [{ role: 'system', content: assembly.sections.map(row => row.text).join('\n') }] }, next), 3);
  assert.equal(calls, 3, 'failed native and unknown purposes never reach the provider');
});

test('a fully recovered native tool-result event resolves its prior memory gap by stable event cursor', async t => {
  const f = await fixture(t), agent = f.agents.get('projection-first'), repository = f.coordinator.repository;
  const event = { type: 'tool/result', seq: 7, time: Date.now(), data: { turn: 1, message: { id: 'native-tool-envelope-id', role: 'tool', source: { kind: 'tool' }, content: [{ type: 'text', text: '{"status":"fixture-ok"}' }] } } };
  f.events.push(event);
  const capture = repository.captureHot.bind(repository);
  repository.captureHot = input => capture({ ...input, dependencyScanComplete: false });
  await f.coordinator.observeEvent(agent.session, event);
  assert.equal((await repository.getRuntime()).memoryGaps.filter(row => row.resolvedAt == null).length, 1);
  repository.captureHot = capture;
  const replay = await f.coordinator.replaySources(agent);
  assert.equal(replay.blockedFromSeq, null);
  const gaps = (await repository.getRuntime()).memoryGaps;
  assert.equal(gaps.length, 1); assert.ok(gaps[0].resolvedAt != null); assert.equal(gaps[0].resolvedSourceCursor, '7');
  const hot = await repository.store.readLines('staging/hot.jsonl');
  assert.ok(hot.some(row => row.sourceRef.sourceEventId === '7' && row.kind === 'tool_result'));
});

test('a tool-result replay that is still incomplete cannot clear a memory gap or advance its blocked cursor', async t => {
  const f = await fixture(t), agent = f.agents.get('projection-first'), repository = f.coordinator.repository;
  const event = { type: 'tool/result', seq: 8, time: Date.now(), data: { turn: 1, message: { id: 'still-incomplete-tool', role: 'tool', source: { kind: 'tool' }, content: [{ type: 'text', text: 'fixture body' }] } } };
  f.events.push(event);
  const capture = repository.captureHot.bind(repository);
  repository.captureHot = input => capture({ ...input, dependencyScanComplete: false });
  await f.coordinator.observeEvent(agent.session, event);
  const replay = await f.coordinator.replaySources(agent);
  assert.equal(replay.blockedFromSeq, 8);
  const gaps = (await repository.getRuntime()).memoryGaps;
  assert.ok(gaps.length > 0); assert.ok(gaps.every(row => row.resolvedAt == null));
});

test('an unsupported event or an uncaptured tool result cannot resolve a gap solely because its cursor matches', async t => {
  const f = await fixture(t), agent = f.agents.get('projection-first'), repository = f.coordinator.repository;
  await repository.captureHot({ sourceSessionId: agent.session.id, sourceEventId: '9', sourceCursor: 9,
    kind: 'tool_result', sourceKind: 'tool/result', content: { mode: 'cached', text: 'fixture unavailable process', chars: 27 },
    dependencyScanComplete: false, hostAvailable: true });
  await f.coordinator.observeEvent(agent.session, { type: 'unsupported-fixture-event', seq: 9, data: {} });
  assert.ok((await repository.getRuntime()).memoryGaps.every(row => row.resolvedAt == null));
  const capture = repository.captureHot;
  repository.captureHot = async () => ({ duplicate: true, revoked: true, record: null, eventId: null });
  try {
    await f.coordinator.observeEvent(agent.session, { type: 'tool/result', seq: 9, data: { turn: 1, message: {
      id: 'uncaptured-tool', role: 'tool', source: { kind: 'tool' }, content: [{ type: 'text', text: 'fixture body' }] } } });
    assert.ok((await repository.getRuntime()).memoryGaps.every(row => row.resolvedAt == null));
  } finally { repository.captureHot = capture; }
});
