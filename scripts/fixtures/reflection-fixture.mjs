import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

export const inject = ['llm', 'personaMemory', 'agents', 'tools'];
const provider = 'persona-reflection-fixture', model = 'fixture-v1';
const textOf = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const argsOf = block => { try { return typeof block.arguments === 'string' ? JSON.parse(block.arguments) : block.arguments ?? {}; } catch { return {}; } };
const serial = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'signal' ? undefined : item));

export async function apply(ctx, config) {
  const { HostConnectionService } = await import(config.connectionModule);
  new HostConnectionService(ctx, [], {});
  mkdirSync(config.artifacts, { recursive: true });
  const record = value => appendFileSync(join(config.artifacts, 'native-events.private.jsonl'), JSON.stringify({ at: Date.now(), ...serial(value) }) + '\n');
  let phase = 'idle', handle; const handles = [], phaseRuns = new Map(), contexts = new Map();
  const manager = ctx.get('personaMemory');
  const capture = (kind, options) => appendFileSync(join(config.artifacts, 'requests.private.jsonl'), JSON.stringify({ kind, at: Date.now(), phase, provider: options.provider, model: options.model,
    tools: (options.tools ?? []).map(item => item.name), messages: serial(options.messages ?? []) }) + '\n');
  ctx.on('llm/stream', (options, next) => {
    if (options.provider !== provider || options.model !== model) { record({ kind: 'non-fixture-route-rejected', provider: options.provider, model: options.model }); throw Error('Reflection fixture refuses all non-fixture model routes'); }
    capture('host-llm-stream-input', options); return next();
  });
  ctx.on('agent/created', ({ agent, source }) => record({ kind: 'agent-created', sessionId: agent.id, header: agent.session.header, source }), { global: true });
  ctx.on('session/event', (session, event) => { if (['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end'].includes(event.type)) record({ kind: 'session-event', sessionId: session.id, event }); }, { global: true });
  const metadata = (p, m) => ({ provider: p, id: m, name: 'Reflection fixture; fixed responses only', context: { contextWindow: 1048576 }, defaultMaxTokens: 4096, inputModalities: ['text'], systemPromptUpdate: 'in-history' });
  const tool = (name, args) => ({ type: 'tool-call', id: 'reflection_' + randomUUID(), name, arguments: JSON.stringify(args) });
  function currentUser(messages) { let index = -1; for (let i = 0; i < messages.length; i++) if (messages[i].role === 'user' && messages[i].source?.kind === 'user') index = i; return { index, text: textOf(messages[index]) }; }
  function contextMaterial(input) {
    const value = input.input?.context; if (value?.format !== 'json_text_fragment' || !value.fragment) throw Error('Fixture did not receive actual frozen context pages');
    const state = contexts.get(input.runId) ?? { points: new Map(), total: value.fragment.total };
    const points = Array.from(value.text); if (points.length !== value.fragment.to - value.fragment.from || state.total !== value.fragment.total) throw Error('Actual frozen context is not stable');
    for (let i = 0; i < points.length; i++) { const at = value.fragment.from + i; if (state.points.has(at) && state.points.get(at) !== points[i]) throw Error('Actual frozen context page changed'); state.points.set(at, points[i]); }
    contexts.set(input.runId, state);
    if (state.points.size !== state.total) return { complete: false, nextCursor: value.nextCursor };
    return { complete: true, value: JSON.parse(Array.from({ length: state.total }, (_, i) => state.points.get(i)).join('')) };
  }
  function sourceRefs(input) {
    const records = input.input?.chat ?? [], seed = records.find(item => item.sourceEventId === 'reflection-human-create') ?? records[0];
    const hot = input.input?.hot?.find(item => item.sourceRef)?.sourceRef;
    return seed ? [{ sourceSessionId: seed.sourceSessionId, sourceEventId: seed.sourceEventId, available: true }] : hot ? [{ ...hot }] : [];
  }
  const entry = (input, documentKey, recordId, value) => ({ documentKey, recordId, expectedVersion: input.inputVersions[documentKey], operation: 'upsert', value });
  const remove = (input, recordId) => ({ documentKey: 'global:deep', recordId, expectedVersion: input.inputVersions['global:deep'], operation: 'remove' });
  function review(input) {
    const ids = phaseRuns.get(phase) ?? []; if (!ids.includes(input.runId)) ids.push(input.runId); phaseRuns.set(phase, ids);
    record({ kind: 'actual-personality-review-input', phase, runId: input.runId, page: input.page, context: input.input?.context, assistant: input.reviewAssistant });
    const material = contextMaterial(input);
    if (['context', 'soften', 'replace', 'prune'].includes(phase) && !material.complete) {
      if (material.nextCursor === null || material.nextCursor === undefined) throw Error('Actual context cannot continue');
      return { entries: [], readContext: { cursor: material.nextCursor } };
    }
    if (phase === 'create') {
      if ((input.previousProposedPatch ?? []).some(item => item.recordId === 'reflection_deep_a')) return { entries: [] };
      const refs = sourceRefs(input); if (!refs.length) return { entries: [] };
      const source = (input.input.chat ?? []).find(item => item.sourceEventId === 'reflection-human-create');
      if (!source || source.fragment && source.fragment.from > 0) return { entries: [] };
      const meta = { scope: 'global', personId: null, epistemic: 'interpretation', srcRefs: refs };
      return { entries: [entry(input, 'global:index', 'reflection_ordinary', { ...meta, kind: 'fact', text: 'ORDINARY_INDEX_KEPT_WITH_SOURCE\n' + source.text, keys: ['synthetic reflection fixture'], importance: null, aboutPersonIds: [], validFrom: null, validTo: null, supersedesIds: [] }),
        entry(input, 'global:deep', 'reflection_deep_a', { ...meta, title: '隔离样本：被误会之后得到澄清', reference: '记得那次误会与澄清；它是参考，不要求现在想起。',
          experience: 'DEEP_EXPERIENCE_ORIGINAL_BODY\n' + source.text, feltThen: '当时觉得难过，后来也感到被理解。', meaningNow: '我目前仍在理解这次经历。', cues: ['误会', '井绳'], aboutPersonIds: [], relatedMemoryIds: ['reflection_ordinary'], supersedesIds: [] })] };
    }
    if (phase === 'soften') {
      const old = material.value.deepMemories.find(item => item.id === 'reflection_deep_a'); if (!old) throw Error('Personality did not receive the old deep memory before reinterpretation');
      const { id, createdAt, updatedAt, ...value } = old;
      return { entries: [entry(input, 'global:deep', id, { ...value, reference: '那次误会后来有了澄清，我现在能用不同方式理解。', meaningNow: 'REINTERPRETED_BY_PERSONALITY_CHOICE：保留当时感受，现在更理解前后情境。' })] };
    }
    if (phase === 'replace') {
      const old = material.value.deepMemories.find(item => item.id === 'reflection_deep_a'); if (!old) throw Error('Actual old deep memory missing for autonomous replacement');
      const base = { ...old, experience: 'DEEP_REPLACEMENT_BODY：后来一起解决问题的经历更加深刻。', reference: '后来一起解决问题的经历，仍只是参考。', meaningNow: '我选择用后来的理解重新组织这段回忆。', supersedesIds: [old.id] };
      delete base.id; delete base.createdAt; delete base.updatedAt;
      return { entries: [remove(input, old.id), entry(input, 'global:deep', 'reflection_deep_b', { ...base, title: '隔离样本：后来共同解决问题' }), entry(input, 'global:deep', 'reflection_deep_c', { ...base, title: '隔离样本：待修剪的相关记忆', reference: '同一来源的另一个可修剪概括。' })] };
    }
    if (phase === 'prune') return { entries: [remove(input, 'reflection_deep_c')] };
    if (phase === 'paused') {
      const refs = sourceRefs(input), meta = { scope: 'global', personId: null, epistemic: 'interpretation', srcRefs: refs };
      return { entries: refs.length ? [entry(input, 'global:index', 'reflection_pending_candidate', { ...meta, kind: 'pattern', text: 'UNCOMMITTED_CANDIDATE_BODY', keys: [], importance: null, aboutPersonIds: [], validFrom: null, validTo: null, supersedesIds: [] })] : [],
        ...(input.input?.context?.nextCursor === null ? {} : { readContext: { cursor: input.input.context.nextCursor } }) };
    }
    return { entries: [] };
  }
  function boundedResult(messages, calls, name, args) {
    const selected = calls.filter(call => call.name === name); let value = '', offset = 0;
    for (const call of selected) {
      const message = messages.find(item => item.role === 'tool' && item.toolCallId === call.id); if (!message) throw Error('Actual tool result missing');
      const result = JSON.parse(textOf(message)); if (result.status !== 'bounded_preview') return { complete: true, value: result };
      const preview = result.preview; if (preview?.fragment?.from !== offset) throw Error('Actual tool result pages are not contiguous'); value += preview.text; offset = preview.fragment.to;
      if (preview.fragment.complete) return { complete: true, value: JSON.parse(value) };
      if (call === selected.at(-1)) return { complete: false, args: { ...args, cursor: result.nextCursor } };
    }
    return { complete: false, args };
  }
  const adapter = {
    providerInfo: p => ({ id: p, name: 'Fixed responses; no real model' }), providerRetryPolicy: () => undefined, imageRequestPricing: () => undefined,
    imageRequestTarget: (_p, _m, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }), listModels: async () => [{ id: model, name: 'Reflection fixture' }], resolveModel: async (p, m) => metadata(p, m),
    prepareCall: async (p, m) => ({ model: metadata(p, m), stream: options => adapter.stream(options) }),
    async *stream(options) {
      capture('fixture-provider-received-request', options); const messages = options.messages ?? [], first = textOf(messages[0]); let block;
      if (first.startsWith('You are the same continuing personality across people and settings.')) {
        let input; try { input = JSON.parse(textOf(messages.at(-1))); } catch { input = {}; } const env = input.environment ?? {};
        block = { type: 'text', text: JSON.stringify({ replyPlan: { action: 'reply', target: { channelId: env.channelId, sessionId: env.sessionId, personId: input.personId ?? null }, pendingEventIds: [], replyAt: null }, nextCheckAt: null }) };
      } else if (first.startsWith('You are an optional memory-material assistant')) {
        const input = JSON.parse(textOf(messages.at(-1))), ids = [...(input.input?.chat ?? []), ...(input.input?.hot ?? [])].map(item => item.id).filter(Boolean);
        record({ kind: 'actual-helper-input', phase, runId: input.runId, input });
        block = { type: 'text', text: JSON.stringify({ observations: [{ category: 'possible_fidelity_issue', detail: 'FIXTURE_HELPER_OPTIONAL_ADVICE：请自行判断是否需要采用这条资料核对提示。', recordIds: [...ids.slice(0, 1), 'helper_fabricated_source_id'] }],
          entries: [{ documentKey: 'persona', recordId: 'anchor', operation: 'upsert', value: { text: 'HELPER_PATCH_MUST_NEVER_COMMIT' } }], authoritative: true }) };
      } else if (first.startsWith('Organize this selected increment')) block = { type: 'text', text: JSON.stringify(review(JSON.parse(textOf(messages.at(-1))))) };
      else if ((options.tools ?? []).some(item => item.name === 'read') && !(options.tools ?? []).some(item => item.name === 'persona_task')) block = { type: 'text', text: 'REFLECTION_WORKER_PROCESS_ONLY: independent technical work, never human speech.' };
      else if ((options.tools ?? []).some(item => item.name === 'persona_task')) {
        const user = currentUser(messages), calls = messages.slice(user.index + 1).flatMap(message => (message.content ?? []).filter(block => block.type === 'tool-call'));
        if (phase === 'introspect' || phase === 'accounts') {
          const name = phase === 'introspect' ? 'persona_introspect' : 'persona_platform', args = phase === 'introspect' ? { section: 'deep' } : { action: 'accounts' };
          const response = boundedResult(messages, calls, name, args); block = response.complete ? { type: 'text', text: 'REFLECT_PHASE_FINISHED:' + phase } : tool(name, response.args);
        } else if (phase === 'delegate') {
          block = calls.some(item => item.name === 'persona_task') ? { type: 'text', text: 'REFLECT_PHASE_FINISHED:delegate' } : tool('persona_task', { action: 'create', title: 'Synthetic independent task', workspace: config.workspace, prompt: 'REFLECTION_WORKER_PROCESS_ONLY: complete an independent synthetic technical task without parent dialogue.' });
        } else if (['create', 'context', 'helper', 'soften', 'replace', 'prune', 'paused', 'postforget'].includes(phase)) {
          block = calls.some(item => item.name === 'persona_decide') ? { type: 'text', text: 'REFLECT_PHASE_FINISHED:' + phase } : tool('persona_decide', { consolidationPlan: { action: 'run', targetPersonIds: [null] }, nextCheckAt: null });
        } else block = { type: 'text', text: 'REFLECT_PHASE_FINISHED:' + phase + '：我们继续聊眼前的话题，我没有选择展开那段回忆。' };
      } else block = { type: 'text', text: '{}' };
      yield { type: 'block-start', index: 0, blockType: block.type };
      if (block.type === 'text') yield { type: 'text-delta', index: 0, text: block.text };
      else yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index: 0, block }; yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  ctx.llm.registerAdapter([provider], adapter); await manager.ready;
  const owner = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' }), foreign = ctx.connection.createPeer({ principal: { kind: 'other' }, interactions: 'none' }), carrier = ctx.connection.createSharedFetchHandler('/api');
  ctx.effect(() => async () => { await owner.dispose(); await foreign.dispose(); });
  const controlToken = randomBytes(24).toString('base64url');
  const server = createServer(async (request, response) => {
    const reply = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.headers.authorization !== 'Bearer ' + controlToken) { response.writeHead(401).end('{}'); return; }
    try {
      const parts = []; for await (const part of request) parts.push(part); const body = parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {};
      if (request.url === '/owner') {
        const envelope = { type: 'client-request', rpcId: 'reflection-owner-' + randomUUID(), method: 'persona-memory.manage', payload: { action: body.action, args: body.args ?? {} } };
        const result = await carrier.fetch(new Request('http://127.0.0.1/api/persona-memory.manage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) }), body.testForeign ? foreign : owner);
        return reply({ httpStatus: result.status, body: await result.text() });
      }
      if (request.url === '/begin') {
        handle = await ctx.agents.create({ sessionId: 'reflection_parent_fixture', agentOptions: { provider, model }, meta: { cwd: config.workspace } }); handles.push(handle);
        await ctx.get('agentPresets').select(handle.agent, 'persona-memory');
      }
      if (request.url === '/begin' || request.url === '/prompt') {
        phase = body.phase; record({ kind: 'fixture-phase-request', phase });
        handle.agent.followup({ id: body.sourceEventId ?? 'reflection-human-' + randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: body.text }] });
        await ctx.get('sessions').flush(handle.agent.session); return reply({ accepted: true, sessionId: handle.agent.id, phase });
      }
      if (request.url === '/state') {
        const c = manager.getCoordinator(); if (!c) return reply({ loaded: false, scopes: ctx.agents.list().map(agent => ({ sessionId: agent.id, status: agent.status, tools: ctx.tools.schemas(agent).map(item => item.name) })) });
        await c.readyState(); return reply({ loaded: true, phase, phaseRuns: Object.fromEntries(phaseRuns), memory: await c.repository.browseMemory({ scope: 'all', limit: 100 }), deep: await c.repository.introspect({ section: 'deep' }),
          persona: await c.repository.getPersona(), runtime: await c.repository.getRuntime(), runs: await c.repository.listConsolidationRuns(), errors: c.errors,
          scopes: ctx.agents.list().map(agent => ({ sessionId: agent.id, status: agent.status, header: agent.session.header, tools: ctx.tools.schemas(agent).map(item => item.name),
            snapshot: c.agents.get(agent.id)?.latestSnapshot ?? null, attachedToPersona: c.agents.has(agent.id) })) });
      }
      response.writeHead(404).end('{}');
    } catch (error) { record({ kind: 'fixture-control-error', code: error.code, message: error.message }); response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.code ?? error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  ctx.effect(() => async () => { for (const handle of handles) await handle.dispose?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  writeFileSync(join(config.artifacts, 'access.private.json'), JSON.stringify({ controlOrigin: 'http://127.0.0.1:' + server.address().port, controlToken }), { mode: 0o600 });
}
