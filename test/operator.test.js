import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, rename, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControlPort } from '../adapters/dsh/control.js';

test('operator commands receive a result once and completed requests do not replay after restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'persona-operator-')); let calls = 0, port;
  const errors = [];
  t.after(async () => { await port?.close(); await rm(root, { recursive: true, force: true }); });
  const execute = async (command, args) => { calls++; return { command, args }; };
  port = await openControlPort(root, execute, error => errors.push(error));
  const temp = join(root, 'operator', 'request.next');
  await writeFile(temp, JSON.stringify({ id: 'request-1', command: 'wake', args: { reason: 'user' } }));
  await rename(temp, join(root, 'operator', 'request.json'));
  let result;
  for (let i = 0; i < 50; i++) {
    try { result = JSON.parse(await readFile(join(root, 'operator', 'response.json'), 'utf8')); if (result.id === 'request-1') break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(result.ok, true); assert.equal(calls, 1); assert.equal(result.result.command, 'wake');
  await port.close(); port = await openControlPort(root, execute, error => errors.push(error));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(calls, 1); assert.deepEqual(errors, []);
});

test('a crash after command execution keeps an unknown outcome and never replays the mutation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'persona-operator-crash-')); let calls = 0, port;
  const errors = [];
  t.after(async () => { await port?.close(); await rm(root, { recursive: true, force: true }); });
  port = await openControlPort(root, async () => { calls++; return { changed: true }; }, error => errors.push(error), {
    fault: async () => { throw new Error('simulated process termination before response'); },
  });
  await writeFile(join(root, 'operator', 'request.json'), JSON.stringify({ id: 'interrupted', command: 'rollback' }));
  for (let i = 0; i < 50 && !errors.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  await port.close();
  assert.equal(calls, 1); assert.equal(errors.length, 1);
  port = await openControlPort(root, async () => { calls++; }, error => errors.push(error));
  let result;
  for (let i = 0; i < 50; i++) {
    try { result = JSON.parse(await readFile(join(root, 'operator', 'response.json'), 'utf8')); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(result.error.code, 'COMMAND_OUTCOME_UNKNOWN'); assert.equal(calls, 1);
});
