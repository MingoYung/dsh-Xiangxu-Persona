import test from 'node:test';
import assert from 'node:assert/strict';
import { observationAllows, validateDecision } from '../core/schema.js';
import { consolidationMessages } from '../core/prompts.js';

test('observation dimensions are independently optional, explicit empty arrays observe nobody, and selected dimensions intersect', () => {
  assert.equal(observationAllows(undefined, { channelId: 'room', personId: null }), true);
  assert.equal(observationAllows(null, {}), true);
  assert.equal(observationAllows({ observeChannelIds: ['room'] }, { channelId: 'room', personId: null }), true);
  assert.equal(observationAllows({ targetPersonIds: ['a'] }, { channelId: 'anywhere', personId: 'a' }), true);
  assert.equal(observationAllows({ targetPersonIds: ['a'] }, { channelId: 'room', personId: null }), false);
  assert.equal(observationAllows({ observeChannelIds: [] }, { channelId: 'room', personId: 'a' }), false);
  assert.equal(observationAllows({ targetPersonIds: [] }, { channelId: 'room', personId: 'a' }), false);
  const attention = { observeChannelIds: ['room'], targetPersonIds: ['a'] };
  assert.equal(observationAllows(attention, { channelId: 'room', personId: 'a' }), true);
  assert.equal(observationAllows(attention, { channelId: 'elsewhere', personId: 'a' }), false);
  assert.equal(observationAllows(attention, { channelId: 'room', personId: 'b' }), false);
  assert.equal(observationAllows(attention, { channelId: 'room', personId: undefined }), false);
  validateDecision({ attention: { observeChannelIds: [], targetPersonIds: [] } });
});
test('consolidation shape guide gives correct common and personal metadata for each document key without requiring new entries', () => {
  const versions = { persona: 2, 'global:index': 1, 'global:codes': 3, 'person:a:index': 4, 'person:a:codes': 5, 'person:a:impression': 6 };
  const run = { runId: 'shape', inputVersions: versions, input: { chat: [{ sourceSessionId: 's', sourceEventId: 'm' }] } };
  const messages = consolidationMessages(run, { personId: 'a' });
  const guide = JSON.parse(messages[1].content.slice('Value shape guide: '.length));
  assert.equal(guide.globalMeta.scope, 'global'); assert.equal(guide.globalMeta.personId, null);
  assert.equal(guide.personMeta.scope, 'person'); assert.equal(guide.personMeta.personId, 'a');
  assert.match(guide.note, /Empty entries are valid/);
  assert.equal(guide.signature.scope, 'global');
  for (const entry of guide.documentKeyExamples) {
    assert.equal(entry.expectedVersion, versions[entry.documentKey]);
    if (entry.documentKey.startsWith('global:')) { assert.equal(entry.value.scope, 'global'); assert.equal(entry.value.personId, null); }
    if (entry.documentKey.startsWith('person:') && typeof entry.value === 'object') { assert.equal(entry.value.scope, 'person'); assert.equal(entry.value.personId, 'a'); }
  }
});
test('unknown-person shape guide cannot suggest invented person document keys', () => {
  const run = { runId: 'unknown', inputVersions: { persona: 0, 'global:index': 0, 'global:codes': 0 }, input: { chat: [] } };
  const guide = JSON.parse(consolidationMessages(run, { personId: null })[1].content.slice('Value shape guide: '.length));
  assert.equal(guide.personMeta, null);
  assert.ok(guide.documentKeyExamples.every(entry => !entry.documentKey.startsWith('person:')));
});
test('a supplied identity ID is structurally checked before new-person effects can be persisted', () => {
  validateDecision({ identityPlan: { action: 'new', displayName: '林岚' } });
  validateDecision({ identityPlan: { action: 'new', personId: 'person_linlan', displayName: '林岚' } });
  assert.throws(() => validateDecision({ identityPlan: { action: 'new', personId: '../outside' } }), { code: 'SCHEMA_INVALID' });
  assert.throws(() => validateDecision({ identityPlan: { action: 'new', personId: '' } }), { code: 'SCHEMA_INVALID' });
});
