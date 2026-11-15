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
export function createDshModelPort(ctx, { getAgent, getSelection, maxTokens, memoryRoot, replyContext } = {}) {
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
      let requestMessages = input.messages;
      // The adapter can provide the current registered group scene to the
      // auxiliary draft path as well as the native reply path. It is automatic
      // system material, never another participant message or a second model.
      const scene = input.purpose === 'reply' ? await replyContext?.(input.context) : null;
      if (scene != null) {
        if (typeof scene.text !== 'string' || !scene.text.trim() || !scene.text.isWellFormed() ||
          !Number.isSafeInteger(scene.maxInputTokens) || scene.maxInputTokens < 1 || typeof scene.countTokens !== 'function') {
          throw Object.assign(new Error('Auxiliary group context requires complete text and the existing input-budget counter'), { code: 'MODEL_REPLY_CONTEXT_INVALID' });
        }
        requestMessages = [...input.messages, { role: 'system', source: { kind: 'persona-memory:auxiliary-group-context' },
          content: '（以下是程序提供的当前群聊现场与交付契约，不是人类新发言。）\n' + scene.text }];
        // Core counted the original logical messages. Recount the complete
        // augmented messages with that same counter and limit before streaming.
        const tokens = await scene.countTokens(JSON.stringify(requestMessages));
        if (!Number.isFinite(tokens) || tokens < 0) throw Object.assign(new Error('Auxiliary group context token count is invalid'), { code: 'MODEL_REPLY_CONTEXT_INVALID' });
        if (tokens > scene.maxInputTokens) throw Object.assign(new Error('Selected model input including current group context exceeds the supplied model input budget'), { code: 'MODEL_INPUT_BUDGET' });
      }
      const messages = requestMessages.map(message => ({
        ...message,
        id: message.id ?? randomUUID(),
        content: typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content,
      }));
      const selectedMaxTokens = input.maxOutputTokens ?? maxTokens ?? (input.purpose === 'consolidation' ? 16384 : 4096);
      if (selectedMaxTokens !== undefined && (!Number.isSafeInteger(selectedMaxTokens) || selectedMaxTokens <= 0)) {
        throw Object.assign(new Error('Model output token budget must be a positive integer'), { code: 'MODEL_OUTPUT_BUDGET' });
      }
      // Routing evidence for scoped cost monitoring only. Keep it separate from
      // the native sessionId: auxiliary prompts are not native reply projections.
      const contextSessionId = input.context?.target?.sessionId ?? input.context?.sessionId
        ?? input.context?.environment?.sessionId ?? agent?.session?.id ?? null;
      const xiangxuAccounting = {
        sessionId: typeof contextSessionId === 'string' && contextSessionId.length ? contextSessionId : null,
        memoryRoot: typeof memoryRoot === 'string' && memoryRoot.length ? memoryRoot : null,
        purpose: typeof input.purpose === 'string' && input.purpose.length ? input.purpose : null,
      };
      const config = { provider: selection.provider, model: selection.model, messages, xiangxuAccounting,
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
