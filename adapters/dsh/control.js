import { watch } from 'node:fs';
import { mkdir, readFile, open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicReplaceWithRetry } from '../../core/store.js';

// Local operator commands only. The OS account controls access to this directory.
// This watcher never schedules personality decisions of its own.
export async function openControlPort(root, execute, report = () => {}, { fault } = {}) {
  const dir = join(root, 'operator'); await mkdir(dir, { recursive: true });
  if ((await lstat(dir)).isSymbolicLink()) throw new Error('Operator directory must not be a link');
  const requestPath = join(dir, 'request.json'), responsePath = join(dir, 'response.json'), receiptPath = join(dir, 'receipt.json');
  let running = Promise.resolve(), lastId = null, closed = false;
  let receipt;
  try { lastId = JSON.parse(await readFile(responsePath, 'utf8')).id; } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  async function durable(path, value) {
    const temp = `${path}.next`, handle = await open(temp, 'w');
    try { await handle.writeFile(JSON.stringify(value), 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await atomicReplaceWithRetry(temp, path);
  }
  const processRequest = () => {
    running = running.then(async () => {
      if (closed) return;
      let request;
      try { const raw = await readFile(requestPath, 'utf8');
        if (Buffer.byteLength(raw) > 16384) throw new Error('Operator request exceeds 16 KiB');
        request = JSON.parse(raw);
      } catch (error) { if (error.code !== 'ENOENT') report(error); return; }
      if (typeof request.id !== 'string' || request.id.length > 100 || request.id === lastId) return;
      let response, executed = false;
      if (receipt?.id === request.id && receipt.status === 'started') {
        response = { id: request.id, ok: false, error: { code: 'COMMAND_OUTCOME_UNKNOWN', message: 'The process ended after starting this command. Inspect current state before issuing a new operation; this request was not replayed.' } };
      } else try {
        receipt = { id: request.id, command: request.command, status: 'started', at: Date.now() }; await durable(receiptPath, receipt);
        response = { id: request.id, ok: true, result: await execute(request.command, request.args ?? {}) };
        executed = true;
      }
      catch (error) { response = { id: request.id, ok: false, error: { code: error.code ?? 'COMMAND_FAILED', message: error.message } }; }
      if (executed) await fault?.('after_execute', request);
      await durable(responsePath, response); lastId = request.id;
      receipt = { id: request.id, status: 'finished', at: Date.now() }; await durable(receiptPath, receipt);
    }).catch(report);
    return running;
  };
  const watcher = watch(dir, (_event, file) => { if (file === 'request.json') void processRequest(); });
  watcher.unref(); void processRequest();
  return { async close() { closed = true; watcher.close(); await running; } };
}
