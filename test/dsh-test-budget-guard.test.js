import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {
  enableWholeBudgetUsageGuard,
  initializeWholeBudget,
  readWholeBudget,
  reserveWholeAttempt,
  settleWholeAttempt,
  wholeBudgetGuardView,
} from '../scripts/dsh-test-budget.mjs';

async function fixture(t, tokens) {
  const root = await mkdtemp(join(tmpdir(), 'xiangxu-usage-guard-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, {recursive: true, force: true});
  });
  const file = join(root, 'whole.json');
  await initializeWholeBudget(file, {attempts: null, tokens, wallMs: null});
  return file;
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('the strict default stops on missing usage until opt-in preserves the original requests', async t => {
  const file = await fixture(t, 100);
  await reserveWholeAttempt(file, {requestId: 'recorded'});
  await settleWholeAttempt(file, 'recorded', {totalTokens: 30});
  await reserveWholeAttempt(file, {requestId: 'historical-missing'});
  await settleWholeAttempt(file, 'historical-missing', null);

  const before = await readWholeBudget(file);
  const original = await readFile(file);
  await assert.rejects(reserveWholeAttempt(file, {requestId: 'next'}), {code: 'WHOLE_USAGE_UNRESOLVED'});
  assert.deepEqual(await readFile(file), original);

  await enableWholeBudgetUsageGuard(file, {minTokensPerAttempt: 20, expectedSha256: sha256(original)});
  const enabled = await readWholeBudget(file);
  assert.deepEqual(enabled.requests, before.requests);
  assert.equal(enabled.wholeAttemptsUsed, before.wholeAttemptsUsed);
  assert.equal(enabled.wholeTokensUsed, before.wholeTokensUsed);
  assert.equal(enabled.wholeUsageAttempts, before.wholeUsageAttempts);
  assert.equal(enabled.wholePendingUnknown, before.wholePendingUnknown);
  assert.deepEqual(wholeBudgetGuardView(enabled), {
    guardTokensUsed: 50, tokensLeft: 50, minTokensPerAttempt: 20, nextAttemptFits: true,
  });

  await reserveWholeAttempt(file, {requestId: 'next'});
  assert.equal((await readWholeBudget(file)).requests['historical-missing'].totalTokens, null);
});

test('activation rejects in-flight requests, stale file digests, invalid floors and duplicate opt-in', async t => {
  const file = await fixture(t, 100);
  const initial = await readFile(file);
  await reserveWholeAttempt(file, {requestId: 'busy'});
  const busy = await readFile(file);
  await assert.rejects(enableWholeBudgetUsageGuard(file, {minTokensPerAttempt: 20, expectedSha256: sha256(busy)}));
  assert.deepEqual(await readFile(file), busy);

  await settleWholeAttempt(file, 'busy', null);
  const settled = await readFile(file);
  await assert.rejects(enableWholeBudgetUsageGuard(file, {minTokensPerAttempt: 20, expectedSha256: sha256(initial)}));
  for (const minTokensPerAttempt of [0, -1, 1.5, NaN, Infinity, '20']) {
    await assert.rejects(enableWholeBudgetUsageGuard(file, {minTokensPerAttempt, expectedSha256: sha256(settled)}));
  }
  await assert.rejects(enableWholeBudgetUsageGuard(file, {minTokensPerAttempt: 20, expectedSha256: 'not-a-digest'}));
  assert.deepEqual(await readFile(file), settled);

  const competing = await Promise.allSettled([20, 25].map(minTokensPerAttempt => enableWholeBudgetUsageGuard(file, {
    minTokensPerAttempt, expectedSha256: sha256(settled),
  })));
  assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
  const enabled = await readFile(file);
  await assert.rejects(enableWholeBudgetUsageGuard(file, {minTokensPerAttempt: 20, expectedSha256: sha256(enabled)}));
  assert.deepEqual(await readFile(file), enabled);
});

test('in-flight, missing and zero usage consume the floor, and late actual usage replaces the floor', async t => {
  const file = await fixture(t, 75);
  await reserveWholeAttempt(file, {requestId: 'historical-missing'});
  await settleWholeAttempt(file, 'historical-missing', null, {finishedAt: 1234});
  await enableWholeBudgetUsageGuard(file, {minTokensPerAttempt: 20, expectedSha256: sha256(await readFile(file))});

  await reserveWholeAttempt(file, {requestId: 'reported-zero'});
  let state = await readWholeBudget(file);
  assert.equal(state.requests['reported-zero'].finishedAt, null);
  assert.equal(wholeBudgetGuardView(state).guardTokensUsed, 40);
  await settleWholeAttempt(file, 'reported-zero', {totalTokens: 0});
  state = await readWholeBudget(file);
  assert.equal(state.requests['reported-zero'].totalTokens, 0);
  assert.equal(state.wholeUsageAttempts, 1);
  assert.equal(state.wholeTokensUsed, 0);
  assert.equal(wholeBudgetGuardView(state).guardTokensUsed, 40);

  await reserveWholeAttempt(file, {requestId: 'new-missing'});
  await settleWholeAttempt(file, 'new-missing', null);
  state = await readWholeBudget(file);
  assert.equal(state.requests['new-missing'].totalTokens, null);
  assert.equal(state.wholePendingUnknown, 2);
  assert.deepEqual(wholeBudgetGuardView(state), {
    guardTokensUsed: 60, tokensLeft: 15, minTokensPerAttempt: 20, nextAttemptFits: false,
  });
  const exhausted = await readFile(file);
  await assert.rejects(reserveWholeAttempt(file, {requestId: 'would-cross-cap'}), {code: 'WHOLE_TOKENS_EXCEEDED'});
  assert.deepEqual(await readFile(file), exhausted);

  await settleWholeAttempt(file, 'historical-missing', {totalTokens: 40}, {finishedAt: 5678});
  state = await readWholeBudget(file);
  assert.equal(state.requests['historical-missing'].finishedAt, 1234);
  assert.equal(state.requests['historical-missing'].totalTokens, 40);
  assert.equal(state.wholeTokensUsed, 40);
  assert.equal(state.wholePendingUnknown, 1);
  assert.deepEqual(wholeBudgetGuardView(state), {
    guardTokensUsed: 80, tokensLeft: -5, minTokensPerAttempt: 20, nextAttemptFits: false,
  });
});

test('restarted processes share the persistent guard and compete for the exact last reservation', async t => {
  const file = await fixture(t, 40);
  await reserveWholeAttempt(file, {requestId: 'historical-missing'});
  await settleWholeAttempt(file, 'historical-missing', null);
  await enableWholeBudgetUsageGuard(file, {minTokensPerAttempt: 20, expectedSha256: sha256(await readFile(file))});
  const module = new URL('../scripts/dsh-test-budget.mjs', import.meta.url).href;
  const child = `
    import {reserveWholeAttempt} from ${JSON.stringify(module)};
    try {
      await reserveWholeAttempt(process.argv[1], {requestId: process.argv[2]});
      console.log('reserved');
    } catch (error) {
      console.log(error.code);
    }
  `;
  const results = await Promise.all(['left', 'right'].map(requestId => promisify(execFile)(process.execPath,
    ['--input-type=module', '-e', child, file, requestId], {windowsHide: true, timeout: 10000})));
  assert.deepEqual(results.map(({stdout}) => stdout.trim()).sort(), ['WHOLE_TOKENS_EXCEEDED', 'reserved']);
  const state = await readWholeBudget(file);
  assert.equal(state.wholeAttemptsUsed, 2);
  assert.equal(state.wholePendingUnknown, 2);
  assert.equal(state.wholeTokensUsed, 0);
  assert.deepEqual(wholeBudgetGuardView(state), {
    guardTokensUsed: 40, tokensLeft: 0, minTokensPerAttempt: 20, nextAttemptFits: false,
  });
});
