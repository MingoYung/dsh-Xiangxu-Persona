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
  const ids = new Map(), calls = [], timers = new Map(), scrollEvents = [], focusEvents = [], documentEvents = new Map(); let nextTimer = 0, autoConfirm = false, now = Date.now();
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  class Element {
    constructor(tag = 'div', text = '') { this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.events = new Map(); this._text = text; this.value = ''; this.type = ''; this.name = ''; this.disabled = false; this.checked = false; this.selected = false; this.hidden = false; this.open = false; this.returnValue = ''; this.className = ''; this.style = {}; this.readOnly = false; this.src = ''; this.files = []; this.isConnected = true; this.classList = { add: value => this.classList.toggle(value, true), remove: value => this.classList.toggle(value, false), contains: value => this.className.split(/\s+/).includes(value), toggle: (value, force) => { const names = new Set(this.className.split(/\s+/).filter(Boolean)), add = force ?? !names.has(value); if (add) names.add(value); else names.delete(value); this.className = [...names].join(' '); return add; } }; }
    set id(value) { this._id = value; ids.set(value, this); } get id() { return this._id ?? ''; }
    set value(value) { this._value = String(value); } get value() { return this._value ?? ''; }
    set hidden(value) { if (value) this.attributes.hidden = ''; else delete this.attributes.hidden; } get hidden() { return Object.hasOwn(this.attributes, 'hidden'); }
    get options() { return this.tagName === 'select' ? this.children.filter(node => node.tagName === 'option') : []; }
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
    focus(options) { focusEvents.push({target:this,options}); } select() {}
    scrollIntoView(options) { scrollEvents.push({target:this,options}); }
    getBoundingClientRect() { return {top:120,left:0,width:200,height:40}; }
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
  const document = { body, hidden: false, visibilityState: 'visible', addEventListener(name, handler) { const handlers = documentEvents.get(name) ?? new Set(); handlers.add(handler); documentEvents.set(name, handlers); }, removeEventListener(name, handler) { documentEvents.get(name)?.delete(handler); }, createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text), getElementById: id => ids.get(id), querySelectorAll: selector => body.querySelectorAll(selector), querySelector: selector => body.querySelector(selector) };
  const channels = ['qq', 'wechat'].map(id => ({ id, configured: false, enabled: false, connected: false, config: { allowedPrivateIds: [], allowedGroupIds: [] }, capabilities: {} }));
  const mediaView = { identity: { version: 0, description: '', primaryAssetId: null, locked: false }, limits: { imageBytes: 8388608, descriptionChars: 2048, assetBytes: 268435456 }, providers: [{ kind: 'image', enabled: false, type: 'openai-images', hasApiKey: true, capabilities: {} }, { kind: 'video', enabled: false, type: 'comfyui', capabilities: {} }], usage: { assetBytes: 0 }, jobs: [] };
  const response = async (action, args) => {
    if (overrides[action]) return overrides[action](args, { channels, mediaView, calls });
    if (action === 'ui.reveal') return { revealed: true };
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
  const context = vm.createContext({ document, Node: Element, window: { scrollY: 30, personaBridge: { request: async (action, args) => { calls.push({ action, args: structuredClone(args) }); return response(action, args); } }, addEventListener() {} }, navigator: { clipboard: { writeText: async () => {} } }, crypto: webcrypto,
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id), Date: ClockDate, queueMicrotask, Uint8Array, TextEncoder, btoa: value => Buffer.from(value, 'binary').toString('base64') });
  vm.runInContext(source, context); await new Promise(resolve => setImmediate(resolve));
  return { calls, timers, ids, scrollEvents, focusEvents, mediaView, context, document, evaluate: code => vm.runInContext(code, context), walk, visible,
    button: (node, label) => { const found = walk(node).find(item => item.tagName === 'button' && item.textContent === label); assert.ok(found, 'button ' + label); return found; },
    advance: ms => { now += ms; }, setHidden: async hidden => { document.hidden = hidden; document.visibilityState = hidden ? 'hidden' : 'visible'; for (const handler of [...documentEvents.get('visibilitychange') ?? []]) await handler(); await new Promise(resolve => setImmediate(resolve)); }, documentEvents,
    confirm: value => { autoConfirm = value; } };
}
const tick=()=>new Promise(resolve=>setImmediate(resolve)),body=ui=>ui.ids.get('page-content');
const qqAccountView={accountId:'10001',liveAccountId:'10001',ready:true,knownAccounts:[{accountId:'10001'},{accountId:'10002'}],receipts:{retained:2,unresolved:1}};
const qqReceipt={receiptId:'receipt-fixture-one',accountId:'10001',userId:'20001',status:'unknown',createdAt:1000,updatedAt:1000};
test('QQ account records page uses real cursors, bounded full reads and no request-execution button',async()=>{
 const ui=await frontend({'qqAccount.inspect':()=>qqAccountView,'qqAccount.read':args=>args.accountOperation==='receipts'?{items:[{...qqReceipt,receiptId:args.pageCursor?'receipt-fixture-two':qqReceipt.receiptId}],total:2,pageCursor:args.pageCursor?null:'next-record-page'}:args.accountOperation==='receipt'?{text:args.offset?'后半段':'<完整资料>',offset:args.offset,nextOffset:args.offset?null:6,totalChars:9,complete:args.offset>0,sha256:'a'.repeat(64)}:{status:'unknown'}});
 await ui.evaluate("navigate('chat','qq-account')");assert.match(body(ui).textContent,/第 1 页/);assert.match(body(ui).textContent,/结果未知/);assert.equal(ui.button(body(ui),'上一页').disabled,true);
 await ui.button(body(ui),'下一页').emit('click');assert.match(body(ui).textContent,/第 2 页/);assert.equal(ui.button(body(ui),'下一页').disabled,true);
 await ui.button(body(ui),'上一页').emit('click');assert.match(body(ui).textContent,/第 1 页/);
 await ui.button(body(ui),'查看完整资料').emit('click');assert.match(body(ui).textContent,/<完整资料>/);await ui.button(body(ui),'继续读取完整资料').emit('click');assert.match(body(ui).textContent,/<完整资料>后半段/);
 const reads=ui.calls.filter(c=>c.action==='qqAccount.read');assert.ok(reads.every(c=>c.args.instanceId==='default'&&c.args.accountId==='10001'));assert.equal(reads.find(c=>c.args.pageCursor)?.args.pageCursor,'next-record-page');assert.equal(reads.find(c=>c.args.accountOperation==='receipt').args.maxChars,4000);
 assert.equal(ui.calls.some(c=>c.action==='qqAccount.execute'),false);assert.equal(ui.timers.size,0);
});
test('QQ account historical selection changes only archive reads and expired controls perform no work',async()=>{
 const ui=await frontend({'qqAccount.inspect':()=>qqAccountView,'qqAccount.read':()=>({items:[],total:0,pageCursor:null})});await ui.evaluate("navigate('chat','qq-account')");const select=ui.ids.get('qq-account-records-account');select.value='10002';await select.emit('change');assert.equal(ui.calls.filter(c=>c.action==='qqAccount.read').at(-1).args.accountId,'10002');
 const old=ui.button(body(ui),'刷新记录'),before=ui.calls.length;ui.evaluate("state.instanceId='other'");await old.emit('click');await select.emit('change');assert.equal(ui.calls.length,before);assert.equal(ui.calls.some(c=>c.action==='qqAccount.execute'||c.action==='channels.configure'),false);
});
test('late QQ account archive pages do not paint a new instance or page',async()=>{
 let entered,release;const started=new Promise(resolve=>entered=resolve),ui=await frontend({'qqAccount.inspect':()=>qqAccountView,'qqAccount.read':()=>{entered();return new Promise(resolve=>release=resolve);}});
 const opening=ui.evaluate("navigate('chat','qq-account')");await started;ui.evaluate("state.instanceId='other'");await ui.evaluate("navigate('memory')");release({items:[qqReceipt],total:1,pageCursor:null});await opening;assert.equal(ui.ids.get('page-title').textContent,'记忆');assert.doesNotMatch(body(ui).textContent,/receipt-fixture-one|20001/);assert.equal(ui.ids.get('global-error').hidden,true);
});
test('QQ account status updates and expired page cursors restart the current archive at its first page',async()=>{
 let revision=0;
 const ui=await frontend({'qqAccount.inspect':()=>qqAccountView,'qqAccount.read':args=>{
  if(args.accountOperation==='friend.status'){revision++;return{status:'submitted'};}
  if(args.pageCursor&&args.pageCursor!=='revision-'+revision)throw Object.assign(Error('cursor changed'),{code:'QQ_ACCOUNT_CURSOR'});
  return{items:[qqReceipt],total:2,pageCursor:args.pageCursor?null:'revision-'+revision};
 }});
 await ui.evaluate("navigate('chat','qq-account')");await ui.button(body(ui),'下一页').emit('click');assert.match(body(ui).textContent,/第 2 页/);await ui.button(body(ui),'核对这次申请的状态').emit('click');assert.match(body(ui).textContent,/第 1 页/);assert.equal(ui.ids.get('global-error').hidden,true);
 revision++;await ui.button(body(ui),'下一页').emit('click');assert.match(body(ui).textContent,/第 1 页/);assert.equal(ui.ids.get('global-error').hidden,true);
 await ui.button(body(ui),'下一页').emit('click');assert.match(body(ui).textContent,/第 2 页/);await ui.button(body(ui),'刷新记录').emit('click');assert.match(body(ui).textContent,/第 1 页/);
});
test('QQ account full receipt continuation cannot combine text from different document hashes',async()=>{
 let reads=0;
 const ui=await frontend({'qqAccount.inspect':()=>qqAccountView,'qqAccount.read':args=>{
  if(args.accountOperation==='receipts')return{items:[qqReceipt],total:1,pageCursor:null};
  reads++;const changed=reads>1;return{text:args.offset?'新版本尾部':changed?'新版本开头':'旧版本开头',offset:args.offset,nextOffset:args.offset?null:5,totalChars:10,complete:args.offset>0,sha256:(changed?'b':'a').repeat(64)};
 }});
 await ui.evaluate("navigate('chat','qq-account')");await ui.button(body(ui),'查看完整资料').emit('click');assert.match(body(ui).textContent,/旧版本开头/);await ui.button(body(ui),'继续读取完整资料').emit('click');assert.equal(reads,3);assert.match(body(ui).textContent,/新版本开头/);assert.doesNotMatch(body(ui).textContent,/旧版本开头|新版本尾部/);await ui.button(body(ui),'继续读取完整资料').emit('click');assert.match(body(ui).textContent,/新版本开头新版本尾部/);
});
const BASE={phase:'not_installed',progressMessage:'尚未准备',version:null,hasQr:false,qrDataUrl:null,loginAccount:null,connected:false,error:null,flowId:null};
const authorized={...BASE,phase:'authorized',flowId:'managed-flow',version:'test-1',loginAccount:{accountId:'10001',displayName:'登录测试账号'}};
async function setup(overrides={}){
 let inspected;
 return frontend({'qqBridgeSetup.start':args=>({...BASE,instanceId:args.instanceId,phase:'installing',flowId:'managed-flow',progressMessage:'校验本地组件',progress:{downloaded:1024,total:4096}}),'qqBridgeSetup.poll':args=>({...((inspected?.flowId)?inspected:authorized),instanceId:args.instanceId}),'qqBridgeSetup.connect':args=>({...authorized,instanceId:args.instanceId,phase:'connected',connected:true}),'qqBridgeSetup.stop':args=>({...BASE,instanceId:args.instanceId,phase:'stopped',version:'test-1'}),...overrides,'qqBridgeSetup.inspect':async args=>{inspected=await(overrides['qqBridgeSetup.inspect']??(args=>({...BASE,instanceId:args.instanceId})))(args);return inspected;}});
}
const managerCalls=ui=>ui.calls.filter(call=>call.action.startsWith('qqBridgeSetup.'));
function destination(ui,label){const found=ui.walk(body(ui)).find(n=>n.tagName==='button'&&n.getAttribute('aria-label')===label);assert.ok(found,label);return found;}
async function chooseCustom(ui){const mode=ui.ids.get('qq-setup-mode');mode.value='custom';await mode.emit('change');}
async function timer(ui){const entries=[...ui.timers.entries()].filter(([,item])=>item.delay===2500);assert.equal(entries.length,1);ui.timers.delete(entries[0][0]);await entries[0][1].fn();await tick();}

test('personal QQ is the default destination and viewing it only inspects local state',async()=>{
 const ui=await setup();await ui.evaluate("navigate('chat')");await destination(ui,'QQ').emit('click');assert.equal(ui.ids.get('page-title').textContent,'连接 QQ');assert.match(body(ui).textContent,/一键准备个人 QQ/);assert.match(body(ui).textContent,/扫码后还需|接入 QQ 账号/);assert.ok(destination(ui,'QQ 官方 Bot'));assert.ok(destination(ui,'使用已有兼容桥'));assert.ok(destination(ui,'能力与权限'));
 assert.deepEqual(managerCalls(ui).map(c=>c.action),['qqBridgeSetup.inspect']);assert.equal(ui.calls.some(c=>['connections.start','channels.configure','channels.start'].includes(c.action)),false);assert.equal(ui.timers.size,0);
});

test('one preparation click starts once then active-phase polling displays only the actual QR',async()=>{
 const waiting={...BASE,phase:'waiting_login',flowId:'managed-flow',hasQr:true,qrDataUrl:'data:image/svg+xml;base64,PHN2Zy8+',version:'test-1'};
 const ui=await setup({'qqBridgeSetup.poll':args=>({...waiting,instanceId:args.instanceId})});await ui.evaluate("navigate('chat','qq')");await ui.button(body(ui),'一键准备个人 QQ').emit('click');assert.equal(managerCalls(ui).filter(c=>c.action.endsWith('.start')).length,1);assert.match(body(ui).textContent,/校验本地组件/);assert.match(body(ui).textContent,/已下载/);await timer(ui);
 assert.ok(ui.walk(body(ui)).some(n=>n.tagName==='img'&&n.src===waiting.qrDataUrl));const polled=managerCalls(ui).find(c=>c.action.endsWith('.poll'));assert.deepEqual(polled.args,{flowId:'managed-flow',instanceId:'default'});assert.equal(managerCalls(ui).some(c=>c.action.endsWith('.connect')),false);assert.equal(ui.walk(body(ui)).some(n=>n.id==='qq-setup-private'),false);
});

test('leaving the preparation page clears its UI polling without stopping the QQ service',async()=>{
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...BASE,phase:'waiting_login',flowId:'managed-flow',instanceId:args.instanceId})});await ui.evaluate("navigate('chat','qq')");assert.equal(ui.timers.size,1);await ui.evaluate("navigate('memory')");assert.equal(ui.timers.size,0);assert.equal(managerCalls(ui).some(c=>c.action.endsWith('.stop')||c.action.endsWith('.connect')),false);
});

test('authorized QQ defaults to autonomous social scope but only connects after the account owner clicks',async()=>{
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...authorized,instanceId:args.instanceId,qrDataUrl:'data:image/svg+xml;base64,PHN2Zy8+'})});await ui.evaluate("navigate('chat','qq')");assert.equal(ui.ids.get('qq-setup-mode').value,'autonomous');assert.match(body(ui).textContent,/由相续自主社交/);assert.equal(ui.walk(body(ui)).some(n=>['qq-setup-private','qq-setup-groups'].includes(n.id)),false);assert.equal(ui.walk(body(ui)).some(n=>n.tagName==='img'),false);assert.equal(ui.timers.size,0);assert.equal(managerCalls(ui).some(c=>c.action.endsWith('.connect')),false);
 await ui.button(body(ui),'接入这个 QQ 账号').emit('click');assert.deepEqual(managerCalls(ui).find(c=>c.action.endsWith('.connect')).args,{flowId:'managed-flow',allowedPrivateIds:['*'],allowedGroupIds:['*'],voiceMode:'text',instanceId:'default'});assert.equal(ui.calls.some(c=>/friend.*accept|approve.*friend/i.test(c.action)),false);
});

test('selected candidates and typed testing IDs are deduplicated and connect only the original instance as text',async()=>{
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...authorized,instanceId:args.instanceId,contacts:[{id:'20001',name:'测试联系人'}],groups:[{id:'30001',name:'测试群'}]})});await ui.evaluate("navigate('chat','qq')");await chooseCustom(ui);const candidates=ui.walk(body(ui)).filter(n=>n.tagName==='input'&&n.type==='checkbox');assert.equal(candidates.length,2);for(const input of candidates){input.checked=true;await input.emit('change');}
 ui.ids.get('qq-setup-private').value='20001\n20002';ui.ids.get('qq-setup-groups').value='30001,30002';await ui.button(body(ui),'接入这个 QQ 账号').emit('click');const call=managerCalls(ui).find(c=>c.action.endsWith('.connect'));assert.deepEqual(call.args,{flowId:'managed-flow',allowedPrivateIds:['20001','20002'],allowedGroupIds:['30001','30002'],voiceMode:'text',instanceId:'default'});assert.match(body(ui).textContent,/已取得当前连接确认/);assert.match(body(ui).textContent,/连接确认不等于已经完成聊天往返/);assert.doesNotMatch(JSON.stringify(call.args),/accessToken|ingressToken|callbackUrl|webui/i);
});

test('manual status refresh preserves scope drafts and checkbox selections for the same logged-in account',async()=>{
 const value={...authorized,contacts:[{id:'20001',name:'测试联系人'}]},ui=await setup({'qqBridgeSetup.inspect':args=>({...value,instanceId:args.instanceId}),'qqBridgeSetup.poll':args=>({...value,instanceId:args.instanceId})});await ui.evaluate("navigate('chat','qq')");await chooseCustom(ui);const input=ui.walk(body(ui)).find(n=>n.tagName==='input'&&n.type==='checkbox');input.checked=true;await input.emit('change');ui.ids.get('qq-setup-groups').value='30001';await ui.button(body(ui),'刷新准备状态').emit('click');assert.equal(ui.ids.get('qq-setup-mode').value,'custom');assert.equal(ui.ids.get('qq-setup-groups').value,'30001');assert.equal(ui.walk(body(ui)).find(n=>n.tagName==='input'&&n.type==='checkbox').checked,true);assert.equal(managerCalls(ui).some(c=>c.action.endsWith('.connect')),false);
});

test('expired page start and scope controls cannot issue a write on another selected instance',async()=>{
 const ui=await setup();await ui.evaluate("navigate('chat','qq')");const old=ui.button(body(ui),'一键准备个人 QQ');ui.evaluate("state.instanceId='other'");await old.emit('click');assert.equal(managerCalls(ui).some(c=>c.action.endsWith('.start')),false);
 const authed=await setup({'qqBridgeSetup.inspect':args=>({...authorized,instanceId:args.instanceId})});await authed.evaluate("navigate('chat','qq')");await chooseCustom(authed);authed.ids.get('qq-setup-private').value='20001';const connect=authed.button(body(authed),'接入这个 QQ 账号');authed.evaluate("state.instanceId='other'");await connect.emit('click');assert.equal(managerCalls(authed).some(c=>c.action.endsWith('.connect')),false);
});

test('late preparation results and errors cannot paint or start polling in a new instance page',async()=>{
 let entered,release;const started=new Promise(r=>entered=r),ui=await setup({'qqBridgeSetup.start':()=>{entered();return new Promise(r=>release=r);}});await ui.evaluate("navigate('chat','qq')");const pending=ui.button(body(ui),'一键准备个人 QQ').emit('click');await started;ui.evaluate("state.instanceId='other'");await ui.evaluate("navigate('memory')");release({...authorized,instanceId:'default'});await pending;assert.equal(ui.ids.get('page-title').textContent,'记忆');assert.equal(ui.timers.size,0);assert.equal(ui.ids.get('global-error').hidden,true);assert.equal(managerCalls(ui).find(c=>c.action.endsWith('.start')).args.instanceId,'default');assert.equal(managerCalls(ui).some(c=>c.action.endsWith('.stop')||c.action.endsWith('.connect')),false);
});

test('a backend view bound to another instance cannot expose its login account or connect controls',async()=>{
 const ui=await setup({'qqBridgeSetup.inspect':()=>({...authorized,instanceId:'other'})});await ui.evaluate("navigate('chat','qq')");assert.match(body(ui).textContent,/其他人格/);assert.doesNotMatch(body(ui).textContent,/登录测试账号|10001/);assert.equal(ui.walk(body(ui)).some(n=>n.tagName==='button'&&n.textContent==='接入这个 QQ 账号'),false);assert.equal(managerCalls(ui).some(c=>c.action.endsWith('.connect')),false);
});

test('stop is an explicit action and preparation metadata never auto-configures or sends platform messages',async()=>{
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...BASE,phase:'waiting_login',flowId:'managed-flow',instanceId:args.instanceId})});await ui.evaluate("navigate('chat','qq')");await ui.button(body(ui),'停止本次准备').emit('click');assert.deepEqual(managerCalls(ui).find(c=>c.action.endsWith('.stop')).args,{flowId:'managed-flow',instanceId:'default'});assert.match(body(ui).textContent,/已停止/);assert.equal(ui.calls.some(c=>['channels.configure','channels.start','connections.disconnect'].includes(c.action)),false);
});

test('optional custom scope requires explicit valid IDs and preserves manual wildcard support',async()=>{
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...authorized,instanceId:args.instanceId})});await ui.evaluate("navigate('chat','qq')");await chooseCustom(ui);assert.ok(ui.walk(body(ui)).some(n=>n.id==='qq-setup-private'));await ui.button(body(ui),'接入这个 QQ 账号').emit('click');assert.match(ui.ids.get('global-error').textContent,/至少一个/);assert.equal(managerCalls(ui).some(c=>c.action.endsWith('.connect')),false);ui.ids.get('qq-setup-private').value='wrong-id';await ui.button(body(ui),'接入这个 QQ 账号').emit('click');assert.equal(managerCalls(ui).some(c=>c.action.endsWith('.connect')),false);ui.ids.get('qq-setup-private').value='*';await ui.button(body(ui),'接入这个 QQ 账号').emit('click');assert.deepEqual(managerCalls(ui).find(c=>c.action.endsWith('.connect')).args.allowedPrivateIds,['*']);assert.deepEqual(managerCalls(ui).find(c=>c.action.endsWith('.connect')).args.allowedGroupIds,[]);
});

test('an unavailable setup service leaves official Bot and existing bridge routes accessible without installation',async()=>{
 const ui=await setup({'qqBridgeSetup.inspect':()=>{throw Object.assign(new Error('not available'),{code:'QQ_SETUP_UNAVAILABLE'});}});await ui.evaluate("navigate('chat','qq')");assert.match(body(ui).textContent,/尚未取得个人 QQ 一键准备服务/);assert.equal(ui.ids.get('global-error').hidden,true);assert.ok(destination(ui,'QQ 官方 Bot'));assert.ok(destination(ui,'使用已有兼容桥'));assert.deepEqual(managerCalls(ui).map(c=>c.action),['qqBridgeSetup.inspect']);
});

test('late connect completion cannot refresh another personality or announce a connection there',async()=>{
 let entered,release;const started=new Promise(r=>entered=r),ui=await setup({'qqBridgeSetup.inspect':args=>({...authorized,instanceId:args.instanceId}),'qqBridgeSetup.connect':()=>{entered();return new Promise(r=>release=r);}});await ui.evaluate("navigate('chat','qq')");const pending=ui.button(body(ui),'接入这个 QQ 账号').emit('click');await started;ui.evaluate("state.instanceId='other'");await ui.evaluate("navigate('memory')");release({...authorized,instanceId:'default',phase:'connected',connected:true});await pending;assert.equal(ui.ids.get('page-title').textContent,'记忆');assert.doesNotMatch(body(ui).textContent,/已取得当前连接确认/);assert.equal(ui.ids.get('global-error').hidden,true);
});


test('manual authorization refresh stops any older preparation polling timer from calling the backend again',async()=>{
 const ui=await setup();await ui.evaluate("navigate('chat','qq')");await ui.button(body(ui),'一键准备个人 QQ').emit('click');const oldTimer=[...ui.timers.values()].find(item=>item.delay===2500);assert.ok(oldTimer);await ui.button(body(ui),'刷新准备状态').emit('click');assert.match(body(ui).textContent,/已登录，尚未接入聊天/);const count=managerCalls(ui).filter(c=>c.action.endsWith('.poll')).length;await oldTimer.fn();await tick();assert.equal(managerCalls(ui).filter(c=>c.action.endsWith('.poll')).length,count);assert.equal(ui.timers.size,0);assert.equal(managerCalls(ui).some(c=>c.action.endsWith('.connect')),false);
});


test('manual ingress rotation preserves the inspected HMAC mode and explains the actual NapCat token field',async()=>{
 for(const mode of ['onebot-hmac','bearer']){
  const ui=await frontend({'channels.status':()=>({connections:[{id:'qq',configured:true,enabled:false,connected:false,ingressAuthMode:mode,hasIngressToken:true,config:{mode:'bridge',accountId:'10001',apiUrl:'http://127.0.0.1:12345',allowedPrivateIds:[],allowedGroupIds:[]},capabilities:{}}],voice:{supported:false}}),'channels.rotateIngress':args=>({authMode:args.authMode,ingressToken:'fixture-once-secret',callbackUrl:'http://127.0.0.1:17654/channels/qq/events'})});
  await ui.evaluate("navigate('chat','qq-bridge')");await ui.button(body(ui),'事件上报与鉴权').emit('click');await ui.button(body(ui),'重新生成上报令牌').emit('click');const call=ui.calls.find(c=>c.action==='channels.rotateIngress');assert.deepEqual(call.args,{id:'qq',authMode:mode,instanceId:'default'});const field=ui.ids.get('channel-qq-ingress-once');assert.equal(field.type,'password');assert.equal(field.value,'fixture-once-secret');assert.doesNotMatch(body(ui).textContent,/fixture-once-secret/);
  if(mode==='onebot-hmac'){assert.match(body(ui).textContent,/NapCat HTTPClient 的 token 字段/);assert.match(body(ui).textContent,/不是 Authorization Bearer/);}else assert.match(body(ui).textContent,/请求头使用 Authorization: Bearer/);
 }
});

test('manual ingress rotation on older status metadata keeps the existing Bearer contract',async()=>{
 const ui=await frontend({'channels.status':()=>({connections:[{id:'qq',configured:true,enabled:false,connected:false,hasIngressToken:true,config:{mode:'bridge',accountId:'10001',apiUrl:'http://127.0.0.1:12345',allowedPrivateIds:[],allowedGroupIds:[]},capabilities:{}}],voice:{supported:false}}),'channels.rotateIngress':args=>({ingressToken:'fixture-once-secret',callbackUrl:'http://127.0.0.1:17654/channels/qq/events'})});await ui.evaluate("navigate('chat','qq-bridge')");await ui.button(body(ui),'事件上报与鉴权').emit('click');await ui.button(body(ui),'重新生成上报令牌').emit('click');assert.equal(ui.calls.find(c=>c.action==='channels.rotateIngress').args.authMode,'bearer');assert.match(body(ui).textContent,/请求头使用 Authorization: Bearer/);
});


test('regenerating a waiting QQ QR is explicit and ordinary status polling never requests rotation',async()=>{
 const oldQr='data:image/svg+xml;base64,PHN2Zy8+',newQr='data:image/svg+xml;base64,'+Buffer.from('<svg>new</svg>').toString('base64'),waiting={...BASE,phase:'waiting_login',flowId:'managed-flow',hasQr:true,qrDataUrl:oldQr,version:'test-1',management:{status:'ready'}};
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...waiting,instanceId:args.instanceId}),'qqBridgeSetup.poll':args=>({...waiting,instanceId:args.instanceId,qrDataUrl:args.refreshQr===true?newQr:oldQr})});await ui.evaluate("navigate('chat','qq')");assert.ok(ui.button(body(ui),'重新生成二维码'));assert.equal(managerCalls(ui).some(c=>c.args.refreshQr),false);await ui.button(body(ui),'刷新扫码状态').emit('click');await timer(ui);assert.ok(managerCalls(ui).filter(c=>c.action.endsWith('.poll')).every(c=>!Object.hasOwn(c.args,'refreshQr')));
 await ui.button(body(ui),'重新生成二维码').emit('click');const rotations=managerCalls(ui).filter(c=>c.args.refreshQr===true);assert.equal(rotations.length,1);assert.deepEqual(rotations[0].args,{flowId:'managed-flow',refreshQr:true,instanceId:'default'});assert.ok(ui.walk(body(ui)).some(n=>n.tagName==='img'&&n.src===newQr));assert.equal(managerCalls(ui).some(c=>c.action.endsWith('.start')||c.action.endsWith('.connect')),false);
});


test('target version metadata does not claim an uninstalled QQ component is already installed',async()=>{
 for(const view of [{phase:'not_installed',version:'v4.18.41',installed:false},{phase:'stopped',version:'v4.18.41',installed:false},{phase:'not_installed',version:'v4.18.41',installed:true}]){
  const ui=await setup({'qqBridgeSetup.inspect':args=>({...BASE,...view,instanceId:args.instanceId})});await ui.evaluate("navigate('chat','qq')");assert.ok(ui.button(body(ui),'一键准备个人 QQ'));assert.equal(ui.walk(body(ui)).some(n=>n.tagName==='button'&&n.textContent==='启动个人 QQ 连接'),false);
 }
 const installed=await setup({'qqBridgeSetup.inspect':args=>({...BASE,phase:'stopped',version:'v4.18.41',installed:true,instanceId:args.instanceId})});await installed.evaluate("navigate('chat','qq')");assert.ok(installed.button(body(installed),'启动个人 QQ 连接'));assert.equal(managerCalls(installed).some(c=>c.action.endsWith('.start')),false);
});


test('an earlier login flow cannot connect after a same-account refresh supplies a new flow',async()=>{
 let polls=0;const ui=await setup({'qqBridgeSetup.inspect':args=>({...authorized,instanceId:args.instanceId}),'qqBridgeSetup.poll':args=>({...authorized,flowId:++polls===1?'managed-flow':'new-managed-flow',instanceId:args.instanceId})});await ui.evaluate("navigate('chat','qq')");const old=ui.button(body(ui),'接入这个 QQ 账号');await ui.button(body(ui),'刷新准备状态').emit('click');await old.emit('click');assert.equal(managerCalls(ui).some(c=>c.action.endsWith('.connect')),false);assert.match(ui.ids.get('global-error').textContent,/准备流程已变化/);await ui.button(body(ui),'接入这个 QQ 账号').emit('click');assert.equal(managerCalls(ui).find(c=>c.action.endsWith('.connect')).args.flowId,'new-managed-flow');
});


test('switching back from custom scope restores autonomous access without retaining a hidden restriction',async()=>{
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...authorized,instanceId:args.instanceId})});await ui.evaluate("navigate('chat','qq')");await chooseCustom(ui);ui.ids.get('qq-setup-private').value='20001';const mode=ui.ids.get('qq-setup-mode');mode.value='autonomous';await mode.emit('change');assert.equal(ui.walk(body(ui)).some(n=>n.id==='qq-setup-private'),false);await ui.button(body(ui),'接入这个 QQ 账号').emit('click');const args=managerCalls(ui).find(c=>c.action.endsWith('.connect')).args;assert.deepEqual(args.allowedPrivateIds,['*']);assert.deepEqual(args.allowedGroupIds,['*']);
});


test('connected QQ opens a pending access choice and applies autonomous scope on its existing flow only after a click',async()=>{
 const connected={...authorized,phase:'connected',connected:true,allowedPrivateIds:['987'],allowedGroupIds:[]};const ui=await setup({'qqBridgeSetup.inspect':args=>({...connected,instanceId:args.instanceId})});await ui.evaluate("navigate('chat','qq')");assert.equal(ui.walk(body(ui)).some(n=>n.id==='qq-setup-mode'),false);assert.deepEqual(managerCalls(ui).map(c=>c.action),['qqBridgeSetup.inspect','qqBridgeSetup.poll']);await ui.button(body(ui),'调整接入方式').emit('click');assert.match(body(ui).textContent,/待应用的选择/);assert.match(body(ui).textContent,/点击“应用接入方式”后才会改变当前范围/);assert.doesNotMatch(body(ui).textContent,/默认接入这个独立 QQ/);assert.equal(ui.ids.get('qq-setup-mode').value,'autonomous');assert.equal(managerCalls(ui).length,2);
 await ui.button(body(ui),'应用接入方式').emit('click');assert.deepEqual(managerCalls(ui).find(c=>c.action.endsWith('.connect')).args,{flowId:'managed-flow',allowedPrivateIds:['*'],allowedGroupIds:['*'],voiceMode:'text',instanceId:'default'});assert.equal(ui.walk(body(ui)).some(n=>n.tagName==='button'&&n.textContent==='应用接入方式'),false);assert.ok(ui.button(body(ui),'调整接入方式'));assert.equal(ui.calls.some(c=>['qqBridgeSetup.start','qqBridgeSetup.stop','channels.configure','channels.rotateIngress','connections.start'].includes(c.action)),false);
});


test('connected access editing preserves optional custom validation without requiring a new QR or manual stop',async()=>{
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...authorized,phase:'connected',connected:true,instanceId:args.instanceId})});await ui.evaluate("navigate('chat','qq')");await ui.button(body(ui),'调整接入方式').emit('click');await chooseCustom(ui);await ui.button(body(ui),'应用接入方式').emit('click');assert.equal(managerCalls(ui).some(c=>c.action.endsWith('.connect')),false);ui.ids.get('qq-setup-private').value='bad';await ui.button(body(ui),'应用接入方式').emit('click');assert.equal(managerCalls(ui).some(c=>c.action.endsWith('.connect')),false);ui.ids.get('qq-setup-private').value='20001';ui.ids.get('qq-setup-groups').value='30001';await ui.button(body(ui),'应用接入方式').emit('click');const call=managerCalls(ui).find(c=>c.action.endsWith('.connect'));assert.deepEqual(call.args.allowedPrivateIds,['20001']);assert.deepEqual(call.args.allowedGroupIds,['30001']);assert.equal(managerCalls(ui).some(c=>c.action.endsWith('.start')||c.action.endsWith('.stop')),false);
});


test('connected access editing rejects old flow and old instance controls',async()=>{
 let polls=0;const connected={...authorized,phase:'connected',connected:true},ui=await setup({'qqBridgeSetup.inspect':args=>({...connected,instanceId:args.instanceId}),'qqBridgeSetup.poll':args=>({...connected,flowId:++polls===1?'managed-flow':'new-managed-flow',instanceId:args.instanceId})});await ui.evaluate("navigate('chat','qq')");await ui.button(body(ui),'调整接入方式').emit('click');const old=ui.button(body(ui),'应用接入方式');await ui.button(body(ui),'刷新准备状态').emit('click');await old.emit('click');assert.equal(managerCalls(ui).some(c=>c.action.endsWith('.connect')),false);assert.match(ui.ids.get('global-error').textContent,/准备流程已变化/);const current=ui.button(body(ui),'应用接入方式');ui.evaluate("state.instanceId='other'");await current.emit('click');assert.equal(managerCalls(ui).some(c=>c.action.endsWith('.connect')),false);
});


test('connected access editing can be cancelled without applying or claiming a new scope',async()=>{
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...authorized,phase:'connected',connected:true,instanceId:args.instanceId})});await ui.evaluate("navigate('chat','qq')");await ui.button(body(ui),'调整接入方式').emit('click');await chooseCustom(ui);ui.ids.get('qq-setup-private').value='20001';const old=ui.button(body(ui),'应用接入方式');await ui.button(body(ui),'取消调整').emit('click');await old.emit('click');assert.equal(managerCalls(ui).some(c=>c.action.endsWith('.connect')),false);assert.equal(ui.walk(body(ui)).some(n=>n.id==='qq-setup-mode'),false);await ui.button(body(ui),'调整接入方式').emit('click');assert.equal(ui.ids.get('qq-setup-mode').value,'autonomous');assert.equal(ui.ids.get('qq-setup-private').value,'');
});


test('connected metadata without a verified online login account does not offer access changes',async()=>{
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...authorized,phase:'connected',connected:true,loginAccount:null,instanceId:args.instanceId})});await ui.evaluate("navigate('chat','qq')");assert.equal(ui.walk(body(ui)).some(n=>n.tagName==='button'&&['调整接入方式','应用接入方式'].includes(n.textContent)),false);assert.deepEqual(managerCalls(ui).map(c=>c.action),['qqBridgeSetup.inspect','qqBridgeSetup.poll']);
});


test('connected optional controls never append literal null under native append semantics',async()=>{
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...authorized,phase:'connected',connected:true,instanceId:args.instanceId})});const nativeProbe=ui.document.createElement('div');nativeProbe.append(null);assert.equal(nativeProbe.textContent,'null','fixture must match browser append(null) stringification');await ui.evaluate("navigate('chat','qq')");const assertNoNull=()=>assert.equal(ui.walk(body(ui)).some(node=>node.tagName==='#text'&&node.textContent==='null'),false,'absent optional control must not render a null text node');assertNoNull();await ui.button(body(ui),'调整接入方式').emit('click');assertNoNull();await chooseCustom(ui);assertNoNull();await ui.button(body(ui),'取消调整').emit('click');assertNoNull();assert.equal(managerCalls(ui).some(call=>call.action.endsWith('.connect')),false);
});

test('opening QQ refreshes a cached connected flow before presenting a new QR login state',async()=>{
 const waiting={...BASE,phase:'waiting_login',flowId:'managed-flow',hasQr:true,qrDataUrl:'data:image/svg+xml;base64,PHN2Zy8+'};
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...authorized,phase:'connected',connected:true,instanceId:args.instanceId}),'qqBridgeSetup.poll':args=>({...waiting,instanceId:args.instanceId})});
 await ui.evaluate("navigate('chat','qq')");
 assert.deepEqual(managerCalls(ui).map(call=>call.action),['qqBridgeSetup.inspect','qqBridgeSetup.poll']);
 assert.deepEqual(managerCalls(ui)[1].args,{flowId:'managed-flow',instanceId:'default'});
 assert.match(body(ui).textContent,/等待你用手机 QQ 扫码/);assert.doesNotMatch(body(ui).textContent,/已取得当前连接确认|个人 QQ 已接入此人格/);
 assert.ok(ui.walk(body(ui)).some(node=>node.tagName==='img'&&node.src===waiting.qrDataUrl));
 assert.equal(ui.calls.some(call=>['qqBridgeSetup.start','qqBridgeSetup.connect','channels.configure','channels.start','connections.start'].includes(call.action)),false);
 assert.equal(managerCalls(ui).some(call=>Object.hasOwn(call.args,'refreshQr')),false);
});

test('first QQ view polls each same-instance live flow once without starting or rotating QR',async()=>{
 for(const phase of ['starting','waiting_login','authorized','connected']){
  const ui=await setup({'qqBridgeSetup.inspect':args=>({...authorized,phase,connected:phase==='connected',instanceId:args.instanceId})});await ui.evaluate("navigate('chat','qq')");
  assert.deepEqual(managerCalls(ui).map(call=>call.action),['qqBridgeSetup.inspect','qqBridgeSetup.poll'],phase);
  assert.deepEqual(managerCalls(ui)[1].args,{flowId:'managed-flow',instanceId:'default'},phase);
 }
});

test('first QQ view does not poll stopped, failed, uninstalled, unrelated, or missing-flow metadata',async()=>{
 for(const view of [...['not_installed','stopped','failed','installing','configuring'].map(phase=>({phase,flowId:'managed-flow',instanceId:'default'})),{phase:'connected',flowId:'managed-flow',instanceId:'other'},{phase:'authorized',flowId:null,instanceId:'default'},{phase:'connected',flowId:'managed-flow',instanceId:null}]){
  const ui=await setup({'qqBridgeSetup.inspect':()=>({...BASE,...view})});await ui.evaluate("navigate('chat','qq')");
  assert.deepEqual(managerCalls(ui).map(call=>call.action),['qqBridgeSetup.inspect'],JSON.stringify(view));
 }
});

test('late initial QQ poll results and errors cannot paint or schedule work after the page or instance changes',async()=>{
 for(const rejected of [false,true]){
  let entered,release;const started=new Promise(resolve=>entered=resolve);
  const ui=await setup({'qqBridgeSetup.inspect':args=>({...authorized,phase:'connected',connected:true,instanceId:args.instanceId}),'qqBridgeSetup.poll':()=>{entered();return new Promise((resolve,reject)=>{release=()=>rejected?reject(new Error('old flow failed')):resolve({...authorized,instanceId:'default'});});}});
  const pending=ui.evaluate("navigate('chat','qq')");await started;ui.evaluate("state.instanceId='other'");await ui.evaluate("navigate('memory')");release();await pending;
  assert.equal(ui.ids.get('page-title').textContent,'记忆');assert.equal(ui.timers.size,0);assert.equal(ui.ids.get('global-error').hidden,true);
  assert.doesNotMatch(body(ui).textContent,/已取得当前连接确认|old flow failed/);
  assert.deepEqual(managerCalls(ui).map(call=>call.action),['qqBridgeSetup.inspect','qqBridgeSetup.poll']);
 }
});

const readyManagement={status:'ready',lastVerifiedAt:1000,retryAt:null,retryAfterMs:0,errorCode:null};
const waitingQr={...BASE,phase:'waiting_login',flowId:'managed-flow',hasQr:true,qrDataUrl:'data:image/svg+xml;base64,PHN2Zy8+',management:readyManagement,lastVerifiedQQ:{at:1000,online:false,coreReady:false,loginPhase:'waiting_qrcode',accountId:null}};
const expiredQr={...waitingQr,hasQr:false,qrDataUrl:null,loginPhase:'waiting_qrcode',error:{code:'NAPCAT_LOGIN_ERROR',message:'二维码已经过期，请刷新二维码'}};

test('an expired hidden QQ QR has one explicit regeneration path and its successful fresh result becomes scannable',async()=>{
 const freshQr='data:image/svg+xml;base64,'+Buffer.from('<svg>fresh-after-expiry</svg>').toString('base64');
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...expiredQr,instanceId:args.instanceId}),'qqBridgeSetup.poll':args=>args.refreshQr?{...waitingQr,qrDataUrl:freshQr,error:null,instanceId:args.instanceId}:{...expiredQr,instanceId:args.instanceId}});
 await ui.evaluate("navigate('chat','qq')");assert.deepEqual(managerCalls(ui).map(call=>call.action),['qqBridgeSetup.inspect']);assert.equal(ui.timers.size,0);assert.equal(ui.walk(body(ui)).some(node=>node.tagName==='img'),false);assert.match(body(ui).textContent,/点击“重新生成二维码”/);
 await ui.button(body(ui),'重新生成二维码').emit('click');assert.deepEqual(managerCalls(ui).find(call=>call.args.refreshQr).args,{flowId:'managed-flow',refreshQr:true,instanceId:'default'});assert.equal(managerCalls(ui).filter(call=>call.args.refreshQr).length,1);assert.ok(ui.walk(body(ui)).some(node=>node.tagName==='img'&&node.src===freshQr));assert.doesNotMatch(body(ui).textContent,/二维码已经过期/);assert.match(body(ui).textContent,/请用手机 QQ 扫码/);assert.equal(managerCalls(ui).some(call=>call.action.endsWith('.start')||call.action.endsWith('.connect')||call.action.endsWith('.recover')),false);
});

test('QR regeneration is unavailable during confirmation, management trouble, unknown state, cooldown or owned restart recovery',async()=>{
 const changes=[{qrLoginAccepted:true},{loginPhase:'initializing'},{loginPhase:'qrcode_scanned'},{loginPhase:'generating_qrcode'},{loginPhase:'reconnecting'},{lastVerifiedQQ:{...waitingQr.lastVerifiedQQ,online:true}},{management:{status:'unknown'}},{management:{status:'unavailable'}},{management:{status:'rate_limited',retryAt:62000,retryAfterMs:60000}},{error:{code:'NAPCAT_WEBUI_AUTH',message:'auth failed'}},{error:{code:'NAPCAT_WEBUI_REJECTED',message:'other business failure'}},{error:{code:'NAPCAT_SETUP_FAILED',message:'unknown failure'}},{recovery:{required:true,canRecover:true,reason:'offline_without_qr'}}];
 for(const change of changes){const ui=await setup({'qqBridgeSetup.inspect':args=>({...expiredQr,...change,instanceId:args.instanceId})});await ui.evaluate("navigate('chat','qq')");assert.equal(ui.walk(body(ui)).some(node=>node.tagName==='button'&&node.textContent==='重新生成二维码'),false,JSON.stringify(change));assert.equal(managerCalls(ui).some(call=>call.args.refreshQr),false);}
});

test('pending manual QR regeneration cannot be duplicated or combined with another status read',async()=>{
 let release,rotations=0;const ui=await setup({'qqBridgeSetup.inspect':args=>({...expiredQr,instanceId:args.instanceId}),'qqBridgeSetup.poll':args=>{rotations++;return new Promise(resolve=>{release=()=>resolve({...waitingQr,instanceId:args.instanceId});});}});
 await ui.evaluate("navigate('chat','qq')");const old=ui.button(body(ui),'重新生成二维码'),pending=old.emit('click');await tick();assert.equal(rotations,1);assert.equal(ui.button(body(ui),'重新生成二维码').disabled,true);await old.emit('click');await ui.button(body(ui),'重新检查连接').emit('click');assert.equal(rotations,1);release();await pending;assert.ok(ui.walk(body(ui)).some(node=>node.tagName==='img'));assert.equal(managerCalls(ui).filter(call=>call.args.refreshQr).length,1);
});

test('a stale QR button cannot refresh a newer flow and late refresh results cannot paint a different page',async()=>{
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...expiredQr,instanceId:args.instanceId}),'qqBridgeSetup.poll':args=>({...expiredQr,flowId:'new-flow',instanceId:args.instanceId})});await ui.evaluate("navigate('chat','qq')");const old=ui.button(body(ui),'重新生成二维码');await ui.button(body(ui),'重新检查连接').emit('click');await old.emit('click');assert.equal(managerCalls(ui).some(call=>call.args.refreshQr),false);assert.match(ui.ids.get('global-error').textContent,/准备流程已变化/);
 let release;const late=await setup({'qqBridgeSetup.inspect':args=>({...expiredQr,instanceId:args.instanceId}),'qqBridgeSetup.poll':()=>new Promise(resolve=>{release=()=>resolve({...waitingQr,instanceId:'default'});})});await late.evaluate("navigate('chat','qq')");const pending=late.button(body(late),'重新生成二维码').emit('click');await tick();await late.evaluate("navigate('memory')");release();await pending;assert.equal(late.ids.get('page-title').textContent,'记忆');assert.equal(late.timers.size,0);assert.equal(late.ids.get('global-error').hidden,true);assert.equal(managerCalls(late).filter(call=>call.args.refreshQr).length,1);
});
async function localTimer(ui,delay){const entry=[...ui.timers.entries()].find(([,value])=>value.delay===delay);assert.ok(entry,'local timer '+delay);ui.timers.delete(entry[0]);await entry[1].fn();await tick();}

test('management cooldown preserves last verified QQ facts, hides cached QR and only permits one manual recovery after expiry',async()=>{
 let retryAt,polls=0;
 const limited=()=>({...waitingQr,connected:true,error:{code:'NAPCAT_WEBUI_RATE_LIMITED',message:'管理请求受限',retryAt},management:{status:'rate_limited',lastVerifiedAt:1000,retryAt,retryAfterMs:retryAt-Date.now(),errorCode:'NAPCAT_WEBUI_RATE_LIMITED'},lastVerifiedQQ:{at:1000,online:true,coreReady:true,loginPhase:'online',accountId:'10001'}});
 const ui=await setup({'qqBridgeSetup.inspect':args=>{retryAt=Date.now()+60000;return{...limited(),instanceId:args.instanceId};},'qqBridgeSetup.poll':args=>{polls++;return{...authorized,phase:'connected',connected:true,instanceId:args.instanceId,management:readyManagement,lastVerifiedQQ:{at:Date.now(),online:true,coreReady:true,loginPhase:'online',accountId:'10001'}};}});
 await ui.evaluate("navigate('chat','qq')");assert.deepEqual(managerCalls(ui).map(call=>call.action),['qqBridgeSetup.inspect']);assert.match(body(ui).textContent,/QQ 上次确认在线，管理连接暂不可用/);assert.match(body(ui).textContent,/NAPCAT_WEBUI_RATE_LIMITED/);assert.doesNotMatch(body(ui).textContent,/等待你用手机 QQ 扫码|请用手机 QQ 扫码|个人 QQ 已接入此人格/);assert.equal(ui.walk(body(ui)).some(node=>node.tagName==='img'),false);assert.equal(ui.button(body(ui),'重新检查连接').disabled,true);
 await ui.button(body(ui),'重新检查连接').emit('click');assert.equal(polls,0);await localTimer(ui,1000);assert.equal(polls,0);
 ui.advance(61000);await localTimer(ui,1000);assert.equal(ui.button(body(ui),'重新检查连接').disabled,false);assert.equal(polls,0,'deadline does not itself issue another authentication request');await ui.button(body(ui),'重新检查连接').emit('click');assert.equal(polls,1);assert.match(body(ui).textContent,/已取得当前连接确认/);assert.equal(ui.timers.size,0);assert.equal(managerCalls(ui).some(call=>call.args.refreshQr||call.action.endsWith('.start')||call.action.endsWith('.connect')),false);
});
test('management failure with no QR does not tell an unverified user to scan, restart or keep refreshing',async()=>{
 const view={...BASE,phase:'waiting_login',flowId:'managed-flow',error:{code:'NAPCAT_WEBUI_AUTH',message:'本机管理鉴权未完成'},management:{status:'unavailable',lastVerifiedAt:null,retryAt:null,retryAfterMs:0,errorCode:'NAPCAT_WEBUI_AUTH'},lastVerifiedQQ:null};
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...view,instanceId:args.instanceId})});await ui.evaluate("navigate('chat','qq')");assert.match(body(ui).textContent,/QQ 登录状态尚未核实/);assert.match(body(ui).textContent,/NAPCAT_WEBUI_AUTH/);assert.ok(ui.button(body(ui),'重新检查连接'));assert.equal(ui.timers.size,0);assert.equal(managerCalls(ui).length,1);assert.equal(ui.walk(body(ui)).some(node=>node.tagName==='button'&&['刷新扫码状态','重新生成二维码','启动个人 QQ 连接'].includes(node.textContent)),false);assert.doesNotMatch(body(ui).textContent,/等待你用手机 QQ 扫码|请用手机 QQ 扫码/);
 const unknown=await setup({'qqBridgeSetup.inspect':args=>({...authorized,phase:'connected',connected:true,management:{status:'unknown'},instanceId:args.instanceId})});await unknown.evaluate("navigate('chat','qq')");assert.match(body(unknown).textContent,/连接配置已保存，登录状态待核对/);assert.doesNotMatch(body(unknown).textContent,/已取得当前连接确认|个人 QQ 已接入此人格/);
});
test('confirmed offline and phone-confirmed initialization are different from management unavailability',async()=>{
 const offline=await setup({'qqBridgeSetup.inspect':args=>({...waitingQr,hasQr:false,qrDataUrl:null,instanceId:args.instanceId,lastVerifiedQQ:{at:1000,online:false,coreReady:false,loginPhase:'waiting_qrcode',accountId:'10001'}})});await offline.evaluate("navigate('chat','qq')");assert.match(body(offline).textContent,/QQ 已离线，正在等待可用二维码/);assert.doesNotMatch(body(offline).textContent,/请用手机 QQ 扫码/);
 const finishing=await setup({'qqBridgeSetup.inspect':args=>({...waitingQr,instanceId:args.instanceId,qrLoginAccepted:true,lastVerifiedQQ:{at:1000,online:true,coreReady:false,loginPhase:'initializing',accountId:'10001'}})});await finishing.evaluate("navigate('chat','qq')");assert.match(body(finishing).textContent,/QQ 正在完成登录/);assert.match(body(finishing).textContent,/手机确认已收到/);assert.equal(finishing.walk(body(finishing)).some(node=>node.tagName==='img'),false);assert.equal(managerCalls(finishing).some(call=>call.args.refreshQr),false);
});
test('a thrown status error stops automatic polling and one explicit read can restore the normal QR flow',async()=>{
 let polls=0;
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...waitingQr,instanceId:args.instanceId}),'qqBridgeSetup.poll':args=>{polls++;if(polls===2)throw Object.assign(new Error('本机管理接口暂不可达'),{code:'NAPCAT_HTTP_FAILED'});return{...waitingQr,instanceId:args.instanceId};}});await ui.evaluate("navigate('chat','qq')");await timer(ui);assert.equal(polls,2);assert.equal(ui.timers.size,0);assert.match(body(ui).textContent,/NAPCAT_HTTP_FAILED/);assert.ok(ui.button(body(ui),'重新检查连接'));assert.equal(ui.walk(body(ui)).some(node=>node.tagName==='img'),false);await ui.button(body(ui),'重新检查连接').emit('click');assert.equal(polls,3);assert.ok(ui.walk(body(ui)).some(node=>node.tagName==='img'));assert.equal([...ui.timers.values()].filter(timer=>timer.delay===2500).length,1);
});
test('one pending status read excludes manual refresh and QR regeneration without rotating automatically',async()=>{
 let polls=0,release;
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...waitingQr,instanceId:args.instanceId}),'qqBridgeSetup.poll':args=>{polls++;return polls===2?new Promise(resolve=>{release=()=>resolve({...waitingQr,instanceId:args.instanceId});}):{...waitingQr,instanceId:args.instanceId};}});await ui.evaluate("navigate('chat','qq')");const oldRotation=ui.button(body(ui),'重新生成二维码'),oldRefresh=ui.button(body(ui),'刷新扫码状态');await timer(ui);assert.equal(polls,2);assert.equal(ui.button(body(ui),'刷新扫码状态').disabled,true);assert.equal(ui.button(body(ui),'重新生成二维码').disabled,true);await oldRotation.emit('click');await oldRefresh.emit('click');assert.equal(polls,2);assert.equal(managerCalls(ui).some(call=>call.args.refreshQr),false);release();await tick();assert.equal(ui.button(body(ui),'刷新扫码状态').disabled,false);assert.equal([...ui.timers.values()].filter(timer=>timer.delay===2500).length,1);
});
test('hidden QQ page stops polling; becoming visible performs one read and cannot bypass an authentication cooldown',async()=>{
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...waitingQr,instanceId:args.instanceId})});await ui.evaluate("navigate('chat','qq')");const stale=[...ui.timers.values()].find(timer=>timer.delay===2500),before=managerCalls(ui).length;await ui.setHidden(true);assert.equal(ui.timers.size,0);await stale.fn();await tick();assert.equal(managerCalls(ui).length,before);await ui.setHidden(false);assert.equal(managerCalls(ui).length,before+1);assert.equal(managerCalls(ui).some(call=>call.args.refreshQr),false);assert.equal([...ui.timers.values()].filter(timer=>timer.delay===2500).length,1);
 const limited=await setup({'qqBridgeSetup.inspect':args=>({...waitingQr,instanceId:args.instanceId,management:{status:'rate_limited',lastVerifiedAt:1000,retryAt:Date.now()+60000,retryAfterMs:60000,errorCode:'NAPCAT_WEBUI_RATE_LIMITED'},error:{code:'NAPCAT_WEBUI_RATE_LIMITED',message:'管理请求受限'}})});await limited.evaluate("navigate('chat','qq')");await limited.setHidden(true);assert.equal(limited.timers.size,0);await limited.setHidden(false);assert.equal(managerCalls(limited).length,1);assert.equal(limited.button(body(limited),'重新检查连接').disabled,true);assert.equal([...limited.timers.values()].some(timer=>timer.delay===2500),false);
 const stopped=await setup({'qqBridgeSetup.inspect':args=>({...BASE,phase:'stopped',flowId:'managed-flow',instanceId:args.instanceId})});await stopped.evaluate("navigate('chat','qq')");await stopped.setHidden(true);await stopped.setHidden(false);assert.equal(managerCalls(stopped).length,1,'visibility cannot poll an intentionally stopped flow');
 const unopened=await setup({'qqBridgeSetup.inspect':args=>({...waitingQr,instanceId:args.instanceId})});await unopened.setHidden(true);await unopened.evaluate("navigate('chat','qq')");assert.deepEqual(managerCalls(unopened).map(call=>call.action),['qqBridgeSetup.inspect']);await unopened.setHidden(false);assert.deepEqual(managerCalls(unopened).map(call=>call.action),['qqBridgeSetup.inspect','qqBridgeSetup.poll']);assert.ok(unopened.walk(body(unopened)).some(node=>node.tagName==='img'));
});
test('leaving a cooldown page removes visibility recovery and late status cannot repaint another route',async()=>{
 let polls=0,release;
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...waitingQr,instanceId:args.instanceId}),'qqBridgeSetup.poll':args=>{polls++;return polls===2?new Promise(resolve=>{release=()=>resolve({...waitingQr,instanceId:args.instanceId,management:{status:'rate_limited',retryAt:Date.now()+60000},error:{code:'NAPCAT_WEBUI_RATE_LIMITED',message:'迟到错误'}});}):{...waitingQr,instanceId:args.instanceId};}});await ui.evaluate("navigate('chat','qq')");await timer(ui);assert.ok(release);await ui.evaluate("navigate('memory')");release();await tick();await ui.setHidden(true);await ui.setHidden(false);assert.equal(ui.ids.get('page-title').textContent,'记忆');assert.doesNotMatch(body(ui).textContent,/迟到错误|重新检查连接/);assert.equal(ui.timers.size,0);assert.equal(ui.documentEvents.get('visibilitychange').size,0);assert.equal(polls,2);
});
test('a preparation error without an active flow still offers a read-only recovery instead of a missing action',async()=>{
 const ui=await setup({'qqBridgeSetup.start':()=>{throw Object.assign(new Error('QQ尚未安装'),{code:'NAPCAT_QQ_MISSING'});}});await ui.evaluate("navigate('chat','qq')");await ui.button(body(ui),'一键准备个人 QQ').emit('click');assert.ok(ui.button(body(ui),'重新检查连接'));const before=managerCalls(ui).filter(call=>call.action.endsWith('.start')).length;await ui.button(body(ui),'重新检查连接').emit('click');assert.ok(ui.button(body(ui),'一键准备个人 QQ'));assert.equal(managerCalls(ui).filter(call=>call.action.endsWith('.start')).length,before);assert.equal([...ui.timers.values()].some(timer=>timer.delay===2500||timer.delay===1000),false);
});
const offlineRecovery={...BASE,phase:'waiting_login',flowId:'managed-flow',loginPhase:'offline',error:{code:'NAPCAT_WEBUI_REJECTED',message:'当前没有可用二维码'},management:readyManagement,lastVerifiedQQ:{at:1000,online:false,coreReady:false,loginPhase:'offline',accountId:'10001'},recovery:{required:true,canRecover:true,reason:'offline_without_qr'}};
test('fresh confirmed offline without a QR offers one owner reconnect, then shows only the new flow QR',async()=>{
 let release,recoveries=0;
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...offlineRecovery,instanceId:args.instanceId}),'qqBridgeSetup.recover':args=>{recoveries++;return new Promise(resolve=>{release=()=>resolve({...BASE,phase:'starting',flowId:'new-managed-flow',instanceId:args.instanceId,management:{status:'unknown'},recovery:{required:false,canRecover:false,reason:null}});});},'qqBridgeSetup.poll':args=>({...waitingQr,flowId:args.flowId,instanceId:args.instanceId})});await ui.evaluate("navigate('chat','qq')");assert.deepEqual(managerCalls(ui).map(call=>call.action),['qqBridgeSetup.inspect']);assert.match(body(ui).textContent,/QQ 已离线，需要重新连接/);assert.doesNotMatch(body(ui).textContent,/暂时无法连接本机 QQ 管理接口|请用手机 QQ 扫码/);assert.equal(ui.timers.size,0);const button=ui.button(body(ui),'重新连接 QQ'),pending=button.emit('click');await tick();assert.equal(recoveries,1);assert.equal(ui.button(body(ui),'重新连接 QQ').disabled,true);await button.emit('click');assert.equal(recoveries,1);assert.deepEqual(managerCalls(ui).find(call=>call.action.endsWith('.recover')).args,{flowId:'managed-flow',instanceId:'default'});assert.equal(ui.ids.get('confirm-dialog').open,false);release();await pending;assert.match(body(ui).textContent,/正在启动个人 QQ 连接/);await timer(ui);assert.ok(ui.walk(body(ui)).some(node=>node.tagName==='img'));assert.equal(managerCalls(ui).find(call=>call.action.endsWith('.poll')).args.flowId,'new-managed-flow');assert.equal(managerCalls(ui).some(call=>call.args.refreshQr||call.action.endsWith('.start')||call.action.endsWith('.connect')),false);
});
test('management limits and unavailable ownership cannot expose a reconnect that bypasses the actual recovery contract',async()=>{
 for(const change of [{management:{status:'rate_limited',retryAt:Date.now()+60000,retryAfterMs:60000,errorCode:'NAPCAT_WEBUI_RATE_LIMITED'},error:{code:'NAPCAT_WEBUI_RATE_LIMITED',message:'管理连接受限'}},{recovery:{required:true,canRecover:false,reason:'offline_without_qr'},manualCloseRequired:true}]){
  const ui=await setup({'qqBridgeSetup.inspect':args=>({...offlineRecovery,...change,instanceId:args.instanceId})});await ui.evaluate("navigate('chat','qq')");assert.equal(ui.walk(body(ui)).some(node=>node.tagName==='button'&&node.textContent==='重新连接 QQ'),false);assert.equal(managerCalls(ui).some(call=>call.action.endsWith('.recover')||call.args.refreshQr),false);assert.ok(ui.button(body(ui),'重新检查连接'));
 }
 const noError=await setup({'qqBridgeSetup.inspect':args=>({...offlineRecovery,error:null,instanceId:args.instanceId})});await noError.evaluate("navigate('chat','qq')");assert.ok(noError.button(body(noError),'重新连接 QQ'));assert.equal(noError.timers.size,0);assert.equal(managerCalls(noError).length,1);
});
test('a reconnect button from an old flow cannot reopen a replacement flow or another personality',async()=>{
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...offlineRecovery,instanceId:args.instanceId}),'qqBridgeSetup.poll':args=>({...offlineRecovery,flowId:'replacement-flow',instanceId:args.instanceId})});await ui.evaluate("navigate('chat','qq')");const old=ui.button(body(ui),'重新连接 QQ');await ui.button(body(ui),'重新检查连接').emit('click');await old.emit('click');assert.equal(managerCalls(ui).some(call=>call.action.endsWith('.recover')),false);assert.match(ui.ids.get('global-error').textContent,/准备流程已变化/);const current=ui.button(body(ui),'重新连接 QQ');ui.evaluate("state.instanceId='other'");await current.emit('click');assert.equal(managerCalls(ui).some(call=>call.action.endsWith('.recover')),false);
});
test('late reconnect completion stays with its original page and does not auto-connect or refresh a QR elsewhere',async()=>{
 let release;
 const ui=await setup({'qqBridgeSetup.inspect':args=>({...offlineRecovery,instanceId:args.instanceId}),'qqBridgeSetup.recover':()=>new Promise(resolve=>{release=()=>resolve({...waitingQr,flowId:'late-recovery-flow',instanceId:'default'});})});await ui.evaluate("navigate('chat','qq')");const pending=ui.button(body(ui),'重新连接 QQ').emit('click');await tick();await ui.evaluate("navigate('memory')");release();await pending;assert.equal(ui.ids.get('page-title').textContent,'记忆');assert.equal(ui.timers.size,0);assert.equal(ui.ids.get('global-error').hidden,true);assert.equal(managerCalls(ui).filter(call=>call.action.endsWith('.recover')).length,1);assert.equal(managerCalls(ui).some(call=>call.action.endsWith('.poll')||call.action.endsWith('.connect')||call.args.refreshQr),false);
});
test('QQ permissions name self-profile and space tools, show real sources and distinguish grants from offline or missing drivers',async()=>{
 const items=[{id:'profile.update',label:'修改账号资料',supported:true,allowed:true,available:true,driverAvailable:true,provider:'napcat-onebot-account',operations:['profile.avatar','profile.update']},{id:'feed.publish',label:'发布朋友圈',supported:true,allowed:false,available:false,driverAvailable:true,provider:'napcat-onebot-account',reason:'尚未获用户授权'},{id:'chat.voice',label:'发语音',supported:true,allowed:true,available:false,driverAvailable:false,provider:'onebot',reason:'当前渠道未就绪'},{id:'call.voice',label:'语音',supported:false,allowed:false,available:false,driverAvailable:false,reason:'当前驱动未提供此能力'},{id:'chat.image',supported:true,allowed:false,available:false,driverAvailable:true}];
 const ui=await frontend({'permissions.inspect':()=>({connected:true,items})});await ui.evaluate("navigate('chat','qq-permissions')");const page=body(ui),rows=ui.walk(page).filter(node=>node.tagName==='tr'),row=id=>rows.find(node=>node.dataset.capability===id);
 assert.match(row('profile.update').textContent,/修改自己的头像与资料/);assert.match(row('profile.update').textContent,/来源：NapCat 个人 QQ 账号接口/);assert.match(row('profile.update').textContent,/已提供操作：修改头像、更新资料/);assert.match(row('feed.publish').textContent,/发表 QQ 空间说说/);assert.match(row('feed.publish').textContent,/支持但尚未授权/);assert.match(row('chat.voice').textContent,/发送语音消息/);assert.match(row('chat.voice').textContent,/离线或连接未就绪/);assert.match(row('call.voice').textContent,/实时语音通话/);assert.match(row('call.voice').textContent,/驱动未提供/);assert.match(row('chat.image').textContent,/当前连接器未报告来源/);
 const check=id=>ui.walk(row(id)).find(node=>node.tagName==='input');assert.equal(check('feed.publish').checked,false);assert.equal(check('call.voice').checked,false);assert.equal(check('call.voice').disabled,true);assert.match(page.textContent,/“语音消息”是在聊天中发送一段音频/);assert.equal(ui.calls.some(call=>call.action==='permissions.configure'),false);await ui.button(page,'保存这些权限').emit('click');assert.deepEqual(ui.calls.find(call=>call.action==='permissions.configure').args.allowed,['profile.update','chat.voice']);
});
test('Bilibili permission publication remains comments even when a driver supplies a generic dynamic label',async()=>{
 const ui=await frontend({'permissions.inspect':args=>{assert.equal(args.id,'bilibili');return{connected:true,items:[{id:'feed.publish',label:'发布动态',supported:true,allowed:false,available:false,driverAvailable:true,provider:'bilibili',operations:['feed.publish']}]};}});await ui.evaluate("navigate('chat','bilibili-permissions')");assert.match(body(ui).textContent,/在B站发表评论/);assert.match(body(ui).textContent,/来源：B 站连接/);assert.doesNotMatch(body(ui).textContent,/发布动态|说说|朋友圈/);assert.equal(ui.calls.some(call=>call.action==='permissions.configure'),false);
});
test('QQ self-operation receipts name the real operation and account target without borrowing friend-status queries',async()=>{
 const records=[{...qqReceipt,receiptId:'avatar-record',operation:'profile.avatar',userId:null,status:'completed'},{...qqReceipt,receiptId:'profile-record',operation:'profile.update',userId:null,status:'unknown'},{...qqReceipt,receiptId:'space-record',operation:'feed.publish',userId:null,status:'completed',tid:'actual-space-tid'},{...qqReceipt,receiptId:'friend-record'}];
 const ui=await frontend({'qqAccount.inspect':()=>qqAccountView,'qqAccount.read':args=>{assert.equal(args.accountOperation,'receipts');return{items:records,total:records.length,pageCursor:null};}});await ui.evaluate("navigate('chat','qq-account')");assert.match(body(ui).textContent,/修改 QQ 头像 · 账号自身/);assert.match(body(ui).textContent,/更新 QQ 资料 · 账号自身/);assert.match(body(ui).textContent,/发表 QQ 空间说说 · 账号自身/);assert.match(body(ui).textContent,/空间说说编号：actual-space-tid/);assert.match(body(ui).textContent,/已完成/);assert.match(body(ui).textContent,/好友申请 · 20001/);assert.equal(ui.walk(body(ui)).filter(node=>node.tagName==='button'&&node.textContent==='核对这次申请的状态').length,1);assert.equal(ui.walk(body(ui)).filter(node=>node.tagName==='button'&&node.textContent==='查看完整资料').length,4);assert.doesNotMatch(body(ui).textContent,/好友申请 · (?:null|账号自身)|联系人null/);assert.equal(ui.calls.some(call=>call.action==='qqAccount.execute'||call.args.accountOperation==='friend.status'),false);
});
test('built-in guide distinguishes direct QQ space publication from optional reading, interaction and cover services',async()=>{
 const ui=await frontend();await ui.evaluate("navigate('settings','user-guide')");assert.match(body(ui).textContent,/发表 QQ 空间说说可使用已核实的 NapCat 账号接口/);assert.match(body(ui).textContent,/空间浏览、点赞、评论与翻唱仍需要相应扩展服务/);assert.doesNotMatch(body(ui).textContent,/QQ 动态和翻唱需要兼容的独立服务/);assert.equal(ui.calls.some(call=>/execute|generate|login|start/.test(call.action)),false);
});
