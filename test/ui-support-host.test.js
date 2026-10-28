import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../ui/client.js', import.meta.url), 'utf8');
const issueUrl = 'https://github.com/MingoYung/dsh-Xiangxu-Persona/issues/new?template=bug_report.yml';
const summary = { schemaVersion: 'xiangxu-support/1', plugin: { name: 'dsh-xiangxu-persona', version: '0.13.1' }, errors: { counts: [{ code: 'ECONNREFUSED', count: 1 }] } };

function host(response = async () => ({ ok: true, value: summary })) {
  let module, component, channel; const effects = [], calls = [], outgoing = [], downloads = [], blobs = [], listeners = new Map(), reveals = [], focuses = [];
  const frame = { parentElement: null, contentWindow: { postMessage() {} }, getBoundingClientRect: () => ({ top: 50, bottom: 470 }),
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const document = { documentElement: {}, body: { append() {} }, head: {}, createElement: tag => tag === 'canvas' ? { getContext: () => null } : { click() { downloads.push({ href: this.href, filename: this.download }); }, remove() {} } };
  class Observer { observe() {} disconnect() {} }
  class Channel { constructor() { channel = this; this.port1 = { postMessage: value => outgoing.push(value), start() {}, close() {} }; this.port2 = { close() {} }; } }
  const React = { useRef: () => ({ current: null }), useState: value => [value, () => {}], useMemo: fn => fn(), useEffect: fn => effects.push(fn), createElement: (tag, props, ...children) => ({ tag, props, children }) };
  const context = vm.createContext({ window: { __ModuleLoader__: { load(value) { module = value.factory(() => React); } }, addEventListener() {}, removeEventListener() {} },
    document, crypto: webcrypto, Uint8Array, TextEncoder, Blob, MessageChannel: Channel, MutationObserver: Observer, ResizeObserver: Observer,
    getComputedStyle: () => ({ getPropertyValue: () => '', color: 'rgb(20, 20, 20)', colorScheme: 'light', fontFamily: 'system-ui', fontSize: '14px', overflowY: 'visible' }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), innerHeight: 800,
    requestAnimationFrame: fn => fn(), setTimeout: () => {}, URL: { createObjectURL: blob => { blobs.push(blob); return 'blob:local-report'; }, revokeObjectURL() {} },
  });
  vm.runInContext(source, context); module.apply({ slots: { inject(_name, register) { register(); }, register(_options, value) { component = value; } }, connection: { rpc: { call: async (...args) => { calls.push(structuredClone(args)); return response(...args); } } } });
  const tree = component(), anchor = tree.children[0].children[0], iframe = tree.children[1];
  anchor.props.ref.current = { scrollIntoView: args => reveals.push(args), focus: args => focuses.push(args) }; iframe.props.ref.current = frame;
  const cleanup = effects[0](); listeners.get('load')();
  return { tree, anchor, iframe, calls, outgoing, downloads, blobs, reveals, focuses, cleanup,
    send: async (action, args = {}) => { const id = String(outgoing.length + 1); await channel.port1.onmessage({ data: { id, action, args } }); return outgoing.findLast(value => value.id === id); } };
}

test('actual generated host renders the fixed GitHub link outside the scripts-only iframe', async () => {
  const ui = host();
  assert.equal(ui.anchor.tag, 'a'); assert.equal(ui.anchor.props.href, issueUrl); assert.equal(ui.anchor.props.target, '_blank'); assert.equal(ui.anchor.props.rel, 'noopener noreferrer');
  assert.equal(ui.iframe.tag, 'iframe'); assert.equal(ui.iframe.props.sandbox, 'allow-scripts');
  const result = await ui.send('ui.support.showLink', { instanceId: 'chosen-instance' });
  assert.equal(result.value.status, 'link_focused'); assert.equal(ui.reveals.length, 1); assert.equal(ui.focuses[0].preventScroll, true);
  assert.equal(ui.calls.length, 0); assert.equal(ui.downloads.length, 0);
  // Focusing the genuine parent link does not claim the external page was opened.
  assert.equal(ui.anchor.props.onClick, undefined); ui.cleanup();
});

test('host support actions reject arbitrary URL/text/file arguments before owner RPC or native effects', async () => {
  const ui = host();
  for (const action of ['ui.support.showLink', 'ui.support.download']) for (const args of [{ url: 'file:///C:/private.txt' }, { text: 'private' }, { path: 'C:/private.txt' }, { instanceId: 'x'.repeat(129) }, []]) {
    const result = await ui.send(action, args); assert.equal(result.ok, false);
  }
  assert.equal(ui.calls.length, 0); assert.equal(ui.downloads.length, 0); assert.equal(ui.reveals.length, 0); ui.cleanup();
});

test('host download obtains only the owner allowlist summary and saves a fixed local JSON filename', async () => {
  const ui = host(), result = await ui.send('ui.support.download', { instanceId: 'selected' });
  assert.equal(result.ok, true); assert.equal(result.value.status, 'download_started');
  assert.deepEqual(ui.calls, [['/api', 'persona-memory.manage', { action: 'support.summary', args: { instanceId: 'selected' } }]]);
  assert.deepEqual(ui.downloads, [{ href: 'blob:local-report', filename: 'xiangxu-diagnostics.json' }]);
  assert.equal(ui.blobs[0].type, 'application/json;charset=utf-8'); assert.deepEqual(JSON.parse(await ui.blobs[0].text()), summary);
  assert.equal(result.value.bytes, Buffer.byteLength(await ui.blobs[0].text())); ui.cleanup();
});

test('failed, oversized and disposed report downloads create no file and do not forward raw RPC errors', async () => {
  for (const value of [{ ok: false, error: { message: 'PRIVATE_SENTINEL_C:\\Users\\Owner' } }, { ok: true, value: { ...summary, payload: 'x'.repeat(17000) } }, { ok: true, value: { schemaVersion: 'unknown' } }]) {
    const ui = host(async () => value), result = await ui.send('ui.support.download');
    assert.equal(result.ok, false); assert.doesNotMatch(result.error.message, /PRIVATE_SENTINEL/); assert.equal(ui.downloads.length, 0); ui.cleanup();
  }
  let finish, entered; const waiting = new Promise(resolve => { entered = resolve; }), ui = host(() => { entered(); return new Promise(resolve => { finish = resolve; }); });
  const pending = ui.send('ui.support.download'); await waiting; ui.cleanup(); finish({ ok: true, value: summary }); await pending;
  assert.equal(ui.downloads.length, 0);
});
