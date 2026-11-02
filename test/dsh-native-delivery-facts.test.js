import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeDeliveryFacts } from '../adapters/dsh/native-delivery-facts.js';

function fixture() {
  const files = new Map(), errors = []; let now = 100;
  const store = { readJson: async (path, fallback) => structuredClone(files.get(path) ?? fallback),
    transaction: async ({ json }) => { for (const [path, value] of Object.entries(json)) files.set(path, structuredClone(value)); } };
  const make = () => createNativeDeliveryFacts({ store, clock: () => now++, onError: error => errors.push(error) });
  return { make, store, files, errors };
}
const source = (id = 'ev1', extra = {}) => ({ eventId: id, sourceSessionId: 's1', sourceEventId: `user-${id}`, sourceAt: 1, channelId: 'dsh:s1', personId: null, text: 'abcdefghij', ...extra });
const output = (extra = {}) => ({ sourceSessionId: 's1', sourceEventId: 'out1', channelId: 'dsh:s1', personId: null, text: 'Actual delivered answer.',
  status: 'delivered', deliveredAt: 200, settledPendingEventIds: ['ev1'], evidence: 'native_visible_assistant_event', ...extra });

test('diagnostics persist presentation, exact receipts and recovery scope without retaining raw dialogue', async () => {
  const f = fixture(), first = f.make(); await first.open(); await first.admit([source()], { sessionId: 's1', turn: 1, streamObserved: true });
  await first.recordOutput(output());
  const second = f.make(); await second.open();
  assert.equal(second.wasAdmitted('ev1'), true);
  const facts = second.inspect({ pending: [source()], sessionId: 's1' });
  assert.equal(facts.pending.items[0].admission.complete, true); assert.ok(facts.pending.items[0].admission.streamObservedAt);
  assert.equal(facts.pending.items[0].answeredByLaterOutput, 'not_inferred');
  assert.equal(JSON.stringify(facts).includes('Actual delivered answer.'), false);
  let cleared;
  await second.recoverSettled({ getPending: async () => [source(), source('ev1', { sourceSessionId: 'foreign', channelId: 'dsh:foreign' }), source('ev1', { personId: 'other' })], clearPending: async ids => { cleared = ids; } });
  assert.deepEqual(cleared, ['ev1']);
});

test('partial admissions need complete coverage; duplicate receipts are idempotent and unknown cannot downgrade delivered', async () => {
  const f = fixture(), value = f.make(); await value.open();
  await value.admit([source('ev1', { fragment: { from: 5, to: 10, total: 10, complete: true } })]);
  assert.equal(value.wasAdmitted('ev1'), false, 'a tail complete flag is not full coverage');
  await value.admit([source('ev1', { fragment: { from: 0, to: 5, total: 10, complete: false } })]); assert.equal(value.wasAdmitted('ev1'), true);
  await value.recordOutput(output()); await value.recordOutput(output()); await value.recordOutput(output({ status: 'unknown', settledPendingEventIds: [] }));
  const facts = value.inspect(); assert.equal(facts.outputs.items.length, 1); assert.equal(facts.outputs.items[0].status, 'delivered');
});

test('bounded diagnostic eviction is explicit and never manufactures exact totals or pending completion', async () => {
  const f = fixture(), value = f.make(); await value.open();
  for (let i = 0; i < 70; i++) await value.recordOutput(output({ sourceEventId: `out-${i}`, settledPendingEventIds: [] }));
  const facts = value.inspect({ pending: [source()], sessionId: 's1', limit: 2 });
  assert.equal(facts.outputs.items.length, 2); assert.equal(facts.outputs.retained, 64); assert.equal(facts.outputs.totalObserved, null);
  assert.equal(facts.outputs.truncated, true); assert.equal(facts.outputs.historyEvicted, true);
  assert.equal(facts.pending.items[0].answeredByLaterOutput, 'not_inferred');
});

test('invalid diagnostic file stays unavailable and cannot authorize acknowledgements', async () => {
  const f = fixture(); f.files.set('host-delivery-facts.json', { schemaVersion: 'bogus' }); const value = f.make(); await value.open();
  assert.equal(value.inspect().available, false); assert.equal(value.wasAdmitted('ev1'), false); assert.equal(f.errors.length, 1);
  let called = false; await value.recoverSettled({ getPending: async () => [source()], clearPending: async () => { called = true; } });
  assert.equal(called, false);
});
