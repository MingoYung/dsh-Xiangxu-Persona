import { createHash } from 'node:crypto';
import { mediaInfo } from '../media/io.js';

export const QQ_ACCOUNT_ACTION_LIMITS = Object.freeze({ imageBytes: 8388608, totalImageBytes: 16777216, images: 9, targets: 100, textChars: 16000, nicknameChars: 64, signatureChars: 512 });
export const QQ_ACCOUNT_ACTIONS = Object.freeze({ 'profile.avatar': 'profile.update', 'profile.update': 'profile.update', 'feed.publish': 'feed.publish' });
const L = QQ_ACCOUNT_ACTION_LIMITS, own = (v, k) => Object.hasOwn(v, k), fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const assetId = v => typeof v === 'string' && /^asset-[a-f0-9]{32}$/.test(v);
const qqId = v => typeof v === 'string' && /^[1-9]\d{0,15}$/.test(v) && Number.isSafeInteger(Number(v));
function text(v, max, empty = false) { if (typeof v !== 'string' || !empty && !v || [...v].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) fail('QQ_ACCOUNT_ARGUMENT', '账号操作内容无效或超过技术容量'); return v; }
export function normalizeQQAccountAction(input) {
  const operation = input.accountOperation, capability = Object.hasOwn(QQ_ACCOUNT_ACTIONS,operation) ? QQ_ACCOUNT_ACTIONS[operation] : null;
  if (!capability || !qqId(input.accountId)) fail('QQ_ACCOUNT_ARGUMENT', '账号操作或真实QQ账号无效');
  if (['path','url','file','bytes','images'].some(key => own(input, key))) fail('QQ_ACCOUNT_ARGUMENT', '账号图片操作只接受当前人格图库的资产编号');
  const request = { accountId: input.accountId };
  if (operation === 'profile.avatar') { if (!assetId(input.assetId)) fail('QQ_ACCOUNT_ARGUMENT', '请使用当前人格已保存的图片资产'); request.assetId = input.assetId; }
  if (operation === 'profile.update') {
    request.nickname = text(input.nickname, L.nicknameChars);
    if (own(input, 'signature')) request.signature = text(input.signature, L.signatureChars, true);
    if (own(input, 'sex')) { if (!['unknown','male','female'].includes(input.sex)) fail('QQ_ACCOUNT_ARGUMENT', 'QQ资料性别参数无效'); request.sex = input.sex; }
  }
  if (operation === 'feed.publish') {
    request.text = text(input.text ?? '', L.textChars, true); const images = input.imageAssetIds ?? [], targets = input.targetUserIds ?? [];
    if (!Array.isArray(images) || images.length > L.images || images.some(v => !assetId(v)) || new Set(images).size !== images.length || !request.text && !images.length) fail('QQ_ACCOUNT_ARGUMENT', 'QQ空间正文或图片资产列表无效');
    if (![1,4,16,64,128].includes(input.visibility) || !Array.isArray(targets) || targets.length > L.targets || targets.some(v => !qqId(v)) || new Set(targets).size !== targets.length || [16,128].includes(input.visibility) !== Boolean(targets.length)) fail('QQ_ACCOUNT_ARGUMENT', 'QQ空间可见范围与指定QQ对象不一致');
    Object.assign(request, { imageAssetIds: [...images], visibility: input.visibility, targetUserIds: [...targets] });
  }
  return { operation, capability, request };
}
export function validateQQAccountActionRequest(operation, request) {
  const normalized = normalizeQQAccountAction({ ...request, accountOperation: operation }).request;
  if (Object.keys(request).some(key => !own(normalized, key) && key !== 'assets')) fail('QQ_ACCOUNT_ARCHIVE_SCOPE', '账号操作档案包含未知参数');
  const expected = operation === 'profile.avatar' ? [request.assetId] : operation === 'feed.publish' ? request.imageAssetIds : [], assets = request.assets ?? [];
  if (!Array.isArray(assets) || assets.length !== expected.length || assets.some((v, i) => !v || v.assetId !== expected[i] || !/^([a-f0-9]{64})$/.test(v.sha256) || v.assetId !== 'asset-' + v.sha256.slice(0,32) || !Number.isSafeInteger(v.bytes) || v.bytes < 1 || v.bytes > L.imageBytes || !['image/png','image/jpeg','image/webp'].includes(v.mime)) || assets.reduce((n, v) => n + v.bytes, 0) > L.totalImageBytes) fail('QQ_ACCOUNT_ARCHIVE_SCOPE', '账号操作图片资料与请求不符');
  return true;
}
export async function prepareQQAccountAction(normalized, { readAsset, memoryRoot, signal, guard }) {
  const { operation, request } = normalized, ids = operation === 'profile.avatar' ? [request.assetId] : request.imageAssetIds ?? [], images = [], assets = []; let total = 0;
  if (ids.length && typeof readAsset !== 'function') fail('QQ_ACCOUNT_ASSET_UNAVAILABLE', '当前人格图片读取端口尚未就绪');
  for (const id of ids) {
    await guard(); const asset = await readAsset({ memoryRoot, assetId: id, signal }); await guard();
    if (!(asset?.bytes instanceof Uint8Array)) fail('QQ_ACCOUNT_ASSET_INVALID', '图片资产未提供可确认字节');
    total += asset.bytes.byteLength; if (!asset.bytes.byteLength || asset.bytes.byteLength > L.imageBytes || total > L.totalImageBytes) fail('QQ_ACCOUNT_CAPACITY', '账号图片超过本次传输技术容量'); const bytes = Buffer.from(asset.bytes);
    const info = mediaInfo(bytes, 'image'), sha256 = createHash('sha256').update(bytes).digest('hex');
    if (asset.mime !== info.mime || id !== 'asset-' + sha256.slice(0,32) || asset.asset?.assetId !== undefined && asset.asset.assetId !== id || asset.asset?.sha256 !== undefined && asset.asset.sha256 !== sha256) fail('QQ_ACCOUNT_ASSET_CHANGED', '当前人格图片与已保存资产身份不符');
    images.push({ bytes, mime: info.mime }); assets.push({ assetId: id, sha256, bytes: bytes.length, mime: info.mime });
  }
  const archivedRequest = { ...request, assets }; validateQQAccountActionRequest(operation, archivedRequest);
  const payload = operation === 'profile.avatar' ? images[0] : operation === 'feed.publish' ? { text: request.text, images, visibility: request.visibility, targetUserIds: request.targetUserIds } : { ...request };
  if (operation === 'profile.update') delete payload.accountId;
  return { archivedRequest, payload };
}
