import { createHash } from 'node:crypto';

/** Versioned presentation of a native DSH reply on a plain-text chat channel.
 * Source events are untouched; callers must use this same projection for their
 * delivery, acknowledgement and recovered delivery text.
 */
export const EXTERNAL_OUTPUT_FORMAT = 'dsh-plain/1';
export const EXTERNAL_OUTPUT_LIMITS = Object.freeze({ inputBytes: 65536, cards: 40, nodes: 200, depth: 8, structureNodes: 4096, structureDepth: 32, outputChars: 16000 });
const L = EXTERNAL_OUTPUT_LIMITS;
const digest = text => createHash('sha256').update(text).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const scalar = value => ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : value === null ? 'null' : '';
const text = value => typeof value === 'string' ? value : '';
const compact = values => values.filter(value => value !== '').join('\n');
const unavailable = '[这部分界面内容无法完整转换为聊天文字，请在 DSH 中查看原始回复。]';
const interactive = '[交互控件在此聊天窗口不可操作]';
const graphical = '[图形在此聊天窗口无法显示]';
const capacityError = () => Object.assign(new Error('External reply exceeds its technical presentation capacity'), { code:'EXTERNAL_OUTPUT_CAPACITY' });

function boundedTree(root) {
  const pending = [{ value:root, depth:0 }]; let visited = 0;
  while (pending.length) {
    const { value, depth } = pending.pop();
    if (++visited > L.structureNodes) return 'structure_capacity';
    if (depth > L.structureDepth) return 'structure_depth';
    if (value && typeof value === 'object') for (const child of Object.values(value)) pending.push({ value:child, depth:depth + 1 });
  }
  return null;
}

function renderCard(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return { text:unavailable, issues:['invalid_json'] }; }
  if (!object(value)) return { text:unavailable, issues:['invalid_root'] };
  const treeIssue = boundedTree(value);
  if (treeIssue) return { text:unavailable, issues:[treeIssue] };
  const issues = new Set(); let nodes = 0;
  const warn = code => { issues.add(code); return unavailable; };
  const labelValue = (label, value) => compact([label && value ? label + '：' + value : label || value]);
  const shownScalar = value => value !== null && typeof value === 'object' ? warn('invalid_component') : scalar(value);
  const row = cells => Array.isArray(cells) ? cells.map(shownScalar).join(' | ') : shownScalar(cells);
  const quoteCode = (source, language = '') => {
    const body = typeof source === 'string' ? source : JSON.stringify(source, null, 2);
    const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map(run => run.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    // A code component is a literal code example, even if its language is dsh-ui.
    const lang = /^[a-zA-Z0-9_+-]{0,32}$/.test(language) && language.toLowerCase() !== 'dsh-ui' ? language : '';
    return fence + lang + '\n' + body + '\n' + fence;
  };
  const listRecord = (item, depth) => {
    if (object(item) && typeof item.type === 'string') return node(item, depth);
    if (object(item)) return compact([text(item.title) || text(item.label) || text(item.name), text(item.desc) || text(item.description) || text(item.content) || text(item.text) || text(item.body) || text(item.detail)]);
    return scalar(item);
  };
  const list = (items, depth, numbered = false) => Array.isArray(items)
    ? items.map((item, index) => { const result = listRecord(item, depth); return result ? (numbered ? (index + 1) + '. ' : '• ') + result : ''; }).filter(Boolean).join('\n') : warn('invalid_component');
  const children = (items, depth) => Array.isArray(items) ? compact(items.map(item => node(item, depth))) : warn('invalid_component');
  const dataSeries = (data, prefix = '') => Array.isArray(data) ? compact(data.map(item => object(item)
    ? labelValue(prefix + (text(item.label) || text(item.name)), scalar(item.value)) : prefix + scalar(item))) : '';
  const fileTree = (items, depth) => Array.isArray(items) ? compact(items.map(item => {
    if (!object(item) || ++nodes > L.nodes || depth > L.depth) return warn(depth > L.depth ? 'depth_capacity' : 'node_capacity');
    return compact([text(item.name), item.children === undefined ? '' : fileTree(item.children, depth + 1).split('\n').map(line => '  ' + line).join('\n')]);
  })) : warn('invalid_component');
  function node(item, depth = 0) {
    if (++nodes > L.nodes) return warn('node_capacity');
    if (depth > L.depth) return warn('depth_capacity');
    if (!object(item) || typeof item.type !== 'string') return warn('invalid_component');
    const title = text(item.title), label = text(item.label), content = text(item.content);
    switch (item.type) {
      case 'text': return content;
      case 'row': case 'col': case 'grid': return children(item.items, depth + 1);
      case 'card': return compact([title, children(item.items, depth + 1)]);
      case 'callout': return compact([title, content]);
      case 'keyvalue': return Array.isArray(item.pairs) ? compact(item.pairs.map(pair => object(pair) ? labelValue(shownScalar(pair.key), shownScalar(pair.value)) : warn('invalid_component'))) : warn('invalid_component');
      case 'hero': return compact([title, text(item.subtitle), labelValue(label, scalar(item.value)), text(item.delta)]);
      case 'stat': return compact([labelValue(label, scalar(item.value)), text(item.delta)]);
      case 'badge': return label;
      case 'progress': return labelValue(label, text(item.valueLabel) || (typeof item.value === 'number' ? item.value + '%' : scalar(item.value)));
      case 'list': return list(item.items, depth + 1);
      case 'breadcrumb': return Array.isArray(item.items) ? item.items.map(scalar).join(' › ') : warn('invalid_component');
      case 'table': {
        if (!Array.isArray(item.columns) || !Array.isArray(item.rows)) return warn('invalid_component');
        const lines = [row(item.columns)];
        item.rows.forEach((cells, index) => { lines.push(row(cells)); if (item.details?.[index] != null) lines.push(children(item.details[index], depth + 1)); });
        return compact([title, ...lines]);
      }
      case 'timeline': return Array.isArray(item.items) ? compact(item.items.map(entry => object(entry) ? compact([compact([scalar(entry.time), text(entry.title)]), text(entry.desc)]) : warn('invalid_component'))) : warn('invalid_component');
      case 'steps': return list(item.steps, depth + 1, true);
      case 'file-tree': return fileTree(item.items, depth + 1);
      case 'tabs': return Array.isArray(item.tabs) ? compact(item.tabs.map(tab => object(tab) ? compact([text(tab.label), tab.items === undefined ? '' : children(tab.items, depth + 1)]) : warn('invalid_component'))) : warn('invalid_component');
      case 'accordion': return Array.isArray(item.items) ? compact(item.items.map(entry => object(entry) ? compact([text(entry.title), children(entry.items ?? [], depth + 1)]) : warn('invalid_component'))) : warn('invalid_component');
      case 'code': return typeof item.code === 'string' ? quoteCode(item.code, text(item.lang)) : warn('invalid_component');
      case 'json': return Object.hasOwn(item, 'value') ? quoteCode(item.value, 'json') : warn('invalid_component');
      case 'diff': return Array.isArray(item.diffs) ? compact(item.diffs.map(entry => object(entry) ? compact([text(entry.path), entry.oldText === null ? '[新增]' : quoteCode(entry.oldText ?? ''), entry.newText === null ? '[删除]' : quoteCode(entry.newText ?? '')]) : warn('invalid_component'))) : warn('invalid_component');
      case 'copy': return compact([label, text(item.text)]);
      case 'link': return compact([label, text(item.href)]);
      case 'avatar': return text(item.name);
      case 'image': case 'audio': case 'video': return compact([text(item.alt), text(item.caption), text(item.src)]);
      case 'button': case 'submit': return compact([label, interactive]);
      case 'input': case 'textarea': case 'slider': return compact([labelValue(label, scalar(item.value)), text(item.placeholder), interactive]);
      case 'checkbox': case 'switch': return compact([(item.checked === true ? '☑ ' : '☐ ') + label, interactive]);
      case 'select': case 'radio': return compact([label, list(item.options, depth + 1), Number.isSafeInteger(item.selected) ? labelValue('已选', scalar(item.options?.[item.selected])) : '', interactive]);
      case 'quiz': return compact([text(item.question), Array.isArray(item.options) ? list(item.options.map(option => object(option) ? text(option.label) : scalar(option)), depth + 1) : '', interactive]);
      case 'chart': case 'echart': {
        const series = Array.isArray(item.series) ? compact(item.series.map(entry => object(entry) ? compact([text(entry.name), dataSeries(entry.data)]) : '')) : '';
        const data = dataSeries(item.data);
        const unsupportedOption = item.option !== undefined;
        if (unsupportedOption) issues.add('graphical_component');
        return compact([title, data, series, unsupportedOption || !data && !series ? graphical : '']);
      }
      case 'blocks': return compact([title, Array.isArray(item.rows) ? compact(item.rows.map(entry => object(entry) ? labelValue(text(entry.label), row(entry.cells)) : warn('invalid_component'))) : warn('invalid_component'), text(item.caption)]);
      case 'arrow': return label;
      case 'icon': return label;
      case 'divider': return label;
      case 'spacer': return '';
      case 'svg': case 'mermaid': case 'plot': case 'diagram': case 'scene3d': issues.add('graphical_component'); return compact([title, text(item.caption), graphical]);
      default: issues.add('unsupported_component'); return compact([title, label, content, unavailable]);
    }
  }
  const result = typeof value.type === 'string' ? node(value) : compact([text(value.title), children(value.items, 0)]);
  return { text:result || warn('empty_card'), issues:[...issues] };
}

const opening = line => /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
const uiLanguage = info => /^dsh-ui$/i.test(info.trim().replace(/[>`"'.,;:)\]】」』]+$/, '').trim());
const closes = (line, fence) => {
  const found = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return found && found[1][0] === fence[0] && found[1].length >= fence.length;
};

/** No evaluation, URL access, model calls or source mutation. Ordinary Markdown
 * fences, including JSON/code examples, remain byte-for-byte unchanged.
 */
export function projectExternalOutput(source) {
  if (typeof source !== 'string') throw new TypeError('External reply must be text');
  if (Buffer.byteLength(source) > L.inputBytes) throw capacityError();
  const lines = source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g).filter(Boolean);
  const output = [], issues = new Set(); let ordinary = null, card = null, cards = 0;
  const settle = (closed, eol = '') => {
    if (!closed) { issues.add('unterminated_fence'); output.push(unavailable + eol); }
    else if (cards > L.cards) { issues.add('card_capacity'); output.push(unavailable + eol); }
    else { const result = renderCard(card.body.join('')); result.issues.forEach(issue => issues.add(issue)); output.push(result.text + eol); }
    card = null;
  };
  for (const full of lines) {
    const eol = /(?:\r\n|\r|\n)$/.exec(full)?.[0] ?? '', line = full.slice(0, full.length - eol.length);
    if (card) { if (closes(line, card.fence)) settle(true, eol); else card.body.push(full); continue; }
    if (ordinary) { output.push(full); if (closes(line, ordinary)) ordinary = null; continue; }
    const found = opening(line);
    if (found && uiLanguage(found[2])) { cards++; card = { fence:found[1], body:[] }; }
    else { output.push(full); if (found) ordinary = found[1]; }
  }
  if (card) settle(false);
  let projected = output.join('');
  if (cards && [...projected].length > L.outputChars) { issues.add('output_capacity'); projected = '[这条回复超出了当前聊天窗口的显示容量，请在 DSH 中查看原始回复。]'; }
  return { text:projected, formatVersion:EXTERNAL_OUTPUT_FORMAT, converted:cards > 0, complete:issues.size === 0,
    cards, issues:[...issues], sourceTextHash:digest(source), deliveryTextHash:digest(projected) };
}

/** Recover only the representation actually identified by a retained receipt.
 * Legacy receipts prove raw output; never retroactively prettify that history.
 */
export function resolveExternalOutput(source, receipt) {
  if (typeof source !== 'string' || !object(receipt) || Buffer.byteLength(source) > L.inputBytes) return null;
  const matches = (value, expected) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && value === expected;
  const rawHash = digest(source);
  if (receipt.formatVersion === undefined) {
    if (!matches(receipt.textHash, rawHash)
      || receipt.sourceTextHash !== undefined && !matches(receipt.sourceTextHash, rawHash)
      || receipt.deliveryTextHash !== undefined && !matches(receipt.deliveryTextHash, rawHash)) return null;
    return { text:source, converted:false, complete:true, cards:0, issues:[], sourceTextHash:rawHash, deliveryTextHash:rawHash };
  }
  if (receipt.formatVersion !== EXTERNAL_OUTPUT_FORMAT || !matches(receipt.sourceTextHash, rawHash)) return null;
  let result;
  try { result = projectExternalOutput(source); } catch { return null; }
  if (!matches(receipt.textHash, result.deliveryTextHash)
    || receipt.deliveryTextHash !== undefined && !matches(receipt.deliveryTextHash, result.deliveryTextHash)) return null;
  return result;
}
