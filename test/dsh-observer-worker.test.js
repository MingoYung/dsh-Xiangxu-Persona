import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {observerSource} from '../scripts/dsh-real-lifecycle.mjs';

async function fixture(t, {direct = false, restored = false} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'xiangxu-worker-observer-'));
  t.after(async () => {assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/')); await rm(root, {recursive: true, force: true});});
  const file = join(root, 'observer.mjs'); await writeFile(file, observerSource);
  const module = await import(pathToFileURL(file).href);
  const handlers = new Map(), events = [], trusted = new Set();
  const coordinator = {runtime: null, taskIsolation: {isWorkerSession(id) {return trusted.has(id);}},
    async attachAgent(agent) {events.push(['attach', agent.id]);}};
  let release;
  const manager = direct ? coordinator : {getCoordinator() {return coordinator;},
    async attachAgent(agent) {return coordinator.attachAgent(agent);}, get runtime() {return coordinator.runtime;}};
  manager.ready = restored ? new Promise(resolve => {release = () => {trusted.add('worker'); resolve();};}) : Promise.resolve();
  const presets = {async select(_ctx, name) {events.push(['select', name]);}, async mount(_ctx, name) {events.push(['mount', name]);},
    composedPreset() {return 'persona-memory';}, serviceFor() {return null;}, inspectCompositions() {return [];}};
  const adapter = {async prepareCall() {return {async *stream() {throw Error('No provider may run in worker observer fixtures');}};}};
  module.apply({on(name, callback) {handlers.set(name, callback);},
    get(name) {return name === 'personaMemory' ? manager : name === 'agentPresets' ? presets : null;},
    llm: {registration() {return {adapter};}}}, {provider: 'fixed-fixture', artifacts: root});
  const agent = (id, header = {}) => ({id, session: {id, header}, ctx: {tools: {restrict() {events.push(['restrict', id]);}}}});
  return {events, trusted, manager, coordinator, agent, release, created: handlers.get('agent/created')};
}

test('observer leaves trusted delegated workers on their independent preset and tools', async t => {
  const f = await fixture(t); f.trusted.add('worker');
  await f.created({agent: f.agent('worker', {agentPreset: 'xiangxu-task-worker'}), source: 'new'});
  assert.deepEqual(f.events, []);
});

test('observer waits for manager role recovery before handling a cold worker', async t => {
  const f = await fixture(t, {restored: true});
  const pending = f.created({agent: f.agent('worker'), source: 'resume'});
  try {await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(f.events, []);}
  finally {f.release();}
  await pending; assert.deepEqual(f.events, []);
});

test('revoked worker role tombstones are still isolated after resume', async t => {
  const f = await fixture(t, {direct: true}); f.trusted.add('revoked-worker');
  await f.created({agent: f.agent('revoked-worker'), source: 'resume'});
  assert.deepEqual(f.events, []);
});

test('ordinary parent mounting and inherited-tool mask still work', async t => {
  const f = await fixture(t);
  await f.created({agent: f.agent('parent'), source: 'new'});
  assert.deepEqual(f.events, [['select', 'persona-memory'], ['attach', 'parent'], ['restrict', 'parent']]);
  f.events.length = 0;
  await f.created({agent: f.agent('parent'), source: 'resume'});
  assert.deepEqual(f.events, [['mount', 'persona-memory'], ['attach', 'parent'], ['restrict', 'parent']]);
});

test('a header claiming the worker preset is not a trusted worker registration', async t => {
  const f = await fixture(t);
  await f.created({agent: f.agent('ordinary', {agentPreset: 'xiangxu-task-worker'}), source: 'new'});
  assert.deepEqual(f.events, [['select', 'persona-memory'], ['attach', 'ordinary'], ['restrict', 'ordinary']]);
});
