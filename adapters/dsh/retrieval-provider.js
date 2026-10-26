import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicReplaceWithRetry } from '../../core/store.js';
import { readLimited } from './connections/common.js';

export const RETRIEVAL_PROVIDER_LIMITS = Object.freeze({ configBytes: 16384, responseBytes: 8388608, inputBytes: 1048576, batch: 64, dimensions: 4096 });
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const initial = () => ({ schemaVersion: 'xiangxu-retrieval-provider/1', version: 0, enabled: false, endpoint: '', model: '', apiKey: '' });
function validated(value) {
  if (!object(value) || value.schemaVersion !== 'xiangxu-retrieval-provider/1' || !Number.isSafeInteger(value.version) || value.version < 0 || typeof value.enabled !== 'boolean') fail('RETRIEVAL_PROVIDER_CONFIG', '向量服务配置无效');
  for (const [key, max] of [['endpoint', 2048], ['model', 256], ['apiKey', 4096]]) if (typeof value[key] !== 'string' || value[key].length > max || /[\u0000-\u001f\u007f]/.test(value[key])) fail('RETRIEVAL_PROVIDER_CONFIG', '向量服务字段无效');
  if (value.endpoint) {
    let url; try { url = new URL(value.endpoint); } catch { fail('RETRIEVAL_PROVIDER_CONFIG', '请填写完整的 embeddings 接口地址'); }
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.hash || url.search || !(url.protocol === 'https:' || local && url.protocol === 'http:')) fail('RETRIEVAL_PROVIDER_CONFIG', '远程向量接口需要 HTTPS；本机允许 HTTP，密钥请填专用字段');
  }
  if (value.enabled && (!value.endpoint || !value.model)) fail('RETRIEVAL_PROVIDER_CONFIG', '启用前请填写接口地址与真实向量模型名');
  return value;
}
async function safePath(file) {
  const full = path.resolve(file); let current = path.parse(full).root;
  for (const part of full.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) fail('RETRIEVAL_PROVIDER_PATH', '向量服务配置不能经过目录联接或符号链接'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return full;
}

/** Explicitly configured embeddings endpoint. Core receives only this service's
 * pure embed port; no chat model fallback or automatic whole-library upload. */
export function createRetrievalProvider({ file, repository, fetchImpl = fetch, storage } = {}) {
  if ((!file && !storage) || typeof repository?.setSemanticPort !== 'function') throw new TypeError('Retrieval provider needs storage and a repository port');
  let state = initial(), closed = false, tail = Promise.resolve(); const controllers = new Set();
  const read = storage?.read ?? (async () => {
    const full = await safePath(file); let handle;
    try { handle = await fs.open(full, 'r'); const stat = await handle.stat(); if (!stat.isFile() || stat.size > RETRIEVAL_PROVIDER_LIMITS.configBytes) fail('RETRIEVAL_PROVIDER_CAPACITY', '向量配置超过容量'); const bytes = Buffer.alloc(RETRIEVAL_PROVIDER_LIMITS.configBytes + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0); if (bytesRead > RETRIEVAL_PROVIDER_LIMITS.configBytes) fail('RETRIEVAL_PROVIDER_CAPACITY', '向量配置超过容量'); return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; } finally { await handle?.close(); }
  });
  const write = storage?.write ?? (async value => {
    const full = await safePath(file), bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'); if (bytes.length > RETRIEVAL_PROVIDER_LIMITS.configBytes) fail('RETRIEVAL_PROVIDER_CAPACITY', '向量配置超过容量');
    await fs.mkdir(path.dirname(full), { recursive: true }); await safePath(full + '.next'); const handle = await fs.open(full + '.next', 'w', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } await atomicReplaceWithRetry(full + '.next', full);
  });
  function port(config) {
    if (!config.enabled) return null;
    const id = createHash('sha256').update(config.endpoint + '\0' + config.model).digest('hex');
    return { id: 'embeddings-' + id, version: String(config.version), async embed({ texts, signal }) {
      if (closed) fail('RETRIEVAL_PROVIDER_CLOSED', '向量服务已关闭');
      if (!Array.isArray(texts) || !texts.length || texts.length > RETRIEVAL_PROVIDER_LIMITS.batch || texts.some(text => typeof text !== 'string' || !text || Array.from(text).length > 16000)) fail('RETRIEVAL_PROVIDER_INPUT', '向量输入超出单批技术容量');
      const body = JSON.stringify({ model: config.model, input: texts, encoding_format: 'float' }); if (Buffer.byteLength(body) > RETRIEVAL_PROVIDER_LIMITS.inputBytes) fail('RETRIEVAL_PROVIDER_INPUT', '向量输入超过 1MiB');
      const controller = new AbortController(); controllers.add(controller);
      try {
        const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(120000), ...(signal ? [signal] : [])]);
        const response = await fetchImpl(config.endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: 'Bearer ' + config.apiKey } : {}) }, body, signal: combined });
        if (!response.ok) { await response.body?.cancel?.(); fail('RETRIEVAL_PROVIDER_HTTP', '向量服务没有确认成功'); }
        let value; try { value = JSON.parse((await readLimited(response, RETRIEVAL_PROVIDER_LIMITS.responseBytes)).toString('utf8')); } catch { fail('RETRIEVAL_PROVIDER_RESPONSE', '向量服务响应无效或超过容量'); }
        if (!Array.isArray(value?.data) || value.data.length !== texts.length) fail('RETRIEVAL_PROVIDER_RESPONSE', '向量响应数量与输入不一致');
        const entries = [...value.data].sort((a, b) => a.index - b.index), vectors = [];
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index], vector = entry?.embedding;
          if (entry?.index !== index || !Array.isArray(vector) || !vector.length || vector.length > RETRIEVAL_PROVIDER_LIMITS.dimensions || vectors.length && vector.length !== vectors[0].length || vector.some(v => !Number.isFinite(v)) || !vector.some(v => v !== 0)) fail('RETRIEVAL_PROVIDER_RESPONSE', '向量维度、索引或数值无效');
          vectors.push(vector);
        }
        return { vectors };
      } catch (error) {
        if (/^RETRIEVAL_PROVIDER_/.test(error?.code ?? '')) throw error;
        fail('RETRIEVAL_PROVIDER_UNAVAILABLE', '向量请求未完成；没有重试或切换到聊天模型');
      } finally { controllers.delete(controller); }
    } };
  }
  const ready = (async () => { const saved = await read(); if (saved) state = validated(saved); await repository.setSemanticPort(port(state)); })();
  const queue = work => { const task = tail.then(async () => { await ready; if (closed) fail('RETRIEVAL_PROVIDER_CLOSED', '向量服务已关闭'); return work(); }); tail = task.catch(() => {}); return task; };
  const inspect = async () => { await ready; return { configured: Boolean(state.endpoint && state.model), enabled: state.enabled, version: state.version, endpoint: state.endpoint, model: state.model, hasApiKey: Boolean(state.apiKey), semanticSearchEnabled: repository.config?.retrieval?.semanticEnabled===true, limits: RETRIEVAL_PROVIDER_LIMITS, automaticIndexing: false }; };
  return { ready, inspect,
    configure(args = {}) { return queue(async () => {
      if (!object(args) || Object.keys(args).some(key => !['enabled', 'endpoint', 'model', 'apiKey', 'clearApiKey', 'expectedVersion'].includes(key))) fail('RETRIEVAL_PROVIDER_CONFIG', '未知向量配置字段');
      if(args.clearApiKey!==undefined&&typeof args.clearApiKey!=='boolean')fail('RETRIEVAL_PROVIDER_CONFIG','清除密钥标记必须为开关');
      if (args.expectedVersion !== state.version) fail('VERSION_CONFLICT', '向量配置已变化，请刷新后保存');
      const next = validated({ ...state, ...Object.fromEntries(['enabled', 'endpoint', 'model', 'apiKey'].filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]])), ...(args.clearApiKey === true ? { apiKey: '' } : {}), version: state.version + 1 });
      await write(next); state = next; await repository.setSemanticPort(port(next)); return inspect();
    }); },
    prepare(args = {}) { return queue(() => { if (!state.enabled) fail('RETRIEVAL_PROVIDER_DISABLED', '请先配置并开启向量服务'); return repository.prepareRetrievalIndex(args); }); },
    async close() { if (closed) return; closed = true; for (const controller of controllers) controller.abort(); await tail; await ready; await repository.setSemanticPort(null); },
  };
}
