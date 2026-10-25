import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryRepository } from '../core/repository.js';
import { sourceKey } from '../core/schema.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'persona-management-read-')), repo = new MemoryRepository({ root, clock: () => 5000 });
  await repo.open(); await repo.upsertPerson({ personId: 'a', displayName: '甲' });
  t.after(async () => { await repo.close(); await rm(root, { recursive: true, force: true }); }); return { root, repo };
}
const chat = (id, personId = null, role = 'user') => ({ sourceSessionId: 'test-session', sourceEventId: id, personId, sourceKind: role, contentClass: 'participant_dialogue', role, text: `原件${id}😀`, sourceAt: 1000, observedAt: 2000, channelId: 'test-channel' });

test('management browse traverses more than 1000 retained originals without inventing people or changing sources', async t => {
  const { repo, root } = await fixture(t), initial = (await repo.ingest(chat('seed', 'a'))).record;
  const rows = Array.from({ length: 1005 }, (_value, index) => ({ ...initial, id: `r_${index}`, sourceEventId: `source_${index}`, eventId: `ev_${String(index + 1).padStart(20, '0')}` }));
  const meta = await repo.store.readJson('meta/state.json'); meta.sequence = 1005;
  meta.sources = Object.fromEntries(rows.map(row => [sourceKey(row), { id: row.id, eventId: row.eventId, lastEventId: row.eventId, personId: row.personId, sourceAt: row.sourceAt }])); meta.pending = [];
  await repo.store.transaction({ json: { 'meta/state.json': meta }, jsonl: { 'people/a/stream.jsonl': rows } });
  const before = await readFile(join(root, 'meta/state.json'), 'utf8'), ids = [];
  let offset = 0, revision;
  do { const page = await repo.browseMemory({ scope: 'person', targetPersonId: 'a', limit: 100, offset });
    assert.equal(page.total, 1005); if (revision) assert.equal(page.revision, revision); revision = page.revision;
    ids.push(...page.items.map(row => row.id)); offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(new Set(ids).size, 1005); assert.equal(ids.length, 1005);
  assert.equal(await readFile(join(root, 'meta/state.json'), 'utf8'), before);
  await assert.rejects(repo.browseMemory({ scope: 'person', targetPersonId: 'uncreated' }), { code: 'UNKNOWN_PERSON_TARGET' });
  assert.deepEqual((await repo.listPeople()).map(row => row.personId), ['a']);
  await assert.rejects(repo.browseMemory({ limit: 101 }));
  await assert.rejects(repo.browseMemory({ offset: -1 }));
});

test('unknown browser contains staged originals, global excludes them, and removed originals remain unavailable', async t => {
  const { repo } = await fixture(t), unknown = (await repo.ingest(chat('unknown-assistant', null, 'assistant'))).record;
  await repo.ingest(chat('known', 'a'));
  assert.deepEqual((await repo.browseMemory({ scope: 'unknown' })).items.map(row => row.id), [unknown.id]);
  assert.equal((await repo.browseMemory({ scope: 'global' })).items.length, 0);
  const fetched = await repo.getMemoryRecord(unknown.id); assert.equal(fetched.role, 'assistant'); assert.equal(fetched.speakerId, null); assert.equal(fetched.text, unknown.text);
  assert.equal((await repo.forget({ ids: [unknown.id], reason: '未指定范围' })).needsTarget, true);
  await repo.forget({ ids: [unknown.id], scope: 'unknown', reason: '用户明确删除' });
  assert.equal(await repo.getMemoryRecord(unknown.id), null);
  assert.equal((await repo.browseMemory({ scope: 'unknown' })).total, 0);
});

test('explicit global revocation only selects named global entries and unknown scopes cannot become a before-time wipe', async t => {
  const { repo } = await fixture(t), unknown = (await repo.ingest(chat('keep-unknown'))).record;
  await repo.store.transaction({ json: { 'global/index.json': { schemaVersion: 'persona-memory/3', version: 1, updatedAt: 5000, items: [{ schemaVersion: 'persona-memory/3', id: 'global-item', scope: 'global', personId: null,
    epistemic: 'interpretation', srcRefs: [], createdAt: 5000, updatedAt: 5000, retractedBy: null, kind: 'pattern', text: '共同记忆', keys: [], importance: null }] } } });
  assert.equal((await repo.browseMemory({ scope: 'global' })).total, 1);
  await assert.rejects(repo.forget({ ids: [unknown.id], scope: 'unknown', before: 10000 }));
  assert.equal((await repo.forget({ scope: 'unknown', ids: [] })).needsSelection, true);
  const result = await repo.forget({ ids: ['global-item'], scope: 'global', reason: '用户明确移除此共同条目' });
  assert.equal(result.revocation.personId, null); assert.equal(result.revocation.scope, 'global');
  assert.equal((await repo.browseMemory({ scope: 'global' })).total, 0);
  assert.equal((await repo.getMemoryRecord(unknown.id)).text, unknown.text);
});

test('common-personality projection defaults omitted shared scope without rewriting persona or mixing staged speakers', async t => {
  const { repo, root } = await fixture(t), original = (await repo.ingest(chat('staged-actor', null, 'assistant'))).record;
  const persona = await repo.getPersona(), metadata = { schemaVersion: 'persona-memory/3', epistemic: 'interpretation', srcRefs: [], createdAt: 5000, updatedAt: 5000 };
  // Simulate an older stored shared entry that omitted catalogue scope metadata.
  persona.habits.push({ ...metadata, id: 'shared-habit', text: '相处时慢慢说话' }, { ...metadata, id: 'personal-habit', text: '只在这段关系里的习惯', scope: 'person', personId: 'a' });
  await repo.store.transaction({ json: { 'self/persona.json': persona } });
  const before = await readFile(join(root, 'self/persona.json'), 'utf8');
  const global = await repo.browseMemory({ scope: 'global', recordType: 'habit' });
  assert.deepEqual(global.items.map(row => row.id), ['shared-habit']); assert.equal(global.items[0].scope, 'global'); assert.equal(global.items[0].personId, null);
  assert.deepEqual((await repo.browseMemory({ scope: 'person', targetPersonId: 'a', recordType: 'habit' })).items.map(row => row.id), ['personal-habit']);
  assert.deepEqual((await repo.browseMemory({ scope: 'unknown' })).items.map(row => row.id), [original.id]);
  assert.equal(await readFile(join(root, 'self/persona.json'), 'utf8'), before);
  await repo.forget({ ids: ['shared-habit'], scope: 'global', reason: '用户明确遗忘共同习惯' });
  assert.equal((await repo.browseMemory({ scope: 'global', recordType: 'habit' })).total, 0);
  assert.deepEqual((await repo.getPersona()).habits.map(row => row.id), ['personal-habit']);
  const after = await repo.getMemoryRecord(original.id); assert.equal(after.text, original.text); assert.equal(after.role, 'assistant'); assert.equal(after.speakerId, null); assert.equal(after.sourceEventId, original.sourceEventId);
});
