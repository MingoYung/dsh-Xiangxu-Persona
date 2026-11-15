import { formatLocalTime } from '../../core/decision-time.js';

const dayMs = 86_400_000;

function localMidnightAsUtc(localTime) {
  const [year, month, day] = localTime.split('T')[0].split('-').map(Number);
  // Compare calendar dates independently of the elapsed time or a DST change.
  return new Date(0).setUTCFullYear(year, month - 1, day);
}

function elapsedLabel(elapsedMs) {
  let remaining = elapsedMs;
  const parts = [];
  for (const [unitMs, unit] of [[dayMs, '天'], [3_600_000, '小时'], [60_000, '分钟'], [1_000, '秒']]) {
    const count = Math.floor(remaining / unitMs);
    if (count) parts.push(count + ' ' + unit);
    remaining %= unitMs;
  }
  return parts.length ? (remaining ? '约 ' : '') + parts.join(' ') : elapsedMs ? '不足 1 秒' : '0 秒';
}

function sourceTiming(sourceAt, sourceAtLocal, snapshot) {
  if (!Number.isSafeInteger(snapshot?.now)) return {};
  const elapsedMs = snapshot.now - sourceAt;
  if (!Number.isSafeInteger(elapsedMs)) return {};
  if (elapsedMs < 0) return { relativeToRequest: { status: 'source_after_request',
    summary: '这条来信的平台时间晚于请求时钟，时钟可能不一致，暂不能确定已过去多久。' } };
  if (!sourceAtLocal || typeof snapshot.localTime !== 'string') return {};
  const calendarDaysAgo = (localMidnightAsUtc(snapshot.localTime) - localMidnightAsUtc(sourceAtLocal)) / dayMs;
  if (!Number.isSafeInteger(calendarDaysAgo) || calendarDaysAgo < 0) return {};
  const calendarDay = calendarDaysAgo === 0 ? '今天' : calendarDaysAgo === 1 ? '昨天' : calendarDaysAgo + ' 个日历日前';
  return { relativeToRequest: { status: 'computed', calendarDaysAgo, elapsedMs,
    summary: '按 ' + snapshot.timezone + ' 的日历，这条来信的平台日期是' + calendarDay + '，与本次请求相隔 ' + elapsedLabel(elapsedMs) + '。' } };
}

/** Link the actual external route to the SAME snapshot's self description.
 * This is source metadata, not an addressee guess or an exclusive name list.
 */
export function externalConversationReference(channel, snapshot, externalInput) {
  if (!channel) return '';
  const profile = snapshot?.selfProfileReference ?? {};
  const sourceAt = externalInput?.sourceAt;
  const sourceAtLocal = formatLocalTime(sourceAt, snapshot?.timezone);
  const currentName = profile.shown?.includes('current.name') ? 'presented_in_self_profile'
    : profile.omitted?.includes('current.name') ? 'not_presented'
      : profile.fullProfileAvailable === true ? 'not_recorded' : 'unavailable';
  const value = {
    connectedAccount: { platform: channel.platform, platformUserId: channel.accountId, source: 'current_channel_binding' },
    selfDescription: { section: 'self_profile', version: profile.version ?? null,
      currentName: { status: currentName, source: 'self_profile.current.name' } },
    currentSender: { platformUserId: channel.sender?.id ?? null, displayName: channel.sender?.name ?? null,
      source: 'current_channel_binding' },
    // Native message.source is a host transport envelope; not all providers
    // serialize it for the model. Give read tools a visible, genuine reference
    // even when optional environment_details do not fit the core context page.
    ...(typeof externalInput?.platformMessageId === 'string' && externalInput.platformMessageId
      ? { inputSource: { platformMessageId: externalInput.platformMessageId, source: 'accepted_platform_input',
        // Observations describe this specific source. The native history may
        // retain earlier images and quotes with different processing outcomes.
        observations: { textComplete: externalInput.textComplete, structuredMediaCount: externalInput.structured?.media ?? 0,
          structuredReplyCount: externalInput.structured?.replies ?? 0, unsupportedSegmentTypeCount: externalInput.unsupportedSegments?.length ?? 0 },
        ...(Number.isSafeInteger(sourceAt) ? { sourceAt, sourceAtLocal, ...sourceTiming(sourceAt, sourceAtLocal, snapshot) } : {}),
      } } : {}),
  };
  return '[conversation_identity_reference]\n' + JSON.stringify(value) + '\n';
}
