import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshCoordinator } from '../adapters/dsh/index.js';
import { renderExternalMessageTextBlocks } from '../adapters/dsh/channels/native.js';
import { projectExternalOutput, projectSocialReply } from '../adapters/dsh/external-output.js';
import { groupReplyAddressEvidence } from '../adapters/dsh/social-dialogue.js';

const groupId = 'xiangxu-social-' + 'c'.repeat(32), privateId = 'xiangxu-social-' + 'd'.repeat(32);
const facts = type => ({ platform: 'qq', accountId: '100', conversation: { type, id: '200' }, sender: { id: '11', name: '发言者' } });
const final = messages => '```xiangxu-social\n' + JSON.stringify({ understanding: { addressee: 'uncertain', reference: '陌生称呼' }, participation: 'join', messages }) + '\n```';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xiangxu-social-contract-')), agents = new Map(), globals = new Map(), requests = [];
  const ctx = { agents: { get: id => agents.get(id)?.agent, list: () => [] },
    on(name, handler) { globals.set(name, handler); return () => globals.delete(name); },
    llm: { async *stream(request) { requests.push(request); yield { type: 'block-end', index: 0, block: { type: 'text', text: final(['固定草稿']) } }; yield { type: 'finish', reason: { kind: 'stop' } }; } },
    get: key => key === 'agentPresets' ? { composedPreset: () => 'persona-memory' } : undefined };
  const c = createDshCoordinator(ctx, { memoryRoot: root, operatorControl: false, provider: 'fixture-local', model: 'fixed-only', timezone: 'Asia/Shanghai' });
  await c.ready;
  for (const [id, type] of [[groupId, 'group'], [privateId, 'private']]) {
    const handlers = new Map(), history = [], agent = { id, inbox: { nextTurn: [], nextStep: [] },
      session: { id, header: {}, deriveMessages: () => history, requestHeader: () => ({ config: { provider: 'fixture-local', model: 'fixed-only' } }) },
      ctx: { on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); },
        tools: { restrict: () => () => {}, register: () => () => {} } } };
    agents.set(id, { agent, handlers, history }); await c.registerExternalChannel(id, facts(type)); await c.attachAgent(agent);
  }
  t.after(async () => { await c.close(); await rm(root, { recursive: true, force: true }); });
  const assemble = (id, signal = new AbortController().signal) => c.preparePersonaAssembly(agents.get(id).agent, { sections: [] }, { signal });
  return { c, agents, requests, globals, assemble };
}
function incoming(id, type = 'group', version = true) {
  const originalText = '陌生称呼在吗？', groupContext = { platformMessageId: '123', sender: { platformUserId: '11', displayName: '发言者' }, connectedAccountId: '100', explicitlyMentionsConnectedAccount: false, observedNameMatches: [], observationCoverage: { completeGroupRoster: false } };
  const structured = type === 'group' ? { originalText, groupContext, ...(version ? { groupPresentation: 'xiangxu-group-scene/1' } : {}) } : null;
  return { id, role: 'user', source: { kind: 'user', xiangxuChannel: facts(type), platformMessageId: '123',
    ...(structured ? { xiangxuStructured: structured } : {}) }, content: renderExternalMessageTextBlocks(structured ?? { originalText }).map(text => ({ type: 'text', text })) };
}

test('new and retained legacy group sources admit their exact originals while plain inputs expose a real platform message ID', async t => {
  const f = await fixture(t), scope = f.agents.get(groupId);
  for (const [index, version] of [false, true].entries()) {
    const message = incoming('source-' + index, 'group', version), before = JSON.stringify(message);
    const entered = await scope.handlers.get('agent/pre-step')({ messages: [message], turn: index + 1 }, async () => ({ kind: 'enter', messages: [message] }));
    assert.equal(entered.kind, 'enter'); assert.equal(JSON.stringify(message), before);
    const state = f.c.agents.get(groupId);
    assert.equal(state.presentedSourcesByTurn.get(index + 1).some(record => record.sourceEventId === message.id), true);
  }
  const plain = incoming('plain', 'private'); await f.c.observeEvent(f.agents.get(privateId).agent.session, { type: 'user/message', seq: 1, data: plain });
  const environment = f.c.contextFor(f.agents.get(privateId).agent).environment;
  assert.equal(environment.externalInput.platformMessageId, '123'); assert.equal(environment.externalInput.structured, undefined);
  const presented = (await f.assemble(privateId)).sections.find(section => section.name === 'persona-memory:channel-output').text;
  const identity = JSON.parse(presented.split('[conversation_identity_reference]\n')[1].split('\n')[0]);
  assert.equal(identity.inputSource.platformMessageId, '123', 'ID must be visible text, not only native source metadata or optional environment details');
  const records = (await f.c.repository.getContext({ personId: null })).records;
  assert.equal(records.filter(record => record.role === 'user').every(record => record.text === '陌生称呼在吗？'), true);
});

test('private request keeps previous media as history and attributes new media and references to their own accepted input', async t => {
  const f = await fixture(t), scope = f.agents.get(privateId);
  const message = (platformMessageId, originalText, { sourceAt, rich, unsupportedSegments = [] } = {}) => {
    const structured = rich ? { originalText, rich: { hasStructuredContent: true, ...rich } } : undefined;
    return { id: 'private-input-' + platformMessageId, role: 'user', source: { kind: 'user', xiangxuChannel: facts('private'),
      platformMessageId, platformSourceAt: sourceAt, textComplete: unsupportedSegments.length === 0, unsupportedSegments,
      ...(structured ? { xiangxuStructured: structured } : {}) },
    content: renderExternalMessageTextBlocks(structured ?? { originalText }).map(text => ({ type: 'text', text })) };
  };
  const earlier = message('101', '看看刚才这张图', { unsupportedSegments: ['image'],
    rich: { media: [{ kind: 'image', status: 'not_attached', reason: 'incoming_media_capacity' }] } });
  const current = message('102', '刚回来，你在么？', { sourceAt: Date.parse('2026-11-10T12:34:56Z') });
  const quoted = message('103', '我问的是之前那张图', { rich: { replies: [{ messageId: '101' }] } });
  const expectedObservations = (textComplete, structuredMediaCount, structuredReplyCount, unsupportedSegmentTypeCount = 0) =>
    ({ textComplete, structuredMediaCount, structuredReplyCount, unsupportedSegmentTypeCount });
  const original = JSON.stringify([earlier, current, quoted]);
  for (const [offset, input] of [earlier, current, quoted].entries()) {
    const turn = offset + 1, signal = new AbortController().signal;
    const entered = await scope.handlers.get('agent/pre-step')({ messages: [input], turn }, async () => ({ kind: 'enter', messages: [input] }));
    assert.equal(entered.kind, 'enter'); assert.equal(entered.messages[0], input);
    const { sections } = await f.assemble(privateId, signal);
    const system = sections.map(section => section.text).join('\n\n');
    const { inputSource } = JSON.parse(system.split('[conversation_identity_reference]\n')[1].split('\n')[0]);
    assert.equal(inputSource.platformMessageId, input.source.platformMessageId);
    assert.equal(inputSource.source, 'accepted_platform_input');
    assert.deepEqual(inputSource.observations, [
      expectedObservations(false, 1, 0, 1),
      expectedObservations(true, 0, 0),
      expectedObservations(true, 0, 1),
    ][offset]);
    if (input === current) {
      assert.equal(inputSource.sourceAtLocal, '2026-11-10T20:34:56+08:00');
      assert.doesNotMatch(system, /incoming_media_capacity/);
      assert.match(system, /平台处理状态对应各自的来信/);
    } else assert.equal(Object.hasOwn(inputSource, 'sourceAt'), false);
    const messages = [{ role: 'system', content: system }, ...scope.history, input];
    for await (const _ of f.globals.get('llm/stream')({ sessionId: privateId, signal, messages }, () => assert.fail('private expression should own this stream'))) {}
    assert.equal(f.requests.at(-1).messages.at(-1), input);
    scope.history.push(input);
  }
  assert.equal(JSON.stringify(scope.history), original);
  assert.match(scope.history[0].content[1].text, /incoming_media_capacity/);
  assert.match(scope.history[2].content[1].text, /"messageId":"101"/);
  assert.equal(f.requests.length, 3);
});

test('group scene contract follows remembered material, stays out of private chat, and is checked at the native stream boundary', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  const assembled = await f.assemble(groupId, signal), sections = assembled.sections;
  assert.equal(sections.at(-1).name, 'persona-memory:social-dialogue');
  assert.match(sections.at(-1).text, /xiangxu-social/); assert.match(sections.at(-1).text, /uncertain/);
  assert(!sections.some(section => section.name === 'persona-memory:qq-private-short-chat'));
  assert(!sections.find(section => section.name === 'persona-memory:channel-output').text.includes('普通文字发成一条'));
  assert(!(await f.assemble(privateId)).sections.some(section => section.name === 'persona-memory:social-dialogue'));
  const stream = f.globals.get('llm/stream'), options = { sessionId: groupId, signal, messages: [{ role: 'system', content: [{ type: 'text', text: sections.map(section => section.text).join('\n\n') }] }] };
  const sentinel = {}; assert.equal(stream(options, () => sentinel), sentinel);
  const missing = sections.slice(0, -1).map(section => section.text).join('\n\n');
  assert.throws(() => stream({ ...options, messages: [{ role: 'system', content: [{ type: 'text', text: missing }] }] }, () => sentinel), error => error.projectionFailure === 'social_dialogue_missing');
  assert.equal(f.requests.length, 0, 'projection validation never dispatches a model');
});

test('QQ private short chat ends the assembled system prompt without spotlighting older equal text', async t => {
  const f = await fixture(t), scope = f.agents.get(privateId);
  const beforeAt = Date.parse('2026-11-10T01:11:36Z'), elapsedMs = 5 * 3600_000;
  const makeInput = (id, platformMessageId, at) => ({ id, role: 'user',
    source: { kind: 'user', xiangxuChannel: facts('private'), platformMessageId, platformSourceAt: at, textComplete: true },
    content: [{ type: 'text', text: '刚回来，你在么？' }] });
  const prior = makeInput('earlier', '101', beforeAt), current = makeInput('now', '102', beforeAt + elapsedMs);
  scope.history.push(prior, current);
  const saved = JSON.stringify(scope.history);
  await f.c.observeEvent(scope.agent.session, { type: 'user/message', seq: 3, data: current });
  scope.handlers.get('agent/inbox/claimed')({ message: current, turn: 1 });
  const signal = new AbortController().signal;
  const { sections, contexts } = await f.assemble(privateId, signal);
  const output = sections.find(section => section.name === 'persona-memory:channel-output').text;
  const reference = JSON.parse(output.split('[conversation_identity_reference]\n')[1].split('\n')[0]);
  assert.equal(reference.inputSource.platformMessageId, '102');
  assert.equal(reference.inputSource.sourceAt, beforeAt + elapsedMs);
  assert.equal(reference.inputSource.earlierSameText, undefined);
  const shortChat = sections.at(-1);
  assert.equal(shortChat.name, 'persona-memory:qq-private-short-chat');
  assert.equal(sections.at(-2).name, 'persona-memory:live');
  assert.match(shortChat.text, /已经说到点上就可以收住/);
  assert.match(shortChat.text, /长短和段落都按当下这段对话自己选/);
  assert.match(shortChat.text, /xiangxu-qq/);
  assert.doesNotMatch(shortChat.text, /刚回来，你在么/);
  assert.doesNotMatch(shortChat.text, /qq_private_current_exchange/);
  assert.equal(contexts.at(-1).name, 'persona-memory:qq-private-exchange');
  const focus = JSON.parse(contexts.at(-1).text.split('[qq_private_current_exchange]\n')[1]);
  assert.deepEqual(focus.sources, [{ sourceEventId: 'now', platformMessageId: '102' }]);
  const environment = JSON.parse(sections.at(-2).text.split('[environment]\n')[1].split('\n')[0]);
  assert.deepEqual(environment.delivery, { available: true, details: 'persona_introspect section:state' });
  const stream = f.globals.get('llm/stream');
  const call = input => stream({ sessionId: privateId, signal, messages: [{ role: 'system',
    content: [{ type: 'text', text: input.map(section => section.text).join('\n\n') }] }, prior, current] }, () => assert.fail('private expression should own this stream'));
  for await (const _ of call(sections)) { /* consume the actual private request */ }
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].xiangxuPrivateExpression, true);
  assert.deepEqual(f.requests[0].messages.slice(-2), [prior, current]);
  for (const wrong of [sections.slice(0, -1), [shortChat, ...sections.slice(0, -1)]]) {
    assert.throws(() => call(wrong), error => error.projectionFailure === 'qq_short_chat_missing_or_misplaced');
  }
  assert.equal(JSON.stringify(scope.history), saved);
  await f.c.observeEvent(scope.agent.session, { type: 'turn/end', seq: 4, data: { turn: 1 } });
  assert.deepEqual((await f.assemble(privateId)).contexts, []);
});

test('same-personality auxiliary group drafts receive the same scene contract; private and control calls are unchanged', async t => {
  const f = await fixture(t);
  const input = { messages: [{ role: 'system', content: '既有上下文' }], context: { sessionId: groupId } };
  const reply = await f.c.runtime.model.complete({ ...input, purpose: 'reply' });
  assert.match(reply.text, /xiangxu-social/);
  const contextual = f.requests[0].messages.find(message => message.source?.kind === 'persona-memory:auxiliary-group-context');
  assert(contextual); assert.match(contextual.content[0].text, /current_group_observation/);
  assert.match(contextual.content[0].text, /"groupId":"200"/);
  await f.c.runtime.model.complete({ ...input, purpose: 'reply', context: { sessionId: privateId } });
  assert.equal(f.requests[1].messages.length, 1);
  assert.equal(f.requests[0].provider, 'fixture-local'); assert.equal(f.requests.length, 2, 'no separate planner call is introduced');
});

test('native group final sends the same envelope once and remembers only confirmed body text, not its interpretation', async t => {
  const f = await fixture(t), scope = f.agents.get(groupId), message = incoming('incoming-final');
  await scope.handlers.get('agent/pre-step')({ messages: [message], turn: 1 }, async () => ({ kind: 'enter', messages: [message] }));
  const scene = (await f.assemble(groupId)).sections.at(-1).text.split('[current_group_observation]\n').at(-1);
  assert.deepEqual(JSON.parse(scene).selfAddressEvidence, { sourceEventId: message.id, direct: false, namesInCurrentSource: [] });
  const text = final(['接话正文。']), projected = projectSocialReply(text); let sent;
  f.c.externalDelivery = { output: async args => { sent = args; return { status: 'delivered', receiptId: 'verified-platform-receipt',
    textHash: projected.deliveryTextHash, sourceTextHash: projected.sourceTextHash, formatVersion: projected.formatVersion }; } };
  await f.c.observeEvent(scope.agent.session, { type: 'assistant/message', seq: 3, time: Date.now(), data: { turn: 1,
    message: { id: 'native-social-final', role: 'assistant', content: [{ type: 'text', text }] } } });
  assert.equal(sent.outputContract, 'xiangxu-social/1'); assert.equal(sent.text, text);
  assert.deepEqual(sent.groupAddressEvidence, { sourceEventId: message.id, direct: false, names: [], presenceQuestion: { target: '陌生称呼', nameCue: false } });
  const record = (await f.c.repository.getContext({ personId: null })).records.find(record => record.sourceEventId === 'native-social-final');
  assert.equal(record.text, '接话正文。'); assert(!record.text.includes('understanding'));
  const hot = await f.c.repository.store.readLines('staging/hot.jsonl');
  assert(hot.some(record => record.kind === 'plugin_state' && record.content.text.includes('understanding')));
  assert.equal((await f.c.repository.getPending()).some(record => record.sourceEventId === message.id), false);
});

test('old self-answers and delivery receipts remain visible without corroborating the current group addressee', async t => {
  const f = await fixture(t), scope = f.agents.get(groupId);
  const first = incoming('older-summons'), current = incoming('current-summons');
  current.source.platformMessageId = '124';
  current.source.xiangxuStructured.groupContext.platformMessageId = '124';
  current.content = renderExternalMessageTextBlocks(current.source.xiangxuStructured).map(text => ({ type: 'text', text }));
  const oldReply = '在呀，一直在这儿。';
  const delivered = projectExternalOutput(oldReply);
  scope.history.push(first,
    { id: 'older-delivered', role: 'assistant', content: [{ type: 'text', text: oldReply }] },
    { id: 'older-unconfirmed', role: 'assistant', content: [{ type: 'text', text: '在的在的，听到你喊我呢。' }] });
  const original = JSON.stringify(scope.history);
  f.c.externalDelivery = { findOutboundReceipt: ({ sourceEventId }) => sourceEventId === 'older-delivered' ? {
    status: 'delivered', formatVersion: delivered.formatVersion, sourceTextHash: delivered.sourceTextHash,
    textHash: delivered.deliveryTextHash,
  } : null };
  await scope.handlers.get('agent/pre-step')({ messages: [current], turn: 1 }, async () => ({ kind: 'enter', messages: [current] }));
  const signal = new AbortController().signal;
  const { sections } = await f.assemble(groupId, signal);
  const system = sections.map(section => section.text).join('\n\n');
  const rows = JSON.parse(system.split('[近期 QQ 文字交付回执')[1].split('\n')[1]);
  assert.deepEqual(rows, [
    { sourceEventId: 'older-delivered', status: 'delivered', sourceRole: 'assistant', evidenceScope: 'delivery_only' },
    { sourceEventId: 'older-unconfirmed', status: 'unconfirmed', sourceRole: 'assistant', evidenceScope: 'delivery_only' },
  ]);
  const observation = JSON.parse(system.split('[current_group_observation]\n').at(-1));
  assert.equal(observation.currentSelfAddress, 'unresolved_from_current_source');
  assert.deepEqual(observation.selfAddressEvidence, { sourceEventId: current.id, direct: false, namesInCurrentSource: [] });
  const messages = [{ role: 'system', content: system }, ...scope.history, current];
  const sentinel = {};
  assert.equal(f.globals.get('llm/stream')({ sessionId: groupId, signal, messages }, () => sentinel), sentinel);
  assert.equal(JSON.stringify(messages.slice(1, -1)), original);
  assert.equal(JSON.stringify(scope.history), original);
});

test('group address evidence binds to the actual source and keeps names, mentions and quotes separate', () => {
  const message = incoming('address-proof');
  const group = facts('group');
  const structured = message.source.xiangxuStructured, observation = structured.groupContext;
  assert.deepEqual(groupReplyAddressEvidence(message, group, ''), { sourceEventId: message.id, direct: false, names: [], presenceQuestion: { target: '陌生称呼', nameCue: false } });
  observation.explicitlyMentionsConnectedAccount = true;
  assert.equal(groupReplyAddressEvidence(message, group, '').direct, true);
  observation.platformMessageId = 'older-source';
  assert.equal(groupReplyAddressEvidence(message, group, '').direct, false);
  assert.equal(groupReplyAddressEvidence(message, group, '').presenceQuestion, undefined);
  observation.platformMessageId = '123';
  observation.explicitlyMentionsConnectedAccount = false;
  observation.quoteLinks = [{ observedAuthorPlatformUserId: '100' }];
  assert.equal(groupReplyAddressEvidence(message, group, '').direct, false);
  observation.quoteLinks = [{ platformMessageId: '125', observedAuthorPlatformUserId: '100', confirmedAccountDelivery: true }];
  assert.equal(groupReplyAddressEvidence(message, group, '').direct, true);
  observation.quoteLinks = [{ observedAuthorPlatformUserId: '11' }];
  structured.originalText = '阿序在吗？';
  assert.deepEqual(groupReplyAddressEvidence(message, group, '阿序').names, ['阿序']);
  structured.originalText = '别叫阿序';
  assert.deepEqual(groupReplyAddressEvidence(message, group, '阿序').names, []);
  structured.originalText = '阿序在吗？';
  observation.observedNameMatches = [{ platformUserId: '22', observedDisplayName: '阿序' }];
  assert.deepEqual(groupReplyAddressEvidence(message, group, '阿序').names, []);
  assert.deepEqual(groupReplyAddressEvidence(message, group, '阿序').presenceQuestion, { target: '阿序', nameCue: true });
  structured.originalText = '熙熙熙熙在么';
  assert.deepEqual(groupReplyAddressEvidence(message, group, '').presenceQuestion, { target: '熙熙熙熙', nameCue: true });
  for (const original of ['有人在吗？', '大家在吗？', '大家都在吗？', '各位都还在吗？', '你还在么', '阿序\n在吗？']) {
    structured.originalText = original;
    assert.equal(groupReplyAddressEvidence(message, group, '').presenceQuestion, undefined, original);
  }
  structured.originalText = '熙熙熙熙在么';
  message.source.textComplete = false;
  assert.equal(groupReplyAddressEvidence(message, group, '').presenceQuestion, undefined);
});

test('a QQ group final cannot borrow an earlier admitted mention or a revoked input', async t => {
  const f = await fixture(t), scope = f.agents.get(groupId);
  const makeInput = (id, at) => {
    const message = incoming(id), source = message.source;
    source.platformMessageId = id;
    source.xiangxuStructured.groupContext.platformMessageId = id;
    source.xiangxuStructured.groupContext.explicitlyMentionsConnectedAccount = at;
    message.content = renderExternalMessageTextBlocks(source.xiangxuStructured).map(text => ({ type: 'text', text }));
    return message;
  };
  const admit = (messages, turn) => scope.handlers.get('agent/pre-step')({ messages, turn }, async () => ({ kind: 'enter', messages }));
  const sent = [];
  f.c.externalDelivery = { output: async args => { sent.push(args); return { status: 'failed', code: 'fixture' }; } };
  const observeFinal = turn => f.c.observeEvent(scope.agent.session, { type: 'assistant/message', seq: turn + 5, time: Date.now(), data: {
    turn, message: { id: 'test-final-' + turn, role: 'assistant', content: [{ type: 'text', text: final(['我也来接话。']) }] },
  } });
  await admit([makeInput('old-at', true), makeInput('new-plain', false)], 1);
  await observeFinal(1);
  assert.equal(sent[0].groupAddressEvidence, null);
  await admit([makeInput('revoked-at', true)], 2);
  const activeScene = (await f.assemble(groupId)).sections.at(-1).text.split('[current_group_observation]\n').at(-1);
  assert.equal(JSON.parse(activeScene).currentSelfAddress, 'supported_by_current_source');
  const pending = (await f.c.repository.getPending()).find(row => row.sourceEventId === 'revoked-at');
  await f.c.executeCommand('forget', { ids: [pending.id], scope: 'unknown', reason: 'remove the evidence' });
  const scene = (await f.assemble(groupId)).sections.at(-1).text.split('[current_group_observation]\n').at(-1);
  assert.equal(JSON.parse(scene).selfAddressEvidence, null, 'revoked proof is not projected even if the old observation remains');
  assert.equal(JSON.parse(scene).currentSelfAddress, 'not_observed');
  await observeFinal(2);
  assert.equal(sent[1].groupAddressEvidence.sourceEventId, 'revoked-at'); assert.equal(sent[1].groupAddressCurrent(), false);
});

test('a rejected plain final is reported as undelivered on the next group turn without deleting historical speech or retrying', async t => {
  const f = await fixture(t), scope = f.agents.get(groupId);
  scope.history.push({ id: 'bad-old-final', role: 'assistant', content: [{ type: 'text', text: '在在在' }] });
  const before = JSON.stringify(scope.history);
  f.c.externalDelivery = { findOutboundReceipt: () => ({ status: 'failed', code: 'SOCIAL_REPLY_FORMAT_REQUIRED' }) };
  const output = (await f.assemble(groupId)).sections.find(section => section.name === 'persona-memory:channel-output').text;
  assert.match(output, /bad-old-final/); assert.match(output, /unconfirmed/); assert.match(output, /SOCIAL_REPLY_FORMAT_REQUIRED/);
  assert.equal(JSON.stringify(scope.history), before); assert.equal(f.requests.length, 0);
});
