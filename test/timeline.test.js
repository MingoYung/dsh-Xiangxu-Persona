import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MemoryRepository } from '../core/repository.js';
import { createBackup, restoreBackup, validateMemoryRoot } from '../core/maintenance.js';
const day = 86400000;
async function fixture(t, config = {}, fault = null) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xiangxu-timeline-')); let now = 10 * day;
  const repo = new MemoryRepository({ root: path.join(dir, 'memory'), config, clock: () => now, fault }); await repo.open();
  await repo.upsertPerson({ personId: 'a' }); await repo.upsertPerson({ personId: 'b' });
  t.after(async () => { await repo.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { repo, dir, advance: amount => { now += amount; }, write: async (id, text, extra = {}) => repo.ingest({ personId: 'a', role: 'user',
    sourceSessionId: 's', sourceEventId: id, sourceKind: 'user', contentClass: 'participant_dialogue', channelId: 'c', text, sourceAt: now, ...extra }) };
}
test('one unified source moves from recent to long term after three days without another model summary', async t => {
  const f = await fixture(t); const first = await f.write('one', '前因🙂经过\n结果');
  let result = await f.repo.browseTimeline({ tier: 'recent' }); assert.equal(result.total, 1);
  const initial = result.items[0]; assert.equal(initial.timeline.format, 'persona-timeline/1'); assert.equal(initial.timeline.feltThen, '');
  f.advance(3 * day + 1); const context = await f.repo.getContext({ personId: 'a' }); assert.equal(context.recentMemory.total, 0);
  result = await f.repo.browseTimeline({ tier: 'long_term' }); assert.equal(result.total, 1);
  assert.equal(result.items[0].id, first.record.id); assert.equal(result.items[0].text, initial.text); assert.deepEqual(result.items[0].timeline, initial.timeline);
  assert.equal((await f.repo.readSources({ eventIds: [first.eventId] }))[0].id, first.record.id);
  await f.repo.close(); await f.repo.open(); assert.equal((await f.repo.browseTimeline({ tier: 'long_term' })).total, 1);
});
test('oldest long-term records archive intact at Unicode text capacity and stay searchable', async t => {
  const f = await fixture(t, { longTermTargetChars: 5, recentTargetChars: 0 });
  const one = await f.write('one', '一🙂二'); const two = await f.write('two', '三🙂四');
  const state = await f.repo.getTimelineStatus(); assert.equal(state.long_term.chars, 3); assert.equal(state.archive.chars, 3); assert.equal(state.automaticDeletion, false);
  const archived = await f.repo.browseTimeline({ tier: 'archive' }); assert.equal(archived.total, 1); assert.equal(archived.items[0].id, one.record.id);
  assert.equal((await f.repo.search({ scope: 'all', query: '一🙂二' })).items[0].id, one.record.id);
  assert.equal((await f.repo.getMemoryRecord(two.record.id)).tier, 'long_term');
  assert.equal((await f.repo.ingest({ ...one.record })).duplicate, true);
});
test('equal source timestamps retain original admission order across tiers', async t => {
  const f = await fixture(t, { longTermTargetChars: 2, recentTargetChars: 0 });
  const ids = []; for (const text of ['甲', '乙', '丙']) ids.push((await f.write(text, text)).record.id);
  assert.deepEqual((await f.repo.browseTimeline({ tier: 'all' })).items.map(row => row.id), ids);
  assert.equal((await f.repo.browseTimeline({ tier: 'archive' })).items[0].id, ids[0]);
});
test('ordinary persona context and capacity do not scan long-term or archive bodies between real expiry and mutations', async t => {
  const f = await fixture(t, { longTermTargetChars: 5, recentTargetChars: 0 }); await f.write('old', '归档原件'); await f.write('other', '长期原文');
  await f.repo.clearPending((await f.repo.getPending()).map(row => row.eventId));
  const read = f.repo.store.readLines.bind(f.repo.store); const reads = [];
  f.repo.store.readLines = async name => { reads.push(name); if (name.startsWith('timeline/archive/') || name.startsWith('timeline/long/')) throw new Error('unexpected old body scan'); return read(name); };
  assert.equal((await f.repo.getContext({ personId: 'a' })).recentMemory.items.length, 0); await f.repo.getCapacity(); await f.repo.getPending();
  assert.equal(reads.some(name => name.startsWith('timeline/archive/')), false); f.repo.store.readLines = read;
});
test('original source reads and queued mail select only their actual archive shard', async t => {
  const f = await fixture(t, { longTermTargetChars: 0, recentTargetChars: 0 }); const one = await f.write('one', '仍待接收');
  const source = await f.repo.readSources({ sourceRefs: [{ sourceSessionId: 's', sourceEventId: 'one' }] });
  assert.equal(source[0].tier, 'archive'); assert.equal((await f.repo.getPending())[0].id, one.record.id);
});
test('archived unknown and assistant sources preserve true roles when associated', async t => {
  const f = await fixture(t, { longTermTargetChars: 0, recentTargetChars: 0 });
  const one = await f.write('assistant', '这是人格说的话', { personId: null, role: 'assistant', origin: 'ai_reply', speakerId: null });
  await f.repo.assign({ sourceSessionId: 's', sourceEventId: 'assistant', personId: 'b' });
  const row = await f.repo.getMemoryRecord(one.record.id); assert.equal(row.personId, 'b'); assert.equal(row.role, 'assistant'); assert.equal(row.speakerId, null); assert.equal(row.tier, 'archive');
});
test('autonomous timeline annotations can enrich an archived event without altering source text or times', async t => {
  const f = await fixture(t, { longTermTargetChars: 0, recentTargetChars: 0 }); const one = await f.write('one', '原话');
  const run = await f.repo.prepareConsolidation({ personId: 'a' });
  await f.repo.refreshConsolidationContext(run.runId);
  await f.repo.applyConsolidation(run, { entries: [{ documentKey: 'global:timeline', recordId: one.record.id, expectedVersion: run.inputVersions['global:timeline'],
    operation: 'upsert', value: { title: '一次相识', background: '刚认识', process: '互相问候', outcome: '继续交流', details: '保留细节', feltThen: '有些好奇', meaningNow: '现在仍想了解', indexCodes: ['相识'], relatedMemoryIds: [] } }] });
  const row = await f.repo.getMemoryRecord(one.record.id); assert.equal(row.text, '原话'); assert.equal(row.sourceAt, one.record.sourceAt); assert.equal(row.timeline.title, '一次相识'); assert.equal(row.timeline.feltThen, '有些好奇');
  assert.equal((await f.repo.getTimelineStatus()).archive.chars, 2 + ['一次相识','刚认识','互相问候','继续交流','保留细节','有些好奇','现在仍想了解'].reduce((sum, value) => sum + Array.from(value).length, 0));
});
test('annotation scope, immutable source fields and stale versions are rejected atomically', async t => {
  const f = await fixture(t); const a = await f.write('a', '甲'); const b = await f.write('b', '乙', { personId: 'b' });
  const run = await f.repo.prepareConsolidation({ personId: 'a' }); const entry = { documentKey: 'global:timeline', recordId: b.record.id, expectedVersion: run.inputVersions['global:timeline'], operation: 'upsert', value: { title: '越界' } };
  await assert.rejects(f.repo.applyConsolidation(run, { entries: [entry] }), /outside this run subject/);
  await assert.rejects(f.repo.applyConsolidation(run, { entries: [{ ...entry, recordId: a.record.id, value: { text: '改写原话' } }] }), /source fields cannot be changed/);
  await f.write('later', '后来'); await assert.rejects(f.repo.applyConsolidation(run, { entries: [{ ...entry, recordId: a.record.id }] }), { code: 'VERSION_CONFLICT' });
  assert.equal((await f.repo.getMemoryRecord(a.record.id)).timeline.title, '');
});
test('natural eviction archives rather than deleting and explicit forgetting still prevents replay', async t => {
  const f = await fixture(t); const one = await f.write('one', '不丢原话'); await f.repo.evictSources([one.record.id]);
  assert.equal((await f.repo.getMemoryRecord(one.record.id)).tier, 'archive');
  await f.repo.forget({ ids: [one.record.id] }, { personId: 'a' });
  assert.equal(await f.repo.getMemoryRecord(one.record.id), null); assert.equal((await f.repo.browseTimeline({ tier: 'archive' })).total, 0);
  assert.equal((await f.write('one', '不应复活')).revoked, true);
});
test('WAL recovery completes relocation after interruption between active and archive writes', async t => {
  let armed = false; const f = await fixture(t, { recentTargetChars: 0, longTermTargetChars: 3 }, (phase, data) => { if (armed && phase === 'after_apply' && data.path.startsWith('timeline/archive/')) { armed = false; throw new Error('interrupted relocation'); } });
  const one = await f.write('one', '甲乙丙'); armed = true; await assert.rejects(f.write('two', '丁戊己'), /interrupted relocation/);
  await f.repo.close(); await f.repo.open(); const rows = (await f.repo.browseTimeline({ tier: 'all' })).items;
  assert.equal(rows.length, 2); assert.equal(new Set(rows.map(row => row.id)).size, 2); assert.equal((await f.repo.getMemoryRecord(one.record.id)).tier, 'archive');
});
test('backup contains archive originals and newer forgetting survives restoring an older backup', async t => {
  const f = await fixture(t, { recentTargetChars: 0, longTermTargetChars: 0 }); const one = await f.write('one', '曾经的完整原文');
  await f.repo.close(); const backup = path.join(f.dir, 'backup'); await createBackup({ root: f.repo.root, destination: backup });
  assert.ok((await validateMemoryRoot(f.repo.root)).files.some(row => row.path.startsWith('timeline/archive/')));
  await f.repo.open(); await f.repo.forget({ ids: [one.record.id] }, { personId: 'a' }); await f.repo.close();
  await restoreBackup({ root: f.repo.root, source: backup }); await f.repo.open();
  assert.equal((await f.repo.browseTimeline({ tier: 'all' })).total, 0); assert.equal((await f.write('one', '不能复活')).revoked, true);
});
test('an actual store hard limit refuses admission atomically without deleting archived or active memory', async t => {
  const f = await fixture(t, { recentTargetChars: 0, longTermTargetChars: 2 }); await f.write('old', '旧事'); await f.write('new', '新事');
  const before = await f.repo.browseTimeline({ tier: 'all' }), limits = f.repo.store.capacityLimits;
  f.repo.store.capacityLimits = { ...limits, storeBytes: 1 };
  await assert.rejects(f.write('blocked', '容量真的不足'), { code: 'CAPACITY_EXCEEDED' });
  f.repo.store.capacityLimits = limits;
  const after = await f.repo.browseTimeline({ tier: 'all' }); assert.deepEqual(after.items, before.items);
  assert.equal(after.items.length, 2);
});
test('changed valid-JSON archive bytes cannot be silently indexed or overwritten by the next archive append', async t => {
  const f = await fixture(t, { recentTargetChars: 0, longTermTargetChars: 0 }); await f.write('one', '甲');
  const state = await f.repo.getTimelineStatus(), archive = path.join(f.repo.root, state.archiveFiles[0].path);
  const raw = await fs.readFile(archive, 'utf8'); await fs.writeFile(archive, raw.replace('甲', '乙'));
  await assert.rejects(f.write('two', '新原文'), { code: 'TIMELINE_ARCHIVE_CORRUPT' });
  assert.equal(await fs.readFile(archive, 'utf8'), raw.replace('甲', '乙'));
  await assert.rejects(f.repo.readSources({ sourceRefs: [{ sourceSessionId: 's', sourceEventId: 'one' }] }), { code: 'TIMELINE_ARCHIVE_CORRUPT' });
});
test('a forged source storage path cannot turn source reads into arbitrary memory-file reads', async t => {
  const f = await fixture(t); const one = await f.write('one', '原话');
  const meta = await f.repo.store.readJson('meta/state.json'); meta.sources[JSON.stringify(['s', 'one'])].storagePath = 'self/persona.json';
  await f.repo.store.transaction({ json: { 'meta/state.json': meta } });
  await assert.rejects(f.repo.readSources({ eventIds: [one.eventId] }), /outside timeline storage/);
});
test('annotation dependencies retract only derived fields while retaining the original event across old-backup restore', async t => {
  const f = await fixture(t, { recentTargetChars: 0, longTermTargetChars: 0 }); const a = await f.write('a', 'A原话应保留');
  let run = await f.repo.prepareConsolidation({ personId: 'a' }); await f.repo.applyConsolidation(run, { entries: [] });
  const b = await f.write('b', 'B说出的新信息'); run = await f.repo.prepareConsolidation({ personId: 'a' });
  await f.repo.applyConsolidation(run, { entries: [{ documentKey: 'global:timeline', recordId: a.record.id,
    expectedVersion: run.inputVersions['global:timeline'], operation: 'upsert', value: { title: '由B带来的理解', meaningNow: '这是B的新信息形成的看法' } }] });
  const annotated = await f.repo.getMemoryRecord(a.record.id); assert.ok(annotated.timeline.provenance.meaningNow.refs.some(ref => ref.sourceEventId === 'b'));
  await f.repo.close(); const backup = path.join(f.dir, 'with-annotation'); await createBackup({ root: f.repo.root, destination: backup }); await f.repo.open();
  await f.repo.forget({ ids: [b.record.id] }, { personId: 'a' });
  let remaining = await f.repo.getMemoryRecord(a.record.id); assert.equal(remaining.text, 'A原话应保留'); assert.equal(remaining.timeline.meaningNow, ''); assert.equal(remaining.timeline.title, '');
  await f.repo.close(); await restoreBackup({ root: f.repo.root, source: backup }); await f.repo.open();
  remaining = await f.repo.getMemoryRecord(a.record.id); assert.equal(remaining.text, 'A原话应保留'); assert.equal(remaining.timeline.meaningNow, ''); assert.equal(await f.repo.getMemoryRecord(b.record.id), null);
});
test('missing required persona, state and metadata documents are never substituted by empty defaults', async t => {
  for (const name of ['self/persona.json', 'global/state.json', 'meta/state.json', 'config.json']) {
    const f = await fixture(t); await f.write('one', '保留'); await f.repo.close();
    const file = path.join(f.repo.root, name), raw = await fs.readFile(file); await fs.unlink(file);
    await assert.rejects(f.repo.open(), { code: 'MEMORY_REQUIRED_DOCUMENT_MISSING' });
    await assert.rejects(fs.access(file), { code: 'ENOENT' }); await fs.writeFile(file, raw);
  }
});
test('a known active source file cannot disappear and be silently replaced by an empty timeline', async t => {
  for (const config of [{}, { recentTargetChars: 0 }]) {
    const f = await fixture(t, config); const one = await f.write('one', '有原件'); await f.repo.close();
    const meta = await fs.readFile(path.join(f.repo.root, 'meta/state.json')), catalog = await fs.readFile(path.join(f.repo.root, 'timeline/catalog.json'));
    const receipt = JSON.parse(meta).sources[JSON.stringify(['s', 'one'])], file = path.join(f.repo.root, receipt.storagePath), raw = await fs.readFile(file); await fs.unlink(file);
    await assert.rejects(f.repo.open(), { code: 'MEMORY_SOURCE_UNAVAILABLE' });
    assert.deepEqual(await fs.readFile(path.join(f.repo.root, 'meta/state.json')), meta); assert.deepEqual(await fs.readFile(path.join(f.repo.root, 'timeline/catalog.json')), catalog);
    await fs.writeFile(file, raw); await f.repo.open(); assert.equal((await f.repo.getMemoryRecord(one.record.id)).text, '有原件');
  }
});
test('a legacy naturally-evicted receipt remains unavailable without blocking migration or inventing original text', async t => {
  const f = await fixture(t);
  const meta = await f.repo.store.readJson('meta/state.json'); meta.sources[JSON.stringify(['old', 'missing'])] = { id: 'legacy_missing', eventId: 'ev_00000000000000000001', lastEventId: 'ev_00000000000000000001', personId: 'a', sourceAt: 1 };
  await f.repo.store.transaction({ json: { 'meta/state.json': meta } }); await f.repo.close(); await f.repo.open();
  assert.deepEqual(await f.repo.readSources({ sourceRefs: [{ sourceSessionId: 'old', sourceEventId: 'missing' }] }), []);
  assert.equal((await f.repo.getContext({ personId: 'a' })).recentMemory.total, 0);
});
test('archive shard counters may not go backward or overwrite an unregistered occupied file', async t => {
  const f = await fixture(t, { recentTargetChars: 0, longTermTargetChars: 0 }); await f.write('one', '旧档');
  const catalogPath = path.join(f.repo.root, 'timeline/catalog.json'), raw = await fs.readFile(catalogPath), catalog = JSON.parse(raw);
  const oldPath = path.join(f.repo.root, catalog.archiveFiles[0].path), original = await fs.readFile(oldPath);
  await fs.writeFile(catalogPath, JSON.stringify({ ...catalog, nextShard: 1 }));
  await assert.rejects(f.repo.getTimelineStatus(), /reuse an existing shard/); assert.deepEqual(await fs.readFile(oldPath), original); await fs.writeFile(catalogPath, raw);
  // A single record larger than the shard's soft page cap fills its own shard.
  await f.write('huge', '大'.repeat(400000));
  const current = await f.repo.getTimelineStatus(), collision = path.join(f.repo.root, 'timeline/archive/' + String(current.nextShard).padStart(8, '0') + '.jsonl');
  await fs.writeFile(collision, 'do not overwrite this file');
  await assert.rejects(f.write('new-shard', '新记录'), { code: 'TIMELINE_ARCHIVE_COLLISION' });
  assert.equal(await fs.readFile(collision, 'utf8'), 'do not overwrite this file'); assert.deepEqual(await fs.readFile(oldPath), original);
});
test('a previously saved self profile and established timeline catalog cannot fall back to an empty identity', async t => {
  const f = await fixture(t); await f.repo.updateSelfProfile({ current: { name: '已保存的名字' } }, { actor: 'persona' }); await f.write('one', '已有经历');
  const profile = path.join(f.repo.root, 'self/profile.json'), profileRaw = await fs.readFile(profile);
  await fs.unlink(profile); await assert.rejects(f.repo.getContext({ personId: 'a' }), { code: 'MEMORY_REQUIRED_DOCUMENT_MISSING' });
  await f.repo.close(); await assert.rejects(f.repo.open(), { code: 'MEMORY_REQUIRED_DOCUMENT_MISSING' }); await fs.writeFile(profile, profileRaw); await f.repo.open();
  const catalog = path.join(f.repo.root, 'timeline/catalog.json'), raw = await fs.readFile(catalog); await fs.unlink(catalog);
  await assert.rejects(f.repo.getContext({ personId: 'a' }), { code: 'MEMORY_REQUIRED_DOCUMENT_MISSING' });
  await fs.writeFile(catalog, raw); assert.equal((await f.repo.getContext({ personId: 'a' })).selfProfile.current.name, '已保存的名字');
});
