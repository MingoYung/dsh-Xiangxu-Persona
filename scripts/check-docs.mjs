import { readFile, readdir, access } from 'node:fs/promises';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig } from '../core/schema.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundledPlans = join(root, 'docs', 'plan');
let reports = bundledPlans;
try { await access(join(bundledPlans, '长期AI人格插件-实施计划.md')); }
catch (error) { if (error.code !== 'ENOENT') throw error; reports = resolve(root, '..', 'reports'); }
const planFiles = [join(reports, '长期AI人格插件-实施计划.md'), ...(await readdir(join(reports, 'persona'))).filter(name => name.endsWith('.md')).map(name => join(reports, 'persona', name))];
const codeDocs = [join(root, 'README.md'), ...(await readdir(join(root, 'docs'))).filter(name => name.endsWith('.md')).map(name => join(root, 'docs', name))];
let jsonBlocks = 0, localLinks = 0;
for (const file of [...planFiles, ...codeDocs]) {
  const text = await readFile(file, 'utf8');
  if (text.includes('\ufffd')) throw new Error(`Replacement character in ${file}`);
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const mark = line.match(/^\s*(`{3,}|~{3,})/);
    if (!mark) continue;
    if (!fence) fence = mark[1][0]; else if (mark[1][0] === fence) fence = null;
  }
  if (fence) throw new Error(`Unclosed Markdown fence in ${file}`);
  for (const match of text.matchAll(/^\s*```json\s*\r?\n([\s\S]*?)^\s*```\s*$/gm)) { JSON.parse(match[1]); jsonBlocks++; }
  const prose = text.replace(/^\s*```[^\n]*\n[\s\S]*?^\s*```\s*$/gm, '');
  for (const match of prose.matchAll(/\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const link = match[1].replace(/^<|>$/g, '').split('#')[0];
    if (!link || /^[a-z]+:\/\//i.test(link) || link.startsWith('mailto:')) continue;
    const path = decodeURIComponent(link);
    await access(isAbsolute(path) ? path : resolve(dirname(file), path)); localLinks++;
  }
}
if (planFiles.length !== 14) throw new Error('The authorized complete plan should contain fourteen Markdown documents');
const schema = await readFile(join(reports, 'persona', 'persona-schema.md'), 'utf8');
if (!schema.includes('interface IdentityPlan') || !schema.includes('pendingEffects') || !schema.includes('nextCursor')) throw new Error('Implementation protocol extensions are absent from authoritative schema');
const config = defaultConfig();
if (config.longTermTargetChars !== 1000000 || config.recentTargetChars !== 100000 || config.tempTargetChars !== 200000 || config.contextBudget.totalTokens !== 2970) throw new Error('Default capacity/budget drifted from the accepted plan');
console.log(JSON.stringify({ status: 'passed', planDocuments: planFiles.length, implementationDocuments: codeDocs.length, jsonBlocks, localLinks, selfContainedPlans: reports === bundledPlans, protocolAuthority: 'persona-memory/3', scope: 'structural/link/default agreement; substantive autonomy and host behavior require the separate reviews and runtime tests' }));
