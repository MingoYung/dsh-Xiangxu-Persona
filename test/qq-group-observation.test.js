import test from 'node:test';
import assert from 'node:assert/strict';
import { qqGroupContext } from '../adapters/dsh/channels/qq-group-context.js';

const binding = (sessionId, id, name) => ({ sessionId, facts: { sender: { id, name } } });
const accepted = (sessionId, messageId) => ({ kind: 'inbound', sessionId, messageId: 'in:' + messageId, status: 'accepted' });
function project({ text = '熙熙熙熙在么', senderId = '11', senderName = 'Mingo', bindings = [], receipts = [], rich, bridgeProbe } = {}) {
  const input = {
    event: { accountId: '100', sender: { id: senderId, name: senderName }, message: { id: 'current', text }, ...(rich ? { rich } : {}) },
    roomBindings: bindings,
    receipts,
    inboundSourceId: id => 'in:' + id,
    bridgeProbe,
  };
  const before = structuredClone({ event: input.event, roomBindings: input.roomBindings, receipts: input.receipts });
  const result = qqGroupContext(input);
  assert.deepEqual(input.event, before.event, 'projection must preserve actual incoming facts');
  assert.deepEqual(input.roomBindings, before.roomBindings);
  assert.deepEqual(input.receipts, before.receipts);
  return result;
}

test('an account display-name observation cannot cross account, protocol, or probe boundaries', () => {
  const observation = { value: 'QQ 登录昵称', source: 'onebot_get_login_info', observedAt: 123 };
  const probe = { connected: true, accountId: '100', platform: 'qq', protocol: 'onebot11',
    checkedAt: 123, connectedAccountDisplayName: observation };
  assert.deepEqual(project({ bridgeProbe: probe }).connectedAccountDisplayName, observation);
  for (const changes of [{ accountId: '101' }, { platform: 'wechat' }, { protocol: 'onebot12' },
    { connected: false }, { checkedAt: 124 }, { connectedAccountDisplayName: { ...observation, value: '空\n行' } }]) {
    assert.equal(project({ bridgeProbe: { ...probe, ...changes } }).connectedAccountDisplayName, undefined);
  }
});

test('an unobserved name remains an uncovered referent, not a self identity or a known other', () => {
  const result = project({ bindings: [binding('current-s', '11', 'Mingo')], receipts: [
    { kind: 'outbound', sessionId: 'current-s', status: 'delivered', platformMessageId: 'old-self-reply' },
  ] });
  assert.equal(result.connectedAccountId, '100');
  assert.deepEqual(result.sender, { platformUserId: '11', displayName: 'Mingo' });
  assert.deepEqual(result.observedNameMatches, []);
  assert.deepEqual(result.observationCoverage, {
    basis: 'retained_accepted_inbound_and_current_sender', observedParticipantCount: 1, completeGroupRoster: false,
    nameMatchesScope: 'latest_names_of_observed_other_senders', noMatchMeaning: 'no_match_in_observed_names',
  });
  assert.equal(result.explicitlyMentionsConnectedAccount, false);
  assert.equal(result.addressee, undefined);
  assert.equal(result.selfName, undefined);
  assert.equal(result.replyAllowed, undefined);
  assert.ok(!JSON.stringify(result).includes('1822729006'), 'an unobserved third-party account must not be invented');
});

test('accepted prior senders and the current prepared intake define a unique observed actor count', () => {
  const result = project({ bindings: [binding('old', '12', '熙熙'), binding('current-s', '11', 'Mingo'), binding('unknown', '13', '熙熙')], receipts: [
    accepted('old', '1'), accepted('old', '2'),
    { kind: 'inbound', sessionId: 'current-s', messageId: 'in:current', status: 'prepared' },
    { kind: 'inbound', sessionId: 'unknown', messageId: 'in:unknown', status: 'unknown' },
  ] });
  assert.equal(result.observationCoverage.observedParticipantCount, 2);
  assert.equal(result.observationCoverage.completeGroupRoster, false);
  assert.deepEqual(result.observedNameMatches, [{ platformUserId: '12', observedDisplayName: '熙熙' }]);
});

test('multiple retained bindings for one stable actor do not inflate observed participants', () => {
  const result = project({ text: '小夏、夏夏在么', bindings: [binding('s1', '12', '小夏'), binding('s2', '12', '夏夏')], receipts: [accepted('s1', '1'), accepted('s2', '2')] });
  assert.equal(result.observationCoverage.observedParticipantCount, 2);
  assert.deepEqual(result.observedNameMatches, [
    { platformUserId: '12', observedDisplayName: '小夏' }, { platformUserId: '12', observedDisplayName: '夏夏' },
  ]);
});

test('same-name people remain separate candidates without resolving a recipient or disallowing speech', () => {
  const result = project({ text: '相续在么', bindings: [binding('s1', '12', '相续'), binding('s2', '13', '相续')], receipts: [accepted('s1', '1'), accepted('s2', '2')] });
  assert.equal(result.observationCoverage.observedParticipantCount, 3);
  assert.deepEqual(result.observedNameMatches, [
    { platformUserId: '12', observedDisplayName: '相续' }, { platformUserId: '13', observedDisplayName: '相续' },
  ]);
  assert.equal(result.connectedAccountId, '100', 'matching names must not replace actual self account facts');
  assert.equal(result.addressee, undefined);
  assert.equal(result.replyAllowed, undefined);
});

test('current sender is observed but their own label is not silently interpreted as the addressee', () => {
  const result = project({ text: '熙熙在么', senderId: '12', senderName: '熙熙', bindings: [binding('current-s', '12', '熙熙')], receipts: [accepted('current-s', '1')] });
  assert.equal(result.observationCoverage.observedParticipantCount, 1);
  assert.deepEqual(result.observedNameMatches, []);
  assert.equal(result.sender.platformUserId, '12');
});

test('latest observed names do not claim complete historical aliases or a full roster after receipt retention', () => {
  const result = project({ text: '旧昵称在么', bindings: [binding('renamed', '12', '新昵称'), binding('unretained', '13', '旧昵称')], receipts: [accepted('renamed', '1')] });
  assert.deepEqual(result.observedNameMatches, []);
  assert.equal(result.observationCoverage.observedParticipantCount, 2);
  assert.equal(result.observationCoverage.nameMatchesScope, 'latest_names_of_observed_other_senders');
  assert.equal(result.observationCoverage.completeGroupRoster, false);
});

test('quote authors and explicit platform mentions retain their independent observed source identities', () => {
  const result = project({ bindings: [binding('same-room', '12', '小夏')], receipts: [
    accepted('same-room', '1'), accepted('other-room', '2'),
    { kind: 'outbound', sessionId: 'same-room', status: 'partial', bubbles: [
      { status: 'delivered', platformMessageId: '10', messageIdKind: 'server_id' },
      { status: 'unknown', platformMessageId: '11', messageIdKind: 'server_id' },
    ] },
  ], rich: { mentions: [{ userId: '100', all: false }], replies: ['1', '2', '10', '11'].map(messageId => ({ messageId })) } });
  assert.equal(result.explicitlyMentionsConnectedAccount, true);
  assert.deepEqual(result.quoteLinks, [
    { platformMessageId: '1', observedAuthorPlatformUserId: '12' },
    { platformMessageId: '2', observedAuthorPlatformUserId: null },
    { platformMessageId: '10', observedAuthorPlatformUserId: '100', confirmedAccountDelivery: true },
    { platformMessageId: '11', observedAuthorPlatformUserId: null },
  ]);
  assert.equal(result.observationCoverage.observedParticipantCount, 2, 'out-of-room receipts do not add an observed actor');
});

test('bounded name presentation stays explicit about omitted matches and incomplete membership', () => {
  const bindings = Array.from({ length: 20 }, (_, i) => binding('s' + i, String(200 + i), '同名'));
  const result = project({ text: '同名在么', bindings, receipts: bindings.map((b, i) => accepted(b.sessionId, String(i))) });
  assert.equal(result.observedNameMatches.length, 12);
  assert.equal(result.nameMatchesTruncated, true);
  assert.equal(result.observationCoverage.observedParticipantCount, 21);
  assert.equal(result.observationCoverage.completeGroupRoster, false);
  assert.ok(Buffer.byteLength(JSON.stringify(result.observationCoverage)) < 400, 'coverage is a compact fact block, not a roster');
});
