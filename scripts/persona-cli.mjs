import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, open, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { atomicReplaceWithRetry } from '../core/store.js';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); if (i < 0) return undefined; const value = args[i + 1]; args.splice(i, 2); return value; };
const root = resolve(option('--root') ?? process.env.PERSONA_MEMORY_ROOT ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'persona'));
const waitMs = Number(option('--wait-ms') ?? 30000);
if (!Number.isSafeInteger(waitMs) || waitMs < 1) throw new TypeError('--wait-ms must be a positive integer');
const [command = 'help', value] = args;
if (command === 'help') {
  console.log('node scripts/persona-cli.mjs [--root ABSOLUTE_MEMORY_ROOT] status|wake|mute|resume|consolidate|backfill|config|rollback [JSON or version]\nOffline: validate|backup DESTINATION|restore SOURCE|export DESTINATION|import SOURCE|recover. Stop the plugin first; see README.');
} else if (['backup', 'export', 'restore', 'import', 'validate', 'recover'].includes(command)) {
  const maintenance = await import('../core/maintenance.js');
  let result;
  if (command === 'validate') result = await maintenance.validateMemoryRoot(root);
  if (command === 'recover') result = await maintenance.recoverRestore({ root });
  if (command === 'backup' || command === 'export') {
    if (!value) throw new Error('Provide the absolute backup destination');
    result = await maintenance.createBackup({ root, destination: resolve(value) });
  }
  if (command === 'restore' || command === 'import') {
    if (!value) throw new Error('Provide the absolute backup source');
    result = await maintenance.restoreBackup({ root, source: resolve(value) });
  }
  console.log(JSON.stringify(result, null, 2));
} else {
  const dir = join(root, 'operator'); await mkdir(dir, { recursive: true });
  const lockPath = join(dir, 'client.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another operator command is running; inspect operator/client.lock if its process ended'); throw error; }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
    const id = randomUUID(), request = { id, command, args: value ? JSON.parse(value) : {} };
    const temp = join(dir, 'request.next'); await writeFile(temp, JSON.stringify(request), 'utf8'); await atomicReplaceWithRetry(temp, join(dir, 'request.json'));
    const deadline = Date.now() + waitMs; let response;
    while (Date.now() < deadline) {
      try { const current = JSON.parse(await readFile(join(dir, 'response.json'), 'utf8')); if (current.id === id) { response = current; break; } }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!response) throw new Error(`No running DSH persona coordinator answered within ${waitMs} ms; the request outcome is unknown. Check status before retrying.`);
    console.log(JSON.stringify(response, null, 2)); if (!response.ok) process.exitCode = 1;
  } finally { await lock.close(); await unlink(lockPath); }
}
