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

const blankSelf = () => ({ schemaVersion: 'xiangxu-self/1', version: 0, mode: 'unset', onboardingAcknowledged: false, initial: {}, current: {}, history: [], createdAt: null, updatedAt: 0 });
const statusWithSelf = profile => ({ available: true, runtime: { sleep: { state: 'awake' }, globalMuted: false }, capacity: {}, agents: [], selfProfile: { mode: profile.mode, version: profile.version, onboardingAcknowledged: profile.onboardingAcknowledged } });

test('first-use hint is optional and skipping saves only the original instance acknowledgement', async () => {
  const profile = blankSelf();
  const ui = await frontend({ status: () => statusWithSelf(profile), 'self.update': args => { assert.deepEqual(structuredClone(args.patch), { mode: 'unset', onboardingAcknowledged: true }); profile.onboardingAcknowledged = true; profile.version++; return structuredClone(profile); } });
  const page = ui.ids.get('page-content');
  assert.ok(page.textContent.includes('先认识一下，也可以直接聊天'));
  assert.equal(ui.ids.get('confirm-dialog').open, false);
  assert.equal(ui.calls.some(call => call.action === 'self.get'), false);
  await ui.button(page, '以后再说').emit('click');
  assert.deepEqual(ui.calls.filter(call => call.action === 'self.update').map(call => call.args), [{ instanceId: 'default', patch: { mode: 'unset', onboardingAcknowledged: true }, expectedVersion: 0 }]);
  assert.equal(ui.ids.get('page-content').textContent.includes('先认识一下，也可以直接聊天'), false);
  assert.equal(ui.calls.some(call => /model|operations.start|control.consolidate/.test(call.action)), false);
});

test('a dismissed or already configured profile does not repeatedly ask for initialization', async () => {
  for (const profile of [{ ...blankSelf(), onboardingAcknowledged: true }, { ...blankSelf(), mode: 'autonomous' }]) {
    const ui = await frontend({ status: () => statusWithSelf(profile) });
    assert.equal(ui.ids.get('page-content').textContent.includes('先认识一下，也可以直接聊天'), false);
    assert.equal(ui.calls.some(call => call.action === 'self.update' || call.action === 'self.get'), false);
  }
});

test('initial ideas save once with CAS and never overwrite the separate current self description', async () => {
  const profile = { ...blankSelf(), version: 4, mode: 'together', current: { name: '当前的名字', gender: '未定', pronouns: 'TA', selfDescription: '已经形成的描述' }, initial: { name: '用户原本的建议' } };
  const ui = await frontend({ 'self.get': () => structuredClone(profile), 'self.update': args => { profile.initial = structuredClone(args.patch.initial); profile.version++; return structuredClone(profile); } });
  await ui.evaluate("navigate('persona','self-profile')");
  assert.ok(ui.ids.get('page-content').textContent.includes('已经形成的描述'));
  assert.ok(ui.ids.get('page-content').textContent.includes('未定'));
  assert.ok(ui.ids.get('page-content').textContent.includes('TA'));
  assert.equal(ui.ids.get('page-content').textContent.includes('她'), false);
  assert.ok(ui.ids.get('page-content').textContent.includes('当前自我描述'));
  assert.ok(ui.ids.get('page-content').textContent.includes('由相续选择'));
  assert.equal(ui.walk(ui.ids.get('page-content')).some(node => node.id.startsWith('self-current-')), false);
  ui.ids.get('self-initial-name').value = '新的初始建议';
  ui.ids.get('self-initial-gender').value = '暂时未定';
  await ui.button(ui.ids.get('page-content'), '保存初始资料').emit('click');
  const calls = ui.calls.filter(call => call.action === 'self.update');
  assert.equal(calls.length, 1); assert.equal(calls[0].args.expectedVersion, 4);
  assert.equal(calls[0].args.patch.initial.name, '新的初始建议');
  assert.equal(calls[0].args.patch.initial.gender, '暂时未定');
  assert.equal(calls[0].args.patch.onboardingAcknowledged, true);
  assert.equal(Object.hasOwn(calls[0].args.patch, 'current'), false);
  assert.equal(profile.current.name, '当前的名字');
  assert.equal(ui.ids.get('confirm-dialog').open, false);
  assert.equal(ui.ids.get('self-initial-name').value, '新的初始建议');
});

test('choosing autonomous or unset preserves saved initial ideas instead of submitting hidden empty inputs', async () => {
  for (const mode of ['autonomous', 'unset']) {
    const profile = { ...blankSelf(), version: 2, mode: 'together', initial: { name: '保留的想法' } };
    const ui = await frontend({ 'self.get': () => structuredClone(profile), 'self.update': args => { profile.mode = args.patch.mode; return structuredClone(profile); } });
    await ui.evaluate("navigate('persona','self-profile')");
    const name = ui.ids.get('self-initial-name'); assert.equal(ui.visible(name), true);
    ui.ids.get('self-mode').value = mode; await ui.ids.get('self-mode').emit('change');
    assert.equal(ui.visible(name), false);
    await ui.button(ui.ids.get('page-content'), '保存初始资料').emit('click');
    assert.deepEqual(ui.calls.find(call => call.action === 'self.update').args.patch, { mode, onboardingAcknowledged: true });
    assert.equal(profile.initial.name, '保留的想法');
  }
});

test('more identity fields use a named disclosure and preserve the visible draft', async () => {
  const ui = await frontend({ 'self.get': () => ({ ...blankSelf(), mode: 'together' }) });
  await ui.evaluate("navigate('persona','self-profile')");
  ui.ids.get('self-initial-name').value = '编辑中的名字';
  assert.equal(ui.visible(ui.ids.get('self-initial-ageDescription')), false);
  await ui.button(ui.ids.get('page-content'), '更多身份资料').emit('click');
  assert.equal(ui.visible(ui.ids.get('self-initial-ageDescription')), true);
  assert.equal(ui.ids.get('self-initial-name').value, '编辑中的名字');
  assert.equal(ui.document.querySelectorAll('details,summary').length, 0);
  assert.equal(ui.calls.some(call => call.action === 'self.update'), false);
});

test('oversized initial ideas are refused before writing without truncating the draft', async () => {
  const ui = await frontend({ 'self.get': () => ({ ...blankSelf(), mode: 'together' }) });
  await ui.evaluate("navigate('persona','self-profile')");
  ui.ids.get('self-initial-selfDescription').value = '相'.repeat(2401);
  await ui.button(ui.ids.get('page-content'), '保存初始资料').emit('click');
  assert.equal(ui.calls.some(call => call.action === 'self.update'), false);
  assert.equal(ui.ids.get('self-initial-selfDescription').value.length, 2401);
  assert.equal(ui.ids.get('global-error').hidden, false);
});

test('a version conflict preserves the self profile draft and shows the actual error', async () => {
  const ui = await frontend({ 'self.get': () => ({ ...blankSelf(), mode: 'together', version: 3 }), 'self.update': () => { throw Object.assign(new Error('资料已有更新，请重新读取后比较'), { code: 'VERSION_CONFLICT' }); } });
  await ui.evaluate("navigate('persona','self-profile')");
  ui.ids.get('self-initial-name').value = '没有丢失的草稿';
  await ui.button(ui.ids.get('page-content'), '保存初始资料').emit('click');
  assert.equal(ui.calls.filter(call => call.action === 'self.update').length, 1);
  assert.equal(ui.ids.get('self-initial-name').value, '没有丢失的草稿');
  assert.ok(ui.ids.get('global-error').textContent.includes('VERSION_CONFLICT'));
  assert.equal(ui.calls.filter(call => call.action === 'self.get').length, 1);
});

test('stale initialization controls cannot write into a newly selected instance', async () => {
  const profile = blankSelf(), ui = await frontend({ status: () => statusWithSelf(profile), 'self.get': () => structuredClone(profile) });
  const skip = ui.button(ui.ids.get('page-content'), '以后再说');
  ui.evaluate("state.instanceId='second';state.generation++"); await skip.emit('click');
  ui.evaluate("state.instanceId='default'"); await ui.evaluate("navigate('persona','self-profile')");
  const save = ui.button(ui.ids.get('page-content'), '保存初始资料');
  ui.evaluate("state.instanceId='third';state.generation++"); await save.emit('click');
  assert.equal(ui.calls.some(call => call.action === 'self.update'), false);
});

test('a pending self profile save cannot refresh or toast into a different instance', async () => {
  let release, announce; const started = new Promise(resolve => { announce = resolve; });
  const ui = await frontend({ 'self.get': () => ({ ...blankSelf(), mode: 'together' }), 'self.update': () => { announce(); return new Promise(resolve => { release = resolve; }); } });
  await ui.evaluate("navigate('persona','self-profile')"); ui.ids.get('self-initial-name').value = '原实例的资料';
  const pending = ui.button(ui.ids.get('page-content'), '保存初始资料').emit('click'); await started;
  const count = ui.calls.length; ui.evaluate("state.instanceId='other';state.generation++"); ui.ids.get('page-content').textContent = 'OTHER_INSTANCE';
  release({ saved: true }); await pending;
  assert.equal(ui.calls.length, count); assert.equal(ui.calls.at(-1).args.instanceId, 'default');
  assert.equal(ui.ids.get('page-content').textContent, 'OTHER_INSTANCE'); assert.equal(ui.ids.get('toast').hidden, true);
});

test('the local user guide is available without loading a persona and begins no model or platform operation', async () => {
  const ui = await frontend({ status: () => ({ available: false, unloaded: true }) });
  const count = ui.calls.length; await ui.evaluate("navigate('settings','user-guide')");
  const page = ui.ids.get('page-content');
  assert.equal(ui.ids.get('page-title').textContent, '使用说明');
  for (const text of ['新开窗口不等于重新创建人格', '初始资料与当前采用的自我描述分别保存', '记什么、怎样理解和何时回忆，由相续决定', '分不分条、说几句、是否继续', '不保证每天或每隔多久发一次', '朋友圈或实时通话不能仅靠扫码获得']) assert.ok(page.textContent.includes(text), text);
  assert.equal(ui.ids.get('global-error').hidden, true);
  assert.deepEqual(ui.calls.slice(count).map(call => call.action), ['status']);
  assert.equal(ui.document.querySelectorAll('details,summary').length, 0);
});

test('a delayed failed self save never paints an error into the next instance', async () => {
  let reject, announce; const started = new Promise(resolve => { announce = resolve; });
  const ui = await frontend({ 'self.get': () => ({ ...blankSelf(), mode: 'together' }), 'self.update': () => { announce(); return new Promise((resolve, fail) => { reject = fail; }); } });
  await ui.evaluate("navigate('persona','self-profile')");
  const pending = ui.button(ui.ids.get('page-content'), '保存初始资料').emit('click'); await started;
  ui.evaluate("state.instanceId='next';state.generation++"); ui.ids.get('page-content').textContent = 'NEXT_INSTANCE';
  reject(new Error('the old save failed')); await pending;
  assert.equal(ui.ids.get('global-error').hidden, true); assert.equal(ui.ids.get('toast').hidden, true);
  assert.equal(ui.ids.get('page-content').textContent, 'NEXT_INSTANCE');
});

test('conversation rhythm is an ordinary preference saved once without model work or confirmation', async () => {
  let selected = 'short_chat';
  const ui = await frontend({ status: () => ({ available: true, runtime: { sleep: { state: 'awake' } }, config: { conversationStyle: selected }, capacity: {}, agents: [] }), 'config.update': args => { selected = args.config.conversationStyle; return { saved: true }; } });
  assert.equal(ui.ids.get('conversation-style').value, 'short_chat');
  assert.ok(ui.ids.get('page-content').textContent.includes('不保证每次发多条'));
  const input = ui.ids.get('conversation-style'); input.value = 'detailed'; await input.emit('change');
  assert.deepEqual(ui.calls.filter(call => call.action === 'config.update').map(call => call.args), [{ instanceId: 'default', config: { conversationStyle: 'detailed' } }]);
  assert.equal(ui.ids.get('conversation-style').value, 'detailed');
  assert.equal(ui.ids.get('confirm-dialog').open, false);
  assert.equal(ui.calls.some(call => /model|operations.start|control.consolidate/.test(call.action)), false);
});

test('stale and pending rhythm controls stay with their original instance', async () => {
  let release, announce; const started = new Promise(resolve => { announce = resolve; });
  const ui = await frontend({ 'config.update': () => { announce(); return new Promise(resolve => { release = resolve; }); } });
  const input = ui.ids.get('conversation-style'); input.value = 'balanced'; const pending = input.emit('change'); await started;
  ui.evaluate("state.instanceId='other';state.generation++"); ui.ids.get('page-content').textContent = 'OTHER'; const count = ui.calls.length;
  release({ saved: true }); await pending;
  assert.equal(ui.calls.length, count); assert.equal(ui.calls.at(-1).args.instanceId, 'default');
  assert.equal(ui.ids.get('page-content').textContent, 'OTHER'); assert.equal(ui.ids.get('toast').hidden, true);
  input.value = 'detailed'; await input.emit('change');
  assert.equal(ui.calls.filter(call => call.action === 'config.update').length, 1);
});

test('a failed rhythm preference remains visibly unsaved and reports the save failure', async () => {
  const ui = await frontend({ 'config.update': () => { throw Object.assign(new Error('无法保存这个偏好'), { code: 'SAVE_FAILED' }); } });
  const input = ui.ids.get('conversation-style'); input.value = 'balanced'; await input.emit('change');
  assert.equal(input.value, 'short_chat'); assert.ok(ui.ids.get('global-error').textContent.includes('SAVE_FAILED'));
  assert.equal(ui.calls.filter(call => call.action === 'config.update').length, 1);
});
