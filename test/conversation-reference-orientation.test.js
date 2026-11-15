import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { REFERENCE_UNDERSTANDING, conversationOrientation } from '../core/onboarding.js';
import { replyMessages, controlMessages } from '../core/prompts.js';
import { MemoryRepository } from '../core/repository.js';
import { PersonaRuntime } from '../core/runtime.js';

const context = { sessionId: 'source-group', channelId: 'qq:source-group', personId: null };
const original = (id, role, text) => ({ sourceSessionId: context.sessionId, sourceEventId: id,
  channelId: context.channelId, personId: null, role, sourceKind: role === 'user' ? 'user' : 'model',
  contentClass: 'participant_dialogue', text });
const section = (snapshot, name) => JSON.parse(snapshot.segments.find(item => item.name === name).text.split('\n')[1]);

async function fixture(t) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(await fs.mkdtemp(path.join(temporary, 'xiangxu-reference-orientation-')));
  const repository = new MemoryRepository({ root, clock: () => 10000 });
  let modelCalls = 0;
  const runtime = new PersonaRuntime({ repository, clock: () => 10000, autoSchedule: false,
    tokenCounter: async text => [...text].length,
    model: { countTokens: async text => [...text].length, complete() { modelCalls++; throw new Error('No model request is permitted'); } } });
  await runtime.open();
  t.after(async () => {
    await runtime.close();
    assert.ok(root.startsWith(temporary + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, repository, runtime, get modelCalls() { return modelCalls; } };
}

test('reply preparation retains distinct current self and historical assistant statement without rewriting either', async t => {
  const f = await fixture(t);
  await f.repository.updateSelfProfile({ current: { name: '阿序' } }, { actor: 'persona' });
  await f.repository.ingest(original('old-claim', 'assistant', '在的在的，熙熙在此。'));
  const beforeDialogue = await fs.readFile(path.join(f.root, 'staging/events.jsonl'));
  const beforeProfile = await fs.readFile(path.join(f.root, 'self/profile.json'));
  const snapshot = await f.runtime.compose(context);
  const messages = replyMessages(snapshot, { incoming: { text: '熙熙在么' } });
  const control = controlMessages(snapshot, { incoming: { text: '熙熙在么' } });
  assert.equal(section(snapshot, 'self_profile').current.name, '阿序');
  const old = section(snapshot, 'recent_memory').items.find(item => item.sourceEventId === 'old-claim');
  assert.equal(old.role, 'assistant');
  assert.equal(old.text, '在的在的，熙熙在此。');
  assert.equal(old.sourceSessionId, context.sessionId);
  assert.ok(messages[0].content.includes(REFERENCE_UNDERSTANDING));
  assert.equal(messages[0].content.split(REFERENCE_UNDERSTANDING).length - 1, 1);
  assert.equal(control[0].content.split(REFERENCE_UNDERSTANDING).length - 1, 1);
  assert.equal(control[1].content, messages[1].content);
  assert.deepEqual(JSON.parse(control[2].content).incoming, JSON.parse(messages[2].content).incoming);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'staging/events.jsonl')), beforeDialogue);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'self/profile.json')), beforeProfile);
  assert.equal(f.modelCalls, 0);
});

test('prepared reference facts do not impose a reply action for unknown, third-person or direct-mention contexts', async t => {
  const f = await fixture(t);
  await f.repository.updateSelfProfile({ current: { name: '阿序' } }, { actor: 'persona' });
  const target = { sessionId: context.sessionId, channelId: context.channelId, personId: null };
  for (const [name, groupContext] of [
    ['unknown', { observedNameMatches: [], explicitlyMentionsConnectedAccount: false }],
    ['third-person', { observedNameMatches: [{ platformUserId: 'third-person', observedDisplayName: '熙熙' }], explicitlyMentionsConnectedAccount: false }],
    ['direct-mention', { observedNameMatches: [], explicitlyMentionsConnectedAccount: true }],
  ]) {
    const observed = { ...context, environment: { groupContext } };
    const snapshot = await f.runtime.compose(observed);
    const prepared = controlMessages(snapshot, observed);
    assert.deepEqual(JSON.parse(prepared[2].content).environment.groupContext, groupContext);
    assert.ok(prepared[0].content.includes(REFERENCE_UNDERSTANDING));
    for (const action of ['reply', 'wait', 'listen']) {
      const input = { replyPlan: { action, target, replyAt: null, pendingEventIds: [], reason: name + ' chosen ' + action }, nextCheckAt: null };
      const result = await f.runtime.decide(input, { ...observed, executeReply: false });
      assert.equal(result.decision.replyPlan.action, action);
      assert.equal((await f.repository.getRuntime()).currentDecision.replyPlan.action, action);
    }
  }
  assert.equal(f.modelCalls, 0);
});

test('an autonomous new nickname remains writable and survives a new-session snapshot with history intact', async t => {
  const f = await fixture(t);
  const initial = await f.repository.updateSelfProfile({ initial: { name: '小序' }, current: { name: '阿序' } }, { actor: 'user' });
  await f.repository.ingest(original('nickname-offer', 'user', '以后也叫你熙熙，好不好？'));
  const beforeDialogue = await fs.readFile(path.join(f.root, 'staging/events.jsonl'));
  const adopted = await f.repository.updateSelfProfile({ current: { name: '熙熙' } }, { actor: 'persona', expectedVersion: initial.version,
    sourceRefs: [{ sourceSessionId: context.sessionId, sourceEventId: 'nickname-offer' }] });
  assert.equal(adopted.current.name, '熙熙');
  assert.equal(adopted.initial.name, '小序');
  assert.equal(adopted.provenance.current.name.actor, 'persona');
  assert.equal(adopted.history.at(-1).current.name, '阿序');
  const snapshot = await f.runtime.compose({ ...context, sessionId: 'later-session', channelId: 'qq:later-session' });
  assert.equal(section(snapshot, 'self_profile').current.name, '熙熙');
  assert.equal(snapshot.selfProfileReference.shown.includes('current.name'), true);
  assert.equal(replyMessages(snapshot)[0].content.includes(REFERENCE_UNDERSTANDING), true);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'staging/events.jsonl')), beforeDialogue);
  assert.equal(f.modelCalls, 0);
});

test('historical assistant self-claims alone do not initialize an empty profile and all styles carry the same optional participation framing', async t => {
  const f = await fixture(t);
  await f.repository.ingest(original('ambiguous-claim', 'assistant', '熙熙在此。'));
  const snapshot = await f.runtime.compose(context);
  assert.equal((await f.repository.getSelfProfile()).version, 0);
  assert.equal((await f.repository.getSelfProfile()).current.name, '');
  assert.deepEqual(snapshot.selfProfileReference.shown, []);
  assert.equal(snapshot.segments.find(item => item.name === 'self_profile').text, '');
  await assert.rejects(fs.stat(path.join(f.root, 'self/profile.json')), { code: 'ENOENT' });
  for (const style of ['short_chat', 'balanced', 'detailed']) {
    const prompt = replyMessages({ ...snapshot, conversationStyle: style })[0].content;
    assert.equal(prompt, conversationOrientation(style));
    assert.ok(prompt.includes(REFERENCE_UNDERSTANDING));
  }
  assert.ok([...REFERENCE_UNDERSTANDING].length <= 350);
  assert.equal(f.modelCalls, 0);
});
