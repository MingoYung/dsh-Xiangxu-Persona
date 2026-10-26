import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { defaultConfig } from '../core/schema.js';
import { clearVersion } from '../adapters/dsh/instance-lifecycle.js';

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

function lifecycleItems() { return [
  { id: 'default', name: '人格甲', memoryRoot: 'C:/fixture/persona-a', active: true, loaded: true, archivedAt: null, clearedAt: null, retiredSessionCount: 0 },
  { id: 'other', name: '人格乙', memoryRoot: 'C:/fixture/persona-b', active: false, loaded: false, archivedAt: null, clearedAt: null, retiredSessionCount: 0 },
  { id: 'archived', name: '归档人格', memoryRoot: 'C:/fixture/persona-archive', active: false, loaded: false, archivedAt: 1000, clearedAt: null, retiredSessionCount: 2 },
  { id: 'cleared', name: '已清除人格', memoryRoot: 'C:/fixture/persona-cleared', active: false, loaded: false, archivedAt: null, clearedAt: 2000, clearStatus: 'cleared', retiredSessionCount: 3 },
]; }
async function lifecycle(overrides = {}, seed = lifecycleItems()) {
  const items = structuredClone(seed); let selected = 'default';
  const listing = () => ({ items: structuredClone(items), activeInstanceId: items.find(item => item.loaded)?.id ?? null, selectedInstanceId: selected, autoLoad: true });
  const defaults = {
    'instances.list': listing,
    status: args => ({ available: Boolean(items.find(item => item.id === args.instanceId)?.loaded), unloaded: !items.find(item => item.id === args.instanceId)?.loaded, runtime: { sleep: { state: 'awake' } }, capacity: {}, agents: [], config: { conversationStyle: 'short_chat' } }),
    'self.get': () => ({ version: 0, mode: 'unset', onboardingAcknowledged: false, initial: {}, current: {}, history: [], createdAt: null, updatedAt: null }),
    'instances.clearPreview': args => { const item = items.find(row => row.id === args.instanceId); return { instanceId: item.id, name: item.name, memoryRoot: item.memoryRoot, scope: ['受管人格文本 · 当前范围', '自我档案与关系文本'], excluded: ['目录外作品二进制', '独立任务原件', '共享账号与凭据', 'DSH旧会话日志'], files: 17, bytes: 12345, requiresName: item.name, confirmationToken: 'fixture-token-' + item.id, version: clearVersion({ ...item, instanceId: item.id }, { root: item.memoryRoot, files: [] }, 9) }; },
    'instances.archive': args => { const item = items.find(row => row.id === args.instanceId); item.archivedAt = 3000; item.loaded = false; item.retiredSessionCount = 4; return listing(); },
    'instances.restore': args => { for (const item of items) { item.loaded = item.id === args.instanceId; item.active = item.id === args.instanceId; } const item = items.find(row => row.id === args.instanceId); item.archivedAt = null; selected = item.id; return listing(); },
    'instances.select': args => { for (const item of items) { item.loaded = item.id === args.instanceId; item.active = item.id === args.instanceId; } selected = args.instanceId; return listing(); },
    'instances.clear': args => { const item = items.find(row => row.id === args.instanceId); item.loaded = false; item.clearedAt = 4000; item.clearStatus = 'cleared'; return { status: 'cleared', instanceId: item.id }; },
    'instances.create': args => { for (const item of items) { item.loaded = false; item.active = false; } items.push({ id: 'created', name: args.name, memoryRoot: 'C:/fixture/brand-new-root', active: true, loaded: true, archivedAt: null, clearedAt: null }); selected = 'created'; return listing(); },
  };
  const ui = await frontend({ ...defaults, ...overrides }); ui.items = items; ui.listing = listing;
  ui.record = id => { const result = ui.walk(ui.ids.get('page-content')).find(node => node.classList.contains('instance-card') && node.dataset.instanceId === id); assert.ok(result, 'instance record ' + id); return result; };
  ui.preview = async (id = 'default') => { await ui.button(ui.record(id), '清除文本资料…').emit('click'); return ui.ids.get('detail-content'); };
  ui.typeName = async text => { const input = ui.ids.get('instance-clear-name'); input.value = text; await input.emit('input'); };
  return ui;
}

test('persona management separates current other archived and cleared without starting work', async () => {
  const ui = await lifecycle(); await ui.evaluate("navigate('settings','instances')");
  assert.equal(ui.ids.get('page-title').textContent, '人格管理');
  const text = ui.ids.get('page-content').textContent; for (const value of ['当前人格', '其它人格', '已归档', '已清除']) assert.ok(text.includes(value), value);
  assert.equal(ui.walk(ui.record('cleared')).some(node => node.tagName === 'button' && /加载实例|恢复并使用/.test(node.textContent)), false);
  assert.equal(ui.button(ui.record('cleared'), '新建人格').disabled, false);
  assert.equal(ui.calls.some(call => /^instances\.(archive|restore|clear|create|load|select)/.test(call.action)), false);
});

test('archived and retired clear states are disabled in the top selector', async () => {
  const items = lifecycleItems(); items.push({ id: 'partial', name: '未完成', memoryRoot: 'C:/fixture/partial', active: false, loaded: false, archivedAt: null, clearedAt: null, clearStatus: 'partial' });
  const ui = await lifecycle({}, items); await ui.evaluate("navigate('settings','instances')");
  const options = ui.ids.get('active-instance').children;
  for (const id of ['archived', 'cleared', 'partial']) assert.equal(options.find(item => item.value === id).disabled, true, id);
  assert.equal(options.find(item => item.value === 'other').disabled, false);
});

test('switching keeps the original target and never archives or clears either persona', async () => {
  const ui = await lifecycle(); await ui.evaluate("navigate('settings','instances')"); ui.confirm(true);
  await ui.button(ui.record('other'), '切换到此实例').emit('click');
  assert.deepEqual(ui.calls.filter(call => call.action === 'instances.select').map(call => call.args), [{ instanceId: 'other' }]);
  assert.equal(ui.evaluate('state.instanceId'), 'other'); assert.equal(ui.items.find(item => item.id === 'default').clearedAt, null);
  assert.equal(ui.calls.some(call => /instances\.(archive|clear|create)/.test(call.action)), false);
});

test('archive is explicit reversible and preserves data without clearing or logging out', async () => {
  const ui = await lifecycle(); await ui.evaluate("navigate('settings','instances')");
  const pending = ui.button(ui.record('default'), '归档保留').emit('click'); await settle();
  assert.ok(ui.ids.get('confirm-description').textContent.includes('归档不是独立备份'));
  assert.equal(ui.calls.some(call => call.action === 'instances.archive'), false);
  await ui.ids.get('confirm-accept').emit('click'); await pending;
  assert.equal(ui.items.find(item => item.id === 'default').archivedAt, 3000);
  assert.ok(ui.record('default').textContent.includes('已归档'));
  assert.ok(ui.record('default').textContent.includes('已关闭旧会话接入 4 个'));
  assert.equal(ui.calls.some(call => /instances\.clear|connections\.(logout|stop)|social\.remove/.test(call.action)), false);
});

test('restore uses its exact archived target with activate true', async () => {
  const ui = await lifecycle(); await ui.evaluate("navigate('settings','instances')"); ui.confirm(true);
  await ui.button(ui.record('archived'), '恢复并使用').emit('click');
  assert.deepEqual(ui.calls.filter(call => call.action === 'instances.restore').map(call => call.args), [{ instanceId: 'archived', activate: true }]);
  assert.equal(ui.evaluate('state.instanceId'), 'archived'); assert.equal(ui.items.find(item => item.id === 'archived').archivedAt, null);
  assert.equal(ui.calls.some(call => call.action === 'instances.clear'), false);
});

test('clear preview shows backend text scope and excluded assets without claiming full asset deletion', async () => {
  const ui = await lifecycle(); await ui.evaluate("navigate('settings','instances')"); const body = await ui.preview();
  assert.equal(ui.ids.get('detail-title').textContent, '清除人格文本资料前，请核对');
  for (const value of ['受管人格文本 · 当前范围', '自我档案与关系文本', '17', '12,345 bytes', '目录外作品二进制', '独立任务原件', 'DSH旧会话日志、其它实例、共享平台账号不在清除范围']) assert.ok(body.textContent.includes(value), value);
  assert.equal(ui.calls.filter(call => call.action === 'instances.clearPreview').length, 1);
  assert.equal(ui.calls.some(call => call.action === 'instances.clear' || call.action === 'instances.archive'), false);
  assert.equal(ui.button(ui.ids.get('detail-footer'), '确认清除人格文本资料').disabled, true);
});

test('no name wrong name or whitespace mismatch cannot submit clear', async () => {
  const ui = await lifecycle(); await ui.evaluate("navigate('settings','instances')"); await ui.preview();
  for (const text of ['', '错误人格', ' 人格甲', '人格甲 ']) { await ui.typeName(text); const submit = ui.button(ui.ids.get('detail-footer'), '确认清除人格文本资料'); assert.equal(submit.disabled, true); await submit.emit('click'); }
  assert.equal(ui.calls.some(call => call.action === 'instances.clear'), false);
});

test('clear preview accepts the actual backend SHA256 version and rejects integer or malformed versions', async () => {
  const ui = await lifecycle(); await ui.evaluate("navigate('settings','instances')"); await ui.preview();
  const actual = clearVersion({ instanceId: 'default', name: '人格甲' }, { root: 'C:/fixture/persona-a', files: [] }, 9);
  assert.match(actual, /^[a-f0-9]{64}$/); assert.equal(ui.ids.get('detail-dialog').open, true);
  for (const version of [9, -1, null, '9', 'a'.repeat(63), 'g'.repeat(64)]) {
    const invalid = await lifecycle({ 'instances.clearPreview': () => ({ instanceId: 'default', name: '人格甲', memoryRoot: 'C:/fixture/persona-a', scope: ['实际受管文本'], excluded: [], files: 1, bytes: 10, requiresName: '人格甲', confirmationToken: 'token', version }) });
    await invalid.evaluate("navigate('settings','instances')"); await invalid.preview();
    assert.equal(invalid.ids.get('detail-dialog').open, false, String(version));
    assert.ok(invalid.ids.get('global-error').textContent.includes('无法核实清除预览'));
    assert.equal(invalid.calls.some(call => call.action === 'instances.clear'), false);
  }
});

test('cancel keeps data and invalidates stale clear controls without issuing a write', async () => {
  const ui = await lifecycle(); await ui.evaluate("navigate('settings','instances')"); await ui.preview(); await ui.typeName('人格甲');
  const submit = ui.button(ui.ids.get('detail-footer'), '确认清除人格文本资料');
  await ui.button(ui.ids.get('detail-footer'), '取消，保留资料').emit('click'); await submit.emit('click');
  assert.equal(ui.ids.get('detail-dialog').open, false);
  assert.equal(ui.calls.some(call => call.action === 'instances.clear' || call.action === 'instances.archive'), false);
  assert.equal(ui.items.find(item => item.id === 'default').clearedAt, null);
});

test('exact typed confirmation clears only the previewed instance once and keeps it unloaded', async () => {
  const ui = await lifecycle(); await ui.evaluate("navigate('settings','instances')"); await ui.preview(); await ui.typeName('人格甲');
  await ui.button(ui.ids.get('detail-footer'), '确认清除人格文本资料').emit('click');
  assert.deepEqual(ui.calls.filter(call => call.action === 'instances.clear').map(call => call.args), [{ instanceId: 'default', confirmationToken: 'fixture-token-default', typedName: '人格甲' }]);
  assert.equal(ui.evaluate('state.instanceId'), 'default'); assert.equal(ui.items.find(item => item.id === 'default').loaded, false);
  assert.equal(ui.walk(ui.record('default')).some(node => node.tagName === 'button' && /加载实例|恢复并使用/.test(node.textContent)), false);
  assert.equal(ui.calls.some(call => /instances\.(load|select|restore|create)/.test(call.action)), false);
  assert.equal(ui.items.find(item => item.id === 'other').clearedAt, null);
});

test('archive from the clear preview does not secretly clear or create a backup', async () => {
  const ui = await lifecycle(); await ui.evaluate("navigate('settings','instances')"); await ui.preview(); ui.confirm(true);
  await ui.button(ui.ids.get('detail-footer'), '先归档保留').emit('click');
  assert.equal(ui.calls.filter(call => call.action === 'instances.archive').length, 1);
  assert.equal(ui.calls.some(call => call.action === 'instances.clear' || /maintenance\.backup/.test(call.action)), false);
  assert.equal(ui.items.find(item => item.id === 'default').clearedAt, null);
});

test('a blocked preview preserves unknown files and offers no destructive submission', async () => {
  const ui = await lifecycle({ 'instances.clearPreview': () => { throw Object.assign(new Error('存在未知文件，保留目录'), { code: 'INSTANCE_UNKNOWN_FILES' }); } });
  await ui.evaluate("navigate('settings','instances')"); await ui.button(ui.record('default'), '清除文本资料…').emit('click');
  assert.ok(ui.ids.get('global-error').textContent.includes('INSTANCE_UNKNOWN_FILES'));
  assert.equal(ui.ids.get('detail-dialog').open, false); assert.equal(ui.calls.some(call => call.action === 'instances.clear'), false);
});

test('partial cleanup cannot load or restore and requires a fresh preview and confirmation', async () => {
  let rows;
  const ui = await lifecycle({ 'instances.clear': args => { const item = rows.find(row => row.id === args.instanceId); item.loaded = false; item.clearStatus = 'partial'; return { status: 'partial', instanceId: item.id }; } }); rows = ui.items;
  await ui.evaluate("navigate('settings','instances')"); await ui.preview(); await ui.typeName('人格甲'); await ui.button(ui.ids.get('detail-footer'), '确认清除人格文本资料').emit('click');
  assert.ok(ui.record('default').textContent.includes('清除未完成'));
  assert.equal(ui.walk(ui.record('default')).some(node => node.tagName === 'button' && /加载实例|恢复并使用/.test(node.textContent)), false);
  await ui.button(ui.record('default'), '重新预览并继续清除').emit('click');
  assert.equal(ui.ids.get('instance-clear-name').value, ''); assert.equal(ui.button(ui.ids.get('detail-footer'), '确认清除人格文本资料').disabled, true);
  assert.equal(ui.calls.filter(call => call.action === 'instances.clearPreview').length, 2); assert.equal(ui.calls.filter(call => call.action === 'instances.clear').length, 1);
});

test('stale confirmation and stale typed controls cannot write after changing instances', async () => {
  const ui = await lifecycle(); await ui.evaluate("navigate('settings','instances')");
  const archive = ui.button(ui.record('default'), '归档保留').emit('click'); await settle();
  ui.evaluate("state.instanceId='other';state.generation++"); await ui.ids.get('confirm-accept').emit('click'); await archive;
  assert.equal(ui.calls.some(call => call.action === 'instances.archive'), false);
  ui.evaluate("state.instanceId='default'"); await ui.evaluate("navigate('settings','instances')"); await ui.preview(); await ui.typeName('人格甲');
  const submit = ui.button(ui.ids.get('detail-footer'), '确认清除人格文本资料'); ui.evaluate("state.instanceId='other';state.generation++"); await submit.emit('click');
  assert.equal(ui.calls.some(call => call.action === 'instances.clear'), false);
});

test('a delayed preview from an old instance cannot open a clear dialog in the new one', async () => {
  let release, announce; const started = new Promise(resolve => { announce = resolve; });
  const ui = await lifecycle({ 'instances.clearPreview': () => { announce(); return new Promise(resolve => { release = resolve; }); } });
  await ui.evaluate("navigate('settings','instances')"); const pending = ui.button(ui.record('default'), '清除文本资料…').emit('click'); await started;
  ui.evaluate("state.instanceId='other';state.generation++"); ui.ids.get('page-content').textContent = 'OTHER';
  release({ instanceId: 'default', requiresName: '人格甲', confirmationToken: 'old' }); await pending;
  assert.equal(ui.ids.get('detail-dialog').open, false); assert.equal(ui.ids.get('page-content').textContent, 'OTHER');
});

test('pending clear rejects double clicks and cannot refresh another selected instance', async () => {
  let release, announce; const started = new Promise(resolve => { announce = resolve; });
  const ui = await lifecycle({ 'instances.clear': () => { announce(); return new Promise(resolve => { release = resolve; }); } });
  await ui.evaluate("navigate('settings','instances')"); await ui.preview(); await ui.typeName('人格甲'); const submit = ui.button(ui.ids.get('detail-footer'), '确认清除人格文本资料');
  const pending = submit.emit('click'); await started; await submit.emit('click');
  assert.equal(ui.calls.filter(call => call.action === 'instances.clear').length, 1);
  const count = ui.calls.length; ui.evaluate("state.instanceId='other';state.generation++"); ui.ids.get('page-content').textContent = 'OTHER';
  release({ status: 'cleared' }); await pending;
  assert.equal(ui.calls.length, count); assert.equal(ui.ids.get('page-content').textContent, 'OTHER'); assert.equal(ui.ids.get('toast').hidden, true);
});

test('new persona only asks for a name and creates an independent instance after confirmation', async () => {
  const ui = await lifecycle(); await ui.evaluate("navigate('settings','instances')"); await destinationButton(ui, '新建人格').emit('click');
  assert.equal(ui.ids.get('page-title').textContent, '新建人格'); assert.equal(ui.walk(ui.ids.get('page-content')).some(node => node.id === 'instance-new-root'), false);
  await ui.button(ui.ids.get('page-content'), '创建并使用').emit('click'); assert.equal(ui.calls.some(call => call.action === 'instances.create'), false);
  ui.ids.get('persona-new-name').value = '新朋友'; ui.confirm(true); await ui.button(ui.ids.get('page-content'), '创建并使用').emit('click');
  assert.deepEqual(ui.calls.filter(call => call.action === 'instances.create').map(call => call.args), [{ instanceId: undefined, name: '新朋友', autoLoad: true }]);
  assert.equal(ui.evaluate('state.instanceId'), 'created'); assert.equal(ui.ids.get('page-title').textContent, '自我档案');
  assert.equal(ui.items.find(item => item.id === 'default').clearedAt, null); assert.equal(ui.calls.some(call => call.action === 'instances.clear'), false);
});

test('new persona cancellation and backend capacity failure preserve the existing instances', async () => {
  const ui = await lifecycle({ 'instances.create': () => { throw Object.assign(new Error('登记已达16条，请先核对已有资料'), { code: 'INSTANCE_CAPACITY' }); } });
  await ui.evaluate("navigate('settings','new-persona')"); ui.ids.get('persona-new-name').value = '新朋友';
  const pending = ui.button(ui.ids.get('page-content'), '创建并使用').emit('click'); await settle(); await ui.ids.get('confirm-cancel').emit('click'); await pending;
  assert.equal(ui.calls.some(call => call.action === 'instances.create'), false);
  ui.confirm(true); await ui.button(ui.ids.get('page-content'), '创建并使用').emit('click');
  assert.ok(ui.ids.get('global-error').textContent.includes('INSTANCE_CAPACITY')); assert.equal(ui.items.length, 4); assert.equal(ui.evaluate('state.instanceId'), 'default');
});

test('a cleared persona exposes explicit new creation without automatically creating or reusing its old root', async () => {
  const ui = await lifecycle(); await ui.evaluate("navigate('settings','instances')"); await ui.button(ui.record('cleared'), '新建人格').emit('click');
  assert.equal(ui.ids.get('page-title').textContent, '新建人格'); assert.equal(ui.ids.get('persona-new-name').value, '');
  assert.equal(ui.calls.some(call => call.action === 'instances.create' || call.action === 'instances.load'), false);
});
