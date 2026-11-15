import { createHash } from 'node:crypto';
import { extractProcessDependencies } from '../../core/source-dependencies.js';

const SHA256 = /^[A-Za-z0-9_-]{43}$/;
const hash = (text, encoding = 'base64url') => createHash('sha256').update(text).digest(encoding);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export function badHistoricalPlatformResult(message) {
  return Object.assign(new Error(message), { code: 'HISTORICAL_PLATFORM_RESULT_UNVERIFIED' });
}

function cursorShape(value, query, offset) {
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return cursor?.v === 1 && cursor.t === 'persona_platform' && cursor.q === query && typeof cursor.s === 'string' && SHA256.test(cursor.s) && cursor.i === 0 && cursor.o === offset
      ? cursor.s : null;
  } catch { return null; }
}

/** Complete old pages by their exact result hash. No platform calls are replayed. */
export function historicalPlatformProofs(events, unconfiguredBilibiliResult, epoch) {
  const unconfiguredShape = hash(unconfiguredBilibiliResult);
  const calls = new Map();
  for (const { type, data, seq } of events) if (type === 'tool/call' && typeof data?.callId === 'string') {
    const { callId } = data;
    calls.set(callId, calls.has(callId) ? null : { data, seq });
  }
  const groups = new Map();
  for (const { type, data, seq } of events) {
    if (type !== 'tool/result' || !Number.isSafeInteger(seq)) continue;
    const { message, turn, step } = data ?? {};
    const callId = message?.toolCallId;
    const call = calls.get(callId);
    const block = message?.content?.[0];
    if (call?.data.name !== 'persona_platform' || call.seq >= seq || call.data.turn !== turn || call.data.step !== step ||
        !Number.isSafeInteger(turn) || !Number.isSafeInteger(step) || message.source?.kind !== 'tool' || message.source?.callId !== callId ||
        (data.callId != null && data.callId !== callId) || message.role !== 'tool' || message.isError !== false ||
        !Array.isArray(message.content) || message.content.length !== 1 || block?.type !== 'text' || typeof block.text !== 'string' || block.text.length > 32768) continue;
    let page, args;
    try {
      page = JSON.parse(block.text);
      args = typeof call.data.arguments === 'string' ? JSON.parse(call.data.arguments) : call.data.arguments;
    } catch { continue; }
    if (!args || typeof args !== 'object' || Array.isArray(args) || page?.status !== 'bounded_preview' || page.detailRef?.tool !== 'persona_platform' ||
        page.preview?.format !== 'json_text_fragment') continue;
    const { from, to, total, complete } = page.preview.fragment ?? {};
    if (![from, to, total].every(Number.isSafeInteger) || from < 0 || to <= from || to > total || total > 16384 || complete !== (to === total) ||
        typeof page.preview.text !== 'string') continue;
    const { cursor, ...input } = args;
    const query = hash(JSON.stringify(canonical(input)));
    const incoming = cursorShape(cursor, query, from), outgoing = cursorShape(page.nextCursor, query, to);
    if (from === 0 ? cursor != null : !incoming) continue;
    if (complete ? from === 0 || page.nextCursor !== null : !outgoing) continue;
    if (incoming && outgoing && incoming !== outgoing) continue;
    const fragment = Array.from(page.preview.text);
    if (fragment.length !== to - from) continue;
    const shape = incoming ?? outgoing;
    const group = groups.get(shape) ?? [];
    group.push({ seq, turn, callId, total, from, fragment, textHash: hash(block.text, 'hex'), unconfiguredInspection: args.platform === 'bilibili' && args.action === 'inspect' });
    groups.set(shape, group);
  }
  const proofs = new Map();
  for (const [shape, group] of groups) {
    const points = shape === unconfiguredShape && group.every(page => page.unconfiguredInspection)
      ? Array.from(unconfiguredBilibiliResult) : new Array(group[0].total).fill(null);
    let consistent = true;
    for (const page of group) {
      if (page.total !== points.length) { consistent = false; break; }
      for (const [index, point] of page.fragment.entries()) {
        const offset = page.from + index;
        if (points[offset] !== null && points[offset] !== point) { consistent = false; break; }
        points[offset] = point;
      }
    }
    if (!consistent || points.includes(null)) continue;
    const text = points.join('');
    if (hash(text) !== shape) continue;
    try { JSON.parse(text); } catch { continue; }
    const envelope = { message: { role: 'tool', source: { kind: 'tool' }, content: [{ type: 'text', text }] } };
    const scan = extractProcessDependencies({ kind: 'tool_result', sourceKind: 'tool/result', content: { mode: 'cached', text: JSON.stringify(envelope) } });
    if (!scan.complete) continue;
    for (const { seq, turn, callId, textHash } of group) proofs.set(seq, { turn, epoch, callId, textHash, scan });
  }
  return proofs;
}
