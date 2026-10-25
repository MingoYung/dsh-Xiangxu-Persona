// Uses DSH's existing authenticated Connection carrier, including Electron IPC.
// No web server, credential reader or independent memory writer is introduced.
export const PERSONA_UI_ENDPOINT = 'persona-memory.manage';
export const PERSONA_UI_PATH = '/api/' + PERSONA_UI_ENDPOINT;
const MAX_REQUEST_BYTES = 65536;
const MAX_RESPONSE_BYTES = 2097152;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reject = (code, message) => ({ ok: false, error: { code, message, details: {} } });

export function createPersonaManagementRoute(service) {
  if (typeof service?.dispatch !== 'function') throw new TypeError('A persona management dispatch service is required');
  return {
    path: PERSONA_UI_PATH, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      let rpcId = 'invalid-persona-management-request';
      const respond = result => new Response(JSON.stringify({ type: 'server-response', rpcId, result }), {
        status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
      try {
        if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 });
        }
        const declared = Number(request.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return new Response('request too large', { status: 413 });
        const text = await request.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES) return new Response('request too large', { status: 413 });
        const envelope = JSON.parse(text);
        if (typeof envelope?.rpcId === 'string' && envelope.rpcId.length <= 128) rpcId = envelope.rpcId;
        if (!record(envelope) || envelope.type !== 'client-request' || rpcId === 'invalid-persona-management-request' ||
          envelope.method !== PERSONA_UI_ENDPOINT || !record(envelope.payload)) {
          return respond(reject('UI_BAD_REQUEST', 'Invalid persona management request envelope'));
        }
        const { action, args = {} } = envelope.payload;
        if (typeof action !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(action) || !record(args)) {
          return respond(reject('UI_BAD_REQUEST', 'An action and an argument object are required'));
        }
        request.signal.throwIfAborted();
        const value = await service.dispatch(action, args);
        const json = JSON.stringify({ ok: true, value });
        if (Buffer.byteLength(json, 'utf8') > MAX_RESPONSE_BYTES) {
          return respond(reject('UI_RESULT_TOO_LARGE', 'The result exceeds the management page limit. Query a smaller page; do not repeat a mutation.'));
        }
        return respond(JSON.parse(json));
      } catch (error) {
        return respond(reject(typeof error?.code === 'string' ? error.code : 'UI_REQUEST_FAILED',
          String(error?.message ?? 'Persona management request failed').slice(0, 1000)));
      }
    },
  };
}

export function mountPersonaManagement(ctx, service) {
  const route = createPersonaManagementRoute(service);
  // The shared Fetch carrier enforces owner principals and browser trust before
  // this exact route. Registering a raw webServer route would bypass that seam.
  return ctx.inject(['connection'], scope => scope.connection.fetch.register(route));
}
