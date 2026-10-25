import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { JsonStore, atomicReplaceWithRetry } from '../core/store.js';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-storage-'));
  const store = new JsonStore(root, options); await store.open();
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, store };
}
test('prepared multi-file WAL recovers the entire batch after a fault between writes', async (t) => {
  let enabled = false;
  const { root, store } = await fixture(t, { fault: (phase, details) => {
    if (enabled && phase === 'after_apply' && details.path === 'a.json') throw new Error('injected power loss');
  } });
  await store.transaction({ runId: 'baseline', json: { 'a.json': { version: 1, value: 'old' }, 'b.json': { version: 1, value: 'old' } } });
  enabled = true;
  await assert.rejects(store.transaction({ runId: 'batch', json: { 'a.json': { version: 2, value: 'new' }, 'b.json': { version: 2, value: 'new' } }, expectedVersions: { 'a.json': 1, 'b.json': 1 } }), /power loss/);
  await assert.rejects(store.readJson('b.json'), { code: 'RECOVERY_REQUIRED' });
  await store.close();
  const recovered = new JsonStore(root); await recovered.open(); t.after(() => recovered.close());
  assert.equal((await recovered.readJson('a.json')).value, 'new');
  assert.equal((await recovered.readJson('b.json')).value, 'new');
  const retry = await recovered.transaction({ runId: 'batch', json: { 'a.json': { version: 2, value: 'new' }, 'b.json': { version: 2, value: 'new' } } });
  assert.equal(retry.duplicate, true);
  await recovered.close();
});
test('optimistic versions fail before WAL is prepared and do not change either file', async (t) => {
  const { store } = await fixture(t);
  await store.transaction({ runId: 'first', json: { 'a.json': { version: 3 } } });
  await assert.rejects(store.transaction({ runId: 'stale', json: { 'a.json': { version: 4 }, 'b.json': {} }, expectedVersions: { 'a.json': 2 } }), { code: 'VERSION_CONFLICT' });
  assert.equal((await store.readJson('a.json')).version, 3);
  assert.equal(await store.readJson('b.json'), null);
});
test('a live process writer lock prevents a second instance, including the same process', async (t) => {
  const { root, store } = await fixture(t);
  const second = new JsonStore(root);
  await assert.rejects(second.open(), { code: 'WRITER_LOCKED' });
  await store.close(); await second.open(); await second.close();
});
test('relative paths and symlink boundaries protect files outside the memory root', async (t) => {
  const { root, store } = await fixture(t);
  for (const unsafe of ['../outside.json', 'a/../../outside', 'C:/outside', '/outside', 'a\\outside', 'a/./outside', 'writer.lock', '.wal/evil.json']) {
    await assert.rejects(store.transaction({ runId: unsafe, json: { [unsafe]: {} } }), { code: 'UNSAFE_PATH' });
  }
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(root, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.readJson('junction/secret.json'), { code: 'UNSAFE_PATH' });
});
test('JSONL replacement is durable, strict and transaction run IDs cannot be repurposed', async (t) => {
  const { store } = await fixture(t);
  await store.transaction({ runId: 'lines', jsonl: { 'nested/stream.jsonl': [{ id: 1 }, { id: 2 }] } });
  assert.deepEqual(await store.readLines('nested/stream.jsonl'), [{ id: 1 }, { id: 2 }]);
  await assert.rejects(store.transaction({ runId: 'lines', jsonl: { 'nested/stream.jsonl': [] } }), { code: 'RUN_ID_REUSED' });
});
test('a terminated writer leaves a stale lock and WAL that a new process owner recovers', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-crash-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storeUrl = pathToFileURL(path.resolve('core/store.js')).href;
  const code = 'import {JsonStore} from ' + JSON.stringify(storeUrl) + ';' +
    'const store = new JsonStore(' + JSON.stringify(root) + ',{fault:(phase,details)=>{if(phase==="after_apply" && details.path==="a.json")process.exit(37)}});' +
    'await store.open(); await store.transaction({runId:"power",json:{"a.json":{version:1},"b.json":{version:1}}});';
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 37, child.stderr);
  const recovered = new JsonStore(root); await recovered.open();
  assert.equal((await recovered.readJson('a.json')).version, 1);
  assert.equal((await recovered.readJson('b.json')).version, 1);
  await recovered.close();
});
test('transient Windows replacement contention retries without deleting the live target', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-rename-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'state.tmp'), target = path.join(directory, 'state.json');
  await fs.writeFile(source, 'new'); await fs.writeFile(target, 'old'); let attempts = 0;
  await atomicReplaceWithRetry(source, target, { delays: [0, 0], rename: async (a, b) => {
    attempts++; assert.equal(await fs.readFile(b, 'utf8'), 'old');
    if (attempts < 3) throw Object.assign(new Error('file reader currently holds target'), { code: attempts === 1 ? 'EPERM' : 'EBUSY' });
    await fs.rename(a, b);
  } });
  assert.equal(attempts, 3); assert.equal(await fs.readFile(target, 'utf8'), 'new');
  await fs.writeFile(source, 'never installed'); attempts = 0;
  await assert.rejects(atomicReplaceWithRetry(source, target, { delays: [0, 0], rename: async () => { attempts++; throw Object.assign(new Error('still busy'), { code: 'EACCES' }); } }), { code: 'EACCES' });
  assert.equal(attempts, 3); assert.equal(await fs.readFile(target, 'utf8'), 'new');
});
