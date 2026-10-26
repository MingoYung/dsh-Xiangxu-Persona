import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../core/prompts.js';
import { defaultConfig } from '../core/schema.js';

const counter = { method: 'test_characters', count: async text => Array.from(text).length };
const context = { sessionId: 'current_session', channelId: 'dsh:current_session', timezone: 'UTC' };
const profile = () => ({ version: 3, mode: 'together',
  current: { name: '相续', gender: '女性', background: 'Long background '.repeat(100) },
  initial: { ageDescription: '二十五岁形象' },
  provenance: { current: {
    name: { sourceRefs: [{ sourceSessionId: 'self_source', sourceEventId: 'name' }], sourceRecordIds: ['name_record'] },
    gender: { sourceRefs: [{ sourceSessionId: 'self_source', sourceEventId: 'gender' }], sourceRecordIds: ['gender_record'] },
    background: { sourceRefs: [{ sourceSessionId: 'self_source', sourceEventId: 'background' }], sourceRecordIds: ['background_record'] },
  }, initial: { ageDescription: { sourceRefs: [{ sourceSessionId: 'self_source', sourceEventId: 'initial_age' }], sourceRecordIds: ['initial_age_record'] } } } });
const zeroBudgets = { environmentTokens: 0, anchorTokens: 0, personaTokens: 0, habitTokens: 0, relationTokens: 0, retrievalTokens: 0, deepMemoryTokens: 0, selfProfileTokens: 0 };
async function snapshot({ totalTokens = 6000, budgets = {}, material = {}, ctx = {}, tokenCounter = counter } = {}) {
  return buildSnapshot({ context: { ...context, ...ctx }, material, state: {}, now: 1000, counter: tokenCounter,
    config: defaultConfig({ contextBudget: { ...zeroBudgets, totalTokens, ...budgets } }) });
}
function assertProfileMatchesVisible(snapshot, original) {
  const segment = snapshot.segments.find(item => item.name === 'self_profile');
  const visible = segment.text ? JSON.parse(segment.text.slice('[self_profile]\n'.length)) : null;
  for (const group of ['current', 'initial']) for (const field of Object.keys(original[group])) {
    const path = group + '.' + field;
    const value = visible?.[group === 'initial' ? 'initialWishes' : group]?.[field];
    if (snapshot.selfProfileReference.shown.includes(path)) assert.equal(value, original[group][field]);
    else { assert.equal(value, undefined); assert.ok(snapshot.selfProfileReference.omitted.includes(path)); }
  }
  assert.ok(snapshot.tokens <= snapshot.segments.reduce((sum, item) => sum + item.budget, 0) || snapshot.tokenAccounting === 'boundary_sensitive');
  assert.equal(snapshot.injectedText, snapshot.segments.map(item => item.text).join(''));
  return visible;
}

test('a total smaller than mandatory route facts rejects without cutting self identity into partial JSON', async () => {
  const base = await snapshot();
  await assert.rejects(snapshot({ totalTokens: base.tokens - 1, budgets: { selfProfileTokens: 350 }, material: { selfProfile: profile() } }), { code: 'ESSENTIAL_CONTEXT_BUDGET' });
});

test('essential facts near the total cap omit whole self fields and truthfully report omitted values', async () => {
  const base = await snapshot(), original = profile(), totalTokens = base.tokens + 30;
  const result = await snapshot({ totalTokens, budgets: { selfProfileTokens: 350 }, material: { selfProfile: original } });
  assert.ok(result.tokens <= totalTokens); assertProfileMatchesVisible(result, original);
  assert.deepEqual(result.selfProfileReference.shown, []);
  assert.deepEqual(result.sourceDependencies, { refs: [], recordIds: [] });
});

test('the optional environment tail consumes real budget before any self profile is admitted', async () => {
  const base = await snapshot(), original = profile(), totalTokens = base.tokens + 180;
  const result = await snapshot({ totalTokens, budgets: { environmentTokens: 5000, selfProfileTokens: 350 },
    ctx: { environment: { placeDescription: 'A long real environment '.repeat(200) } }, material: { selfProfile: original } });
  assert.ok(result.tokens <= totalTokens); assertProfileMatchesVisible(result, original);
  assert.deepEqual(result.selfProfileReference.shown, []);
  assert.ok(result.selfProfileReference.omitted.includes('current.name'));
  assert.ok(!result.injectedText.includes('[self_profile]'));
});

test('later oversized segments never truncate an admitted self profile and omitted fields do not claim source dependencies', async () => {
  const base = await snapshot(), original = profile(), totalTokens = base.tokens + 390;
  const result = await snapshot({ totalTokens, budgets: { selfProfileTokens: 250, anchorTokens: 5000, personaTokens: 5000, relationTokens: 5000, retrievalTokens: 5000 },
    material: { selfProfile: original, persona: { anchor: { text: 'Later text '.repeat(1000) } } } });
  assert.ok(result.tokens <= totalTokens); const visible = assertProfileMatchesVisible(result, original);
  assert.equal(visible.current.name, '相续');
  assert.ok(result.selfProfileReference.omitted.includes('current.background'));
  assert.ok(!result.sourceDependencies.recordIds.includes('background_record'));
  assert.ok(!result.sourceDependencies.refs.some(ref => ref.sourceEventId === 'background'));
  assert.ok(result.sourceDependencies.recordIds.includes('name_record'));
});

test('deep reference cards and self fields stay complete while later retrieval yields to the unchanged total cap', async () => {
  const base = await snapshot(), original = profile(), totalTokens = base.tokens + 1100;
  const result = await snapshot({ totalTokens, budgets: { selfProfileTokens: 250, anchorTokens: 90, personaTokens: 90, habitTokens: 40,
    deepMemoryTokens: 550, relationTokens: 5000, retrievalTokens: 5000 },
    material: { selfProfile: original, persona: { anchor: { text: 'Existing identity '.repeat(20) } },
      deepMemories: [{ id: 'deep_one', title: 'A past event', reference: 'A brief reference', cues: [], aboutPersonIds: [], updatedAt: 10 }] },
    ctx: { memories: [{ id: 'large_retrieval', text: 'A retained record '.repeat(1000) }] } });
  assert.ok(result.tokens <= totalTokens); assertProfileMatchesVisible(result, original);
  const deep = result.segments.find(segment => segment.name === 'deep_memory_reference');
  assert.ok(deep?.text); const content = JSON.parse(deep.text.slice('[deep_memory_reference]\n'.length));
  assert.equal(content.items[0].id, 'deep_one'); assert.deepEqual(result.deepMemoryReference.ids, ['deep_one']);
});

test('boundary-sensitive token counting cannot cut a whole profile after concatenation', async () => {
  const boundaryCounter = { method: 'boundary_sensitive', count: async text => Array.from(text).length +
    (text.includes('[environment]') && text.includes('[self_profile]') ? 73 : 0) };
  const base = await snapshot({ tokenCounter: boundaryCounter }), original = profile(), totalTokens = base.tokens + 240;
  const result = await snapshot({ totalTokens, budgets: { selfProfileTokens: 350, anchorTokens: 5000 },
    material: { selfProfile: original, persona: { anchor: { text: 'overflow '.repeat(1000) } } }, tokenCounter: boundaryCounter });
  assert.ok(result.tokens <= totalTokens); assertProfileMatchesVisible(result, original);
});
