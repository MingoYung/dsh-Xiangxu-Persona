import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryRepository } from '../core/repository.js';
import { SELF_PROFILE_PATH, SELF_PROFILE_LIMITS, validateSelfProfile, selfProfileDependencies } from '../core/self-profile.js';
import { createBackup, restoreBackup, validateMemoryRoot } from '../core/maintenance.js';

async function fixture(t, { config = {}, fault } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiangxu-self-'));
  const clock = { value: 1000 };
  let repository = new MemoryRepository({ root, config, fault, clock: () => clock.value });
  await repository.open();
  t.after(async () => { await repository.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, clock, get repository() { return repository; },
    async reopen() { await repository.close(); repository = new MemoryRepository({ root, clock: () => clock.value }); await repository.open(); return repository; } };
}
const chat = (id, text, personId = null) => ({ sourceSessionId: 'source', sourceEventId: id, personId,
  channelId: 'dsh:source', sourceKind: 'user', contentClass: 'participant_dialogue', role: 'user', text });
const ref = id => ({ sourceSessionId: 'source', sourceEventId: id });
const bytes = f => fs.readFile(path.join(f.root, SELF_PROFILE_PATH));

test('old instances read an optional empty profile without inventing dates, identity, files or new versions', async t => {
  const f = await fixture(t);
  const beforePersona = await fs.readFile(path.join(f.root, 'self/persona.json'));
  const first = await f.repository.getSelfProfile(); f.clock.value += 86400000;
  assert.deepEqual(await f.repository.getSelfProfile(), first);
  assert.equal(first.createdAt, null); assert.equal(first.updatedAt, null); assert.equal(first.version, 0);
  assert.equal(first.mode, 'unset'); assert.equal(first.onboardingAcknowledged, false);
  assert.ok(Object.values(first.current).every(value => value === ''));
  await assert.rejects(fs.access(path.join(f.root, SELF_PROFILE_PATH)), { code: 'ENOENT' });
  await f.repository.updateSelfProfile({}, { actor: 'user' });
  await assert.rejects(fs.access(path.join(f.root, SELF_PROFILE_PATH)), { code: 'ENOENT' });
  await f.reopen();
  assert.deepEqual(await f.repository.getSelfProfile(), first);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'self/persona.json')), beforePersona);
});

test('initial wishes and current self description persist separately, without deriving age, traits or appearance', async t => {
  const f = await fixture(t);
  const seed = await f.repository.updateSelfProfile({ mode: 'together', onboardingAcknowledged: true,
    initial: { name: '小续', gender: '女性形象', ageDescription: '二十五岁左右', birthday: '以后再定', background: '虚拟背景，尚未选定' } }, { actor: 'user', expectedVersion: 0 });
  assert.equal(seed.createdAt, 1000); assert.equal(seed.current.name, ''); assert.equal(seed.current.gender, '');
  f.clock.value = 2000;
  const adopted = await f.repository.updateSelfProfile({ current: { name: '相续', pronouns: '她', selfDescription: '我还在认识自己，也可以保持未定。' } }, { actor: 'persona', expectedVersion: seed.version });
  assert.equal(adopted.initial.name, '小续'); assert.equal(adopted.current.name, '相续');
  assert.equal(adopted.current.ageDescription, ''); assert.equal(adopted.current.gender, '');
  assert.equal(adopted.createdAt, 1000); assert.equal(adopted.updatedAt, 2000);
  assert.equal(adopted.provenance.initial.name.actor, 'user'); assert.equal(adopted.provenance.current.name.actor, 'persona');
  const saved = await bytes(f); f.clock.value += 30 * 365 * 86400000;
  await f.reopen(); assert.deepEqual(await bytes(f), saved);
  assert.deepEqual(await f.repository.getSelfProfile(), adopted);
  const newerWish = await f.repository.updateSelfProfile({ initial: { name: '另一个建议' } }, { actor: 'user', expectedVersion: adopted.version });
  assert.equal(newerWish.current.name, '相续'); assert.equal(newerWish.initial.name, '另一个建议');
});

test('onboarding acknowledgment is a user preference and does not require invented persona content', async t => {
  const f = await fixture(t);
  const profile = await f.repository.updateSelfProfile({ mode: 'unset', onboardingAcknowledged: true }, { actor: 'user' });
  assert.equal(profile.onboardingAcknowledged, true); assert.ok(Object.values(profile.current).every(value => value === ''));
  for (const patch of [{ mode: 'autonomous' }, { onboardingAcknowledged: false }, { initial: { name: 'forced' } }]) {
    await assert.rejects(f.repository.updateSelfProfile(patch, { actor: 'persona' }), { code: 'SELF_PROFILE_SCOPE' });
  }
  assert.deepEqual(await f.repository.getSelfProfile(), profile);
});

test('no-op saves preserve bytes and CAS refuses stale concurrent profile writes', async t => {
  const f = await fixture(t);
  const first = await f.repository.updateSelfProfile({ current: { name: '相续' } }, { actor: 'persona', expectedVersion: 0 });
  const saved = await bytes(f), meta = await f.repository.store.readJson('meta/state.json'); f.clock.value++;
  const noOp = await f.repository.updateSelfProfile({ current: { name: '相续' } }, { actor: 'persona', expectedVersion: first.version });
  assert.equal(noOp.version, first.version); assert.deepEqual(await bytes(f), saved);
  assert.equal((await f.repository.store.readJson('meta/state.json')).version, meta.version);
  const results = await Promise.allSettled([
    f.repository.updateSelfProfile({ current: { name: '相续甲' } }, { actor: 'persona', expectedVersion: first.version }),
    f.repository.updateSelfProfile({ current: { name: '相续乙' } }, { actor: 'persona', expectedVersion: first.version }),
  ]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'VERSION_CONFLICT');
  assert.equal((await f.repository.getSelfProfile()).current.name, '相续甲');
});

test('current text remains intact while bounded history rotates and UTF-32 character limits reject before mutation', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 12; i++) { f.clock.value++; await f.repository.updateSelfProfile({ current: { name: '相续' + i, ageDescription: '未定' } }, { actor: 'persona' }); }
  const profile = await f.repository.getSelfProfile(); assert.equal(profile.history.length, SELF_PROFILE_LIMITS.history);
  assert.equal(profile.current.name, '相续11'); assert.equal(profile.history[0].current.name, '相续3');
  const saved = await bytes(f);
  await assert.rejects(f.repository.updateSelfProfile({ current: { background: '😀'.repeat(SELF_PROFILE_LIMITS.sectionChars + 1) } }, { actor: 'persona' }), { code: 'CAPACITY_EXCEEDED' });
  await assert.rejects(f.repository.updateSelfProfile({ current: { name: 23 } }, { actor: 'persona' }), { code: 'SCHEMA_INVALID' });
  await assert.rejects(f.repository.updateSelfProfile({ current: { maturity: '必须成熟' } }, { actor: 'persona' }), { code: 'SCHEMA_INVALID' });
  assert.deepEqual(await bytes(f), saved);
  assert.ok(saved.length < SELF_PROFILE_LIMITS.profileBytes);
});

test('self profile has independent semantic limits and cannot bypass physical instance capacity', async t => {
  const f = await fixture(t);
  const first = await f.repository.updateSelfProfile({ current: { name: '相续' } }, { actor: 'persona' });
  const capacity = await f.repository.getCapacity(); assert.ok(capacity.semanticChars >= 2);
  await f.repository.updateConfig({ longTermTargetChars: 0 });
  const second = await f.repository.updateSelfProfile({ current: { background: '长'.repeat(200) } }, { actor: 'persona', expectedVersion: first.version });
  const saved = await bytes(f), limits = f.repository.store.capacityLimits;
  f.repository.store.capacityLimits = { ...limits, storeBytes: 1 };
  await assert.rejects(f.repository.updateSelfProfile({ current: { name: '另一个名字' } }, { actor: 'persona', expectedVersion: second.version }), { code: 'CAPACITY_EXCEEDED' });
  f.repository.store.capacityLimits = limits;
  assert.deepEqual(await bytes(f), saved);
});

test('explicit source withdrawal cleans current, initial and old versions and rejects late reuse', async t => {
  const f = await fixture(t);
  const original = await f.repository.ingest(chat('old', '我希望你叫小续。'));
  await f.repository.updateSelfProfile({ initial: { name: '小续' } }, { actor: 'user', sourceRefs: [ref('old')] });
  await f.repository.updateSelfProfile({ current: { name: '小续' } }, { actor: 'persona', sourceRecordIds: [original.record.id] });
  await f.repository.updateSelfProfile({ current: { selfDescription: '保留独立的自我描述' } }, { actor: 'persona' });
  const material = await f.repository.getContext(); assert.equal(material.selfProfile.current.name, '小续');
  const dependencies = selfProfileDependencies(material.selfProfile);
  assert.ok(dependencies.refs.some(item => item.sourceEventId === 'old'));
  assert.ok(dependencies.recordIds.includes(original.record.id));
  assert.ok(material.sourceDependencies.refs.some(item => item.sourceEventId === 'old'));
  assert.ok(material.sourceDependencies.recordIds.includes(original.record.id));
  await f.repository.saveSnapshot({ requestId: 'with-profile', injectedIds: [], injectedText: '小续', sourceDependencies: dependencies });
  await f.repository.forget({ ids: [original.record.id], scope: 'unknown' });
  const clean = await f.repository.getSelfProfile();
  assert.equal(clean.current.name, ''); assert.equal(clean.initial.name, ''); assert.equal(clean.current.selfDescription, '保留独立的自我描述');
  assert.ok(clean.history.every(item => item.current.name === '' && item.initial.name === ''));
  assert.equal((await f.repository.getSnapshots()).length, 0);
  await assert.rejects(f.repository.updateSelfProfile({ current: { name: '迟到旧值' } }, { actor: 'persona', sourceRefs: [ref('old')] }), { code: 'SOURCE_REVOKED' });
  await assert.rejects(f.repository.updateSelfProfile({ current: { name: '迟到旧值' } }, { actor: 'persona', sourceRecordIds: [original.record.id] }), { code: 'SOURCE_REVOKED' });
  const saved = await bytes(f); await f.reopen(); assert.deepEqual(await bytes(f), saved);
});

test('explicit independent owner correction preserves the current value after earlier source is withdrawn', async t => {
  const f = await fixture(t);
  const original = await f.repository.ingest(chat('old', '一个早先的名字。'));
  await f.repository.updateSelfProfile({ current: { name: '相续' } }, { actor: 'persona', sourceRefs: [ref('old')] });
  await f.repository.updateSelfProfile({ current: { name: '相续' } }, { actor: 'user' });
  await f.repository.forget({ ids: [original.record.id], scope: 'unknown' });
  const current = await f.repository.getSelfProfile();
  assert.equal(current.current.name, '相续'); assert.equal(current.provenance.current.name.actor, 'user');
  assert.ok(current.history.every(item => item.current.name === ''));
});

test('a restored older optional profile cannot expose withdrawn text through reads or reopen cleanup', async t => {
  const f = await fixture(t);
  const original = await f.repository.ingest(chat('old', '撤销这份背景。'));
  await f.repository.updateSelfProfile({ current: { background: '旧背景' } }, { actor: 'persona', sourceRefs: [ref('old')] });
  const legacy = JSON.parse((await bytes(f)).toString('utf8')); delete legacy.onboardingAcknowledged;
  await f.repository.forget({ ids: [original.record.id], scope: 'unknown' });
  await f.repository.store.transaction({ json: { [SELF_PROFILE_PATH]: legacy } });
  const guarded = await f.repository.getSelfProfile(); assert.equal(guarded.current.background, ''); assert.equal(guarded.onboardingAcknowledged, false);
  await f.reopen();
  const saved = JSON.parse((await bytes(f)).toString('utf8'));
  assert.equal(saved.current.background, ''); assert.equal(saved.version, legacy.version + 1);
  assert.ok(!JSON.stringify(saved).includes('旧背景'));
});

test('profile WAL recovers the complete version and meta after an interrupted atomic batch', async t => {
  let fail = false;
  const f = await fixture(t, { fault: (phase, detail) => { if (fail && phase === 'after_apply' && detail.path === SELF_PROFILE_PATH) throw new Error('injected profile power loss'); } });
  await f.repository.updateSelfProfile({ current: { name: '旧名字' } }, { actor: 'persona' });
  const beforeMeta = await f.repository.store.readJson('meta/state.json'); fail = true;
  await assert.rejects(f.repository.updateSelfProfile({ current: { name: '新名字' } }, { actor: 'persona', expectedVersion: 1 }), /power loss/);
  await assert.rejects(f.repository.getSelfProfile(), { code: 'RECOVERY_REQUIRED' });
  await f.reopen();
  assert.equal((await f.repository.getSelfProfile()).current.name, '新名字');
  assert.equal((await f.repository.getSelfProfile()).version, 2);
  assert.equal((await f.repository.store.readJson('meta/state.json')).version, beforeMeta.version + 1);
});

test('invalid stored self profile is preserved rather than replaced with an apparently empty identity', async t => {
  const f = await fixture(t);
  await f.repository.updateSelfProfile({ current: { name: '相续' } }, { actor: 'persona' });
  await f.repository.close();
  const file = path.join(f.root, SELF_PROFILE_PATH), invalid = Buffer.from('{"schemaVersion":"future-self/99","version":7}');
  await fs.writeFile(file, invalid);
  await assert.rejects(f.reopen(), { code: 'SCHEMA_INVALID' });
  assert.deepEqual(await fs.readFile(file), invalid);
});

test('memory availability keeps source receipts separate from store emptiness and from person association', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.repository.getContext()).memoryAvailability, { knownSourceCount: 0, personAssociation: 'unassociated', storeContent: 'not_assessed' });
  const original = await f.repository.ingest(chat('receipt', '原记录'));
  await f.repository.evictSources([original.record.id]);
  assert.equal((await f.repository.getContext()).memoryAvailability.knownSourceCount, 1);
  await f.repository.upsertPerson({ personId: 'known' });
  assert.equal((await f.repository.getContext({ personId: 'known' })).memoryAvailability.personAssociation, 'associated');
  const profile = await f.repository.getSelfProfile();
  assert.equal(validateSelfProfile(profile).createdAt, null);
});

test('offline backup validates optional self-profile schema and restores complete current and initial information', async t => {
  const f = await fixture(t), destination = f.root + '-backup';
  t.after(() => fs.rm(destination, { recursive: true, force: true }));
  await f.repository.updateSelfProfile({ mode: 'together', onboardingAcknowledged: true, initial: { name: '小续', ageDescription: '成年形象' } }, { actor: 'user' });
  await f.repository.updateSelfProfile({ current: { name: '相续', gender: '暂未确定' } }, { actor: 'persona' });
  const before = await f.repository.getSelfProfile(); await f.repository.close();
  assert.ok((await validateMemoryRoot(f.root)).files.some(item => item.path === SELF_PROFILE_PATH));
  const receipt = await createBackup({ root: f.root, destination });
  assert.ok(receipt.files.some(item => item.path === SELF_PROFILE_PATH));
  await f.repository.open();
  await f.repository.updateSelfProfile({ current: { name: '新值' } }, { actor: 'persona' });
  await f.repository.close();
  const restored = await restoreBackup({ root: f.root, source: destination });
  t.after(() => restored.rollback && fs.rm(restored.rollback, { recursive: true, force: true }));
  assert.deepEqual(JSON.parse((await bytes(f)).toString('utf8')), before);
  await f.repository.open(); assert.deepEqual(await f.repository.getSelfProfile(), before);
});

test('restore carries newer source withdrawals into a legacy profile before exposing the restored directory', async t => {
  const f = await fixture(t), destination = f.root + '-backup';
  t.after(() => fs.rm(destination, { recursive: true, force: true }));
  const original = await f.repository.ingest(chat('forget-after-backup', '这份旧身份想法后来撤销。'));
  await f.repository.updateSelfProfile({ initial: { name: '旧初始名' } }, { actor: 'user', sourceRefs: [ref('forget-after-backup')] });
  await f.repository.updateSelfProfile({ current: { name: '旧当前名' } }, { actor: 'persona', sourceRecordIds: [original.record.id] });
  await f.repository.updateSelfProfile({ current: { selfDescription: '独立保留的信息' } }, { actor: 'persona' });
  await f.repository.close(); await createBackup({ root: f.root, destination });
  await f.repository.open(); await f.repository.forget({ ids: [original.record.id], scope: 'unknown' }); await f.repository.close();
  const restored = await restoreBackup({ root: f.root, source: destination });
  t.after(() => restored.rollback && fs.rm(restored.rollback, { recursive: true, force: true }));
  // Read before opening MemoryRepository: the restored public file is already cleaned.
  const offline = JSON.parse((await bytes(f)).toString('utf8'));
  assert.equal(offline.initial.name, ''); assert.equal(offline.current.name, ''); assert.equal(offline.current.selfDescription, '独立保留的信息');
  assert.ok(offline.history.every(item => item.initial.name === '' && item.current.name === ''));
  await validateMemoryRoot(f.root);
  await f.repository.open(); assert.equal((await f.repository.getSelfProfile()).current.name, '');
});

test('maintenance still rejects a future self-profile schema and does not replace original bytes', async t => {
  const f = await fixture(t), destination = f.root + '-backup';
  t.after(() => fs.rm(destination, { recursive: true, force: true }));
  await f.repository.updateSelfProfile({ current: { name: '相续' } }, { actor: 'persona' });
  await f.repository.close();
  const invalid = Buffer.from('{"schemaVersion":"xiangxu-self/999","version":1}');
  await fs.writeFile(path.join(f.root, SELF_PROFILE_PATH), invalid);
  await assert.rejects(validateMemoryRoot(f.root), { code: 'SCHEMA_INVALID' });
  await assert.rejects(createBackup({ root: f.root, destination }), { code: 'SCHEMA_INVALID' });
  assert.deepEqual(await bytes(f), invalid);
});

test('retained process IDs and accepted process roots remain AI provenance and carry their actual participant dependencies', async t => {
  const f = await fixture(t);
  const original = await f.repository.ingest(chat('process-root', '这是真实参与者原话'));
  const toolRoot = { sourceSessionId: 'source', sourceEventId: 'tool-event', sourceKind: 'tool/result', sourceRole: 'assistant', sourceOrigin: 'system' };
  const hot = (await f.repository.captureHot({ personId: null, sourceRef: toolRoot, sourceKind: 'tool/result', kind: 'tool_result', origin: 'system',
    content: { mode: 'cached', text: JSON.stringify({ item: { schemaVersion: 'persona-memory/3', id: original.record.id, srcRefs: [ref('process-root')], text: '有来源的工具结果' } }) } })).record;
  assert.ok(hot.id.startsWith('h_'));
  const saved = await f.repository.updateSelfProfile({ current: { selfDescription: '我对这段过程有自己的理解' } }, { actor: 'persona', sourceRefs: [toolRoot], sourceRecordIds: [hot.id] });
  const provenance = saved.provenance.current.selfDescription;
  assert.ok(provenance.sourceRefs.some(item => item.sourceEventId === 'tool-event' && item.sourceRole === 'assistant'));
  assert.ok(provenance.sourceRefs.some(item => item.sourceEventId === 'process-root'));
  assert.ok(provenance.sourceRecordIds.includes(hot.id)); assert.ok(provenance.sourceRecordIds.includes(original.record.id));
  assert.equal((await f.repository.getContext()).records.length, 1);
  await f.repository.forget({ ids: [original.record.id], scope: 'unknown' });
  assert.equal((await f.repository.getSelfProfile()).current.selfDescription, '');
});

test('an arbitrary explicit record ID quoted inside process content is never promoted to a trusted retained-memory identity', async t => {
  const f = await fixture(t);
  await f.repository.updateSelfProfile({ current: { name: '保留原名' } }, { actor: 'persona' });
  const before = await bytes(f);
  const process = (await f.repository.captureHot({ personId: null, sourceRef: { sourceSessionId: 'host', sourceEventId: 'quoted-id' },
    sourceKind: 'tool/result', kind: 'tool_result', origin: 'system', content: { mode: 'cached', text: JSON.stringify({ recordId: 'unknown-but-quoted' }) } })).record;
  await assert.rejects(f.repository.updateSelfProfile({ current: { name: '不能依赖假ID的新名' } }, { actor: 'persona', sourceRecordIds: [process.id] }), { code: 'SOURCE_UNKNOWN' });
  await assert.rejects(f.repository.updateSelfProfile({ current: { name: '直接假ID' } }, { actor: 'persona', sourceRecordIds: ['unknown-but-quoted'] }), { code: 'SOURCE_UNKNOWN' });
  assert.deepEqual(await bytes(f), before);
});
