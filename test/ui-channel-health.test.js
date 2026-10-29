import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

// Run the shipped frontend and its asynchronous overview reads with isolated DOM/RPC.
// No QQ bridge, model, timers or production personality data are accessed.
async function frontend({ channel, managed, runtime, channelsRead, managedRead } = {}) {
  const ids = new Map(), calls = [], timers = new Map();
  class Element {
    constructor(tag = 'div', text = '') {
      this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.events = new Map();
      this._text = text; this.className = ''; this.style = {}; this.isConnected = true;
      this.classList = { add: value => this.classList.toggle(value, true), remove: value => this.classList.toggle(value, false),
        toggle: (value, force) => { const names = new Set(this.className.split(/\s+/).filter(Boolean)); if (force ?? !names.has(value)) names.add(value); else names.delete(value); this.className = [...names].join(' '); }, contains: value => this.className.split(/\s+/).includes(value) };
    }
    set id(value) { this._id = value; ids.set(value, this); } get id() { return this._id ?? ''; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...children) { for (const child of children) { const node = child instanceof Element ? child : new Element('#text', String(child)); node.parentNode = this; this.children.push(node); } }
    replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
    setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'id') this.id = value; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(name, action) { const list = this.events.get(name) ?? []; list.push(action); this.events.set(name, list); }
    async emit(name) { for (const action of this.events.get(name) ?? []) await action({ currentTarget: this, target: this, preventDefault() {} }); }
    querySelectorAll() { return []; } close() { this.open = false; }
  }
  const document = { createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text),
    getElementById: id => { if (!ids.has(id)) { const node = new Element(); node.id = id; } return ids.get(id); }, querySelectorAll: () => [], querySelector: () => null };
  const context = vm.createContext({ document, Node: Element, window: { addEventListener() {}, personaBridge: { request: async (action, args) => {
    calls.push({ action, args: structuredClone(args) });
    if (action === 'instances.list') return { items: [{ id: 'default', name: '测试人格', active: true, loaded: true }], selectedInstanceId: 'default' };
    if (action === 'status') return { available: true, runtime: runtime ?? { sleep: { state: 'awake' }, globalMuted: false }, capacity: {}, agents: [], selfProfile: { mode: 'unset', version: 0, onboardingAcknowledged: false } };
    if (action === 'people.list') return { items: [] };
    if (action === 'channels.status') return channelsRead ? channelsRead(args) : { connections: [channel ?? { id: 'qq', configured: false }] };
    if (action === 'qqBridgeSetup.inspect') return managedRead ? managedRead(args) : structuredClone(managed);
    throw new Error('Unexpected RPC: ' + action);
  } } }, setTimeout: (fn, delay) => { const id = timers.size + 1; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(source, context); await settle();
  const evaluate = code => vm.runInContext(code, context), page = () => ids.get('page-content'), walk = node => [node, ...node.children.flatMap(walk)];
  return { calls, timers, ids, evaluate, page, text: () => page().textContent, walk, button: label => walk(page()).find(node => node.tagName === 'button' && node.textContent === label) };
}

const configured = { id: 'qq', mode: 'bridge', configured: true, enabled: true, connected: true, config: { accountId: '10001' } };
const snapshot = (phase, patch = {}) => ({ instanceId: 'default', phase, management: { status: 'ready', lastVerifiedAt: 1000 }, lastVerifiedQQ: { at: 1000, online: false, accountId: '10001' }, ...patch });
const managerReads = ui => ui.calls.filter(call => call.action.startsWith('qqBridgeSetup.'));

test('overview prioritizes a managed waiting-login snapshot over a cached connected channel', async () => {
  const ui = await frontend({ channel: configured, managed: snapshot('waiting_login') });
  assert.match(ui.text(), /当前状态：清醒/);
  assert.match(ui.text(), /已连接的渠道可以接收来信；是否回应由相续决定/);
  assert.match(ui.text(), /QQ 连接：等待登录/);
  assert.match(ui.text(), /暂不能通过 QQ 收发消息/);
  assert.match(ui.text(), /上次核查：/);
  assert.ok(ui.text().indexOf('QQ 连接：等待登录') < ui.text().indexOf('当前状态：清醒'));
  assert.ok(ui.text().indexOf('先认识一下，也可以直接聊天') >= 0);
  assert.ok(ui.text().indexOf('QQ 连接：等待登录') < ui.text().indexOf('先认识一下，也可以直接聊天'));
  assert.doesNotMatch(ui.text(), /QQ 连接：上次核查已连接/);
  assert.deepEqual(managerReads(ui), [{ action: 'qqBridgeSetup.inspect', args: { instanceId: 'default' } }]);
  assert.equal(ui.timers.size, 0);
  ui.evaluate("navigate = async (page, view) => { window.lastNavigation = { page, view }; }");
  await ui.button('检查 QQ 连接').emit('click');
  assert.deepEqual(structuredClone(ui.evaluate('window.lastNavigation')), { page: 'chat', view: 'qq' });
  assert.equal(ui.calls.some(call => /poll|start|connect$|probe|model|control\./.test(call.action)), false);
});

test('overview reports unknown management and failed preparation without mistaking personality state for connectivity', async () => {
  for (const [managed, expected] of [
    [snapshot('waiting_login', { management: { status: 'unknown' } }), /QQ 连接：登录状态尚未核实/],
    [snapshot('failed'), /QQ 连接：准备未完成/],
    [snapshot('connected', { lastVerifiedQQ: null }), /QQ 连接：当前在线尚未确认/],
  ]) {
    const ui = await frontend({ channel: configured, managed, runtime: { sleep: { state: 'sleeping' }, globalMuted: true } });
    assert.match(ui.text(), /当前状态：休息中/); assert.match(ui.text(), expected);
    assert.doesNotMatch(ui.text(), /QQ 连接：上次核查已连接/); assert.ok(ui.button('检查 QQ 连接'));
    assert.equal(ui.timers.size, 0); assert.equal(managerReads(ui).length, 1);
  }
});

test('overview leaves an unconfigured QQ quiet and never reads or starts its managed bridge', async () => {
  const ui = await frontend({ managedRead: () => { throw new Error('An unconfigured bridge must not be read'); } });
  assert.match(ui.text(), /允许主动找我聊天/); assert.doesNotMatch(ui.text(), /QQ 连接：|扫码|尚未安装|尚未准备/);
  assert.equal(managerReads(ui).length, 0); assert.equal(ui.button('检查 QQ 连接'), undefined); assert.equal(ui.timers.size, 0);
});

test('overview connection reads cannot delay daily controls and rejected reads stay local', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const ui = await frontend({ channelsRead: () => pending });
  assert.match(ui.text(), /允许主动找我聊天/); assert.doesNotMatch(ui.text(), /暂时无法读取/);
  release({ connections: [{ ...configured, connected: false }] }); await settle();
  assert.match(ui.text(), /QQ 连接：当前在线尚未确认/);
  const failed = await frontend({ channel: configured, managedRead: () => { throw new Error('fixture unavailable'); } });
  assert.match(failed.text(), /QQ 连接：状态尚未核实/); assert.match(failed.text(), /允许主动找我聊天/);
  assert.doesNotMatch(failed.text(), /暂时无法读取|fixture unavailable/); assert.equal(failed.timers.size, 0);
});

test('overview only labels positive snapshots as previous verification, never as a fresh live probe', async () => {
  const ui = await frontend({ channel: configured, managed: snapshot('connected', { lastVerifiedQQ: { at: 1000, online: true, accountId: '10001' } }) });
  assert.match(ui.text(), /QQ 连接：上次核查已连接/); assert.match(ui.text(), /这是已有连接快照/); assert.match(ui.text(), /上次核查：/);
  assert.equal(ui.calls.some(call => call.action === 'channels.probe' || call.action === 'qqBridgeSetup.poll'), false);
  const wrongAccount = await frontend({ channel: configured, managed: snapshot('connected', { lastVerifiedQQ: { at: 1000, online: true, accountId: '10002' } }) });
  assert.match(wrongAccount.text(), /QQ 连接：当前在线尚未确认/);
});

test('late overview snapshots and expired buttons cannot affect a different personality', async () => {
  let release;
  const ui = await frontend({ channel: configured, managedRead: () => new Promise(resolve => { release = resolve; }) });
  assert.match(ui.text(), /允许主动找我聊天/);
  ui.evaluate("state.instanceId = 'other'; state.generation++; document.getElementById('page-content').textContent = '另一人格页面';");
  release(snapshot('waiting_login')); await settle();
  assert.equal(ui.text(), '另一人格页面'); assert.equal(ui.button('检查 QQ 连接'), undefined);
  const current = await frontend({ channel: configured, managed: snapshot('waiting_login') });
  const oldButton = current.button('检查 QQ 连接');
  current.evaluate("state.instanceId = 'other'; navigate = async () => { throw new Error('Expired navigation must not run'); }");
  const before = current.calls.length; await oldButton.emit('click'); assert.equal(current.calls.length, before);
});

test('a managed snapshot for another personality is not displayed as this personality online or QR state', async () => {
  const ui = await frontend({ channel: configured, managed: snapshot('waiting_login', { instanceId: 'other', loginAccount: { accountId: 'private-other-account' } }) });
  assert.match(ui.text(), /QQ 连接：当前人格尚未核实/); assert.doesNotMatch(ui.text(), /等待登录|private-other-account|上次核查已连接/);
  assert.equal(ui.timers.size, 0);
});
