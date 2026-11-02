import { SchemaError, validateDecision } from './schema.js';

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
