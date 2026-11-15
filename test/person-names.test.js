import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRepository, PersonaRuntime } from '../core/index.js';
import { createBackup, restoreBackup } from '../core/maintenance.js';

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'person-names-')), root = join(workspace, 'memory');
  let now = 1000;
  const repository = new MemoryRepository({ root, clock: () => now++ }), notifications = [];
  const runtime = new PersonaRuntime({ repository, autoSchedule: false, clock: () => now++,
    host: { onIdentity: (...args) => { notifications.push(args); } } });
  await runtime.open();
  t.after(async () => { await runtime.close(); await rm(workspace, { recursive: true, force: true }); });
  await repository.upsertPerson({ personId: 'a', displayName: '甲', aliases: ['旧档案别名'] });
  await repository.upsertPerson({ personId: 'b', displayName: '乙' });
  return { workspace, root, repository, runtime, notifications };
}
const ref = (id, personId = 'a') => ({ sourceSessionId: 'session-' + personId, sourceEventId: id });
const context = personId => ({ sessionId: 'session-' + personId, channelId: 'channel-' + personId, personId, executeReply: false });
const name = (kind, value, sourceRefs) => ({ action: 'upsert', kind, name: value, ...(sourceRefs === undefined ? {} : { sourceRefs }) });
async function accept(f, id, personId = 'a', role = 'user') {
  return f.runtime.accept({ ...ref(id, personId), personId, channelId: 'channel-' + personId,
    role, sourceKind: role === 'user' ? 'user' : 'model', contentClass: 'participant_dialogue', text: '原始内容 ' + id }, context(personId));
}

test('name-only decisions preserve the active relationship, retain typed provenance and surface same-name candidates separately', async t => {
  const f = await fixture(t), { runtime, repository } = f;
  await accept(f, 'first-a');
  await runtime.decide({ identityPlan: { action: 'associate', personId: 'a', sourceRefs: [] } }, context('a'));
  const operationId = 'names-first';
  const decision = { identityPlan: { action: 'names', personId: 'b', nameUpdates: [
    name('nickname', ' 阿岚 '), name('former_name', '临风', [ref('first-a')]),
  ] } };
  await runtime.decide(decision, { ...context('a'), operationId });
  assert.equal(f.notifications.length, 1, 'only the actual association called the host binding port');
  const state = await repository.getRuntime();
  assert.equal(state.execution.lastContext.personId, 'a');
  assert.equal(state.currentDecision.identityPlan.personId, 'a');
  assert(!JSON.stringify(state).includes('临风'), 'completed name commands must not be copied to long-lived runtime plans');
  const profile = await repository.introspect({ section: 'names', targetPersonId: 'b' });
  assert.deepEqual(profile.names.map(entry => [entry.kind, entry.name, entry.srcRefs.map(src => src.sourceRole)]),
    [['nickname', '阿岚', []], ['former_name', '临风', ['user']]]);
  assert.equal((await runtime.decide(decision, { ...context('a'), operationId })).duplicate, true);
  assert.deepEqual(await repository.introspect({ section: 'names', targetPersonId: 'b' }), profile);
  await runtime.decide({ identityPlan: { action: 'names', personId: 'a', nameUpdates: [name('alias', '阿岚')] } }, context('a'));
  const results = await runtime.introspect({ section: 'names', nameQuery: '阿岚' }, context('a'));
  assert.deepEqual(results.candidates.map(entry => [entry.personId, entry.matches[0].kind]), [['a', 'alias'], ['b', 'nickname']]);
  assert.equal(results.referenceOnly, true);
  assert.deepEqual((await repository.introspect({ section: 'names', nameQuery: '阿岚', targetPersonId: 'b' })).candidates.map(row => row.personId), ['b']);
  const legacy = await repository.introspect({ section: 'names', nameQuery: '旧档案别名' });
  assert.deepEqual(legacy.candidates[0].matches, [{ kind: 'legacy_alias', name: '旧档案别名' }]);
  await runtime.decide({ identityPlan: { action: 'names', personId: 'b', nameUpdates: [{ action: 'remove', kind: 'nickname', name: '阿岚' }] } }, context('a'));
  assert.deepEqual((await runtime.introspect({ section: 'names', nameQuery: '阿岚' }, context('a'))).candidates.map(entry => entry.personId), ['a']);
});

test('only a trusted, sourced platform nickname can be recorded and repeat observations do not rewrite the identity', async t => {
  const f = await fixture(t), { repository, runtime } = f;
  await accept(f, 'qq-first'); await accept(f, 'qq-repeat'); await accept(f, 'wrong-person', 'b'); await accept(f, 'assistant', 'a', 'assistant');
  const observedOn = { platform: 'qq', accountId: 'bound-bot', senderId: 'real-sender' };
  const observe = (id, personId = 'a', sourcePerson = personId, label = '晚风') => repository.recordPersonNames({ personId, observedOn,
    nameUpdates: [name('platform_nickname', label, [ref(id, sourcePerson)])] });
  await assert.rejects(observe('wrong-person', 'a', 'b'), { code: 'SOURCE_UNKNOWN' });
  await assert.rejects(observe('assistant'), { code: 'SOURCE_UNKNOWN' });
  await assert.rejects(runtime.decide({ identityPlan: { action: 'names', personId: 'a',
    nameUpdates: [name('platform_nickname', '晚风', [ref('qq-first')])] } }, context('a')), { code: 'SCHEMA_INVALID' });
  const identity = await observe('qq-first');
  assert.deepEqual(await observe('qq-repeat'), identity);
  assert.deepEqual(identity.names, [{ kind: 'platform_nickname', name: '晚风',
    srcRefs: [{ ...ref('qq-first'), available: true, sourceKind: 'user', sourceRole: 'user', sourceOrigin: 'user' }],
    updatedAt: identity.updatedAt - 1, observedOn }]);
  assert.equal(identity.displayName, '甲');
  assert.deepEqual(identity.aliases, ['旧档案别名']);
  const renamed = await observe('qq-repeat', 'a', 'a', '冬青');
  assert.deepEqual(renamed.names.map(row => row.name), ['晚风', '冬青']);
  assert.equal(renamed.displayName, '甲');
});

test('reassigning the original withdraws only the old platform observation, including after backup restore', async t => {
  const f = await fixture(t), { repository, runtime } = f;
  const source = ref('reassigned-qq');
  await accept(f, source.sourceEventId);
  await repository.recordPersonNames({ personId: 'a', observedOn: { platform: 'qq', accountId: 'bot', senderId: 'sender' },
    nameUpdates: [name('platform_nickname', '平台名', [source])] });
  await repository.recordPersonNames({ personId: 'a', nameUpdates: [name('nickname', '自选称呼', [source])] });
  await repository.assign({ ...source, personId: 'b' });
  const verify = async () => {
    assert.deepEqual((await repository.store.readJson('people/a/identity.json')).names.map(row => row.name), ['自选称呼']);
    assert.deepEqual((await repository.introspect({ section: 'names', targetPersonId: 'b' })).names, []);
    assert.deepEqual((await repository.introspect({ section: 'names', nameQuery: '平台名' })).candidates, []);
    assert.equal((await repository.getContext({ personId: 'b' })).records[0].sourceEventId, source.sourceEventId);
  };
  await verify();
  const backup = join(f.workspace, 'assignment-backup');
  await runtime.close(); await createBackup({ root: f.root, destination: backup });
  await restoreBackup({ root: f.root, source: backup }); await runtime.open();
  await verify();
});

test('invalid name provenance or capacity rejects the identity edit as a unit', async t => {
  const f = await fixture(t), { runtime, repository } = f, before = await repository.listPeople();
  await assert.rejects(runtime.decide({ identityPlan: { action: 'associate', personId: 'a', displayName: '不该写入',
    sourceRefs: [], nameUpdates: [name('nickname', '无来源昵称', [ref('unknown')])] } }, context('a')), { code: 'SOURCE_UNKNOWN' });
  assert.deepEqual(await repository.listPeople(), before);
  assert.equal(f.notifications.length, 0);
  const beforeLarge = await repository.getRuntime();
  await assert.rejects(runtime.decide({ identityPlan: { action: 'names', personId: 'a', nameUpdates: [
    name('alias', '太长来源', [ref('x'.repeat(17000))]),
  ] } }, context('a')), { code: 'CAPACITY_EXCEEDED' });
  assert.deepEqual(await repository.getRuntime(), beforeLarge);
  for (let batch = 0; batch < 4; batch++) {
    await repository.recordPersonNames({ personId: 'a', nameUpdates: Array.from({ length: 8 }, (_, item) => name('alias', '别名 ' + (batch * 8 + item))) });
  }
  const full = await repository.listPeople();
  await assert.rejects(runtime.decide({ identityPlan: { action: 'associate', personId: 'a', displayName: '不该写入',
    sourceRefs: [], nameUpdates: [name('alias', '第33条')] } }, context('a')), { code: 'CAPACITY_EXCEEDED' });
  assert.deepEqual(await repository.listPeople(), full);
  assert.equal(f.notifications.length, 0);
  await assert.rejects(runtime.decide({ identityPlan: { action: 'names', personId: 'missing', nameUpdates: [name('alias', '不会创建人物')] } }, context('a')),
    { code: 'PERSON_NAME_TARGET_UNKNOWN' });
  assert.equal((await repository.listPeople()).length, 2);
});

test('withdrawing the source of a pending rename prevents partial identity effects during recovery', async t => {
  const f = await fixture(t), { repository, runtime } = f;
  const accepted = await accept(f, 'pending-source');
  const state = await repository.getRuntime(), decisionId = 'pending-names';
  const identityPlan = { action: 'associate', personId: 'a', displayName: '不应部分写入', sourceRefs: [] };
  const decision = { schemaVersion: state.schemaVersion, decisionId, decidedAt: 1000, srcRefs: [], identityPlan };
  state.currentDecision = decision;
  state.execution.pendingEffects = { [decisionId]: { operationId: 'pending-name-op', decision,
    input: { identityPlan: { ...identityPlan, nameUpdates: [name('former_name', '应撤销的待办', [ref('pending-source')])] } },
    context: context('a'), completed: [], values: {} } };
  await repository.saveRuntime(state);
  await repository.forget({ targetPersonId: 'a', ids: [accepted.record.id], reason: 'withdraw before restart' });
  const after = await repository.getRuntime();
  assert.equal(after.currentDecision.identityPlan, undefined);
  assert.equal(after.execution.pendingEffects[decisionId].input.identityPlan, undefined);
  assert(!JSON.stringify(after).includes('应撤销的待办'));
  await runtime.close(); await runtime.open(); await runtime.idle();
  assert.equal((await repository.introspect({ section: 'names', targetPersonId: 'a' })).displayName, '甲');
  assert.equal(f.notifications.length, 0);
});

test('forgetting a source removes the dependent name through reopen and restore while preserving unsourced legacy aliases', async t => {
  const f = await fixture(t), { repository, runtime } = f;
  const accepted = await accept(f, 'source-to-forget');
  await repository.recordPersonNames({ personId: 'a', nameUpdates: [
    name('former_name', '撤销名字', [ref('source-to-forget')]), name('nickname', '自己选的叫法'),
  ] });
  const backup = join(f.workspace, 'backup');
  await runtime.close();
  await createBackup({ root: f.root, destination: backup });
  await runtime.open();
  await repository.forget({ targetPersonId: 'a', ids: [accepted.record.id], reason: 'test withdrawal' });
  const check = async () => {
    const result = await repository.introspect({ section: 'names', targetPersonId: 'a' });
    assert.deepEqual(result.aliases, ['旧档案别名']);
    assert.deepEqual(result.names.map(entry => entry.name), ['自己选的叫法']);
    assert.deepEqual((await repository.introspect({ section: 'names', nameQuery: '撤销名字' })).candidates, []);
    assert.deepEqual((await repository.store.readJson('people/a/identity.json')).names.map(entry => entry.name), ['自己选的叫法']);
  };
  await check();
  await runtime.close(); await restoreBackup({ root: f.root, source: backup }); await runtime.open();
  await check();
});
