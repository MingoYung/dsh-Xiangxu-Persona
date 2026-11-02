import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createWholeBudgetState, validateWholeBudgetState, initializeWholeBudget, readWholeBudget, reserveWholeAttempt, settleWholeAttempt, clearWholeBudget} from '../scripts/dsh-test-budget.mjs';
import {observerSource, observerConfig} from '../scripts/dsh-real-lifecycle.mjs';

async function fixture(t, limits = {}) {
  const root = await mkdtemp(join(tmpdir(), 'xiangxu-budget-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/')); await rm(root, {recursive: true, force: true}); });
  const file = join(root, 'whole.json');
  await initializeWholeBudget(file, {attempts: 10, tokens: 10000, wallMs: 60000, ...limits});
  return {root, file};
}

async function observer(t, file, options = {}) {
  const {root} = await fixture(t);
  const moduleFile = join(root, 'observer.mjs');
  await writeFile(moduleFile, observerSource);
  const module = await import(pathToFileURL(moduleFile).href);
  let calls = 0;
  const adapter = {async prepareCall() {return {async *stream() {
    calls++;
    if (options.fail?.()) throw Object.assign(new Error('fake malformed output'), {code: 'MALFORMED_RESPONSE'});
    yield {type: 'usage', usage: {totalTokens: options.tokens ?? 10}};
    yield {type: 'finish', reason: {kind: 'stop'}};
  }};}};
  const ctx = {on() {}, get() {return {runtime: null};}, llm: {registration() {return {adapter};}}};
  module.apply(ctx, observerConfig({provider: 'fixed-fixture', ...(file ? {wholeStatePath: file} : {}), ...options}, root));
  return {root, get calls() {return calls;}, async send() {
    const call = await adapter.prepareCall({});
    for await (const chunk of call.stream({provider: 'fixed-fixture', model: 'zero-model', messages: [], tools: []})) void chunk;
  }};
}

test('first actual observer attempt sets the persisted clock and exact bound timestamp', async t => {
  const {file} = await fixture(t);
  const o = await observer(t, file);
  assert.equal((await readWholeBudget(file)).wholeFirstRequestAt, null);
  await o.send();
  const state = await readWholeBudget(file);
  const bound = JSON.parse((await readFile(join(o.root, 'provider-bound.jsonl'), 'utf8')).trim());
  assert.equal(state.wholeFirstRequestAt, bound.startedAt);
  assert.equal(state.wholeDeadline, bound.startedAt + 60000);
  assert.equal(state.wholeAttemptsUsed, 1);
  assert.equal(state.wholeUsageAttempts, 1);
});

test('same user turn continuation stops BEFORE fake provider at known token threshold', async t => {
  const {file} = await fixture(t, {tokens: 100});
  const o = await observer(t, file, {tokens: 60});
  await o.send(); await o.send();
  await assert.rejects(o.send(), {code: 'WHOLE_TOKENS_EXCEEDED'});
  assert.equal(o.calls, 2);
  assert.equal((await readWholeBudget(file)).wholeTokensUsed, 120); // in-flight tail is honest
});

test('same-turn attempts and independent observer instances share one cap', async t => {
  const {file} = await fixture(t, {attempts: 2});
  const a = await observer(t, file), b = await observer(t, file);
  await a.send(); await b.send();
  await assert.rejects(a.send(), {code: 'WHOLE_ATTEMPTS_EXCEEDED'});
  assert.equal(a.calls + b.calls, 2);
});

test('expired deadline blocks a continuation without invoking the provider', async t => {
  const {file} = await fixture(t, {wallMs: 10});
  const o = await observer(t, file);
  await o.send();
  await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(o.send(), {code: 'WHOLE_DEADLINE_PASSED'});
  assert.equal(o.calls, 1);
});

test('failed provider remains a counted unknown and zero usage is valid', async t => {
  const {file} = await fixture(t);
  let fail = true;
  const o = await observer(t, file, {tokens: 0, fail: () => fail});
  await assert.rejects(o.send(), {code: 'MALFORMED_RESPONSE'});
  fail = false; await o.send();
  const state = await readWholeBudget(file);
  assert.deepEqual([state.wholeAttemptsUsed, state.wholeUsageAttempts, state.wholePendingUnknown, state.wholeTokensUsed], [2, 1, 1, 0]);
});

test('corrupt or missing explicitly enabled whole state cannot disable protection', async t => {
  const {file} = await fixture(t);
  const o = await observer(t, file);
  await writeFile(file, '{bad');
  await assert.rejects(o.send(), {code: 'WHOLE_STATE_INVALID'});
  await rm(file);
  await assert.rejects(o.send(), {code: 'WHOLE_STATE_MISSING'});
  assert.equal(o.calls, 0);
});

test('no whole option keeps the existing observer behavior and local cap', async t => {
  const o = await observer(t, null, {maxActualDispatches: 1});
  await o.send();
  await assert.rejects(o.send(), {code: 'TEST_DISPATCH_BUDGET'});
  assert.equal(o.calls, 1);
});

test('parallel contexts cannot both reserve the last attempt', async t => {
  const {file} = await fixture(t, {attempts: 1});
  const a = await observer(t, file), b = await observer(t, file);
  const result = await Promise.allSettled([a.send(), b.send()]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(result.find(r => r.status === 'rejected').reason.code, 'WHOLE_ATTEMPTS_EXCEEDED');
  assert.equal(a.calls + b.calls, 1);
});

test('one observer claims its local slot before awaiting the shared gate', async t => {
  const {file} = await fixture(t);
  const o = await observer(t, file, {maxActualDispatches: 1});
  const result = await Promise.allSettled([o.send(), o.send()]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(result.find(r => r.status === 'rejected').reason.code, 'TEST_DISPATCH_BUDGET');
  assert.equal(o.calls, 1);
  assert.equal((await readWholeBudget(file)).wholeAttemptsUsed, 1);
});

test('settlement is idempotent, null cannot erase usage, conflicting totals stop', async t => {
  const {file} = await fixture(t);
  await reserveWholeAttempt(file, {requestId: 'one'});
  await settleWholeAttempt(file, 'one', {totalTokens: 12});
  await settleWholeAttempt(file, 'one', null);
  await settleWholeAttempt(file, 'one', {totalTokens: 12});
  assert.equal((await readWholeBudget(file)).wholeTokensUsed, 12);
  await assert.rejects(settleWholeAttempt(file, 'one', {totalTokens: 13}), {code: 'WHOLE_USAGE_CONFLICT'});
});

test('negative/fractional usage stays unknown and invalid caps do not create state', async t => {
  const {file, root} = await fixture(t);
  for (const [i, totalTokens] of [-1, 1.5, '2'].entries()) {
    await reserveWholeAttempt(file, {requestId: 'bad-' + i});
    await settleWholeAttempt(file, 'bad-' + i, {totalTokens});
  }
  const state = await readWholeBudget(file);
  assert.equal(state.wholePendingUnknown, 3); assert.equal(state.wholeTokensUsed, 0);
  await assert.rejects(initializeWholeBudget(join(root, 'bad.json'), {attempts: 1.5, tokens: 2, wallMs: 1}), {code: 'WHOLE_PARAMS_INVALID'});
  await assert.rejects(readFile(join(root, 'bad.json')), {code: 'ENOENT'});
});

test('a new process keeps the first timestamp and cannot regain a reserved attempt', async t => {
  const {file, root} = await fixture(t, {attempts: 1});
  const state = await reserveWholeAttempt(file, {requestId: 'before-crash'});
  const childFile = join(root, 'child.mjs');
  const helper = new URL('../scripts/dsh-test-budget.mjs', import.meta.url).href;
  await writeFile(childFile, `import {reserveWholeAttempt,readWholeBudget} from ${JSON.stringify(helper)};
    try {await reserveWholeAttempt(process.argv[2],{requestId:'after-restart'});process.exitCode=1;}
    catch(e){console.log(JSON.stringify({code:e.code,state:await readWholeBudget(process.argv[2])}));}`);
  const child = spawn(process.execPath, [childFile, file], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let output = ''; child.stdout.on('data', c => {output += c;});
  assert.equal(await new Promise(resolve => child.once('close', resolve)), 0);
  const result = JSON.parse(output);
  assert.equal(result.code, 'WHOLE_ATTEMPTS_EXCEEDED');
  assert.equal(result.state.wholeFirstRequestAt, state.wholeFirstRequestAt);
  assert.equal(result.state.wholePendingUnknown, 1);
});

test('clear preserves a fixed previous state and does not write an invalid empty object', async t => {
  const {file} = await fixture(t);
  await reserveWholeAttempt(file, {requestId: 'one'});
  await clearWholeBudget(file);
  assert.equal(await readWholeBudget(file, {allowMissing: true}), null);
  assert.equal(JSON.parse(await readFile(file + '.previous.json', 'utf8')).wholeAttemptsUsed, 1);
});

test('token-only schema 2 persists no count/time cap beyond old 20/30 limits', async t => {
  const {file} = await fixture(t, {attempts: null, tokens: 250, wallMs: null});
  for (let i = 0; i < 25; i++) {
    await reserveWholeAttempt(file, {requestId: 'token-only-' + i, startedAt: Date.now() - 86400000});
    await settleWholeAttempt(file, 'token-only-' + i, {totalTokens: 10});
  }
  const state = await readWholeBudget(file);
  assert.equal(state.schema, 2);
  assert.equal(state.wholeAttemptsCap, null);
  assert.equal(state.wholeWallMs, null);
  assert.equal(state.wholeDeadline, null);
  assert.equal(state.wholeAttemptsUsed, 25);
  assert.equal(state.wholeTokensUsed, 250);
  validateWholeBudgetState(JSON.parse(JSON.stringify(state)));
  await assert.rejects(reserveWholeAttempt(file, {requestId: '26'}), {code: 'WHOLE_TOKENS_EXCEEDED'});
});

test('nullable count/time caps do not weaken required token or legacy schema validation', () => {
  const valid = createWholeBudgetState({attempts: null, tokens: 10000000, wallMs: null});
  validateWholeBudgetState(valid);
  assert.throws(() => validateWholeBudgetState({...valid, schema: 1}), {code: 'WHOLE_STATE_INVALID'});
  for (const field of ['attempts', 'tokens', 'wallMs']) {
    const args = {attempts: null, tokens: 10000000, wallMs: null};
    delete args[field];
    assert.throws(() => createWholeBudgetState(args), {code: 'WHOLE_PARAMS_INVALID'});
  }
  for (const tokens of [null, NaN, 0, 1.5]) assert.throws(() => createWholeBudgetState({attempts: null, tokens, wallMs: null}), {code: 'WHOLE_PARAMS_INVALID'});
});
