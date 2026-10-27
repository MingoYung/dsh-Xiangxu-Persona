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
  const ids = new Map(), calls = [], timers = new Map(), scrollEvents = [], focusEvents = []; let nextTimer = 0, autoConfirm = false;
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
  const document = { body, createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text), getElementById: id => ids.get(id), querySelectorAll: selector => body.querySelectorAll(selector), querySelector: selector => body.querySelector(selector) };
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
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id), queueMicrotask, Uint8Array, TextEncoder, btoa: value => Buffer.from(value, 'binary').toString('base64') });
  vm.runInContext(source, context); await new Promise(resolve => setImmediate(resolve));
  return { calls, timers, ids, scrollEvents, focusEvents, mediaView, context, document, evaluate: code => vm.runInContext(code, context), walk, visible,
    button: (node, label) => { const found = walk(node).find(item => item.tagName === 'button' && item.textContent === label); assert.ok(found, 'button ' + label); return found; },
    confirm: value => { autoConfirm = value; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const records = size => Array.from({length:size},(_,i)=>({id:'retained-'+i,recordType:i%5===0?'deep':'memory',scope:'global',textPreview:'entry-'+i,text:'entry-'+i,createdAt:i+1}));
function page(rows,args,size=args.pageSize){const from=args.cursor?Number(args.cursor.slice(args.cursor.indexOf(':')+1)):0,to=Math.min(rows.length,from+size);return{items:rows.slice(from,to),total:rows.length,offset:from,pageSize:args.pageSize,nextCursor:to<rows.length?'offset:'+to:null};}
const content=ui=>ui.ids.get('page-content');
const pagers=ui=>ui.walk(content(ui)).filter(n=>n.classList.contains('pagination'));
const top=ui=>pagers(ui).find(n=>n.classList.contains('pagination-top'));
const summary=ui=>top(ui).textContent;
const move=async(ui,label)=>ui.button(top(ui),label).emit('click');
const cards=ui=>ui.walk(content(ui)).filter(n=>n.tagName==='article'&&n.classList.contains('record'));
function memoryUi(overrides={}){const rows=records(34);return frontend({'memory.list':args=>page(rows.filter(row=>(!args.query||row.text.includes(args.query))&&(!args.recordType||row.recordType===args.recordType)),args),...overrides});}

test('34 retained records expose top and bottom pagination and all entries are reachable in both directions',async()=>{
 const ui=await memoryUi();await ui.evaluate("navigate('memory')");
 assert.equal(pagers(ui).length,2);assert.match(summary(ui),/第 1 页.*显示 1–12 条.*共 34 条/);assert.equal(ui.button(top(ui),'上一页').disabled,true);
 const seen=new Set(cards(ui).map(n=>n.textContent.match(/entry-\d+/)?.[0]));
 await move(ui,'下一页 →');assert.match(summary(ui),/第 2 页.*13–24/);cards(ui).forEach(n=>seen.add(n.textContent.match(/entry-\d+/)?.[0]));
 await move(ui,'下一页 →');assert.match(summary(ui),/第 3 页.*25–34/);cards(ui).forEach(n=>seen.add(n.textContent.match(/entry-\d+/)?.[0]));assert.equal(seen.size,34);assert.equal(ui.button(top(ui),'下一页 →').disabled,true);
 await move(ui,'上一页');assert.match(summary(ui),/第 2 页.*13–24/);await move(ui,'回到第一页');assert.match(summary(ui),/第 1 页.*1–12/);
 assert.equal(ui.calls.filter(c=>c.action==='memory.list').at(-1).args.cursor,undefined);assert.equal(ui.ids.get('global-error').hidden,true);
});

test('query and record type changes reset the memory cursor and empty state still explains navigation',async()=>{
 const ui=await memoryUi();await ui.evaluate("navigate('memory')");await move(ui,'下一页 →');ui.ids.get('memory-query').value='entry-31';await ui.button(content(ui),'搜索').emit('click');
 assert.match(summary(ui),/第 1 页.*共 1 条/);assert.equal(ui.calls.filter(c=>c.action==='memory.list').at(-1).args.cursor,undefined);assert.equal(ui.button(top(ui),'上一页').disabled,true);
 ui.ids.get('memory-type').value='deep';await ui.ids.get('memory-type').emit('change');await tick();assert.match(summary(ui),/未找到匹配条目.*共 0 条/);assert.equal(ui.button(top(ui),'下一页 →').disabled,true);assert.match(content(ui).textContent,/可以修改线索后重新查询/);
});

test('a changed result cursor prompts explicit reload instead of silently losing the next page',async()=>{
 let changed=false;const rows=records(36),ui=await memoryUi({'memory.list':args=>{if(args.cursor&&!changed){changed=true;throw Object.assign(new Error('changed'),{code:'MANAGEMENT_CURSOR_STALE'});}return page(rows,args);}});
 await ui.evaluate("navigate('memory')");await move(ui,'下一页 →');assert.match(content(ui).textContent,/资料在翻页期间发生了变化/);assert.equal(ui.calls.filter(c=>c.action==='memory.list').length,2);assert.equal(ui.ids.get('global-error').hidden,true);
 await ui.button(content(ui),'回到第一页重新读取').emit('click');assert.match(summary(ui),/第 1 页.*共 36 条/);assert.equal(ui.calls.filter(c=>c.action==='memory.list').length,3);
});

test('failed next-page reads do not advance the displayed page or corrupt retry position',async()=>{
 let fail=true;const rows=records(34),ui=await memoryUi({'memory.list':args=>{if(args.cursor&&fail){fail=false;throw Object.assign(new Error('temporary read failure'),{code:'READ_UNAVAILABLE'});}return page(rows,args);}});
 await ui.evaluate("navigate('memory')");await move(ui,'下一页 →');assert.match(summary(ui),/第 1 页/);assert.equal(ui.ids.get('global-error').hidden,false);await move(ui,'下一页 →');assert.match(summary(ui),/第 2 页.*13–24/);assert.equal(ui.ids.get('global-error').hidden,true);
});

test('late people pages cannot write another personality instance cache or visible list',async()=>{
 let entered,release;const pending=new Promise(r=>entered=r);
 const ui=await frontend({'people.list':args=>{if(args.pageSize===100)return{items:[]};if(args.instanceId==='default'){entered();return new Promise(r=>release=r);}return{items:[{personId:'new-person',displayName:'新实例人物'}],total:1,offset:0,nextCursor:null};}});
 const old=ui.evaluate("navigate('memory','people')");await pending;ui.evaluate("state.instanceId='other';state.people=[]");await ui.evaluate("navigate('memory','people')");release({items:[{personId:'old-person',displayName:'旧实例人物'}],total:1,offset:0,nextCursor:null});await old;
 assert.equal(ui.evaluate("state.people.some(p=>p.personId==='old-person')"),false);assert.match(content(ui).textContent,/新实例人物/);assert.doesNotMatch(content(ui).textContent,/旧实例人物/);assert.equal(ui.calls.find(c=>c.action==='people.list'&&c.args.pageSize===15).args.instanceId,'default');
});

test('34 known people use retained cursor history for previous and first-page navigation',async()=>{
 const rows=Array.from({length:34},(_,i)=>({personId:'person-'+i,displayName:'人物'+i})),ui=await frontend({'people.list':args=>args.pageSize===100?{items:[]}:page(rows,args)});
 await ui.evaluate("navigate('memory','people')");assert.match(summary(ui),/1–15.*共 34 条/);await move(ui,'下一页 →');assert.match(summary(ui),/第 2 页.*16–30/);await move(ui,'下一页 →');assert.match(summary(ui),/第 3 页.*31–34/);await move(ui,'上一页');assert.match(summary(ui),/第 2 页.*16–30/);await move(ui,'回到第一页');assert.match(summary(ui),/第 1 页.*1–15/);
});

test('bounded retrieval candidates retain all response-budget pages and explain their limited candidate scope',async()=>{
 const rows=records(34).map((row,i)=>({...row,title:'candidate-'+i,retrieval:{channels:['lexical']}})),ui=await frontend({'memory.search':args=>page(rows,args,7)});
 await ui.evaluate("navigate('memory','retrieval')");ui.ids.get('hybrid-query').value='meaning';await ui.button(content(ui),'查找记忆').emit('click');
 assert.match(content(ui).textContent,/最多保留前 100 条候选.*不代表全库条目总数/);const seen=new Set();
 for(let i=0;i<5;i++){cards(ui).forEach(n=>seen.add(n.textContent.match(/candidate-\d+/)?.[0]));if(i<4)await move(ui,'下一页 →');}
 assert.equal(seen.size,34);assert.match(summary(ui),/第 5 页.*29–34/);assert.equal(ui.button(top(ui),'下一页 →').disabled,true);await move(ui,'上一页');assert.match(summary(ui),/第 4 页.*22–28/);
 const searchCalls=ui.calls.filter(c=>c.action==='memory.search');assert.ok(searchCalls.every(c=>c.args.limit===100&&c.args.pageSize===12&&c.args.query==='meaning'));
 ui.ids.get('hybrid-mode').value='lexical';await ui.ids.get('hybrid-mode').emit('change');assert.equal(pagers(ui).length,0);assert.match(content(ui).textContent,/查询条件已修改/);const before=searchCalls.length;await ui.button(content(ui),'查找记忆').emit('click');assert.equal(ui.calls.filter(c=>c.action==='memory.search').length,before+1);assert.equal(ui.calls.filter(c=>c.action==='memory.search').at(-1).args.cursor,undefined);assert.match(summary(ui),/第 1 页.*1–7/);
});

test('refreshed waiting Bilibili QR is restored explicitly using the same unexpired flow',async()=>{
 const waiting={enabled:false,connected:false,accountId:null,hasCredentials:false,login:{flowId:'same-flow',phase:'waiting',expiresAt:Date.now()+60000},receipts:{retained:0,unresolved:0},limits:{receipts:512}};
 const ui=await frontend({'bilibili.inspect':()=>waiting,'bilibili.listReceipts':()=>({items:[],total:0,hasMore:false}),'bilibili.loginStart':()=>({...waiting,login:{...waiting.login,qrContent:'https://passport.bilibili.com/test-only',qrDataUrl:'data:image/svg+xml;base64,PHN2Zy8+'}})});
 await ui.evaluate("navigate('chat','bilibili')");assert.equal(ui.calls.some(c=>c.action==='bilibili.loginStart'),false);assert.match(content(ui).textContent,/页面刷新后未保留二维码图片/);await ui.button(content(ui),'重新显示本次二维码').emit('click');
 assert.equal(ui.calls.filter(c=>c.action==='bilibili.loginStart').length,1);assert.ok(ui.walk(content(ui)).some(n=>n.tagName==='img'&&n.src.startsWith('data:image/')));assert.equal([...ui.timers.values()].filter(t=>t.delay===2500).length,1);assert.equal(ui.ids.get('global-error').hidden,true);
});

test('QQ capability rows show human-readable names without changing grants',async()=>{
 const ids=['chat.mention','message.read','message.forward.read','media.cover'],ui=await frontend({'permissions.inspect':()=>({items:ids.map(id=>({id,supported:true,allowed:false,available:false}))})});
 await ui.evaluate("navigate('chat','qq-permissions')");for(const text of ['提及聊天对象','读取所引用的消息','读取合并转发内容','通过已配置服务制作翻唱'])assert.match(content(ui).textContent,new RegExp(text));assert.equal(ui.calls.some(c=>c.action==='permissions.configure'),false);
});


test('a successful list retry leaves unrelated errors visible',async()=>{
 let fail=true;const rows=records(34),ui=await memoryUi({'memory.list':args=>{if(args.cursor&&fail){fail=false;throw Object.assign(new Error('old list read'),{code:'READ_UNAVAILABLE'});}return page(rows,args);}});
 await ui.evaluate("navigate('memory')");await move(ui,'下一页 →');ui.evaluate("showError(Object.assign(new Error('unrelated settings error'),{code:'SETTINGS_FAILED'}))");await move(ui,'下一页 →');assert.match(summary(ui),/第 2 页/);assert.equal(ui.ids.get('global-error').hidden,false);assert.match(ui.ids.get('global-error').textContent,/SETTINGS_FAILED.*unrelated settings error/);
});

test('changing retrieval conditions clears busy state and suppresses the obsolete result',async()=>{
 let entered,release;const pending=new Promise(r=>entered=r),ui=await frontend({'memory.search':()=>{entered();return new Promise(r=>release=r);}});await ui.evaluate("navigate('memory','retrieval')");
 const search=ui.button(content(ui),'查找记忆').emit('click');await pending;ui.ids.get('hybrid-query').value='new condition';await ui.ids.get('hybrid-query').emit('input');release(page(records(34),{pageSize:12}));await search;assert.equal(pagers(ui).length,0);assert.match(content(ui).textContent,/查询条件已修改/);const busy=ui.walk(content(ui)).filter(n=>n.getAttribute('aria-busy')==='true');assert.equal(busy.length,0);
});


test('Bilibili expanded permission confirmation uses the same contextual names as all four rows',async()=>{
 const names={'feed.read':'浏览B站视频资料、字幕、评论和故事板','feed.publish':'在B站发表评论','message.reply':'在B站回复评论','chat.text':'发送B站私信或分享视频链接'},ui=await frontend({'permissions.inspect':()=>({items:Object.entries(names).map(([id,label])=>({id,label,supported:true,allowed:false,available:false}))})});
 await ui.evaluate("navigate('chat','bilibili-permissions')");const panel=content(ui);for(const node of ui.walk(panel).filter(n=>n.tagName==='input'&&n.type==='checkbox'))node.checked=true;
 const pending=ui.button(panel,'保存这些权限').emit('click');await tick();assert.equal(ui.ids.get('confirm-dialog').open,true);const preview=JSON.parse(ui.ids.get('confirm-preview').textContent);assert.deepEqual(preview['新增许可'],Object.values(names));assert.doesNotMatch(ui.ids.get('confirm-preview').textContent,/朋友圈|引用消息|发送文字/);assert.equal(ui.calls.some(c=>c.action==='permissions.configure'),false);ui.ids.get('confirm-dialog').close('cancel');await pending;assert.equal(ui.calls.some(c=>c.action==='permissions.configure'),false);
});



const revealCalls = ui => ui.calls.filter(call=>call.action==='ui.reveal');
test('memory initial rendering keeps focus while successful page and query reads request local host reveal',async()=>{
 const ui=await memoryUi();await ui.evaluate("navigate('memory')");assert.equal(revealCalls(ui).length,0);assert.equal(top(ui).getAttribute('tabindex'),null);
 await move(ui,'下一页 →');await tick();assert.equal(top(ui).getAttribute('data-reveal-state'),'revealed');assert.equal(revealCalls(ui).length,1);assert.equal(revealCalls(ui)[0].args.top,150);assert.deepEqual(Object.keys(revealCalls(ui)[0].args),['top']);assert.equal(top(ui).getAttribute('tabindex'),'-1');assert.equal(ui.focusEvents.at(-1).target,top(ui));assert.equal(ui.focusEvents.at(-1).options.preventScroll,true);
 ui.ids.get('memory-query').value='entry-31';await ui.button(content(ui),'搜索').emit('click');assert.equal(revealCalls(ui).length,2);assert.equal(ui.scrollEvents.some(event=>event.target.classList.contains('pagination-top')),false);
});

test('people pages and manually requested retrieval candidates ask the existing host port to reveal their first row',async()=>{
 const people=Array.from({length:34},(_,i)=>({personId:'p-'+i,displayName:'人物'+i})),rows=records(34).map((row,i)=>({...row,title:'candidate-'+i,retrieval:{channels:['lexical']}})),ui=await frontend({'people.list':args=>args.pageSize===100?{items:[]}:page(people,args),'memory.search':args=>page(rows,args)});
 await ui.evaluate("navigate('memory','people')");assert.equal(revealCalls(ui).length,0);await move(ui,'下一页 →');assert.equal(revealCalls(ui).length,1);assert.equal(revealCalls(ui).at(-1).args.top,150);
 await ui.evaluate("navigate('memory','retrieval')");assert.equal(revealCalls(ui).length,1);await ui.button(content(ui),'查找记忆').emit('click');assert.equal(revealCalls(ui).length,2);await move(ui,'下一页 →');assert.equal(revealCalls(ui).length,3);assert.equal(ui.scrollEvents.some(event=>event.target.classList.contains('pagination-top')),false);
});

test('failed or superseded memory page reads never request host reveal or move keyboard focus',async()=>{
 let entered,release,mode='fail';const pending=new Promise(r=>entered=r),rows=records(34),ui=await memoryUi({'memory.list':args=>{if(!args.cursor)return page(rows,args);if(mode==='fail'){mode='wait';throw new Error('temporary read error');}entered();return new Promise(r=>release=r);}});
 await ui.evaluate("navigate('memory')");await move(ui,'下一页 →');assert.equal(revealCalls(ui).length,0);const late=move(ui,'下一页 →');await pending;await ui.evaluate("navigate('memory')");const focusCount=ui.focusEvents.length;release(page(rows,{cursor:'offset:12',pageSize:12}));await late;assert.equal(revealCalls(ui).length,0);assert.equal(ui.focusEvents.length,focusCount);assert.match(summary(ui),/第 1 页/);
});

test('an older host without local reveal keeps successful results without a direct scroll fallback',async()=>{
 const ui=await memoryUi({'ui.reveal':()=>{throw Object.assign(new Error('unsupported local UI action'),{code:'LOCAL_UI_UNAVAILABLE'});}});await ui.evaluate("navigate('memory')");await move(ui,'下一页 →');await tick();assert.equal(top(ui).getAttribute('data-reveal-state'),'error');assert.equal(top(ui).getAttribute('data-reveal-code'),'LOCAL_UI_UNAVAILABLE');assert.match(top(ui).getAttribute('data-reveal-message'),/unsupported local UI action/);assert.match(summary(ui),/第 2 页.*13–24/);assert.equal(ui.ids.get('global-error').hidden,true);assert.equal(ui.scrollEvents.some(event=>event.target.classList.contains('pagination-top')),false);
});
