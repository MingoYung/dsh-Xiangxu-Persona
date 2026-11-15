const MAX_NAME_MATCHES = 12;
const MAX_QUOTE_LINKS = 12;

function displayName(sender) {
  const value = sender?.name;
  return typeof value === 'string' && value.trim() && [...value].length <= 80 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

function confirmedMessageId(receipt) {
  return receipt.status === 'delivered' && typeof receipt.platformMessageId === 'string' &&
    (receipt.messageIdKind === undefined || receipt.messageIdKind === 'server_id');
}

export function qqGroupContext({ event, roomBindings, receipts, inboundSourceId, bridgeProbe }) {
  const roomBySession = new Map(roomBindings.map(binding => [binding.sessionId, binding.facts.sender]));
  const acceptedSources = new Map();
  const ownSources = new Map();
  const observeOwn = receipt => {
    if (!confirmedMessageId(receipt)) return;
    const id = receipt.platformMessageId;
    ownSources.set(id, ownSources.get(id) === true || receipt.messageIdKind === 'server_id');
  };
  for (const receipt of receipts) {
    if (!roomBySession.has(receipt.sessionId)) continue;
    if (receipt.kind === 'inbound' && receipt.status === 'accepted') acceptedSources.set(receipt.messageId, receipt.sessionId);
    if (receipt.kind === 'outbound') {
      observeOwn(receipt);
      for (const bubble of receipt.bubbles ?? []) observeOwn(bubble);
    }
  }

  // A label occurring in the text is a possible referent, never a platform mention or verified addressee.
  const observedNameMatches = [];
  // The registry is a retained observation window, not the group's membership
  // directory. Current intake precedes its accepted receipt, but its sender is
  // already an actual observed actor. A missing name match says nothing about
  // whether that name is the personality's own or another person's.
  const observedParticipants = new Set([event.sender.id]);
  for (const sessionId of new Set(acceptedSources.values())) {
    const sender = roomBySession.get(sessionId), name = displayName(sender);
    observedParticipants.add(sender.id);
    if (name && sender.id !== event.sender.id && event.message.text.includes(name)) {
      observedNameMatches.push({ platformUserId: sender.id, observedDisplayName: name });
    }
  }
  const mentions = event.rich?.mentions ?? [], replies = event.rich?.replies ?? [];
  const quoteLinks = replies.slice(0, MAX_QUOTE_LINKS).map(({ messageId }) => {
    const quotedSender = roomBySession.get(acceptedSources.get(inboundSourceId(messageId)));
    const own = ownSources.has(messageId);
    const author = own ? (quotedSender ? null : event.accountId) : (quotedSender?.id ?? null);
    return { platformMessageId: messageId, observedAuthorPlatformUserId: author,
      ...(author === event.accountId && ownSources.get(messageId) === true ? { confirmedAccountDelivery: true } : {}) };
  });
  // This observation belongs to the latest successful probe for this exact
  // bridge account. It describes its login nickname at that time, not a group
  // card, a self description, or who the speaker meant to address.
  const nickname = bridgeProbe?.connectedAccountDisplayName;
  const observedLoginName = bridgeProbe?.connected === true && bridgeProbe.platform === 'qq' &&
    bridgeProbe.protocol === 'onebot11' && bridgeProbe.accountId === event.accountId &&
    nickname?.source === 'onebot_get_login_info' && Number.isSafeInteger(nickname.observedAt) &&
    nickname.observedAt >= 0 && nickname.observedAt === bridgeProbe.checkedAt && displayName({ name: nickname.value })
    ? { value: nickname.value, source: nickname.source, observedAt: nickname.observedAt } : null;
  return {
    platformMessageId: event.message.id,
    sender: { platformUserId: event.sender.id, displayName: displayName(event.sender) },
    connectedAccountId: event.accountId,
    ...(observedLoginName ? { connectedAccountDisplayName: observedLoginName } : {}),
    explicitlyMentionsConnectedAccount: mentions.some(mention => !mention.all && mention.userId === event.accountId),
    observationCoverage: {
      basis: 'retained_accepted_inbound_and_current_sender',
      observedParticipantCount: observedParticipants.size,
      completeGroupRoster: false,
      nameMatchesScope: 'latest_names_of_observed_other_senders',
      noMatchMeaning: 'no_match_in_observed_names',
    },
    observedNameMatches: observedNameMatches.slice(0, MAX_NAME_MATCHES),
    ...(observedNameMatches.length > MAX_NAME_MATCHES ? { nameMatchesTruncated: true } : {}),
    ...(quoteLinks.length ? { quoteLinks } : {}),
  };
}
