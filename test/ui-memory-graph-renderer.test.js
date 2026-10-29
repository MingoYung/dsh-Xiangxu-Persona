import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../ui/memory-graph.js', import.meta.url), 'utf8');
function target() {
  const listeners = new Map();
  return { listeners, addEventListener(name, fn) { const list = listeners.get(name) ?? new Set(); list.add(fn); listeners.set(name, list); },
    removeEventListener(name, fn) { const list = listeners.get(name); list?.delete(fn); if (!list?.size) listeners.delete(name); },
    emit(name, props = {}) { let prevented = false; const event = { pointerId: 1, button: 0, buttons: 1, pointerType: 'mouse', clientX: 0, clientY: 0,
      preventDefault() { prevented = true; }, ...props }; for (const fn of [...(listeners.get(name) ?? [])]) fn(event); return { prevented }; } };
}
function fixture({ raf = true, observers = true, dpr = 1, tabindex = null, reducedMotion = false } = {}) {
  const frames = [], scheduled = new Map(), watched = [], captures = new Set(), selections = [], contexts = [], document = { ...target(), visibilityState: 'visible', activeElement: null };
  let nextFrame = 1, rect = { left: 10, top: 20, width: 600, height: 400 }, path = [], frame;
  const drawing = { globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    setTransform(...values) { this.transform = values; }, clearRect() { frame = []; frames.push(frame); }, fillRect(...values) { frame.push({ type: 'background', values, color: this.fillStyle }); },
    beginPath() { path = []; }, moveTo(x, y) { path.push({ type: 'move', x, y }); }, lineTo(x, y) { path.push({ type: 'line', x, y }); },
    arc(x, y, radius) { path.push({ type: 'arc', x, y, radius }); }, fill() { for (const part of path) frame.push({ ...part, type: 'node', color: this.fillStyle, alpha: this.globalAlpha }); },
    stroke() { frame.push({ type: 'stroke', path: path.map(part => ({ ...part })), color: this.strokeStyle, alpha: this.globalAlpha, width: this.lineWidth }); },
    measureText(text) { return { width: Array.from(text).reduce((sum, char) => sum + (/[^\x00-\x7f]/.test(char) ? 12 : 7), 0) }; },
    fillText(text, x, y) { frame.push({ type: 'label', text, x, y, color: this.fillStyle }); } };
  const attributes = new Map(tabindex === null ? [] : [['tabindex', tabindex]]), canvas = { ...target(), ownerDocument: document, style: { touchAction: 'pan-y' }, width: 0, height: 0,
    getContext(kind) { contexts.push(kind); return kind === '2d' ? drawing : null; }, getBoundingClientRect: () => rect,
    getAttribute: name => attributes.get(name) ?? null, setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name),
    focus() { document.activeElement = this; this.emit('focus'); }, blur() { document.activeElement = null; this.emit('blur'); },
    setPointerCapture(id) { captures.add(id); }, releasePointerCapture(id) { captures.delete(id); } };
  const globals = { ...target(), document, devicePixelRatio: dpr,
    setTimeout() { throw new Error('A memory graph must not start timers'); }, setInterval() { throw new Error('A memory graph must not start intervals'); },
    fetch() { throw new Error('A memory graph must not request data or a model'); } };
  if (raf) { globals.requestAnimationFrame = fn => { const id = nextFrame++; scheduled.set(id, fn); return id; }; globals.cancelAnimationFrame = id => scheduled.delete(id); }
  if (observers) for (const name of ['ResizeObserver', 'IntersectionObserver']) globals[name] = class {
    constructor(callback) { this.name = name; this.callback = callback; this.disconnected = false; watched.push(this); }
    observe(value) { this.target = value; } disconnect() { this.disconnected = true; }
    trigger(value = true) { this.callback(name === 'IntersectionObserver' ? [{ target: canvas, isIntersecting: value }] : []); }
  };
  const realm = vm.createContext(globals); vm.runInContext(source, realm);
  const api = realm.XiangxuMemoryGraph.create(canvas, { onSelect: value => selections.push(value), reducedMotion,
    colors: { text: '#text', node: '#node', edge: '#edge', selected: '#selected', neighbor: '#neighbor', kinds: { source: '#source', person: '#person' } } });
  const flush = () => { const batch = [...scheduled.values()]; scheduled.clear(); for (const fn of batch) fn(); };
  const current = () => frames.at(-1) ?? [], nodes = () => current().filter(item => item.type === 'node');
  const pointer = (name, point, extra = {}) => canvas.emit(name, { clientX: point.x + rect.left, clientY: point.y + rect.top, ...extra });
  return { api, canvas, document, globals, realm, frames, scheduled, watched, captures, selections, contexts, drawing, attributes, flush, current, nodes, pointer,
    rect(value) { rect = { ...rect, ...value }; }, setData(data) { const result = api.setData(data); flush(); return result; } };
}
const data = (count = 8) => ({ nodes: Array.from({ length: count }, (_, i) => ({ id: 'record-' + i, label: '真实条目 ' + i, kind: i === 0 ? 'source' : i === 1 ? 'person' : 'record', recordKey: '["chat","person","a","' + i + '"]' })),
  edges: [{ source: 'record-0', target: 'record-1', kind: 'source', basis: 'stored source ref' }, { source: 'record-1', target: 'record-2', kind: 'subject' }, { source: 'record-3', target: 'record-4', kind: 'related' }] });
const positions = ui => ui.nodes().map(({ x, y, radius }) => ({ x, y, radius }));

test('the shipped renderer uses one Canvas2D context, genuine perspective depth and deterministic static frames', () => {
  const ui = fixture(), graph = data(); const untouched = JSON.stringify(graph), stats = ui.setData(graph);
  assert.deepEqual(ui.contexts, ['2d']); assert.equal(stats.nodes, 8); assert.equal(stats.edges, 3); assert.equal(JSON.stringify(graph), untouched);
  const scene = ui.nodes(); assert.equal(scene.length, 8); assert.ok(new Set(scene.map(point => point.radius.toFixed(4))).size > 1, '3D depth must affect perspective size');
  assert.ok(scene.every((point, i) => Number.isFinite(point.x) && Number.isFinite(point.y) && (i === 0 || point.radius >= scene[i - 1].radius)), 'far nodes paint before nearer nodes');
  const count = ui.frames.length; ui.flush(); assert.equal(ui.frames.length, count); assert.equal(ui.scheduled.size, 0, 'a frame never schedules its successor');
  const initial = positions(ui); ui.api.reset(); ui.flush(); assert.deepEqual(positions(ui), initial);
  ui.api.setMode('2d'); ui.flush(); assert.equal(new Set(ui.nodes().map(point => point.radius)).size, 1, 'flat mode has no perspective depth'); ui.api.dispose();
});

test('clicks return the exact original node and selection highlights only supplied neighboring links', () => {
  const ui = fixture(), graph = data(); ui.setData(graph); const front = ui.nodes().at(-1);
  ui.pointer('pointerdown', front); ui.pointer('pointerup', front); ui.flush(); assert.equal(ui.selections.length, 1); assert.ok(graph.nodes.includes(ui.selections[0]), 'no synthetic node replaces the source object');
  ui.api.select('record-1'); ui.flush(); assert.equal(ui.selections.length, 1, 'a programmatic keyboard-list selection does not feed back into onSelect');
  const lines = ui.current().filter(item => item.type === 'stroke' && item.path[0]?.type === 'move' && item.path.length === 2);
  assert.equal(lines.filter(item => item.color === '#selected').length, 2); assert.equal(lines.filter(item => item.color === '#edge' && item.alpha < .3).length, 1);
  assert.ok(ui.nodes().some(item => item.color === '#selected')); assert.ok(ui.nodes().some(item => item.color === '#neighbor'));
  ui.api.select('missing'); ui.flush(); assert.equal(ui.current().filter(item => item.type === 'stroke' && item.color === '#selected').length, 0); ui.api.dispose();
});

test('dragging rotates 3D without clicking, flat dragging pans, and reset restores the view', () => {
  const ui = fixture(); ui.setData(data()); const initial = positions(ui), start = { x: 280, y: 180 }, end = { x: 340, y: 205 };
  ui.pointer('pointerdown', start); ui.pointer('pointermove', end); ui.pointer('pointerup', end); ui.flush();
  assert.notDeepEqual(positions(ui), initial); assert.equal(ui.selections.length, 0); assert.equal(ui.captures.size, 0);
  ui.api.reset(); ui.flush(); assert.deepEqual(positions(ui), initial);
  ui.api.setMode('2d'); ui.flush(); const flat = positions(ui); ui.pointer('pointerdown', start); ui.pointer('pointermove', end); ui.pointer('pointerup', end); ui.flush();
  positions(ui).forEach((point, i) => { assert.equal(point.x, flat[i].x + 60); assert.equal(point.y, flat[i].y + 25); });
  assert.equal(ui.selections.length, 0); ui.api.dispose();
});

test('wheel zoom requires intentional focus, Escape and blur return page scrolling, and controls have keyboard equivalents', () => {
  const ui = fixture({ dpr: 4 }); ui.setData(data()); const initial = positions(ui);
  assert.equal(ui.canvas.width, 1200); assert.equal(ui.canvas.height, 800); assert.deepEqual(ui.drawing.transform, [2, 0, 0, 2, 0, 0]);
  assert.equal(ui.canvas.emit('wheel', { deltaY: -100 }).prevented, false); assert.equal(ui.scheduled.size, 0);
  ui.canvas.focus(); assert.equal(ui.canvas.style.touchAction, 'none'); assert.equal(ui.canvas.emit('wheel', { deltaY: -100 }).prevented, true); ui.flush(); assert.notDeepEqual(positions(ui), initial);
  ui.canvas.blur(); assert.equal(ui.canvas.style.touchAction, 'pan-y'); assert.equal(ui.canvas.emit('wheel', { deltaY: -100 }).prevented, false);
  ui.api.reset(); ui.flush(); ui.api.zoomIn(); ui.flush(); const larger = positions(ui); assert.notDeepEqual(larger, initial); ui.api.zoomOut(); ui.flush(); assert.deepEqual(positions(ui), initial);
  ui.canvas.focus(); assert.equal(ui.canvas.emit('keydown', { key: '+' }).prevented, true); ui.flush(); assert.notDeepEqual(positions(ui), initial);
  ui.canvas.emit('keydown', { key: '0' }); ui.flush(); assert.deepEqual(positions(ui), initial);
  ui.canvas.emit('keydown', { key: 'Escape' }); assert.equal(ui.document.activeElement, null); assert.equal(ui.canvas.emit('wheel', { deltaY: 100 }).prevented, false);
  ui.api.zoom(Infinity); assert.equal(ui.scheduled.size, 0); ui.api.dispose();
});

test('touch pinch zooms, cancelled or lost captures never select a node and release every pointer', () => {
  const ui = fixture(); ui.setData(data()); const initial = positions(ui);
  ui.canvas.focus(); ui.pointer('pointerdown', { x: 100, y: 120 }, { pointerId: 1, pointerType: 'touch' }); ui.pointer('pointerdown', { x: 200, y: 120 }, { pointerId: 2, pointerType: 'touch' });
  ui.pointer('pointermove', { x: 260, y: 120 }, { pointerId: 2, pointerType: 'touch' }); ui.flush(); assert.notDeepEqual(positions(ui), initial);
  ui.pointer('pointercancel', { x: 100, y: 120 }, { pointerId: 1, pointerType: 'touch' }); assert.equal(ui.captures.size, 0);
  const afterCancel = ui.frames.length; ui.pointer('pointermove', { x: 300, y: 120 }, { pointerId: 2, pointerType: 'touch' }); ui.pointer('pointerup', { x: 300, y: 120 }, { pointerId: 2, pointerType: 'touch' }); ui.flush();
  assert.equal(ui.frames.length, afterCancel); assert.equal(ui.selections.length, 0);
  const front = ui.nodes().at(-1); ui.pointer('pointerdown', front); ui.canvas.emit('lostpointercapture'); ui.pointer('pointerup', front); assert.equal(ui.selections.length, 0); assert.equal(ui.captures.size, 0); ui.api.dispose();
});

test('large inputs have bounded scanning, layout and paint with honest omission counts and no invented edges', () => {
  const ui = fixture({ reducedMotion: true }), graph = { nodes: Array.from({ length: 10000 }, (_, i) => ({ id: 'n' + i, label: 'Node ' + i, kind: 'record' })),
    edges: Array.from({ length: 10000 }, (_, i) => ({ source: 'n' + i % 120, target: 'n' + (i % 120 + 1 + Math.floor(i / 120)) % 120, kind: 'declared' })) };
  Object.defineProperty(graph.nodes[120], 'id', { get() { throw new Error('nodes beyond the renderer cap must not be read'); } });
  Object.defineProperty(graph.edges[200], 'source', { get() { throw new Error('edges beyond the renderer cap must not be read'); } });
  const stats = ui.setData(graph); assert.equal(stats.nodes, 120); assert.equal(stats.edges, 200); assert.equal(stats.omittedNodes, 9880); assert.equal(stats.omittedEdges, 9800);
  assert.equal(ui.nodes().length, 120); assert.equal(ui.current().filter(item => item.type === 'stroke').length, 200); assert.equal(ui.scheduled.size, 0);
  const frameCount = ui.frames.length; ui.flush(); assert.equal(ui.frames.length, frameCount);
  const malformed = ui.setData({ nodes: [{ key: 'same', id: 'other', label: 'Uses key' }, { id: 'same' }, { id: 'b' }, null], edges: [{ source: 'same', target: 'b', kind: 'ref' }, { source: 'same', target: 'b', kind: 'ref' }, { source: 'same', target: 'missing' }, { source: 'same', target: 'same' }] });
  assert.equal(malformed.nodes, 2); assert.equal(malformed.edges, 1); assert.equal(malformed.omittedNodes, 2); assert.equal(malformed.omittedEdges, 3); ui.api.dispose();
});

test('hidden, offscreen and zero-size canvases cancel pending work until visible and do not run animation loops', () => {
  const ui = fixture(); ui.setData(data()); ui.api.zoomIn(); assert.equal(ui.scheduled.size, 1);
  ui.document.visibilityState = 'hidden'; ui.document.emit('visibilitychange'); assert.equal(ui.scheduled.size, 0);
  const count = ui.frames.length; ui.api.zoomIn(); ui.api.resize(); ui.flush(); assert.equal(ui.frames.length, count);
  const intersection = ui.watched.find(item => item.name === 'IntersectionObserver'); intersection.trigger(false);
  ui.document.visibilityState = 'visible'; ui.document.emit('visibilitychange'); assert.equal(ui.scheduled.size, 0);
  intersection.trigger(true); assert.equal(ui.scheduled.size, 1); ui.flush(); assert.equal(ui.frames.length, count + 1); assert.equal(ui.scheduled.size, 0);
  ui.rect({ width: 0, height: 0 }); ui.api.resize(); ui.api.zoomIn(); ui.flush(); assert.equal(ui.frames.length, count + 1);
  ui.rect({ width: 500, height: 350 }); ui.watched.find(item => item.name === 'ResizeObserver').trigger(); ui.flush(); assert.equal(ui.canvas.width, 500); assert.equal(ui.frames.length, count + 2); ui.api.dispose();
});

test('dispose removes all listeners, observers, captures and frames, preserving existing canvas attributes', () => {
  const ui = fixture({ tabindex: '7' }); ui.setData(data()); ui.canvas.focus(); ui.pointer('pointerdown', { x: 120, y: 90 }); ui.api.zoomIn();
  const stale = [...ui.scheduled.values()], count = ui.frames.length; assert.ok(ui.canvas.listeners.size > 0); assert.ok(ui.document.listeners.size > 0); assert.ok(ui.globals.listeners.size > 0);
  ui.api.dispose(); ui.api.dispose(); assert.equal(ui.scheduled.size, 0); assert.equal(ui.captures.size, 0); assert.equal(ui.canvas.listeners.size, 0); assert.equal(ui.document.listeners.size, 0); assert.equal(ui.globals.listeners.size, 0);
  assert.ok(ui.watched.every(item => item.disconnected)); assert.equal(ui.attributes.get('tabindex'), '7'); assert.equal(ui.canvas.style.touchAction, 'pan-y');
  for (const callback of stale) callback(); for (const observer of ui.watched) observer.trigger(); ui.api.resize(); ui.api.reset(); ui.api.select('record-1'); ui.api.setMode('2d'); ui.api.zoomIn(); ui.api.setColors({ node: '#new' }); ui.api.setData(data()); ui.flush();
  assert.equal(ui.frames.length, count); assert.equal(ui.selections.length, 0);
  const other = fixture(); assert.equal(other.attributes.get('tabindex'), '0'); other.api.dispose(); assert.equal(other.attributes.has('tabindex'), false);
});

test('theme colors refresh without rebuilding, and browsers without observers or rAF remain usable', () => {
  const ui = fixture({ observers: false, raf: false }); ui.setData(data()); const count = ui.frames.length;
  ui.api.setColors({ background: '#background-new', text: '#text-new', node: '#node-new', kinds: { source: '#source-new' } });
  assert.equal(ui.frames.length, count + 1); assert.ok(ui.current().some(item => item.type === 'background' && item.color === '#background-new'));
  assert.ok(ui.nodes().some(item => item.color === '#source-new')); assert.ok(ui.nodes().some(item => item.color === '#node-new')); assert.equal(ui.scheduled.size, 0);
  ui.api.setData(null); assert.equal(ui.nodes().length, 0); ui.api.dispose(); assert.equal(ui.canvas.listeners.size, 0);
});

test('crowded labels reserve the selected name, avoid each other and stay inside the canvas without dropping nodes or edges', () => {
  const ui = fixture(); ui.rect({ width: 250, height: 170 }); ui.api.resize();
  const graph = data(17); for (const node of graph.nodes) node.label = node.id === 'record-9' ? '重要的摄影与热茶回忆' : '有些拥挤的完整记忆标题-' + node.id;
  ui.setData(graph); ui.api.select('record-9'); ui.flush();
  const labels = ui.current().filter(item => item.type === 'label'); assert.ok(labels.length > 0); assert.ok(labels.length < graph.nodes.length, 'unplaceable names are hidden instead of overlapping');
  assert.equal(labels.filter(item => item.color === '#selected').length, 1); assert.equal(labels.at(-1).text, '重要的摄影与热茶回忆', 'the selected name keeps first choice and paints last');
  const boxes = labels.map(item => ({ x: item.x - 4, y: item.y - 10, width: ui.drawing.measureText(item.text).width + 8, height: 20 }));
  for (const box of boxes) assert.ok(box.x >= 7 && box.y >= 7 && box.x + box.width <= 243 && box.y + box.height <= 163, 'the whole text box fits within the visible canvas');
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j]; assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, 'placed text boxes do not overlap');
  }
  assert.equal(ui.nodes().length, 17); assert.equal(ui.current().filter(item => item.type === 'stroke' && ['#edge', '#selected'].includes(item.color) && item.path[0]?.type === 'move' && item.path.length === 2).length, 3, 'the supplied relationship lines remain intact');
  const frames = ui.frames.length; ui.flush(); assert.equal(ui.frames.length, frames); assert.equal(ui.scheduled.size, 0);
  ui.rect({ width: 90, height: 70 }); ui.api.resize(); ui.flush();
  const selected = ui.current().find(item => item.type === 'label' && item.color === '#selected'); assert.ok(selected); assert.match(selected.text, /…$/); assert.ok(selected.x - 4 >= 7 && selected.x + ui.drawing.measureText(selected.text).width + 4 <= 83);
  ui.api.dispose();
});

test('extreme CSS sizes and high DPR keep a hard pixel budget without changing projection or pointer coordinates', () => {
  const ui = fixture({ dpr: 32 }), graph = data(); ui.setData(graph); const normal = positions(ui);
  assert.equal(ui.canvas.width, 1200); assert.equal(ui.canvas.height, 800);
  ui.rect({ width: 12000, height: 8000 }); ui.api.resize(); ui.flush();
  assert.ok(ui.canvas.width <= 2048 && ui.canvas.height <= 2048); assert.ok(ui.canvas.width * ui.canvas.height <= 2097152);
  const enlarged = positions(ui); enlarged.forEach((point, i) => { assert.ok(Math.abs(point.x / 20 - normal[i].x) < 1e-8); assert.ok(Math.abs(point.y / 20 - normal[i].y) < 1e-8); });
  for (const size of [{ width: 12000, height: 8000 }, { width: 1e10, height: 16 }, { width: 1e200, height: 1e200 }]) {
    ui.rect(size); ui.api.resize(); ui.flush();
    assert.ok(Number.isSafeInteger(ui.canvas.width) && Number.isSafeInteger(ui.canvas.height));
    assert.ok(ui.canvas.width >= 1 && ui.canvas.height >= 1 && ui.canvas.width <= 2048 && ui.canvas.height <= 2048);
    assert.ok(ui.canvas.width * ui.canvas.height <= 2097152, 'actual buffer area, including integer rounding, stays within the cap');
    const transform = ui.drawing.transform; assert.ok(transform.every(Number.isFinite)); assert.ok(transform[0] < 1, 'effective raster density may be lower than one');
    const front = ui.nodes().at(-1), displayedX = front.x * transform[0] * size.width / ui.canvas.width, displayedY = front.y * transform[3] * size.height / ui.canvas.height;
    assert.ok(Math.abs(displayedX - front.x) <= Math.max(1, Math.abs(front.x)) * 1e-12);
    assert.ok(Math.abs(displayedY - front.y) <= Math.max(1, Math.abs(front.y)) * 1e-12);
    const before = ui.selections.length; ui.pointer('pointerdown', front); ui.pointer('pointerup', front); ui.flush();
    assert.equal(ui.selections.length, before + 1); assert.ok(graph.nodes.includes(ui.selections.at(-1)), 'the visibly projected point remains selectable using CSS-space pointer coordinates');
  }
  ui.api.dispose();
});
