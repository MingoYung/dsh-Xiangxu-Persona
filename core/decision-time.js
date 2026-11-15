import { SchemaError, validateDecision } from './schema.js';

/** Render a known epoch time in the specified IANA zone without changing it. */
export function formatLocalTime(epochMs, timezone) {
  if (!Number.isSafeInteger(epochMs) || typeof timezone !== 'string' || !timezone || !Number.isFinite(new Date(epochMs).getTime())) return null;
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, timeZoneName: 'longOffset',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  const { year, month, day, hour, minute, second, timeZoneName } = Object.fromEntries(formatter.formatToParts(epochMs).map(({ type, value }) => [type, value]));
  const offset = timeZoneName === 'GMT' ? '+00:00' : timeZoneName.slice(3);
  return `${year.padStart(4, '0')}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
}

/** Translate a chosen duration once, at durable decision admission. No scheduler
 * policy or personality preference is selected here. Persist only absolute times
 * so cold recovery and operation replay never restart the chosen delay. */
export function resolveDecisionTimes(input, now) {
  validateDecision(input);
  if (!Number.isSafeInteger(now) || now < 0) throw new SchemaError('Decision clock must be a nonnegative safe epoch millisecond integer');
  const result = structuredClone(input);
  const resolve = (object, relative, absolute) => {
    if (!object || !Object.hasOwn(object, relative)) return;
    const delay = object[relative];
    if (delay === null) { if (!Object.hasOwn(object, absolute)) object[absolute] = null; }
    else {
      const value = now + delay;
      if (!Number.isSafeInteger(value) || value < 0) throw new SchemaError(relative + ' exceeds the safe epoch millisecond range');
      object[absolute] = value;
    }
    delete object[relative];
  };
  resolve(result, 'nextCheckAfterMs', 'nextCheckAt');
  resolve(result.replyPlan, 'replyAfterMs', 'replyAt');
  resolve(result.sleepPlan, 'wakeAfterMs', 'wakeAt');
  return result;
}
