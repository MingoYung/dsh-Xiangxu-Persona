import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

export const inject = ['llm', 'personaMemory', 'agents', 'tools'];
const provider = 'persona-onboarding-fixture', model = 'fixture-v1';
const textOf = value => ((value?.message ?? value)?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const argumentsOf = call => typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments ?? {};
const serial = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'signal' ? undefined : item));

/** Actual native host probe and fixed provider. It does not simulate a Session,
 * agent loop, tools, owner authorization or persistence implementation. */
export async function apply(ctx, config) {
  const { HostConnectionService } = await import(config.connectionModule);
  new HostConnectionService(ctx, [], {});
  mkdirSync(config.artifacts, { recursive: true });
  const record = value => appendFileSync(join(config.artifacts, 'native-events.private.jsonl'), JSON.stringify({ at: Date.now(), ...serial(value) }) + '\n');
  const capture = (kind, options) => appendFileSync(join(config.artifacts, 'requests.private.jsonl'), JSON.stringify({ kind, at: Date.now(), provider: options.provider,
    model: options.model, tools: (options.tools ?? []).map(item => item.name), messages: serial(options.messages ?? []) }) + '\n');
  const manager = ctx.get('personaMemory'), handles = [];
  let handle;
  ctx.on('llm/stream', (options, next) => {
    if (options.provider !== provider || options.model !== model) { record({ kind: 'non-fixture-route-rejected' }); throw Error('Onboarding fixture refuses non-fixture routes'); }
    capture('host-llm-stream-input', options); return next();
  });
  ctx.on('session/event', (session, event) => {
    if (['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end'].includes(event.type)) record({ kind: 'session-event', sessionId: session.id, event });
  }, { global: true });
  const metadata = (p, m) => ({ provider: p, id: m, name: 'Onboarding fixed fixture; no real model', context: { contextWindow: 1048576 },
    defaultMaxTokens: 4096, inputModalities: ['text'], systemPromptUpdate: 'in-history' });
  const tool = (name, args) => ({ type: 'tool-call', id: 'onboarding_' + randomUUID(), name, arguments: JSON.stringify(args) });
  const done = text => ({ type: 'text', text });
  function latestInput(messages) {
    let index = -1;
    for (let i = 0; i < messages.length; i++) if (messages[i].role === 'user' &&
      (messages[i].source?.kind === 'user' || messages[i].source?.kind === 'persona-memory:control')) index = i;
    return { index, message: messages[index], text: textOf(messages[index]) };
  }
  function resultFor(messages, call) {
    const result = messages.find(message => message.role === 'tool' && message.toolCallId === call.id);
    if (!result) throw Error('Actual tool result is missing');
    return JSON.parse(textOf(result));
  }
  function collectedResult(messages, calls, name, args) {
    const selected = calls.filter(call => call.name === name); let value = '', offset = 0;
    if (!selected.length) return { complete: false, args };
    for (const call of selected) {
      const result = resultFor(messages, call);
      if (result.status !== 'bounded_preview') return { complete: true, value: result };
      if (result.preview?.fragment?.from !== offset) throw Error('Actual tool pages are not contiguous');
      value += result.preview.text; offset = result.preview.fragment.to;
      if (result.preview.fragment.complete) return { complete: true, value: JSON.parse(value) };
      if (call === selected.at(-1)) return { complete: false, args: { ...args, cursor: result.nextCursor } };
    }
    throw Error('Tool pages did not yield a result or continuation');
  }
  function response(options) {
    const messages = options.messages ?? [], input = latestInput(messages), calls = messages.slice(input.index + 1).flatMap(message =>
      (message.content ?? []).filter(block => block.type === 'tool-call'));
    const sessionId = options.messages?.find(message => message.source?.kind === 'runtime-context')?.source?.sessionId;
    if (!(options.tools ?? []).some(item => item.name === 'persona_introspect')) throw Error('Onboarding native step did not expose persona tools');
    if (input.message?.source?.kind === 'persona-memory:control') {
      record({ kind: 'actual-reconsideration-input', text: input.text });
      if (!calls.some(call => call.name === 'persona_decide')) {
        const environmentText = messages.map(textOf).find(text => text.includes('[environment]')) ?? '';
        const match = environmentText.match(/\[environment\]\n([^\n]+)/);
        if (!match) throw Error('Actual environment unavailable');
        const target = JSON.parse(match[1]).target;
        return [tool('persona_decide', { replyPlan: { action: 'reply', target, pendingEventIds: [], replyAt: null, recheckOn: ['new_message'] }, nextCheckAt: null })];
      }
      if (!input.text.includes('ONBOARD_LATEST_ARRIVAL')) throw Error('Reconsideration did not receive the latest real accepted input');
      return [done('ONBOARD_SHORT_SECOND：刚才补充的那句，我看到了。')];
    }
    if (input.text.includes('ONBOARD_ADOPT')) {
      const inspectCalls = calls.filter(call => call.name === 'persona_introspect' && argumentsOf(call).action !== 'update_self');
      const read = collectedResult(messages, inspectCalls, 'persona_introspect', { section: 'self' });
      if (!read.complete) return [tool('persona_introspect', read.args)];
      const writes = calls.filter(call => call.name === 'persona_introspect' && argumentsOf(call).action === 'update_self');
      if (!writes.length) return [tool('persona_introspect', { action: 'update_self', expectedVersion: read.value.version,
        selfPatch: { name: '相续自选名', gender: '女性', ageDescription: '二十五岁的虚拟形象', selfDescription: 'ONBOARD_CURRENT_CHOSEN：这是隔离固定模型选择保存的自我描述。' } })];
      const applied = collectedResult(messages, writes, 'persona_introspect', argumentsOf(writes[0]));
      if (!applied.complete) return [tool('persona_introspect', applied.args)];
      if (applied.value.current?.name !== '相续自选名') throw Error('Actual self update result differs');
      return [done('ONBOARD_ADOPT_FINISHED：你好呀，我是相续自选名。')];
    }
    if (input.text.includes('ONBOARD_EMPTY')) {
      const read = collectedResult(messages, calls, 'persona_introspect', { section: 'self' });
      if (!read.complete) return [tool('persona_introspect', read.args)];
      if (Object.values(read.value.current ?? {}).some(value => value !== '')) throw Error('A new synthetic instance inherited another personality');
      return [done('ONBOARD_EMPTY_FINISHED：这是另一个空白实例的隔离回复。')];
    }
    if (input.text.includes('ONBOARD_READ')) {
      const read = collectedResult(messages, calls, 'persona_introspect', { section: 'self' });
      if (!read.complete) return [tool('persona_introspect', read.args)];
      if (read.value.current?.name !== '相续自选名') throw Error('A new session did not receive the retained self profile');
      return [done('ONBOARD_READ_FINISHED：相续自选名仍在。')];
    }
    if (input.text.includes('ONBOARD_RHYTHM_START')) {
      if (calls.some(call => call.name === 'persona_decide')) return [done('ONBOARD_RHYTHM_UNEXPECTED_EXTRA_STEP')];
      const environmentText = messages.map(textOf).find(text => text.includes('[environment]')) ?? '';
      const match = environmentText.match(/\[environment\]\n([^\n]+)/);
      if (!match) throw Error('Actual current target was not injected');
      const target = JSON.parse(match[1]).target;
      return [done('ONBOARD_SHORT_FIRST：我先说这一句。'), tool('persona_decide', {
        replyPlan: { action: 'wait', target, pendingEventIds: [], replyAt: null, recheckOn: [] }, nextCheckAt: Date.now() + 4000 })];
    }
    return [done('ONBOARD_UNEXPECTED_INPUT')];
  }
  const adapter = { providerInfo: p => ({ id: p, name: 'Fixed responses only' }), providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined, imageRequestTarget: (_p, _m, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
    listModels: async () => [{ id: model, name: 'Onboarding fixture' }], resolveModel: async (p, m) => metadata(p, m),
    prepareCall: async (p, m) => ({ model: metadata(p, m), stream: options => adapter.stream(options) }),
    async *stream(options) {
      capture('fixture-provider-received-request', options);
      for (const [index, block] of response(options).entries()) {
        yield { type: 'block-start', index, blockType: block.type };
        if (block.type === 'text') yield { type: 'text-delta', index, text: block.text };
        else yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index, block };
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    } };
  ctx.llm.registerAdapter([provider], adapter); await manager.ready;
  const owner = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
  const foreign = ctx.connection.createPeer({ principal: { kind: 'other' }, interactions: 'none' });
  const carrier = ctx.connection.createSharedFetchHandler('/api');
  ctx.effect(() => async () => { await owner.dispose(); await foreign.dispose(); });
  const controlToken = randomBytes(24).toString('base64url');
  const server = createServer(async (request, response) => {
    const reply = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.headers.authorization !== 'Bearer ' + controlToken) { response.writeHead(401).end('{}'); return; }
    try {
      const parts = []; for await (const part of request) parts.push(part);
      const body = parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {};
      if (request.url === '/owner') {
        const envelope = { type: 'client-request', rpcId: 'onboarding-owner-' + randomUUID(), method: 'persona-memory.manage', payload: { action: body.action, args: body.args ?? {} } };
        const result = await carrier.fetch(new Request('http://127.0.0.1/api/persona-memory.manage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) }), body.testForeign ? foreign : owner);
        return reply({ httpStatus: result.status, body: await result.text() });
      }
      if (request.url === '/begin') {
        if (typeof body.sessionId !== 'string' || !/^onboarding_[a-z_]+$/.test(body.sessionId)) throw Error('Bad fixture session ID');
        handle = await ctx.agents.create({ sessionId: body.sessionId, agentOptions: { provider, model }, meta: { cwd: config.workspace } }); handles.push(handle);
        await ctx.get('agentPresets').select(handle.agent, 'persona-memory');
      }
      if (request.url === '/begin' || request.url === '/prompt') {
        if (!handle) throw Error('No native agent was created');
        handle.agent.followup({ id: body.sourceEventId ?? 'onboarding-human-' + randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: body.text }] });
        await ctx.get('sessions').flush(handle.agent.session); return reply({ accepted: true, sessionId: handle.agent.id });
      }
      if (request.url === '/state') {
        const c = manager.getCoordinator();
        if (!c) return reply({ loaded: false });
        await c.readyState(); return reply({ loaded: true, self: await c.repository.getSelfProfile(), runtime: await c.repository.getRuntime(),
          pending: await c.repository.getPending(), records: (await c.repository.browseMemory({ scope: 'all', limit: 100 })).items,
          errors: c.errors, scopes: ctx.agents.list().map(agent => ({ sessionId: agent.id, status: agent.status,
            snapshot: c.agents.get(agent.id)?.latestSnapshot ?? null, attached: c.agents.has(agent.id) })) });
      }
      if (request.url === '/session') {
        if (!handles.some(owned => owned.agent.id === body.sessionId)) throw Error('Only a session created by this fixture can be queried');
        const stored = await ctx.get('sessionQuery').readSession(body.sessionId);
        return reply({ retained: true, eventCount: stored.events.length,
          sourceEventIds: stored.events.filter(event => event.type === 'user/message').map(event => event.data.id) });
      }
      response.writeHead(404).end('{}');
    } catch (error) { record({ kind: 'fixture-control-error', code: error.code, message: error.message }); response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.code ?? error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  ctx.effect(() => async () => { for (const owned of handles) await owned.dispose?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  writeFileSync(join(config.artifacts, 'access.private.json'), JSON.stringify({ controlOrigin: 'http://127.0.0.1:' + server.address().port, controlToken }), { mode: 0o600 });
}
