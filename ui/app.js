/* The management page talks only to the DSH bridge. It never creates a writer or a model call by itself. */
const $ = id => document.getElementById(id);
const state = { connected: false, instanceId: null, instances: [], people: [], status: null, page: 'overview', generation: 0, detailGeneration: 0 };
const pages = {
  overview: ['运行总览', 'OVERVIEW', '查看真实运行状态、容量与正在执行的工作。'],
  persona: ['共同人格', 'PERSONA', '查看持续积累的身份、性格与习惯。这里展示当前数据，不替人格设定成长指标。'],
  memory: ['记忆与关系', 'MEMORY', '按关系与来源浏览原件、提炼和编码，保留实际发言者与未知归属。'],
  evolution: ['进化与变更', 'EVOLUTION', '跟踪已选整理作业、未完成进度和已保留的变更历史。'],
  settings: ['设置与加载', 'SETTINGS', '管理实例、加载状态和技术资源；保存配置不会要求人格必须改变。'],
  chat: ['聊天渠道与语音', 'CHANNELS & VOICE', '在熟悉的聊天软件里继续交流，让同一个人格走进私聊和群聊。'],
  maintenance: ['维护与诊断', 'MAINTENANCE', '查看可用诊断、校验和备份恢复结果。写入操作都作用于明确选择的实例。'],
};
const labels = { awake: '清醒', sleeping: '睡眠', queued: '待执行', running: '执行中', paused: '已暂停', committed: '已提交', completed: '已完成', prepared: '已准备', failed: '失败', invalidated: '已失效', no_work: '无工作', delivered: '已交付', pending: '待处理', cancelled: '已取消', unknown: '结果未知', deferred: '已暂缓' };
const pretty = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const number = value => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('zh-CN').format(value) : '—';
const date = value => typeof value === 'number' && Number.isFinite(value) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未选择时间';
const short = (value, max = 230) => { const text = typeof value === 'string' ? value : pretty(value) ?? ''; const chars = Array.from(text); return chars.length > max ? chars.slice(0, max).join('') + '…' : text; };
const errorText = error => `${error?.code ? error.code + ' · ' : ''}${error?.message ?? String(error)}`;
const personName = id => id == null ? '未知归属' : state.people.find(p => p.personId === id || p.id === id)?.displayName || id;
const memoryScopeLabel = record => record.scope === 'global'
  ? (['facet', 'signature', 'habit'].includes(record.recordType) ? '共同人格' : '共同记忆')
  : record.personId != null ? '关系：' + personName(record.personId) : '未知归属';
function applyTheme(theme) {
  const value = ['system', 'light', 'dark'].includes(theme) ? theme : 'system';
  if (value === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = value;
  $('theme-choice').value = value;
}
let themeRead = false;
async function loadTheme() {
  if (themeRead) return;
  try { const result = await request('ui.theme.get'); applyTheme(result.theme); themeRead = true; }
  catch { try { applyTheme(localStorage.getItem('xiangxu.theme')); } catch {} }
}
function element(tag, attrs = {}, ...children) {
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
function notice(text, kind = '') { return element('div', { class: `notice ${kind}` }, text); }
function pill(value) { return element('span', { class: 'status-pill ' + (['failed', 'invalidated', 'error'].includes(value) ? 'error' : ['paused', 'pending', 'unknown', 'prepared'].includes(value) ? 'warning' : '') }, labels[value] ?? value ?? '未知'); }
function tag(text, kind = '') { return element('span', { class: `tag ${kind}` }, text); }
function empty(title, detail, symbol = '◇') { return element('div', { class: 'empty-state' }, element('div', { class: 'empty-symbol', 'aria-hidden': true }, symbol), element('h3', {}, title), element('p', {}, detail)); }
function card(title, subtitle, ...content) { return element('section', { class: 'card' }, element('div', { class: 'card-header' }, element('div', {}, element('h2', {}, title), subtitle ? element('p', {}, subtitle) : null)), content); }
function kv(items) { return element('dl', { class: 'kv-list' }, Object.entries(items).map(([name, value]) => element('div', { class: 'kv-row' }, element('dt', {}, name), element('dd', {}, value instanceof Node ? value : value == null ? '—' : String(value))))); }
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
    return element('div', {}, kv({ '起点版本': 'v' + value.fromVersion, '终点版本': 'v' + value.toVersion }), value.changes.length ? value.changes.map(change => card(({ anchor: '身份基调', axes: '人格坐标', facets: '倾向与边界', signatures: '签名', habits: '习惯', retired: '已退役条目' })[change.field] ?? change.field, '', element('div', { class: 'diff-grid' }, element('div', {}, element('div', { class: 'section-label' }, '修改前'), data(change.before)), element('div', {}, element('div', { class: 'section-label' }, '修改后'), data(change.after))))) : empty('所选版本没有模块变化', '这是实际对比结果，不要求为了进化而产生变更。'));
  }
  if (value && typeof value === 'object' && value.recordType) {
    const refs = value.srcRefs ?? (value.sourceEventId ? [{ sourceSessionId: value.sourceSessionId, sourceEventId: value.sourceEventId, sourceRole: value.role }] : []);
    return element('div', {}, kv({ '类型': value.recordType, '记忆归属': memoryScopeLabel(value), '实际角色': value.role ?? value.sourceRole ?? '提炼/解释', '实际发言者': value.speakerId ?? '未知 / 未提供独立标识', '发生时间': value.sourceAt ? date(value.sourceAt) : '未提供', '条目 ID': element('code', {}, value.id) }),
      value.text || value.meaning || value.desc ? element('div', { class: 'detail-value' }, element('h3', {}, '已保留内容'), value.text ?? value.meaning ?? value.desc) : null,
      refs.length ? element('div', {}, element('h3', {}, '实际来源'), element('div', { class: 'record-list' }, refs.map(ref => element('div', { class: 'record' }, kv({ '会话': element('code', {}, ref.sourceSessionId), '来源根': element('code', {}, ref.sourceEventId), '来源角色': ref.sourceRole ?? '未提供', '可用性': ref.available === false ? '原件不可用' : '按实际原件查询' }), button('查询仍可用的原件', () => inspectDocument('sources.read', { sourceRefs: [ref] }, '来源原件', { eyebrow: 'SOURCE / ORIGINAL' }), 'link'))))) : null,
      element('details', {}, element('summary', { class: 'small muted' }, '查看完整字段'), data(value)));
  }
  if (value && typeof value === 'object' && value.runId && value.status) {
    const entries = value.validatedPatch ?? value.candidatePatch?.entries ?? (Array.isArray(value.candidatePatch) ? value.candidatePatch : []);
    return element('div', {}, kv({ '批次': element('code', {}, value.runId), '状态': labels[value.status] ?? value.status, '关系归属': personName(value.personId), '实际调用尝试': number(value.reviewState?.modelCalls), '暂停原因': value.reviewState?.pauseReason ?? value.validationError?.code ?? '无', '提交标记': value.commitMarker ?? '尚未提交' }),
      element('h3', {}, value.status === 'committed' ? '已提交变更' : '尚未提交的提案'), entries.length ? element('div', { class: 'record-list' }, entries.map(entry => element('div', { class: 'record' }, element('div', { class: 'record-header' }, element('h3', { class: 'record-title' }, entry.documentKey), tag(entry.operation === 'remove' ? '删除' : '更新')), element('code', {}, entry.recordId), entry.operation === 'upsert' ? data(entry.value) : element('p', { class: 'small muted' }, '明确移除此记录')))) : empty('当前没有变更条目', '空变更有效；仅提交状态才表示完成对应消费。'),
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
    replace(body, !complete ? notice(`目前读取 ${number(Array.from(accumulated).length)} / ${number(total)} 字符；未读尾部仍保留，继续读取后才是完整详情。`, 'warning') : null, complete ? documentView(view) : data(view));
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
  loadTheme();
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
  const select = $('active-instance'); replace(select, state.instances.map(item => element('option', { value: item.id, selected: item.id === state.instanceId }, `${item.name ?? item.id}${item.loaded ? '' : ' · 未加载'}${item.active ? ' · 默认' : ''}`)));
  if (!state.instances.length) select.append(element('option', { value: '' }, '尚无实例'));
  select.disabled = !state.instances.length;
  const selected = state.instances.find(item => item.id === state.instanceId); $('instance-root').textContent = selected?.memoryRoot ?? state.status?.memoryRoot ?? '未配置目录'; $('instance-root').title = $('instance-root').textContent;
  $('build-version').textContent = state.status?.version ?? state.status?.pluginVersion ?? 'DSH 插件';
}
async function navigate(page) { state.page = pages[page] ? page : 'overview'; await renderPage(); }
async function renderPage() {
  const [title, eyebrow, description] = pages[state.page];
  $('page-title').textContent = title; $('page-eyebrow').textContent = 'XIANGXU / ' + eyebrow; $('page-description').textContent = description;
  document.querySelectorAll('[data-page]').forEach(node => { node.classList.toggle('active', node.dataset.page === state.page); if (node.dataset.page === state.page) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
  replace($('page-actions'));
  if (!state.connected) return;
  clearError(); const generation = ++state.generation; $('page-content').classList.add('loading');
  try {
    state.status = await request('status'); updateInstanceBar();
    let content;
    if (!state.status.available && !['settings', 'maintenance', 'chat'].includes(state.page)) content = card('当前实例尚未加载', '加载实例后才能读取人格、记忆和整理状态。', notice(state.status.unloaded ? '实例已停用。数据仍保留在原记忆目录。' : '当前实例不可用，请查看诊断或加载设置。', 'warning'), button('前往设置与加载', () => navigate('settings'), 'primary'));
    else content = await ({ overview: overviewPage, persona: personaPage, memory: memoryPage, evolution: evolutionPage, settings: settingsPage, maintenance: maintenancePage, chat: chatPage })[state.page]();
    if (generation !== state.generation) return;
    replace($('page-content'), content); $('last-updated').textContent = '上次读取 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  } catch (error) { if (generation === state.generation) { showError(error); replace($('page-content'), card('暂时无法读取', '', notice(errorText(error), 'error'), button('重新读取', renderPage, 'secondary'))); } }
  finally { if (generation === state.generation) $('page-content').classList.remove('loading'); }
}
async function mutate(action, args = {}, options = {}) {
  const confirmed = options.confirm === false ? {} : await confirmOperation({ title: options.title ?? '执行管理操作', description: options.description ?? '操作只作用于当前选择的实例。', preview: options.preview ?? args, reason: options.reason, accept: options.accept, danger: options.danger });
  if (!confirmed) return;
  const result = await request(action, { ...args, ...(confirmed.reason ? { reason: confirmed.reason } : {}) });
  toast(options.success ?? '操作已返回，请查看实际结果。');
  if (options.refresh !== false) await renderPage();
  return result;
}
async function control(name, args = {}) {
  const choices = {
    wake: ['明确唤醒', '向当前实例发送明确唤醒信号。它醒来后如何回应仍由人格选择。'],
    mute: ['暂停主动行为', '暂停后续主动判断，并取消或对账尚可取消的主动投递。普通回复与记忆接收仍可进行。'],
    resume: ['恢复主动行为', '恢复主动机制。何时主动、是否开口仍由人格自行决定。'],
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
  } else await mutate('control.' + name, args, { title, description, success: '已收到操作结果。' });
}
async function showOperation(receipt, { retry } = {}) {
  const id = receipt?.operationId ?? receipt?.id ?? receipt?.operation?.id;
  const generation = startDetail('后台操作回执', 'OPERATION');
  async function update(query = true) {
    const item = query && id ? await request('operations.get', { id }) : receipt;
    if (generation !== state.detailGeneration) return;
    replace($('detail-content'), notice('查询状态不会重新执行操作。即使关闭此面板，也不要因等待时间较长而重复提交。'), kv({ '操作编号': id ?? '未返回编号', '状态': labels[item?.status] ?? item?.status ?? '已收到回执', '实际提交': item?.result?.committed == null ? '以回执为准' : item.result.committed ? '已提交' : '尚未提交', '暂停原因': item?.result?.pauseReason ?? item?.error?.code ?? '无' }), data(item));
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
  const persistent = capacity.persistentChars ?? capacity.longTermChars?.used, persistentLimit = capacity.longTermTargetChars ?? capacity.longTermChars?.limit;
  const hot = capacity.hotChars ?? capacity.tempChars?.used, hotLimit = capacity.tempTargetChars ?? capacity.tempChars?.limit;
  const gaps = runtime.memoryGapCounts?.unresolved ?? runtime.memoryGaps?.filter(item => !item.resolvedAt).length;
  replace($('page-actions'), button(runtime.globalMuted ? '恢复主动' : '暂停主动', () => control(runtime.globalMuted ? 'resume' : 'mute'), 'secondary'), button('明确唤醒', () => control('wake'), 'primary'));
  const controls = element('div', { class: 'row-actions' }, button('查看完整运行态', () => inspectDocument('state.get', {}, '完整运行状态'), 'secondary compact'), button('整理一批', () => control('consolidate'), 'secondary compact'));
  return element('div', {}, element('div', { class: 'stats-grid' },
    stat('当前状态', labels[runtime.sleep?.state] ?? '未知', runtime.globalMuted ? '主动行为已由用户暂停' : '主动行为由人格自行选择', '◉'),
    stat('长期记忆', number(persistent), `目标 ${number(persistentLimit)} 字符`, '▤', persistent != null && persistentLimit != null ? { used: persistent, limit: persistentLimit } : null),
    stat('临时过程', number(hot), `目标 ${number(hotLimit)} 字符`, '⌁', hot != null && hotLimit != null ? { used: hot, limit: hotLimit } : null),
    stat('未解决缺口', number(gaps), '仅显示真实记录的来源缺口', '◇')),
    element('div', { class: 'two-column' }, card('此刻的运行状态', '时间、信号和回执来自当前实例。', kv({ '睡眠状态': labels[runtime.sleep?.state] ?? '未知', '唤醒条件': ({ at_time: '人格选择的时间', consolidation_complete: '所选整理提交完成', explicit_wake: '等待明确唤醒' })[runtime.sleep?.wakeCondition] ?? '当前未选择', '计划唤醒': date(runtime.sleep?.wakeAt), '下次判断': date(runtime.schedule?.nextCheckAt), '事件等待': runtime.schedule?.recheckOn?.join('、') || '无', '主动控制': runtime.globalMuted ? '用户已暂停' : '允许人格自主选择' }), controls),
      card('存储与接入', '容量限制保护数据写入，不替人格决定睡眠或成长。', kv({ '物理占用': capacity.physicalBytes != null ? number(capacity.physicalBytes) + ' bytes' : '未知', '已接入会话': number(status.agents?.length), '排队作业': number(jobs.queued ?? 0), '执行中': number(jobs.running ?? 0), '暂停作业': number(jobs.paused ?? 0) }), button('查看容量设置', () => navigate('settings'), 'link'))),
    card('接入的会话', '关系归属用于记忆和路由；它不改变实际发言者。', status.agents?.length ? element('div', { class: 'record-list' }, status.agents.map(agent => element('div', { class: 'record' }, kv({ '会话': element('code', {}, agent.sessionId), '关系归属': personName(agent.personId), '通道': element('code', {}, agent.channelId) })))) : empty('当前没有已接入会话', '在 DSH 中选择“相续人格”预设后，对应会话会出现在这里。人格实例的加载状态与会话接入分别显示。')));
}
async function personaPage() {
  let section = 'anchor', personaGeneration = 0;
  const content = element('div'), modules = [['anchor', '身份基调'], ['axes', '人格坐标'], ['facets', '倾向与边界'], ['signatures', '签名'], ['habits', '习惯'], ['retired', '已退役条目']];
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
    else if (Array.isArray(module)) node.append(module.length ? element('div', { class: 'record-list' }, module.map(item => element('article', { class: 'record' }, element('h3', { class: 'record-title' }, item.name ?? item.label ?? item.id ?? '条目'), element('p', { class: 'record-text' }, item.text ?? item.description ?? item.if ?? item.cue ?? short(item, 600)), element('div', { class: 'record-meta' }, item.scope ? tag(item.scope === 'global' ? '共同人格' : personName(item.personId)) : null, item.epistemic ? tag(item.epistemic) : null, item.observations != null ? tag('描述性观察 ' + number(item.observations)) : null), button('查看完整字段与来源', () => { const id = startDetail('人格条目', 'PERSONA'); replace($('detail-content'), data(item)); replace($('detail-footer'), button('关闭', () => $('detail-dialog').close(), 'secondary')); return id; }, 'link')))) : empty('当前没有条目', '本模块可以保持不变，空白不是异常。'));
    else node.append(data(module));
    node.append(button('查看当前模块原始字段', () => inspectDocument('persona.get', { section }, title), 'link')); replace(content, node);
  }
  for (const [key, label] of modules) tabs.append(button(label, () => load(key), 'module-tab', { class: `module-tab${key === section ? ' active' : ''}`, dataset: { section: key } }));
  await load(section); return element('div', {}, tabs, content);
}
function memoryRecord(record, open) {
  const role = record.role ?? record.sourceRole ?? record.srcRefs?.[0]?.sourceRole;
  const text = record.text ?? record.textPreview ?? record.summary ?? record.expansion ?? record.meaning ?? record.preview ?? record.anchorPreview ?? record.title ?? '';
  return element('article', { class: 'record' }, element('div', { class: 'record-header' }, element('h3', { class: 'record-title' }, record.label ?? record.name ?? ({ chat: '对话原件', memory: '记忆提炼', code: '编码', relation_signature: '关系签名', relation_event: '关系事件', interpretation: '待解释', facet: '人格倾向', signature: '共同签名', habit: '习惯' })[record.recordType] ?? record.recordType ?? '记忆条目'), element('time', { class: 'record-time' }, record.sourceAt || record.createdAt || record.updatedAt ? date(record.sourceAt ?? record.createdAt ?? record.updatedAt) : '时间未提供')),
    element('p', { class: 'record-text' }, short(text, 360)), element('div', { class: 'record-meta' }, tag(({ assistant: 'AI 助手', user: '用户原话', system: '程序材料' })[role] ?? role ?? '提炼/解释', role === 'assistant' ? 'ai' : role === 'user' ? 'human' : ''), tag(memoryScopeLabel(record)), record.speakerId ? tag('发言者：' + record.speakerId) : null, record.epistemic ? tag(record.epistemic) : null),
    element('div', { class: 'record-footer' }, element('code', { class: 'muted' }, short(record.id ?? record.recordId ?? '', 55)), button('查看详情 →', open, 'link')));
}
async function memoryPage() {
  const container = element('div'), filters = element('div', { class: 'toolbar', role: 'search' }), resultArea = element('div');
  const query = field('memory-query', '搜索线索', '', { placeholder: '原话、记忆或编码中的文字', class: 'search' });
  const scope = field('memory-scope', '查询范围', 'all', { choices: [['all', '全部关系'], ['person', '指定人物'], ['global', '共同记忆'], ['unknown', '未知暂存']] });
  const person = field('memory-person', '关系人物', '', { choices: [['', '请选择人物'], ...state.people.map(item => [item.personId ?? item.id, item.displayName ?? item.personId ?? item.id])] });
  const type = field('memory-type', '条目类型', '', { choices: [['', '全部类型'], ['chat', '对话原件'], ['memory', '记忆索引'], ['code', '编码'], ['relation_signature', '关系签名'], ['relation_event', '关系事件'], ['interpretation', '待解释'], ['facet', '人格倾向'], ['signature', '共同签名'], ['habit', '习惯']] });
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
  query.input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); load().catch(showError); } }); filters.append(query.wrapper, scope.wrapper, person.wrapper, type.wrapper, button('搜索', () => load(), 'primary'));
  const peopleQuery = field('people-query', '搜索已知人物', '', { placeholder: '姓名、别名或人物 ID' }), peopleResults = element('div');
  let peopleArgs = {}, peoplePage = 1, peopleGeneration = 0;
  async function loadPeople(cursor) {
    const generation = ++peopleGeneration;
    if (!cursor) { peopleArgs = { query: peopleQuery.input.value.trim(), pageSize: 15 }; peoplePage = 1; } else peoplePage++;
    const result = await request('people.list', { ...peopleArgs, ...(cursor ? { cursor } : {}) }); if (generation !== peopleGeneration) return;
    const rows = getItems(result), known = new Map([...state.people, ...rows].map(item => [item.personId ?? item.id, item])); state.people = [...known.values()].slice(-200);
    replace(peopleResults, rows.length ? element('div', { class: 'people-list' }, rows.map(item => element('div', {}, button(item.displayName ?? item.personId, () => inspectDocument('relation.get', { personId: item.personId ?? item.id, section: 'all' }, '关系 · ' + (item.displayName ?? item.personId), { eyebrow: 'RELATIONSHIP' }), 'person-button', { class: 'person-button' }), button('筛选此人的记忆', async () => { const id = item.personId ?? item.id; if (![...person.input.options].some(option => option.value === id)) person.input.append(element('option', { value: id }, item.displayName ?? id)); person.input.value = id; person.input.disabled = false; scope.input.value = 'person'; await load(); }, 'link')))) : empty('没有匹配的已知人物', '这里不会按姓名自动创建或合并人物。'), paginator(result, loadPeople, { pageNumber: peoplePage }));
  }
  peopleQuery.input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); loadPeople().catch(showError); } });
  const relations = card('人物与关系', '按真实人物列表分页。查看主观印象、编码与相处状态。', peopleQuery.wrapper, button('搜索人物', () => loadPeople(), 'secondary compact'), peopleResults);
  await Promise.all([load(), loadPeople()]); container.append(filters, element('div', { class: 'two-pane' }, relations, resultArea)); return container;
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
  await load(); content.append(element('div', { class: 'toolbar' }, filter.wrapper, button('明确整理一批', () => control('consolidate'), 'primary')), notice('“已暂停”或“已准备”不等于完成。这里的执行段预算限制资源，不规定人格每天必须进化几次。'), list, card('管理操作回执', '已接收、执行中、已返回和结果未知分别显示。', operationArea), comparison); return content;
}
const configGroups = [
  ['记忆与存储', [['longTermTargetChars', '长期文本总目标', '字符'], ['recentTargetChars', '近期视图目标', '字符'], ['recentPreferredDays', '近期优先天数', '天；不是永久保留保证'], ['tempTargetChars', '临时过程目标', '字符'], ['diskReserveBytes', '磁盘保留空间', 'bytes']]],
  ['记录与文件上限', [['capacityLimits.artifactTextChars', '单条进化记录文本', '字符'], ['capacityLimits.artifactRecordBytes', '单条记录序列化', 'bytes'], ['capacityLimits.documentBytes', '业务 JSON 文档', 'bytes'], ['capacityLimits.storeBytes', '实例物理空间', 'bytes；另验事务峰值']]],
  ['整理输入与输出', [['processingLimits.consolidationInputChars', '新批每目标增量', '字符；不重切旧批'], ['processingLimits.consolidationContextChars', '旧记忆每页', '字符'], ['processingLimits.consolidationRequestTokens', '核心完整请求预算', '计数单位；缺 tokenizer 时标估算'], ['processingLimits.consolidationOutputTokens', '整理输出预留', 'tokens'], ['processingLimits.controlOutputTokens', '控制输出预留', 'tokens'], ['processingLimits.replyOutputTokens', '回复输出预留', 'tokens']]],
  ['作业执行容量', [['processingLimits.consolidationCallsPerSegment', '单执行段调用尝试', '跨全部子批共享；不是每日频率'], ['processingLimits.maxQueuedConsolidations', '最大排队作业', '个'], ['processingLimits.maxTargetsPerJob', '每作业最多目标', '个']]],
  ['普通注入预算', [['contextBudget.totalTokens', '动态人格材料总预算', '计数单位'], ['contextBudget.environmentTokens', '环境', '计数单位'], ['contextBudget.anchorTokens', '身份基调', '计数单位'], ['contextBudget.personaTokens', '人格', '计数单位'], ['contextBudget.habitTokens', '习惯', '计数单位'], ['contextBudget.relationTokens', '关系', '计数单位'], ['contextBudget.retrievalTokens', '检索', '计数单位']]],
  ['条目容量', [['artifactLimits.axes', '人格坐标', '个'], ['artifactLimits.tendencyFacets', '倾向', '个'], ['artifactLimits.boundaryFacets', '软边界', '个'], ['artifactLimits.signatures', '共同签名', '个'], ['artifactLimits.habits', '习惯', '个'], ['artifactLimits.impressionSignaturesPerPerson', '每人印象签名', '个'], ['artifactLimits.indexItemsPerPerson', '每人索引', '个'], ['artifactLimits.codesPerScope', '每范围编码', '个'], ['artifactLimits.interpretationsPerPerson', '每人待解释', '个'], ['artifactLimits.relationEventsPerPerson', '每人关系事件', '个']]],
  ['有限历史与诊断', [['retention.snapshotMaxRequests', '快照保留数量', '条'], ['retention.personaHistoryMaxVersions', '人格历史版本', '个'], ['retention.journalMaxBytes', '运行日志与工作区', 'bytes'], ['retention.backupMaxBytes', '维护备份容量', 'bytes']]],
];
const getPath = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
function setPath(object, path, value) { const keys = path.split('.'); let node = object; for (const key of keys.slice(0, -1)) node = node[key] ??= {}; node[keys.at(-1)] = value; }
async function settingsPage() {
  const container = element('div'), current = state.status.available ? await request('config.get') : null;
  const instances = await request('instances.list', { instanceId: undefined }); state.instances = instanceItems(instances); updateInstanceBar();
  const instanceCards = state.instances.map(item => element('article', { class: `record instance-card${item.id === state.instanceId ? ' active' : ''}` }, element('div', { class: 'record-header' }, element('h3', { class: 'record-title' }, item.name ?? item.id), pill(item.loaded ? 'running' : 'paused')), element('div', { class: 'record-meta' }, tag(item.id), item.active ? tag('新会话默认实例') : null, item.id === state.instanceId ? tag('正在查看') : null), element('div', { class: 'instance-path' }, item.memoryRoot), element('div', { class: 'row-actions' },
    button(item.loaded ? '停用实例' : '加载实例', async () => { const result = await mutate(item.loaded ? 'instances.unload' : 'instances.load', { instanceId: item.id }, { title: item.loaded ? '停用这个人格实例' : '加载这个人格实例', description: item.loaded ? '停止此实例的接收、调度和写入，释放写者；保留原记忆目录。进行中的对话或整理会阻止切换。' : '从已登记目录加载实例，恢复其真实持久状态，并停用当前其他实例。一个目录只允许一个活动写者。', preview: { instanceId: item.id, memoryRoot: item.memoryRoot }, refresh: false }); if (result) { if (!item.loaded) state.instanceId = result.activeInstanceId ?? item.id; await connect(); } }, item.loaded ? 'secondary compact' : 'primary compact'),
    !item.active ? button('切换到此实例', async () => { const result = await mutate('instances.select', { instanceId: item.id }, { title: '切换人格实例', description: '停用当前实例并加载所选目录，作为后续人格会话使用的实例。不迁移或合并旧记录；对话或整理执行中会拒绝切换。', preview: { instanceId: item.id, memoryRoot: item.memoryRoot }, refresh: false }); if (result) { state.instanceId = result.activeInstanceId ?? item.id; await connect(); } }, 'secondary compact') : null)));
  const newName = field('instance-new-name', '显示名称', '', { placeholder: '例如 日常相续' }), newRoot = field('instance-new-root', '记忆目录绝对路径', '', { placeholder: 'C:\\Users\\...\\persona-new', hint: '使用独立目录。更换实例不等于移动、合并或覆盖旧数据；实例编号由服务生成。' });
  const autoLoad = element('input', { type: 'checkbox', id: 'instance-auto-load', checked: Boolean(instances.autoLoad) });
  container.append(card('加载与实例', '实例决定使用哪一套持久记忆；预设决定哪些 DSH 会话接入。', notice('暂停主动只停止主动机制；停用实例才停止此实例的接收、调度和写入。同一时间只加载一个实例；切换 DSH 预设不会自动删除人格数据。'), element('div', { class: 'record-list' }, instanceCards), element('hr', { class: 'divider' }), element('h3', {}, '启动时的加载方式'), element('label', { class: 'field-checkbox' }, autoLoad, 'DSH 下次启动时自动加载已选实例'), button('应用加载方式', async () => { const target = instances.selectedInstanceId ?? instances.activeInstanceId; if (!target) throw new Error('请先登记并选择实例。'); const result = await mutate('instances.load', { instanceId: target, autoLoad: autoLoad.checked }, { title: '应用启动加载方式', description: '本次会重新加载已选实例，并保存下次启动是否自动加载的选择。关闭自动加载不会删除数据，当前这次仍会加载。', preview: { instanceId: target, autoLoad: autoLoad.checked }, refresh: false }); if (result) { state.instanceId = target; await connect(); } }, 'secondary'), element('hr', { class: 'divider' }), element('h3', {}, '从独立目录加载一个实例'), newName.wrapper, newRoot.wrapper, button('登记并加载', async () => { if (!newRoot.input.value.trim()) throw new Error('请填写绝对记忆目录。'); const result = await mutate('instances.load', { name: newName.input.value.trim() || '相续人格', memoryRoot: newRoot.input.value.trim() }, { title: '登记并加载实例', description: '打开所选目录的记忆，或在不存在数据的独立目录初始化新实例；当前其他实例会停用。不复制测试经历，也不自动合并已有记忆。', preview: { name: newName.input.value || '相续人格', memoryRoot: newRoot.input.value }, refresh: false }); if (result) { state.instanceId = result.activeInstanceId ?? result.selectedInstanceId; await connect(); } }, 'primary')));
  if (!current) { container.append(notice('当前查看的实例未加载，加载后可修改其技术配置。', 'warning')); return container; }
  const form = element('div', { role: 'form', 'aria-label': '技术设置' }), inputs = new Map(), timezone = field('settings-timezone', '现实时间的时区', current.timezone, { required: true, placeholder: 'Asia/Shanghai', hint: 'IANA 时区名称；不从目录名推测。' }), mode = field('settings-mode', '整理机会的呈现方式', current.consolidationMode, { choices: [['sleep', 'sleep · 睡眠整理方式'], ['on_write', 'on_write · 写后合并机会']] });
  form.append(notice('人格自行选择必要时 run / defer，各模块都允许不变。这里不设置主动次数、最小社交间隔、印象门槛、强制睡眠或固定进化周期。'), element('div', { class: 'form-grid' }, timezone.wrapper, mode.wrapper), notice('sleep：人格选择本次整理与睡眠，也可以只休息或清醒整理。on_write：写后合并机会，在正常人格轮由它选择，不是每写一条自动付费。两种方式沿用已有来源与消费游标。'));
  for (const [title, definitions] of configGroups) {
    const group = element('fieldset', { class: 'form-section' }, element('legend', {}, title)), grid = element('div', { class: 'form-grid wide' });
    for (const [path, label, hint] of definitions) { const input = field('config-' + path.replaceAll('.', '-'), label, getPath(current, path), { type: 'number', min: /^(capacityLimits|processingLimits)\./.test(path) ? 1 : 0, hint }); inputs.set(path, input.input); grid.append(input.wrapper); }
    group.append(grid); form.append(group);
  }
  async function saveSettings() {
    const partial = {};
    if (timezone.input.value.trim() !== current.timezone) partial.timezone = timezone.input.value.trim();
    if (mode.input.value !== current.consolidationMode) partial.consolidationMode = mode.input.value;
    for (const [path, input] of inputs) { const value = Number(input.value); if (!input.value.trim() || !Number.isSafeInteger(value) || value < Number(input.min)) throw new Error('请输入有效整数：' + path); if (value !== getPath(current, path)) setPath(partial, path, value); }
    if (!Object.keys(partial).length) { toast('没有配置变更。'); return; }
    await mutate('config.update', { config: partial }, { title: '保存技术设置', description: '仅更新列出的技术配置。容量缩小不会自动裁剪记忆或替人格决定遗忘；超限操作会按实际约束拒绝。', preview: partial, success: '配置已返回实际保存结果。' });
  }
  form.append(element('div', { class: 'form-footer' }, element('p', {}, '设置作用于当前选定实例。请求预算估算不等于供应商精确 token 计费。'), button('保存设置', saveSettings, 'primary', { dataset: { action: 'save-settings' } })));
  container.append(card('技术设置', '资源边界有明确上限，改变配置不等于改变人格观点。', form)); return container;
}
async function chatPage() {
  const channels = await request('channels.status'), container = element('div');
  const connections = Array.isArray(channels.connections) ? channels.connections : [];
  const platformName = value => ({ qq: 'QQ', wechat: '微信' })[value] ?? value;
  const statusName = value => ({ connected: '桥已连接', ready: '已就绪', connecting: '正在连接', disconnected: '尚未连接', disabled: '已停用', unconfigured: '尚未配置', unavailable: '暂不可用', error: '连接异常' })[value] ?? value;
  container.append(card('', '', element('div', { class: 'mobile-intro' }, element('div', { class: 'mobile-symbol', 'aria-hidden': true }, '☷'), element('div', {}, element('h2', {}, '在熟悉的聊天软件里相处'), element('p', {}, '把 QQ、微信的私聊或群聊接到这里。相续仍是同一个持续成长的人格，自己判断关注、回应、主动和休息。')))));
  const parseIds = input => [...new Set(input.value.split(/[\s,，;；]+/u).map(value => value.trim()).filter(Boolean))];
  async function copyField(input, message) {
    try { await navigator.clipboard.writeText(input.value); toast(message); }
    catch { input.select(); toast('请复制已选中的内容。'); }
  }
  for (const id of ['qq', 'wechat']) {
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
      const patch = { apiUrl: apiUrl.input.value.trim(), accountId: account.input.value.trim(), allowedPrivateIds: parseIds(privateIds.input), allowedGroupIds: parseIds(groupIds.input), voiceMode: voiceMode.input.value };
      if (accessToken.input.value) patch.accessToken = accessToken.input.value;
      if (clearAccessToken.checked) patch.clearAccessToken = true;
      await request('channels.configure', { id, config: patch }); accessToken.input.value = ''; toast(title + '接入设置已保存。'); await renderPage();
    }, 'primary');
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
    container.append(card(title, isWechat ? '需要你准备兼容 OneBot 12 的本地桥；微信官方接口不等于已具备普通群聊能力。' : '通过 NapCat 等兼容 OneBot 11 的本地桥接入 QQ 私聊与群聊。',
      element('div', { class: 'row-actions channel-status' }, statusBadge, tag(connection.protocol ?? (isWechat ? 'OneBot 12' : 'OneBot 11'))),
      connection.error ? notice(connection.error.message ?? String(connection.error), 'error') : null,
      capabilityTags, element('div', { class: 'form-grid' }, apiUrl.wrapper, account.wrapper), accessToken.wrapper,
      connection.hasAccessToken ? element('label', { class: 'field-checkbox' }, clearAccessToken, '明确清除已保存的 API 令牌') : null,
      element('div', { class: 'form-grid' }, privateIds.wrapper, groupIds.wrapper),
      element('p', { class: 'subtle-note' }, '这些列表只确定哪些对象和群接入人格；接入之后，是否回应、关注谁和怎样相处仍由人格自己判断。'),
      element('div', { class: 'channel-details' }, voiceMode.wrapper), controls, element('hr', { class: 'divider' }), bridgeDetails, excludedInfo));
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
  container.append(card('后续扩展', '本轮提供 QQ、微信的渠道适配入口。', element('div', { class: 'row-actions' }, tag('Telegram：预留接口'), tag('个人网页：预留接口')), element('p', { class: 'subtle-note' }, '预留接口不会自动开启服务，也不表示已经连接对应平台。')));
  return container;
}

async function maintenancePage() {
  const container = element('div'), resultArea = element('div'), root = state.status.memoryRoot ?? state.instances.find(item => item.id === state.instanceId)?.memoryRoot;
  async function maintenance(action, args, title, description, danger = false) {
    const confirmation = await confirmOperation({ title, description, preview: { instanceId: state.instanceId, memoryRoot: root, ...args }, danger, accept: title }); if (!confirmation) return;
    const result = await request('maintenance.' + action, args); replace(resultArea, card('维护操作结果', '以下是本次真实返回值，失败与结果未知不会显示为完成。', result?.requiresLoad ? notice('操作后实例保持停用。核对结果后，前往“设置与加载”明确加载；加载时才恢复持久调度。', 'warning') : null, data(result))); toast('维护请求已返回。');
    state.status = await request('status'); const instanceResult = await request('instances.list', { instanceId: undefined }); state.instances = instanceItems(instanceResult); updateInstanceBar();
  }
  const destination = field('backup-destination', '备份目标绝对目录', '', { placeholder: 'C:\\Users\\...\\backup\\persona-data-latest' });
  const source = field('restore-source', '已校验备份的绝对目录', '', { placeholder: 'C:\\Users\\...\\backup\\persona-data-latest' });
  container.append(notice('维护使用现有单写者与恢复流程。需要停机的操作由服务端明确检查，活动实例不会被第二个写者绕过；备份不是无限历史。'), element('div', { class: 'maintenance-grid' },
    card('数据校验', '检查实际目录的格式、文件与可用恢复状态。', element('p', { class: 'small muted' }, '校验不会把不兼容版本猜测转换成当前格式。'), button('校验当前实例', () => maintenance('validate', {}, '开始校验', '只校验当前实例。活动写者会先安全停用，校验后恢复此前加载状态；正在对话或整理时拒绝切换。'), 'secondary')),
    card('创建备份', '使用受控目录和校验清单保存可恢复副本。', destination.wrapper, button('创建备份', () => { if (!destination.input.value.trim()) throw new Error('请填写备份目标绝对目录。'); return maintenance('backup', { destination: destination.input.value.trim() }, '创建备份', '复制当前所选实例的可恢复数据并校验 SHA。活动写者会安全停用并在完成后恢复；不覆盖未知的外部目录。'); }, 'secondary')),
    card('从备份恢复', '恢复会替换当前实例数据，请先核对目录。', source.wrapper, notice('已有较新的明确撤销仍需保持有效。恢复旧备份不能复活已明确遗忘的材料。', 'warning'), button('校验并恢复', () => { if (!source.input.value.trim()) throw new Error('请填写备份来源绝对目录。'); return maintenance('restore', { source: source.input.value.trim() }, '确认恢复备份', '安全停用后校验版本、路径、容量与 SHA，再恢复所选实例。此操作会替换数据；完成后保持停用，需你明确加载。', true); }, 'danger')),
    card('恢复中断与来源缺口', '区分目录切换中断和宿主原件缺失。', element('div', { class: 'row-actions' }, button('恢复中断的目录切换', () => maintenance('recover', {}, '执行恢复检查', '处理本实例已有的恢复 journal；不会为未知格式删库重建。'), 'secondary'), button('回补可用来源', () => control('backfill'), 'secondary')))), resultArea);
  const kind = field('diagnostic-kind', '诊断类型', 'errors', { choices: [['errors', '运行错误'], ['gaps', '来源缺口'], ['usage', '实际用量'], ['outbox', '交付回执'], ['snapshots', '请求快照']] }), list = element('div'); let pageNumber = 1, listGeneration = 0;
  async function load(cursor) { const generation = ++listGeneration; pageNumber = cursor ? pageNumber + 1 : 1; const result = await request('diagnostics.list', { kind: kind.input.value, pageSize: 10, ...(cursor ? { cursor } : {}) }); if (generation !== listGeneration) return; replace(list, getItems(result).length ? element('div', { class: 'record-list' }, getItems(result).map(item => element('article', { class: 'record' }, data(item)))) : empty('当前没有可用诊断', '用量缺失表示未知，不计作零；受保留容量限制，诊断不会无限积累。'), paginator(result, load, { pageNumber })); }
  kind.input.addEventListener('change', () => load().catch(showError));
  if (state.status.available) { await load(); container.append(card('真实诊断', '仅查看已保留数据，不因打开面板调用模型。', element('div', { class: 'toolbar' }, kind.wrapper, button('刷新诊断', () => load(), 'secondary')), list)); }
  return container;
}
$('close-detail').addEventListener('click', () => { state.detailGeneration++; $('detail-dialog').close(); });
$('confirm-accept').addEventListener('click', () => $('confirm-dialog').close('confirm'));
$('confirm-cancel').addEventListener('click', () => $('confirm-dialog').close('cancel'));
$('confirm-close').addEventListener('click', () => $('confirm-dialog').close('cancel'));
$('detail-dialog').addEventListener('cancel', () => { state.detailGeneration++; });
$('refresh-button').addEventListener('click', () => { if (state.connected) renderPage().catch(showError); else connect(); });
$('active-instance').addEventListener('change', async event => { state.instanceId = event.target.value; try { state.status = await request('status'); state.people = state.status.available ? getItems(await request('people.list', { pageSize: 100 })) : []; await renderPage(); } catch (error) { showError(error); } });
$('connect-retry').addEventListener('click', connect);
$('theme-choice').addEventListener('change', async event => { const theme = event.target.value; applyTheme(theme); try { const result = await request('ui.theme.set', { theme }); if (result.persisted === false) toast('外观已切换；当前环境无法保存，下次打开会跟随系统。'); } catch { try { localStorage.setItem('xiangxu.theme', theme); } catch { toast('外观已切换；当前环境无法保存。'); } } });
document.querySelectorAll('[data-page]').forEach(node => node.addEventListener('click', event => { event.preventDefault(); navigate(node.dataset.page).catch(showError); }));
window.addEventListener('persona-bridge-ready', () => { if (!state.connected) connect(); });
connect();
