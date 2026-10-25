/** Pure translation of the DSH event envelope. No personality decisions. */
export const AUTOMATIC_SOURCE_KINDS = new Set([
  'runtime-context', 'agent-instructions', 'skill-catalog', 'agent-message',
  'subagent-settled', 'system', 'persona-memory', 'persona-memory:control',
  'persona-memory:delivery', 'persona-memory:wake',
]);

export function sourceClassification(kind, participantSourceKinds = ['user']) {
  if (participantSourceKinds.includes(kind)) return 'participant_dialogue';
  if (kind === 'agent-message' || kind === 'subagent-settled') return 'agent_message';
  if (kind === 'agent-instructions' || kind === 'skill-catalog') return 'agent_instructions';
  if (kind === 'runtime-context') return 'runtime_context';
  return 'plugin_state';
}

export function textOf(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
    : '';
}

export function normalizeDshEvent(session, event, options = {}) {
  const hostMessage = event?.type === 'assistant/message' ? event.data?.message : event?.type === 'user/message' ? event.data : null;
  const messageId = options.sourceEventId ?? hostMessage?.id;
  if (!session?.id || !event || (!messageId && !Number.isSafeInteger(event.seq))) return { dialogue: null, hot: [], ignored: 'missing_stable_source' };
  const sourceSessionId = String(session.id);
  // Inbox messages have IDs before admission; keep the same key after user/message commits.
  const sourceEventId = String(messageId ?? event.seq);
  const sourceAt = Number.isFinite(event.time) ? event.time : (options.now ?? Date.now());
  const observedAt = options.now ?? Date.now();
  const timezone = options.timezone ?? 'UTC';
  const base = {
    sourceSessionId, sourceEventId, sourceAt, observedAt, timezone,
    channelId: options.channelId ?? `dsh:${sourceSessionId}`,
    personId: options.personId ?? null, speakerId: Object.hasOwn(options, 'speakerId') ? options.speakerId ?? null : options.personId ?? null,
  };
  const hot = [];
  const sourceRef = (kind, role, origin) => ({ sourceSessionId, sourceEventId, available: true, sourceKind: kind, sourceRole: role, sourceOrigin: origin });
  if (event.type === 'user/message') {
    const message = event.data ?? {};
    const sourceKind = message.source?.kind ?? 'unknown';
    const classification = sourceClassification(sourceKind, options.participantSourceKinds);
    const actorBase = classification === 'participant_dialogue' ? base : { ...base, speakerId: null };
    const text = textOf(message.content);
    if (text) hot.push({ ...actorBase, sourceKind, sourceRef: sourceRef(sourceKind, 'user', classification === 'participant_dialogue' ? 'user' : 'system'),
      origin: classification === 'participant_dialogue' ? 'user' : 'system', kind: classification === 'participant_dialogue' ? 'dialogue' : classification,
      content: { mode: 'cached', text, chars: [...text].length }, navigationSummary: null });
    return {
      dialogue: classification === 'participant_dialogue' && text
        ? { ...actorBase, sourceKind, contentClass: 'participant_dialogue', role: 'user', origin: 'user', text,
          chars: [...text].length, proactiveId: null, reactionTo: null }
        : null,
      hot,
      ignored: classification === 'participant_dialogue' ? null : 'automatic_context',
    };
  }
  if (event.type === 'assistant/message') {
    const message = event.data?.message ?? {};
    const sourceKind = message.source?.kind ?? 'model';
    const actorBase = { ...base, speakerId: options.assistantSpeakerId ?? (options.speakerId !== base.personId ? options.speakerId : null) ?? null };
    const origin = options.proactiveId ? 'ai_initiated' : 'ai_reply';
    const content = Array.isArray(message.content) ? message.content : [];
    for (let index = 0; index < content.length; index++) {
      const block = content[index];
      if (block?.type === 'text' || block?.type === 'reasoning') {
        if (typeof block.text !== 'string' || !block.text) continue;
        hot.push({ ...actorBase, blockIndex: index, sourceKind, sourceRef: sourceRef(sourceKind, 'assistant', origin), origin,
          kind: block.type === 'text' ? 'dialogue' : 'reasoning', content: { mode: 'cached', text: block.text, chars: [...block.text].length }, navigationSummary: null });
      } else if (block?.type === 'tool-call') {
        const text = JSON.stringify({ name: block.name, arguments: block.arguments, callId: block.id });
        hot.push({ ...actorBase, blockIndex: index, sourceKind, sourceRef: sourceRef(sourceKind, 'assistant', origin), origin,
          kind: 'tool_call', content: { mode: 'cached', text, chars: [...text].length }, navigationSummary: null });
      }
    }
    const text = textOf(content);
    return { dialogue: text ? { ...actorBase, sourceKind, contentClass: 'participant_dialogue', role: 'assistant', origin, text,
      chars: [...text].length, proactiveId: options.proactiveId ?? null, reactionTo: null } : null, hot, ignored: null };
  }
  if (event.type === 'tool/result') {
    const text = JSON.stringify(event.data ?? null);
    hot.push({ ...base, speakerId: null, sourceKind: 'tool/result', sourceRef: sourceRef('tool/result', 'assistant', 'system'), origin: 'system', kind: 'tool_result',
      content: { mode: 'cached', text, chars: [...text].length }, navigationSummary: null });
  }
  return { dialogue: null, hot, ignored: hot.length ? null : 'not_memory_input' };
}

export function dshEnvironment(agent, { now = Date.now(), timezone = 'UTC', displayName = null } = {}) {
  const session = agent.session;
  return {
    schemaVersion: 'persona-memory/3', version: now, observedAt: now,
    channelId: `dsh:${session.id}`, sessionId: session.id, platform: 'dsh',
    placeDescription: session.header?.cwd ? `DSH workspace ${session.header.cwd}` : 'DSH conversation',
    participantClues: [{ externalId: null, displayName, avatarRef: null }],
    visual: { available: false, adapterId: null, observation: null }, timezone,
  };
}
