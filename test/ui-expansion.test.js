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

test('the five primary entries navigate actual pages and expose exactly one current destination', async () => {
  const ui = await frontend(), nav = ui.document.querySelectorAll('[data-page]');
  assert.deepEqual(nav.map(node => [node.dataset.page, node.textContent]), [['overview', '相处'], ['memory', '记忆'], ['chat', '连接'], ['media', '创作'], ['settings', '设置']]);
  for (const node of nav) {
    await node.emit('click'); await settle();
    assert.equal(ui.ids.get('page-title').textContent, node.textContent);
    assert.equal(ui.ids.get('page-back').hidden, true);
    assert.deepEqual(nav.filter(item => item.getAttribute('aria-current') === 'page').map(item => item.dataset.page), [node.dataset.page]);
    assert.equal(ui.ids.get('global-error').hidden, true);
  }
  assert.equal(ui.calls.some(call => /^(?:connections\.start|channels\.start|media\.generate|config\.update|operations\.start)$/.test(call.action)), false);
});

test('connection subpages return to their actual parent without beginning a login', async () => {
  const ui = await frontend(); await ui.evaluate("navigate('chat')");
  await destinationButton(ui, 'QQ').emit('click');
  assert.equal(ui.ids.get('page-title').textContent, '连接 QQ'); assert.equal(ui.ids.get('page-back').hidden, false);
  assert.ok(ui.walk(ui.ids.get('page-content')).some(node => node.tagName === 'ol' && node.textContent.includes('扫码授权')));
  await destinationButton(ui, '能力与权限').emit('click');
  assert.equal(ui.ids.get('page-title').textContent, 'QQ 能力与权限');
  await ui.ids.get('page-back').emit('click'); await settle();
  assert.equal(ui.ids.get('page-title').textContent, '连接 QQ');
  await ui.ids.get('page-back').emit('click'); await settle();
  assert.equal(ui.ids.get('page-title').textContent, '连接'); assert.equal(ui.ids.get('page-back').hidden, true);
  assert.equal(ui.calls.some(call => ['connections.start', 'connections.poll', 'channels.start', 'channels.configure', 'permissions.configure'].includes(call.action)), false);
});

test('secondary task pages preserve their primary navigation and return destination', async () => {
  const ui = await frontend({ 'persona.get': () => ({ anchor: { text: '已保存的自我描述' } }) });
  await destinationButton(ui, '了解相续').emit('click');
  assert.equal(ui.ids.get('page-title').textContent, '了解相续');
  assert.equal(ui.document.querySelector('[data-page="overview"]').getAttribute('aria-current'), 'page');
  assert.equal(ui.ids.get('page-back').textContent, '返回相处');
  await ui.ids.get('page-back').emit('click'); await settle();
  assert.equal(ui.ids.get('page-title').textContent, '相处'); assert.equal(ui.ids.get('page-back').hidden, true);
});

test('representative settings and channel pages use named disclosures without native triangles', async () => {
  const ui = await frontend();
  for (const [page, view] of [['settings', 'assistant'], ['chat', 'qq-bridge'], ['chat', 'qq-permissions'], ['media', 'provider-image'], ['media', 'provider-video'], ['memory', 'deep']]) {
    await ui.evaluate('navigate(' + JSON.stringify(page) + ',' + JSON.stringify(view) + ')');
    assert.equal(ui.ids.get('global-error').hidden, true, page + '/' + view);
    assert.equal(ui.document.querySelectorAll('details,summary').length, 0, page + '/' + view);
    for (const toggle of ui.ids.get('page-content').querySelectorAll('button[aria-controls]')) {
      assert.ok(toggle.textContent.trim());
      const content = ui.ids.get(toggle.getAttribute('aria-controls')); assert.ok(content);
      assert.equal(content.hidden, toggle.getAttribute('aria-expanded') !== 'true');
    }
  }
});

test('dialogue details put the actual words first and reveal source metadata only on request', async () => {
  const record = { id: 'chat-one', recordType: 'chat', scope: 'person', personId: 'person-one', role: 'assistant', speakerId: 'personality-one', text: '这是真正的原话。', sourceSessionId: 'private-source-session', sourceEventId: 'event-one', sourceAt: 1770000000000 };
  const ui = await frontend({ 'memory.detail': () => record });
  await ui.evaluate("inspectDocument('memory.detail',{id:'chat-one'},'记忆详情')");
  const body = ui.ids.get('detail-content'), nodes = ui.walk(body), words = nodes.find(node => node.classList.contains('detail-value'));
  const source = nodes.find(node => node.tagName === 'dd' && node.textContent === 'private-source-session');
  const toggle = ui.button(body, '查看来源与记录信息');
  assert.equal(words.textContent, record.text); assert.equal(ui.visible(words), true);
  assert.ok(nodes.indexOf(words) < nodes.indexOf(toggle));
  assert.equal(ui.visible(source), false); assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  await toggle.emit('click'); assert.equal(toggle.getAttribute('aria-expanded'), 'true'); assert.equal(ui.visible(source), true);
  await toggle.emit('click'); assert.equal(ui.visible(source), false);
  assert.equal(ui.calls.some(call => call.action === 'sources.read'), false);
});

test('assistant settings save from their independent page with no extra confirmation or model work', async () => {
  const ui = await frontend({ 'config.update': () => ({ saved: true }) }); await ui.evaluate("navigate('settings')");
  assert.equal(ui.ids.get('review-assistant-enabled'), undefined);
  await destinationButton(ui, '整理资料助手').emit('click');
  assert.equal(ui.ids.get('page-title').textContent, '整理资料助手');
  ui.ids.get('review-assistant-enabled').checked = true;
  await ui.button(ui.ids.get('page-content'), '保存整理助手设置').emit('click');
  const writes = ui.calls.filter(call => call.action === 'config.update');
  assert.deepEqual(writes.map(call => call.args), [{ instanceId: 'default', config: { reviewAssistant: { enabled: true } } }]);
  assert.equal(ui.ids.get('confirm-dialog').open, false);
  assert.equal(ui.calls.some(call => ['operations.start', 'control.consolidate', 'model.invoke'].includes(call.action)), false);
});

test('a pending assistant save stays with its original instance and cannot refresh the new one', async () => {
  let release, announce; const started = new Promise(resolve => { announce = resolve; });
  const ui = await frontend({ 'config.update': () => { announce(); return new Promise(resolve => { release = resolve; }); } });
  await ui.evaluate("navigate('settings','assistant')"); ui.ids.get('review-assistant-enabled').checked = true;
  const pending = ui.button(ui.ids.get('page-content'), '保存整理助手设置').emit('click'); await started;
  const callCount = ui.calls.length;
  ui.evaluate("state.instanceId='other-personality';state.generation++"); ui.ids.get('page-content').textContent = 'NEW_ASSISTANT_PAGE';
  release({ saved: true }); await pending;
  assert.equal(ui.calls.length, callCount); assert.equal(ui.calls.at(-1).args.instanceId, 'default');
  assert.equal(ui.ids.get('page-content').textContent, 'NEW_ASSISTANT_PAGE'); assert.equal(ui.ids.get('toast').hidden, true);
});

test('a stale assistant or social form cannot begin a write after changing instances', async () => {
  const ui = await frontend(); const assistant = ui.evaluate("state.page='settings';reviewAssistantSettings({})");
  ui.ids.get('review-assistant-enabled').checked = true; ui.evaluate("state.instanceId='second';state.generation++");
  await ui.button(assistant, '保存整理助手设置').emit('click');
  const social = await ui.evaluate("state.page='chat';socialIdentitiesPanel()");
  ui.ids.get('social-account-id').value = 'uid-one'; ui.evaluate("state.instanceId='third';state.generation++");
  await ui.button(social, '保存账号档案').emit('click');
  assert.equal(ui.calls.some(call => ['config.update', 'social.upsert'].includes(call.action)), false);
});

test('an unverified registered account remains unverified and has no executable capability', async () => {
  const item = { identityId: 'social-unverified', platform: 'qq', accountId: 'pending-account', connection: { adapterAvailable: true, connected: false, currentAccount: true, verification: 'unverified', status: 'unverified' }, capabilities: [{ id: 'chat.text', supported: true, allowed: true, available: false, reason: '连接尚未核实' }] };
  const ui = await frontend({ 'social.inspect': () => ({ items: [item], total: 1 }) }); await ui.evaluate("navigate('chat','accounts')");
  const page = ui.ids.get('page-content');
  assert.ok(page.textContent.includes('仅登记／尚未核实连接')); assert.equal(page.textContent.includes('当前连接已核验'), false);
  const capabilityCount = ui.walk(page).find(node => node.tagName === 'dt' && node.textContent === '当前已核实可用能力');
  assert.equal(capabilityCount.parentNode.children[1].textContent, '0 项');
  assert.equal(ui.calls.some(call => ['connections.start', 'social.linkCurrent', 'permissions.configure'].includes(call.action)), false);
});

test('instance management opens startup and another memory library as separate read-only destinations', async () => {
  const ui = await frontend(); await ui.evaluate("navigate('settings','instances')");
  assert.ok(ui.ids.get('page-content').textContent.includes('已保存的人格'));
  assert.equal(ui.walk(ui.ids.get('page-content')).some(node => node.id === 'instance-new-root'), false);
  await destinationButton(ui, '启动时加载').emit('click');
  assert.ok(ui.walk(ui.ids.get('page-content')).some(node => node.id === 'instance-auto-load'));
  assert.equal(ui.walk(ui.ids.get('page-content')).some(node => node.id === 'instance-new-root'), false);
  await ui.ids.get('page-back').emit('click'); await settle();
  await destinationButton(ui, '使用其他记忆库').emit('click');
  assert.ok(ui.walk(ui.ids.get('page-content')).some(node => node.id === 'instance-new-root'));
  assert.equal(ui.walk(ui.ids.get('page-content')).some(node => node.id === 'instance-auto-load'), false);
  assert.equal(ui.calls.some(call => ['instances.load', 'instances.select', 'instances.unload'].includes(call.action)), false);
});

test('the settings maintenance destination opens all four subpages and returns without executing maintenance', async () => {
  const ui = await frontend({ 'diagnostics.list': () => ({ items: [], total: 0 }) });
  await ui.evaluate("navigate('settings')"); await destinationButton(ui, '数据维护与诊断').emit('click');
  assert.equal(ui.ids.get('page-title').textContent, '维护与诊断'); assert.equal(ui.ids.get('global-error').hidden, true);
  for (const [label, title, content] of [['检查数据', '数据校验', '校验当前实例'], ['创建备份', '创建备份', '备份目标绝对目录'], ['从备份恢复', '恢复备份', '已校验备份的绝对目录'], ['运行诊断', '运行诊断', '当前没有可用诊断']]) {
    await destinationButton(ui, label).emit('click');
    assert.equal(ui.ids.get('page-title').textContent, title);
    assert.equal(ui.ids.get('global-error').hidden, true, label);
    assert.ok(ui.ids.get('page-content').textContent.includes(content), label);
    assert.equal(ui.ids.get('confirm-dialog').open, false);
    await ui.ids.get('page-back').emit('click'); await settle();
    assert.equal(ui.ids.get('page-title').textContent, '维护与诊断'); assert.equal(ui.ids.get('global-error').hidden, true);
  }
  await ui.ids.get('page-back').emit('click'); await settle();
  assert.equal(ui.ids.get('page-title').textContent, '设置'); assert.equal(ui.ids.get('page-back').hidden, true);
  assert.equal(ui.calls.filter(call => call.action === 'diagnostics.list').length, 1);
  assert.equal(ui.calls.some(call => call.action.startsWith('maintenance.') || ['operations.start', 'control.backfill', 'instances.load', 'instances.unload'].includes(call.action)), false);
});

test('evolution progress history and manual receipts stay separate and browsing never starts work', async () => {
  const ui = await frontend({ 'history.list': () => ({ items: [{ version: 1, current: false, updatedAt: 1770000000000 }] }), 'operations.list': () => ({ items: [{ id: 'operation-one', action: 'control.consolidate', status: 'completed' }] }), 'jobs.list': () => ({ items: [] }) });
  await ui.evaluate("navigate('evolution')"); const page = ui.ids.get('page-content');
  assert.ok(page.textContent.includes('没有当前筛选下的作业'));
  assert.equal(page.textContent.includes('对比起点'), false); assert.equal(page.textContent.includes('查询原操作回执'), false);
  await ui.button(page, '人格变化').emit('click');
  assert.ok(page.textContent.includes('对比起点')); assert.equal(page.textContent.includes('查询原操作回执'), false);
  await ui.button(page, '手动操作').emit('click');
  assert.ok(page.textContent.includes('查询原操作回执')); assert.equal(page.textContent.includes('对比起点'), false);
  assert.equal(ui.calls.some(call => ['operations.start', 'control.consolidate', 'persona.rollback', 'operations.get'].includes(call.action)), false);
});

test('switching budget categories preserves drafts and one save sends only changed fields across categories', async () => {
  const config = defaultConfig(), ui = await frontend({ 'config.get': () => structuredClone(config), 'config.update': () => ({ saved: true }) });
  await ui.evaluate("navigate('settings','budgets')");
  ui.ids.get('config-longTermTargetChars').value = config.longTermTargetChars + 1000;
  ui.ids.get('settings-budget-group').value = '1'; await ui.ids.get('settings-budget-group').emit('change');
  ui.ids.get('config-capacityLimits-documentBytes').value = config.capacityLimits.documentBytes + 1000;
  ui.ids.get('settings-budget-group').value = '0'; await ui.ids.get('settings-budget-group').emit('change');
  assert.equal(ui.ids.get('config-longTermTargetChars').value, String(config.longTermTargetChars + 1000));
  await ui.button(ui.ids.get('page-content'), '保存设置').emit('click');
  assert.deepEqual(ui.calls.filter(call => call.action === 'config.update').map(call => call.args), [{ instanceId: 'default', config: { longTermTargetChars: config.longTermTargetChars + 1000, capacityLimits: { documentBytes: config.capacityLimits.documentBytes + 1000 } } }]);
  assert.equal(ui.ids.get('confirm-dialog').open, false);
});

test('saving ordinary general settings does not clear another category of unsaved budget draft', async () => {
  const config = defaultConfig(), ui = await frontend({ 'config.get': () => structuredClone(config), 'config.update': () => ({ saved: true }) });
  await ui.evaluate("navigate('settings','budgets')"); ui.ids.get('config-longTermTargetChars').value = config.longTermTargetChars + 1111;
  ui.ids.get('settings-budget-group').value = '1'; await ui.ids.get('settings-budget-group').emit('change');
  await ui.evaluate("navigate('settings','general')"); ui.ids.get('settings-timezone').value = 'Asia/Shanghai';
  await ui.button(ui.ids.get('page-content'), '保存设置').emit('click');
  assert.deepEqual(ui.calls.filter(call => call.action === 'config.update').map(call => call.args.config), [{ timezone: 'Asia/Shanghai' }]);
  assert.equal(ui.ids.get('confirm-dialog').open, false);
  await ui.evaluate("navigate('settings','budgets')"); ui.ids.get('settings-budget-group').value = '0'; await ui.ids.get('settings-budget-group').emit('change');
  assert.equal(ui.ids.get('config-longTermTargetChars').value, String(config.longTermTargetChars + 1111));
});

test('budget drafts and stale save controls never cross the selected personality boundary', async () => {
  const config = defaultConfig(), ui = await frontend({ 'config.get': () => structuredClone(config), 'instances.list': () => ({ items: [{ id: 'default', name: '甲', loaded: true }, { id: 'other', name: '乙', loaded: true }], activeInstanceId: 'default' }) });
  await ui.evaluate("navigate('settings','budgets')"); ui.ids.get('config-longTermTargetChars').value = config.longTermTargetChars + 999;
  ui.ids.get('settings-budget-group').value = '1'; await ui.ids.get('settings-budget-group').emit('change');
  const staleSave = ui.button(ui.ids.get('page-content'), '保存设置');
  ui.ids.get('active-instance').value = 'other'; await ui.ids.get('active-instance').emit('change');
  ui.ids.get('settings-budget-group').value = '0'; await ui.ids.get('settings-budget-group').emit('change');
  assert.equal(ui.ids.get('config-longTermTargetChars').value, String(config.longTermTargetChars));
  await staleSave.emit('click');
  assert.equal(ui.calls.some(call => call.action === 'config.update'), false);
});

test('a stale general settings form cannot save after another personality is selected', async () => {
  const config = defaultConfig(), ui = await frontend({ 'config.get': () => structuredClone(config) });
  await ui.evaluate("navigate('settings','general')"); ui.ids.get('settings-timezone').value = 'Asia/Shanghai';
  const save = ui.button(ui.ids.get('page-content'), '保存设置');
  ui.evaluate("state.instanceId='new-personality';state.generation++"); await save.emit('click');
  assert.equal(ui.calls.some(call => call.action === 'config.update'), false);
});

test('adding a supported permission needs one confirmation and cancelling leaves permissions untouched', async () => {
  const ui = await frontend(); await ui.evaluate("navigate('chat','qq-permissions')");
  const panel = ui.ids.get('page-content'), image = ui.walk(panel).find(node => node.getAttribute('aria-label') === '允许发送图片'); image.checked = true;
  const pending = ui.button(panel, '保存这些权限').emit('click'); await settle();
  assert.equal(ui.ids.get('confirm-dialog').open, true); assert.ok(ui.ids.get('confirm-preview').textContent.includes('发送图片'));
  assert.equal(ui.calls.some(call => call.action === 'permissions.configure'), false);
  ui.ids.get('confirm-dialog').close('cancel'); await pending;
  assert.equal(ui.calls.some(call => call.action === 'permissions.configure'), false);
  const accepted = ui.button(panel, '保存这些权限').emit('click'); await settle(); ui.ids.get('confirm-dialog').close('confirm'); await accepted;
  assert.deepEqual(ui.calls.filter(call => call.action === 'permissions.configure').map(call => call.args), [{ instanceId: 'default', id: 'qq', allowed: ['chat.text', 'chat.image'] }]);
});

test('narrowing a permission saves directly while an expanded pending confirmation cannot cross instances', async () => {
  const ui = await frontend(); await ui.evaluate("navigate('chat','qq-permissions')");
  const panel = ui.ids.get('page-content'); ui.walk(panel).find(node => node.getAttribute('aria-label') === '允许发送文字').checked = false;
  await ui.button(panel, '保存这些权限').emit('click');
  assert.equal(ui.ids.get('confirm-dialog').open, false); assert.deepEqual(ui.calls.find(call => call.action === 'permissions.configure').args.allowed, []);
  const fresh = ui.ids.get('page-content'); ui.walk(fresh).find(node => node.getAttribute('aria-label') === '允许发送图片').checked = true;
  const pending = ui.button(fresh, '保存这些权限').emit('click'); await settle();
  assert.equal(ui.ids.get('confirm-dialog').open, true);
  ui.evaluate("state.instanceId='other-personality';state.generation++"); ui.ids.get('confirm-dialog').close('confirm'); await pending;
  assert.equal(ui.calls.filter(call => call.action === 'permissions.configure').length, 1);
});

test('a pending permission write stays on its captured instance and does not refresh another one', async () => {
  let release, announce; const started = new Promise(resolve => { announce = resolve; });
  const ui = await frontend({ 'permissions.configure': () => { announce(); return new Promise(resolve => { release = resolve; }); } });
  await ui.evaluate("navigate('chat','qq-permissions')");
  const panel = ui.ids.get('page-content'); ui.walk(panel).find(node => node.getAttribute('aria-label') === '允许发送文字').checked = false;
  const pending = ui.button(panel, '保存这些权限').emit('click'); await started; const callCount = ui.calls.length;
  ui.evaluate("state.instanceId='other-personality';state.generation++"); ui.ids.get('page-content').textContent = 'NEW_PERMISSION_PAGE';
  release({ ok: true }); await pending;
  assert.equal(ui.calls.length, callCount); assert.equal(ui.calls.at(-1).args.instanceId, 'default');
  assert.equal(ui.ids.get('page-content').textContent, 'NEW_PERMISSION_PAGE'); assert.equal(ui.ids.get('toast').hidden, true);
});

test('memory rows keep UUIDs out of the reading surface while their detail action uses the real record identity', async () => {
  const record = { id: 'record-sensitive-uuid', recordType: 'chat', scope: 'global', role: 'user', text: '真正的对话内容' };
  const ui = await frontend({ 'memory.list': () => ({ items: [record], total: 1 }), 'memory.detail': () => record }); await ui.evaluate("navigate('memory')");
  const page = ui.ids.get('page-content'); assert.equal(page.textContent.includes(record.id), false);
  await ui.button(page, '查看详情 →').emit('click'); assert.equal(ui.calls.find(call => call.action === 'memory.detail').args.id, record.id);
  const identifier = ui.walk(ui.ids.get('detail-content')).find(node => node.tagName === 'dd' && node.textContent === record.id); assert.ok(identifier); assert.equal(ui.visible(identifier), false);
});

test('structured technical values and full run receipts start hidden behind a named disclosure', async () => {
  const ui = await frontend(), values = ui.evaluate("kv({运行细节:{code:'PRIVATE_TECHNICAL_BODY'}})");
  const rawValue = ui.walk(values).find(node => node.tagName === 'pre'); assert.equal(ui.visible(rawValue), false);
  await ui.button(values, '查看内容').emit('click'); assert.equal(ui.visible(rawValue), true);
  const run = { runId: 'run-one', status: 'committed', commitMarker: 'commit-one', validatedPatch: [{ documentKey: 'global:index', recordId: 'memory-one', operation: 'upsert', value: { text: '已提交的人格内容', auxiliary: 'RAW_CHANGE_ONLY' } }], reviewState: { modelCalls: 1, diagnosticBody: 'FULL_RUN_ONLY' } };
  const detail = ui.evaluate('documentView(' + JSON.stringify(run) + ')'), nodes = ui.walk(detail);
  assert.equal(nodes.find(node => node.classList.contains('detail-value')).textContent, '已提交的人格内容');
  for (const raw of nodes.filter(node => node.tagName === 'pre')) assert.equal(ui.visible(raw), false);
  const full = nodes.find(node => node.tagName === 'pre' && node.textContent.includes('FULL_RUN_ONLY'));
  await ui.button(detail, '查看输入范围、读取进度与完整字段').emit('click'); assert.equal(ui.visible(full), true);
});

test('task details show the result before the hidden task identifiers and metadata', async () => {
  const ui = await frontend({ 'tasks.inspect': () => taskUiView, 'tasks.list': () => ({ items: [{ taskId: taskFixtureId, title: '研究任务', status: 'completed' }] }), 'tasks.get': () => ({ taskId: taskFixtureId, title: '研究任务', summary: { text: '研究得到的真实结论', truncated: false }, status: 'completed', capture: { complete: true }, documents: [] }) });
  await ui.evaluate("navigate('tasks')"); await ui.button(ui.ids.get('page-content'), '查看任务与资料').emit('click');
  const body = ui.ids.get('detail-content'), nodes = ui.walk(body), result = nodes.find(node => node.tagName === 'pre' && node.textContent === '研究得到的真实结论');
  const identifier = nodes.find(node => node.tagName === 'dd' && node.textContent === taskFixtureId), toggle = ui.button(body, '任务信息与编号');
  assert.equal(ui.visible(result), true); assert.equal(ui.visible(identifier), false); assert.ok(nodes.indexOf(result) < nodes.indexOf(toggle));
  await toggle.emit('click'); assert.equal(ui.visible(identifier), true);
});

test('opening channel settings reads status without starting authorization or enabling accounts', async () => {
  const ui = await frontend(); await ui.evaluate("navigate('chat')");
  assert.equal(ui.calls.filter(call => ['connections.start', 'connections.poll', 'channels.start'].includes(call.action)).length, 0);
  assert.equal(ui.calls.filter(call => call.action === 'permissions.inspect').length, 0);
  assert.ok(ui.calls.some(call => call.action === 'channels.status'));
  assert.ok(ui.calls.some(call => call.action === 'connections.status'));
});

test('QR flow polls its original flow and releases its timer when leaving the page', async () => {
  const ui = await frontend({ 'connections.start': () => ({ connections: [{ id: 'qq', phase: 'waiting', flowId: 'flow-one', qrDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', expiresAt: Date.now() + 60000 }] }), 'connections.poll': args => ({ connections: [{ id: 'qq', phase: 'waiting', flowId: args.flowId, qrDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }] }) });
  const page = await ui.evaluate("state.page='chat';state.view='qq';chatPage()"); await ui.button(page, '连接QQ').emit('click');
  assert.equal(ui.calls.filter(call => call.action === 'connections.start').length, 1); assert.equal(ui.timers.size, 1);
  const [timerId, poll] = [...ui.timers.entries()][0]; ui.timers.delete(timerId); await poll.fn(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.calls.find(call => call.action === 'connections.poll').args.flowId, 'flow-one');
  assert.ok(ui.walk(page).some(node => node.tagName === 'img' && node.attributes.alt === 'QQ官方授权二维码'));
  await ui.evaluate("navigate('settings')"); assert.equal(ui.timers.size, 0);
});

test('authorized WeChat private scope is explicit and does not grant unsupported groups', async () => {
  const ui = await frontend({ 'connections.status': () => ({ connections: [{ id: 'qq', phase: 'idle' }, { id: 'wechat', phase: 'authorized', accountId: 'bot-one', pairedUserId: 'owner-one', chatTypes: ['private'] }] }) });
  const page = await ui.evaluate("state.page='chat';state.view='wechat';chatPage()");
  const groupLabel = ui.walk(page).find(node => node.tagName === 'label' && node.textContent.includes('群聊：当前官方连接器未提供'));
  assert.ok(groupLabel.children[0].disabled);
  await ui.button(page, '完成连接并启用').emit('click');
  const configure = ui.calls.find(call => call.action === 'channels.configure');
  assert.deepEqual(configure.args.config.allowedPrivateIds, ['owner-one']); assert.deepEqual(configure.args.config.allowedGroupIds, []);
  assert.equal(ui.calls.filter(call => call.action === 'channels.start').length, 1);
});

test('permissions distinguish unsupported capabilities and save only selected real permissions', async () => {
  const ui = await frontend(), panel = await ui.evaluate("state.page='chat';permissionsPanel('qq')"); ui.confirm(true);
  const unsupported = ui.walk(panel).find(node => node.attributes['aria-label'] === '允许发布朋友圈'); assert.equal(unsupported.disabled, true); assert.equal(unsupported.checked, false);
  const image = ui.walk(panel).find(node => node.attributes['aria-label'] === '允许发送图片'); image.checked = true;
  await ui.button(panel, '保存这些权限').emit('click');
  assert.deepEqual(ui.calls.find(call => call.action === 'permissions.configure').args.allowed, ['chat.text', 'chat.image']);
});

test('opening identity settings never submits generation or probe and never fills stored API secrets', async () => {
  const ui = await frontend(); await ui.evaluate("navigate('media','identity')");
  for (const view of ['provider-image', 'provider-video']) await ui.evaluate("openSection('" + view + "')");
  assert.equal(ui.calls.some(call => ['media.generate', 'media.probeProvider', 'media.uploadBegin'].includes(call.action)), false);
  assert.equal(ui.ids.get('media-image-key').value, ''); assert.equal(ui.ids.get('media-video-key').value, '');
  await ui.evaluate("openSection('create')");
  assert.equal(ui.button(ui.ids.get('page-content'), '开始这次创作').disabled, true);
});

test('reference upload uses sequential bounded owner chunks then one finish operation', async () => {
  const ui = await frontend({ 'media.uploadBegin': () => ({ uploadId: 'upload-one' }), 'media.uploadChunk': () => ({ accepted: true }), 'media.uploadFinish': () => ({ assetId: 'asset-one' }) });
  const page = await ui.evaluate("state.page='media';state.view='identity';mediaPage()");
  ui.ids.get('identity-reference-file').files = [new File([Buffer.alloc(70000, 1)], 'reference.png', { type: 'image/png' })];
  await ui.button(page, '上传并保存参考图').emit('click');
  const chunks = ui.calls.filter(call => call.action === 'media.uploadChunk');
  assert.deepEqual(chunks.map(call => call.args.index), [0, 1, 2]); assert.deepEqual(chunks.map(call => Buffer.from(call.args.dataBase64, 'base64').length), [32768, 32768, 4464]);
  assert.ok(chunks.every(call => Buffer.byteLength(JSON.stringify(call.args)) < 65536));
  assert.equal(ui.calls.filter(call => call.action === 'media.uploadFinish').length, 1); assert.equal(ui.calls.some(call => call.action === 'media.uploadCancel'), false);
});

test('creation is submitted once and later queries retain the original job identity', async () => {
  const ui = await frontend({ 'media.generate': () => ({ jobId: 'job-one', status: 'prepared' }), 'media.getJob': () => ({ jobId: 'job-one', kind: 'image', status: 'completed', resultAssetIds: [] }) });
  Object.assign(ui.mediaView.providers[0], { enabled: true, configured: true, capabilities: { generate: true } });
  const page = await ui.evaluate("state.page='media';state.view='create';mediaPage()"); ui.confirm(true); ui.ids.get('media-create-prompt').value = '沿用当前角色，在窗边喝茶';
  await ui.button(page, '开始这次创作').emit('click');
  assert.equal(ui.calls.filter(call => call.action === 'media.generate').length, 1); assert.ok(ui.calls.find(call => call.action === 'media.generate').args.requestId.startsWith('media_ui_'));
  await ui.button(ui.ids.get('detail-footer'), '查询原任务').emit('click');
  assert.equal(ui.calls.filter(call => call.action === 'media.generate').length, 1); assert.ok(ui.calls.filter(call => call.action === 'media.getJob').every(call => call.args.jobId === 'job-one'));
});

test('an unsupported identity reference is not retried as unreferenced text generation', async () => {
  const ui = await frontend({ 'media.getAsset': () => ({ assetId: 'main-reference', kind: 'image', name: '主参考', mime: 'image/png', bytes: 24 }), 'media.generate': () => { throw Object.assign(new Error('服务未支持参考图'), { code: 'REFERENCE_UNSUPPORTED' }); } });
  Object.assign(ui.mediaView.providers[0], { enabled: true, configured: true, capabilities: { generate: true } });
  ui.mediaView.identity.primaryAssetId = 'main-reference';
  const page = await ui.evaluate("state.page='media';state.view='create';mediaPage()"); ui.confirm(true); ui.ids.get('media-create-prompt').value = '同一个形象';
  await ui.button(page, '开始这次创作').emit('click');
  const submissions = ui.calls.filter(call => call.action === 'media.generate'); assert.equal(submissions.length, 1); assert.equal(submissions[0].args.useIdentityReference, true);
});

test('switching instances during a reference upload cancels only the original instance upload', async () => {
  let ui;
  ui = await frontend({ 'media.uploadBegin': () => ({ uploadId: 'upload-old-instance' }), 'media.uploadChunk': () => { ui.evaluate("state.instanceId='other-instance';state.generation++"); return { accepted: true }; }, 'media.uploadCancel': () => ({ cancelled: true }) });
  const page = await ui.evaluate("state.page='media';state.view='identity';mediaPage()");
  ui.ids.get('identity-reference-file').files = [new File([Buffer.alloc(70000)], 'reference.png', { type: 'image/png' })];
  await ui.button(page, '上传并保存参考图').emit('click');
  const transfers = ui.calls.filter(call => call.action.startsWith('media.upload'));
  assert.ok(transfers.every(call => call.args.instanceId === 'default'));
  assert.equal(transfers.filter(call => call.action === 'media.uploadCancel').length, 1);
  assert.equal(transfers.some(call => call.action === 'media.uploadFinish'), false);
});

test('closing a running creative task stops further automatic owner queries', async () => {
  const ui = await frontend({ 'media.generate': () => ({ jobId: 'running-job', status: 'prepared' }), 'media.getJob': () => ({ jobId: 'running-job', kind: 'image', status: 'running', resultAssetIds: [] }) });
  Object.assign(ui.mediaView.providers[0], { enabled: true, configured: true, capabilities: { generate: true } });
  const page = await ui.evaluate("state.page='media';state.view='create';mediaPage()"); ui.confirm(true); ui.ids.get('media-create-prompt').value = '窗边的同一个角色';
  await ui.button(page, '开始这次创作').emit('click');
  const queries = ui.calls.filter(call => call.action === 'media.getJob').length;
  ui.ids.get('detail-dialog').close();
  const [timerId, timer] = [...ui.timers.entries()][0]; ui.timers.delete(timerId); await timer.fn(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.calls.filter(call => call.action === 'media.getJob').length, queries);
  assert.equal(ui.calls.filter(call => call.action === 'media.generate').length, 1);
});

test('ComfyUI reference configuration carries its explicit input binding and keeps optional bindings strings', async () => {
  const ui = await frontend({ 'media.configureProvider': () => ({ saved: true }) });
  const page = await ui.evaluate("state.page='media';state.view='provider-video';mediaPage()");
  ui.ids.get('media-video-url').value = 'http://127.0.0.1:8188';
  ui.ids.get('media-video-workflow').value = JSON.stringify({ 1: { inputs: { text: 'prompt' } }, 3: { inputs: { image: 'reference.png' } } });
  ui.ids.get('media-video-prompt-node').value = '1'; ui.ids.get('media-video-reference-node').value = '3'; ui.ids.get('media-video-reference').value = 'edit';
  await ui.button(page, '保存并启用视频服务').emit('click');
  const saved = ui.calls.find(call => call.action === 'media.configureProvider'); assert.ok(saved);
  assert.equal(saved.args.config.referenceMode, 'edit'); assert.equal(saved.args.config.referenceNode, '3'); assert.equal(saved.args.config.promptNode, '1');
  assert.equal(ui.calls.some(call => call.action === 'media.generate'), false);
});

test('saving an Images provider keeps a blank stored secret untouched and uses the selected edit transport', async () => {
  const ui = await frontend({ 'media.configureProvider': () => ({ saved: true }) });
  const page = await ui.evaluate("state.page='media';state.view='provider-image';mediaPage()");
  ui.ids.get('media-image-url').value = 'https://provider.example/v1'; ui.ids.get('media-image-model').value = 'provider-image';
  ui.ids.get('media-image-reference').value = 'edit'; ui.ids.get('media-image-edit-transport').value = 'multipart';
  ui.ids.get('media-image-download-origins').value = 'https://cdn.provider.example';
  await ui.button(page, '保存并启用图片服务').emit('click');
  const saved = ui.calls.find(call => call.action === 'media.configureProvider'); assert.ok(saved);
  assert.equal(saved.args.config.editTransport, 'multipart'); assert.equal(saved.args.config.referenceMode, 'edit'); assert.equal(Object.hasOwn(saved.args.config, 'apiKey'), false);
  assert.deepEqual(saved.args.config.downloadOrigins, ['https://cdn.provider.example']);
});

test('resetting an old saved account permission is explicit and carries only that account identity', async () => {
  const ui = await frontend({ 'permissions.list': () => ({ items: [{ accountId: 'old-bot', allowed: ['chat.text', 'chat.image'], updatedAt: 1770000000000 }] }), 'permissions.reset': () => ({ reset: true }) });
  const panel = await ui.evaluate("state.page='chat';permissionsPanel('qq')"); ui.confirm(true);
  await ui.button(panel, '恢复该账号默认权限').emit('click');
  const reset = ui.calls.find(call => call.action === 'permissions.reset'); assert.ok(reset); assert.equal(reset.args.id, 'qq'); assert.equal(reset.args.accountId, 'old-bot'); assert.equal(Object.hasOwn(reset.args, 'memoryRoot'), false);
});

const taskFixtureId = 'task-' + 'a'.repeat(32), taskFixtureDoc = 'doc-' + 'b'.repeat(32), taskFixtureSha = 'c'.repeat(64);
const taskUiLimits = { maxTasks: 4096, maxArchiveBytes: 1073741824, maxTaskBytes: 67108864, maxDocumentBytes: 67108864 };
const taskUiView = { limits: taskUiLimits, usage: { tasks: 1, bytes: 800 }, host: { available: true } };
test('task page only reads metadata and leaves delegation and memory selection to the personality', async () => {
  const ui = await frontend({ 'tasks.inspect': () => taskUiView, 'tasks.list': () => ({ items: [], nextCursor: null }) });
  const page = await ui.evaluate("state.page='tasks';tasksPage()");
  assert(ui.walk(page).some(node => node.textContent.includes('浏览此页不会创建任务')));
  assert.equal(ui.calls.filter(call => ['tasks.create', 'tasks.material', 'tasks.configureLimits', 'tasks.cancel'].includes(call.action)).length, 0);
  await ui.button(page, '保存任务容量').emit('click'); assert.equal(ui.calls.filter(call => call.action === 'tasks.configureLimits').length, 0);
});
test('task documents use the actual next Unicode offset and replace previews rather than pretending the first page is complete', async () => {
  const ui = await frontend({ 'tasks.inspect': () => taskUiView, 'tasks.list': () => ({ items: [{ taskId: taskFixtureId, title: '隔离任务', status: 'completed', documentCount: 1, capture: { complete: true } }], nextCursor: null }),
    'tasks.get': () => ({ taskId: taskFixtureId, status: 'completed', documentCount: 1, capture: { complete: true }, documents: [{ documentId: taskFixtureDoc, name: 'report.txt', encoding: 'utf8', sha256: taskFixtureSha, bytes: 8 }], nextDocumentOffset: null }),
    'tasks.read': args => ({ taskId: taskFixtureId, documentId: taskFixtureDoc, encoding: 'utf8', text: args.offset === 0 ? '第一页😀' : '第二页乙', offset: args.offset, nextOffset: args.offset === 0 ? 4 : 8, totalChars: 8, complete: args.offset !== 0, sha256: taskFixtureSha }) });
  const page = await ui.evaluate("state.page='tasks';tasksPage()"); await ui.button(page, '查看任务与资料').emit('click');
  await ui.button(ui.ids.get('detail-content'), '按页查看').emit('click'); assert(ui.ids.get('detail-content').textContent.includes('第一页😀'));
  await ui.button(ui.ids.get('detail-footer'), '下一页').emit('click'); assert(ui.ids.get('detail-content').textContent.includes('第二页乙')); assert(!ui.ids.get('detail-content').textContent.includes('第一页😀'));
  const read = ui.calls.filter(call => call.action === 'tasks.read'); assert.equal(read[1].args.offset, 4); assert.equal(read[1].args.expectedSha256, taskFixtureSha);
});
test('a delayed task document cannot render into another selected personality instance', async () => {
  let release, announce; const waiting = new Promise(resolve => { announce = resolve; });
  const ui = await frontend({ 'tasks.inspect': () => taskUiView, 'tasks.list': () => ({ items: [{ taskId: taskFixtureId, title: '任务', status: 'completed' }], nextCursor: null }), 'tasks.get': () => ({ taskId: taskFixtureId, status: 'completed', capture: { complete: true }, documents: [{ documentId: taskFixtureDoc, name: 'report.txt', sha256: taskFixtureSha }] }), 'tasks.read': () => { announce(); return new Promise(resolve => { release = resolve; }); } });
  const page = await ui.evaluate("state.page='tasks';tasksPage()"); await ui.button(page, '查看任务与资料').emit('click'); const pending = ui.button(ui.ids.get('detail-content'), '按页查看').emit('click'); await waiting;
  ui.evaluate("state.instanceId='different-instance'"); release({ encoding: 'utf8', text: 'OLD_PRIVATE_TASK_BODY', offset: 0, nextOffset: 21, totalChars: 21, complete: true, sha256: taskFixtureSha }); await pending;
  assert(!ui.ids.get('detail-content').textContent.includes('OLD_PRIVATE_TASK_BODY'));
});

test('deep memories remain a browsable personality reference without triggering recall or editing their meaning', async () => {
  const deep = { id: 'deep-memory-one', recordType: 'deep', scope: 'global', title: '一起等雨停', reference: '那次陪伴是珍贵的经历', experience: '一起等雨停。', feltThen: '当时很安心', meaningNow: '现在仍觉得温暖', cues: ['雨声'], srcRefs: [] };
  const ui = await frontend({ 'memory.list': args => ({ items: args.recordType === 'deep' ? [deep] : [], total: args.recordType === 'deep' ? 1 : 0 }), 'persona.get': () => ({ items: [deep] }) });
  await ui.evaluate("navigate('memory','deep')"); const page = ui.ids.get('page-content');
  assert.ok(page.textContent.includes('是否回忆、怎样理解和修剪，仍由它自己决定'));
  const query = ui.calls.filter(call => call.action === 'memory.list').at(-1); assert.equal(query.args.recordType, 'deep'); assert.equal(query.args.scope, 'all');
  assert.ok(page.textContent.includes('一起等雨停')); assert.ok(page.textContent.includes('深刻记忆 · 共同参考'));
  const detail = ui.evaluate('documentView(' + JSON.stringify(deep) + ')');
  assert.ok(detail.textContent.includes('当时很安心')); assert.ok(detail.textContent.includes('现在仍觉得温暖')); assert.ok(detail.textContent.includes('是否想起、怎样理解与修剪，由它自己决定'));
  assert.equal(ui.calls.some(call => /(?:control\.|operations\.start|memory\.forget|config\.update)/.test(call.action)), false);
});

test('the optional review assistant opens disabled and saving unchanged settings does not start work', async () => {
  const ui = await frontend(); const panel = ui.evaluate("state.page='settings';reviewAssistantSettings({})");
  assert.equal(ui.ids.get('review-assistant-enabled').checked, false); assert.ok(panel.textContent.includes('浏览本页不会调用助手'));
  await ui.button(panel, '保存整理助手设置').emit('click');
  assert.equal(ui.calls.some(call => ['config.update', 'operations.start', 'control.consolidate'].includes(call.action)), false);
});

test('enabling a review assistant saves only its explicit config and does not invoke a model', async () => {
  const ui = await frontend({ 'config.update': () => ({ saved: true }) }); const panel = ui.evaluate("state.page='settings';reviewAssistantSettings({})"); ui.confirm(true);
  ui.ids.get('review-assistant-enabled').checked = true; await ui.button(panel, '保存整理助手设置').emit('click');
  const saved = ui.calls.filter(call => call.action === 'config.update'); assert.equal(saved.length, 1); assert.deepEqual(saved[0].args, { instanceId: 'default', config: { reviewAssistant: { enabled: true } } });
  assert.equal(ui.calls.some(call => ['operations.start', 'control.consolidate'].includes(call.action)), false);
});

test('review assistant settings reject an oversized processing budget before any save', async () => {
  const ui = await frontend(); const panel = ui.evaluate("state.page='settings';reviewAssistantSettings({})"); ui.confirm(true);
  ui.ids.get('review-assistant-output').value = '8193'; await ui.button(panel, '保存整理助手设置').emit('click');
  assert.equal(ui.calls.some(call => call.action === 'config.update'), false); assert.ok(ui.ids.get('global-error').textContent.includes('有效的助手输出'));
});

const socialFixture = { identityId: 'social-' + 'd'.repeat(32), platform: 'bilibili', accountId: 'uid-123', displayName: '相续的小站', accountType: 'creator', profileUrl: null, avatarUrl: null, notes: '', bindingSource: 'manual', connection: { adapterAvailable: false, currentAccount: false, connected: false, verification: 'unverified', status: 'unsupported' }, capabilities: [] };
const socialView = items => ({ items, total: items.length, nextOffset: null, complete: true, limits: { perInstance: 32, registryBytes: 262144 }, platforms: [{ id: 'bilibili', label: 'B站', adapterAvailable: false }] });

test('registering an external social identity does not invent a connection, grant, login or credentials', async () => {
  let registered = false;
  const ui = await frontend({ 'social.inspect': () => socialView(registered ? [socialFixture] : []), 'social.upsert': () => { registered = true; return { item: socialFixture, changed: true }; } });
  const page = await ui.evaluate("state.page='chat';socialIdentitiesPanel()"); ui.confirm(true);
  ui.ids.get('social-platform').value = 'bilibili'; await ui.ids.get('social-platform').emit('change'); ui.ids.get('social-account-id').value = 'uid-123'; ui.ids.get('social-display-name').value = '相续的小站';
  await ui.button(page, '保存账号档案').emit('click');
  const call = ui.calls.find(value => value.action === 'social.upsert'); assert.equal(call.args.instanceId, 'default'); assert.equal(call.args.platform, 'bilibili'); assert.equal(call.args.accountId, 'uid-123'); assert.equal(call.args.accountType, 'creator');
  assert.equal(Object.hasOwn(call.args, 'verified'), false); assert.equal(Object.hasOwn(call.args, 'capabilities'), false); assert.equal(Object.hasOwn(call.args, 'memoryRoot'), false);
  assert.ok(page.textContent.includes('仅登记／尚无适配器')); assert.ok(page.textContent.includes('登记本身不会授予能力'));
  assert.equal(ui.calls.some(value => ['connections.start', 'channels.start', 'permissions.configure', 'media.generate'].includes(value.action)), false);
});

test('linking a current social account uses only the platform so its real identity is resolved by the backend', async () => {
  const ui = await frontend({ 'social.linkCurrent': () => ({ changed: true }) }); const page = await ui.evaluate("state.page='chat';socialIdentitiesPanel({connections:[{id:'qq',connected:true}]})"); ui.confirm(true);
  await ui.button(page, '从当前QQ连接登记').emit('click');
  const call = ui.calls.find(value => value.action === 'social.linkCurrent'); assert.deepEqual(call.args, { instanceId: 'default', platform: 'qq' });
  assert.equal(ui.calls.some(value => ['connections.start', 'channels.start', 'permissions.configure'].includes(value.action)), false);
});

test('a delayed social identity directory cannot expose an old personality account in a new instance', async () => {
  let release, announce; const started = new Promise(resolve => { announce = resolve; });
  const ui = await frontend({ 'social.inspect': () => { announce(); return new Promise(resolve => { release = resolve; }); } });
  const pending = ui.evaluate("state.page='chat';socialIdentitiesPanel()"); await started; ui.evaluate("state.instanceId='new-personality';state.generation++");
  release(socialView([{ ...socialFixture, displayName: 'OLD_PRIVATE_SOCIAL_IDENTITY' }])); const page = await pending;
  assert.equal(page.textContent.includes('OLD_PRIVATE_SOCIAL_IDENTITY'), false);
});

test('a social registration response cannot refresh or paint a different personality', async () => {
  let release, announce; const started = new Promise(resolve => { announce = resolve; });
  const ui = await frontend({ 'social.upsert': () => { announce(); return new Promise(resolve => { release = resolve; }); } }); const page = await ui.evaluate("state.page='chat';socialIdentitiesPanel()");
  ui.ids.get('social-platform').value = 'bilibili'; ui.ids.get('social-account-id').value = 'uid-123';
  const pending = ui.button(page, '保存账号档案').emit('click'); await started;
  assert.equal(ui.ids.get('confirm-dialog').open, false);
  const reads = ui.calls.filter(value => value.action === 'social.inspect').length;
  ui.evaluate("state.instanceId='new-personality';state.generation++"); ui.ids.get('page-content').textContent = 'NEW_PERSONALITY_PAGE';
  release({ changed: true, item: socialFixture }); await pending;
  const writes = ui.calls.filter(value => value.action === 'social.upsert'); assert.equal(writes.length, 1); assert.equal(writes[0].args.instanceId, 'default');
  assert.equal(ui.calls.filter(value => value.action === 'social.inspect').length, reads);
  assert.equal(ui.ids.get('page-content').textContent, 'NEW_PERSONALITY_PAGE');
  assert.equal(ui.ids.get('toast').hidden, true);
});

test('social account pagination follows the returned offset and refresh never rebinds the account', async () => {
  const ui = await frontend({ 'social.inspect': () => ({ ...socialView([socialFixture]), total: 2, nextOffset: 1, complete: false }), 'social.list': args => ({ ...socialView([{ ...socialFixture, accountId: 'uid-456', identityId: 'social-' + 'e'.repeat(32) }]), offset: args.offset }), 'social.refresh': () => socialView([socialFixture]) });
  const page = await ui.evaluate("state.page='chat';socialIdentitiesPanel()");
  await ui.button(page, '下一页账号').emit('click'); assert.equal(ui.calls.find(value => value.action === 'social.list').args.offset, 1);
  await ui.button(page, '刷新账号实际状态').emit('click'); assert.equal(ui.calls.find(value => value.action === 'social.refresh').args.offset, 1);
  assert.equal(ui.calls.some(value => ['social.upsert', 'social.linkCurrent', 'connections.start', 'permissions.configure'].includes(value.action)), false);
});

test('removing a social identity only removes its exact registration without logging out or deleting memories', async () => {
  let removed = false;
  const ui = await frontend({ 'social.inspect': () => socialView(removed ? [] : [socialFixture]), 'social.remove': () => { removed = true; return { removed: true }; } }); const page = await ui.evaluate("state.page='chat';socialIdentitiesPanel()"); ui.confirm(true);
  await ui.button(page, '解除这条身份登记').emit('click'); const call = ui.calls.find(value => value.action === 'social.remove'); assert.deepEqual(call.args, { instanceId: 'default', identityId: socialFixture.identityId });
  assert.equal(ui.calls.some(value => ['connections.disconnect', 'channels.stop', 'memory.forget', 'permissions.configure'].includes(value.action)), false);
});

test('social delivery policy is shown as a platform fact without changing the personality proactive choice', async () => {
  const item = { ...socialFixture, platform: 'qq', connection: { adapterAvailable: true, currentAccount: true, connected: true, verification: 'verified', deliveryPolicy: { proactive: false, passiveReplyRequired: true, reason: '当前驱动只支持有效上下文内的被动回复，不支持主动推送' } }, capabilities: [{ id: 'chat.text', supported: true, allowed: true, available: true }] };
  const ui = await frontend({ 'social.inspect': () => socialView([item]) }); const page = await ui.evaluate("state.page='chat';socialIdentitiesPanel()");
  assert.ok(page.textContent.includes('不支持主动推送')); assert.ok(page.textContent.includes('当前连接已核验'));
  assert.equal(ui.calls.some(value => ['control.mute', 'control.resume', 'config.update'].includes(value.action)), false);
});

test('a deep memory sourced from human dialogue is labelled as personality memory rather than a human quote', async () => {
  const ui = await frontend();
  const memory = { id: 'deep-source-role', recordType: 'deep', scope: 'global', title: '共同经历', reference: '我珍惜这段陪伴', srcRefs: [{ sourceSessionId: 'source-session', sourceEventId: 'source-event', sourceRole: 'user' }] };
  const row = ui.evaluate('memoryRecord(' + JSON.stringify(memory) + ',()=>{})');
  assert.ok(row.textContent.includes('人格记忆')); assert.equal(row.textContent.includes('用户原话'), false);
  const detail = ui.evaluate('documentView(' + JSON.stringify(memory) + ')');
  assert.equal(ui.walk(detail).filter(ui.visible).some(node => node.textContent === '用户原话'), false);
  assert.ok(detail.textContent.includes('人格的记忆与理解')); assert.ok(detail.textContent.includes('user'));
});
