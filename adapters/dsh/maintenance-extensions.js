import { createHash } from 'node:crypto';
import { QQ_ACCOUNT_LIMITS as A } from './connections/qq-account.js';
import { SOCIAL_PROVIDER_LIMITS as S } from './channels/social-provider.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw Object.assign(new Error('扩展档案的路径、结构或校验信息无效'), { code: 'INVALID_EXTENSION' }); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const id = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max;
const ref = (value, kind) => typeof value === 'string' && new RegExp('^qq' + kind + '_[a-f0-9]{32}$').test(value);
const receiptId = value => typeof value === 'string' && /^qqop-[a-f0-9]{32}$/.test(value);
const statuses = ['prepared','unknown','submitted','accepted','failed','unsupported'];
const bounded = (value, max) => { if (Buffer.byteLength(JSON.stringify(value) + '\n') > max) fail(); };
function source(value) {
  if (!object(value) || value.sourceKind !== 'qq-account-operation' || value.humanDialogue !== false || value.bindingCreated !== false || value.sourceSessionId !== null && !text(value.sourceSessionId) || !Array.isArray(value.sourceRefs) || value.sourceRefs.length > 64 || !Array.isArray(value.sourceRecordIds) || value.sourceRecordIds.length > 128 || value.sourceRecordIds.some(item => !text(item))) fail();
}
function queryResponse(value) {
  if (!object(value) || !id(value.accountId) || !id(value.userId) || !text(value.bootId,160) || !ref(value.optionsRef,'opts') || !ref(value.targetRef,'target') || !integer(value.expiresAt) || !['friend','not_friend'].includes(value.relationship) || !object(value.requirements) || typeof value.requirements.supported !== 'boolean' || typeof value.requirements.verificationText !== 'boolean' || !integer(value.requirements.questionCount) || value.requirements.questionCount > 16) fail();
}
function accountDocument(relative, value) {
  if (!object(value) || value.schemaVersion !== 'xiangxu-qq-account/1') fail();
  bounded(value, relative === 'index.json' ? A.indexBytes : A.recordBytes);
  if (relative === 'index.json') {
    if (!text(value.instanceId) || !integer(value.revision) || !Array.isArray(value.receipts) || value.receipts.length > A.receipts || !Array.isArray(value.queries) || value.queries.length > A.queries) fail();
    const ids = new Set();
    for (const row of value.receipts) { if (!object(row) || !receiptId(row.receiptId) || ids.has(row.receiptId) || !id(row.accountId) || !id(row.userId) || !statuses.includes(row.status) || !integer(row.revisions) || row.revisions > A.revisionsPerReceipt || !integer(row.createdAt) || !integer(row.updatedAt)) fail(); ids.add(row.receiptId); }
    for (const row of value.queries) { if (!object(row) || !/^qqquery-[a-f0-9]{32}$/.test(row.queryId) || ids.has(row.queryId) || !id(row.accountId) || !id(row.userId) || !ref(row.optionsRef,'opts') || !ref(row.targetRef,'target') || !text(row.bootId,160) || !integer(row.expiresAt) || !integer(row.createdAt)) fail(); ids.add(row.queryId); }
    return;
  }
  if (/^queries\/qqquery-[a-f0-9]{32}\.json$/.test(relative)) {
    if (!text(value.instanceId) || !id(value.accountId) || !integer(value.receivedAt)) fail(); queryResponse(value.response); if (value.accountId !== value.response.accountId) fail(); return;
  }
  const match = /^receipts\/(qqop-[a-f0-9]{32})\/(\d{6})\.json$/.exec(relative);
  if (!match || Number(match[2]) > A.revisionsPerReceipt || value.receiptId !== match[1]) fail();
  if (match[2] === '000000') {
    if (!text(value.instanceId) || !id(value.accountId) || !text(value.operationId,160) || !object(value.request) || value.request.accountId !== value.accountId || !id(value.request.userId) || !ref(value.request.optionsRef,'opts') || !ref(value.request.targetRef,'target') || typeof value.request.text !== 'string' || [...value.request.text].length > 512 || !object(value.runtime) || value.runtime.protocol !== 'xiangxu-qq-native/1' || !text(value.runtime.bootId,160) || !text(value.runtime.abiVersion,128) || !integer(value.createdAt) || value.status !== 'prepared' || value.nativeCalls !== null || value.nativeCallUpperBound !== 1) fail(); source(value.source); queryResponse(value.query); return;
  }
  if (value.revision !== Number(match[2]) || !text(value.event,160) || !statuses.includes(value.status) || !integer(value.at)) fail();
}
function links(value) {
  if (!Array.isArray(value.sourceRefs) || value.sourceRefs.length > S.sourceRefs || value.sourceRefs.some(ref => !object(ref) || !text(ref.sourceSessionId) || !text(ref.sourceEventId)) || !Array.isArray(value.sourceRecordIds) || value.sourceRecordIds.length > S.sourceRecordIds || value.sourceRecordIds.some(item => !text(item))) fail();
}
function socialDocument(value) {
  if (!object(value) || value.schemaVersion !== 'xiangxu-social-provider-state/1' || !integer(value.version) || !Array.isArray(value.jobs) || value.jobs.length > S.jobs || !Array.isArray(value.assets) || value.assets.length > S.assets || !Array.isArray(value.pendingDeletes) || value.pendingDeletes.length > S.assets || !Array.isArray(value.revokedSourceKeys) || value.revokedSourceKeys.length > 8192 || value.revokedSourceKeys.some(key => typeof key !== 'string' || key.length > 2048) || !Array.isArray(value.revokedRecordIds) || value.revokedRecordIds.length > 16384 || value.revokedRecordIds.some(key => typeof key !== 'string' || key.length > 256)) fail(); bounded(value,S.stateBytes);
  const jobs = new Set(),requests = new Set(),assetId = /^cover-[a-f0-9]{32}$/;
  for (const job of value.jobs) {
    if (!object(job) || !/^social-[a-f0-9]{32}$/.test(job.jobId) || jobs.has(job.jobId) || typeof job.requestId !== 'string' || job.requestId.length > 160 || requests.has(job.requestId) || !/^[a-f0-9]{64}$/.test(job.requestHash) || !/^[a-f0-9]{64}$/.test(job.configFingerprint) || !['feed','cover'].includes(job.kind) || !(job.kind === 'cover' ? job.capability === 'media.cover' : ['feed.read','feed.publish','feed.react'].includes(job.capability)) || !['prepared','running','submitted','completed','failed','unknown','cancelled','revoked'].includes(job.status) || !Array.isArray(job.resultAssetIds) || job.resultAssetIds.length > 1 || job.resultAssetIds.some(id => !assetId.test(id)) || !integer(job.createdAt) || !integer(job.updatedAt) || job.remoteJobId !== null && (typeof job.remoteJobId !== 'string' || job.remoteJobId.length > 256)) fail(); links(job); jobs.add(job.jobId); requests.add(job.requestId);
  }
  const ids = new Set(); for (const asset of [...value.assets,...value.pendingDeletes]) {
    if (!object(asset) || !assetId.test(asset.assetId) || asset.assetId !== 'cover-' + asset.sha256?.slice(0,32) || !/^[a-f0-9]{64}$/.test(asset.sha256) || asset.filename !== asset.assetId + '.' + ({'audio/wav':'wav','audio/flac':'flac','audio/ogg':'ogg','audio/mpeg':'mp3'}[asset.mime]) || !integer(asset.bytes) || asset.bytes < 1 || asset.bytes > S.audioBytes || !Array.isArray(asset.provenance) || !asset.provenance.length || asset.provenance.length > S.provenance) fail(); asset.provenance.forEach(links); if (value.assets.includes(asset)) { if (ids.has(asset.assetId)) fail(); ids.add(asset.assetId); }
  }
}
/** Adapter-only extension admission; unknown paths never inherit a known schema's permission. */
export function validateDshMaintenanceExtension({ path, value, kind = 'content' } = {}) {
  if (kind === 'writerLock') {
    if (!['extensions/qq-account/writer.lock','extensions/qq-social/state.json.writer.lock'].includes(path)) return false;
    if (!object(value) || !Number.isSafeInteger(value.pid) || value.pid < 1 || !text(path.endsWith('/writer.lock') ? value.token : value.owner,160)) fail(); return true;
  }
  if (kind !== 'content') return false;
  if (path === 'extensions/qq-social/state.json') { socialDocument(value); return true; }
  const prefix = 'extensions/qq-account/'; if (!path.startsWith(prefix)) return false; const relative = path.slice(prefix.length);
  if (/^\.wal\/[a-f0-9]{64}\.json$/.test(relative)) {
    bounded(value,4194304); if (!object(value) || !text(value.runId,4096) || !['prepared','committed'].includes(value.state) || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > A.revisionsPerReceipt + 3 || relative !== '.wal/' + createHash('sha256').update(value.runId).digest('hex') + '.json') fail(); if (value.digest !== createHash('sha256').update(JSON.stringify(value.entries)).digest('hex')) throw Object.assign(new Error('Extension WAL checksum mismatch'), { code: 'CORRUPT_WAL' }); const paths = new Set();
    for (const entry of value.entries) { if (!object(entry) || typeof entry.path !== 'string' || paths.has(entry.path) || typeof entry.text !== 'string') fail(); paths.add(entry.path); accountDocument(entry.path,JSON.parse(entry.text)); } return true;
  }
  accountDocument(relative,value); return true;
}
