import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshCoordinator } from '../adapters/dsh/index.js';
import { externalConversationReference } from '../adapters/dsh/conversation-reference.js';
import { REFERENCE_UNDERSTANDING } from '../core/onboarding.js';
import { qqGroupContext } from '../adapters/dsh/channels/qq-group-context.js';
import { renderExternalMessageTextBlocks } from '../adapters/dsh/channels/native.js';

const parse = text => JSON.parse(text.split('\n')[1]);
const channel = { platform: 'qq', accountId: '3910812661', conversation: { type: 'group', id: '1129932744' }, sender: { id: '987425023', name: 'Mingo' } };
async function fixture(t, facts = channel) {
  const root = await mkdtemp(join(tmpdir(), 'xiangxu-reference-')), handlers = new Map(), tools = new Map();
  const session = { id: 'xiangxu-social-' + 'a'.repeat(32), header: {}, deriveMessages: () => [], requestHeader: () => ({ config: { provider: 'fixed', model: 'none' } }) };
  const scope = { on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); }, tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); }, restrict() { return () => {}; } } };
  const agent = { id: session.id, session, ctx: scope, inbox: { nextTurn: [], nextStep: [] }, followup(message) { this.inbox.nextTurn.push(message); } };
  let modelCalls = 0;
  const coordinator = createDshCoordinator({ agents: { get: () => agent }, get: () => undefined,
    llm: { stream() { modelCalls++; throw new Error('No paid or other model is allowed in reference assembly verification'); } } }, { memoryRoot: root });
  await coordinator.ready; assert.equal(coordinator.initializationError, null);
  if (facts) await coordinator.registerExternalChannel(session.id, facts);
  await coordinator.attachAgent(agent);
  t.after(async () => { await coordinator.close(); await rm(root, { recursive: true, force: true }); });
  return { root, coordinator, agent, handlers, tools, get modelCalls() { return modelCalls; },
    async assembly() { return coordinator.preparePersonaAssembly(agent, { sections: [] }); } };
}
const section = (assembly, name) => assembly.sections.find(value => value.name === 'persona-memory:' + name)?.text;

test('an unseen group name remains an incomplete observation while native assembly links the same current self snapshot', async t => {
  const f = await fixture(t);
  await f.coordinator.repository.updateSelfProfile({ current: { name: '阿序' } }, { actor: 'persona', expectedVersion: 0 });
  const event = { sender: channel.sender, accountId: channel.accountId, message: { id: 'm1', text: '熙熙熙熙在么' } };
  const group = qqGroupContext({ event, roomBindings: [], receipts: [], inboundSourceId: id => id });
  const original = event.message.text;
  const blocks = renderExternalMessageTextBlocks({ originalText: original, groupContext: group });
  assert.equal(blocks[0], original);
  assert.deepEqual(group.observedNameMatches, []);
  assert.equal(group.observationCoverage.completeGroupRoster, false);
  assert.equal(group.observationCoverage.observedParticipantCount, 1);
  assert.equal(Object.hasOwn(group, 'addressee'), false);
  const assembly = await f.assembly();
  const reference = JSON.parse(section(assembly, 'channel-output').split('[conversation_identity_reference]\n')[1].split('\n')[0]);
  assert.equal(reference.connectedAccount.platformUserId, channel.accountId);
  assert.equal(reference.currentSender.platformUserId, channel.sender.id);
  assert.equal(reference.selfDescription.currentName.status, 'presented_in_self_profile');
  assert.equal(reference.selfDescription.version, f.coordinator.agents.get(f.agent.id).latestSnapshot.selfProfileReference.version);
  const profile = JSON.parse(section(assembly, 'live').split('[self_profile]\n')[1].split('\n')[0]);
  assert.equal(profile.current.name, '阿序');
  assert.ok(section(assembly, 'conversation').includes(REFERENCE_UNDERSTANDING));
  assert.equal(f.modelCalls, 0);
});

test('the saved self name is a reference, not a gate for a new nickname or speaking in a third-person topic', async t => {
  const f = await fixture(t);
  await f.coordinator.repository.updateSelfProfile({ current: { name: '阿序' } }, { actor: 'persona', expectedVersion: 0 });
  const message = { id: 'nickname-input', role: 'user', source: { kind: 'user', xiangxuChannel: channel, platformMessageId: 'nickname-platform' }, content: [{ type: 'text', text: '以后叫你熙熙怎么样？' }] };
  f.handlers.get('agent/inbox/claimed')({ message, turn: 1 });
  let passed = false;
  const admitted = await f.handlers.get('agent/pre-step')({ messages: [message], turn: 1 }, async () => { passed = true; return { kind: 'enter', messages: [message] }; });
  assert.equal(passed, true); assert.equal(admitted.kind, 'enter');
  const prior = await f.coordinator.repository.getSelfProfile();
  await f.coordinator.repository.updateSelfProfile({ current: { name: '熙熙' } }, { actor: 'persona', expectedVersion: prior.version });
  const assembly = await f.assembly(), current = JSON.parse(section(assembly, 'live').split('[self_profile]\n')[1].split('\n')[0]);
  assert.equal(current.current.name, '熙熙');
  assert.equal(f.modelCalls, 0);
});

test('reference status distinguishes a shown name, an absent name and unavailable data without guessing a name', () => {
  assert.equal(externalConversationReference(null, {}), '');
  for (const [profile, expected] of [
    [{ version: 2, shown: ['current.name'], fullProfileAvailable: true }, 'presented_in_self_profile'],
    [{ version: 0, shown: [], fullProfileAvailable: true }, 'not_recorded'],
    [{ version: 2, shown: [], omitted: ['current.name'], fullProfileAvailable: true }, 'not_presented'],
    [{ shown: [], fullProfileAvailable: false }, 'unavailable'],
  ]) {
    const reference = parse(externalConversationReference(channel, { selfProfileReference: profile }));
    assert.equal(reference.selfDescription.currentName.status, expected);
    assert.equal(Object.hasOwn(reference, 'addressee'), false);
    assert.equal(Object.hasOwn(reference.selfDescription.currentName, 'value'), false);
  }
});

test('private external routes receive the same identity link and desktop does not invent a platform account', async t => {
  const wechat = { ...channel, platform: 'wechat', conversation: { type: 'private', id: 'private-test' } };
  const external = await fixture(t, wechat), desktop = await fixture(t, null);
  assert.match(section(await external.assembly(), 'channel-output'), /conversation_identity_reference/);
  assert.equal(section(await desktop.assembly(), 'channel-output'), undefined);
  assert.equal(external.modelCalls + desktop.modelCalls, 0);
});
