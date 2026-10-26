/* The management page talks only to the DSH bridge. It never creates a writer or a model call by itself. */
const $ = id => document.getElementById(id);
const state = { connected: false, instanceId: null, instances: [], people: [], status: null, page: 'overview', view: null, trail: [], budgetDraft: null, configGroup: '0', memoryPerson: null, generation: 0, detailGeneration: 0 };
const pages = {
  overview: ['相处', 'OVERVIEW', '查看相续的近况，按自己的需要管理日常交流。'],
  persona: ['了解相续', 'PERSONA', '查看持续积累的身份、性格与习惯。这里展示当前数据，不替人格设定成长指标。'],
  memory: ['记忆', 'MEMORY', '查找相续留下的记忆、重要经历，以及认识的人。'],
  evolution: ['成长记录', 'EVOLUTION', '跟踪已选整理作业、未完成进度和已保留的变更历史。'],
  settings: ['设置', 'SETTINGS', '管理人格、记忆库与可选功能。'],
  chat: ['连接', 'CHANNELS & VOICE', '在熟悉的聊天软件里继续交流，让同一个人格走进私聊和群聊。'],
  tasks: ['任务与资料', 'TASKS', '查看独立任务、按需读取完整资料；记什么仍由相续自己决定。'],
  media: ['创作', 'IDENTITY & MEDIA', '保存同一个形象，选择性接入图片和视频创作服务。'],
  maintenance: ['维护与诊断', 'MAINTENANCE', '查看可用诊断、校验和备份恢复结果。写入操作都作用于明确选择的实例。'],
};
const labels = { starting: '准备启动', awake: '清醒', sleeping: '休息中', queued: '待执行', running: '执行中', paused: '已暂停', committed: '已提交', completed: '已完成', prepared: '已准备', failed: '失败', invalidated: '已失效', no_work: '无工作', delivered: '已交付', pending: '待处理', cancelled: '已取消', unknown: '结果未知', deferred: '已暂缓', submitted: '已提交到服务', revoked: '来源已撤销' };
const pretty = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const number = value => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('zh-CN').format(value) : '—';
const date = value => typeof value === 'number' && Number.isFinite(value) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未选择时间';
const short = (value, max = 230) => { const text = typeof value === 'string' ? value : pretty(value) ?? ''; const chars = Array.from(text); return chars.length > max ? chars.slice(0, max).join('') + '…' : text; };
const errorText = error => `${error?.code ? error.code + ' · ' : ''}${error?.message ?? String(error)}`;
const personName = id => id == null ? '未知归属' : state.people.find(p => p.personId === id || p.id === id)?.displayName || id;
const memoryScopeLabel = record => record.scope === 'global'
  ? (record.recordType === 'deep' ? '深刻记忆 · 共同参考' : ['facet', 'signature', 'habit'].includes(record.recordType) ? '共同人格' : '共同记忆')
  : record.personId != null ? '关系：' + personName(record.personId) : '未知归属';
function element(tag, attrs = {}, ...children) {
  if (tag === 'details') return disclosure(attrs, ...children);
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') for (const [name, item] of Object.entries(value)) node.dataset[name] = item;
    else if (key in node && !['list', 'form'].includes(key)) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) if (child != null) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
function replace(node, ...children) { node.replaceChildren(...children.flat().filter(Boolean)); return node; }
function button(text, action, kind = 'secondary', attrs = {}) {
  return element('button', { type: 'button', class: `button ${kind}`, ...attrs, onclick: async event => {
    const target = event.currentTarget; target.disabled = true;
    try { await action(); } catch (error) { showError(error); } finally { if (target.isConnected) target.disabled = false; }
  } }, text);
}

let disclosureSequence = 0;
function disclosure(attrs = {}, ...children) {
  const { open = false, ...rest } = attrs, group = element('section', { ...rest, class: 'disclosure ' + (rest.class ?? '') });
  const panel = element('div', { class: 'disclosure-content', id: 'extra-' + (++disclosureSequence), hidden: !open });
  let expanded = Boolean(open), title = '更多信息';
  const toggle = button(title, () => { group.open = !group.open; }, 'link disclosure-toggle', { 'aria-expanded': String(expanded), 'aria-controls': panel.id });
  group.append(toggle, panel); group.disclosureButton = toggle;
  Object.defineProperty(group, 'open', { get: () => expanded, set: value => { expanded = Boolean(value); panel.hidden = !expanded; toggle.setAttribute('aria-expanded', String(expanded)); toggle.textContent = expanded ? '收起' + title : title; } });
  group.append = (...items) => { for (const item of items.flat(Infinity)) { if (item?.tagName?.toLowerCase() === 'summary') { title = item.textContent; toggle.textContent = expanded ? '收起' + title : title; } else if (item != null) panel.append(item); } };
  group.append(...children); return group;
}
function destination(title, description, action, status = '') {
  const node = button('', action, 'destination', { class: 'destination', 'aria-label': title }); node.append(
    element('span', { class: 'destination-copy' }, element('span', { class: 'destination-title' }, title), element('span', { class: 'destination-description' }, description)),
    element('span', { class: 'destination-end' }, status ? element('span', { class: 'destination-status' }, status) : null, element('span', { class: 'destination-action', 'aria-hidden': true }, '打开 →'))); return node;
}
function destinations(...items) { return element('div', { class: 'destination-list' }, ...items); }
function sectionTabs(items) { return element('nav', { class: 'module-tabs', 'aria-label': '当前页面内容' }, items.map(([view, label]) => button(label, () => openSection(view, false), 'module-tab', { class: 'module-tab' + ((state.view ?? '') === view ? ' active' : ''), 'aria-current': (state.view ?? '') === view ? 'page' : 'false' }))); }
let pageScrollRequested = false;
const routeParents = { persona: 'overview', evolution: 'memory', tasks: 'overview', maintenance: 'settings' };
const viewTitles = { 'self-profile': '自我档案', 'user-guide': '使用说明', startup: '启动时加载', 'new-persona': '新建人格', 'new-instance': '使用其他记忆库', history: '人格变化', receipts: '手动操作', runtime: '运行与用量', instances: '人格管理', assistant: '整理资料助手', general: '交流与时间', budgets: '容量与模型预算', voice: '声音', accounts: '社交身份', identity: '形象档案', create: '开始创作', gallery: '作品与任务', 'provider-image': '图片服务', 'provider-video': '视频服务', qq: '连接 QQ', wechat: '连接微信', 'qq-bridge': 'QQ 兼容桥', 'wechat-bridge': '微信兼容桥', 'qq-permissions': 'QQ 能力与权限', 'wechat-permissions': '微信能力与权限', deep: '深刻经历', people: '认识的人', backup: '创建备份', restore: '恢复备份', validate: '数据校验', diagnostics: '运行诊断' };
async function openSection(view, remember = true) { pageScrollRequested = true; if (remember) state.trail.push({ page: state.page, view: state.view }); state.view = view || null; await renderPage(); }
async function goBack() { pageScrollRequested = true; const previous = state.trail.pop(); state.page = previous?.page ?? routeParents[state.page] ?? state.page; state.view = previous?.view ?? null; await renderPage(); }

function notice(text, kind = '') { return element('div', { class: `notice ${kind}` }, text); }
function pill(value) { return element('span', { class: 'status-pill ' + (['failed', 'invalidated', 'error'].includes(value) ? 'error' : ['paused', 'pending', 'unknown', 'prepared'].includes(value) ? 'warning' : '') }, labels[value] ?? value ?? '未知'); }
function tag(text, kind = '') { return element('span', { class: `tag ${kind}` }, text); }
function empty(title, detail, symbol = '◇') { return element('div', { class: 'empty-state' }, element('div', { class: 'empty-symbol', 'aria-hidden': true }, symbol), element('h3', {}, title), element('p', {}, detail)); }
function card(title, subtitle, ...content) { return element('section', { class: 'card' }, element('div', { class: 'card-header' }, element('div', {}, element('h2', {}, title), subtitle ? element('p', {}, subtitle) : null)), content); }
function kv(items) { return element('dl', { class: 'kv-list' }, Object.entries(items).map(([name, value]) => element('div', { class: 'kv-row' }, element('dt', {}, name), element('dd', {}, value instanceof Node ? value : value == null ? '—' : typeof value === 'boolean' ? value ? '是' : '否' : typeof value === 'object' ? disclosure({}, element('summary', {}, '查看内容'), data(value)) : String(value))))); }
function data(value) { return element('pre', { class: 'data-preview' }, pretty(value) ?? '无数据'); }
function showError(error) { $('global-error').hidden = false; $('global-error').textContent = errorText(error); toast(errorText(error), true); }
function clearError() { $('global-error').hidden = true; $('global-error').textContent = ''; }
let toastTimer;
function toast(message, isError = false) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').className = `toast${isError ? ' error' : ''}`; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, isError ? 9000 : 5000); }
async function request(action, args = {}) {
  if (!window.personaBridge || typeof window.personaBridge.request !== 'function') throw Object.assign(new Error('尚未连接 DSH 管理桥。请从 DSH 的“相续人格”设置入口打开。'), { code: 'BRIDGE_UNAVAILABLE' });
  const result = await window.personaBridge.request(action, { ...(state.instanceId ? { instanceId: state.instanceId } : {}), ...args });
  if (result && result.ok === false && result.error) throw Object.assign(new Error(result.error.message || '操作失败'), result.error);
  return result;
}
function getItems(result) { return Array.isArray(result) ? result : result?.items ?? []; }
function instanceItems(result) { return getItems(result).map(item => ({ ...item, id: item.id ?? item.instanceId, active: item.active ?? item.selected ?? false })); }
function documentView(value) {
  if (value && typeof value === 'object' && Array.isArray(value.changes) && value.fromVersion != null) {
    return element('div', {}, kv({ '起点版本': 'v' + value.fromVersion, '终点版本': 'v' + value.toVersion }), value.changes.length ? value.changes.map(change => card(({ anchor: '身份基调', axes: '性格维度', facets: '性格与偏好', signatures: '常见反应', habits: '习惯', retired: '过去的描述' })[change.field] ?? change.field, '', element('div', { class: 'diff-grid' }, element('div', {}, element('div', { class: 'section-label' }, '修改前'), data(change.before)), element('div', {}, element('div', { class: 'section-label' }, '修改后'), data(change.after))))) : empty('所选版本没有模块变化', '这是实际对比结果，不要求为了进化而产生变更。'));
  }
  if (value && typeof value === 'object' && value.recordType) {
    const refs = value.srcRefs ?? (value.sourceEventId ? [{ sourceSessionId: value.sourceSessionId, sourceEventId: value.sourceEventId, sourceRole: value.role }] : []);
    const label = value.recordType === 'deep' ? value.title ?? '深刻经历' : ({ chat: '对话原文', memory: '保留的记忆', code: '记忆短语' })[value.recordType] ?? '已保留内容';
    const metadata = disclosure({}, element('summary', {}, '查看来源与记录信息'), kv({ '类型': value.recordType, '记忆归属': memoryScopeLabel(value), '实际角色': value.role ?? value.sourceRole ?? '人格的记忆与理解', '实际发言者': value.speakerId ?? '未提供', '发生时间': value.sourceAt ? date(value.sourceAt) : '未提供', '记录编号': value.id }),
      refs.map(ref => element('div', { class: 'source-reference' }, kv({ '会话': ref.sourceSessionId, '来源': ref.sourceEventId, '角色': ref.sourceRole ?? '未提供', '原件': ref.available === false ? '已不可用' : '可查询' }), button('查看这份原件', () => inspectDocument('sources.read', { sourceRefs: [ref] }, '来源原件'), 'link'))), disclosure({}, element('summary', {}, '原始字段'), data(value)));
    const content = value.recordType === 'deep'
      ? element('div', {}, element('p', { class: 'subtle-note' }, '这是人格留下的参考。是否想起、怎样理解与修剪，由它自己决定。'),
        ...[['experience', '经历'], ['feltThen', '当时的感受'], ['meaningNow', '现在的理解']].map(([key, title]) => element('section', { class: 'reading-section' }, element('h3', {}, title), element('p', { class: 'detail-value' }, value[key] || '尚未描述'))), value.reference ? element('p', { class: 'subtle-note' }, '留下的参考：' + value.reference) : null)
      : element('div', { class: 'detail-value' }, value.text ?? value.meaning ?? value.desc ?? value.reference ?? '本条目没有正文。');
    return element('div', { class: 'reading-view' }, element('h2', {}, label), element('p', { class: 'record-meta' }, memoryScopeLabel(value) + ' · ' + ({ assistant: 'AI 助手', user: '用户原话', system: '程序材料' }[value.role ?? value.sourceRole] ?? '人格的记忆与理解')), content, metadata);
  }
  if (value && typeof value === 'object' && value.runId && value.status) {
    const entries = value.validatedPatch ?? value.candidatePatch?.entries ?? (Array.isArray(value.candidatePatch) ? value.candidatePatch : []);
    return element('div', {}, kv({ '批次': element('code', {}, value.runId), '状态': labels[value.status] ?? value.status, '关系归属': personName(value.personId), '实际调用尝试': number(value.reviewState?.modelCalls), '暂停原因': value.reviewState?.pauseReason ?? value.validationError?.code ?? '无', '提交标记': value.commitMarker ?? '尚未提交' }),
      element('h3', {}, value.status === 'committed' ? '已提交变更' : '尚未提交的提案'), entries.length ? element('div', { class: 'record-list' }, entries.map(entry => element('div', { class: 'record' }, element('div', { class: 'record-header' }, element('h3', { class: 'record-title' }, entry.documentKey), tag(entry.operation === 'remove' ? '删除' : '更新')), element('code', {}, entry.recordId), entry.operation === 'upsert' ? element('div', {}, element('p', { class: 'detail-value' }, typeof entry.value === 'string' ? entry.value : entry.value?.text ?? entry.value?.desc ?? entry.value?.reference ?? entry.value?.meaning ?? '这项描述的结构已更新。'), disclosure({}, element('summary', {}, '查看原始变更'), data(entry.value))) : element('p', { class: 'small muted' }, '明确移除此记录')))) : empty('当前没有变更条目', '空变更有效；仅提交状态才表示完成对应消费。'),
      element('details', {}, element('summary', { class: 'small muted' }, '查看输入范围、读取进度与完整字段'), data(value)));
  }
  return data(value);
}
function field(name, label, value, options = {}) {
  const input = options.choices ? element('select', { name, id: name }, options.choices.map(([v, title]) => element('option', { value: v, selected: String(value ?? '') === String(v) }, title)))
    : options.multiline
      ? element('textarea', { name, id: name, value: value ?? '', required: options.required ?? false, placeholder: options.placeholder, rows: 3 })
      : element('input', { name, id: name, value: value ?? '', type: options.type ?? 'text', min: options.min ?? (options.type === 'number' ? 0 : undefined), step: options.type === 'number' ? 1 : undefined, required: options.required ?? false, placeholder: options.placeholder });
  const wrapper = element('label', { class: `field${options.class ? ' ' + options.class : ''}` }, element('span', {}, label), input, options.hint ? element('small', {}, options.hint) : null);
  return { wrapper, input };
}
async function confirmOperation({ title, description, preview, reason = false, accept = '确认执行', danger = false }) {
  $('confirm-title').textContent = title; $('confirm-description').textContent = description;
  $('confirm-preview').hidden = preview == null; $('confirm-preview').textContent = preview == null ? '' : pretty(preview);
  $('confirm-reason-label').hidden = !reason; $('confirm-reason').value = '';
  $('confirm-accept').textContent = accept; $('confirm-accept').className = `button ${danger ? 'danger' : 'primary'}`;
  const dialog = $('confirm-dialog');
  return new Promise(resolve => { dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm' ? { reason: $('confirm-reason').value.trim() } : null), { once: true }); dialog.returnValue = ''; dialog.showModal(); });
}
function startDetail(title, eyebrow = 'DETAIL') { state.detailGeneration++; $('detail-title').textContent = title; $('detail-eyebrow').textContent = eyebrow; replace($('detail-content'), element('p', { class: 'muted' }, '正在读取…')); replace($('detail-footer')); if (!$('detail-dialog').open) $('detail-dialog').showModal(); return state.detailGeneration; }
async function inspectDocument(action, args, title, { actions = [], eyebrow } = {}) {
  const generation = startDetail(title, eyebrow), body = $('detail-content'), footer = $('detail-footer');
  let accumulated = '', cursor, total = null;
  async function load() {
    const result = await request(action, { ...args, ...(cursor != null ? { cursor } : {}) });
    if (generation !== state.detailGeneration) return;
    let view, complete = true;
    if (result?.format === 'json_text_fragment') {
      if (cursor == null) accumulated = '';
      const fragment = result.fragment;
      if (fragment.from !== Array.from(accumulated).length) throw new Error('详情分页位置已变化，请关闭后重新打开。');
      accumulated += result.text; cursor = result.nextCursor; total = fragment.total; complete = fragment.complete;
      try { view = complete ? JSON.parse(accumulated) : accumulated; } catch { view = accumulated; }
    } else { view = result; cursor = null; }
    replace(body, !complete ? element('div', {}, element('h3', {}, '内容较长，正在按页读取'), element('p', { class: 'muted' }, `已读取 ${number(Array.from(accumulated).length)} / ${number(total)} 字符。原文完整保留，继续读取后展示全文。`), disclosure({}, element('summary', {}, '查看当前原始片段'), data(view))) : documentView(view));
    replace(footer, actions.map(item => button(item.label, () => item.run(view), item.kind ?? 'secondary')),
      cursor != null ? button('继续读取下一页', load, 'primary', { dataset: { action: 'detail-next' } }) : element('span', { class: 'small muted' }, '已读取可用详情'),
      button('关闭', () => $('detail-dialog').close(), 'secondary'));
  }
  try { await load(); } catch (error) { if (generation === state.detailGeneration) replace(body, notice(errorText(error), 'error')); throw error; }
}
function paginator(result, next, { pageNumber = 1 } = {}) {
  return element('div', { class: 'pagination' }, element('span', {}, `第 ${pageNumber} 页 · 本页 ${number(getItems(result).length)} 条${result?.total != null ? ` / 共 ${number(result.total)} 条` : ''}`),
    result?.nextCursor != null ? button('下一页 →', () => next(result.nextCursor), 'secondary compact', { dataset: { action: 'list-next' } }) : element('span', {}, '已到当前结果末尾'));
}
let connecting = false;
async function connect() {
  if (connecting) return;
  connecting = true;
  clearError(); $('connection-state').textContent = '正在连接'; $('connection-state').className = 'status-pill neutral';
  try {
    const instances = await request('instances.list', { instanceId: undefined }); state.instances = instanceItems(instances);
    state.instanceId = state.instanceId ?? instances?.selectedInstanceId ?? instances?.activeInstanceId ?? state.instances.find(item => item.active)?.id ?? state.instances[0]?.id ?? null;
    state.status = await request('status'); state.connected = true;
    updateInstanceBar(); $('refresh-button').disabled = false; $('connection-state').textContent = '已连接 DSH'; $('connection-state').className = 'status-pill';
    const people = state.status.available ? await request('people.list', { pageSize: 100 }) : { items: [] }; state.people = getItems(people);
    await renderPage();
  } catch (error) {
    state.connected = false; $('connection-state').textContent = '未连接'; $('connection-state').className = 'status-pill error'; $('refresh-button').disabled = false;
    const detail = $('connection-detail'); if (detail) detail.textContent = errorText(error); showError(error);
  } finally { connecting = false; }
}
function updateInstanceBar() {
  const select = $('active-instance'); replace(select, state.instances.map(item => element('option', { value: item.id, selected: item.id === state.instanceId, disabled: item.archivedAt != null || item.clearedAt != null || Boolean(item.clearStatus) }, `${item.name ?? item.id}${item.clearedAt != null || item.clearStatus === 'cleared' ? ' · 已清除' : item.clearStatus ? ' · 清除未完成' : item.archivedAt != null ? ' · 已归档' : item.loaded ? '' : ' · 未加载'}${item.active ? ' · 默认' : ''}`)));
  if (!state.instances.length) select.append(element('option', { value: '' }, '尚无实例'));
  select.disabled = !state.instances.length;
  const selected = state.instances.find(item => item.id === state.instanceId); $('instance-root').textContent = selected?.memoryRoot ?? state.status?.memoryRoot ?? '未配置目录'; $('instance-root').title = $('instance-root').textContent;
  $('build-version').textContent = state.status?.version ?? state.status?.pluginVersion ?? 'DSH 插件';
}
async function navigate(page, view = null) {
  pageScrollRequested = true;
  if (routeParents[page]) state.trail.push({ page: state.page, view: state.view }); else state.trail = [];
  state.page = pages[page] ? page : 'overview'; state.view = view;
  state.detailGeneration++; if ($('detail-dialog').open) $('detail-dialog').close();
  await renderPage();
}
async function renderPage() {
  for (const cleanup of [...pageCleanups]) cleanup();
  const [title, , description] = pages[state.page];
  $('page-title').textContent = viewTitles[state.view] ?? title; $('page-description').textContent = ({ 'instances': '分别管理当前、其它和已归档的人格，清除前核对文本资料范围。', 'user-guide': '了解初次认识、记忆、休息和日常操作。', 'self-profile': '初始想法与当前自我描述分别保存，资料可以慢慢确定。' }[state.view] ?? (state.view ? ({ chat: '选择连接方式后，按步骤完成接入。', media: '设置只作用于当前人格；创作使用已保存的服务。', settings: '按需要调整这一项，保存后生效。', memory: '查看已保留的内容，回忆与记忆变化仍由人格自己决定。' }[state.page] ?? description) : description));
  const back = $('page-back'); back.hidden = !state.view && !routeParents[state.page]; back.textContent = '返回' + (viewTitles[state.trail.at(-1)?.view] ?? pages[state.trail.at(-1)?.page ?? routeParents[state.page] ?? state.page]?.[0] ?? '上一页');
  document.querySelectorAll('[data-page]').forEach(node => { node.classList.toggle('active', node.dataset.page === (routeParents[state.page] ?? state.page)); if (node.dataset.page === (routeParents[state.page] ?? state.page)) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
  replace($('page-actions'));
  if (!state.connected) return;
  clearError(); const generation = ++state.generation; $('page-content').classList.add('loading');
  try {
    state.status = await request('status'); updateInstanceBar();
    let content;
    if (state.view === 'user-guide') content = userGuidePage();
    else if (!state.status.available && !['settings', 'maintenance', 'chat'].includes(state.page)) content = card('当前实例尚未加载', '加载实例后才能读取人格、记忆和整理状态。', notice(state.status.unloaded ? '实例已停用。数据仍保留在原记忆目录。' : '当前实例不可用，请查看诊断或加载设置。', 'warning'), button('启用或选择人格', () => navigate('settings', 'instances'), 'primary'));
    else content = await ({ overview: overviewPage, persona: personaPage, memory: memoryPage, evolution: evolutionPage, settings: settingsPage, maintenance: maintenancePage, chat: chatPage, media: mediaPage, tasks: tasksPage })[state.page]();
    if (generation !== state.generation) return;
    replace($('page-content'), content); if (pageScrollRequested) { document.querySelector?.('.app-shell')?.scrollIntoView?.({ block: 'start', behavior: 'instant' }); pageScrollRequested = false; } $('last-updated').textContent = '上次读取 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  } catch (error) { if (generation === state.generation) { showError(error); replace($('page-content'), card('暂时无法读取', '', notice(errorText(error), 'error'), button('重新读取', renderPage, 'secondary'))); } }
  finally { if (generation === state.generation) $('page-content').classList.remove('loading'); }
}
async function mutate(action, args = {}, options = {}) {
  const confirmed = options.confirm === false ? {} : await confirmOperation({ title: options.title ?? '执行管理操作', description: options.description ?? '操作只作用于当前选择的实例。', preview: Object.prototype.hasOwnProperty.call(options, 'preview') ? options.preview : args, reason: options.reason, accept: options.accept, danger: options.danger });
  if (!confirmed) return;
  const result = await request(action, { ...args, ...(confirmed.reason ? { reason: confirmed.reason } : {}) });
  toast(options.success ?? '操作已返回，请查看实际结果。');
  if (options.refresh !== false) await renderPage();
  return result;
}
async function control(name, args = {}) {
  const choices = {
    wake: ['现在叫醒相续', '结束这次休息，让相续看到休息期间保留的来信。这可能调用模型；醒来后是否回应、怎样回应仍由它自己判断。'],
    mute: ['暂时关闭主动聊天', '相续暂时不会主动找你聊天。仍然接收你的来信并保留记忆；已经发出的消息不会撤回。'],
    resume: ['允许主动找我聊天', '相续可以在你没有发消息时主动开口。是否开口、何时开口仍由它自己决定；开启后不代表马上发消息。'],
    consolidate: ['明确整理一批', '这是你明确发起的一批整理，可能调用模型。每个模块都可以保持不变，未完成时保留实际进度；不会设置固定进化频率。'],
    backfill: ['回补可用来源', '按已有缺口和宿主保留的原件回补。原件已不存在时会保留缺口，不伪造内容。'],
  };
  const [title, description] = choices[name];
  if (['consolidate', 'backfill'].includes(name)) {
    const confirm = await confirmOperation({ title, description, preview: args, accept: '开始这次操作' }); if (!confirm) return;
    const random = new Uint8Array(16); crypto.getRandomValues(random);
    const requestId = 'ui_' + Array.from(random, item => item.toString(16).padStart(2, '0')).join('');
    const input = { action: 'control.' + name, args, requestId };
    try { const receipt = await request('operations.start', input); await showOperation(receipt); }
    catch (error) { await showOperation({ id: requestId, action: input.action, status: 'unknown', error: { code: error.code ?? 'REQUEST_OUTCOME_UNKNOWN', message: error.message } }, { retry: () => request('operations.start', input) }); }
  } else await mutate('control.' + name, args, { title, description, preview: Object.keys(args).length ? args : null, success: '已收到操作结果。' });
}
async function showOperation(receipt, { retry } = {}) {
  const id = receipt?.operationId ?? receipt?.id ?? receipt?.operation?.id;
  const generation = startDetail('后台操作回执', 'OPERATION');
  async function update(query = true) {
    const item = query && id ? await request('operations.get', { id }) : receipt;
    if (generation !== state.detailGeneration) return;
    replace($('detail-content'), notice('查询状态不会重新执行操作。即使关闭此面板，也不要因等待时间较长而重复提交。'), kv({ '操作编号': id ?? '未返回编号', '状态': labels[item?.status] ?? item?.status ?? '已收到回执', '实际提交': item?.result?.committed == null ? '以回执为准' : item.result.committed ? '已提交' : '尚未提交', '暂停原因': item?.result?.pauseReason ?? item?.error?.code ?? '无' }), disclosure({}, element('summary', {}, '查看技术回执'), data(item)));
    replace($('detail-footer'), id ? button('查询最新状态', () => update(), 'primary') : null, retry && item.status === 'unknown' ? button('使用原编号重试请求', async () => { const confirmation = await confirmOperation({ title: '恢复原请求的回执', description: '使用相同请求编号和参数重发。服务端若已经接收，只返回原回执，不重复执行。不会生成新的付费操作编号。', preview: { requestId: id, action: receipt.action } }); if (!confirmation) return; receipt = await retry(); await update(false); }, 'secondary') : null, button('关闭', () => $('detail-dialog').close(), 'secondary'));
  }
  await update(false);
}
function stat(label, value, sub, icon, usage) {
  const node = element('section', { class: 'stat-card' }, element('span', { class: 'stat-icon', 'aria-hidden': true }, icon), element('div', { class: 'stat-label' }, label), element('div', { class: `stat-value${typeof value === 'string' && value.length < 8 ? ' word' : ''}` }, value), element('div', { class: 'stat-sub' }, sub));
  if (usage) { const ratio = usage.limit > 0 ? Math.min(100, usage.used / usage.limit * 100) : 0; node.append(element('div', { class: `progress${ratio >= 90 ? ' warning' : ''}`, role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': usage.limit, 'aria-valuenow': usage.used }, element('span', { style: `width:${ratio}%` }))); }
  return node;
}
async function overviewPage() {
  const status = state.status, runtime = status.runtime ?? {}, capacity = status.capacity ?? {}, jobs = runtime.jobCounts ?? {};
  const instanceId = state.instanceId, generation = state.generation;
  const alive = () => state.instanceId === instanceId && state.page === 'overview' && state.generation === generation;
  const savedStyle = status.config?.conversationStyle ?? 'short_chat';
  const conversationStyle = element('select', { id: 'conversation-style', class: 'inline-choice', 'aria-label': '交流节奏' }, [['short_chat', '自然短聊'], ['balanced', '按内容决定'], ['detailed', '完整展开']].map(([value, label]) => element('option', { value, selected: savedStyle === value }, label)));
  conversationStyle.addEventListener('change', async event => {
    const input = event.currentTarget, value = input.value; input.value = savedStyle;
    if (!alive() || value === savedStyle) return; input.disabled = true;
    try { await request('config.update', { instanceId, config: { conversationStyle: value } }); if (alive()) { toast('交流偏好已保存。'); await renderPage(); } }
    catch (error) { if (alive()) showError(error); }
    finally { if (input.isConnected) input.disabled = false; }
  });
  const persistent = capacity.persistentChars ?? capacity.longTermChars?.used, persistentLimit = capacity.longTermTargetChars ?? capacity.longTermChars?.limit;
  const hot = capacity.hotChars ?? capacity.tempChars?.used, hotLimit = capacity.tempTargetChars ?? capacity.tempChars?.limit;
  const gaps = runtime.memoryGapCounts?.unresolved ?? runtime.memoryGaps?.filter(item => !item.resolvedAt).length;
  const sleeping = runtime.sleep?.state === 'sleeping';
  const proactive = element('input', { id: 'proactive-allowed', type: 'checkbox', role: 'switch', 'aria-label': '允许主动找我聊天', checked: !runtime.globalMuted, onchange: async event => {
    const input = event.currentTarget, requested = input.checked; input.checked = !runtime.globalMuted; input.disabled = true;
    try { await request('control.' + (requested ? 'resume' : 'mute')); await renderPage(); }
    catch (error) { try { await renderPage(); } catch {} showError(error); }
    finally { input.disabled = false; }
  } });
  const daily = element('section', { class: 'daily-controls', 'aria-label': '日常交流设置' },
    element('div', { class: 'setting-row' }, element('div', { class: 'setting-copy' }, element('h2', {}, '当前状态：' + (labels[runtime.sleep?.state] ?? '尚未读取')),
      element('p', {}, sleeping ? '相续正在休息，期间的来信会保留。叫醒后，由它决定如何回应。' : '可以接收来信，是否回应由相续决定。')),
      sleeping ? button('现在叫醒', () => control('wake'), 'secondary') : null),
    element('div', { class: 'setting-row' }, element('div', { class: 'setting-copy' }, element('label', { class: 'setting-title', for: 'proactive-allowed' }, '允许主动找我聊天'),
      element('p', {}, '允许相续自主选择时机开口；关闭后仍可接收来信。')), proactive),
    element('div', { class: 'setting-row' }, element('div', { class: 'setting-copy' }, element('label', { class: 'setting-title', for: 'conversation-style' }, '交流节奏'),
      element('p', {}, '这是表达偏好，复杂内容仍可展开。分次补充可能增加模型调用，不保证每次发多条。')), conversationStyle));
  replace($('page-actions'));
  const controls = element('div', { class: 'row-actions' }, button('查看完整运行态', () => inspectDocument('state.get', {}, '完整运行状态'), 'secondary compact'), button('整理一批', () => control('consolidate'), 'secondary compact'));
  if (state.view === 'runtime') return element('div', {}, element('div', { class: 'stats-grid' }, stat('长期记忆', number(persistent), '上限 ' + number(persistentLimit) + ' 字符'), stat('临时资料', number(hot), '上限 ' + number(hotLimit) + ' 字符')),
    kv({ '当前状态': labels[runtime.sleep?.state] ?? '未知', '唤醒方式': ({ at_time: '相续选择的时间', consolidation_complete: '所选整理完成后', explicit_wake: '等你叫醒' })[runtime.sleep?.wakeCondition] ?? '尚未选择', '计划唤醒': date(runtime.sleep?.wakeAt), '下次判断': date(runtime.schedule?.nextCheckAt), '来源缺口': number(gaps), '接入会话': number(status.agents?.length), '排队整理': number(jobs.queued ?? 0), '物理占用': number(capacity.physicalBytes) + ' bytes' }), controls,
    status.agents?.length ? card('已接入的会话', '', status.agents.map(agent => kv({ '会话': agent.sessionId, '关系': personName(agent.personId), '渠道': agent.channelId }))) : empty('还没有接入人格会话', '回到 DSH 对话，选择“相续人格”预设即可开始。'));
  return element('div', {}, onboardingHint(), daily,
    !status.agents?.length ? element('p', { class: 'getting-started' }, '在 DSH 对话中选择“相续人格”预设，即可开始聊天。') : null,
    destinations(destination('了解相续', '它如何描述自己，以及留下的性格与习惯。', () => navigate('persona')),
      destination('独立任务与资料', '查看委派出去的任务和完整结果。', () => navigate('tasks')),
      destination('运行与用量', '查看记忆容量、会话接入和当前运行状态。', () => openSection('runtime')),
      destination('使用说明', '从初次认识到记忆、休息和可选功能。', () => openSection('user-guide'))));
}
const selfFields = [
  ['name', '名字'], ['pronouns', '称呼与代词'], ['gender', '性别表达'], ['ageDescription', '设定或外观年龄'],
  ['birthday', '设定生日'], ['background', '背景设定'], ['selfDescription', '自我描述'],
];
const selfModeLabels = { together: '一起确定', autonomous: '由相续选择', unset: '暂不设置' };
function selfValues(value) { return Object.fromEntries(selfFields.filter(([key]) => typeof value?.[key] === 'string' && value[key].trim()).map(([key, label]) => [label, value[key]])); }
function onboardingHint() {
  const summary = state.status.selfProfile;
  if (summary?.mode !== 'unset' || summary.onboardingAcknowledged !== false) return null;
  const instanceId = state.instanceId, generation = state.generation;
  const alive = () => state.instanceId === instanceId && state.page === 'overview' && state.generation === generation;
  return element('section', { class: 'onboarding-hint', 'aria-label': '初次使用提示' },
    element('div', { class: 'setting-copy' }, element('h2', {}, '先认识一下，也可以直接聊天'), element('p', {}, '可以一起确定名字与初始形象，或留给相续选择。暂不设置也不影响相处。')),
    element('div', { class: 'row-actions' }, button('设置初始资料', () => navigate('persona', 'self-profile'), 'secondary'),
      button('以后再说', async () => { if (!alive()) return; try { await request('self.update', { instanceId, patch: { mode: 'unset', onboardingAcknowledged: true }, expectedVersion: summary.version }); } catch (error) { if (alive()) throw error; return; } if (alive()) await renderPage(); }, 'link'),
      button('先看使用说明', () => openSection('user-guide'), 'link')));
}
async function selfProfilePage() {
  const instanceId = state.instanceId, generation = state.generation;
  const alive = () => state.instanceId === instanceId && state.page === 'persona' && state.view === 'self-profile' && state.generation === generation;
  const profile = await request('self.get');
  const mode = field('self-mode', '初始身份怎么确定？', profile.mode ?? 'unset', { choices: [['together', '一起确定'], ['autonomous', '由相续选择'], ['unset', '暂不设置']], hint: '保存的是相处的起点，不要求人格一直照着设定表演。所有资料都可以留空。' });
  const inputs = Object.fromEntries(selfFields.map(([key, label]) => [key, field('self-initial-' + key, key === 'selfDescription' ? '你想给相续的一点初始想法' : label, profile.initial?.[key] ?? '', { multiline: ['selfDescription', 'background'].includes(key), placeholder: key === 'name' ? '可以建议一个名字，也可以让相续自己取' : key === 'selfDescription' ? '例如初次想怎样认识彼此。可以留空。' : undefined })]));
  const initialForm = element('div', { class: 'self-initial-fields' }, inputs.name.wrapper, inputs.selfDescription.wrapper,
    disclosure({}, element('summary', {}, '更多身份资料'), element('div', { class: 'form-grid' }, inputs.pronouns.wrapper, inputs.gender.wrapper, inputs.ageDescription.wrapper, inputs.birthday.wrapper), inputs.background.wrapper),
    element('p', { class: 'subtle-note' }, '这一组资料合计最多 2,400 个字符。年龄与生日按你的描述保存，不据此规定性格、成熟程度或成长速度。背景设定与实际共同经历分别保留。'));
  const modeNote = element('p', { class: 'subtle-note' });
  function updateMode() {
    initialForm.hidden = mode.input.value !== 'together';
    modeNote.hidden = mode.input.value === 'together';
    modeNote.textContent = mode.input.value === 'autonomous' ? '由相续选择或暂时保持未定。已有的初始想法仍保留，不会因为切换方式而删除。' : '先保留空白，随时可以回来补充，也可以直接在聊天中认识彼此。已有资料不会因此被清空。';
  }
  mode.input.addEventListener('change', updateMode); updateMode();
  const save = button('保存初始资料', async () => {
    if (!alive()) return;
    const patch = { mode: mode.input.value, onboardingAcknowledged: true };
    if (patch.mode === 'together') {
      patch.initial = Object.fromEntries(selfFields.map(([key]) => [key, inputs[key].input.value]));
      if (Object.values(patch.initial).reduce((sum, text) => sum + Array.from(text).length, 0) > 2400) throw new Error('初始资料合计不能超过 2,400 个字符，请保留最想表达的部分。');
    }
    try { await request('self.update', { instanceId, patch, expectedVersion: profile.version }); }
    catch (error) { if (alive()) throw error; return; }
    if (!alive()) return;
    toast('初始资料已保存。相续的当前自我描述保持独立。'); await renderPage();
  }, 'primary', { dataset: { action: 'save-self-profile' } });
  const current = selfValues(profile.current), initial = selfValues(profile.initial);
  const currentSection = card('当前自我描述', '这是当前保存的自我资料。你提出的初始想法不会自动覆盖这里。',
    Object.keys(current).length ? kv(current) : element('p', { class: 'muted' }, '当前自我档案还没有描述。已有的身份基调仍然保留；不需要为了填满这里而生成资料。'));
  const history = Array.isArray(profile.history) ? profile.history : [];
  const historyPanel = disclosure({}, element('summary', {}, '查看过去的资料与保存信息'),
    kv({ '当前资料版本': profile.version, '初始化方式': selfModeLabels[profile.mode] ?? '尚未选择', '自我档案首次保存': profile.createdAt ? date(profile.createdAt) : '尚未保存或旧资料未记录', '最近更新': profile.updatedAt ? date(profile.updatedAt) : '尚未保存' }),
    element('p', { class: 'subtle-note' }, '首次保存时间只说明这份自我档案何时建立，不是人格的生日或年龄。历史保留有容量上限。'),
    history.length ? element('div', { class: 'record-list' }, history.map(item => element('article', { class: 'record' }, element('h3', {}, '资料版本 ' + (item.version ?? '—')), Object.keys(selfValues(item.current)).length ? kv(selfValues(item.current)) : element('p', { class: 'muted' }, '这一版还没有当前自我描述。'), disclosure({}, element('summary', {}, '查看这一版的初始想法与来源'), data(item))))) : element('p', { class: 'muted' }, '当前没有已保留的旧版本。'));
  return element('div', { class: 'self-profile-page' }, currentSection,
    card('你想怎样认识相续', '你可以建议一个起点，是否接受以及后续怎样理解自己，由相续在相处中决定。',
      mode.wrapper, initialForm, modeNote, element('div', { class: 'form-footer' }, element('p', {}, '这里只保存资料，不会调用模型，也不直接改写当前自我描述。'), save)),
    Object.keys(initial).length ? disclosure({}, element('summary', {}, '查看已保存的初始想法'), kv(initial)) : null,
    destinations(destination('身份基调', '查看随着经历形成的共同人格描述。', () => openSection('anchor')),
      destination('形象档案', '管理外貌描述与参考图，保持作品中的形象连续。', () => navigate('media', 'identity')),
      destination('声音', '查看可用音色及当前的声音选择。', () => navigate('chat', 'voice')),
      destination('使用说明', '了解身份、记忆、主动联系和日常操作。', () => openSection('user-guide'))), historyPanel);
}
const userGuideTopics = [
  ['开始相处', '在 DSH 对话中选择“相续人格”预设即可开始。可以直接打招呼，也可以在“了解相续 → 自我档案”给出名字、称呼或形象方面的初始想法；由相续选择或暂不设置都可以。初始资料与当前采用的自我描述分别保存。'],
  ['同一个人格，新的聊天窗口', '继续使用同一人格实例时，新开窗口不等于重新创建人格。不同实例分别保存资料。换了平台、昵称或群聊环境，可能需要提醒相续你希望被怎样称呼；账号和称呼是线索，不保证一定认对人。'],
  ['记住、想起与检索', '接收记录、当前回忆和长期整理是不同过程。本次没有提起过去，不代表资料已经被删除；尚未检索、检索未找到、记忆库为空和读取失败也不同。记什么、怎样理解和何时回忆，由相续决定。你可以在“记忆”里查看已保留内容，并在理解有误时直接纠正。'],
  ['短句与分条表达', '在“相处 → 交流节奏”选择自然短聊、按内容决定或完整展开。这是表达偏好，不是字数、条数或频率硬限制，复杂内容仍可展开。可以分次表达，但不保证每次发多条；每次补充可能增加一次模型调用。分不分条、说几句、是否继续，由相续结合实际交流决定；不会按消息条数要求人格进化。各渠道以实际能力和逐条回执为准。'],
  ['允许主动找我聊天', '开启表示允许相续自主选择联系时机，不保证每天或每隔多久发一次。关闭后仍可接收你的来信；是否回应、如何相处仍由相续判断。'],
  ['休息与现在叫醒', '休息期间来信会保留。相续可以选择时间、整理完成或等你叫醒；“现在叫醒”结束这次休息，让相续看到保留的来信。唤醒可能调用模型，醒来后是否以及怎样回应仍由相续决定。'],
  ['模型与思考强度', '模型和思考强度会影响等待时间、用量与复杂判断，相关后台整理也可能沿用对应会话的选择。强度不是感情深度，也不保证越高越自然；计费按当前模型服务和实际用量计算。'],
  ['形象、声音与身份资料', '形象与声音可以按需设置或交由相续选择。头像年龄、虚拟设定年龄、设定生日与实际建立时间分别看待；音色不会自动决定性别、性格或成熟程度。当前形象参考与旧作品分别保留。'],
  ['连接 QQ、微信与其他平台', '在“连接”里按实际驱动扫码或配置兼容桥。连接支持范围、你的许可和当前可用状态分别查看；接通账号不等于能使用平台全部功能。当前官方 QQ 为 Bot 接入，微信官方接入为私聊；普通微信群、朋友圈或实时通话不能仅靠扫码获得。'],
  ['容量、备份与遗忘', '记忆有存储与上下文容量限制，不承诺永久保存全部原话。你可以查看容量、创建备份或明确遗忘；实际作用范围以操作说明和回执为准。文本备份不包含外部图片、视频、平台凭据或供应商保存的副本。用于生成的材料会交给你选择的模型服务处理。'],
  ['认错人、记错事或表达不自然', '可以直接告诉相续你的感受，说明哪一处理解不对。若反复声称刚认识你、把未检索说成完全没有记忆，或身份资料前后矛盾，可记录使用的人格实例、模型、原话与时间；在“设置 → 数据维护与诊断”查看实际状态，再区分表达问题与技术故障。'],
];
function userGuidePage() {
  return element('article', { class: 'user-guide' },
    element('p', { class: 'guide-intro' }, '相续是一位可以保留经历、形成持续自我描述的 AI 伙伴。你可以从一句话开始，身份资料和可选功能以后再慢慢确定。'),
    element('p', { class: 'subtle-note' }, '这份说明介绍产品怎样使用，不是要求人格必须变成某种性格。查看说明不会启动模型、登录账号或执行管理操作。'),
    ...userGuideTopics.map(([title, text]) => element('section', { class: 'reading-section' }, element('h2', {}, title), element('p', {}, text))));
}

async function personaPage() {
  if (state.view === 'self-profile') return selfProfilePage();
  let section = 'anchor', personaGeneration = 0;
  const content = element('div'), modules = [['anchor', '身份基调'], ['axes', '性格维度'], ['facets', '性格与偏好'], ['signatures', '常见反应'], ['habits', '习惯'], ['retired', '过去的描述']];
  const tabs = element('div', { class: 'module-tabs' });
  async function load(selected) {
    const generation = ++personaGeneration;
    section = selected; tabs.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.section === section));
    replace(content, element('p', { class: 'loading-note' }, '正在读取人格模块…'));
    const result = await request('persona.get', { section });
    if (generation !== personaGeneration) return;
    let value = result;
    if (result?.format === 'json_text_fragment') { if (!result.fragment.complete) { replace(content, card('当前模块', '内容较长，按真实游标分页查看。', notice('模块内容尚未完整读取。'), button('打开分页详情', () => inspectDocument('persona.get', { section }, modules.find(x => x[0] === section)[1]), 'primary'))); return; } value = JSON.parse(result.text); }
    const module = value?.section === section ? value.value : value?.[section] ?? value;
    const title = modules.find(item => item[0] === section)[1], node = card(title, '这些是已保存的人格描述，不是要求每次交流都满足的行为规则。');
    if (section === 'anchor') { const text = module?.text ?? (typeof module === 'string' ? module : ''); node.append(text ? element('div', { class: 'persona-anchor' }, text) : empty('尚未形成身份基调', '人格可以暂时保留空白，不要求为了填满面板而生成内容。', '✳')); if (module?.changedAt) node.append(element('p', { class: 'subtle-note' }, '更新于 ' + date(module.changedAt))); }
    else if (Array.isArray(module)) node.append(module.length ? element('div', { class: 'record-list' }, module.map(item => element('article', { class: 'record' }, element('h3', { class: 'record-title' }, item.name ?? item.label ?? item.id ?? '条目'), element('p', { class: 'record-text' }, item.text ?? item.desc ?? item.description ?? (item.if ? '情境：' + item.if + (item.then ? '\n倾向：' + item.then : '') : item.cue ?? item.entry?.desc ?? '尚未描述')), element('div', { class: 'record-meta' }, item.scope ? tag(item.scope === 'global' ? '共同人格' : personName(item.personId)) : null, item.epistemic ? tag(item.epistemic) : null, item.observations != null ? tag('描述性观察 ' + number(item.observations)) : null), button('查看完整字段与来源', () => { const id = startDetail('人格条目', 'PERSONA'); replace($('detail-content'), data(item)); replace($('detail-footer'), button('关闭', () => $('detail-dialog').close(), 'secondary')); return id; }, 'link')))) : empty('当前没有条目', '本模块可以保持不变，空白不是异常。'));
    else if (module && typeof module === 'object') node.append(...Object.entries(module).map(([name, item]) => element('section', { class: 'reading-section' }, element('h3', {}, name), element('p', { class: 'detail-value' }, typeof item === 'string' ? item : item?.desc ?? item?.text ?? item?.description ?? '尚未描述'))));
    else node.append(element('p', { class: 'muted' }, typeof module === 'string' ? module : '尚未形成描述。'));
    node.append(button('查看当前模块原始字段', () => inspectDocument('persona.get', { section }, title), 'link')); replace(content, node);
  }
  for (const [key, label] of modules) tabs.append(button(label, () => load(key), 'module-tab', { class: `module-tab${key === section ? ' active' : ''}`, dataset: { section: key } }));
  await load(section); return element('div', {}, destinations(destination('自我档案', '初始想法与当前自我描述分别保存，名字与形象可以慢慢确定。', () => openSection('self-profile'))), tabs, content);
}
function memoryRecord(record, open) {
  const role = record.recordType === 'deep' ? '人格记忆' : record.role ?? record.sourceRole ?? record.srcRefs?.[0]?.sourceRole;
  const text = record.recordType === 'deep' ? record.reference ?? record.textPreview ?? record.experience ?? '' : record.text ?? record.textPreview ?? record.summary ?? record.expansion ?? record.meaning ?? record.preview ?? record.anchorPreview ?? record.title ?? '';
  return element('article', { class: 'record' }, element('div', { class: 'record-header' }, element('h3', { class: 'record-title' }, record.label ?? record.name ?? (record.recordType === 'deep' ? record.title : null) ?? ({ chat: '对话原件', memory: '记忆提炼', deep: '深刻记忆', code: '编码', relation_signature: '关系签名', relation_event: '关系事件', interpretation: '待解释', facet: '人格倾向', signature: '共同签名', habit: '习惯' })[record.recordType] ?? record.recordType ?? '记忆条目'), element('time', { class: 'record-time' }, record.sourceAt || record.createdAt || record.updatedAt ? date(record.sourceAt ?? record.createdAt ?? record.updatedAt) : '时间未提供')),
    element('p', { class: 'record-text' }, short(text, 360)), element('div', { class: 'record-meta' }, tag(({ assistant: 'AI 助手', user: '用户原话', system: '程序材料' })[role] ?? role ?? '提炼/解释', role === 'assistant' ? 'ai' : role === 'user' ? 'human' : ''), tag(memoryScopeLabel(record)), record.speakerId ? tag('发言者：' + record.speakerId) : null, record.epistemic ? tag(record.epistemic) : null),
    element('div', { class: 'record-footer' }, button('查看详情 →', open, 'link')));
}
async function memoryPage() {
  const container = element('div'), filters = element('div', { class: 'toolbar', role: 'search' }), resultArea = element('div');
  const query = field('memory-query', '搜索线索', '', { placeholder: '原话、记忆或编码中的文字', class: 'search' });
  const scope = field('memory-scope', '查询范围', 'all', { choices: [['all', '全部关系'], ['person', '指定人物'], ['global', '共同记忆'], ['unknown', '未知暂存']] });
  const person = field('memory-person', '关系人物', '', { choices: [['', '请选择人物'], ...state.people.map(item => [item.personId ?? item.id, item.displayName ?? item.personId ?? item.id])] });
  const type = field('memory-type', '条目类型', state.view === 'deep' ? 'deep' : '', { choices: [['', '全部类型'], ['chat', '对话原件'], ['memory', '记忆索引'], ['deep', '深刻记忆（人格参考）'], ['code', '编码'], ['relation_signature', '关系签名'], ['relation_event', '关系事件'], ['interpretation', '待解释'], ['facet', '人格倾向'], ['signature', '共同签名'], ['habit', '习惯']] });
  let args = {}, pageNumber = 1, listGeneration = 0;
  async function openRecord(item) {
    const id = item.id ?? item.recordId;
    await inspectDocument('memory.detail', { id }, '记忆详情', { eyebrow: 'MEMORY / SOURCE', actions: [
      { label: '明确遗忘此条目', kind: 'danger', run: async () => { const result = await mutate('memory.forget', { ids: [id], ...(item.personId ? { targetPersonId: item.personId, scope: 'person' } : { scope: item.scope === 'global' ? 'global' : 'unknown' }) }, { title: '明确遗忘所选条目', description: '撤销选定记录及必要派生，并清理相关临时副本与未提交候选。明确撤销不会因回滚或重建而复活；宿主独立日志与外部备份不由此删除。', preview: { ids: [id], relationship: memoryScopeLabel(item), role: item.role ?? item.sourceRole }, reason: true, danger: true, accept: '确认遗忘' }); if (result) { startDetail('明确遗忘的实际结果', 'REVOCATION / RECEIPT'); replace($('detail-content'), notice(`实际影响 ${number(result.affectedCount ?? result.affectedIds?.length)} 条；是否完整列出以回执字段为准。`), data(result)); replace($('detail-footer'), button('关闭', () => $('detail-dialog').close(), 'secondary')); } } },
      ...(item.sourceSessionId && item.sourceEventId ? [{ label: '关联到关系…', run: async () => {
        const generation = startDetail('为原件选择关系归属', 'RELATIONSHIP'), choice = field('assign-person', '关系人物', '', { choices: [['', '请选择关系人物'], ...state.people.map(p => [p.personId ?? p.id, p.displayName ?? p.personId ?? p.id])] }), lookup = field('assign-person-query', '查找更多已知人物', '', { placeholder: '姓名、别名或人物 ID' }), reason = field('assign-reason', '操作说明', '', { multiline: true });
        const lookupResult = element('p', { class: 'small muted' });
        const find = button('查询人物', async () => { const result = await request('people.list', { query: lookup.input.value.trim(), pageSize: 100 }); replace(choice.input, element('option', { value: '' }, '请选择查询到的人物'), getItems(result).map(p => element('option', { value: p.personId ?? p.id }, p.displayName ?? p.personId ?? p.id))); lookupResult.textContent = `匹配 ${number(result.total)} 人${result.nextCursor ? '，请用更具体的线索缩小范围。' : '。'}`; }, 'secondary compact');
        replace($('detail-content'), notice('关系归属用于检索分区。关联助手原件仍保留 assistant 角色、实际 speakerId、原话和来源，不把它改成人类发言。'), lookup.wrapper, find, lookupResult, choice.wrapper, reason.wrapper);
        replace($('detail-footer'), button('确认关联', async () => { if (!choice.input.value) throw new Error('请选择已知关系人物。'); const result = await mutate('memory.assign', { sourceSessionId: item.sourceSessionId, sourceEventId: item.sourceEventId, personId: choice.input.value, reason: reason.input.value }, { title: '确认关系归属', description: '只对这条所选原件改变关系归属，保留真实来源与发言角色。', refresh: false }); if (result && generation === state.detailGeneration) { $('detail-dialog').close(); await load(); } }, 'primary'), button('取消', () => $('detail-dialog').close(), 'secondary'));
      } }] : []),
    ] });
  }
  async function load(cursor) {
    const generation = ++listGeneration;
    if (!cursor) { pageNumber = 1; args = { query: query.input.value.trim(), scope: scope.input.value, ...(scope.input.value === 'person' ? { personId: person.input.value } : {}), ...(type.input.value ? { recordType: type.input.value } : {}), pageSize: 12 }; if (args.scope === 'person' && !args.personId) throw new Error('请选择要查看的人物。'); }
    else pageNumber++;
    const result = await request('memory.list', { ...args, ...(cursor ? { cursor } : {}) });
    if (generation !== listGeneration) return;
    replace(resultArea, getItems(result).length ? element('div', { class: 'record-list' }, getItems(result).map(item => memoryRecord(item, () => openRecord(item)))) : card('查询结果', '', empty('没有匹配的已保留条目', '可以调整查询范围或线索。未知暂存不自动属于当前人物，原件淘汰或明确撤销后也可能不再可查。', '▤')), paginator(result, load, { pageNumber }));
  }
  scope.input.addEventListener('change', () => { person.input.disabled = scope.input.value !== 'person'; if (scope.input.value === 'person' && !person.input.value) { listGeneration++; replace(resultArea, notice('请选择关系人物后查询。')); } else load().catch(showError); }); person.input.disabled = true;
  person.input.addEventListener('change', () => { if (scope.input.value === 'person') load().catch(showError); });
  type.input.addEventListener('change', () => { if (scope.input.value !== 'person' || person.input.value) load().catch(showError); });
  query.input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); load().catch(showError); } }); filters.append(query.wrapper, button('搜索', () => load(), 'primary'));
  const advancedFilters = disclosure({}, element('summary', {}, '筛选范围与类型'), element('div', { class: 'form-grid' }, scope.wrapper, person.wrapper, type.wrapper));
  const peopleQuery = field('people-query', '搜索已知人物', '', { placeholder: '姓名、别名或人物 ID' }), peopleResults = element('div');
  let peopleArgs = {}, peoplePage = 1, peopleGeneration = 0;
  async function loadPeople(cursor) {
    const generation = ++peopleGeneration;
    if (!cursor) { peopleArgs = { query: peopleQuery.input.value.trim(), pageSize: 15 }; peoplePage = 1; } else peoplePage++;
    const result = await request('people.list', { ...peopleArgs, ...(cursor ? { cursor } : {}) }); if (generation !== peopleGeneration) return;
    const rows = getItems(result), known = new Map([...state.people, ...rows].map(item => [item.personId ?? item.id, item])); state.people = [...known.values()].slice(-200);
    replace(peopleResults, rows.length ? element('div', { class: 'people-list' }, rows.map(item => element('div', {}, button(item.displayName ?? item.personId, () => inspectDocument('relation.get', { personId: item.personId ?? item.id, section: 'all' }, '关系 · ' + (item.displayName ?? item.personId), { eyebrow: 'RELATIONSHIP' }), 'person-button', { class: 'person-button' }), button('筛选此人的记忆', async () => { const id = item.personId ?? item.id; if (![...person.input.options].some(option => option.value === id)) person.input.append(element('option', { value: id }, item.displayName ?? id)); state.memoryPerson = { id, name: item.displayName ?? id }; await openSection('', false); }, 'link')))) : empty('没有匹配的已知人物', '这里不会按姓名自动创建或合并人物。'), paginator(result, loadPeople, { pageNumber: peoplePage }));
  }
  peopleQuery.input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); loadPeople().catch(showError); } });
  const relations = card('人物与关系', '按真实人物列表分页。查看主观印象、编码与相处状态。', peopleQuery.wrapper, button('搜索人物', () => loadPeople(), 'secondary compact'), peopleResults);
  const tabs = sectionTabs([['', '全部记忆'], ['deep', '深刻经历'], ['people', '认识的人']]);
  container.append(tabs);
  if (state.view === 'people') { await loadPeople(); container.append(relations); return container; }
  if (state.memoryPerson) { const selected = state.memoryPerson; scope.input.value = 'person'; person.input.disabled = false; if (![...person.input.options].some(item => item.value === selected.id)) person.input.append(element('option', { value: selected.id }, selected.name)); person.input.value = selected.id; container.append(element('div', { class: 'active-filter' }, element('span', {}, '正在看：' + selected.name), button('查看所有人的记忆', async () => { state.memoryPerson = null; await openSection('', false); }, 'link'))); }
  if (state.view === 'deep') container.append(element('p', { class: 'subtle-note' }, '人格保留的重要经历。是否回忆、怎样理解和修剪，仍由它自己决定。'), button('查看深刻记忆模块', () => inspectDocument('persona.get', { section: 'deep' }, '深刻记忆'), 'link'));
  await load(); container.append(filters, advancedFilters, resultArea,
    destinations(destination('成长记录', '查看已发生的整理与人格变化。', () => navigate('evolution')))); return container;
}
async function evolutionPage() {
  const content = element('div'), list = element('div'), filter = field('job-status', '作业状态', '', { choices: [['', '全部状态'], ['queued', '待执行'], ['running', '执行中'], ['paused', '已暂停'], ['prepared', '已准备'], ['committed', '已提交'], ['completed', '已完成'], ['failed', '失败'], ['invalidated', '已失效']] });
  let pageNumber = 1, listGeneration = 0;
  async function showJob(item) {
    const args = item.runId || item.kind === 'run' ? { runId: item.runId ?? item.id } : { jobId: item.jobId ?? item.id };
    const actions = item.status === 'paused' || item.status === 'prepared' ? [{ label: '明确继续这批整理', kind: 'primary', run: async () => {
      if (!args.runId && !item.children?.find(child => child.runId && child.status !== 'committed')) throw new Error('请在完整作业详情中选取实际未提交子 runId 后继续。');
      const runId = args.runId ?? item.children.find(child => child.runId && child.status !== 'committed').runId;
      await control('consolidate', { runId });
    } }] : [];
    await inspectDocument('jobs.detail', args, item.kind === 'run' ? '整理批次详情' : '所选作业详情', { eyebrow: 'EVOLUTION / JOB', actions });
  }
  async function load(cursor) {
    const generation = ++listGeneration;
    pageNumber = cursor ? pageNumber + 1 : 1;
    const result = await request('jobs.list', { ...(filter.input.value ? { status: filter.input.value } : {}), ...(cursor ? { cursor } : {}), pageSize: 12 });
    if (generation !== listGeneration) return;
    replace(list, getItems(result).length ? element('div', { class: 'record-list' }, getItems(result).map(item => element('article', { class: 'record' }, element('div', { class: 'record-header' }, element('div', {}, element('h3', { class: 'record-title' }, item.kind === 'run' ? '增量整理批次' : '人格所选整理作业'), element('code', { class: 'muted' }, item.id)), pill(item.status)), element('div', { class: 'record-meta' }, item.personId !== undefined ? tag('关系：' + personName(item.personId)) : null, item.createdAt ? tag(date(item.createdAt)) : null, item.modelCalls != null ? tag('调用尝试 ' + number(item.modelCalls)) : null, item.targets ? tag('目标 ' + number(item.targets.length)) : null), item.error || item.validationError ? notice(short(item.error ?? item.validationError, 350), 'warning') : null, element('div', { class: 'record-footer' }, element('span', { class: 'small muted' }, '以实际提交回执和读取进度为准'), button('查看进度与变更 →', () => showJob(item), 'link'))))) : card('整理作业', '', empty('没有当前筛选下的作业', '人格可以选择暂缓整理，空变更也有效。已清理的诊断不会被冒称为永久历史。', '⌁')), paginator(result, load, { pageNumber }));
  }
  const history = await request('history.list', { pageSize: 30 }), allVersions = getItems(history), versions = allVersions.filter(item => !item.current);
  const operations = await request('operations.list', { pageSize: 10 });
  const operationArea = element('div'); let operationPage = 1;
  async function renderOperations(result) {
    replace(operationArea, getItems(result).length ? element('div', { class: 'record-list' }, getItems(result).map(item => element('div', { class: 'record' }, element('div', { class: 'record-header' }, element('h3', { class: 'record-title' }, item.action === 'control.consolidate' ? '明确整理请求' : '来源回补请求'), pill(item.status)), element('code', { class: 'muted' }, item.id), button('查询原操作回执', () => showOperation(item), 'link')))) : empty('没有保留的管理操作回执', '手动整理、续执行和来源回补会保留回执。查询回执不会重新调用模型。'), paginator(result, async cursor => { operationPage++; await renderOperations(await request('operations.list', { pageSize: 10, cursor })); }, { pageNumber: operationPage }));
  }
  await renderOperations(operations);
  const from = field('history-from', '对比起点', versions[0]?.version ?? '', { choices: [['', '选择已保留版本'], ...versions.map(item => [String(item.version), `v${item.version} · ${date(item.updatedAt)}`])] });
  const to = field('history-to', '对比终点', '', { choices: [['', '当前人格'], ...versions.map(item => [String(item.version), `v${item.version}`])] });
  const comparison = card('已保留的人格历史', '历史容量有限；明确遗忘后的旧内容不会通过回滚恢复。', versions.length ? element('div', {}, element('div', { class: 'form-grid' }, from.wrapper, to.wrapper), element('div', { class: 'row-actions' }, button('查看前后对比', async () => { if (!from.input.value) throw new Error('请选择已保留的起点版本。'); await inspectDocument('history.diff', { fromVersion: Number(from.input.value), ...(to.input.value ? { toVersion: Number(to.input.value) } : {}) }, '人格历史前后对比', { eyebrow: 'EVOLUTION / DIFF' }); }, 'secondary'), button('回滚到起点版本', async () => { if (!from.input.value) throw new Error('请选择已保留版本。'); const result = await mutate('persona.rollback', { version: Number(from.input.value) }, { title: '回滚共同人格', description: '把所选已保留人格版本应用为一个新版本。只回滚支持的人格历史，不会撤销明确遗忘，也不等于整个记忆库恢复。', preview: { version: Number(from.input.value) }, danger: true, accept: '确认回滚' }); if (result) toast('回滚已返回实际结果。'); }, 'danger'))) : empty('尚无可对比的历史版本', '共同人格发生变更并保存历史后，这里才会出现真实版本。'));
  filter.input.addEventListener('change', () => load().catch(showError));
  const tabs = sectionTabs([['', '整理进度'], ['history', '人格变化'], ['receipts', '手动操作']]);
  if (state.view === 'history') return element('div', {}, tabs, comparison);
  if (state.view === 'receipts') return element('div', {}, tabs, operationArea);
  await load(); content.append(tabs, element('div', { class: 'toolbar' }, filter.wrapper, button('整理这批资料', () => control('consolidate'), 'secondary')), element('p', { class: 'subtle-note' }, '相续可以暂缓整理，也可以选择不改变任何内容。这里显示真实进度。'), list); return content;
}
const configGroups = [
  ['记忆与存储', [['longTermTargetChars', '长期文本总目标', '字符'], ['recentTargetChars', '近期视图目标', '字符'], ['recentPreferredDays', '近期优先天数', '天；不是永久保留保证'], ['tempTargetChars', '临时过程目标', '字符'], ['diskReserveBytes', '磁盘保留空间', 'bytes']]],
  ['记录与文件上限', [['capacityLimits.artifactTextChars', '单条进化记录文本', '字符'], ['capacityLimits.artifactRecordBytes', '单条记录序列化', 'bytes'], ['capacityLimits.documentBytes', '业务 JSON 文档', 'bytes'], ['capacityLimits.storeBytes', '实例物理空间', 'bytes；另验事务峰值']]],
  ['整理输入与输出', [['processingLimits.consolidationInputChars', '新批每目标增量', '字符；不重切旧批'], ['processingLimits.consolidationContextChars', '旧记忆每页', '字符'], ['processingLimits.consolidationRequestTokens', '核心完整请求预算', '计数单位；缺 tokenizer 时标估算'], ['processingLimits.consolidationOutputTokens', '整理输出预留', 'tokens'], ['processingLimits.controlOutputTokens', '控制输出预留', 'tokens'], ['processingLimits.replyOutputTokens', '回复输出预留', 'tokens']]],
  ['作业执行容量', [['processingLimits.consolidationCallsPerSegment', '单执行段调用尝试', '跨全部子批共享；不是每日频率'], ['processingLimits.maxQueuedConsolidations', '最大排队作业', '个'], ['processingLimits.maxTargetsPerJob', '每作业最多目标', '个']]],
  ['普通注入预算', [['contextBudget.totalTokens', '动态人格材料总预算', '计数单位'], ['contextBudget.environmentTokens', '环境', '计数单位'], ['contextBudget.anchorTokens', '身份基调', '计数单位'], ['contextBudget.personaTokens', '人格', '计数单位'], ['contextBudget.habitTokens', '习惯', '计数单位'], ['contextBudget.relationTokens', '关系', '计数单位'], ['contextBudget.retrievalTokens', '检索', '计数单位'], ['contextBudget.deepMemoryTokens', '深刻记忆参考', '计数单位；仍受总预算约束，不表示已触发回忆']]],
  ['条目容量', [['artifactLimits.axes', '性格维度', '个'], ['artifactLimits.tendencyFacets', '倾向', '个'], ['artifactLimits.boundaryFacets', '软边界', '个'], ['artifactLimits.signatures', '共同签名', '个'], ['artifactLimits.habits', '习惯', '个'], ['artifactLimits.impressionSignaturesPerPerson', '每人印象签名', '个'], ['artifactLimits.indexItemsPerPerson', '每人索引', '个'], ['artifactLimits.codesPerScope', '每范围编码', '个'], ['artifactLimits.interpretationsPerPerson', '每人待解释', '个'], ['artifactLimits.relationEventsPerPerson', '每人关系事件', '个'], ['artifactLimits.deepMemories', '深刻记忆条目', '个；满容量不自动替人格选取舍'], ['artifactLimits.deepMemoryChars', '深刻记忆文本总量', '字符；仍受实例容量约束']]],
  ['有限历史与诊断', [['retention.snapshotMaxRequests', '快照保留数量', '条'], ['retention.personaHistoryMaxVersions', '人格历史版本', '个'], ['retention.journalMaxBytes', '运行日志与工作区', 'bytes'], ['retention.backupMaxBytes', '维护备份容量', 'bytes']]],
];
const getPath = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
function setPath(object, path, value) { const keys = path.split('.'); let node = object; for (const key of keys.slice(0, -1)) node = node[key] ??= {}; node[keys.at(-1)] = value; }
function instanceLifecyclePanel(instances, { alive }) {
  async function refresh(preferId, { useActualSelection = false } = {}) {
    try {
      const latest = await request('instances.list', { instanceId: undefined });
      if (!alive()) return;
      const items = instanceItems(latest), nextId = preferId ?? (useActualSelection ? latest.activeInstanceId ?? latest.selectedInstanceId : state.instanceId) ?? latest.selectedInstanceId ?? latest.activeInstanceId ?? items[0]?.id ?? null;
      const viewed = items.find(item => item.id === nextId);
      const people = viewed?.loaded ? getItems(await request('people.list', { instanceId: nextId, pageSize: 100 })) : [];
      if (!alive()) return;
      state.instances = items; state.instanceId = nextId; state.people = people; state.budgetDraft = null; state.memoryPerson = null;
      const nextGeneration = state.generation + 1; await renderPage();
      if (state.instanceId === nextId && state.generation === nextGeneration) return { instanceId: nextId, loaded: Boolean(viewed?.loaded) };
    } catch (error) { if (alive()) showError(error); }
  }
  async function change(item, action, { title, description, accept = '确认执行', activate = false, guard = alive } = {}) {
    if (!guard()) return;
    const confirmation = await confirmOperation({ title, description, preview: { 人格: item.name ?? item.id, 目录: item.memoryRoot }, accept });
    if (!confirmation || !guard()) return;
    let result;
    try { result = await request(action, { instanceId: item.id, ...(action === 'instances.restore' ? { activate: true } : {}) }); }
    catch (error) { if (guard()) showError(error); return; }
    if (!guard()) return;
    if ($('detail-dialog').open) { state.detailGeneration++; $('detail-dialog').close(); }
    toast('操作已返回，正在读取人格的实际状态。');
    await refresh(activate ? result?.activeInstanceId ?? item.id : undefined);
  }
  const archive = (item, guard = alive) => change(item, 'instances.archive', { title: '归档这个人格', description: '停止使用并保留这个人格的资料，之后可以恢复。归档不是独立备份；不会清除记忆、作品或退出共享平台账号，当前有工作时由后端检查。', accept: '归档并保留资料', guard });
  async function clearPreview(item) {
    if (!alive()) return;
    let preview;
    try { preview = await request('instances.clearPreview', { instanceId: item.id }); }
    catch (error) { if (alive()) showError(error); return; }
    if (!alive()) return;
    if (preview?.instanceId !== item.id || preview.memoryRoot !== item.memoryRoot || typeof preview.requiresName !== 'string' || !preview.requiresName || typeof preview.confirmationToken !== 'string' || !preview.confirmationToken || typeof preview.version !== 'string' || !/^[a-f0-9]{64}$/.test(preview.version) || !Number.isSafeInteger(preview.files) || preview.files < 0 || !Number.isSafeInteger(preview.bytes) || preview.bytes < 0 || !Array.isArray(preview.scope) || !preview.scope.length || preview.scope.some(value => typeof value !== 'string')) throw new Error('无法核实清除预览，尚未发起清除。请重新读取人格管理。');
    const generation = startDetail('清除人格文本资料前，请核对', 'PERSONA / CLEAR');
    const panelAlive = () => alive() && state.detailGeneration === generation && $('detail-dialog').open;
    const name = field('instance-clear-name', '输入人格名称以确认', '', { placeholder: preview.requiresName, hint: '请完整输入：' + preview.requiresName });
    const note = element('p', { class: 'subtle-note' }, '尚未输入名称，不会执行清除。'), resultArea = element('div'); let clearing = false;
    const submit = element('button', { type: 'button', class: 'button danger', disabled: true, dataset: { action: 'confirm-clear-instance' }, onclick: async () => {
      if (!panelAlive() || clearing || name.input.value !== preview.requiresName) return;
      clearing = true; name.input.disabled = true; submit.disabled = true;
      replace(resultArea, notice('正在执行这次明确清除。关闭页面不会撤回已经提交的操作；不要重复提交。'));
      try {
        const result = await request('instances.clear', { instanceId: item.id, confirmationToken: preview.confirmationToken, typedName: name.input.value });
        if (!alive()) return;
        if (state.detailGeneration === generation) { state.detailGeneration++; $('detail-dialog').close(); }
        toast(result?.status === 'partial' ? '清除未完成，旧实例保持不可加载。请重新预览再决定是否继续。' : '清除请求已返回，正在读取实际结果。'); await refresh();
      } catch (error) { if (panelAlive()) replace(resultArea, notice(errorText(error), 'error')); }
      finally { clearing = false; name.input.disabled = false; if (panelAlive()) updateName(); }
    } }, '确认清除人格文本资料');
    function updateName() { submit.disabled = clearing || name.input.value !== preview.requiresName; note.textContent = name.input.value === preview.requiresName ? '名称已匹配。点击下方按钮才会提交清除。' : '名称尚未匹配，不会执行清除。'; }
    name.input.addEventListener('input', updateName);
    replace($('detail-content'), notice('清除会删除下列已登记的人格文本资料，完成后旧实例不能再次加载；如果只是暂时不用，建议先归档保留。', 'warning'),
      kv({ '人格名称': preview.name, '记忆目录': preview.memoryRoot, '实际文件数': typeof preview.files === 'number' ? number(preview.files) : Array.isArray(preview.files) ? number(preview.files.length) : '以预览范围为准', '实际大小': typeof preview.bytes === 'number' ? number(preview.bytes) + ' bytes' : '以预览范围为准' }),
      element('section', { class: 'reading-section' }, element('h3', {}, '本次实际清除范围'), element('ul', {}, preview.scope.map(text => element('li', {}, text)))),
      Array.isArray(preview.excluded) && preview.excluded.length ? element('section', { class: 'reading-section' }, element('h3', {}, '本次不会清除'), element('ul', {}, preview.excluded.map(text => element('li', {}, text)))) : null,
      notice('DSH旧会话日志、其它实例、共享平台账号不在清除范围。目录外作品、独立任务原件和外部备份也保留；未知文件会阻止清除并保留。归档、切换或取消此页都不会删除资料。'), name.wrapper, note, resultArea);
    replace($('detail-footer'), item.archivedAt == null && item.clearStatus !== 'partial' ? button('先归档保留', () => archive(item, panelAlive), 'secondary') : null,
      button('取消，保留资料', () => { state.detailGeneration++; $('detail-dialog').close(); }, 'secondary'), submit);
  }
  function record(item) {
    const cleared = item.clearedAt != null || item.clearStatus === 'cleared', partial = item.clearStatus === 'partial' || item.clearStatus === 'clearing', archived = item.archivedAt != null;
    const actions = cleared ? element('div', {}, element('p', { class: 'subtle-note' }, '人格文本资料已清除，旧实例不能再次加载或恢复。需要继续相处时，可以新建人格，后台会使用新的独立目录。'), button('新建人格', () => openSection('new-persona'), 'primary compact')) : partial ? element('div', {}, notice('上次清除尚未完成，旧实例保持不可加载。请重新预览实际剩余范围，再决定是否继续。', 'warning'), button('重新预览并继续清除', () => clearPreview(item), 'danger compact')) : element('div', { class: 'row-actions' },
      archived ? button('恢复并使用', () => change(item, 'instances.restore', { title: '恢复并使用这个人格', description: '恢复这份保留的资料并加载使用，当前其他人格会停止使用。旧会话日志仍保留；请为恢复后的人格新开会话。', accept: '恢复并使用', activate: true }), 'primary compact') : [
        button(item.loaded ? '停用实例' : '加载实例', () => change(item, item.loaded ? 'instances.unload' : 'instances.load', { title: item.loaded ? '停用这个人格实例' : '加载这个人格实例', description: item.loaded ? '停止接收、调度和写入，保留原资料。进行中的对话或整理会阻止切换。' : '加载所选目录的资料，并停用当前其他活动实例；不迁移、合并或清除旧资料。', activate: !item.loaded }), item.loaded ? 'secondary compact' : 'primary compact'),
        !item.active ? button('切换到此实例', () => change(item, 'instances.select', { title: '切换人格实例', description: '停止当前实例并加载所选人格，作为后续新会话使用的实例。资料分别保留，不迁移、合并或删除；忙碌时由后端拒绝切换。', activate: true }), 'secondary compact') : null,
        button('归档保留', () => archive(item), 'secondary compact')],
      button('清除文本资料…', () => clearPreview(item), 'danger compact'));
    return element('article', { class: `record instance-card${item.id === state.instanceId ? ' active' : ''}`, dataset: { instanceId: item.id } },
      element('div', { class: 'record-header' }, element('h3', { class: 'record-title' }, item.name ?? item.id), cleared ? tag('已清除') : partial ? tag('清除未完成') : archived ? tag('已归档') : pill(item.loaded ? 'running' : 'paused')),
      element('div', { class: 'record-meta' }, item.active && !cleared && !partial && !archived ? tag('新会话默认人格') : null, item.id === state.instanceId ? tag('正在查看') : null, item.retiredSessionCount ? tag('已关闭旧会话接入 ' + number(item.retiredSessionCount) + ' 个') : null),
      element('div', { class: 'instance-path' }, item.memoryRoot), archived ? element('p', { class: 'subtle-note' }, '归档保留资料，可恢复后新开会话继续使用。') : null, actions);
  }
  const items = instanceItems(instances), groups = [
    ['当前人格', items.filter(item => item.clearedAt == null && !item.clearStatus && item.archivedAt == null && (item.active || item.loaded))],
    ['其它人格', items.filter(item => item.clearedAt == null && !item.clearStatus && item.archivedAt == null && !item.active && !item.loaded)],
    ['已归档', items.filter(item => item.clearedAt == null && !item.clearStatus && item.archivedAt != null)],
    ['清除未完成', items.filter(item => item.clearedAt == null && ['partial', 'clearing'].includes(item.clearStatus))],
    ['已清除', items.filter(item => item.clearedAt != null || item.clearStatus === 'cleared')],
  ];
  const panel = element('div', {}, groups.filter(([, list]) => list.length).map(([title, list]) => element('section', { class: 'reading-section' }, element('h3', {}, title), element('div', { class: 'record-list' }, list.map(record)))),
    items.length ? null : empty('还没有登记的人格', '可以从一个新的独立目录开始。'));
  panel.refreshLifecycle = refresh; return panel;
}

async function settingsPage() {
  const instanceId = state.instanceId, generation = state.generation, alive = () => state.instanceId === instanceId && state.page === 'settings' && state.generation === generation;
  const container = element('div'), current = state.status.available ? await request('config.get') : null;
  if (!state.view) return element('div', {}, destinations(
    destination('人格管理', '切换、归档保留或明确清除人格，分别管理已有资料。', () => openSection('instances')),
    destination('交流与时间', '时区，以及整理机会的呈现方式。', () => openSection('general')),
    destination('整理资料助手', '可选的资料保真建议，由人格决定是否采纳。', () => openSection('assistant'), current ? current.reviewAssistant?.enabled ? '已开启' : '已关闭' : '加载后查看'),
    destination('容量与模型预算', '按需要调整资源上限，通常保持默认即可。', () => openSection('budgets')),
    destination('数据维护与诊断', '备份、恢复、校验以及运行诊断。', () => navigate('maintenance')),
    destination('使用说明', '查看日常操作、记忆方式与可选功能的说明。', () => openSection('user-guide'))));
  if (state.view === 'assistant') return current ? reviewAssistantSettings(current) : empty('先启用当前人格', '启用后即可保存这套人格的助手设置。');
  const instances = await request('instances.list', { instanceId: undefined }); state.instances = instanceItems(instances); updateInstanceBar();
  const instanceCards = instanceLifecyclePanel(instances, { alive });
  async function setupInstance(args, options, action = 'instances.load') {
    if (!alive()) return;
    const confirmation = await confirmOperation({ ...options, preview: args });
    if (!confirmation || !alive()) return;
    let result;
    try { result = await request(action, { instanceId: action === 'instances.create' ? undefined : instanceId, ...args }); }
    catch (error) { if (alive()) showError(error); return; }
    if (!alive()) return;
    toast('操作已返回，正在读取实际状态。');
    const refreshed = await instanceCards.refreshLifecycle(result?.activeInstanceId ?? result?.selectedInstanceId ?? args.instanceId, { useActualSelection: action === 'instances.create' });
    if (action === 'instances.create' && refreshed?.loaded && state.instanceId === refreshed.instanceId && state.page === 'settings' && state.view === 'new-persona') await navigate('persona', 'self-profile');
  }
  const newName = field('instance-new-name', '显示名称', '', { placeholder: '例如 日常相续' }), newRoot = field('instance-new-root', '记忆目录绝对路径', '', { placeholder: 'C:\\Users\\...\\persona-new', hint: '使用独立目录。更换实例不等于移动、合并或覆盖旧数据；实例编号由服务生成。' });
  const autoLoad = element('input', { type: 'checkbox', id: 'instance-auto-load', checked: Boolean(instances.autoLoad) });
  if (['instances', 'startup', 'new-instance', 'new-persona'].includes(state.view)) {
    if (state.view === 'instances') container.append(card('已保存的人格', '切换只改变使用对象；归档保留资料；清除需要先核对实际范围并输入名称。', instanceCards), destinations(
      destination('新建人格', '只需填写名称，自动使用新的独立资料目录。', () => openSection('new-persona')),
      destination('启动时加载', '设置下次启动是否自动启用已选人格。', () => openSection('startup')),
      destination('使用其他记忆库', '高级：手工选择已有或新的绝对目录。', () => openSection('new-instance'))));
    if (state.view === 'new-persona') { const name = field('persona-new-name', '人格名称', '', { placeholder: '例如 日常相续', hint: '只填写名称即可。资料使用新的独立目录，不复制或合并旧人格。' }); container.append(card('新建人格', '创建后可以一起确定初始资料，也可以直接开始聊天。', name.wrapper, button('创建并使用', async () => { if (!alive()) return; const value = name.input.value.trim(); if (!value) throw new Error('请填写人格名称。'); await setupInstance({ name: value, autoLoad: true }, { title: '创建并使用新的人格', description: '为这个名字建立独立资料目录并加载。当前人格停止使用但保留资料，不从旧人格或旧会话复制经历。' }, 'instances.create'); }, 'primary'))); }
    if (state.view === 'startup') container.append(card('启动时加载', '保存时会重新加载已选人格，并记住下次启动的选择；不会删除或合并记忆。', element('label', { class: 'field-checkbox' }, autoLoad, '下次启动 DSH 时自动启用已选人格'), button('保存并加载', async () => { if (!alive()) return; const target = instances.selectedInstanceId ?? instances.activeInstanceId, item = state.instances.find(value => value.id === target); if (!target) throw new Error('请先登记并选择实例。'); if (item?.archivedAt != null || item?.clearedAt != null || item?.clearStatus) throw new Error('请先在“人格管理”选择可用的人格；归档、已清除或清除未完成的实例不能直接加载。'); await setupInstance({ instanceId: target, autoLoad: autoLoad.checked }, { title: '应用启动加载方式', description: '本次会重新加载已选实例，并保存下次启动是否自动加载的选择。关闭自动加载不会删除数据，当前这次仍会加载。' }); }, 'secondary')));
    if (state.view === 'new-instance') container.append(card('使用其他记忆库', '选择独立目录。已有数据会加载；空目录会初始化新的人格，不合并旧记忆；已清除的旧目录不能重用。', newName.wrapper, newRoot.wrapper, button('登记并加载', async () => { if (!alive()) return; if (!newRoot.input.value.trim()) throw new Error('请填写绝对记忆目录。'); await setupInstance({ name: newName.input.value.trim() || '相续人格', memoryRoot: newRoot.input.value.trim() }, { title: '登记并加载实例', description: '打开所选目录的记忆，或在不存在数据的独立目录初始化新实例；当前其他实例会停用。不复制测试经历，也不自动合并已有记忆。' }); }, 'primary')));
    return container;
  }
  if (!current) { container.append(notice('当前查看的实例未加载，加载后可修改其技术配置。', 'warning')); return container; }
  const form = element('div', { role: 'form', 'aria-label': '技术设置' }), inputs = new Map(), timezone = field('settings-timezone', '现实时间的时区', current.timezone, { required: true, placeholder: 'Asia/Shanghai', hint: '例如 Asia/Shanghai（中国标准时间），或 UTC。' }), mode = field('settings-mode', '什么时候提供整理机会', current.consolidationMode, { choices: [['sleep', '休息时为主，也可清醒整理'], ['on_write', '有新资料时提供机会']] });
  form.append(element('p', { class: 'subtle-note' }, '这里只设置时间与整理机会。什么时候真正整理、记住什么、是否改变，由相续自己决定。'), element('div', { class: 'form-grid' }, timezone.wrapper, mode.wrapper), element('p', { class: 'subtle-note' }, '提供机会不等于立即整理，也不会因为新增一条资料就自动付费调用。'));
  if (state.budgetDraft?.instanceId !== state.instanceId) state.budgetDraft = { instanceId: state.instanceId, values: {} };
  const budgetDraft = state.budgetDraft.values;
  const captureBudgetDraft = () => { for (const [path, input] of inputs) { if (input.value !== String(getPath(current, path))) budgetDraft[path] = input.value; else delete budgetDraft[path]; } };
  const groupChoice = field('settings-budget-group', '要调整哪一类', state.configGroup, { choices: configGroups.map(([title], index) => [String(index), title]) });
  groupChoice.input.addEventListener('change', async () => { if (!alive()) return; captureBudgetDraft(); state.configGroup = groupChoice.input.value; await renderPage(); });
  if (state.view === 'budgets') { replace(form, groupChoice.wrapper, element('p', { class: 'subtle-note' }, '只显示所选类别。切换类别会保留未保存值；保存提交所有已改动类别，不自动裁剪记忆。')); }
  for (const [index, [title, definitions]] of configGroups.entries()) {
    if (state.view !== 'budgets' || String(index) !== state.configGroup) continue;
    const group = element('fieldset', { class: 'form-section' }, element('legend', {}, title)), grid = element('div', { class: 'form-grid wide' });
    for (const [path, label, hint] of definitions) { const input = field('config-' + path.replaceAll('.', '-'), label, budgetDraft[path] ?? getPath(current, path), { type: 'number', min: /^(capacityLimits|processingLimits)\./.test(path) ? 1 : 0, hint }); inputs.set(path, input.input); grid.append(input.wrapper); }
    group.append(grid); form.append(group);
  }
  async function saveSettings() {
    if (!alive()) return;
    const partial = {};
    if (timezone.input.value.trim() !== current.timezone) partial.timezone = timezone.input.value.trim();
    if (mode.input.value !== current.consolidationMode) partial.consolidationMode = mode.input.value;
    if (state.view === 'budgets') { captureBudgetDraft(); for (const [path, raw] of Object.entries(budgetDraft)) { const value = Number(raw), min = /^(capacityLimits|processingLimits)\./.test(path) ? 1 : 0; if (!raw.trim() || !Number.isSafeInteger(value) || value < min) throw new Error('请修正未保存的容量值：' + path); if (value !== getPath(current, path)) setPath(partial, path, value); } }
    for (const [path, input] of inputs) { const value = Number(input.value); if (!input.value.trim() || !Number.isSafeInteger(value) || value < Number(input.min)) throw new Error('请输入有效整数：' + path); if (value !== getPath(current, path)) setPath(partial, path, value); }
    if (!Object.keys(partial).length) { toast('没有配置变更。'); return; }
    await request('config.update', { instanceId, config: partial });
    if (!alive()) return;
    if (state.view === 'budgets') state.budgetDraft = null;
    toast('设置已保存。'); await renderPage();
  }
  form.append(element('div', { class: 'form-footer' }, element('p', {}, '设置作用于当前选定实例。请求预算估算不等于供应商精确 token 计费。'), button('保存设置', saveSettings, 'primary', { dataset: { action: 'save-settings' } })));
  container.append(form); return container;
}

function reviewAssistantSettings(config) {
  const instanceId = state.instanceId, generation = state.generation, current = { enabled: false, maxOutputTokens: 1024, maxReportChars: 4000, ...config.reviewAssistant };
  const alive = () => state.instanceId === instanceId && state.page === 'settings' && state.generation === generation;
  const enabled = element('input', { type: 'checkbox', checked: current.enabled === true, role: 'switch', id: 'review-assistant-enabled', 'aria-label': '启用整理资料助手' });
  const output = field('review-assistant-output', '助手输出上限', current.maxOutputTokens, { type: 'number', min: 1, hint: 'tokens；沿用 DSH 当前模型。' }); output.input.max = 8192;
  const report = field('review-assistant-report', '单份建议保留上限', current.maxReportChars, { type: 'number', min: 1, hint: 'Unicode 字符；建议不等于人格决定。' }); report.input.max = 16000;
  const save = button('保存整理助手设置', async () => {
    if (!alive()) return;
    const values = { enabled: enabled.checked, maxOutputTokens: Number(output.input.value), maxReportChars: Number(report.input.value) };
    if (!output.input.value || !Number.isSafeInteger(values.maxOutputTokens) || values.maxOutputTokens < 1 || values.maxOutputTokens > 8192 || !report.input.value || !Number.isSafeInteger(values.maxReportChars) || values.maxReportChars < 1 || values.maxReportChars > 16000) throw new Error('请输入有效的助手输出与建议容量。');
    const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== current[key]));
    if (!Object.keys(changed).length) return toast('整理助手设置没有变化。');
    if (!alive()) return;
    await request('config.update', { instanceId, config: { reviewAssistant: changed } });
    if (!alive()) return; toast('整理资料助手设置已保存。'); await renderPage();
  }, 'secondary');
  return card('整理资料助手', '可选的资料辅助，默认关闭；不会替人格规定应该变成什么样。',
    element('label', { class: 'field-checkbox' }, enabled, '启用整理资料助手'),
    element('p', { class: 'small muted' }, '沿用 DSH 当前模型，运行时可能增加模型调用。助手只提示来源、遗漏、重复或摘要失真，建议不直接写成人格变化；是否整理、怎样解释和是否采纳仍由人格决定。浏览本页不会调用助手。'),
    element('details', { class: 'advanced-section' }, element('summary', {}, '高级：助手处理预算'), element('div', { class: 'advanced-body form-grid' }, output.wrapper, report.wrapper)), save);
}

const pageCleanups = new Set();
function pageLifetime(generation = state.generation) {
  let disposed = generation !== state.generation;
  const timers = new Set(), cleanup = () => { disposed = true; for (const timer of timers) clearTimeout(timer); timers.clear(); pageCleanups.delete(cleanup); };
  if (!disposed) pageCleanups.add(cleanup);
  return { alive: () => !disposed && generation === state.generation,
    later: (fn, delay = 2500) => { if (disposed || generation !== state.generation) return; for (const existing of timers) clearTimeout(existing); timers.clear(); const timer = setTimeout(() => { timers.delete(timer); if (!disposed && generation === state.generation) fn(); }, Math.max(1000, Math.min(30000, delay))); timers.add(timer); }, stop: cleanup };
}
function operationId(prefix) { const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); return prefix + '_' + Array.from(bytes, value => value.toString(16).padStart(2, '0')).join(''); }
async function copyText(text, message = '内容已复制。') {
  try { await navigator.clipboard.writeText(text); toast(message); }
  catch { const input = element('textarea', { value: text, class: 'copy-content', readOnly: true }); const generation = startDetail('复制内容'); replace($('detail-content'), element('p', { class: 'small muted' }, '当前环境不能自动复制，请选中下方内容手动复制。'), input); input.focus(); input.select(); replace($('detail-footer'), button('关闭', () => $('detail-dialog').close())); }
}
function safeImageData(value) { return typeof value === 'string' && /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(value); }
const capabilityNames = { 'chat.text': '发送文字', 'chat.image': '发送图片', 'chat.video': '发送视频', 'chat.file': '发送文件', 'chat.voice': '发送语音消息', 'chat.sticker': '使用表情与表情包', 'message.reply': '引用消息', 'message.retract': '撤回自己的消息', 'contacts.read': '读取联系人', 'groups.read': '读取群列表', 'friend.manage': '处理好友请求', 'group.manage': '群管理', 'profile.update': '修改账号资料', 'feed.read': '查看动态／朋友圈', 'feed.publish': '发布动态／朋友圈', 'feed.react': '动态点赞与评论', 'call.voice': '实时语音通话', 'call.video': '实时视频通话' };
async function permissionsPanel(id) {
  const instanceId = state.instanceId, generation = state.generation, alive = () => state.instanceId === instanceId && state.page === 'chat' && state.generation === generation;
  const permissionRequest = (action, args = {}) => request(action, { ...args, instanceId });
  const content = element('div');
  try {
    const result = await permissionRequest('permissions.inspect', { id });
    if (!Array.isArray(result.items)) throw new Error('渠道未返回可核对的能力目录。');
    const inputs = new Map(), rows = result.items.map(item => {
      const name = item.label ?? capabilityNames[item.id] ?? item.id;
      const allowed = element('input', { type: 'checkbox', checked: item.allowed === true, disabled: !item.supported && !item.allowed, 'aria-label': '允许' + name, onchange: event => { if (!item.supported && event.currentTarget.checked) event.currentTarget.checked = false; } }); inputs.set(item.id, allowed);
      return element('tr', {}, element('th', { scope: 'row' }, name), element('td', { 'data-label': '平台支持' }, item.supported ? '支持' : '未支持'), element('td', { 'data-label': '用户许可' }, allowed), element('td', { 'data-label': '当前可用' }, element('span', {}, item.available ? '可用' : '不可用'), !item.available && item.reason ? element('small', {}, item.reason) : null));
    });
    content.append(element('p', { class: 'small muted' }, '权限只决定已接入工具能做什么；是否使用、关注谁和怎样交流仍由相续自己选择。平台不支持的能力不会因为勾选而生效。'),
      element('div', { class: 'permission-scroll' }, element('table', { class: 'permission-table' }, element('thead', {}, element('tr', {}, ['能力', '平台支持', '用户许可', '当前可用'].map(text => element('th', { scope: 'col' }, text)))), element('tbody', {}, rows))),
      button('保存这些权限', async () => {
        if (!alive()) return;
        const allowed = [...inputs].filter(([, input]) => input.checked).map(([key]) => key), added = allowed.filter(key => !result.items.some(item => item.id === key && item.allowed === true));
        if (added.length) { const confirmed = await confirmOperation({ title: '允许更多账号操作', description: '以下操作将获得你的许可。平台仍需实际支持；是否使用由相续自己决定。', preview: { 新增许可: added.map(key => capabilityNames[key] ?? key) }, accept: '允许并保存' }); if (!confirmed || !alive()) return; }
        await permissionRequest('permissions.configure', { id, allowed }); if (!alive()) return; toast('权限已保存。'); await renderPage();
      }, 'primary'));
    const saved = await permissionRequest('permissions.list', { id });
    if (Array.isArray(saved.items) && saved.items.length) content.append(element('details', { class: 'advanced-section' }, element('summary', {}, '已保存账号权限'), element('div', { class: 'advanced-body record-list' }, saved.items.map(item => element('div', { class: 'record' }, element('div', { class: 'record-header' }, element('h3', { class: 'record-title' }, item.accountId), tag((item.allowed ?? []).length + ' 项已保存许可')), element('p', { class: 'small muted' }, '上次设置 ' + date(item.updatedAt)), button('恢复该账号默认权限', async () => { const confirmation = await confirmOperation({ title: '恢复该账号默认权限', description: '移除该账号在当前人格中的授权选择，恢复渠道默认许可：文字，以及渠道中已开启的语音。不会删除聊天记忆或自动断开账号。', preview: { accountId: item.accountId }, accept: '恢复默认权限' }); if (!confirmation || !alive()) return; await permissionRequest('permissions.reset', { id, accountId: item.accountId }); toast('该账号权限已恢复默认。'); await renderPage(); }, 'secondary compact'))))));
  } catch (error) { content.append(notice(errorText(error), 'warning')); }
  return element('details', { class: 'advanced-section' }, element('summary', {}, '实际能力与权限'), element('div', { class: 'advanced-body' }, content));
}
async function connectionWizard(id, connection, initial, generation) {
  const life = pageLifetime(generation), area = element('div', { class: 'connection-wizard' });
  const platform = id === 'qq' ? 'QQ' : '微信'; let authorization = initial ?? { id, phase: 'idle' }, polling = false;
  const flowArea = element('div'), actions = element('div', { class: 'row-actions' });
  const selectCurrent = value => value?.connections?.find(item => item.id === id) ?? (value?.id === id ? value : null);
  async function useResult(value, refresh = false) { const next = selectCurrent(value); if (!next) throw new Error('未获得该平台的连接状态。'); authorization = next; if (life.alive()) { await paint(); if (refresh) await renderPage(); } }
  async function query() {
    if (polling || !life.alive() || !authorization.flowId) return;
    polling = true;
    try { const value = await request('connections.poll', { id, flowId: authorization.flowId }); if (life.alive()) await useResult(value, selectCurrent(value)?.phase === 'authorized'); }
    catch (error) { if (life.alive()) replace(flowArea, notice('状态查询未完成：' + errorText(error) + '。可以查询原连接，不必重新申请二维码。', 'warning'), button('查询原连接状态', query, 'secondary')); }
    finally { polling = false; }
  }
  async function start() { const result = await request('connections.start', { id }); if (life.alive()) await useResult(result); }
  async function paint() {
    replace(flowArea); replace(actions);
    const phase = authorization.phase ?? 'idle', waiting = ['waiting', 'scanned', 'verify'].includes(phase);
    if (waiting) {
      if (safeImageData(authorization.qrDataUrl)) flowArea.append(element('img', { class: 'connection-qr', src: authorization.qrDataUrl, alt: platform + '官方授权二维码' }));
      else if (authorization.qrContent) flowArea.append(notice('当前没有生成二维码图片。可复制真实授权链接，在手机上打开。', 'warning'));
      flowArea.append(element('div', {}, element('p', { class: 'small muted' }, phase === 'scanned' ? '已扫码，请在手机上完成平台授权。' : phase === 'verify' ? '平台要求验证，请由你本人完成。' : '请用手机' + platform + '扫描二维码并完成授权。'), authorization.expiresAt ? element('p', { class: 'small muted' }, '二维码有效期至 ' + date(authorization.expiresAt)) : null));
      if (authorization.qrContent) flowArea.append(button('复制授权链接', () => copyText(authorization.qrContent), 'subtle compact'));
      if (phase === 'verify') {
        const code = field('connection-' + id + '-verification', '平台验证码', '', { hint: '仅交给本次平台验证流程，不保存到人格记忆。' }); code.input.autocomplete = 'one-time-code'; code.input.maxLength = 128;
        flowArea.append(code.wrapper, button('提交验证码并查询', async () => { if (!code.input.value.trim()) throw new Error('请填写平台要求的验证码。'); const verifyCode = code.input.value.trim(); code.input.value = ''; await useResult(await request('connections.poll', { id, flowId: authorization.flowId, verifyCode }), true); }, 'secondary'));
      }
      actions.append(button('查询扫码状态', query, 'secondary'), button('取消本次连接', async () => { life.stop(); await request('connections.cancel', { id, flowId: authorization.flowId }); await renderPage(); }, 'subtle'));
      life.later(query, authorization.pollAfterMs ?? 2500);
    } else if (phase === 'authorized') {
      flowArea.append(element('p', { class: 'small muted' }, '已获得平台授权' + (authorization.accountId ? ' · ' + authorization.accountId : '') + '。接入范围由你选择，启用后才将来信交给相续。'));
      const chatTypes = Array.isArray(authorization.chatTypes) ? authorization.chatTypes : [];
      const privateAllowed = chatTypes.includes('private'), groupAllowed = chatTypes.includes('group');
      const privateInput = element('input', { type: 'checkbox', checked: connection.config?.mode === 'official' ? Boolean(connection.config?.allowedPrivateIds?.length) : privateAllowed, disabled: !privateAllowed });
      const groupInput = element('input', { type: 'checkbox', checked: connection.config?.mode === 'official' && Boolean(connection.config?.allowedGroupIds?.length), disabled: !groupAllowed });
      const voiceCapability = authorization.supportedCapabilities?.['chat.voice'], voiceSupported = voiceCapability === true || voiceCapability?.supported === true;
      const replyMode = field('official-' + id + '-reply-mode', '回复形式', connection.config?.mode === 'official' ? connection.config?.voiceMode ?? 'text' : 'text', { choices: voiceSupported ? [['text', '文字'], ['both', '文字与语音'], ['voice', '语音']] : [['text', '文字']], hint: voiceSupported ? '语音还需要本机声音可用，并在能力面板允许发送语音。' : '当前连接器未报告语音发送能力。' });
      flowArea.append(element('label', { class: 'field-checkbox' }, privateInput, authorization.pairedUserId ? '接入本次扫码账号的私聊' : '接入该 Bot 收到的全部私聊'), element('label', { class: 'field-checkbox' }, groupInput, groupAllowed ? '接入该 Bot 收到的全部群聊' : '群聊：当前官方连接器未提供'),
        element('p', { class: 'small muted' }, '平台账号本身还需具备相应消息权限。接入之后，是否回应、主动和休息仍由相续自己决定。'), replyMode.wrapper);
      actions.append(button(connection.enabled && connection.config?.mode === 'official' ? '保存范围并重新连接' : '完成连接并启用', async () => {
        if (!state.status.available) throw new Error('请先加载一个人格实例。');
        if (!privateInput.checked && !groupInput.checked) throw new Error('请选择至少一个要接入的范围。');
        if (connection.enabled) await request('channels.stop', { id });
        await request('channels.configure', { id, config: { mode: 'official', accountId: authorization.accountId, allowedPrivateIds: privateInput.checked ? [authorization.pairedUserId ?? '*'] : [], allowedGroupIds: groupInput.checked ? ['*'] : [], voiceMode: replyMode.input.value } });
        await request('channels.start', { id }); toast(platform + '接入已获得实际连接结果。'); await renderPage();
      }, 'primary')); if (connection.enabled) actions.append(button('暂停接入', async () => { await request('channels.stop', { id }); await renderPage(); }, 'secondary')); actions.append(button('断开官方账号', async () => { const confirmation = await confirmOperation({ title: '断开' + platform + '官方账号', description: '停止本插件的该账号连接并移除其本机授权。已经保存的人格记忆保持原样。', accept: '断开连接' }); if (!confirmation) return; if (connection.enabled) await request('channels.stop', { id }); await request('connections.disconnect', { id }); await renderPage(); }, 'subtle'));
    } else {
      if (['expired', 'cancelled', 'failed'].includes(phase)) flowArea.append(notice(phase === 'expired' ? '上次二维码已过期，请重新获取。' : phase === 'cancelled' ? '本次连接已取消。' : authorization.error?.message ?? '平台连接未完成，请重试或查看诊断。', phase === 'failed' ? 'error' : 'warning'));
      actions.append(button(phase === 'idle' ? '连接' + platform : '重新获取二维码', start, 'primary'));
    }
    if (authorization.error && phase !== 'failed') flowArea.append(notice(authorization.error.message ?? authorization.error.code ?? '平台返回了连接错误。', 'warning'));
  }
  area.append(element('p', { class: 'small muted' }, id === 'qq' ? '扫码绑定独立 QQ Bot 身份，后续配置由插件保存。它不会接管桌面已登录的个人 QQ。' : '使用微信官方扫码授权，目前接入私聊；普通群聊、朋友圈和实时通话以实际连接器能力为准。'), ...(authorization.deliveryPolicy?.reason ? [notice('QQ 官方接口：' + authorization.deliveryPolicy.reason + '。高级兼容桥按其实际能力执行。')] : []), flowArea, actions);
  await paint(); return area;
}

async function socialIdentitiesPanel({ generation = state.generation, connections = [] } = {}) {
  const instanceId = state.instanceId, listing = element('div'), formArea = element('details', { class: 'advanced-section' });
  const alive = () => state.instanceId === instanceId && state.page === 'chat' && state.generation === generation;
  const socialRequest = (action, args = {}) => request(action, { ...args, instanceId });
  const labelsByPlatform = { qq: 'QQ', wechat: '微信', bilibili: 'B站', douyin: '抖音' };
  let platforms = [], currentOffset = 0, loadGeneration = 0;
  const platform = field('social-platform', '平台', 'qq', { choices: [['qq', 'QQ'], ['wechat', '微信'], ['bilibili', 'B站'], ['douyin', '抖音'], ['other', '其他平台']] });
  const custom = field('social-custom-platform', '其他平台标识', '', { placeholder: '例如 telegram；小写字母、数字、下划线或连字符' });
  const account = field('social-account-id', '平台账号 ID', '', { required: true, hint: '使用平台稳定账号标识，不填写密码、Token 或 Cookie。QQ／微信可优先从当前连接登记。' });
  const name = field('social-display-name', '显示名称', ''), type = field('social-account-type', '账号类型', 'other', { choices: [['bot', '机器人'], ['personal', '个人账号'], ['creator', '创作者账号'], ['other', '其他']] });
  const profile = field('social-profile-url', '主页链接（可选）', '', { placeholder: 'https://…；不要包含登录凭据或查询参数' });
  const avatar = field('social-avatar-url', '头像链接（可选）', ''), notes = field('social-notes', '备注（可选）', '');
  account.input.maxLength = 256; name.input.maxLength = 120; notes.input.maxLength = 1000;
  const updatePlatform = () => { custom.wrapper.hidden = platform.input.value !== 'other'; if (platform.input.value === 'qq') type.input.value = 'bot'; else if (platform.input.value === 'wechat') type.input.value = 'personal'; else if (['bilibili', 'douyin'].includes(platform.input.value)) type.input.value = 'creator'; };
  platform.input.addEventListener('change', updatePlatform); updatePlatform();
  const edit = item => {
    platform.input.value = Object.hasOwn(labelsByPlatform, item.platform) ? item.platform : 'other'; custom.input.value = platform.input.value === 'other' ? item.platform : ''; updatePlatform();
    account.input.value = item.accountId; name.input.value = item.displayName ?? ''; type.input.value = ['bot', 'personal', 'creator', 'other'].includes(item.accountType) ? item.accountType : 'other'; profile.input.value = item.profileUrl ?? ''; avatar.input.value = item.avatarUrl ?? ''; notes.input.value = item.notes ?? ''; formArea.open = true; account.input.focus();
  };
  function render(view) {
    platforms = Array.isArray(view.platforms) ? view.platforms : platforms;
    const items = getItems(view);
    const rows = items.map(item => {
      const connection = item.connection ?? {}, verified = connection.connected === true && connection.currentAccount === true && connection.verification === 'verified';
      const status = !connection.adapterAvailable ? '仅登记／尚无适配器' : verified ? '当前连接已核验' : connection.status === 'account_changed' ? '登记账号与当前连接不同' : '仅登记／尚未核实连接';
      const supported = Array.isArray(item.capabilities) ? item.capabilities : [];
      return element('article', { class: 'record' }, element('div', { class: 'record-header' }, element('h3', { class: 'record-title' }, item.displayName || item.accountId), tag(status, verified ? '' : 'warning')),
        kv({ '平台': labelsByPlatform[item.platform] ?? platforms.find(value => value.id === item.platform)?.label ?? item.platform, '账号 ID': item.accountId, '账号类型': ({ bot: '机器人', personal: '个人账号', creator: '创作者账号', other: '其他' })[item.accountType] ?? item.accountType, '登记来源': item.bindingSource === 'current_connection' ? '实际连接核对后登记' : '手动登记', '当前已核实可用能力': supported.filter(value => value.available === true).length + ' 项' }),
        item.profileUrl ? element('p', { class: 'small muted' }, '主页：' + item.profileUrl) : null, item.notes ? element('p', { class: 'small muted' }, item.notes) : null,
        connection.deliveryPolicy?.reason ? notice(connection.deliveryPolicy.reason) : null,
        supported.length ? element('details', { class: 'advanced-section' }, element('summary', {}, '查看此账号的实际能力'), element('div', { class: 'advanced-body' }, supported.map(value => element('div', { class: 'record' }, element('strong', {}, capabilityNames[value.id] ?? value.id), kv({ '适配器支持': value.supported ? '支持' : '未支持', '用户许可': value.allowed === true ? '已许可' : value.allowed === false ? '未许可' : '尚未核实', '当前可用': value.available === true ? '可用' : '不可用' }), value.reason ? element('p', { class: 'small muted' }, value.reason) : null)))) : element('p', { class: 'small muted' }, '当前没有已核实的执行能力。登记本身不会授予能力。'),
        element('div', { class: 'row-actions' }, button('修改账号档案', () => { if (alive()) edit(item); }, 'secondary compact'), button('解除这条身份登记', async () => {
          if (!alive()) return; const confirmed = await confirmOperation({ title: '解除社交身份登记', description: '只移除当前人格中的这条账号档案；不会退出平台账号、修改平台权限或删除聊天记忆。', preview: { platform: item.platform, accountId: item.accountId }, accept: '解除登记' });
          if (!confirmed || !alive()) return; await socialRequest('social.remove', { identityId: item.identityId }); if (!alive()) return; toast('身份登记已解除。'); await load();
        }, 'secondary compact')));
    });
    replace(listing, kv({ '当前人格的身份档案': number(view.total ?? items.length) + ' / ' + number(view.limits?.perInstance), '账号档案总容量': view.limits?.registryBytes != null ? number(view.limits.registryBytes) + ' bytes' : '由服务返回' }),
      rows.length ? element('div', { class: 'record-list' }, rows) : empty('尚未登记独立社交身份', '可从当前已连接的 QQ／微信登记，或先保存其他平台账号档案；未接入适配器时只表示登记。'),
      element('div', { class: 'row-actions' }, currentOffset > 0 ? button('回到账号首页', () => load(), 'secondary compact') : null, view.nextOffset != null ? button('下一页账号', () => load('social.list', view.nextOffset), 'secondary compact') : null));
  }
  async function load(action = 'social.inspect', offset = 0) {
    const ticket = ++loadGeneration, view = await socialRequest(action, offset ? { offset } : {}); if (!alive() || ticket !== loadGeneration) return; currentOffset = offset; render(view);
  }
  const register = button('保存账号档案', async () => {
    if (!alive()) return;
    const input = { platform: platform.input.value === 'other' ? custom.input.value.trim() : platform.input.value, accountId: account.input.value.trim(), displayName: name.input.value.trim(), accountType: type.input.value, profileUrl: profile.input.value.trim() || null, avatarUrl: avatar.input.value.trim() || null, notes: notes.input.value.trim() };
    if (!input.accountId) throw new Error('请填写平台账号 ID。'); if (!/^[a-z][a-z0-9_-]{0,47}$/.test(input.platform)) throw new Error('请填写有效的平台标识。');
    if (!alive()) return; await socialRequest('social.upsert', input); if (!alive()) return; formArea.open = false; toast('账号档案已保存，实际能力以连接核实为准。'); await load();
  }, 'secondary', { disabled: !state.status?.available });
  formArea.append(element('summary', {}, '登记或修改独立账号'), element('div', { class: 'advanced-body' }, element('div', { class: 'form-grid' }, platform.wrapper, custom.wrapper, account.wrapper, name.wrapper),
    element('p', { class: 'small muted' }, '账号由你在相应平台注册并完成所需认证。B站、抖音或其他平台没有适配器时，只保存身份参考，不会显示为已连接。'),
    element('details', { class: 'advanced-section' }, element('summary', {}, '可选账号资料'), element('div', { class: 'advanced-body form-grid' }, type.wrapper, profile.wrapper, avatar.wrapper, notes.wrapper)), register));
  const link = platform => button('从当前' + labelsByPlatform[platform] + '连接登记', async () => {
    if (!alive()) return; const confirmed = await confirmOperation({ title: '登记当前' + labelsByPlatform[platform] + '身份', description: '从当前实际连接核对账号 ID 后，登记到当前人格。账号权限沿用现有授权，不因此扩大。', preview: { platform }, accept: '核对并登记' });
    if (!confirmed || !alive()) return; await socialRequest('social.linkCurrent', { platform }); if (!alive()) return; toast('已取得实际账号登记结果。'); await load();
  }, 'secondary', { disabled: !state.status?.available || !connections.some(item => item.id === platform && item.connected) });
  const content = card('账号与社交身份', '让同一个人格关联自己的平台账号；身份登记、连接和能力分别显示。',
    element('p', {}, 'QQ／微信请返回“连接”，选择对应平台完成接入。多个档案不代表同一平台能同时连接多个账号；目前每个平台只有一个活动连接。'),
    element('div', { class: 'row-actions' }, link('qq'), link('wechat'), button('刷新账号实际状态', () => load('social.refresh', currentOffset), 'secondary', { disabled: !state.status?.available })), listing, formArea);
  if (!state.status?.available) { listing.append(notice('先加载人格实例，再查看或登记其社交身份。')); return content; }
  try { await load(); } catch (error) { if (alive()) listing.append(notice(errorText(error), 'warning')); }
  return content;
}

async function chatPage() {
  const generation = state.generation;
  const [channels, official] = await Promise.all([request('channels.status'), request('connections.status')]);
  const container = element('div');
  const connections = Array.isArray(channels.connections) ? channels.connections : [];
  const platformName = value => ({ qq: 'QQ', wechat: '微信' })[value] ?? value;
  const statusName = value => ({ connected: '已连接', ready: '已就绪', connecting: '正在连接', disconnected: '尚未连接', disabled: '已停用', unconfigured: '尚未配置', unavailable: '暂不可用', error: '连接异常' })[value] ?? value;
  if (!state.view) return destinations(
    ...['qq', 'wechat'].map(id => { const item = connections.find(value => value.id === id), authorized = official.connections?.find(value => value.id === id); return destination(id === 'qq' ? 'QQ' : '微信', id === 'qq' ? '扫码连接独立 QQ Bot；个人账号可使用已有兼容桥。' : '官方扫码接入私聊；群聊需已有兼容桥支持。', () => openSection(item?.config?.mode === 'bridge' && item.configured ? id + '-bridge' : id), item?.connected ? '已连接' : authorized?.connected ? '已授权，待启用' : '未连接'); }),
    destination('声音', '选择音色、试听，以及由谁决定声音。', () => openSection('voice')),
    destination('社交身份', '登记人格的平台账号，核对连接与可用能力。', () => openSection('accounts')));
  if (state.view === 'accounts') return socialIdentitiesPanel({ generation, connections });
  if (['qq', 'wechat', 'qq-permissions', 'wechat-permissions'].includes(state.view)) {
    const id = state.view.split('-')[0], connection = connections.find(value => value.id === id) ?? { id, enabled: false, connected: false, config: {} };
    if (state.view.endsWith('-permissions')) { const panel = await permissionsPanel(id); panel.open = true; panel.disclosureButton.hidden = true; return panel; }
    return element('div', {}, element('ol', { class: 'flow-steps' }, ['扫码授权', '选择私聊或群聊范围', '启用连接'].map(title => element('li', {}, title))),
      await connectionWizard(id, connection, official.connections?.find(value => value.id === id), generation),
      destinations(destination('能力与权限', '查看平台支持什么、当前账号允许什么。', () => openSection(id + '-permissions')),
        destination('使用已有兼容桥', '已经部署 NapCat 或兼容桥时，在这里填写接入配置。', () => openSection(id + '-bridge'))));
  }
  if (state.view !== 'voice') {
  const parseIds = input => [...new Set(input.value.split(/[\s,，;；]+/u).map(value => value.trim()).filter(Boolean))];
  async function copyField(input, message) {
    try { await navigator.clipboard.writeText(input.value); toast(message); }
    catch { input.select(); toast('请复制已选中的内容。'); }
  }
  for (const id of [state.view.split('-')[0]]) {
    const connection = connections.find(value => value.id === id) ?? { id, configured: false, enabled: false, connected: false, status: 'unavailable', capabilities: {}, config: {} };
    const config = connection.config ?? {}, title = platformName(id), isWechat = id === 'wechat';
    const apiUrl = field('channel-' + id + '-url', '本地桥 API 地址', config.apiUrl ?? '', { placeholder: 'http://127.0.0.1:3000', hint: '填写已运行的本地桥地址；保存不会替你登录账号。' });
    const account = field('channel-' + id + '-account', '接入账号标识', config.accountId ?? '', { placeholder: isWechat ? '本地桥提供的账号标识' : 'QQ 账号 ID' });
    const accessToken = field('channel-' + id + '-token', 'API 访问令牌', '', { type: 'password', hint: connection.hasAccessToken ? '已保存令牌。留空保留，不回显原值。' : '本地桥需要令牌时填写；不需要可留空。' });
    accessToken.input.autocomplete = 'new-password';
    const clearAccessToken = element('input', { type: 'checkbox' });
    const privateIds = field('channel-' + id + '-private', '接入的私聊对象', (config.allowedPrivateIds ?? []).join('\n'), { multiline: true, placeholder: '每行一个对象 ID', hint: '空白表示暂不接入私聊；明确填 * 可接入该账号的全部私聊。' });
    const groupIds = field('channel-' + id + '-groups', '接入的群聊', (config.allowedGroupIds ?? []).join('\n'), { multiline: true, placeholder: '每行一个群 ID', hint: '空白表示暂不接入群聊；明确填 * 可接入该账号的全部群。' });
    const voiceMode = field('channel-' + id + '-voice', '回复形式', config.voiceMode ?? 'text', { choices: [['text', '文字'], ['both', '文字与语音'], ['voice', '语音']] });
    const save = button('保存接入设置', async () => {
      if (accessToken.input.value && clearAccessToken.checked) throw new Error('请只选择填写新令牌，或清除已保存的令牌。');
      const patch = { mode: 'bridge', apiUrl: apiUrl.input.value.trim(), accountId: account.input.value.trim(), allowedPrivateIds: parseIds(privateIds.input), allowedGroupIds: parseIds(groupIds.input), voiceMode: voiceMode.input.value };
      if (accessToken.input.value) patch.accessToken = accessToken.input.value;
      if (clearAccessToken.checked) patch.clearAccessToken = true;
      await request('channels.configure', { id, config: patch }); accessToken.input.value = ''; toast(title + '接入设置已保存。'); await renderPage();
    }, 'primary');
    save.disabled = connection.enabled === true;
    const controls = element('div', { class: 'row-actions' }, save,
      button(connection.enabled ? '停用接入' : '启用已保存配置', async () => { await request(connection.enabled ? 'channels.stop' : 'channels.start', { id }); await renderPage(); }, 'secondary', { disabled: !connection.configured && !connection.enabled }),
      button('检查连接', async () => { await request('channels.probe', { id }); await renderPage(); }, 'secondary', { disabled: !connection.configured }));
    const callback = field('channel-' + id + '-callback', '事件上报地址', connection.callbackUrl ?? '', { hint: '在本地桥的事件上报设置中使用；平台登录在本地桥完成。' });
    callback.input.readOnly = true;
    const ingressArea = element('div');
    const bridgeDetails = element('details', {}, element('summary', { class: 'small muted' }, '事件上报与鉴权'), element('div', { class: 'channel-details' }, callback.wrapper,
      element('div', { class: 'row-actions' }, button('复制上报地址', () => { if (!callback.input.value) throw new Error('当前没有可用的上报地址。'); return copyField(callback.input, '上报地址已复制。'); }, 'secondary compact'),
        button(connection.hasIngressToken ? '重新生成上报令牌' : '生成上报令牌', async () => {
          const result = await request('channels.rotateIngress', { id });
          if (typeof result.ingressToken !== 'string' || !result.ingressToken) throw new Error('未获得新的上报令牌。');
          if (typeof result.callbackUrl === 'string') callback.input.value = result.callbackUrl;
          const token = field('channel-' + id + '-ingress-once', '本次生成的上报令牌', result.ingressToken, { type: 'password', hint: '只在这里显示本次生成值。旧令牌已失效，请更新本地桥配置。' });
          token.input.readOnly = true; token.input.autocomplete = 'off';
          const show = element('input', { type: 'checkbox', onchange: event => { token.input.type = event.target.checked ? 'text' : 'password'; } });
          replace(ingressArea, token.wrapper, element('label', { class: 'field-checkbox' }, show, '显示本次令牌'), button('复制本次令牌', () => copyField(token.input, '本次上报令牌已复制。'), 'secondary compact'));
        }, 'secondary compact')), element('div', { class: 'channel-details' }, ingressArea)));
    const capabilities = connection.capabilities ?? {};
    const status = connection.status ?? (connection.connected ? 'connected' : connection.enabled ? 'disconnected' : 'disabled'), statusBadge = pill(status);
    statusBadge.textContent = statusName(status);
    if (!connection.connected && !connection.error) statusBadge.className = 'status-pill neutral';
    const capabilityTags = element('div', { class: 'row-actions channel-capabilities' },
      tag('私聊：' + (capabilities.private ? '支持' : '待桥提供')), tag('群聊：' + (capabilities.group ? '支持' : '待桥提供')), tag('文字：' + (capabilities.text ? '支持' : '待桥提供')), tag('语音：' + (capabilities.voice ? '支持' : '当前不可用')));
    const excluded = connection.recentExcluded ?? connection.excluded ?? [];
    const excludedInfo = Array.isArray(excluded) && excluded.length ? element('details', {}, element('summary', { class: 'small muted' }, '最近未接入的对象与群'), element('div', { class: 'record-list channel-details' }, excluded.slice(-10).map(value => element('div', { class: 'record' }, kv({ '对象 ID': value.senderId ?? value.userId ?? '—', '群 ID': value.roomId ?? value.groupId ?? '私聊', '时间': value.at ? date(value.at) : '未提供' }))))) : null;
    container.append(card(title, isWechat ? '私聊、群聊能力由实际接入的连接服务提供。' : '连接服务准备好后，可接入选定的私聊与群聊。',
      element('div', { class: 'row-actions channel-status' }, statusBadge, tag(config.mode === 'official' ? '官方连接' : '兼容桥')),
      destination('能力与权限', '核对这个账号实际支持且允许的操作。', () => openSection(id + '-permissions')),
      connection.error ? notice(connection.error.message ?? String(connection.error), 'error') : null,
      element('section', { class: 'setup-form' }, element('h3', {}, '兼容桥设置'), element('div', { class: 'advanced-body' },
      element('p', { class: 'small muted' }, isWechat ? '需要兼容 OneBot 12 的微信连接服务。协议本身不提供账号登录或普通微信群聊。' : '需要 NapCat 等兼容 OneBot 11 的 QQ 连接服务；在该服务中完成账号登录。'),
      connection.enabled ? notice('连接正在使用。修改前请先点“停用接入”，保存后再启用。') : null, capabilityTags, element('div', { class: 'form-grid' }, apiUrl.wrapper, account.wrapper), accessToken.wrapper,
      connection.hasAccessToken ? element('label', { class: 'field-checkbox' }, clearAccessToken, '明确清除已保存的 API 令牌') : null,
      element('div', { class: 'form-grid' }, privateIds.wrapper, groupIds.wrapper),
      element('p', { class: 'subtle-note' }, '这些列表只确定哪些对象和群接入人格；接入之后，是否回应、关注谁和怎样相处仍由人格自己判断。'),
      element('div', { class: 'channel-details' }, voiceMode.wrapper), controls, element('hr', { class: 'divider' }), bridgeDetails, excludedInfo))));
  }
    return container;
  }
  const voiceArea = element('div');
  try {
    const voice = await request('voice.inspect', { sessionKey: 'channel-voice' });
    const catalog = Array.isArray(voice.catalog) ? voice.catalog : voice.catalog?.voices ?? channels.voice?.catalog?.voices ?? [], current = voice.profile ?? voice;
    const supported = channels.voice?.supported ?? voice.supported ?? catalog.length > 0;
    const mode = field('channel-voice-mode', '由谁选择音色', current.mode ?? 'persona', { choices: [['persona', '让人格自己选择'], ['user', '由我来选择']] });
    const choice = field('channel-voice-choice', '本机音色', current.userSelection?.voiceId ?? '', { choices: [['', '本机默认音色'], ...catalog.map(value => [value.id, value.name + (value.lang ? ' · ' + value.lang : '')])] });
    const rate = field('channel-voice-rate', '语速', current.userSelection?.rate ?? 1, { type: 'number', min: 0.1 }), pitch = field('channel-voice-pitch', '音高', current.userSelection?.pitch ?? 1, { type: 'number', min: 0 });
    rate.input.max = 10; rate.input.step = 0.1; pitch.input.max = 2; pitch.input.step = 0.1;
    const pitchSupported = voice.providerCapabilities?.pitch !== false;
    if (!pitchSupported) { pitch.input.disabled = true; pitch.input.value = 1; pitch.wrapper.append(element('small', {}, '当前本机引擎使用原生音高。')); }
    const manual = element('div', { class: 'form-grid' }, choice.wrapper, rate.wrapper, pitch.wrapper);
    const updateMode = () => { manual.hidden = mode.input.value !== 'user'; }; mode.input.addEventListener('change', updateMode); updateMode();
    const selected = catalog.find(value => value.id === current.personaSelection?.voiceId), resultArea = element('div');
    const voiceActions = element('div', { class: 'row-actions' }, button('保存声音设置', async () => {
      const nextRate = Number(rate.input.value), nextPitch = Number(pitch.input.value);
      if (!rate.input.value || !Number.isFinite(nextRate) || nextRate < 0.1 || nextRate > 10 || !pitch.input.value || !Number.isFinite(nextPitch) || nextPitch < 0 || nextPitch > 2) throw new Error('请输入有效语速与音高。');
      await request('voice.configure', { sessionKey: 'channel-voice', mode: mode.input.value, userSelection: { voiceId: choice.input.value || null, rate: nextRate, pitch: nextPitch } }); toast('声音设置已保存。'); await renderPage();
    }, 'primary'), button('试听已保存的声音', async () => {
      const result = await request('voice.preview', { sessionKey: 'channel-voice', text: '你好，这是一段声音试听。' });
      if (result.status !== 'generated' || result.mime !== 'audio/wav' || typeof result.audioDataUrl !== 'string' || !/^data:audio\/wav;base64,[A-Za-z0-9+/=]+$/.test(result.audioDataUrl)) throw new Error(result.message ?? (result.status === 'unsupportedPitch' ? '当前本机音色不支持这个音高。请保存原生音高后试听。' : '本机暂未返回可播放的试听音频。' + (result.reason ? '（' + result.reason + '）' : '')));
      replace(resultArea, element('div', { class: 'voice-preview channel-details' }, element('p', {}, '试听已生成，点播放收听。'), element('audio', { controls: true, src: result.audioDataUrl, preload: 'none', 'aria-label': '本机音色试听' }), result.notice || result.pitchSupported === false ? element('p', { class: 'small muted' }, result.notice ?? '当前本机引擎不支持音高调整。') : null));
    }, 'secondary', { disabled: !supported || !catalog.length }));
    if (!supported || !catalog.length) voiceArea.append(notice('本机暂未发现可用的语音引擎或音色。文字聊天仍可使用。', 'warning'));
    voiceArea.append(mode.wrapper, element('p', { class: 'small muted' }, current.mode === 'persona' ? selected ? '人格当前选择：' + selected.name : '人格尚未指定音色，当前使用本机默认声音。' : '当前按你选定的声音播放；人格的自主偏好仍保留。'), manual, voiceActions, resultArea);
  } catch (error) { voiceArea.append(notice(errorText(error), 'warning')); }
  container.append(card('语音与音色', '使用本机语音合成，再由实际支持语音的聊天渠道交付。', voiceArea,
    element('p', { class: 'subtle-note' }, '文字与语音的实际发送能力以渠道桥返回为准。音色由人格自主选择或由你指定；试听不会写入聊天记忆。')));
  return container;
}


async function mediaPage() {
  const generation = state.generation, life = pageLifetime(generation), instanceId = state.instanceId;
  const mediaRequest = (action, args = {}) => request(action, { ...args, instanceId });
  const view = await mediaRequest('media.inspect', { includeConfiguration: true });
  const identity = view.identity ?? {}, limits = view.limits ?? {}, container = element('div');
  const providers = Array.isArray(view.providers) ? view.providers : [];
  if (!state.view) return element('div', {}, element('p', { class: 'page-note' }, identity.primaryAssetId ? '已保存主参考形象，创作时可沿用。' : '先留下形象描述或参考图，让后续作品有一致的形象。'),
    button(providers.some(item => item.enabled && item.configured && item.capabilities?.generate) ? '开始创作' : '连接图片服务', () => openSection(providers.some(item => item.enabled && item.configured && item.capabilities?.generate) ? 'create' : 'provider-image'), 'primary'),
    destinations(destination('形象档案', '外貌描述、参考图，以及谁可以修改。', () => openSection('identity')),
      destination('作品与任务', '查看已保存的作品和生成进度。', () => openSection('gallery')),
      ...['image', 'video'].map(kind => { const provider = providers.find(item => item.kind === kind); return destination(kind === 'image' ? '图片服务' : '视频服务', kind === 'image' ? '连接 Images API 或 ComfyUI。' : '连接已部署的 ComfyUI 视频工作流。', () => openSection('provider-' + kind), provider?.enabled && provider?.configured ? '已开启' : '未开启'); })));
  const assets = state.view === 'gallery' ? await mediaRequest('media.listAssets', { limit: 12 }) : { items: [] };
  const description = field('identity-description', '形象描述', identity.description ?? '', { multiline: true, hint: '用于保持角色身份的外貌描述；动作、衣服与场景可以在每次创作时变化。' });
  const locked = element('input', { type: 'checkbox', checked: identity.locked === true });
  const primary = element('div', { class: 'identity-primary' });
  if (identity.primaryAssetId && state.view === 'identity') {
    try { const asset = await mediaRequest('media.getAsset', { assetId: identity.primaryAssetId, preview: true }); primary.append(safeImageData(asset.dataUrl) ? element('img', { src: asset.dataUrl, alt: '当前形象主参考图', class: 'identity-reference' }) : notice('主参考图已保存。原图超过预览容量时，可下载原文件查看。'), element('p', { class: 'small muted' }, '主参考 · ' + (asset.name ?? asset.assetId ?? identity.primaryAssetId)), element('div', { class: 'row-actions' }, button('下载主参考原文件', () => request('ui.asset.download', { assetId: identity.primaryAssetId, instanceId }), 'secondary compact'), button('取消主参考选择，保留图片', async () => { await mediaRequest('media.updateIdentity', { primaryAssetId: null }); if (life.alive()) { toast('已取消主参考选择，图片仍保留在图库。'); await renderPage(); } }, 'subtle compact'))); }
    catch (error) { primary.append(notice(errorText(error), 'warning')); }
  } else primary.append(empty('尚未选择主参考图', '上传一张图，或在生成作品后将其设为主参考。后续创作会沿用所选形象参考。'));
  const upload = element('input', { id: 'identity-reference-file', type: 'file', accept: 'image/png,image/jpeg,image/webp' });
  const setAsPrimary = element('input', { type: 'checkbox', checked: true }), uploadProgress = element('p', { class: 'small muted', role: 'status' });
  async function uploadReference() {
    const file = upload.files?.[0]; if (!file) throw new Error('请先选择一张参考图。');
    const maxBytes = limits.imageBytes ?? 8388608;
    if (!file.size || file.size > maxBytes) throw new Error('参考图需为有效的 PNG/JPEG/WebP，最大 ' + number(maxBytes) + ' bytes。');
    let uploadId;
    try {
      const started = await mediaRequest('media.uploadBegin', { mime: file.type, name: file.name, totalBytes: file.size }); uploadId = started.uploadId;
      if (!uploadId) throw new Error('未获得上传编号。');
      for (let offset = 0, index = 0; offset < file.size; offset += 32768, index++) {
        if (!life.alive()) throw new Error('页面已切换，上传停止。');
        const bytes = new Uint8Array(await file.slice(offset, offset + 32768).arrayBuffer());
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
        await mediaRequest('media.uploadChunk', { uploadId, index, dataBase64: btoa(binary) }); uploadProgress.textContent = '已上传 ' + number(Math.min(offset + bytes.length, file.size)) + ' / ' + number(file.size) + ' bytes';
      }
      await mediaRequest('media.uploadFinish', { uploadId, setAsPrimary: setAsPrimary.checked }); uploadId = null; if (!life.alive()) return; toast('参考图已保存。'); await renderPage();
    } finally { if (uploadId) { try { await mediaRequest('media.uploadCancel', { uploadId }); } catch {} } }
  }
  if (state.view === 'identity') container.append(card('形象档案', '主参考图、描述和版本保存在当前人格实例；图库按需读取，不会每轮全量送入模型。',
    kv({ '当前版本': identity.version == null ? '尚未建立' : 'v' + identity.version, '主参考': identity.primaryAssetId ?? '未选择' }), primary, description.wrapper,
    element('label', { class: 'field-checkbox' }, locked, '锁定形象档案：人格工具不能修改主参考和形象描述（你仍可在这里修改）'),
    button('保存形象设置', async () => { if (Array.from(description.input.value).length > (limits.descriptionChars ?? 2048)) throw new Error('形象描述超过技术容量，请缩短后保存。'); await mediaRequest('media.updateIdentity', { description: description.input.value, locked: locked.checked }); toast('形象设置已保存。'); await renderPage(); }, 'primary'),
    element('section', { class: 'upload-section' }, element('h3', {}, '上传参考图片'), element('div', { class: 'advanced-body' }, element('label', { class: 'field' }, element('span', {}, 'PNG / JPEG / WebP 参考图'), upload), element('label', { class: 'field-checkbox' }, setAsPrimary, '保存后设为当前主参考'), button('上传并保存参考图', uploadReference, 'secondary'), uploadProgress))));
  if (state.view === 'identity') return container;
  for (const kind of ['image', 'video']) {
    if (state.view !== 'provider-' + kind) continue;
    const current = providers.find(item => item.kind === kind) ?? { kind, enabled: false, type: kind === 'image' ? 'openai-images' : 'comfyui', capabilities: {} }, name = kind === 'image' ? '图片' : '视频';
    const enabled = element('input', { type: 'checkbox', checked: current.enabled === true, disabled: current.configured !== true && current.enabled !== true, role: 'switch', 'aria-label': '启用' + name + '生成', onchange: async event => { const input = event.currentTarget, requested = input.checked; input.checked = current.enabled === true; input.disabled = true; try { await mediaRequest('media.configureProvider', { kind, config: { enabled: requested } }); if (life.alive()) { toast(name + '生成已' + (requested ? '开启。' : '关闭。')); await renderPage(); } } catch (error) { showError(error); } finally { if (input.isConnected) input.disabled = current.configured !== true && current.enabled !== true; } } });
    const type = field('media-' + kind + '-type', '服务类型', current.type, { choices: kind === 'image' ? [['openai-images', '兼容 Images API'], ['comfyui', 'ComfyUI 工作流']] : [['comfyui', 'ComfyUI 视频工作流']] });
    const baseUrl = field('media-' + kind + '-url', '服务地址', current.baseUrl ?? '', { placeholder: kind === 'image' ? 'https://服务地址/v1' : 'http://127.0.0.1:8188', hint: '填写自己开通的云 API 或自部署服务。云服务使用 HTTPS；本机／局域网服务可使用 HTTP。' });
    const apiKey = field('media-' + kind + '-key', 'API 密钥', '', { type: 'password', hint: current.hasApiKey ? '已保存密钥，留空保留，不回显。' : '服务要求密钥时填写；只保存在本机配置。' }); apiKey.input.autocomplete = 'new-password';
    const clearKey = element('input', { type: 'checkbox' });
    const model = field('media-' + kind + '-model', '模型名称', current.model ?? '', { hint: '使用该服务实际提供的模型标识。' });
    const editTransport = field('media-' + kind + '-edit-transport', '参考图接口格式', current.editTransport ?? 'json', { choices: [['json', 'JSON images（当前接口）'], ['multipart', 'multipart image[]（兼容服务）']] });
    const referenceMode = field('media-' + kind + '-reference', '参考图支持', current.referenceMode ?? 'none', { choices: [['none', '未配置参考图输入'], ['edit', '已配置参考图编辑／输入']] });
    const workflow = field('media-' + kind + '-workflow', 'ComfyUI API 工作流 JSON', current.workflow ? JSON.stringify(current.workflow, null, 2) : '', { multiline: true, hint: '使用 ComfyUI 的 API 格式工作流；工作流需要真实可用的模型及输出节点。' });
    const promptNode = field('media-' + kind + '-prompt-node', '文本提示节点 ID', current.promptNode ?? ''), promptInput = field('media-' + kind + '-prompt-input', '文本输入字段', current.promptInput ?? 'text');
    const referenceNode = field('media-' + kind + '-reference-node', '参考图节点 ID（可选）', current.referenceNode ?? ''), referenceInput = field('media-' + kind + '-reference-input', '参考图输入字段', current.referenceInput ?? 'image');
    const outputs = field('media-' + kind + '-outputs', '输出节点 ID（可选）', (current.outputNodeIds ?? []).join(', '), { hint: '多个 ID 用逗号分隔，留空使用工作流实际输出。' });
    const downloadOrigins = field('media-' + kind + '-download-origins', '返回文件的额外下载来源（可选）', (current.downloadOrigins ?? []).join('\n'), { multiline: true, hint: '服务返回独立 CDN 文件时，每行填写一个受信任的 HTTPS 主机来源，不填完整临时链接或密钥。' });
    const openaiOptions = element('div', {}, model.wrapper, element('details', { class: 'advanced-section' }, element('summary', {}, '高级：参考图接口兼容格式'), element('div', { class: 'advanced-body' }, editTransport.wrapper, downloadOrigins.wrapper))), comfyOptions = element('details', { class: 'advanced-section' }, element('summary', {}, '高级：工作流与节点绑定'), element('div', { class: 'advanced-body' }, workflow.wrapper, element('div', { class: 'form-grid' }, promptNode.wrapper, promptInput.wrapper, referenceNode.wrapper, referenceInput.wrapper), outputs.wrapper));
    const updateType = () => { openaiOptions.hidden = type.input.value !== 'openai-images'; comfyOptions.hidden = type.input.value !== 'comfyui'; }; type.input.addEventListener('change', updateType); updateType();
    const feedback = element('div');
    container.append(card(name + '生成服务', kind === 'video' ? '独立可选；需要已部署并验证可运行的视频工作流。' : '独立可选；开启后相续可按需调用，保存配置不会自动生成。',
      current.configured ? element('label', { class: 'field-checkbox' }, enabled, '启用' + name + '生成') : null,
      !current.configured ? element('p', { class: 'small muted' }, '填写服务地址和所需配置，点击“保存并启用”后，相续即可自主使用。实际创作可能产生服务费用。') : null,
      element('p', { class: 'small muted' }, '当前能力：' + (current.capabilities?.generate ? '配置可提交生成' : '尚未就绪') + '；' + (current.capabilities?.reference ? '支持形象参考' : '尚未支持形象参考') + '。实际结果以服务回执为准。'),
      element('section', { class: 'setup-form' }, element('h3', {}, '连接配置'), element('div', { class: 'advanced-body' }, type.wrapper, baseUrl.wrapper, apiKey.wrapper,
      current.hasApiKey ? element('label', { class: 'field-checkbox' }, clearKey, '明确清除已保存的密钥') : null, referenceMode.wrapper, openaiOptions, comfyOptions,
      element('div', { class: 'row-actions' }, button(current.configured ? '保存' + name + '服务' : '保存并启用' + name + '服务', async () => {
        if (apiKey.input.value && clearKey.checked) throw new Error('不能同时填写新密钥并清除密钥。');
        const config = { enabled: current.configured ? enabled.checked : true, type: type.input.value, baseUrl: baseUrl.input.value.trim(), referenceMode: referenceMode.input.value, allowRemote: /^https:\/\//i.test(baseUrl.input.value.trim()) };
        if (apiKey.input.value) config.apiKey = apiKey.input.value; if (clearKey.checked) config.clearApiKey = true;
        if (type.input.value === 'openai-images') { config.model = model.input.value.trim(); config.referenceMode = referenceMode.input.value; config.editTransport = editTransport.input.value; config.downloadOrigins = downloadOrigins.input.value.split(/[\s,，]+/u).filter(Boolean); }
        else { if (workflow.input.value.trim()) { try { config.workflow = JSON.parse(workflow.input.value); } catch { throw new Error('工作流 JSON 格式无效。'); } } config.promptNode = promptNode.input.value.trim(); config.promptInput = promptInput.input.value.trim() || 'text'; config.referenceNode = referenceNode.input.value.trim(); config.referenceInput = referenceInput.input.value.trim() || 'image'; config.outputNodeIds = outputs.input.value.split(/[\s,，]+/u).filter(Boolean); }
        if (new TextEncoder().encode(JSON.stringify({ kind, config, instanceId })).length > 60000) throw new Error('工作流或配置超过当前管理请求容量，请使用更精简的 API 工作流；内容没有被截断。');
        await mediaRequest('media.configureProvider', { kind, config }); apiKey.input.value = ''; if (!life.alive()) return; toast(name + '服务配置已保存。'); await renderPage();
      }, 'secondary')))), button('检查已保存的连接', async () => { const result = await mediaRequest('media.probeProvider', { kind }); replace(feedback, kv({ '服务可访问': result.reachable ? '是' : '未确认', '配置有效': result.configurationValid ? '是' : '未确认', '实际生成验证': result.verifiedGeneration ? '已验证' : '未执行生成' }), result.message ? notice(result.message) : null); }, 'secondary', { disabled: !current.configured }), feedback));
  }
  if (state.view?.startsWith('provider-')) return container;
  const prompt = field('media-create-prompt', '这次想创作什么', '', { multiline: true, hint: '例如：沿用当前形象，在窗边喝茶的半身照。只在点击开始创作后提交任务。' });
  const kind = field('media-create-kind', '创作类型', 'image', { choices: [['image', '图片'], ['video', '视频']] });
  const useReference = element('input', { type: 'checkbox', checked: Boolean(identity.primaryAssetId), disabled: !identity.primaryAssetId });
  const requestFeedback = element('div');
  async function showJob(jobId) {
    if (!life.alive()) return;
    const detailGeneration = startDetail('创作任务'); let querying = false;
    async function query() {
      if (querying || !life.alive() || detailGeneration !== state.detailGeneration || !$('detail-dialog').open) return; querying = true;
      try {
      const job = await mediaRequest('media.getJob', { jobId, poll: true });
      if (!life.alive() || detailGeneration !== state.detailGeneration || !$('detail-dialog').open) return;
      replace($('detail-content'), kv({ '任务编号': job.jobId ?? jobId, '类型': job.kind === 'video' ? '视频' : '图片', '状态': labels[job.status] ?? ({ submitted: '已提交到服务', running: '生成中' })[job.status] ?? job.status, '形象参考版本': job.referenceVersion == null ? '未使用' : 'v' + job.referenceVersion }), job.error ? notice(job.error.message ?? job.error.code, 'error') : null,
        job.status === 'unknown' ? notice('任务结果尚未确认。查询不会重新提交生成；请先核对原任务，避免重复付费。', 'warning') : null,
        element('div', { class: 'row-actions' }, (job.resultAssetIds ?? []).map(assetId => button('查看生成作品', () => showAsset(assetId), 'secondary'))));
      replace($('detail-footer'), button('查询原任务', query, 'secondary'), !['completed', 'failed', 'cancelled', 'unknown', 'revoked'].includes(job.status) ? button('取消可取消的任务', async () => { await mediaRequest('media.cancelJob', { jobId }); await query(); }, 'secondary') : null, button('关闭', () => $('detail-dialog').close(), 'secondary'));
      if (['prepared', 'running', 'submitted'].includes(job.status)) life.later(() => query().catch(showError), 3500);
      } finally { querying = false; }
    }
    await query();
  }
  async function showAsset(assetId) {
    const detailGeneration = startDetail('形象作品'), asset = await mediaRequest('media.getAsset', { assetId, preview: true });
    if (!life.alive() || detailGeneration !== state.detailGeneration || !$('detail-dialog').open) return;
    replace($('detail-content'), safeImageData(asset.dataUrl) ? element('img', { class: 'asset-preview', src: asset.dataUrl, alt: asset.name ?? '形象作品' }) : notice('原文件已保存，面板不自动加载大图或视频。可下载原文件查看。'), kv({ '名称': asset.name ?? asset.assetId, '类型': asset.mime, '大小': number(asset.bytes) + ' bytes', '参考版本': asset.referenceVersion == null ? '未使用' : 'v' + asset.referenceVersion, '来源': asset.origin === 'import' ? '用户上传' : '生成作品' }));
    replace($('detail-footer'), asset.kind === 'image' ? button('设为当前主参考', async () => { await mediaRequest('media.updateIdentity', { primaryAssetId: assetId }); $('detail-dialog').close(); toast('主参考已更新。'); await renderPage(); }, 'secondary') : null,
      button('下载原文件', async () => { const result = await request('ui.asset.download', { assetId, instanceId }); if (result.status === 'download_started') toast('已交给浏览器下载；如出现保存提示，请完成保存。'); }, 'secondary'), button('删除这份资产', async () => { const confirmation = await confirmOperation({ title: '删除这份形象资产', description: '删除这份本机作品和资产索引，同时清除保留历史里对此图片的引用；不会删除其它作品，无法从此图库恢复。', accept: '删除资产', danger: true }); if (!confirmation) return; await mediaRequest('media.deleteAsset', { assetId }); $('detail-dialog').close(); toast('资产已删除。'); await renderPage(); }, 'danger', { disabled: asset.isPrimaryReference === true || assetId === identity.primaryAssetId, title: asset.isPrimaryReference === true || assetId === identity.primaryAssetId ? '请先取消或更换当前主参考。' : '明确删除本机资产' }), button('关闭', () => $('detail-dialog').close(), 'secondary'));
  }
  const jobsArea = element('div'), gallery = element('div');
  async function loadJobs() {
    const result = await mediaRequest('media.listJobs', { limit: 12 });
    replace(jobsArea, getItems(result).length ? element('div', { class: 'record-list' }, getItems(result).map(job => element('div', { class: 'record' }, element('div', { class: 'record-header' }, element('h3', { class: 'record-title' }, job.kind === 'video' ? '视频任务' : '图片任务'), pill(job.status)), element('p', { class: 'small muted' }, date(job.createdAt)), button('查询进度与结果', () => showJob(job.jobId), 'secondary compact')))) : empty('尚无创作任务', '配置服务不会自动提交生成任务。'));
  }
  async function renderAssets(result, pageNumber = 1) {
    replace(gallery, getItems(result).length ? element('div', { class: 'asset-grid' }, getItems(result).map(asset => element('article', { class: 'record asset-card' }, element('h3', { class: 'record-title' }, asset.name ?? (asset.kind === 'video' ? '视频作品' : '图片作品')), element('p', { class: 'small muted' }, (asset.kind === 'video' ? '视频' : '图片') + ' · ' + number(asset.bytes) + ' bytes' + (asset.pinned ? ' · 主参考已保留' : '')), button('查看作品', () => showAsset(asset.assetId), 'secondary compact')))) : empty('作品库还是空的', '上传和生成的资产会保存在这里。'), paginator(result, async cursor => renderAssets(await mediaRequest('media.listAssets', { limit: 12, cursor }), pageNumber + 1), { pageNumber }));
  }
  const createButton = button('开始这次创作', async () => {
      if (!prompt.input.value.trim()) throw new Error('请先描述这次想创作的内容。');
      const confirmation = await confirmOperation({ title: '提交这次创作', description: '向已保存的' + (kind.input.value === 'video' ? '视频' : '图片') + '服务提交一次任务，可能产生服务费用。后续查询使用同一个任务编号。', accept: '开始生成' }); if (!confirmation) return;
      const requestId = operationId('media_ui');
      try { const job = await mediaRequest('media.generate', { requestId, kind: kind.input.value, prompt: prompt.input.value.trim(), useIdentityReference: useReference.checked }); if (!life.alive()) return; replace(requestFeedback, notice('任务已记录，正在按原任务编号查询。')); await loadJobs(); await showJob(job.jobId); }
      catch (error) { if (!life.alive()) return; replace(requestFeedback, notice('提交结果未确认时，请先刷新下方原任务列表，避免重新付费提交。请求编号：' + requestId, 'warning')); await loadJobs(); throw error; }
    }, 'primary');
  const providerReady = element('p', { class: 'small muted' });
  const updateCreationAvailability = () => { const selected = providers.find(value => value.kind === kind.input.value); const ready = selected?.enabled === true && selected?.configured === true && selected?.capabilities?.generate === true; createButton.disabled = !ready; providerReady.textContent = ready ? '使用已保存的服务配置。' : '先保存并启用所选类型的生成服务，再开始创作。'; };
  kind.input.addEventListener('change', updateCreationAvailability); updateCreationAvailability();
  if (state.view === 'create') container.append(card('开始创作', '任务使用已保存的服务配置，可能产生该服务的费用。相同任务只查询原编号，不因等待时间较长自动重发。', element('div', { class: 'form-grid' }, kind.wrapper), prompt.wrapper, element('label', { class: 'field-checkbox' }, useReference, identity.primaryAssetId ? '沿用当前主参考形象（服务需支持参考图）' : '尚无主参考，本次使用文字描述'),
    createButton, providerReady, button('配置所选类型的服务', () => openSection('provider-' + kind.input.value), 'link'), requestFeedback));
  if (state.view === 'create') return container;
  await loadJobs(); await renderAssets(assets);
  container.append(card('最近创作任务', '生成成功、文件保存和平台发送是不同结果。', button('刷新任务列表', loadJobs, 'secondary compact'), jobsArea),
    card('作品与参考图库', '只在查看时读取作品。主参考与临时缓存分开保存，资产容量以实际用量为准。', view.usage ? kv({ '资产用量': view.usage.assetBytes == null ? '按实际清单查看' : number(view.usage.assetBytes) + ' bytes', '总容量': number(limits.assetBytes) + ' bytes' }) : null, gallery,
      button('导出资产清单', async () => { const manifest = await mediaRequest('media.exportManifest'); startDetail('资产备份清单'); replace($('detail-content'), notice('此处是文件名、摘要与参考关系清单。原始图片／视频仍需一并备份；清单不包含 API 密钥。'), data(manifest)); replace($('detail-footer'), button('复制完整清单', () => copyText(JSON.stringify(manifest, null, 2)), 'secondary'), button('关闭', () => $('detail-dialog').close(), 'secondary')); }, 'secondary')));
  return container;
}

async function tasksPage() {
  const instanceId = state.instanceId, view = await request('tasks.inspect'), container = element('div', { class: 'section-stack' }), listing = element('div');
  const current = () => state.page === 'tasks' && state.instanceId === instanceId;
  async function readDocument(taskId, doc) {
    const generation = startDetail(doc.name ?? '任务资料', 'TASK / ARCHIVE'); let offset = 0, sha = doc.sha256;
    async function page(next = 0) {
      const result = await request('tasks.read', { instanceId, taskId, documentId: doc.documentId, offset: next, maxChars: 4000, expectedSha256: sha });
      if (generation !== state.detailGeneration || !current()) return; offset = result.offset; sha = result.sha256;
      replace($('detail-content'), kv({ '资料': doc.kind ?? '档案', '指纹': sha, '已读位置': result.encoding === 'utf8' ? `${number(result.offset)} → ${number(result.nextOffset)} / ${number(result.totalChars)} 字符` : `${number(doc.bytes)} bytes` }),
        result.encoding === 'utf8' ? element('pre', { class: 'reading-text' }, result.text) : notice('这是二进制资料，请下载原文件查看。'),
        result.complete ? notice('已到原文末尾。') : notice('当前仅显示这一页；完整资料仍保留，下一页继续读取。'));
      replace($('detail-footer'), offset > 0 ? button('上一页', () => page(Math.max(0, offset - 4000)), 'secondary') : null,
        !result.complete && result.encoding === 'utf8' ? button('下一页', () => page(result.nextOffset), 'primary') : null,
        button('下载原文件', () => request('ui.task.download', { instanceId, taskId, documentId: doc.documentId }), 'secondary'),
        button('返回任务', () => openTask(taskId), 'secondary'), button('关闭', () => $('detail-dialog').close(), 'secondary'));
    }
    await page();
  }
  async function openTask(taskId, documentOffset = 0) {
    const generation = startDetail('独立任务', 'TASK'), result = await request('tasks.get', { instanceId, taskId, documentOffset, documentLimit: 20 });
    if (generation !== state.detailGeneration || !current()) return;
    const summary = typeof result.summary === 'string' ? result.summary : result.summary?.text;
    replace($('detail-content'), element('h2', {}, result.title || '独立任务'), pill(result.status),
      summary ? element('div', {}, element('h3', {}, '结果摘要'), element('pre', { class: 'data-preview' }, summary), result.summary?.truncated ? notice('摘要不是完整报告，完整结果在下方资料中。') : null) : null,
      result.capture?.complete === false ? notice('任务状态与资料完整性分别记录；当前仍有未收齐资料或来源缺口。', 'warning') : null,
      element('h3', {}, '原始任务、过程与产物'), (result.documents ?? []).length ? element('div', { class: 'record-list' }, result.documents.map(doc => element('div', { class: 'record' }, element('div', { class: 'record-header' }, element('h3', { class: 'record-title' }, doc.name ?? doc.documentId), tag(doc.kind)), element('p', { class: 'small muted' }, `${number(doc.bytes)} bytes · ${doc.sha256}`), button('按页查看', () => readDocument(taskId, doc), 'secondary compact'), button('下载原文件', () => request('ui.task.download', { instanceId, taskId, documentId: doc.documentId }), 'secondary compact')))) : empty('暂无已归档资料', '只呈现实际保存的数据。'), disclosure({}, element('summary', {}, '任务信息与编号'), kv({ '任务': result.title || result.taskId, '状态': labels[result.status] ?? result.status, '任务编号': result.taskId, '创建': date(result.createdAt), '资料数': number(result.documentCount), '资料已收齐': result.capture?.complete ? '是' : '尚未确认', '实际错误码': result.capture?.errorCode ?? result.errorCode ?? '无' })));
    replace($('detail-footer'), result.nextDocumentOffset != null ? button('下一页资料', () => openTask(taskId, result.nextDocumentOffset), 'secondary') : null,
      documentOffset > 0 ? button('返回首批资料', () => openTask(taskId), 'secondary') : null,
      button('刷新实际状态', () => openTask(taskId, documentOffset), 'secondary'),
      !['completed', 'failed', 'cancelled', 'revoked'].includes(result.status) ? button('取消此任务', async () => { const confirmed = await confirmOperation({ title: '取消独立任务', description: '停止这个任务后续执行，并保留已产生的资料。已经执行的工作目录修改不会自动回滚。', preview: { taskId }, accept: '取消任务' }); if (!confirmed) return; await request('tasks.cancel', { instanceId, taskId }); await openTask(taskId); }, 'secondary') : null,
      button('关闭', () => $('detail-dialog').close(), 'secondary'));
  }
  let listGeneration = 0, pageNumber = 1;
  async function load(cursor) {
    const generation = ++listGeneration, result = await request('tasks.list', { instanceId, limit: 10, ...(cursor ? { cursor } : {}) }); if (!current() || generation !== listGeneration) return;
    pageNumber = cursor ? pageNumber + 1 : 1;
    replace(listing, getItems(result).length ? element('div', { class: 'record-list' }, getItems(result).map(task => element('article', { class: 'record' }, element('div', { class: 'record-header' }, element('h3', { class: 'record-title' }, task.title || task.taskId), tag(labels[task.status] ?? task.status)), element('p', { class: 'small muted' }, `${date(task.createdAt)} · ${number(task.documentCount)} 份资料 · ${task.capture?.complete ? '资料已收齐' : '资料完整性待确认'}`), button('查看任务与资料', () => openTask(task.taskId), 'secondary compact')))) : empty('尚无独立任务', '相续可以自主选择委派。浏览此页不会创建任务或调用模型。'), paginator(result, load, { pageNumber }));
  }
  container.append(card('自主委派与独立资料', '相续决定是否委派、读哪些结果、记住什么。子任务使用独立工作预设，详细过程单独保存；查询资料本身不会写入人格记忆。',
    view.host?.available === false ? notice('当前宿主的原生派发服务尚不可用；已有档案仍可查看。', 'warning') : null,
    kv({ '任务记录': `${number(view.usage?.tasks ?? view.tasks)} / ${number(view.limits?.maxTasks)}`, '资料用量': `${number(view.usage?.bytes ?? view.usedBytes)} / ${number(view.limits?.maxArchiveBytes)} bytes` }), button('刷新任务列表', () => load(), 'secondary'), listing));
  const labelsByKey = { maxTasks: '最多保留的任务记录数', maxArchiveBytes: '全部任务资料容量（bytes）', maxTaskBytes: '单个任务容量（bytes）', maxDocumentBytes: '单份资料容量（bytes）' }, fields = Object.entries(labelsByKey).map(([key, label]) => ({ key, ...field('tasks-limit-' + key, label, view.limits?.[key], { type: 'number', required: true }) }));
  container.append(element('details', { class: 'advanced-section' }, element('summary', {}, '高级：任务资料容量'), element('div', { class: 'advanced-body' }, element('p', { class: 'small muted' }, '容量满时明确报告并停止新增资料，不自动淘汰完整原件或防重收据。并发、深度与执行权限沿 DSH 已有设置；此处不规定人格派发或成长频率。'), element('div', { class: 'field-grid' }, fields.map(item => item.wrapper)), button('保存任务容量', async () => { const changed = Object.fromEntries(fields.map(item => [item.key, Number(item.input.value)]).filter(([key, value]) => value !== view.limits?.[key])); if (!Object.keys(changed).length) return toast('容量没有变化。'); await mutate('tasks.configureLimits', { instanceId, ...changed }, { title: '修改任务资料容量', description: '仅调整存储技术上限；不会清理资料、派发任务或要求人格改变。', preview: changed, accept: '保存容量' }); }, 'secondary'))));
  await load(); return container;
}

async function maintenancePage() {
  const container = element('div'), resultArea = element('div'), root = state.status.memoryRoot ?? state.instances.find(item => item.id === state.instanceId)?.memoryRoot;
  if (!state.view) return destinations(destination('检查数据', '检查格式、文件和恢复状态。', () => openSection('validate')),
    destination('创建备份', '保存一份经过校验的可恢复副本。', () => openSection('backup')),
    destination('从备份恢复', '替换当前人格的数据，需要明确确认。', () => openSection('restore')),
    destination('运行诊断', '查看错误、用量、来源缺口和交付回执。', () => openSection('diagnostics')));
  async function maintenance(action, args, title, description, danger = false) {
    const confirmation = await confirmOperation({ title, description, preview: { instanceId: state.instanceId, memoryRoot: root, ...args }, danger, accept: title }); if (!confirmation) return;
    const result = await request('maintenance.' + action, args); replace(resultArea, card('维护操作结果', '以下是本次真实返回值，失败与结果未知不会显示为完成。', result?.requiresLoad ? notice('操作后实例保持停用。核对结果后，前往“设置与加载”明确加载；加载时才恢复持久调度。', 'warning') : null, data(result))); toast('维护请求已返回。');
    state.status = await request('status'); const instanceResult = await request('instances.list', { instanceId: undefined }); state.instances = instanceItems(instanceResult); updateInstanceBar();
  }
  const backupDestination = field('backup-destination', '备份目标绝对目录', '', { placeholder: 'C:\\Users\\...\\backup\\persona-data-latest' });
  const source = field('restore-source', '已校验备份的绝对目录', '', { placeholder: 'C:\\Users\\...\\backup\\persona-data-latest' });
  container.append(notice('维护使用现有单写者与恢复流程。需要停机的操作由服务端明确检查，活动实例不会被第二个写者绕过；备份不是无限历史。'), element('div', { class: 'maintenance-grid' },
    state.view === 'validate' ? card('数据校验', '检查实际目录的格式、文件与可用恢复状态。', element('p', { class: 'small muted' }, '校验不会把不兼容版本猜测转换成当前格式。'), button('校验当前实例', () => maintenance('validate', {}, '开始校验', '只校验当前实例。活动写者会先安全停用，校验后恢复此前加载状态；正在对话或整理时拒绝切换。'), 'secondary')) : null,
    state.view === 'backup' ? card('创建备份', '使用受控目录和校验清单保存可恢复副本。', backupDestination.wrapper, button('创建备份', () => { if (!backupDestination.input.value.trim()) throw new Error('请填写备份目标绝对目录。'); return maintenance('backup', { destination: backupDestination.input.value.trim() }, '创建备份', '复制当前所选实例的可恢复数据并校验 SHA。活动写者会安全停用并在完成后恢复；不覆盖未知的外部目录。'); }, 'secondary')) : null,
    state.view === 'restore' ? card('从备份恢复', '恢复会替换当前实例数据，请先核对目录。', source.wrapper, notice('已有较新的明确撤销仍需保持有效。恢复旧备份不能复活已明确遗忘的材料。', 'warning'), button('校验并恢复', () => { if (!source.input.value.trim()) throw new Error('请填写备份来源绝对目录。'); return maintenance('restore', { source: source.input.value.trim() }, '确认恢复备份', '安全停用后校验版本、路径、容量与 SHA，再恢复所选实例。此操作会替换数据；完成后保持停用，需你明确加载。', true); }, 'danger')) : null,
    state.view === 'validate' ? card('恢复中断与来源缺口', '区分目录切换中断和宿主原件缺失。', element('div', { class: 'row-actions' }, button('恢复中断的目录切换', () => maintenance('recover', {}, '执行恢复检查', '处理本实例已有的恢复 journal；不会为未知格式删库重建。'), 'secondary'), button('回补可用来源', () => control('backfill'), 'secondary'))) : null), resultArea);
  const kind = field('diagnostic-kind', '诊断类型', 'errors', { choices: [['errors', '运行错误'], ['gaps', '来源缺口'], ['usage', '实际用量'], ['outbox', '交付回执'], ['snapshots', '请求快照']] }), list = element('div'); let pageNumber = 1, listGeneration = 0;
  async function load(cursor) { const generation = ++listGeneration; pageNumber = cursor ? pageNumber + 1 : 1; const result = await request('diagnostics.list', { kind: kind.input.value, pageSize: 10, ...(cursor ? { cursor } : {}) }); if (generation !== listGeneration) return; replace(list, getItems(result).length ? element('div', { class: 'record-list' }, getItems(result).map(item => element('article', { class: 'record' }, data(item)))) : empty('当前没有可用诊断', '用量缺失表示未知，不计作零；受保留容量限制，诊断不会无限积累。'), paginator(result, load, { pageNumber })); }
  kind.input.addEventListener('change', () => load().catch(showError));
  if (state.status.available && state.view === 'diagnostics') { await load(); container.append(card('真实诊断', '仅查看已保留数据，不因打开面板调用模型。', element('div', { class: 'toolbar' }, kind.wrapper, button('刷新诊断', () => load(), 'secondary')), list)); }
  return container;
}
$('page-back').addEventListener('click', () => goBack().catch(showError));
$('close-detail').addEventListener('click', () => { state.detailGeneration++; $('detail-dialog').close(); });
$('confirm-accept').addEventListener('click', () => $('confirm-dialog').close('confirm'));
$('confirm-cancel').addEventListener('click', () => $('confirm-dialog').close('cancel'));
$('confirm-close').addEventListener('click', () => $('confirm-dialog').close('cancel'));
$('detail-dialog').addEventListener('cancel', () => { state.detailGeneration++; });
$('refresh-button').addEventListener('click', () => { if (state.connected) renderPage().catch(showError); else connect(); });
$('active-instance').addEventListener('change', async event => { state.instanceId = event.target.value; state.budgetDraft = null; state.memoryPerson = null; state.trail = []; try { state.status = await request('status'); state.people = state.status.available ? getItems(await request('people.list', { pageSize: 100 })) : []; await renderPage(); } catch (error) { showError(error); } });
$('connect-retry').addEventListener('click', connect);
document.querySelectorAll('[data-page]').forEach(node => node.addEventListener('click', event => { event.preventDefault(); navigate(node.dataset.page).catch(showError); }));
window.addEventListener('persona-bridge-ready', () => { if (!state.connected) connect(); });
connect();
