import { randomUUID } from 'node:crypto';

export function parseStructuredReply(text, purpose) {
  const stripped = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(stripped); }
  catch (cause) { const error = new Error(`DSH ${purpose} response is not one complete JSON value: ${cause.message}`); error.code = 'INVALID_MODEL_JSON'; error.responseText = String(text); throw error; }
  if (!value || typeof value !== 'object' || Array.isArray(value) && purpose === 'control') {
    throw Object.assign(new Error('Structured model response must be an object'), { code: 'INVALID_MODEL_JSON', responseText: String(text) });
  }
  return value;
}

export function normalizeConsolidationReply(value, depth = 0) {
  if (depth > 6) throw Object.assign(new Error('Consolidation reply has excessive structural wrapping'), { code: 'INVALID_MODEL_PATCH' });
  if (Array.isArray(value)) return { entries: value };
  if (value && typeof value === 'object') {
    const controls = Object.fromEntries(['readContext', 'replaceDraft'].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
    if (Array.isArray(value.entries)) return value;
    if (value.patch !== undefined) return { ...normalizeConsolidationReply(value.patch, depth + 1), ...controls };
    if (value.readContext !== undefined || value.replaceDraft !== undefined) return { entries: [], ...controls };
    if (value.name === 'persona_memory_patch' && value.arguments !== undefined) {
      const args = typeof value.arguments === 'string' ? parseStructuredReply(value.arguments, 'consolidation') : value.arguments;
      return { ...normalizeConsolidationReply(args, depth + 1), ...controls };
    }
  }
  throw Object.assign(new Error('Consolidation model must return entries or patch entries; no record values were inferred'), { code: 'INVALID_MODEL_PATCH' });
}

/** Uses the host's own model service and credential resolution. Never reads keys. */
export function createDshModelPort(ctx, { getAgent, getSelection, maxTokens } = {}) {
  return {
    async complete(input) {
      const agent = getAgent?.(input.context);
      const selection = await getSelection?.(input.context, agent)
        ?? agent?.session?.requestHeader?.()?.config
        ?? ctx.get?.('agentDefaultModel')?.currentSelection?.();
      if (!selection?.provider || !selection?.model) {
        const error = new Error('No current DSH model route is available'); error.code = 'MODEL_ROUTE_UNAVAILABLE'; throw error;
      }
      const service = agent?.ctx?.llm ?? ctx.llm;
      if (typeof service?.stream !== 'function') throw new Error('The DSH llm.stream service is unavailable');
      const messages = input.messages.map(message => ({
        ...message,
        id: message.id ?? randomUUID(),
        content: typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content,
      }));
      const selectedMaxTokens = input.maxOutputTokens ?? maxTokens ?? (input.purpose === 'consolidation' ? 16384 : 4096);
      if (selectedMaxTokens !== undefined && (!Number.isSafeInteger(selectedMaxTokens) || selectedMaxTokens <= 0)) {
        throw Object.assign(new Error('Model output token budget must be a positive integer'), { code: 'MODEL_OUTPUT_BUDGET' });
      }
      const config = { provider: selection.provider, model: selection.model, messages,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        ...(selectedMaxTokens ? { maxTokens: selectedMaxTokens } : {}), signal: input.signal };
      const textBlocks = new Map();
      let usage = null;
      let finish = null;
      for await (const chunk of service.stream(config)) {
        if (chunk.type === 'text-delta') textBlocks.set(chunk.index, (textBlocks.get(chunk.index) ?? '') + chunk.text);
        else if (chunk.type === 'block-end' && chunk.block?.type === 'text') textBlocks.set(chunk.index, chunk.block.text);
        else if (chunk.type === 'usage') usage = chunk.usage;
        else if (chunk.type === 'finish') finish = chunk.reason;
      }
      if (!finish || finish.kind !== 'stop') {
        const error = new Error(`DSH model did not complete: ${finish?.kind ?? 'missing_finish'}`);
        error.code = 'MODEL_INCOMPLETE'; error.finish = finish; error.usage = usage; throw error;
      }
      const text = [...textBlocks.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join('');
      const result = { text, usage, model: `${selection.provider}/${selection.model}` };
      try {
        if (input.purpose === 'control') { const parsed = parseStructuredReply(text, 'control'); result.decision = parsed.decision ?? parsed; }
        else if (input.purpose === 'consolidation') result.patch = normalizeConsolidationReply(parseStructuredReply(text, 'consolidation'));
      } catch (error) { error.usage = usage; error.model = result.model; error.responseText ??= text; throw error; }
      return result;
    },
  };
}
