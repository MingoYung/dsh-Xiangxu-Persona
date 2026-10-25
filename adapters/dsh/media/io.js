import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { atomicReplaceWithRetry } from '../../../core/store.js';

export const LIMITS = Object.freeze({ imageBytes: 8388608, videoBytes: 67108864, assetBytes: 268435456, assets: 256, jobs: 80, activeJobs: 8, profileBytes: 65536, descriptionChars: 2048, history: 8, previewBytes: 524288, imageEdge:8192,imagePixels:33554432,previewPixels:4194304,outputAssets: 4, metadataBytes: 1048576, workflowBytes: 131072, responseBytes: 25165824, promptChars: 8000, requestMs: 120000, sourceRefs:32, sourceRecordIds:64, provenance:16 });
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const clone = value => structuredClone(value);
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const failure = (code, message) => Object.assign(new Error(message), { code });
export const fail = (code, message) => { throw failure(code, message); };
export function plain(value, name, max = 256, empty = false) {
  if (typeof value !== 'string' || !empty && !value || Array.from(value).length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail('MEDIA_INVALID', name + '格式或长度无效');
  return value;
}
export function fields(value, keys) { if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) fail('MEDIA_INVALID', '未知媒体字段'); }
export async function safePath(file) {
  const full = path.resolve(file); let cursor = path.parse(full).root;
  for (const part of full.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) fail('MEDIA_UNSAFE_PATH', '媒体路径不能经过符号链接或目录联接'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return full;
}
export async function readBounded(file, max, fallback) {
  await safePath(file); let handle;
  try {
    const stat = await fs.lstat(file); if (!stat.isFile() || stat.size > max) fail('MEDIA_CAPACITY', '媒体文件不是普通文件或超过容量');
    handle = await fs.open(file, 'r'); const buffer = Buffer.alloc(max + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > max) fail('MEDIA_CAPACITY', '媒体文件超过容量'); return buffer.subarray(0, bytesRead);
  } catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
  finally { await handle?.close(); }
}
export async function readJson(file, max, fallback) { const bytes = await readBounded(file, max, null); return bytes === null ? clone(fallback) : JSON.parse(bytes.toString('utf8')); }
export async function atomic(file, bytes, max) {
  if (bytes.length > max) fail('MEDIA_CAPACITY', '媒体元数据超过容量'); await safePath(file); await fs.mkdir(path.dirname(file), { recursive: true }); await safePath(file);
  const temporary = file + '.part-' + randomUUID(); let handle;
  try { handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null; await atomicReplaceWithRetry(temporary, file); }
  finally { await handle?.close(); await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function writeJson(file, value, max = LIMITS.metadataBytes) { return atomic(file, Buffer.from(JSON.stringify(value, null, 2) + '\n'), max); }
const local = hostname => hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || /^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) || /^(fc|fd)[0-9a-f:]+$/i.test(hostname.replace(/^\[|\]$/g, ''));
export function endpoint(value, allowRemote) {
  plain(value, '服务地址', 2048); let url; try { url = new URL(value); } catch { fail('MEDIA_ENDPOINT', '服务地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (!local(url.hostname) && (!allowRemote || url.protocol !== 'https:')) || isIP(url.hostname) === 4 && url.hostname.startsWith('169.254.')) fail('MEDIA_ENDPOINT', '远程服务需要明确允许并使用HTTPS，地址不能夹带凭据或查询');
  return url.href.replace(/\/$/, '');
}
export async function responseBytes(response, max) {
  const length = Number(response.headers.get('content-length')); if (Number.isFinite(length) && length > max) fail('MEDIA_RESPONSE_CAPACITY', '服务响应超过容量');
  if (!response.body) return Buffer.alloc(0); const reader = response.body.getReader(); let total = 0; const chunks = [];
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; total += value.byteLength; if (total > max) { await reader.cancel(); fail('MEDIA_RESPONSE_CAPACITY', '服务响应超过容量'); } chunks.push(Buffer.from(value)); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
export function mediaInfo(bytes, wanted) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) fail('MEDIA_FORMAT', '媒体内容为空'); let mime, ext, width = null, height = null, kind;
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii',12,16) !== 'IHDR') fail('MEDIA_FORMAT','PNG头部无效');
    width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);let at=8,ended=false;
    while(at+12<=bytes.length){const n=bytes.readUInt32BE(at),type=bytes.toString('ascii',at+4,at+8);if(n>bytes.length-at-12)fail('MEDIA_FORMAT','PNG截断');at+=12+n;if(type==='IEND'){ended=n===0&&at===bytes.length;break;}}if(!ended)fail('MEDIA_FORMAT','PNG缺少完整结束块');mime='image/png';ext='png';kind='image';
  } else if (bytes.length >= 8 && bytes[0]===255&&bytes[1]===216&&bytes.at(-2)===255&&bytes.at(-1)===217) {
    let at=2;while(at+4<bytes.length){if(bytes[at++]!==255)fail('MEDIA_FORMAT','JPEG标记无效');while(bytes[at]===255)at++;const marker=bytes[at++];if(marker===218)break;if(marker===216||marker===217||marker>=208&&marker<=215)continue;const size=bytes.readUInt16BE(at);if(size<2||at+size>bytes.length)fail('MEDIA_FORMAT','JPEG截断');if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){height=bytes.readUInt16BE(at+3);width=bytes.readUInt16BE(at+5);}at+=size;}if(!width||!height)fail('MEDIA_FORMAT','JPEG缺少尺寸');mime='image/jpeg';ext='jpg';kind='image';
  } else if (bytes.length>=30&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&bytes.readUInt32LE(4)+8===bytes.length) {
    const type=bytes.toString('ascii',12,16);if(type==='VP8X'){width=bytes.readUIntLE(24,3)+1;height=bytes.readUIntLE(27,3)+1;}else if(type==='VP8 '&&bytes.length>=30&&bytes.subarray(23,26).equals(Buffer.from([157,1,42]))){width=bytes.readUInt16LE(26)&16383;height=bytes.readUInt16LE(28)&16383;}else if(type==='VP8L'&&bytes.length>=25&&bytes[20]===47){width=1+(((bytes[22]&63)<<8)|bytes[21]);height=1+(((bytes[24]&15)<<10)|(bytes[23]<<2)|((bytes[22]&192)>>6));}else fail('MEDIA_FORMAT','WebP缺少支持的尺寸头');mime='image/webp';ext='webp';kind='image';
  } else if(bytes.length>=24&&bytes.toString('ascii',4,8)==='ftyp') {
    let at=0;const types=new Set();while(at+8<=bytes.length){let n=bytes.readUInt32BE(at);const type=bytes.toString('ascii',at+4,at+8);if(n===1){if(at+16>bytes.length)fail('MEDIA_FORMAT','MP4截断');const big=bytes.readBigUInt64BE(at+8);if(big>BigInt(Number.MAX_SAFE_INTEGER))fail('MEDIA_FORMAT','MP4尺寸无效');n=Number(big);}if(n===0)n=bytes.length-at;if(n<8||at+n>bytes.length)fail('MEDIA_FORMAT','MP4块截断');types.add(type);at+=n;}if(at!==bytes.length||!types.has('moov')||!types.has('mdat'))fail('MEDIA_FORMAT','MP4缺少必要容器块');mime='video/mp4';ext='mp4';kind='video';
  } else if(bytes.length>=16&&bytes.subarray(0,4).equals(Buffer.from([26,69,223,163]))&&bytes.includes(Buffer.from('webm'))){mime='video/webm';ext='webm';kind='video';}
  else fail('MEDIA_FORMAT','只接受可识别的PNG/JPEG/WebP图片或MP4/WebM视频容器');
  if(wanted&&kind!==wanted)fail('MEDIA_KIND','服务返回的媒体类型与请求不符');if(kind==='image'&&(!width||!height||width>LIMITS.imageEdge||height>LIMITS.imageEdge||width*height>LIMITS.imagePixels))fail('MEDIA_DIMENSIONS','图片尺寸超过技术容量');
  if(bytes.length>(kind==='image'?LIMITS.imageBytes:LIMITS.videoBytes))fail('MEDIA_CAPACITY','单个媒体文件超过容量');return{kind,mime,ext,width,height,containerValidated:true};
}
