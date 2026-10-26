import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

export const inject = ['llm', 'personaMemory', 'agents', 'tools'];
const provider = 'persona-delegation-fixture', model = 'fixture-v1';
const textOf = message => (message?.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
const argsOf = block => { try { return typeof block.arguments === 'string' ? JSON.parse(block.arguments) : block.arguments; } catch { return {}; } };
const serial = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'signal' ? undefined : item));
const report = 'TASK_REPORT_FIRST_CHOSEN_INSIGHT technical work may be remembered by choice. 完整报告🙂\n' + 'TASK_FULL_PROCESS_ONLY 原始技术细节保持完整，不冒充人类原话。\n'.repeat(1800) + 'TASK_REPORT_LAST_END';

export async function apply(ctx, config) {
  mkdirSync(config.artifacts, { recursive: true });
  const record = value => appendFileSync(join(config.artifacts, 'native-events.private.jsonl'), JSON.stringify({ at: Date.now(), ...serial(value) }) + '\n');
  const capture = (kind, options) => appendFileSync(join(config.artifacts, 'requests.private.jsonl'), JSON.stringify({ kind, at: Date.now(), provider: options.provider, model: options.model, tools: (options.tools ?? []).map(x => x.name), messages: serial(options.messages ?? []) }) + '\n');
  ctx.on('llm/stream', (options, next) => {
    if (options.provider !== provider || options.model !== model) { record({ kind: 'non-fixture-route-rejected', provider: options.provider, model: options.model }); throw Error('Dedicated delegation fixture refuses non-fixture routes'); }
    capture('host-llm-stream-input', options); return next();
  });
  ctx.on('agent/created', ({ agent, source }) => record({ kind: 'agent-created', sessionId: agent.id, header: agent.session.header, source, tools: ctx.tools.schemas(agent).map(x => x.name) }), { global: true });
  ctx.on('session/event', (session, event) => { if (['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end'].includes(event.type)) record({ kind: 'session-event', sessionId: session.id, event: serial(event) }); }, { global: true });
  const manager = ctx.get('personaMemory');
  const scopeSample=agent=>({sessionId:agent?.id,preset:agent?ctx.get('agentPresets').composedPreset(agent.ctx):null,tools:agent?ctx.tools.schemas(agent).map(x=>x.name):[],attached:agent?manager.getCoordinator()?.agents.has(agent.id):false,disposers:agent?manager.getCoordinator()?.agents.get(agent.id)?.disposers?.length:null});
  ctx.on('agent/pre-step',async(payload,next)=>{record({kind:'diagnostic-pre-step-before',...scopeSample(payload.agent)});const value=await next();record({kind:'diagnostic-pre-step-after',...scopeSample(payload.agent),decision:value.kind});return value;},{global:true,prepend:true});
  ctx.on('system-prompt/assemble',async(assembly,context,next)=>{record({kind:'diagnostic-prompt-before',...scopeSample(context.agent)});const value=await next();record({kind:'diagnostic-prompt-after',...scopeSample(context.agent),sections:value.sections?.map(x=>x.name)});return value;},{global:true,prepend:true});
  const metadata = (p, m) => ({ provider: p, id: m, name: 'Isolated delegation fixture', context: { contextWindow: 1048576 }, defaultMaxTokens: 4096, inputModalities: ['text'], systemPromptUpdate: 'in-history' });
  const tool = (name, args, callId) => ({ type: 'tool-call', id: callId ?? 'delegation_fixture_' + randomUUID(), name, arguments: JSON.stringify(args) });
  function latestUser(messages) { for (let index = messages.length - 1; index >= 0; index--) if (messages[index].role === 'user' && messages[index].source?.kind === 'user') return { message: messages[index], index, text: textOf(messages[index]) }; return { index: -1, text: '' }; }
  function toolResult(messages, call) { if (!call) return null; const message = messages.find(x => x.role === 'tool' && x.toolCallId === call.id); if (!message) return null; try { return JSON.parse(textOf(message)); } catch { return { text: textOf(message) }; } }
  function pagedToolResult(messages, calls, action) {
    const selected = calls.filter(call => call.name === 'persona_task' && argsOf(call).action === action);
    let text = '', offset = 0;
    for (const call of selected) {
      const result = toolResult(messages, call);
      if (!result) throw Error('Tool continuation has no real result: ' + call.id);
      if (result.status !== 'bounded_preview') return { value: result, complete: true };
      const preview = result.preview;
      if (preview?.format !== 'json_text_fragment' || preview.fragment.from !== offset) throw Error('Bounded tool response cursor is not contiguous');
      text += preview.text; offset = preview.fragment.to;
      if (preview.fragment.complete) {
        record({ kind: 'fixture-consumed-complete-tool-response', action, pages: selected.indexOf(call) + 1, chars: offset });
        return { value: JSON.parse(text), complete: true };
      }
      if (call === selected.at(-1)) {
        if (!result.nextCursor || selected.length > 80) throw Error('Bounded tool response cannot continue');
        return { complete: false, nextArguments: { ...argsOf(selected[0]), cursor: result.nextCursor } };
      }
    }
    return { complete: false };
  }
  function fileArgs(options, name, target, body) {
    const definition = options.tools.find(x => x.name === name), props = definition?.parameters?.properties ?? definition?.parameters ?? {};
    const key = ['path', 'file_path', 'filePath'].find(x => props[x]); if (!key) throw Error('Cannot find actual file-tool path parameter: ' + JSON.stringify(definition));
    const args = { [key]: target };
    if (body !== undefined) { const field = ['content', 'text', 'contents'].find(x => props[x]); if (!field) throw Error('Cannot find actual write-tool content parameter'); args[field] = body; }
    return args;
  }
  const adapter = { providerInfo: p => ({ id: p, name: 'Fixed responses; no real language model' }), providerRetryPolicy: () => undefined, imageRequestPricing: () => undefined,
    imageRequestTarget: (_p, _m, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }), listModels: () => Promise.resolve([{ id: model, name: 'Delegation fixture' }]), resolveModel: (p, m) => Promise.resolve(metadata(p, m)),
    prepareCall: async (p, m) => ({ model: metadata(p, m), stream: options => adapter.stream(options) }),
    async *stream(options) {
      capture('fixture-provider-received-request', options); const messages = options.messages ?? [], firstSystem = textOf(messages[0]); let block;
      if (firstSystem.startsWith('You are the same continuing personality across people and settings.')) {
        let input; try { input = JSON.parse(textOf(messages.at(-1))); } catch { input = {}; }
        const env = input.environment ?? {}; block = { type: 'text', text: JSON.stringify({ replyPlan: { action: 'reply', target: { channelId: env.channelId, sessionId: env.sessionId, personId: input.personId ?? null }, pendingEventIds: [], replyAt: null }, nextCheckAt: null }) };
      } else if (firstSystem.startsWith('Organize this selected increment')) {
        record({ kind: 'memory-review-input', messages }); block = { type: 'text', text: JSON.stringify({ entries: [] }) };
      } else if ((options.tools ?? []).some(x => x.name === 'read') && !(options.tools ?? []).some(x => x.name === 'persona_task')) {
        const calls = messages.flatMap(message => (message.content ?? []).filter(x => x.type === 'tool-call'));
        if (latestUser(messages).text.includes('WORKER_RESUMED_REVOKED_IDENTITY')) block = { type: 'text', text: 'WORKER_REVOKED_ROLE_STAYS_TECHNICAL' };
        else if (!calls.some(x => x.name === 'read')) block = tool('read', fileArgs(options, 'read', join(config.workspace, 'input.txt')), 'worker_reads_actual_file');
        else if (!calls.some(x => x.name === 'write')) block = tool('write', fileArgs(options, 'write', join(config.workspace, 'worker-report.txt'), report), 'worker_writes_actual_report');
        else block = { type: 'text', text: report };
      } else if ((options.tools ?? []).some(x => x.name === 'persona_task')) {
        const user = latestUser(messages), calls = messages.slice(user.index + 1).flatMap(message => (message.content ?? []).filter(x => x.type === 'tool-call'));
        const current = user.text;
        if (current.includes('TASK_PARENT_START')) {
          if (!calls.some(x => x.name === 'memory_search')) block = tool('memory_search', { query: 'TASK_PARENT_START', scope: 'all', limit: 3 }, 'parent_reads_real_source_before_delegating');
          else if (!calls.some(x => x.name === 'persona_task' && argsOf(x).action === 'create')) block = tool('persona_task', { action: 'create', title: 'Isolated engineering and research', workspace: config.workspace, prompt: 'TASK_WORKER_PAYLOAD: Read input.txt, write worker-report.txt, preserve all technical details in your final report.' }, 'parent_native_create_once');
          else block = { type: 'text', text: 'TASK_PARENT_CREATED_AND_CONTINUES' };
        } else if (current.includes('TASK_PARENT_READ') || current.includes('TASK_PARENT_RETAIN')) {
          const taskId = current.match(/task-[a-f0-9]+/)?.[0], statusCall = calls.find(x => x.name === 'persona_task' && argsOf(x).action === 'status');
          const status = pagedToolResult(messages, calls, 'status');
          const action = current.includes('TASK_PARENT_RETAIN') ? 'retain' : 'read';
          if (!statusCall) block = tool('persona_task', { action: 'status', taskId, documentLimit: 1 });
          else if (!status.complete) block = tool('persona_task', status.nextArguments);
          else if (!calls.some(x => x.name === 'persona_task' && argsOf(x).action === action)) {
            if (!status.value?.resultDocumentId) throw Error('Task has no archived final result: ' + JSON.stringify(status.value));
            block = tool('persona_task', { action, taskId, documentId: status.value.resultDocumentId, offset: 0, maxChars: action === 'retain' ? 800 : 2400 });
          } else {
            const output = pagedToolResult(messages, calls, action);
            block = output.complete ? { type: 'text', text: action === 'retain' ? 'TASK_PARENT_RETAIN_SELECTED' : 'TASK_PARENT_READ_ON_DEMAND' } : tool('persona_task', output.nextArguments);
          }
        } else if (current.includes('TASK_PARENT_REVIEW') && !calls.some(x => x.name === 'persona_decide')) block = tool('persona_decide', { consolidationPlan: { action: 'run', targetPersonIds: [null] }, nextCheckAt: null });
        else block = { type: 'text', text: 'TASK_PARENT_REVIEW_CHOSE_NO_AUTOMATIC_PERSONALITY_CHANGE' };
      } else block = { type: 'text', text: '{}' };
      yield { type: 'block-start', index: 0, blockType: block.type };
      if (block.type === 'text') yield { type: 'text-delta', index: 0, text: block.text };
      else yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index: 0, block }; yield { type: 'finish', reason: { kind: 'stop' } };
    } };
  ctx.llm.registerAdapter([provider], adapter); await manager.ready;
  const controlToken = randomBytes(24).toString('base64url'); let handle, resumedWorker;
  const control = createServer(async (request, response) => {
    const reply = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.headers.authorization !== 'Bearer ' + controlToken) { response.writeHead(401).end('{}'); return; }
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      const c = manager.getCoordinator(); await c.ready;
      if (request.url === '/begin') {
        handle = await ctx.agents.create({ sessionId: 'delegation_parent_fixture', agentOptions: { provider, model }, meta: { cwd: config.workspace } });
        await ctx.get('agentPresets').select(handle.agent, 'persona-memory');
        record({kind:'diagnostic-immediate-select-returned',...scopeSample(handle.agent)});
        handle.agent.followup({ id: 'parent-original-human-message', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'TASK_PARENT_START PARENT_PRIVATE_ONLY Keep the full work process in an independent task.' }] });
        await ctx.get('sessions').flush(handle.agent.session); return reply({ accepted: true, parentSessionId: handle.agent.id });
      }
      if (request.url === '/prompt') { handle.agent.followup({ id: 'parent-human-' + randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: body.text }] }); await ctx.get('sessions').flush(handle.agent.session); return reply({ accepted: true }); }
      if (request.url === '/snapshot') {
        await c.readyState(); return reply({ loaded: true, tasks: await c.tasks.list(), memory: await c.repository.browseMemory({ scope: 'all', limit: 100 }), persona: await c.repository.getPersona(), runtime: await c.repository.getRuntime(), errors: c.errors,
          scopes: ctx.agents.list().map(agent => ({ sessionId: agent.id, status: agent.status, header: agent.session.header, tools: ctx.tools.schemas(agent).map(x => x.name), attachedToPersona: c.agents.has(agent.id) })) });
      }
      if (request.url === '/task') return reply(await c.tasks.get({ taskId: body.taskId }));
      if (request.url === '/read') return reply(await c.tasks.read(body));
      if (request.url === '/archive-file') return reply(await c.tasks.archiveFile(body));
      if (request.url === '/cycle') { await manager.unload(); await manager.load(); const next = manager.getCoordinator(); await next.ready; return reply({ tasks: await next.tasks.list(), task: await next.tasks.get({ taskId: body.taskId }) }); }
      if (request.url === '/forget') {
        const records = await c.repository.browseMemory({ scope: 'all', limit: 100 }), original = records.items?.find(x => x.sourceEventId === 'parent-original-human-message');
        if (!original) throw Error('Cannot find actual original human source for explicit forget');
        return reply(await c.executeCommand('forget', { ids: [original.id], scope: 'unknown', reason: 'Explicit isolated fixture source revocation' }));
      }
      if (request.url === '/resume-revoked-worker') {
        resumedWorker = await ctx.agents.resume({ resumeSessionId: body.sessionId, parentAgent: handle.agent, agentOptions: { provider, model } });
        let presetSwitch = 'selected';
        try { await ctx.get('agentPresets').select(resumedWorker.agent, 'persona-memory'); }
        catch (error) { if (error.code !== 'agent-preset/locked' && error.message !== 'agent-preset/locked') throw error; presetSwitch = 'native-locked'; record({ kind: 'actual-worker-preset-change-rejected', code: error.code ?? error.message }); }
        resumedWorker.agent.followup({ id: 'revoked-worker-native-followup', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'WORKER_RESUMED_REVOKED_IDENTITY This is still an AI delegated task session.' }] });
        return reply({ accepted: true, sessionId: resumedWorker.agent.id, presetSwitch });
      }
      if (request.url === '/unload') { await manager.unload(); return reply({ unloaded: true }); }
      response.writeHead(404).end('{}');
    } catch (error) { record({ kind: 'test-control-error', code: error.code, message: error.message }); response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.code ?? error.message })); }
  });
  await new Promise(resolve => control.listen(0, '127.0.0.1', resolve));
  ctx.effect(() => async () => { await resumedWorker?.dispose?.(); await handle?.dispose?.(); control.closeAllConnections(); await new Promise(resolve => control.close(resolve)); });
  writeFileSync(join(config.artifacts, 'access.private.json'), JSON.stringify({ controlOrigin: 'http://127.0.0.1:' + control.address().port, controlToken }), { mode: 0o600 });
}
