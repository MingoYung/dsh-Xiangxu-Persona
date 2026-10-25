import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let checked = 0;
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'artifacts', 'outputs'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { await walk(path); continue; }
    if (!/\.(?:js|mjs)$/.test(entry.name)) continue;
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`${path}: ${result.stderr}`);
    if (dir === join(root, 'core')) {
      const source = await readFile(path, 'utf8');
      if (/from\s+['"][^'"]*(?:@deepseek-ai|adapters\/dsh)/.test(source) || /process\.env/.test(source)) throw new Error(`Host-specific coupling in portable core: ${path}`);
    }
    checked++;
  }
}
await walk(root);
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
for (const path of Object.values(pkg.exports)) await readFile(resolve(root, path));
await readFile(resolve(root, pkg.dsh.bundle.patch));
console.log(JSON.stringify({ status: 'passed', syntaxFiles: checked, portableCoreImports: 'passed', packageTargets: 'passed' }));
