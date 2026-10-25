import { createSpeechController } from './speech.js';

const $ = id => document.getElementById(id);
const AUTH_KEY = 'xiangxu.chat.device', THEME_KEY = 'xiangxu.chat.theme';
const storeRead = name => { try { return JSON.parse(window[name].getItem(AUTH_KEY) || 'null'); } catch { return null; } };
const initialAuth = storeRead('sessionStorage') ?? storeRead('localStorage');
let auth = initialAuth && typeof initialAuth.deviceToken === 'string' ? initialAuth : null;
let pairToken = new URLSearchParams(location.hash.slice(1)).get('pair');
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
const state = { connected: false, after: null, cursor: null, timer: null, polling: false, failures: 0, stopped: false, initialSync: true,
  pending: null, lastAcceptedId: null, messages: new Map(), earlierBefore: null, historyBefore: null, historyCursor: null, historyMode: false, historyReading: false, longPaused: false, longCheckpoint: 0, viewGeneration: 0,
  device: auth?.device ?? null, voice: null, catalog: null, voiceStatus: null, voiceProfileKey: null };
let speech, soundEnabled = false, speechQueue = [], speechAwaitingEnd = false, previousSpeechStatus = 'disabled';
const played = new Set();
const sleepText = { sleeping: '正在休息，消息会留给相续', thinking: '正在想一想', waiting: '正在听你说', ready: '已连接，可以慢慢聊' };
const speechText = { unsupported: '这台设备的浏览器暂无可用语音', disabled: '声音已关闭', ready: '声音已开启', no_permitted_voice: '这台设备暂无可用的本地音色', gesture_required: '请点一下“开启声音”再播放', voice_unavailable: '所选音色在这台设备上暂不可用', queued: '正在准备语音', speaking: '正在说话', error: '这次播放未完成，请点击播放重试', invalid_text: '这段内容暂时无法播放', closed: '语音已关闭' };
function node(tag, attrs = {}, ...children) {
  const result = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === 'class') result.className = value;
    else if (key.startsWith('on')) result.addEventListener(key.slice(2), value);
    else if (key in result) result[key] = value;
    else result.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child != null) result.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return result;
}
function messageError(error) { return error?.message ?? '连接暂时没有回应，请稍后再试。'; }
function feedback(id, text, error = false) { $(id).textContent = text; $(id).classList.toggle('error', error); }
function notice(text, action = null) {
  const area = $('connection-notice'); area.hidden = !text;
  area.replaceChildren(node('span', {}, text));
  if (action) area.append(node('button', { class: 'quiet-button', type: 'button', onclick: action.run }, action.label));
}
function clearAuth() {
  auth = null; state.connected = false; state.stopped = true; clearTimeout(state.timer); stopSpeech();
  state.pending = null; $('message-input').readOnly = false;
  try { sessionStorage.removeItem(AUTH_KEY); localStorage.removeItem(AUTH_KEY); } catch {}
  $('conversation').hidden = true; $('composer-area').hidden = true; $('pair-screen').hidden = false;
  $('pair-options').hidden = true; $('connection-state').textContent = '尚未连接';
}
function keepAuth(value, remember) {
  auth = value; let stored = true;
  try { sessionStorage.setItem(AUTH_KEY, JSON.stringify(value)); if (remember) localStorage.setItem(AUTH_KEY, JSON.stringify(value)); else localStorage.removeItem(AUTH_KEY); }
  catch { stored = false; }
  return stored;
}
async function api(path, { method = 'GET', body, authenticated = true } = {}) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(authenticated && auth ? { authorization: 'Bearer ' + auth.deviceToken } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, credentials: 'omit', mode: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' });
    let value; try { value = await response.json(); } catch { throw new Error('聊天入口返回了无法读取的内容。'); }
    if (!response.ok || value?.ok === false) {
      const error = Object.assign(new Error(value?.error?.message || '这次请求没有完成。'), { code: value?.error?.code, status: response.status });
      if (authenticated && [401, 403].includes(response.status)) { clearAuth(); feedback('pair-feedback', '设备连接已失效，请从电脑重新生成连接码。', true); }
      throw error;
    }
    return value;
  } finally { clearTimeout(timeout); }
}
function applyTheme(value) {
  const theme = ['system', 'light', 'dark'].includes(value) ? value : 'system';
  if (theme === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
  $('theme-choice').value = theme;
}
try { applyTheme(localStorage.getItem(THEME_KEY)); } catch { applyTheme('system'); }
function setVoice(value) {
  if (!value || typeof value !== 'object') return;
  const key = JSON.stringify([value.mode, value.allowRemoteVoices, value.userSelection, value.personaSelection]);
  if (key !== state.voiceProfileKey) { stopSpeech(); state.voiceProfileKey = key; }
  state.voice = value; speech?.setPreferences(value); renderVoice();
}
function showState(value) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.displayName === 'string') $('persona-name').textContent = value.displayName;
  const waiting = value.sleep?.state === 'sleeping' ? 'sleeping' : value.waiting ?? 'ready';
  $('connection-state').textContent = sleepText[waiting] ?? '已连接';
  $('waiting-state').textContent = waiting === 'thinking' ? '相续正在想一想…' : waiting === 'sleeping' ? '相续正在休息。你可以继续留言。' : waiting === 'waiting' ? '相续正在听。' : '';
  $('wake-button').hidden = waiting !== 'sleeping';
  if (value.voice) setVoice(value.voice);
}
function setConnected(value) {
  state.connected = value;
  $('pair-screen').hidden = value; $('conversation').hidden = !value; $('composer-area').hidden = !value;
  if (value) { $('device-name').textContent = state.device?.label ?? '当前设备'; $('send-button').disabled = false; }
}
function stopSpeech() { speechQueue = []; speechAwaitingEnd = false; speech?.stop(); }
function nextSpeech() {
  if (!speechQueue.length || !soundEnabled) return;
  speechAwaitingEnd = false;
  const chunk = speechQueue.shift(), result = speech.speak(chunk.text, { id: chunk.id });
  if (result.ok) speechAwaitingEnd = true;
  else { speechQueue = []; feedback('voice-feedback', speechText[result.reason] ?? '语音暂时不可用。', true); }
}
function playText(text, id) {
  stopSpeech();
  const enabled = speech.enableFromGesture();
  if (!enabled.ok) { feedback('voice-feedback', speechText[enabled.reason] ?? '语音暂时不可用。', true); $('settings-dialog').showModal(); return false; }
  soundEnabled = true; updateSoundButton();
  const points = Array.from(text);
  for (let offset = 0; offset < points.length; offset += 16000) speechQueue.push({ text: points.slice(offset, offset + 16000).join(''), id: id + ':' + offset });
  nextSpeech(); return true;
}
function queueSpeech(text, id) {
  const points = Array.from(text), queuedChars = speechQueue.reduce((total, item) => total + item.text.length, 0);
  if (points.length + queuedChars > 128000) { notice('待播放内容较多，这条回复可以稍后点击“播放”收听。'); return; }
  for (let offset = 0; offset < points.length; offset += 16000) speechQueue.push({ text: points.slice(offset, offset + 16000).join(''), id: id + ':' + offset });
  if (!speechAwaitingEnd) nextSpeech();
}
function updateSoundButton() { $('sound-enable').textContent = soundEnabled ? '关闭声音' : '开启声音'; }
function renderSpeechStatus(value) {
  state.voiceStatus = value;
  $('speech-state').textContent = speechText[value.status] ?? '语音状态未知';
  $('voice-preview').disabled = !value.supported;
  if (value.status === 'error') notice('浏览器没有完成语音播放，可以点消息旁的“播放”再试。');
  const previous = previousSpeechStatus; previousSpeechStatus = value.status;
  if (speechAwaitingEnd && value.status === 'ready' && ['speaking', 'queued'].includes(previous)) { speechAwaitingEnd = false; nextSpeech(); }
}
function renderVoice() {
  const value = state.voice, catalog = state.catalog?.voices ?? [];
  if (!value) return;
  $('voice-mode').value = value.mode ?? 'persona'; $('remote-voices').checked = value.allowRemoteVoices === true;
  $('voice-rate').value = value.userSelection?.rate ?? 1; $('voice-pitch').value = value.userSelection?.pitch ?? 1;
  const choice = $('voice-choice'), allowed = catalog.filter(voice => voice.localService || value.allowRemoteVoices);
  choice.replaceChildren(node('option', { value: '' }, '设备默认声音'), ...allowed.map(voice => node('option', { value: voice.id }, voice.name + (voice.lang ? ' · ' + voice.lang : '') + (voice.localService ? ' · 本地' : ' · 网络'))));
  const selected = value.userSelection?.voiceId;
  if (selected && !allowed.some(voice => voice.id === selected)) choice.append(node('option', { value: selected }, '已选音色（当前不可用）'));
  choice.value = selected ?? '';
  const personaVoice = catalog.find(voice => voice.id === value.personaSelection?.voiceId);
  $('persona-voice-note').textContent = value.mode === 'persona'
    ? personaVoice ? '相续当前选择：' + personaVoice.name : value.personaSelection?.voiceId ? '相续选择的音色在当前设备上暂不可用。' : '相续尚未指定音色，目前使用设备可用的默认声音。'
    : '当前按你的选择播放；相续的自主音色偏好仍保留。';
  $('user-voice-fields').hidden = value.mode !== 'user';
}
async function registerCatalog(catalog = speech.getCatalog()) {
  state.catalog = catalog;
  if (!auth || !state.connected) return;
  try { const value = await api('/api/voice/catalog', { method: 'POST', body: catalog }); setVoice(value); }
  catch (error) { feedback('voice-feedback', messageError(error), true); }
}
speech = createSpeechController({ scope: window, onState: renderSpeechStatus, onCatalog: catalog => { state.catalog = catalog; if (state.connected) registerCatalog(catalog); } });
function appendMessage(value, historical = false) {
  if (!value || !['user', 'assistant'].includes(value.role) || typeof value.id !== 'string' || typeof value.text !== 'string' || !Number.isSafeInteger(value.seq)) throw new Error('聊天记录格式暂时无法读取。');
  let item = state.messages.get(value.id), complete = value.fragment?.complete !== false;
  if (!item) {
    const text = node('div', { class: 'bubble' }), time = node('time'), extra = node('span', { class: 'fragment-note' }), body = node('div', { class: 'message-body' }, text), meta = node('div', { class: 'message-meta' }, time, extra);
    const play = value.role === 'assistant' ? node('button', { type: 'button', class: 'play-message', onclick: () => { const current = state.messages.get(value.id); if (current?.complete) playText(current.text, current.id); } }, '▷ 播放') : null;
    if (play) meta.append(play); body.append(meta);
    const row = node('article', { class: 'message ' + value.role }, value.role === 'assistant' ? node('span', { class: 'message-avatar', 'aria-hidden': true }, '续') : null, body);
    item = { id: value.id, seq: value.seq, role: value.role, text: '', textFrom: 0, readTo: 0, row, textNode: text, time, extra, play, complete: false };
    const next = [...state.messages.values()].sort((a, b) => a.seq - b.seq).find(existing => existing.seq > value.seq);
    state.messages.set(value.id, item); $('messages').insertBefore(row, next?.row ?? null);
  }
  if (value.fragment) {
    const fragment = value.fragment;
    if (fragment.from === 0) { item.text = value.text; item.textFrom = 0; }
    else if (fragment.from === item.readTo) item.text += value.text;
    else throw Object.assign(new Error('一条长消息的读取位置已变化，请重新读取记录。'), { code: 'MOBILE_CURSOR_INVALID' });
    item.readTo = fragment.to;
    const points = Array.from(item.text); if (points.length > 64000) { item.text = points.slice(-64000).join(''); item.textFrom = item.readTo - 64000; }
    item.extra.textContent = item.textFrom > 0 ? `当前显示第 ${item.textFrom + 1}–${item.readTo} / ${fragment.total} 字；先前片段保留在原会话` : complete ? '' : `已读取 ${item.readTo} / ${fragment.total} 字`;
  } else { item.text = value.text; item.readTo = Array.from(value.text).length; }
  item.complete = complete; item.textNode.textContent = item.text;
  if (item.play) { item.play.hidden = !complete; item.play.textContent = item.textFrom > 0 ? '▷ 播放当前片段' : '▷ 播放'; }
  if (typeof value.at === 'number' && Number.isFinite(value.at)) { item.time.dateTime = new Date(value.at).toISOString(); item.time.textContent = new Date(value.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }); }
  if (!historical && !state.initialSync && complete && value.role === 'assistant' && soundEnabled && $('auto-read').checked && !played.has(value.id)) {
    played.add(value.id); while (played.size > 256) played.delete(played.values().next().value);
    queueSpeech(item.text, item.id);
  }
  while (state.messages.size > 200) {
    const sorted = [...state.messages.values()].sort((a, b) => a.seq - b.seq), first = state.historyMode ? sorted.at(-1) : sorted[0]; if (!first.complete) break;
    first.row.remove(); state.messages.delete(first.id); $('history-note').textContent = '这个窗口显示最近 200 条消息。'; $('history-note').hidden = false;
  }
  if (state.lastAcceptedId === value.id && value.role === 'user') { $('send-receipt').hidden = true; state.lastAcceptedId = null; }
}
function schedulePoll(delay = 1600) { clearTimeout(state.timer); if (!state.stopped && auth) state.timer = setTimeout(poll, document.hidden ? Math.max(delay, 15000) : delay); }
function historyControls() {
  $('history-earlier').hidden = !(state.historyCursor || state.historyBefore != null || !state.historyMode && state.earlierBefore != null);
  $('history-earlier').textContent = state.historyCursor ? '继续读取这页记录' : '更早记录';
  $('history-latest').hidden = !state.historyMode && !state.longPaused;
  $('long-read-note').hidden = !state.longPaused;
}
function checkLongPause(result) {
  const last = result.messages.at(-1), current = last ? state.messages.get(last.id) : null;
  if (result.nextCursor && current && !current.complete && current.readTo - state.longCheckpoint >= 64000) state.longPaused = true;
  if (!result.nextCursor || last?.fragment?.complete) state.longCheckpoint = 0;
  historyControls();
}
async function latest() {
  state.viewGeneration++; state.earlierBefore = null;
  state.historyMode = false; state.historyCursor = null; state.historyBefore = null; state.longPaused = false; state.longCheckpoint = 0;
  state.after = null; state.cursor = null; state.initialSync = true; state.messages.clear(); $('messages').replaceChildren();
  $('history-note').hidden = true; historyControls(); state.stopped = false; schedulePoll(20);
}
async function earlier() {
  if (state.historyReading || state.longPaused) return;
  const before = state.historyBefore ?? state.earlierBefore;
  if (!state.historyCursor && before == null) return;
  if (!state.historyMode) state.viewGeneration++;
  const generation = state.viewGeneration;
  state.historyReading = true; $('history-earlier').disabled = true; state.historyMode = true;
  try {
    const query = state.historyCursor ? '?cursor=' + encodeURIComponent(state.historyCursor) + '&limit=60' : '?before=' + before + '&limit=60';
    const result = await api('/api/messages' + query);
    if (generation !== state.viewGeneration) return;
    if (!Array.isArray(result.messages)) throw new Error('暂时无法读取较早记录。');
    for (const value of result.messages) appendMessage(value, true);
    state.historyCursor = result.nextCursor ?? null; state.historyBefore = result.previousBefore ?? null;
    showState(result.state); checkLongPause(result);
    $('history-note').textContent = '正在浏览较早记录。回到最近聊天后继续接收新消息；主机原记录不受窗口折叠影响。'; $('history-note').hidden = false;
  } catch (error) { notice(messageError(error)); }
  finally { state.historyReading = false; $('history-earlier').disabled = false; historyControls(); }
}
async function poll() {
  if (state.polling || state.stopped || !auth) return;
  state.polling = true;
  const generation = state.viewGeneration;
  const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
  try {
    if (state.historyMode || state.longPaused) { showState(await api('/api/state')); schedulePoll(2500); return; }
    const query = state.cursor ? '?cursor=' + encodeURIComponent(state.cursor) + '&limit=60' : (state.after == null ? '?limit=60' : '?after=' + state.after + '&limit=60');
    const result = await api('/api/messages' + query);
    if (generation !== state.viewGeneration) { schedulePoll(20); return; }
    if (!Array.isArray(result.messages) || !Number.isSafeInteger(result.nextAfter)) throw new Error('暂时无法读取聊天记录。');
    for (const value of result.messages) appendMessage(value);
    state.cursor = result.nextCursor ?? null; state.after = result.nextAfter;
    if (result.earlierBefore != null && state.earlierBefore == null) state.earlierBefore = result.earlierBefore;
    checkLongPause(result);
    if (!state.connected) setConnected(true);
    showState(result.state); state.failures = 0; notice('');
    if (!state.cursor && !result.hasMore) state.initialSync = false;
    if (nearBottom && result.messages.length) window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
    schedulePoll(state.cursor || result.hasMore ? 60 : 1600);
  } catch (error) {
    if (state.stopped) return;
    if (['MOBILE_HISTORY_GAP', 'MOBILE_CURSOR_INVALID'].includes(error.code)) {
      state.stopped = true;
      notice('聊天记录的读取位置已变化，已保留当前窗口内容。', { label: '重新读取', run: () => { state.after = null; state.cursor = null; state.initialSync = true; state.stopped = false; poll(); } });
    } else {
      state.failures++; $('connection-state').textContent = '连接暂时中断，正在重连';
      notice(state.failures < 3 ? '连接正在恢复，你写下的话仍留在输入框里。' : '暂时连接不上电脑，请确认 DSH 和聊天入口仍在运行。'); schedulePoll(Math.min(30000, 1800 * 2 ** Math.min(state.failures, 4)));
    }
  } finally { state.polling = false; }
}
async function connect() {
  if (!auth) return;
  state.stopped = false;
  try {
    const result = await api('/api/state'); state.device ??= auth.device; setConnected(true); showState(result);
    await registerCatalog(); await poll();
  } catch (error) {
    if (!state.stopped) { $('pair-screen').hidden = false; $('welcome-title').textContent = '正在找回连接'; feedback('pair-feedback', messageError(error), true); state.timer = setTimeout(connect, 6000); }
  }
}
function requestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'm-' + Date.now().toString(36) + '-' + Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join('');
}
function resizeComposer() { const input = $('message-input'); input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 180) + 'px'; }
function receipt(text, unknown = false) {
  $('send-receipt').hidden = false; $('send-receipt').classList.toggle('warning', unknown); $('receipt-text').textContent = text;
  $('receipt-query').hidden = !unknown; $('receipt-dismiss').hidden = !unknown;
  $('receipt-retry').hidden = true;
}
function acceptedReceipt(result) {
  state.lastAcceptedId = result.messageId ?? null; state.pending = null;
  $('message-input').value = ''; resizeComposer(); $('message-input').readOnly = false;
  receipt('消息已收到，正在同步到聊天记录。');
  if (state.lastAcceptedId && state.messages.has(state.lastAcceptedId)) { $('send-receipt').hidden = true; state.lastAcceptedId = null; }
  if (state.historyMode) latest(); else schedulePoll(20);
}
async function sendPending() {
  const pending = state.pending; if (!pending) return;
  $('send-button').disabled = true; $('message-input').readOnly = true; receipt('正在发送…');
  try {
    const result = await api('/api/send', { method: 'POST', body: { requestId: pending.requestId, text: pending.text, createdAt: pending.createdAt } });
    if (result.status === 'accepted') acceptedReceipt(result);
    else if (result.status === 'rejected') { state.pending = null; $('message-input').readOnly = false; receipt('这次消息没有被接收。原文仍留在输入框中。'); }
    else { pending.status = 'unknown'; receipt('发送结果暂时未知，先查询结果，不会自动重发。', true); }
  } catch (error) {
    pending.status = 'unknown'; receipt('发送结果暂时未知，原文已保留，不会自动重发。', true);
  } finally { $('send-button').disabled = !state.connected; }
}
$('composer').addEventListener('submit', event => {
  event.preventDefault(); const text = $('message-input').value;
  if (!state.connected || !text.trim() || state.pending) return;
  if (Array.from(text).length > 16000) { notice('单条消息最多 16,000 个字符，请分段发送。'); return; }
  state.pending = { requestId: requestId(), text, createdAt: Date.now(), status: 'sending' }; sendPending();
});
$('message-input').addEventListener('input', resizeComposer);
$('history-earlier').addEventListener('click', earlier);
$('history-latest').addEventListener('click', latest);
$('long-read-continue').addEventListener('click', () => {
  const last = [...state.messages.values()].filter(item => !item.complete).at(-1);
  state.longCheckpoint = last?.readTo ?? 0; state.longPaused = false; historyControls();
  if (state.historyMode) earlier(); else schedulePoll(20);
});
$('wake-button').addEventListener('click', async () => {
  $('wake-button').disabled = true;
  try { const result = await api('/api/wake', { method: 'POST', body: {} }); showState(result.state ?? result); notice('已送达这次唤醒请求。'); schedulePoll(20); }
  catch (error) { notice(messageError(error)); }
  finally { $('wake-button').disabled = false; }
});
$('message-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer:coarse)').matches) { event.preventDefault(); $('composer').requestSubmit(); } });
$('receipt-query').addEventListener('click', async () => {
  if (!state.pending) return;
  const pending = state.pending;
  $('receipt-query').disabled = true;
  try {
    const result = await api('/api/receipt?requestId=' + encodeURIComponent(pending.requestId));
    if (result.status === 'accepted') acceptedReceipt(result);
    else if (result.status === 'not_found') { receipt('暂未找到这次发送回执。可以继续查询，或明确重试这条消息。', true); $('receipt-retry').hidden = false; }
    else receipt('这次发送结果仍然未知。你可以继续查询或另写一条。', true);
  } catch (error) { receipt(messageError(error), true); }
  finally { $('receipt-query').disabled = false; }
});
$('receipt-dismiss').textContent = '另写一条';
$('receipt-dismiss').addEventListener('click', () => {
  if (state.pending) {
    if ($('unconfirmed-drafts').childElementCount >= 16) { receipt('当前保留了较多未确认原文。先保存并移除一些本地草稿，再继续输入。', true); return; }
    const draft = node('details', {}, node('summary', {}, '一条发送结果未确认的原文（保留在此窗口）'), node('p', {}, state.pending.text));
    draft.append(node('button', { type: 'button', class: 'quiet-button', onclick: () => { draft.remove(); $('unconfirmed-drafts').hidden = !$('unconfirmed-drafts').childElementCount; } }, '已另行保存，移除这份本地草稿'));
    $('unconfirmed-drafts').append(draft); $('unconfirmed-drafts').hidden = false;
  }
  state.pending = null; $('message-input').value = ''; $('message-input').readOnly = false; resizeComposer();
  receipt('上一条发送结果仍未知；稍后可刷新聊天记录确认。'); $('receipt-query').hidden = true; $('receipt-dismiss').hidden = true;
});
$('receipt-retry').addEventListener('click', sendPending);
$('pair-connect').addEventListener('click', async () => {
  if (!pairToken) return;
  $('pair-connect').disabled = true; feedback('pair-feedback', '正在连接…');
  try {
    const result = await api('/api/pair', { method: 'POST', authenticated: false, body: { token: pairToken, label: $('device-label').value.trim() || '我的手机' } });
    pairToken = null; state.device = result.device;
    const stored = keepAuth({ deviceToken: result.deviceToken, device: result.device }, $('remember-device').checked);
    if (!stored) notice('设备已连接；当前浏览器无法保存绑定，关闭页面后需要重新扫码。');
    state.after = null; state.cursor = null; state.initialSync = true; state.stopped = false; setConnected(true); showState(result.state); await registerCatalog(); await poll();
  } catch (error) { feedback('pair-feedback', messageError(error), true); }
  finally { $('pair-connect').disabled = false; }
});
$('settings-open').addEventListener('click', () => { renderVoice(); $('settings-dialog').showModal(); });
$('settings-close').addEventListener('click', () => $('settings-dialog').close());
$('sound-enable').addEventListener('click', () => {
  if (soundEnabled) { soundEnabled = false; stopSpeech(); speech.setPreferences({ enabled: false }); }
  else { const result = speech.enableFromGesture(); soundEnabled = result.ok; if (!result.ok) { feedback('voice-feedback', speechText[result.reason] ?? '声音暂时不可用。', true); $('settings-dialog').showModal(); } }
  updateSoundButton();
});
$('voice-preview').addEventListener('click', () => playText('你好，这是一段声音试听。', 'preview'));
$('voice-stop').addEventListener('click', stopSpeech);
$('voice-mode').addEventListener('change', () => { $('user-voice-fields').hidden = $('voice-mode').value !== 'user'; });
$('remote-voices').addEventListener('change', () => {
  const selected = $('voice-choice').value, allowed = state.catalog?.voices.filter(voice => voice.localService || $('remote-voices').checked) ?? [];
  $('voice-choice').replaceChildren(node('option', { value: '' }, '设备默认声音'), ...allowed.map(voice => node('option', { value: voice.id }, voice.name + ' · ' + voice.lang + (voice.localService ? ' · 本地' : ' · 网络'))));
  if (allowed.some(voice => voice.id === selected)) $('voice-choice').value = selected;
});
$('voice-save').addEventListener('click', async () => {
  $('voice-save').disabled = true;
  try {
    const rate = Number($('voice-rate').value), pitch = Number($('voice-pitch').value);
    if (!$('voice-rate').value || !Number.isFinite(rate) || rate < 0.1 || rate > 10 || !$('voice-pitch').value || !Number.isFinite(pitch) || pitch < 0 || pitch > 2) throw new Error('请输入有效语速与音高。');
    const result = await api('/api/voice/config', { method: 'POST', body: { mode: $('voice-mode').value, allowRemoteVoices: $('remote-voices').checked, userSelection: { voiceId: $('voice-choice').value || null, rate, pitch } } });
    setVoice(result); feedback('voice-feedback', '声音设置已保存。');
  } catch (error) { feedback('voice-feedback', messageError(error), true); }
  finally { $('voice-save').disabled = false; }
});
$('theme-choice').addEventListener('change', event => { applyTheme(event.target.value); try { localStorage.setItem(THEME_KEY, event.target.value); } catch {} });
$('disconnect-button').addEventListener('click', async () => {
  $('disconnect-button').disabled = true;
  try { await api('/api/disconnect', { method: 'POST', body: {} }); clearAuth(); $('settings-dialog').close(); feedback('pair-feedback', '已移除此设备。需要时可以重新扫码连接。'); }
  catch (error) { feedback('voice-feedback', messageError(error), true); }
  finally { $('disconnect-button').disabled = false; }
});
window.addEventListener('online', () => { if (auth && !state.stopped) schedulePoll(20); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && auth && !state.stopped) schedulePoll(20); });
window.addEventListener('pagehide', event => { state.stopped = true; clearTimeout(state.timer); soundEnabled = false; stopSpeech(); speech.setPreferences({ enabled: false }); updateSoundButton(); if (!event.persisted) speech.dispose(); });
window.addEventListener('pageshow', event => { if (event.persisted && auth) { state.stopped = false; connect(); } });
if (pairToken) { $('pair-screen').hidden = false; $('pair-options').hidden = false; $('connection-state').textContent = '等待设备配对'; }
else if (auth) connect();
else { $('pair-screen').hidden = false; $('connection-state').textContent = '尚未连接'; }
