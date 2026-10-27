import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createBilibiliStorage } from '../adapters/dsh/bilibili/storage.js';
import { createBilibiliService } from '../adapters/dsh/bilibili/service.js';

async function temporary(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiangxu-bili-deadpid-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return { root, file: path.join(root, 'bilibili.json') }; }
async function worker(t, file, { prepared = false, memoryRoot = path.dirname(file) } = {}) {
  const storageModule = new URL('../adapters/dsh/bilibili/storage.js', import.meta.url).href, serviceModule = new URL('../adapters/dsh/bilibili/service.js', import.meta.url).href;
  const source = prepared
    ? `import {createBilibiliService} from ${JSON.stringify(serviceModule)};const service=createBilibiliService({registryPath:${JSON.stringify(file)},authorize:async()=>true,fetchImpl:async(url,options)=>{if(options.method==='GET'&&new URL(url).pathname==='/x/web-interface/nav')return new Response(JSON.stringify({code:0,data:{isLogin:true,mid:1234,uname:'fixture'}}));process.send({kind:'sending'});return new Promise(()=>{});}});await service.ready;process.on('message',async value=>{if(value==='go')void service.execute({operation:'message',receiverUid:'55',text:'prepared crash fixture'},{memoryRoot:${JSON.stringify(memoryRoot)},accountId:'1234',deliveryId:'crashed-send'}).catch(error=>process.send({kind:'result',status:'error',code:error.code}));});process.send({kind:'ready',pid:process.pid});`
    : `import {createBilibiliStorage} from ${JSON.stringify(storageModule)};const storage=createBilibiliStorage(${JSON.stringify(file)});process.on('message',async value=>{if(value==='go'){try{await storage.acquire();process.send({kind:'result',status:'owned',pid:process.pid});}catch(error){process.send({kind:'result',status:'error',code:error.code,pid:process.pid});}}else if(value==='release'){await storage.release();process.send({kind:'released'});process.exit(0);}});process.send({kind:'ready',pid:process.pid});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }), messages = [], waiters = []; let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes.toString().slice(0, 2000); });
  child.on('message', message => { const at = waiters.findIndex(item => item.kind === message.kind); if (at < 0) messages.push(message); else { const [waiter] = waiters.splice(at, 1); clearTimeout(waiter.timer); waiter.resolve(message); } });
  function wait(kind) { const at = messages.findIndex(item => item.kind === kind); if (at >= 0) return Promise.resolve(messages.splice(at, 1)[0]); return new Promise((resolve, reject) => { const entry = { kind, resolve, timer: setTimeout(() => { const at = waiters.indexOf(entry); if (at >= 0) waiters.splice(at, 1); reject(new Error('Local worker timed out: ' + kind + ' ' + stderr)); }, 5000) }; waiters.push(entry); }); }
  async function kill() { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  t.after(kill); await wait('ready');
  return { child, wait, send: value => child.send(value), kill, get pid() { return child.pid; } };
}
async function crashedOwner(t, file) { const owner = await worker(t, file); owner.send('go'); assert.equal((await owner.wait('result')).status, 'owned'); const bytes = await fs.readFile(file + '.lock'); await owner.kill(); assert.throws(() => process.kill(owner.pid, 0), { code: 'ESRCH' }); return { owner, bytes }; }

test('a real child process crash leaves its lock intact and a new Bilibili writer conservatively recovers it', { timeout: 10000 }, async t => {
  const { file } = await temporary(t), { owner, bytes } = await crashedOwner(t, file); assert.equal(JSON.parse(bytes).pid, owner.pid); assert.deepEqual(await fs.readFile(file + '.lock'), bytes);
  const storage = createBilibiliStorage(file); t.after(() => storage.release()); await storage.acquire(); const recovered = JSON.parse(await fs.readFile(file + '.lock')); assert.equal(recovered.pid, process.pid); assert.notEqual(recovered.token, JSON.parse(bytes).token);
  await storage.write({ recovered: true }); assert.deepEqual(await storage.read(), { recovered: true }); await storage.release(); await assert.rejects(fs.lstat(file + '.lock'), { code: 'ENOENT' }); await assert.rejects(fs.lstat(file + '.lock.recovery'), { code: 'ENOENT' });
});

test('two real recovering processes admit one live writer and neither loser nor later acquirer removes the winner', { timeout: 15000 }, async t => {
  const { file } = await temporary(t); await crashedOwner(t, file); const first = await worker(t, file), second = await worker(t, file); first.send('go'); second.send('go');
  const results = await Promise.all([first.wait('result'), second.wait('result')]); assert.equal(results.filter(value => value.status === 'owned').length, 1); assert.equal(results.filter(value => value.status === 'error' && value.code === 'BILI_WRITER_LOCKED').length, 1);
  const winner = results[0].status === 'owned' ? first : second, before = await fs.readFile(file + '.lock'); assert.equal(JSON.parse(before).pid, winner.pid); process.kill(winner.pid, 0);
  const later = createBilibiliStorage(file); await assert.rejects(later.acquire(), { code: 'BILI_WRITER_LOCKED' }); assert.deepEqual(await fs.readFile(file + '.lock'), before); await later.release(); assert.deepEqual(await fs.readFile(file + '.lock'), before);
  winner.send('release'); await winner.wait('released'); await assert.rejects(fs.lstat(file + '.lock'), { code: 'ENOENT' });
});

test('live and malformed locks fail closed without changing their exact bytes', async t => {
  const { file } = await temporary(t), { owner } = await crashedOwner(t, file);
  const variants = [JSON.stringify({ token: randomUUID(), pid: process.pid }), '', '{broken', JSON.stringify({ token: 'not-a-uuid', pid: owner.pid }), JSON.stringify({ token: randomUUID(), pid: 0 }), JSON.stringify({ token: randomUUID(), pid: -1 }), JSON.stringify({ token: randomUUID(), pid: String(owner.pid) }), JSON.stringify({ token: randomUUID(), pid: owner.pid, other: true })];
  for (const value of variants) { await fs.writeFile(file + '.lock', value); const storage = createBilibiliStorage(file); await assert.rejects(storage.acquire(), { code: 'BILI_WRITER_LOCKED' }); await storage.release(); assert.equal(await fs.readFile(file + '.lock', 'utf8'), value); await assert.rejects(fs.lstat(file + '.lock.recovery'), { code: 'ENOENT' }); }
});

test('symlink or junction lock paths and hardlinked locks are preserved rather than reclaimed', async t => {
  const { root, file } = await temporary(t), target = path.join(root, 'external-lock-target'); await fs.mkdir(target); await fs.writeFile(path.join(target, 'keep'), 'untouched');
  await fs.symlink(target, file + '.lock', process.platform === 'win32' ? 'junction' : 'dir'); const linked = createBilibiliStorage(file); await assert.rejects(linked.acquire(), { code: 'BILI_STORAGE_PATH' }); assert.equal((await fs.lstat(file + '.lock')).isSymbolicLink(), true); assert.equal(await fs.readFile(path.join(target, 'keep'), 'utf8'), 'untouched'); await fs.unlink(file + '.lock');
  const { bytes } = await crashedOwner(t, file), other = path.join(root, 'same-inode'); await fs.link(file + '.lock', other); const hardlinked = createBilibiliStorage(file); await assert.rejects(hardlinked.acquire(), { code: 'BILI_WRITER_LOCKED' }); assert.deepEqual(await fs.readFile(file + '.lock'), bytes); assert.deepEqual(await fs.readFile(other), bytes);
});

test('an abnormal recovery guard blocks recovery without deleting either the guard or dead writer record', async t => {
  const { file } = await temporary(t), { bytes } = await crashedOwner(t, file); await fs.writeFile(file + '.lock.recovery', 'unknown guard'); const storage = createBilibiliStorage(file);
  await assert.rejects(storage.acquire(), { code: 'BILI_WRITER_LOCKED' }); assert.deepEqual(await fs.readFile(file + '.lock'), bytes); assert.equal(await fs.readFile(file + '.lock.recovery', 'utf8'), 'unknown guard');
});

test('release verifies inode and owner token and never removes a replacement live lock', async t => {
  const { file } = await temporary(t), storage = createBilibiliStorage(file); await storage.acquire(); await fs.rename(file + '.lock', file + '.lock.original');
  const replacement = JSON.stringify({ token: randomUUID(), pid: process.pid }); await fs.writeFile(file + '.lock', replacement); await storage.release(); assert.equal(await fs.readFile(file + '.lock', 'utf8'), replacement);
});

test('service recovery after a real crash retains prepared delivery as unknown and never repeats the platform mutation', { timeout: 10000 }, async t => {
  const { root, file } = await temporary(t), memoryRoot = path.join(root, 'persona'); await fs.mkdir(memoryRoot);
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 'xiangxu-bilibili/1', enabled: true, credential: { accountId: '1234', sessdata: 'local-fixture', csrf: 'fixture-csrf' }, receipts: [] }));
  const owner = await worker(t, file, { prepared: true, memoryRoot }); owner.send('go'); await owner.wait('sending'); assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).receipts[0].status, 'prepared'); const oldLock = await fs.readFile(file + '.lock'); await owner.kill(); assert.deepEqual(await fs.readFile(file + '.lock'), oldLock);
  let posts = 0, startupChecks = 0; const service = createBilibiliService({ registryPath: file, authorize: async () => true, fetchImpl: async (url, options) => { if (options.method === 'GET' && new URL(url).pathname === '/x/web-interface/nav') { startupChecks++; return new Response(JSON.stringify({ code: 0, data: { isLogin: true, mid: 1234, uname: 'fixture' } })); } posts++; throw new Error('No repeated platform mutation is permitted'); } }); t.after(() => service.close()); await service.ready;
  const result = await service.execute({ operation: 'message', receiverUid: '55', text: 'prepared crash fixture' }, { memoryRoot, accountId: '1234', deliveryId: 'crashed-send' }); assert.equal(result.status, 'unknown'); assert.equal(result.duplicate, true); assert.equal(posts, 0); assert.equal(startupChecks, 1); assert.equal((await service.listReceipts({ status: 'unknown' })).total, 1); await service.close(); await assert.rejects(fs.lstat(file + '.lock'), { code: 'ENOENT' });
});
