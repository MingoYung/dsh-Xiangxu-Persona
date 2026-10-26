import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { defaultConfig } from '../core/schema.js';

// Exercise the actual management frontend against an isolated DOM and owner RPC.
// These tests inspect effects; they do not contact providers or real accounts.
const source = await readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
async function frontend(overrides = {}) {
  const ids = new Map(), calls = [], timers = new Map(); let nextTimer = 0, autoConfirm = false;
  class Element {
    constructor(tag = 'div', text = '') { this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.events = new Map(); this._text = text; this.value = ''; this.type = ''; this.name = ''; this.disabled = false; this.checked = false; this.selected = false; this.hidden = false; this.open = false; this.returnValue = ''; this.className = ''; this.style = {}; this.readOnly = false; this.src = ''; this.files = []; this.isConnected = true; this.classList = { add: value => this.classList.toggle(value, true), remove: value => this.classList.toggle(value, false), contains: value => this.className.split(/\s+/).includes(value), toggle: (value, force) => { const names = new Set(this.className.split(/\s+/).filter(Boolean)), add = force ?? !names.has(value); if (add) names.add(value); else names.delete(value); this.className = [...names].join(' '); return add; } }; }
    set id(value) { this._id = value; ids.set(value, this); } get id() { return this._id ?? ''; }
    set value(value) { this._value = String(value); } get value() { return this._value ?? ''; }
    set hidden(value) { if (value) this.attributes.hidden = ''; else delete this.attributes.hidden; } get hidden() { return Object.hasOwn(this.attributes, 'hidden'); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...children) { for (const child of children) { const node = child instanceof Element ? child : new Element('#text', String(child)); this.children.push(node); node.parentNode = this; if (this.tagName === 'select' && node.tagName === 'option' && (node.selected || this.children.length === 1)) this.value = node.value; } }
    replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
    setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'id') this.id = value; if (name === 'class') this.className = String(value); if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value); }
    getAttribute(name) { if (name === 'id') return this.id || null; if (name === 'class') return this.className || null; return this.attributes[name] ?? null; }
    hasAttribute(name) { return this.getAttribute(name) !== null; }
    removeAttribute(name) { delete this.attributes[name]; if (name.startsWith('data-')) delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]; }
    addEventListener(name, action, options) { const list = this.events.get(name) ?? []; list.push({ action, once: options?.once }); this.events.set(name, list); }
    async emit(name, extra = {}) { if (name === 'click' && this.disabled) return; const list = [...this.events.get(name) ?? []]; for (const entry of list) { if (entry.once) this.events.set(name, (this.events.get(name) ?? []).filter(value => value !== entry)); await entry.action({ currentTarget: this, target: this, preventDefault() {}, ...extra }); } }
    querySelectorAll(selector) { return walk(this).slice(1).filter(node => selector.split(',').some(part => matches(node, part.trim()))); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    showModal() { this.open = true; if (this.id === 'confirm-dialog' && autoConfirm) queueMicrotask(() => this.close('confirm')); }
    close(value = '') { this.open = false; this.returnValue = value; void this.emit('close'); }
    focus() {} select() {}
  }
  function walk(node) { return [node, ...node.children.flatMap(walk)]; }
  function matches(node, selector) {
    const tag = selector.match(/^[a-z][\w-]*/i)?.[0], id = selector.match(/#([\w-]+)/)?.[1];
    if (tag && node.tagName !== tag || id && node.id !== id) return false;
    for (const name of selector.matchAll(/\.([\w-]+)/g)) if (!node.classList.contains(name[1])) return false;
    for (const attr of selector.matchAll(/\[([\w-]+)(?:=['"]?([^'"\]]+)['"]?)?\]/g)) {
      const value = node.getAttribute(attr[1]); if (value === null || attr[2] !== undefined && value !== attr[2]) return false;
    }
    return Boolean(tag || id || /[.\[]/.test(selector));
  }
  function visible(node) { for (let current = node; current; current = current.parentNode) if (current.hidden || current.tagName === 'dialog' && !current.open) return false; return true; }
  const decode = text => text.replace(/&(?:amp|lt|gt|quot|#39);/g, value => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[value]);
  const body = new Element('body');
  // Parse the actual small HTML shell so hidden parents, back buttons and native tags
  // have their browser meaning; routing and disclosure behavior stay in ui/app.js.
  const stack = [body], shell = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? '';
  for (const match of shell.matchAll(/<!--[\s\S]*?-->|<\/?[^>]+>|[^<]+/g)) {
    const token = match[0]; if (token.startsWith('<!--')) continue;
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (token.startsWith('<')) {
      const tag = token.match(/^<([\w-]+)/)?.[1]; if (!tag) continue;
      const node = new Element(tag);
      for (const attr of token.slice(tag.length + 1, -1).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        const name = attr[1], value = decode(attr[2] ?? attr[3] ?? attr[4] ?? ''); node.setAttribute(name, value);
        if (['disabled', 'checked', 'selected', 'open', 'readOnly'].includes(name)) node[name] = true;
        else if (['value', 'type', 'name'].includes(name)) node[name] = value;
      }
      stack.at(-1).append(node); if (!['input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'area', 'base', 'embed', 'param', 'wbr'].includes(tag) && !token.endsWith('/>')) stack.push(node);
    } else if (token.trim()) stack.at(-1).append(new Element('#text', decode(token)));
  }
  const document = { body, createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text), getElementById: id => ids.get(id), querySelectorAll: selector => body.querySelectorAll(selector), querySelector: selector => body.querySelector(selector) };
  const channels = ['qq', 'wechat'].map(id => ({ id, configured: false, enabled: false, connected: false, config: { allowedPrivateIds: [], allowedGroupIds: [] }, capabilities: {} }));
  const mediaView = { identity: { version: 0, description: '', primaryAssetId: null, locked: false }, limits: { imageBytes: 8388608, descriptionChars: 2048, assetBytes: 268435456 }, providers: [{ kind: 'image', enabled: false, type: 'openai-images', hasApiKey: true, capabilities: {} }, { kind: 'video', enabled: false, type: 'comfyui', capabilities: {} }], usage: { assetBytes: 0 }, jobs: [] };
  const response = async (action, args) => {
    if (overrides[action]) return overrides[action](args, { channels, mediaView, calls });
    if (action === 'instances.list') return { items: [{ id: 'default', name: '隔离测试人格', active: true, loaded: true }], activeInstanceId: 'default', selectedInstanceId: 'default' };
    if (action === 'status') return { available: true, runtime: { sleep: { state: 'awake' }, globalMuted: false }, capacity: {}, agents: [] };
    if (action === 'people.list') return { items: [] };
    if (action === 'memory.list') return { items: [], total: 0 };
    if (action === 'channels.status') return { connections: channels, voice: { supported: false } };
    if (action === 'connections.status') return { connections: [{ id: 'qq', phase: 'idle' }, { id: 'wechat', phase: 'idle' }] };
    if (action === 'permissions.inspect') return { items: [{ id: 'chat.text', label: '发送文字', supported: true, allowed: true, available: true }, { id: 'chat.image', label: '发送图片', supported: true, allowed: false, available: false, reason: '尚未允许' }, { id: 'feed.publish', label: '发布朋友圈', supported: false, allowed: false, available: false, reason: '当前驱动未提供' }] };
    if (action === 'permissions.list') return { items: [] };
    if (action === 'voice.inspect') return { profile: { mode: 'persona' }, catalog: [], supported: false };
    if (action === 'media.inspect') return structuredClone(mediaView);
    if (action === 'media.listAssets' || action === 'media.listJobs') return { items: [], total: 0 };
    if (action === 'social.inspect' || action === 'social.list' || action === 'social.refresh') return { items: [], total: 0, complete: true, nextOffset: null, limits: { perInstance: 32, registryBytes: 262144 }, platforms: [{ id: 'qq', label: 'QQ', adapterAvailable: true }, { id: 'wechat', label: '微信', adapterAvailable: true }, { id: 'bilibili', label: 'B站', adapterAvailable: false }, { id: 'douyin', label: '抖音', adapterAvailable: false }] };
    if (action === 'config.get') return {};
    if (action === 'permissions.configure' || action === 'channels.configure' || action === 'channels.start') return { ok: true };
    throw new Error('Unexpected test owner RPC: ' + action);
  };
  const context = vm.createContext({ document, Node: Element, window: { personaBridge: { request: async (action, args) => { calls.push({ action, args: structuredClone(args) }); return response(action, args); } }, addEventListener() {} }, navigator: { clipboard: { writeText: async () => {} } }, crypto: webcrypto,
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id), queueMicrotask, Uint8Array, TextEncoder, btoa: value => Buffer.from(value, 'binary').toString('base64') });
  vm.runInContext(source, context); await new Promise(resolve => setImmediate(resolve));
  return { calls, timers, ids, mediaView, context, document, evaluate: code => vm.runInContext(code, context), walk, visible,
    button: (node, label) => { const found = walk(node).find(item => item.tagName === 'button' && item.textContent === label); assert.ok(found, 'button ' + label); return found; },
    confirm: value => { autoConfirm = value; } };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
function destinationButton(ui, label) {
  const found = ui.walk(ui.ids.get('page-content')).find(node => node.tagName === 'button' && node.getAttribute('aria-label') === label && ui.visible(node));
  assert.ok(found, 'visible destination ' + label); return found;
}

const BILI_STATUS = { id: 'bilibili', enabled: false, connected: false, accountId: null, hasCredentials: false, receipts: { retained: 0, unresolved: 0 }, limits: { receipts: 512 } };
const ASSET = 'cover-' + 'a'.repeat(32);
async function integrations(overrides = {}) {
  return frontend({
    'bilibili.inspect': () => structuredClone(BILI_STATUS), 'bilibili.listReceipts': () => ({ items: [], total: 0, hasMore: false }),
    'bilibili.loginStart': () => ({ ...BILI_STATUS, login: { flowId: 'login-flow', phase: 'waiting', qrDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', qrContent: 'https://passport.bilibili.com/qrcode/h5/login?key=private-qr' } }),
    'bilibili.loginCancel': () => ({ ...BILI_STATUS, phase: 'idle' }),
    'socialProviders.inspect': () => ({ providers: [{ kind: 'feed', enabled: false, hasApiKey: true, capabilities: {} }, { kind: 'cover', enabled: true, hasApiKey: true, model: 'fixture-model', targetVoice: 'fixture-voice', capabilities: { 'media.cover': true } }], protocol: { id: 'xiangxu-social-provider/1' } }),
    'socialProviders.listJobs': () => ({ items: [], total: 0 }), 'socialProviders.listAssets': () => ({ items: [], total: 0 }),
    'socialProviders.configure': () => ({ configured: true }), 'socialProviders.uploadCancel': () => ({ cancelled: true }),
    ...overrides,
  });
}
function audioFile(ui, size = 65537) {
  const bytes = new Uint8Array(size), input = ui.walk(ui.ids.get('page-content')).find(node => node.tagName === 'input' && node.type === 'file'); assert.ok(input);
  input.files = [{ name: 'input.wav', size, type: 'audio/wav', arrayBuffer: async () => bytes.buffer }]; input.value = 'input.wav'; return { bytes, input };
}
const sha = async bytes => Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');

test('current full Bilibili page opens read-only with no login, platform probe or publishing', async () => {
  const ui = await integrations(); await ui.evaluate("navigate('chat','bilibili')"); const body = ui.ids.get('page-content');
  assert.ok(body.textContent.includes('绑定 B 站账号')); assert.ok(body.textContent.includes('默认全部关闭')); assert.ok(body.textContent.includes('512')); assert.equal(ui.ids.get('global-error').hidden, true);
  assert.equal(ui.calls.some(call => ['bilibili.loginStart', 'bilibili.loginPoll', 'bilibili.configure', 'bilibili.execute'].includes(call.action) || call.action === 'bilibili.inspect' && call.args.probe), false);
  assert.equal(ui.document.querySelectorAll('details,summary').length, 0);
});

test('current Bilibili QR flow is cancelled for the original instance when leaving the page', async () => {
  const ui = await integrations(); await ui.evaluate("navigate('chat','bilibili')"); await ui.button(ui.ids.get('page-content'), '扫码绑定 B 站').emit('click');
  assert.ok(ui.walk(ui.ids.get('page-content')).some(node => node.tagName === 'img' && node.src.startsWith('data:image/')));
  ui.evaluate("state.instanceId='other-instance'"); await ui.evaluate("navigate('memory')"); await settle();
  const cancelled = ui.calls.filter(call => call.action === 'bilibili.loginCancel'); assert.equal(cancelled.length, 1); assert.equal(cancelled[0].args.flowId, 'login-flow'); assert.equal(cancelled[0].args.instanceId, 'default');
  assert.equal([...ui.timers.values()].some(timer => timer.delay === 2500), false); assert.equal(ui.calls.some(call => call.action === 'bilibili.loginPoll'), false);
});

test('late QR creation cannot populate another page and cancels the returned original flow', async () => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; });
  const ui = await integrations({ 'bilibili.loginStart': () => { entered(); return new Promise(resolve => { release = resolve; }); } }); await ui.evaluate("navigate('chat','bilibili')");
  const pending = ui.button(ui.ids.get('page-content'), '扫码绑定 B 站').emit('click'); await started; await ui.evaluate("navigate('memory')");
  release({ ...BILI_STATUS, login: { flowId: 'late-flow', phase: 'waiting' } }); await pending;
  assert.equal(ui.calls.at(-1).action, 'bilibili.loginCancel'); assert.equal(ui.calls.at(-1).args.flowId, 'late-flow'); assert.equal(ui.ids.get('page-title').textContent, '记忆'); assert.equal(ui.walk(ui.ids.get('page-content')).some(node => node.tagName === 'img'), false);
});

test('Bilibili permission UI respects all-off owner state and does not silently grant ordinary chat defaults', async () => {
  const ui = await integrations({ 'permissions.inspect': args => { assert.equal(args.id, 'bilibili'); return { items: ['feed.read', 'feed.publish', 'message.reply', 'chat.text'].map(id => ({ id, supported: true, allowed: false, available: false, reason: '尚未获用户授权' })) }; } });
  await ui.evaluate("navigate('chat','bilibili-permissions')"); const inputs = ui.walk(ui.ids.get('page-content')).filter(node => node.tagName === 'input' && node.type === 'checkbox'); assert.equal(inputs.length, 4); assert.ok(inputs.every(input => !input.checked));
  assert.equal(ui.calls.some(call => call.action === 'permissions.configure'), false); assert.equal(ui.ids.get('global-error').hidden, true);
});

test('feed and cover provider pages browse saved configuration without probing or executing and preserve a blank stored secret', async () => {
  for (const kind of ['feed', 'cover']) {
    const ui = await integrations(); await ui.evaluate(`navigate('${kind === 'cover' ? 'media' : 'chat'}','provider-${kind}')`); assert.equal(ui.ids.get('global-error').hidden, true);
    assert.equal(ui.calls.some(call => ['socialProviders.probe', 'socialProviders.execute', 'socialProviders.uploadBegin'].includes(call.action)), false);
    const key = ui.ids.get('social-' + kind + '-key'); assert.equal(key.value, '');
    ui.ids.get('social-' + kind + '-url').value = 'http://127.0.0.1:8000'; await ui.button(ui.ids.get('page-content'), '保存服务设置').emit('click');
    const saved = ui.calls.find(call => call.action === 'socialProviders.configure'); assert.equal(saved.args.kind, kind); assert.equal(saved.args.config.baseUrl, 'http://127.0.0.1:8000'); assert.equal(Object.hasOwn(saved.args.config, 'apiKey'), false);
  }
});

test('current audio upload advances only after exact chunk receipts and accepts only the complete SHA-bound asset', async () => {
  let begin;
  const ui = await integrations({
    'socialProviders.uploadBegin': args => { begin = args; return { uploadId: 'upload-good' }; },
    'socialProviders.uploadChunk': args => ({ uploadId: args.uploadId, index: args.index, receivedBytes: args.index * 32768 + Buffer.from(args.dataBase64, 'base64').length }),
    'socialProviders.uploadFinish': () => ({ status: 'completed', asset: { assetId: 'cover-' + begin.sha256.slice(0, 32), sha256: begin.sha256, bytes: begin.totalBytes, name: 'input.wav', mime: 'audio/wav' } }),
  });
  await ui.evaluate("navigate('media','provider-cover')"); const { bytes } = audioFile(ui); await ui.button(ui.ids.get('page-content'), '导入所选音频').emit('click');
  const chunks = ui.calls.filter(call => call.action === 'socialProviders.uploadChunk'); assert.deepEqual(chunks.map(call => call.args.index), [0, 1, 2]); assert.equal(chunks[2].args.dataBase64, 'AA=='); assert.equal(begin.sha256, await sha(bytes)); assert.equal(begin.totalBytes, 65537);
  for (const chunk of chunks) assert.equal(chunk.args.sha256, await sha(Buffer.from(chunk.args.dataBase64, 'base64')));
  assert.ok(ui.ids.get('page-content').textContent.includes('音频已校验并保存。')); assert.equal(ui.ids.get('social-cover-input').value, 'cover-' + begin.sha256.slice(0, 32)); assert.equal(ui.calls.some(call => call.action === 'socialProviders.execute'), false); assert.equal(ui.ids.get('global-error').hidden, true);
});

for (const bad of ['expired', 'cancelled', 'wrong-index', 'wrong-byte-count', 'wrong-upload-id']) test('audio chunk ' + bad + ' stops after one response without finishing or claiming progress', async () => {
  const ui = await integrations({
    'socialProviders.uploadBegin': () => ({ uploadId: 'upload-stale' }),
    'socialProviders.uploadChunk': args => bad === 'expired' || bad === 'cancelled' ? { status: bad } : { uploadId: bad === 'wrong-upload-id' ? 'another-upload' : args.uploadId, index: bad === 'wrong-index' ? 7 : args.index, receivedBytes: bad === 'wrong-byte-count' ? 1 : 32768 },
  });
  await ui.evaluate("navigate('media','provider-cover')"); audioFile(ui, 16777216); await ui.button(ui.ids.get('page-content'), '导入所选音频').emit('click');
  assert.equal(ui.calls.filter(call => call.action === 'socialProviders.uploadChunk').length, 1); assert.equal(ui.calls.some(call => call.action === 'socialProviders.uploadFinish'), false); assert.equal(ui.calls.filter(call => call.action === 'socialProviders.uploadCancel').length, 1);
  assert.equal(ui.ids.get('page-content').textContent.includes('已传入 '), false); assert.equal(ui.ids.get('page-content').textContent.includes('音频已校验并保存。'), false); assert.equal(ui.ids.get('global-error').hidden, false); assert.match(ui.ids.get('global-error').textContent, /有效确认/);
});

for (const bad of ['unknown', 'wrong-sha', 'wrong-bytes', 'wrong-cover-id']) test('audio finish ' + bad + ' remains unconfirmed and cannot display import success', async () => {
  let begin;
  const ui = await integrations({
    'socialProviders.uploadBegin': args => { begin = args; return { uploadId: 'upload-unconfirmed' }; },
    'socialProviders.uploadChunk': args => ({ uploadId: args.uploadId, index: args.index, receivedBytes: args.index * 32768 + Buffer.from(args.dataBase64, 'base64').length }),
    'socialProviders.uploadFinish': () => ({ status: bad === 'unknown' ? 'unknown' : 'completed', asset: { assetId: bad === 'wrong-cover-id' ? ASSET : 'cover-' + begin.sha256.slice(0, 32), sha256: bad === 'wrong-sha' ? '0'.repeat(64) : begin.sha256, bytes: bad === 'wrong-bytes' ? 123 : begin.totalBytes, name: 'input.wav' } }),
  });
  await ui.evaluate("navigate('media','provider-cover')"); audioFile(ui, 4); await ui.button(ui.ids.get('page-content'), '导入所选音频').emit('click');
  assert.ok(ui.ids.get('page-content').textContent.includes('音频导入结果尚未确认')); assert.equal(ui.ids.get('page-content').textContent.includes('音频已校验并保存。'), false); assert.equal(ui.ids.get('social-cover-input').value, ''); assert.equal(ui.calls.some(call => call.action === 'socialProviders.execute'), false);
});

const buildSource = await readFile(new URL('../scripts/build-ui.mjs', import.meta.url), 'utf8');
const downloadStart = buildSource.indexOf("if(message.action==='ui.asset.download'"), downloadEnd = buildSource.indexOf('const result=await ctx.connection.rpc.call', downloadStart);
assert.ok(downloadStart >= 0 && downloadEnd > downloadStart);
const downloadBlock = buildSource.slice(downloadStart, downloadEnd);
async function downloadFixture({ rpc, digest = (...args) => webcrypto.subtle.digest(...args) } = {}) {
  const bytes = Buffer.from('verified-bytes'), checksum = await sha(bytes), posted = [], created = [], clicked = [], calls = [];
  const context = vm.createContext({ disposed: false, downloadInProgress: false, channel: { port1: { postMessage: value => posted.push(value) } }, ctx: { connection: { rpc: { call: async (...args) => { calls.push(args); return rpc ? rpc(...args) : { ok: true, value: { totalBytes: bytes.length, sha256: checksum, mime: 'audio/wav', filename: ASSET + '.wav', dataBase64: bytes.toString('base64'), complete: true, nextOffset: null } }; } } } },
    crypto: { subtle: { digest } }, Uint8Array, Blob, atob: value => Buffer.from(value, 'base64').toString('binary'), URL: { createObjectURL: value => { created.push(value); return 'blob:test'; }, revokeObjectURL() {} },
    document: { body: { append() {} }, createElement: () => ({ click() { clicked.push(true); }, remove() {} }) }, setTimeout() {} });
  vm.runInContext('async function testDownload(message){const current=channel;' + downloadBlock + '}', context);
  return { context, posted, created, clicked, calls, invoke: () => context.testDownload({ id: 'download-1', action: 'ui.audio.download', args: { assetId: ASSET, instanceId: 'default' } }), part: { ok: true, value: { totalBytes: bytes.length, sha256: checksum, mime: 'audio/wav', filename: ASSET + '.wav', dataBase64: bytes.toString('base64'), complete: true, nextOffset: null } } };
}

test('actual build download handler verifies audio bytes and routes to the current audio chunk RPC', async () => {
  const f = await downloadFixture(); await f.invoke(); assert.equal(f.calls[0][2].action, 'socialProviders.readAssetChunk'); assert.equal(f.created.length, 1); assert.equal(f.clicked.length, 1); assert.equal(f.posted[0].value.status, 'download_started'); assert.equal(f.context.downloadInProgress, false);
});

for (const changed of ['disposed', 'channel']) test('actual build refuses a download when ' + changed + ' changes during its RPC', async () => {
  let entered, release; const active = new Promise(resolve => { entered = resolve; }); const f = await downloadFixture({ rpc: async () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const pending = f.invoke(); await active; if (changed === 'disposed') f.context.disposed = true; else f.context.channel = { port1: { postMessage() {} } }; release(f.part);
  await assert.rejects(pending, /页面或连接已经改变/); assert.equal(f.created.length, 0); assert.equal(f.clicked.length, 0); assert.equal(f.posted.length, 0); assert.equal(f.context.downloadInProgress, false);
});

for (const changed of ['disposed', 'channel']) test('actual build refuses a download when ' + changed + ' changes during SHA verification', async () => {
  let entered, release; const active = new Promise(resolve => { entered = resolve; });
  const f = await downloadFixture({ digest: async (...args) => { const result = await webcrypto.subtle.digest(...args); entered(); await new Promise(resolve => { release = resolve; }); return result; } });
  const pending = f.invoke(); await active; if (changed === 'disposed') f.context.disposed = true; else f.context.channel = { port1: { postMessage() {} } }; release();
  await assert.rejects(pending, /页面或连接已经改变/); assert.equal(f.created.length, 0); assert.equal(f.clicked.length, 0); assert.equal(f.posted.length, 0); assert.equal(f.context.downloadInProgress, false);
});
