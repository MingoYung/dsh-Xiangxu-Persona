import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryRepository } from '../core/repository.js';
import { SELF_PROFILE_PATH, SELF_PROFILE_LIMITS, selfProfileLinks, validateSelfProfile } from '../core/self-profile.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiangxu-self-sources-'));
  let tick = 1000, repository = new MemoryRepository({ root, clock: () => ++tick });
  await repository.open();
  t.after(async () => { await repository.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, get repository() { return repository; },
    async reopen() { await repository.close(); repository = new MemoryRepository({ root, clock: () => ++tick }); await repository.open(); },
    async sources(count) {
      const rows = [];
      for (let i = 0; i < count; i++) rows.push((await repository.ingest({ personId: null, sourceSessionId: 'actual-source', sourceEventId: 'event-' + i,
        sourceKind: 'user', contentClass: 'participant_dialogue', channelId: 'fixture', role: 'user', text: 'retained fixture source ' + i })).record);
      return rows;
    } };
}
const ref = row => ({ sourceSessionId: row.sourceSessionId, sourceEventId: row.sourceEventId });
const profileBytes = f => fs.readFile(path.join(f.root, SELF_PROFILE_PATH));

test('27 complete source references deduplicate, reopen unchanged and withdraw the late source through current and history', async t => {
  const f = await fixture(t), rows = await f.sources(27), refs = rows.map(ref);
  const options = { sourceRefs: [...refs, refs[26], refs[0]] };
  await f.repository.updateSelfProfile({ initial: { name: 'initial suggestion' } }, { actor: 'user', ...options });
  await f.repository.updateSelfProfile({ current: { name: 'independently adopted name' } }, { actor: 'persona', ...options });
  const changed = await f.repository.updateSelfProfile({ current: { selfDescription: 'an unrelated retained field' } }, { actor: 'persona' });
  assert.deepEqual(changed.provenance.current.name.sourceRefs, refs);
  assert.deepEqual(changed.provenance.initial.name.sourceRefs, refs);
  assert.ok(changed.history.some(item => item.current.name === 'independently adopted name'));
  const saved = await profileBytes(f); await f.reopen();
  assert.deepEqual(await profileBytes(f), saved);
  assert.deepEqual((await f.repository.getSelfProfile()).provenance.current.name.sourceRefs, refs);
  await f.repository.forget({ ids: [rows[26].id], scope: 'unknown' });
  const clean = await f.repository.getSelfProfile();
  assert.equal(clean.current.name, ''); assert.equal(clean.initial.name, '');
  assert.equal(clean.current.selfDescription, 'an unrelated retained field');
  assert.ok(clean.history.every(item => item.current.name === '' && item.initial.name === ''));
  await assert.rejects(f.repository.updateSelfProfile({ current: { name: 'late reuse' } }, { actor: 'persona', sourceRefs: refs }), { code: 'SOURCE_REVOKED' });
  await f.reopen(); assert.equal((await f.repository.getSelfProfile()).current.name, '');
});

test('33 complete record identities deduplicate and withdrawing the 33rd identity still clears every derived profile version', async t => {
  const f = await fixture(t), rows = await f.sources(33), ids = rows.map(row => row.id);
  const options = { actor: 'persona', sourceRecordIds: [...ids, ids[32], ids[0]] };
  await f.repository.updateSelfProfile({ current: { name: 'independent name' } }, { actor: 'persona' });
  await f.repository.updateSelfProfile({ current: { selfDescription: 'first derived description' } }, options);
  const changed = await f.repository.updateSelfProfile({ current: { selfDescription: 'later derived description' } }, options);
  assert.deepEqual(changed.provenance.current.selfDescription.sourceRecordIds, ids);
  const saved = await profileBytes(f); await f.reopen(); assert.deepEqual(await profileBytes(f), saved);
  await f.repository.forget({ ids: [rows[32].id], scope: 'unknown' });
  const clean = await f.repository.getSelfProfile();
  assert.equal(clean.current.name, 'independent name'); assert.equal(clean.current.selfDescription, '');
  assert.ok(clean.history.every(item => item.current.selfDescription === ''));
  await assert.rejects(f.repository.updateSelfProfile({ current: { selfDescription: 'late reuse' } }, options), { code: 'SOURCE_REVOKED' });
});

test('a retained process expands all 27 participant sources without losing the last source from revocation', async t => {
  const f = await fixture(t), rows = await f.sources(27), refs = rows.map(ref);
  const root = { sourceSessionId: 'process-session', sourceEventId: 'tool-root', sourceRole: 'assistant', sourceOrigin: 'system' };
  const process = (await f.repository.captureHot({ personId: null, sourceRef: root, kind: 'tool_result', sourceKind: 'tool/result', origin: 'system',
    content: { mode: 'cached', text: JSON.stringify({ refs }) } })).record;
  const options = { actor: 'persona', sourceRecordIds: [process.id] };
  await f.repository.updateSelfProfile({ current: { name: 'first chosen name' } }, options);
  const changed = await f.repository.updateSelfProfile({ current: { name: 'later chosen name' } }, options);
  assert.equal(changed.provenance.current.name.sourceRefs.length, 28);
  for (const source of [root, ...refs]) assert.ok(changed.provenance.current.name.sourceRefs.some(item => item.sourceSessionId === source.sourceSessionId && item.sourceEventId === source.sourceEventId));
  assert.deepEqual(changed.provenance.current.name.sourceRecordIds, [process.id]);
  await f.reopen(); assert.equal((await f.repository.getSelfProfile()).provenance.current.name.sourceRefs.length, 28);
  await f.repository.forget({ ids: [rows[26].id], scope: 'unknown' });
  const clean = await f.repository.getSelfProfile();
  assert.equal(clean.current.name, ''); assert.ok(clean.history.every(item => item.current.name === ''));
});

test('complete provenance beyond the real 64 KiB profile budget is rejected atomically without dropping sources', async t => {
  const f = await fixture(t), rows = await f.sources(27);
  await f.repository.updateSelfProfile({ current: { name: 'preserved original' } }, { actor: 'persona' });
  const before = await profileBytes(f), meta = await f.repository.store.readJson('meta/state.json');
  const refs = rows.map(row => ({ ...ref(row), summary: 's'.repeat(2600) })), originalRefs = structuredClone(refs);
  assert.equal(selfProfileLinks({ sourceRefs: refs }).sourceRefs.length, 27);
  await assert.rejects(f.repository.updateSelfProfile({ current: { name: 'must not partially save' } }, { actor: 'persona', sourceRefs: refs }),
    error => error.code === 'CAPACITY_EXCEEDED' && error.resource === 'selfProfileBytes' && error.actual > SELF_PROFILE_LIMITS.profileBytes && error.limit === 65536);
  assert.deepEqual(refs, originalRefs); assert.deepEqual(await profileBytes(f), before);
  assert.deepEqual(await f.repository.store.readJson('meta/state.json'), meta);
  await f.reopen(); assert.deepEqual(await profileBytes(f), before);
});

test('byte-driven history rotation preserves the full current provenance and leaves the stored JSON format compatible', async t => {
  const f = await fixture(t), rows = await f.sources(27);
  const refs = rows.map(row => ({ ...ref(row), summary: 'bounded provenance '.repeat(12) }));
  let changed;
  for (let i = 0; i < 10; i++) changed = await f.repository.updateSelfProfile({ current: { name: 'chosen-' + i, selfDescription: 'unchanged self description' } }, { actor: 'persona', sourceRefs: refs });
  assert.equal(changed.schemaVersion, 'xiangxu-self/1');
  assert.equal(changed.current.name, 'chosen-9');
  assert.ok(changed.history.length > 0 && changed.history.length < SELF_PROFILE_LIMITS.history);
  assert.deepEqual(changed.provenance.current.name.sourceRefs, refs);
  assert.deepEqual(changed.provenance.current.selfDescription.sourceRefs, refs);
  for (const state of [changed, ...changed.history]) for (const source of Object.values(state.provenance.current)) assert.deepEqual(source.sourceRefs, refs);
  assert.ok((await profileBytes(f)).length <= SELF_PROFILE_LIMITS.profileBytes);
  assert.deepEqual(validateSelfProfile(changed), changed);
  const stored = await profileBytes(f); await f.reopen(); assert.deepEqual(await profileBytes(f), stored);
});
