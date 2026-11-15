import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {formalMonitorSource, formalMonitorConfig, normalizeFormalScope} from '../scripts/dsh-formal-monitor.mjs';
import {enableWholeBudgetUsageGuard, initializeWholeBudget, readWholeBudget, reserveWholeAttempt, settleWholeAttempt} from '../scripts/dsh-test-budget.mjs';
import {createDshModelPort} from '../adapters/dsh/model.js';

const nativeOptions = (sessionId = 'qq-private', extra = {}) => ({
  provider: 'fixed-primary', model: 'fixed-model', sessionId,
  messages: [{id: 'native-message', role: 'user', content: [{type: 'text', text: 'PRIVATE_BODY_SENTINEL'}]}],
  tools: [{name: 'fixed-tool', description: 'PRIVATE_TOOL_SENTINEL'}],
  ...extra,
});

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'xiangxu-formal-scope-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
    await rm(root, {recursive: true, force: true});
  });
  const artifacts = join(root, 'evidence'), wholeStatePath = join(root, 'whole.json'), memoryRoot = join(root, 'memory');
  await mkdir(artifacts);
  await initializeWholeBudget(wholeStatePath, {attempts: null, tokens: 1000000, wallMs: null, ...options.limits});
  const moduleFile = join(root, 'formal-monitor.mjs');
  await writeFile(moduleFile, formalMonitorSource);
  const monitor = await import(pathToFileURL(moduleFile).href);
  const handlers = new Map(), effects = [], providers = new Map(), headerReads = [], queryDisposals = [];
  let effectRegistrations = 0;
  const calls = [], prepareCalls = [], sessionHeaders = new Map(), agentHeaders = new Map(), coldHeaders = new Map();
  const adapters = new Set();
  const makeAdapter = behavior => {
    const adapter = {async prepareCall(...args) {
      prepareCalls.push({adapter, args, receiver: this});
      return {model: {id: 'fixed-model'}, fixedCallProperty: 'preserved', async *stream(config) {
        calls.push({adapter, config, thisValue: this});
        if (behavior) {yield* behavior(config); return;}
        yield {type: 'text-delta', index: 0, text: 'FIXED_OUTPUT_SENTINEL'};
        yield {type: 'usage', usage: {inputTokens: 5, outputTokens: 2, totalTokens: 7}};
        yield {type: 'finish', reason: {kind: 'stop'}};
      }};
    }};
    adapters.add(adapter); return adapter;
  };
  const ctx = {
    llm: {
      listProviders: () => [...providers.keys()].map(id => ({id})),
      registration: id => {if (!providers.has(id)) throw Error('Missing fixed registration'); return {adapter: providers.get(id)};},
    },
    sessions: {get: id => sessionHeaders.has(id) ? {header: sessionHeaders.get(id)} : undefined},
    agents: {get: id => agentHeaders.has(id) ? {session: {header: agentHeaders.get(id)}} : undefined},
    sessionQuery: {async observeSession(id, query) {
      headerReads.push({id, query});
      if (!coldHeaders.has(id)) return null;
      return {header: coldHeaders.get(id), [Symbol.dispose]() {queryDisposals.push(id);}};
    }},
    get(name) {return this[name];},
    on(event, callback) {
      assert.notEqual(event, 'dispose', 'Cordis lifecycle cleanup must use ctx.effect, not a synthetic dispose event');
      const list = handlers.get(event) ?? []; list.push(callback); handlers.set(event, list);
    },
    effect(initialize) {
      effectRegistrations++;
      const cleanup = initialize(); assert.equal(typeof cleanup, 'function'); effects.push(cleanup);
    },
  };
  const primary = makeAdapter(options.behavior);
  providers.set('fixed-primary', primary);
  sessionHeaders.set('other-session', {id: 'other-session'});
  const scope = {mode: 'sessions', sessionIds: ['qq-private', 'qq-group'], memoryRoot, includeDescendants: true, ...options.scope};
  const config = formalMonitorConfig({artifacts, wholeStatePath, scope, ...options.config});
  monitor.apply(ctx, config);
  const emit = event => {for (const callback of handlers.get(event) ?? []) callback();};
  const send = async (request = nativeOptions(), adapter = providers.get(request.provider)) => {
    const signal = request.signal ?? new AbortController().signal;
    const call = await adapter.prepareCall(request.provider, request.model, signal);
    assert.equal(call.fixedCallProperty, 'preserved');
    const chunks = []; for await (const chunk of call.stream(request)) chunks.push(chunk);
    return chunks;
  };
  const jsonl = async name => {
    try {const text = await readFile(join(artifacts, name), 'utf8'); return text.trim().split('\n').filter(Boolean).map(JSON.parse);}
    catch (error) {if (error.code === 'ENOENT') return []; throw error;}
  };
  return {root, artifacts, wholeStatePath, memoryRoot, ctx, monitor, config, providers, calls, prepareCalls,
    makeAdapter, adapters, primary, sessionHeaders, agentHeaders, coldHeaders, headerReads, queryDisposals, send, jsonl,
    emit, get effectRegistrations() {return effectRegistrations;},
    dispose: () => {for (const cleanup of effects.splice(0).reverse()) cleanup();}};
}

test('formal monitor refuses implicit provider-wide scope and validates the actual injected module configuration', async t => {
  for (const scope of [undefined, {}, {mode: 'provider'}, {mode: 'sessions', sessionIds: [], memoryRoot: 'x'},
    {mode: 'sessions', sessionIds: [''], memoryRoot: 'x'}, {mode: 'sessions', sessionIds: ['ok'], memoryRoot: ''},
    {mode: 'sessions', sessionIds: ['ok'], memoryRoot: 'x', includeDescendants: 'yes'}]) {
    assert.throws(() => formalMonitorConfig({artifacts: 'evidence', wholeStatePath: 'whole', scope}), {code: 'FORMAL_MONITOR_SCOPE_REQUIRED'});
  }
  assert.deepEqual(normalizeFormalScope({mode: 'sessions', sessionIds: ['a', 'a'], memoryRoot: 'x'}),
    {mode: 'sessions', sessionIds: ['a'], memoryRoot: 'x', includeDescendants: true});
  const f = await fixture(t);
  assert.deepEqual(f.monitor.inject, ['llm']);
  assert.equal(f.effectRegistrations, 1, 'the actual injected monitor must register its cleanup through ctx.effect');
  assert.equal(f.config.wholeStatePath, f.wholeStatePath);
  assert.throws(() => f.monitor.apply(f.ctx, {...f.config, scope: undefined}), {code: 'FORMAL_MONITOR_SCOPE_REQUIRED'});
  for (const banned of ['agent/created', 'personaMemory', 'agentDefaultModel', 'tools.restrict', 'presets.mount']) {
    assert.equal(formalMonitorSource.includes(banned), false, `monitor must not mutate personality via ${banned}`);
  }
});

test('selected private/group and each continuation or retry reserve independently; unrelated same-provider sessions pass unchanged', async t => {
  const f = await fixture(t);
  const before = await readFile(f.wholeStatePath, 'utf8');
  const unrelated = nativeOptions('other-session', {purpose: 'compaction'});
  await f.send(unrelated);
  assert.equal(await readFile(f.wholeStatePath, 'utf8'), before);
  assert.equal(f.calls[0].config, unrelated);
  for (const request of [nativeOptions(), nativeOptions('qq-group'), nativeOptions('qq-private', {purpose: 'compaction'}),
    nativeOptions('qq-private', {purpose: 'session-title'}), nativeOptions('qq-private', {purpose: 'tool-continuation'}),
    nativeOptions('qq-private', {purpose: 'retry'})]) await f.send(request);
  const state = await readWholeBudget(f.wholeStatePath);
  assert.deepEqual([state.wholeAttemptsUsed, state.wholeUsageAttempts, state.wholePendingUnknown, state.wholeTokensUsed], [6, 6, 0, 42]);
  assert.equal(f.calls.length, 7);
  const bounds = await f.jsonl('provider-bound.jsonl');
  assert.equal(new Set(bounds.map(row => row.requestId)).size, 6);
  assert.deepEqual(bounds.map(row => row.scope.rootSessionId), ['qq-private', 'qq-group', 'qq-private', 'qq-private', 'qq-private', 'qq-private']);
  assert.equal((await f.jsonl('scope-dispatch.jsonl'))[0].included, false);
});

test('provider receives the exact messages, tools, options, signal and prepareCall receiver only after reservation', async t => {
  let f;
  f = await fixture(t, {behavior: async function* (options) {
    const state = await readWholeBudget(f.wholeStatePath);
    assert.equal(state.wholeAttemptsUsed, 1); assert.equal(state.wholePendingUnknown, 1);
    assert.equal((await f.jsonl('provider-bound.jsonl')).length, 1);
    yield {type: 'usage', usage: {totalTokens: 0}};
    yield {type: 'finish', reason: {kind: 'stop'}};
  }});
  const signal = new AbortController().signal, request = nativeOptions('qq-private', {signal, reasoningEffort: 'high', maxTokens: 4096, temperature: 0.71});
  const original = structuredClone({...request, signal: null});
  await f.send(request);
  assert.equal(f.calls[0].config, request); assert.equal(f.calls[0].config.signal, signal);
  assert.deepEqual({...request, signal: null}, original);
  assert.equal(f.prepareCalls[0].receiver, f.primary);
  assert.deepEqual(f.prepareCalls[0].args, ['fixed-primary', 'fixed-model', signal]);
  assert.equal((await readWholeBudget(f.wholeStatePath)).wholeUsageAttempts, 1, 'real zero is valid usage');
  const evidence = (await Promise.all((await readdir(f.artifacts)).map(name => readFile(join(f.artifacts, name), 'utf8')))).join('');
  for (const secret of ['PRIVATE_BODY_SENTINEL', 'PRIVATE_TOOL_SENTINEL', 'FIXED_OUTPUT_SENTINEL']) assert.equal(evidence.includes(secret), false);
  assert.equal((await f.jsonl('provider-bound.jsonl'))[0].fullInputsLogged, false);
  assert.equal((await f.jsonl('provider-bound.jsonl'))[0].requestSize.tokenCount, null);
});

test('real host-header descendants use live sessions, live agents and cold header-only leases across providers', async t => {
  const f = await fixture(t);
  f.sessionHeaders.set('worker-live', {id: 'worker-live', parentSession: 'qq-private'});
  f.agentHeaders.set('worker-agent', {id: 'worker-agent', parentSession: 'worker-live'});
  f.coldHeaders.set('worker-cold', {id: 'worker-cold', parentSession: 'worker-agent'});
  const workerAdapter = f.makeAdapter();
  f.providers.set('fixed-worker', workerAdapter); f.emit('llm/adapters-updated');
  await f.send(nativeOptions('worker-cold', {provider: 'fixed-worker', purpose: 'compaction'}));
  await f.send(nativeOptions('worker-agent', {provider: 'fixed-worker', purpose: 'session-title'}));
  await f.send(nativeOptions('worker-live', {provider: 'fixed-worker'}));
  assert.equal((await readWholeBudget(f.wholeStatePath)).wholeAttemptsUsed, 3);
  const bounds = await f.jsonl('provider-bound.jsonl');
  assert.deepEqual(bounds[0].scope.ancestry, ['worker-cold', 'worker-agent', 'worker-live', 'qq-private']);
  assert.equal(bounds[0].scope.rootSessionId, 'qq-private');
  assert.deepEqual(f.headerReads, [{id: 'worker-cold', query: {projectionMode: 'none'}}]);
  assert.deepEqual(f.queryDisposals, ['worker-cold']);
  assert.ok(f.calls.every(row => row.adapter === workerAdapter));
});

test('descendant matching uses real headers rather than session names and can be explicitly disabled', async t => {
  const f = await fixture(t, {scope: {includeDescendants: false}});
  f.sessionHeaders.set('qq-private-worker-lookalike', {id: 'qq-private-worker-lookalike', parentSession: 'qq-private'});
  await f.send(nativeOptions('qq-private-worker-lookalike'));
  assert.equal((await readWholeBudget(f.wholeStatePath)).wholeAttemptsUsed, 0);
  assert.equal(f.headerReads.length, 0);
  await f.send(nativeOptions('qq-private'));
  assert.equal((await readWholeBudget(f.wholeStatePath)).wholeAttemptsUsed, 1);
});

test('auxiliary producer attributes control, consolidation, memory assistance and proactive replies without native projection fields', async t => {
  const f = await fixture(t, {behavior: async function* (options) {
    const text = options.xiangxuAccounting.purpose === 'control' ? '{"replyPlan":{"action":"wait"}}'
      : options.xiangxuAccounting.purpose === 'consolidation' ? '{"entries":[]}' : 'fixed';
    yield {type: 'text-delta', index: 0, text}; yield {type: 'usage', usage: {totalTokens: 11}};
    yield {type: 'finish', reason: {kind: 'stop'}};
  }});
  const service = {async *stream(options) {
    const call = await f.primary.prepareCall(options.provider, options.model, options.signal);
    yield* call.stream(options);
  }};
  const port = createDshModelPort({llm: service}, {memoryRoot: f.memoryRoot,
    getSelection: () => ({provider: 'fixed-primary', model: 'fixed-model', reasoningEffort: 'high'})});
  for (const purpose of ['control', 'consolidation', 'memory_assistant', 'reply']) {
    await port.complete({purpose, context: JSON.parse(JSON.stringify({sessionId: 'qq-private', proactive: true})), messages: []});
  }
  assert.equal((await readWholeBudget(f.wholeStatePath)).wholeAttemptsUsed, 4);
  assert.ok(f.calls.every(({config}) => !Object.hasOwn(config, 'sessionId') && !Object.hasOwn(config, 'purpose')));
  assert.deepEqual((await f.jsonl('provider-bound.jsonl')).map(row => row.purpose), ['control', 'consolidation', 'memory_assistant', 'reply']);
  const stateBefore = await readFile(f.wholeStatePath, 'utf8');
  await f.send(nativeOptions(undefined, {sessionId: undefined,
    xiangxuAccounting: {sessionId: 'qq-private', memoryRoot: join(f.root, 'another-persona'), purpose: 'reply'}}));
  assert.equal(await readFile(f.wholeStatePath, 'utf8'), stateBefore, 'another persona cannot claim the selected scope by session text alone');
});

test('unresolved selected-persona routing, native/aux conflict and invalid or cyclic ancestry stop before provider or reservation', async t => {
  const f = await fixture(t);
  f.sessionHeaders.set('bad-header', {id: 'different-header'});
  f.sessionHeaders.set('bad-parent', {id: 'bad-parent', parentSession: 42});
  f.sessionHeaders.set('cycle-a', {id: 'cycle-a', parentSession: 'cycle-b'});
  f.sessionHeaders.set('cycle-b', {id: 'cycle-b', parentSession: 'cycle-a'});
  const cases = [
    [nativeOptions(undefined, {sessionId: undefined, xiangxuAccounting: {sessionId: null, memoryRoot: f.memoryRoot, purpose: 'control'}}), 'FORMAL_MONITOR_SCOPE_UNRESOLVED'],
    [nativeOptions('qq-private', {xiangxuAccounting: {sessionId: 'qq-group', memoryRoot: f.memoryRoot, purpose: 'reply'}}), 'FORMAL_MONITOR_SCOPE_CONFLICT'],
    [nativeOptions('missing-header'), 'FORMAL_MONITOR_SCOPE_UNRESOLVED'],
    [nativeOptions('bad-header'), 'FORMAL_MONITOR_SCOPE_UNRESOLVED'],
    [nativeOptions('bad-parent'), 'FORMAL_MONITOR_SCOPE_UNRESOLVED'],
    [nativeOptions('cycle-a'), 'FORMAL_MONITOR_SCOPE_UNRESOLVED'],
  ];
  const before = await readFile(f.wholeStatePath, 'utf8');
  for (const [request, code] of cases) await assert.rejects(f.send(request), {code});
  assert.equal(f.calls.length, 0); assert.equal(await readFile(f.wholeStatePath, 'utf8'), before);
  const blocks = await f.jsonl('dispatch-budget.jsonl');
  assert.equal(blocks.length, cases.length); assert.ok(blocks.every(row => row.blockedBeforeProviderInvocation === true));
});

test('ended unknown blocks only selected acceptance calls; unrelated same-provider traffic remains uncounted', async t => {
  const f = await fixture(t, {behavior: async function* () {yield {type: 'finish', reason: {kind: 'stop'}};}});
  await f.send();
  const afterUnknown = await readFile(f.wholeStatePath, 'utf8');
  await assert.rejects(f.send(nativeOptions('qq-group')), {code: 'WHOLE_USAGE_UNRESOLVED'});
  await f.send(nativeOptions('other-session'));
  assert.equal(f.calls.length, 2); assert.equal(await readFile(f.wholeStatePath, 'utf8'), afterUnknown);
  const state = await readWholeBudget(f.wholeStatePath);
  assert.deepEqual([state.wholeAttemptsUsed, state.wholeUsageAttempts, state.wholePendingUnknown, state.wholeTokensUsed], [1, 0, 1, 0]);
  assert.ok((await f.jsonl('dispatch-budget.jsonl')).some(row => row.reason === 'WHOLE_USAGE_UNRESOLVED' && row.blockedBeforeProviderInvocation));
});

test('recreating the monitor cannot clear a previously settled unknown reservation', async t => {
  const f = await fixture(t);
  await reserveWholeAttempt(f.wholeStatePath, {requestId: 'prior-monitor-attempt'});
  await settleWholeAttempt(f.wholeStatePath, 'prior-monitor-attempt', null);
  const before = await readFile(f.wholeStatePath, 'utf8');
  f.dispose(); f.monitor.apply(f.ctx, f.config);
  await assert.rejects(f.send(), {code: 'WHOLE_USAGE_UNRESOLVED'});
  await f.send(nativeOptions('other-session'));
  assert.equal(f.calls.length, 1);
  assert.equal(await readFile(f.wholeStatePath, 'utf8'), before);
  assert.equal((await readWholeBudget(f.wholeStatePath)).requests['prior-monitor-attempt'].totalTokens, null);
});

test('selected calls continue through missing usage under the bounded guard and stop before provider when it runs out', async t => {
  const f = await fixture(t, {limits: {tokens: 20}, behavior: async function* () {
    yield {type: 'finish', reason: {kind: 'stop'}};
  }});
  await f.send();
  const prior = await readWholeBudget(f.wholeStatePath);
  const expectedSha256 = createHash('sha256').update(await readFile(f.wholeStatePath)).digest('hex');
  await enableWholeBudgetUsageGuard(f.wholeStatePath, {minTokensPerAttempt: 10, expectedSha256});
  await f.send(nativeOptions('qq-group'));
  await assert.rejects(f.send(), {code: 'WHOLE_TOKENS_EXCEEDED'});
  await f.send(nativeOptions('other-session'));
  assert.equal(f.calls.length, 3);
  const state = await readWholeBudget(f.wholeStatePath);
  assert.equal(state.wholeTokensUsed, 0);
  assert.equal(state.wholePendingUnknown, 2);
  for (const row of Object.values(prior.requests)) assert.deepEqual(state.requests[row.requestId], row);
  assert.equal((await f.jsonl('provider-bound.jsonl')).length, 2);
  assert.ok((await f.jsonl('dispatch-budget.jsonl')).some(row =>
    row.reason === 'WHOLE_TOKENS_EXCEEDED' && row.blockedBeforeProviderInvocation));
});

test('a retry after an observed usage error is a new attempt; missing usage is never silently replaced by zero', async t => {
  let actual = 0;
  const f = await fixture(t, {behavior: async function* () {
    actual++; yield {type: 'usage', usage: {totalTokens: 13}};
    if (actual === 1) throw Object.assign(Error('fixed provider failure after usage'), {code: 'FIXED_STREAM_ERROR'});
    yield {type: 'finish', reason: {kind: 'stop'}};
  }});
  await assert.rejects(f.send(), {code: 'FIXED_STREAM_ERROR'}); await f.send();
  const state = await readWholeBudget(f.wholeStatePath);
  assert.deepEqual([state.wholeAttemptsUsed, state.wholeUsageAttempts, state.wholePendingUnknown, state.wholeTokensUsed], [2, 2, 0, 26]);
});

test('concurrent selected sessions atomically compete for the final reservation without cross-session attribution', async t => {
  const f = await fixture(t, {limits: {attempts: 1}});
  const results = await Promise.allSettled([f.send(nativeOptions('qq-private')), f.send(nativeOptions('qq-group'))]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.find(row => row.status === 'rejected').reason.code, 'WHOLE_ATTEMPTS_EXCEEDED');
  assert.equal(f.calls.length, 1);
  const bound = (await f.jsonl('provider-bound.jsonl'))[0];
  assert.equal(bound.scope.sessionId, f.calls[0].config.sessionId);
  assert.equal((await readWholeBudget(f.wholeStatePath)).wholeAttemptsUsed, 1);
});

test('selected requests across providers share one token threshold while unrelated provider traffic stays outside it', async t => {
  const f = await fixture(t, {limits: {tokens: 10}});
  const workerAdapter = f.makeAdapter(); f.providers.set('fixed-worker', workerAdapter); f.emit('llm/adapters-updated');
  f.sessionHeaders.set('cross-provider-worker', {id: 'cross-provider-worker', parentSession: 'qq-private'});
  await f.send();
  await f.send(nativeOptions('cross-provider-worker', {provider: 'fixed-worker'}));
  const before = await readFile(f.wholeStatePath, 'utf8');
  await assert.rejects(f.send(nativeOptions('qq-group', {provider: 'fixed-worker'})), {code: 'WHOLE_TOKENS_EXCEEDED'});
  await f.send(nativeOptions('other-session', {provider: 'fixed-worker'}));
  assert.equal(f.calls.length, 3);
  assert.equal(await readFile(f.wholeStatePath, 'utf8'), before);
  const state = await readWholeBudget(f.wholeStatePath);
  assert.deepEqual([state.wholeAttemptsUsed, state.wholeTokensUsed], [2, 14], 'retain the real in-flight tail rather than truncate it to the cap');
});

test('provider additions/replacements are monitored and shared adapters never receive duplicate wrappers', async t => {
  const f = await fixture(t), firstWrapper = f.primary.prepareCall;
  f.providers.set('shared-alias', f.primary); f.emit('llm/adapters-updated');
  assert.equal(f.primary.prepareCall, firstWrapper);
  await f.send(nativeOptions('qq-private', {provider: 'shared-alias'}));
  const replacement = f.makeAdapter(), originalReplacement = replacement.prepareCall;
  f.providers.set('fixed-primary', replacement); f.emit('llm/adapters-updated');
  assert.notEqual(replacement.prepareCall, originalReplacement);
  await f.send(nativeOptions('qq-group'));
  const added = f.makeAdapter(); f.providers.set('new-provider', added); f.emit('llm/adapters-updated');
  await f.send(nativeOptions('qq-private', {provider: 'new-provider'}));
  assert.equal((await readWholeBudget(f.wholeStatePath)).wholeAttemptsUsed, 3);
  assert.equal(f.calls.length, 3);
  f.dispose();
  assert.equal(replacement.prepareCall, originalReplacement);
});

test('dispose restores only its own wrapper and a retained call cannot continue charging after disposal', async t => {
  const f = await fixture(t);
  const originalOther = f.makeAdapter().prepareCall;
  const other = {prepareCall: originalOther}; f.providers.set('other-provider', other); f.emit('llm/adapters-updated');
  const wrapped = f.primary.prepareCall, laterWrapper = async (...args) => wrapped.apply(f.primary, args);
  f.primary.prepareCall = laterWrapper;
  const prepared = await other.prepareCall('other-provider', 'fixed-model');
  f.dispose();
  assert.equal(f.primary.prepareCall, laterWrapper, 'do not overwrite a wrapper installed by another plugin later');
  assert.equal(other.prepareCall, originalOther);
  f.emit('llm/adapters-updated');
  assert.equal(other.prepareCall, originalOther, 'disposed monitor does not reattach');
  for await (const chunk of prepared.stream(nativeOptions('qq-private', {provider: 'other-provider'}))) void chunk;
  await f.send();
  assert.equal((await readWholeBudget(f.wholeStatePath)).wholeAttemptsUsed, 0);
  const rows = (await f.jsonl('dispatch-budget.jsonl')).filter(row => row.reason === 'monitor-disposed');
  assert.deepEqual(rows.map(row => row.prepareCallRestored).sort(), [false, true]);
});

test('an expired acceptance deadline and missing or corrupt budget block selected requests before provider invocation', async t => {
  const f = await fixture(t, {config: {wholeDeadline: 0}});
  await assert.rejects(f.send(), {code: 'WHOLE_DEADLINE_PASSED'});
  await f.send(nativeOptions('other-session'));
  assert.equal(f.calls.length, 1); assert.equal((await readWholeBudget(f.wholeStatePath)).wholeAttemptsUsed, 0);
  const missing = await fixture(t); await rm(missing.wholeStatePath);
  await assert.rejects(missing.send(), {code: 'WHOLE_STATE_MISSING'}); assert.equal(missing.calls.length, 0);
  const corrupt = await fixture(t); await writeFile(corrupt.wholeStatePath, '{bad');
  await assert.rejects(corrupt.send(), {code: 'WHOLE_STATE_INVALID'}); assert.equal(corrupt.calls.length, 0);
});

test('explicit full-input opt-in is truthful and never applies to unrelated traffic', async t => {
  const f = await fixture(t, {config: {logFullInputs: true}});
  await f.send(nativeOptions('other-session')); await f.send();
  const full = await f.jsonl('provider-input-full.jsonl'), bounds = await f.jsonl('provider-bound.jsonl');
  assert.equal(full.length, 1); assert.equal(bounds.length, 1); assert.equal(bounds[0].fullInputsLogged, true);
  assert.equal(full[0].requestId, bounds[0].requestId); assert.ok(JSON.stringify(full[0]).includes('PRIVATE_BODY_SENTINEL'));
});
