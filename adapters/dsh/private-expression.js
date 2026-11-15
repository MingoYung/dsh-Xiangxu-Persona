import { resolveExternalOutput, resolvePartialQqReply } from './external-output.js';
import { textOf } from './normalize.js';

export function confirmedPrivateText(message, receipt) {
  if (message.role !== 'assistant' || !Array.isArray(message.content) ||
    message.content.some(block => block.type === 'tool-call')) return null;
  const original = textOf(message.content);
  if (!original) return null;
  if (receipt?.status === 'delivered') return resolveExternalOutput(original, receipt)?.text ?? null;
  if (receipt?.status === 'partial') return resolvePartialQqReply(original, receipt);
  return null;
}

/** Build a separate request view, never editing messages or the session log. */
export function privateExpressionMessages(messages, { currentSources, isParticipant, receiptFor, isRevoked = () => false }) {
  const ids = new Set(currentSources.map(source => source.sourceEventId));
  const claimed = messages.filter(message => ids.has(message.id) && isParticipant(message) &&
    currentSources.some(source => source.sourceEventId === message.id && source.platformMessageId === message.source.platformMessageId));
  if (!ids.size || new Set(claimed.map(message => message.id)).size !== ids.size || claimed.length !== ids.size) {
    throw Object.assign(new Error('QQ 私聊表达入口未能核实本轮来信'), { code: 'PRIVATE_EXPRESSION_INPUT_MISSING' });
  }
  if (claimed.some(message => isRevoked(message.id))) {
    throw Object.assign(new Error('本轮来信已撤销'), { code: 'PRIVATE_EXPRESSION_INPUT_REVOKED' });
  }
  const boundary = messages.indexOf(claimed[0]), result = [];
  for (const message of messages.slice(0, boundary)) {
    if (message.role === 'system' || message.role === 'developer') result.push(message);
    else if (!isRevoked(message.id)) {
      if (isParticipant(message)) result.push(message);
      else if (message.role === 'assistant') {
        const visible = confirmedPrivateText(message, receiptFor(message.id));
        if (visible) {
          const { replayState: _oldReplayState, ...source } = message.source ?? {};
          result.push({ ...message, source, content: [{ type: 'text', text: visible }] });
        }
      }
    }
  }
  // A native tool round after this admitted input belongs to the current
  // exchange. Its reasoning, calls, replay signatures and results stay paired.
  return [...result, ...messages.slice(boundary)];
}
