import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

// Exercise the actual management frontend against an isolated DOM and owner RPC.
// These tests inspect effects; they do not contact providers or real accounts.
const source = await readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
async function frontend(overrides = {}) {
  const ids = new Map(), calls = [], timers = new Map(); let nextTimer = 0, autoConfirm = false;
  class Element {
    constructor(tag = 'div', text = '') { this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.events = new Map(); this._text = text; this.value = ''; this.type = ''; this.name = ''; this.disabled = false; this.checked = false; this.selected = false; this.hidden = false; this.open = false; this.returnValue = ''; this.className = ''; this.style = {}; this.readOnly = false; this.src = ''; this.files = []; this.isConnected = true; this.classList = { add() {}, remove() {}, toggle() {} }; }
    set id(value) { this._id = value; ids.set(value, this); } get id() { return this._id ?? ''; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...children) { for (const child of children) { const node = child instanceof Element ? child : new Element('#text', String(child)); this.children.push(node); node.parentNode = this; if (this.tagName === 'select' && node.tagName === 'option' && (node.selected || this.children.length === 1)) this.value = node.value; } }
    replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
    setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'id') this.id = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(name, action, options) { const list = this.events.get(name) ?? []; list.push({ action, once: options?.once }); this.events.set(name, list); }
    async emit(name, extra = {}) { if (name === 'click' && this.disabled) return; const list = [...this.events.get(name) ?? []]; for (const entry of list) { if (entry.once) this.events.set(name, (this.events.get(name) ?? []).filter(value => value !== entry)); await entry.action({ currentTarget: this, target: this, preventDefault() {}, ...extra }); } }
    querySelectorAll(selector) { return walk(this).filter(node => selector === 'button' ? node.tagName === 'button' : selector === '[data-page]' ? node.dataset.page : false); }
    showModal() { this.open = true; if (this.id === 'confirm-dialog' && autoConfirm) queueMicrotask(() => this.close('confirm')); }
    close(value = '') { this.open = false; this.returnValue = value; void this.emit('close'); }
    focus() {} select() {}
  }
  function walk(node) { return [node, ...node.children.flatMap(walk)]; }
  const body = new Element('body');
  for (const match of html.matchAll(/id="([^"]+)"/g)) { const node = new Element(); node.id = match[1]; body.append(node); }
  const nav = [...html.matchAll(/<button[^>]*data-page="([^"]+)"[^>]*>([^<]*)/g)].map(match => { const node = new Element('button', match[2]); node.dataset.page = match[1]; body.append(node); return node; });
  const document = { body, createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text), getElementById: id => ids.get(id), querySelectorAll: selector => selector === '[data-page]' ? nav : body.querySelectorAll(selector) };
  const channels = ['qq', 'wechat'].map(id => ({ id, configured: false, enabled: false, connected: false, config: { allowedPrivateIds: [], allowedGroupIds: [] }, capabilities: {} }));
  const mediaView = { identity: { version: 0, description: '', primaryAssetId: null, locked: false }, limits: { imageBytes: 8388608, descriptionChars: 2048, assetBytes: 268435456 }, providers: [{ kind: 'image', enabled: false, type: 'openai-images', hasApiKey: true, capabilities: {} }, { kind: 'video', enabled: false, type: 'comfyui', capabilities: {} }], usage: { assetBytes: 0 }, jobs: [] };
  const response = async (action, args) => {
    if (overrides[action]) return overrides[action](args, { channels, mediaView, calls });
    if (action === 'instances.list') return { items: [{ id: 'default', name: '隔离测试人格', active: true, loaded: true }], activeInstanceId: 'default', selectedInstanceId: 'default' };
    if (action === 'status') return { available: true, runtime: { sleep: { state: 'awake' }, globalMuted: false }, capacity: {}, agents: [] };
    if (action === 'people.list') return { items: [] };
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
  return { calls, timers, ids, mediaView, context, document, evaluate: code => vm.runInContext(code, context), walk,
    button: (node, label) => { const found = walk(node).find(item => item.tagName === 'button' && item.textContent === label); assert.ok(found, 'button ' + label); return found; },
    confirm: value => { autoConfirm = value; } };
}

test('opening channel settings reads status without starting authorization or enabling accounts', async () => {
  const ui = await frontend(); await ui.evaluate("state.page='chat';chatPage()");
  assert.equal(ui.calls.filter(call => ['connections.start', 'connections.poll', 'channels.start'].includes(call.action)).length, 0);
  assert.equal(ui.calls.filter(call => call.action === 'permissions.inspect').length, 2);
});

test('QR flow polls its original flow and releases its timer when leaving the page', async () => {
  const ui = await frontend({ 'connections.start': () => ({ connections: [{ id: 'qq', phase: 'waiting', flowId: 'flow-one', qrDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', expiresAt: Date.now() + 60000 }] }), 'connections.poll': args => ({ connections: [{ id: 'qq', phase: 'waiting', flowId: args.flowId, qrDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }] }) });
  const page = await ui.evaluate("state.page='chat';chatPage()"); await ui.button(page, '连接QQ').emit('click');
  assert.equal(ui.calls.filter(call => call.action === 'connections.start').length, 1); assert.equal(ui.timers.size, 1);
  const [timerId, poll] = [...ui.timers.entries()][0]; ui.timers.delete(timerId); await poll.fn(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.calls.find(call => call.action === 'connections.poll').args.flowId, 'flow-one');
  assert.ok(ui.walk(page).some(node => node.tagName === 'img' && node.attributes.alt === 'QQ官方授权二维码'));
  await ui.evaluate("navigate('settings')"); assert.equal(ui.timers.size, 0);
});

test('authorized WeChat private scope is explicit and does not grant unsupported groups', async () => {
  const ui = await frontend({ 'connections.status': () => ({ connections: [{ id: 'qq', phase: 'idle' }, { id: 'wechat', phase: 'authorized', accountId: 'bot-one', pairedUserId: 'owner-one', chatTypes: ['private'] }] }) });
  const page = await ui.evaluate("state.page='chat';chatPage()");
  const groupLabel = ui.walk(page).find(node => node.tagName === 'label' && node.textContent.includes('群聊：当前官方连接器未提供'));
  assert.ok(groupLabel.children[0].disabled);
  await ui.button(page, '完成连接并启用').emit('click');
  const configure = ui.calls.find(call => call.action === 'channels.configure');
  assert.deepEqual(configure.args.config.allowedPrivateIds, ['owner-one']); assert.deepEqual(configure.args.config.allowedGroupIds, []);
  assert.equal(ui.calls.filter(call => call.action === 'channels.start').length, 1);
});

test('permissions distinguish unsupported capabilities and save only selected real permissions', async () => {
  const ui = await frontend(), panel = await ui.evaluate("permissionsPanel('qq')");
  const unsupported = ui.walk(panel).find(node => node.attributes['aria-label'] === '允许发布朋友圈'); assert.equal(unsupported.disabled, true); assert.equal(unsupported.checked, false);
  const image = ui.walk(panel).find(node => node.attributes['aria-label'] === '允许发送图片'); image.checked = true;
  await ui.button(panel, '保存这些权限').emit('click');
  assert.deepEqual(ui.calls.find(call => call.action === 'permissions.configure').args.allowed, ['chat.text', 'chat.image']);
});

test('opening identity settings never submits generation or probe and never fills stored API secrets', async () => {
  const ui = await frontend(); const page = await ui.evaluate("state.page='media';mediaPage()");
  assert.equal(ui.calls.some(call => ['media.generate', 'media.probeProvider', 'media.uploadBegin'].includes(call.action)), false);
  assert.equal(ui.ids.get('media-image-key').value, ''); assert.equal(ui.ids.get('media-video-key').value, '');
  assert.equal(ui.button(page, '开始这次创作').disabled, true);
});

test('reference upload uses sequential bounded owner chunks then one finish operation', async () => {
  const ui = await frontend({ 'media.uploadBegin': () => ({ uploadId: 'upload-one' }), 'media.uploadChunk': () => ({ accepted: true }), 'media.uploadFinish': () => ({ assetId: 'asset-one' }) });
  const page = await ui.evaluate("state.page='media';mediaPage()");
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
  const page = await ui.evaluate("state.page='media';mediaPage()"); ui.confirm(true); ui.ids.get('media-create-prompt').value = '沿用当前角色，在窗边喝茶';
  await ui.button(page, '开始这次创作').emit('click');
  assert.equal(ui.calls.filter(call => call.action === 'media.generate').length, 1); assert.ok(ui.calls.find(call => call.action === 'media.generate').args.requestId.startsWith('media_ui_'));
  await ui.button(ui.ids.get('detail-footer'), '查询原任务').emit('click');
  assert.equal(ui.calls.filter(call => call.action === 'media.generate').length, 1); assert.ok(ui.calls.filter(call => call.action === 'media.getJob').every(call => call.args.jobId === 'job-one'));
});

test('an unsupported identity reference is not retried as unreferenced text generation', async () => {
  const ui = await frontend({ 'media.getAsset': () => ({ assetId: 'main-reference', kind: 'image', name: '主参考', mime: 'image/png', bytes: 24 }), 'media.generate': () => { throw Object.assign(new Error('服务未支持参考图'), { code: 'REFERENCE_UNSUPPORTED' }); } });
  Object.assign(ui.mediaView.providers[0], { enabled: true, configured: true, capabilities: { generate: true } });
  ui.mediaView.identity.primaryAssetId = 'main-reference';
  const page = await ui.evaluate("state.page='media';mediaPage()"); ui.confirm(true); ui.ids.get('media-create-prompt').value = '同一个形象';
  await ui.button(page, '开始这次创作').emit('click');
  const submissions = ui.calls.filter(call => call.action === 'media.generate'); assert.equal(submissions.length, 1); assert.equal(submissions[0].args.useIdentityReference, true);
});

test('switching instances during a reference upload cancels only the original instance upload', async () => {
  let ui;
  ui = await frontend({ 'media.uploadBegin': () => ({ uploadId: 'upload-old-instance' }), 'media.uploadChunk': () => { ui.evaluate("state.instanceId='other-instance';state.generation++"); return { accepted: true }; }, 'media.uploadCancel': () => ({ cancelled: true }) });
  const page = await ui.evaluate("state.page='media';mediaPage()");
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
  const page = await ui.evaluate("state.page='media';mediaPage()"); ui.confirm(true); ui.ids.get('media-create-prompt').value = '窗边的同一个角色';
  await ui.button(page, '开始这次创作').emit('click');
  const queries = ui.calls.filter(call => call.action === 'media.getJob').length;
  ui.ids.get('detail-dialog').close();
  const [timerId, timer] = [...ui.timers.entries()][0]; ui.timers.delete(timerId); await timer.fn(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.calls.filter(call => call.action === 'media.getJob').length, queries);
  assert.equal(ui.calls.filter(call => call.action === 'media.generate').length, 1);
});

test('ComfyUI reference configuration carries its explicit input binding and keeps optional bindings strings', async () => {
  const ui = await frontend({ 'media.configureProvider': () => ({ saved: true }) });
  const page = await ui.evaluate("state.page='media';mediaPage()");
  ui.ids.get('media-video-url').value = 'http://127.0.0.1:8188';
  ui.ids.get('media-video-workflow').value = JSON.stringify({ 1: { inputs: { text: 'prompt' } }, 3: { inputs: { image: 'reference.png' } } });
  ui.ids.get('media-video-prompt-node').value = '1'; ui.ids.get('media-video-reference-node').value = '3'; ui.ids.get('media-video-reference').value = 'edit';
  await ui.button(page, '保存视频服务').emit('click');
  const saved = ui.calls.find(call => call.action === 'media.configureProvider'); assert.ok(saved);
  assert.equal(saved.args.config.referenceMode, 'edit'); assert.equal(saved.args.config.referenceNode, '3'); assert.equal(saved.args.config.promptNode, '1');
  assert.equal(ui.calls.some(call => call.action === 'media.generate'), false);
});

test('saving an Images provider keeps a blank stored secret untouched and uses the selected edit transport', async () => {
  const ui = await frontend({ 'media.configureProvider': () => ({ saved: true }) });
  const page = await ui.evaluate("state.page='media';mediaPage()");
  ui.ids.get('media-image-url').value = 'https://provider.example/v1'; ui.ids.get('media-image-model').value = 'provider-image';
  ui.ids.get('media-image-reference').value = 'edit'; ui.ids.get('media-image-edit-transport').value = 'multipart';
  ui.ids.get('media-image-download-origins').value = 'https://cdn.provider.example';
  await ui.button(page, '保存图片服务').emit('click');
  const saved = ui.calls.find(call => call.action === 'media.configureProvider'); assert.ok(saved);
  assert.equal(saved.args.config.editTransport, 'multipart'); assert.equal(saved.args.config.referenceMode, 'edit'); assert.equal(Object.hasOwn(saved.args.config, 'apiKey'), false);
  assert.deepEqual(saved.args.config.downloadOrigins, ['https://cdn.provider.example']);
});

test('resetting an old saved account permission is explicit and carries only that account identity', async () => {
  const ui = await frontend({ 'permissions.list': () => ({ items: [{ accountId: 'old-bot', allowed: ['chat.text', 'chat.image'], updatedAt: 1770000000000 }] }), 'permissions.reset': () => ({ reset: true }) });
  const panel = await ui.evaluate("permissionsPanel('qq')"); ui.confirm(true);
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
  const page = await ui.evaluate("state.page='memory';memoryPage()");
  assert.ok(page.textContent.includes('它是参考，不是自动触发器'));
  await ui.button(page, '查看深刻记忆条目').emit('click');
  const query = ui.calls.filter(call => call.action === 'memory.list').at(-1); assert.equal(query.args.recordType, 'deep'); assert.equal(query.args.scope, 'all');
  assert.ok(page.textContent.includes('一起等雨停')); assert.ok(page.textContent.includes('深刻记忆 · 共同参考'));
  const detail = ui.evaluate('documentView(' + JSON.stringify(deep) + ')');
  assert.ok(detail.textContent.includes('当时很安心')); assert.ok(detail.textContent.includes('现在仍觉得温暖')); assert.ok(detail.textContent.includes('不表示本轮已经回忆或产生反应'));
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

test('social registration is abandoned when the personality changes while confirmation is open', async () => {
  const ui = await frontend({ 'social.upsert': () => { throw Error('must not save'); } }); const page = await ui.evaluate("state.page='chat';socialIdentitiesPanel()");
  ui.ids.get('social-platform').value = 'bilibili'; ui.ids.get('social-account-id').value = 'uid-123';
  const pending = ui.button(page, '保存账号档案').emit('click'); await new Promise(resolve => setImmediate(resolve)); assert.equal(ui.ids.get('confirm-dialog').open, true);
  ui.evaluate("state.instanceId='new-personality';state.generation++"); ui.ids.get('confirm-dialog').close('confirm'); await pending;
  assert.equal(ui.calls.some(value => value.action === 'social.upsert'), false);
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
  assert.ok(detail.textContent.includes('人格记忆（非对话原件）')); assert.ok(detail.textContent.includes('user'));
});
