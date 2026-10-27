import { createHash, randomUUID } from 'node:crypto';
import { mediaInfo } from '../media/io.js';
import { BILIBILI_LIMITS as LIMITS, bvid, externalSource, fail, fields, hash, id, integer, object, text, trustedUrl, uid, videoUrl } from './common.js';

// Website WBI permutation, a wire-format algorithm rather than a behavioral rule.
const WBI_ORDER = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
export function signWbi(parameters, imageKey, subKey, timestamp) {
  if (!/^[0-9a-f]{32}$/i.test(imageKey) || !/^[0-9a-f]{32}$/i.test(subKey) || !Number.isSafeInteger(timestamp) || timestamp < 0) fail('BILI_WBI_UNAVAILABLE');
  const joined = imageKey + subKey, mixed = WBI_ORDER.map(at => joined[at]).join('').slice(0, 32), values = { ...parameters, wts: timestamp };
  const query = Object.keys(values).sort().map(key => encodeURIComponent(key) + '=' + encodeURIComponent(String(values[key]).replace(/[!'()*]/g, ''))).join('&');
  return { ...values, w_rid: createHash('md5').update(query + mixed).digest('hex') };
}
const short = (value, max = 512) => typeof value === 'string' ? value.slice(0, max) : '';
const positiveId = value => { const result = uid(value); if (result.length > 16 || !Number.isSafeInteger(Number(result))) fail('BILI_IDENTIFIER'); return result; };
const cleanedTitle = value => short(value).replace(/<[^>]*>/g, '');
function summary(raw) {
  if (!object(raw)) return null; const bv = raw.bvid;
  if (typeof bv !== 'string' || !/^BV[0-9A-Za-z]{10}$/.test(bv)) return null;
  const scalar = value => typeof value === 'string' ? short(value, 64) : typeof value === 'number' && Number.isFinite(value) ? value : null;
  return { bvid: bv, title: cleanedTitle(raw.title), author: short(raw.author ?? raw.owner?.name), authorId: String(scalar(raw.mid ?? raw.owner?.mid) ?? ''), duration: scalar(raw.duration), play: scalar(raw.play ?? raw.stat?.view), publishedAt: scalar(raw.pubdate ?? raw.ctime), url: videoUrl(bv) };
}
function videoData(raw) {
  if (!object(raw)) fail('BILI_RESPONSE_INVALID');
  const bv = bvid(raw.bvid), pages = Array.isArray(raw.pages) ? raw.pages : [];
  return { ...summary(raw), aid: positiveId(raw.aid), cid: positiveId(raw.cid ?? pages[0]?.cid), description: short(raw.desc, LIMITS.resultChars), descriptionComplete: typeof raw.desc !== 'string' || raw.desc.length <= LIMITS.resultChars, duration: Number(raw.duration) || 0, pages: pages.slice(0, LIMITS.pages).map(page => ({ cid: positiveId(page.cid), part: short(page.part), page: page.page, duration: Number(page.duration) || 0 })), totalPages: pages.length, pagesComplete: pages.length <= LIMITS.pages, url: videoUrl(bv) };
}
export function createBilibiliClient({ http, clock = Date.now, transformFrames } = {}) {
  let wbi;
  const getVideo = async (value, auth, signal) => {
    const requested = bvid(value), result = videoData(await http.json('api', '/x/web-interface/view', { bvid: requested }, { auth, signal }));
    if (result.bvid !== requested) fail('BILI_VIDEO_IDENTITY_MISMATCH', 'The returned video does not match the requested bvid; no related source was attributed.');
    return result;
  };
  async function probe(auth, signal) { const result = await http.json('api', '/x/web-interface/nav', {}, { auth, signal }); if (result.isLogin !== true || String(result.mid) !== auth.accountId) fail('BILI_AUTH_REJECTED'); return { accountId: auth.accountId, name: short(result.uname, 128), connected: true }; }
  async function signed(parameters, auth, signal) {
    if (!wbi || clock() >= wbi.until) {
      const nav = await http.json('api', '/x/web-interface/nav', {}, { auth, signal });
      const key = value => { try { return new URL(value).pathname.split('/').at(-1).split('.')[0]; } catch { fail('BILI_WBI_UNAVAILABLE'); } };
      wbi = { image: key(nav.wbi_img?.img_url), sub: key(nav.wbi_img?.sub_url), until: clock() + 300000 };
    }
    return signWbi(parameters, wbi.image, wbi.sub, Math.floor(clock() / 1000));
  }
  async function read(args, auth, signal) {
    fields(args, ['operation', 'keyword', 'page', 'limit', 'order', 'bvid', 'cid', 'offset', 'charOffset', 'root', 'next', 'at', 'num', 'commentId', 'contentHash']);
    const operation = args.operation;
    if (operation === 'search' || operation === 'recommend') {
      const limit = integer(args.limit, 10, 1, 40); let raw, rows, page = 1;
      if (operation === 'search') {
        page = integer(args.page, 1, 1, 1000); const order = args.order ?? 'totalrank'; if (!['totalrank', 'click', 'pubdate', 'dm', 'stow'].includes(order)) fail('BILI_ARGUMENT');
        raw = await http.json('api', '/x/web-interface/wbi/search/type', await signed({ search_type: 'video', keyword: text(args.keyword, 256), page, page_size: limit, order }, auth, signal), { auth, signal }); rows = raw.result;
      } else { raw = await http.json('api', '/x/web-interface/index/top/feed/rcmd', { ps: limit, fresh_type: 3 }, { auth, signal }); rows = raw.item; }
      if (!Array.isArray(rows) || rows.length > 256) fail('BILI_RESPONSE_INVALID');
      const items = rows.slice(0, limit).filter(row => operation !== 'recommend' || !row.goto || row.goto === 'av').map(summary).filter(Boolean);
      return { operation, items, source: externalSource(operation, null, clock), coverage: { page, returned: items.length, platformReturned: rows.length, complete: false, ...(operation === 'search' ? { totalResults: raw.numResults ?? null, nextPage: raw.numPages > page ? page + 1 : null } : { scope: 'one_homepage_response', liveCardsExcluded: true }) } };
    }
    const bv = bvid(args.bvid), meta = await getVideo(bv, auth, signal);
    if (operation === 'video') return { operation, video: meta, source: externalSource(operation, bv, clock), coverage: { metadataOnly: true, descriptionComplete: meta.descriptionComplete, totalPages: meta.totalPages, pagesComplete: meta.pagesComplete } };
    const cid = args.cid === undefined ? meta.cid : positiveId(args.cid), page = meta.pages.find(value => value.cid === cid);
    if (cid !== meta.cid && !page) fail('BILI_VIDEO_PAGE_MISMATCH');
    if (operation === 'subtitles') {
      // The signed player endpoint binds the subtitle listing to verified media
      // IDs. The legacy unsigned endpoint can return unrelated subtitle assets
      // even while echoing the requested IDs, so it is never used as fallback.
      const player = await http.json('api', '/x/player/wbi/v2', await signed({ aid: meta.aid, bvid: meta.bvid, cid }, auth, signal), { auth, signal });
      if (String(player.aid) !== meta.aid || player.bvid !== meta.bvid || String(player.cid) !== cid) fail('BILI_VIDEO_PAGE_MISMATCH', 'The player media IDs do not match the selected video page; no subtitle was fetched.');
      const sourceBinding = { aid: meta.aid, bvid: meta.bvid, cid, endpoint: '/x/player/wbi/v2', platformDeclaredIdsVerified: true };
      const choices = player.subtitle?.subtitles;
      if (!Array.isArray(choices) || choices.length > 128) fail('BILI_RESPONSE_INVALID');
      if (!choices.length) return { operation, bvid: bv, cid, segments: [], source: externalSource(operation, bv, clock), coverage: { available: false, complete: false, reason: 'no_platform_subtitle', sourceBinding, pagesCovered: [page?.page ?? 1], totalPages: meta.totalPages } };
      const chosen = choices.find(value => ['ai-zh', 'zh-CN', 'zh'].includes(value.lan)) ?? choices[0];
      const target = trustedUrl(chosen.subtitle_url, ['hdslb.com', 'bilibili.com'], http.localBases);
      const namedAsset = /^\/bfs\/ai_subtitle\/prod\/([a-f0-9]+)(?:\.json)?$/i.exec(target.pathname), expectedPrefix = meta.aid + cid;
      const encodedMediaIds = Boolean(namedAsset && /^[0-9]+[a-f0-9]{32}$/i.test(namedAsset[1])), assetMediaMatches = Boolean(namedAsset && namedAsset[1].startsWith(expectedPrefix) && namedAsset[1].length === expectedPrefix.length + 32);
      if (encodedMediaIds && !assetMediaMatches) fail('BILI_SUBTITLE_SOURCE_MISMATCH', 'The declared AI subtitle asset belongs to different media IDs; no subtitle was fetched.');
      const rawTrackId = chosen.id_str ?? chosen.id;
      const trackId = typeof rawTrackId === 'string' && /^[0-9]{1,32}$/.test(rawTrackId) ? rawTrackId : Number.isSafeInteger(rawTrackId) && rawTrackId > 0 ? String(rawTrackId) : null;
      const response = await http.raw(target, { signal, image: true }), document = (() => { try { return JSON.parse(response.bytes.toString('utf8')); } catch { fail('BILI_RESPONSE_INVALID'); } })();
      if (!object(document) || !Array.isArray(document.body) || document.body.length > 20000) fail('BILI_RESPONSE_INVALID');
      const contentHash = hash(response.bytes);
      if (args.contentHash !== undefined && args.contentHash !== contentHash) fail('BILI_SOURCE_CHANGED', 'The subtitle source changed; restart its paged read rather than joining different versions.');
      const subtitleTrack = { id: trackId, sourceHost: target.host, sourceUrlHash: hash(target.href),
        assetBinding: encodedMediaIds && assetMediaMatches ? 'aid_cid_prefix' : 'not_encoded' };
      let offset = integer(args.offset, 0, 0, document.body.length), charOffset = integer(args.charOffset, 0, 0, LIMITS.responseBytes), remaining = LIMITS.resultChars;
      const startOffset = offset, startCharOffset = charOffset, limit = integer(args.limit, 50, 1, 100), segments = [];
      while (offset < document.body.length && segments.length < limit && remaining > 0) {
        const item = document.body[offset]; if (!object(item) || typeof item.content !== 'string' || !Number.isFinite(item.from) || !Number.isFinite(item.to) || item.from < 0 || item.to < item.from || charOffset > item.content.length) fail('BILI_RESPONSE_INVALID');
        const length = Math.min(item.content.length - charOffset, remaining), end = charOffset + length;
        segments.push({ index: offset, from: item.from, to: item.to, text: item.content.slice(charOffset, end), charStart: charOffset, charEnd: end, textComplete: charOffset === 0 && end === item.content.length }); remaining -= length;
        if (end < item.content.length) { charOffset = end; break; } offset++; charOffset = 0;
      }
      const hasMore = offset < document.body.length;
      return { operation, bvid: bv, cid, language: short(chosen.lan, 64), languageName: short(chosen.lan_doc, 64), segments, contentHash, subtitleTrack, source: externalSource(operation, bv, clock), coverage: { available: true, sourceBinding, subtitleTrackIdAvailable: trackId !== null, contentCorrespondenceAssessed: false, startOffset, startCharOffset, totalSegments: document.body.length, returned: segments.length, hasMore, nextOffset: hasMore ? offset : null, nextCharOffset: hasMore ? charOffset : null, complete: startOffset === 0 && startCharOffset === 0 && !hasMore, pagesCovered: [page?.page ?? 1], totalPages: meta.totalPages, fullSubtitleTrackReturned: startOffset === 0 && startCharOffset === 0 && !hasMore, fullVideoCovered: false } };
    }
    if (operation === 'comments') {
      const limit = integer(args.limit, 20, 1, 20), root = args.root === undefined ? null : positiveId(args.root), pn = integer(args.page, 1, 1, 1000), cursor = integer(args.next, 0, 0, 1000000);
      const raw = await http.json('api', root ? '/x/v2/reply/reply' : '/x/v2/reply/main', root ? { type: 1, oid: meta.aid, root, pn, ps: limit } : { type: 1, oid: meta.aid, mode: 3, next: cursor, ps: limit }, { auth, signal });
      if (!Array.isArray(raw.replies ?? []) || (raw.replies ?? []).length > 256) fail('BILI_RESPONSE_INVALID'); let chars = 0;
      const selectedId = args.commentId === undefined ? null : positiveId(args.commentId), offset = integer(args.charOffset, 0, 0, LIMITS.responseBytes), selected = selectedId ? raw.replies.filter(item => String(item.rpid_str ?? item.rpid) === selectedId) : (raw.replies ?? []).slice(0, limit);
      if (selectedId && selected.length !== 1) fail('BILI_SOURCE_UNAVAILABLE');
      if (!selectedId && (offset || args.contentHash !== undefined)) fail('BILI_ARGUMENT');
      const items = selected.map(item => { const full = typeof item.content?.message === 'string' ? item.content.message : '', contentHash = hash(full); if (offset > full.length || args.contentHash !== undefined && args.contentHash !== contentHash) fail('BILI_SOURCE_CHANGED'); const clipped = full.slice(offset, offset + Math.max(0, LIMITS.resultChars - chars)); chars += clipped.length; const end = offset + clipped.length; return { messageId: positiveId(item.rpid_str ?? item.rpid), rootId: item.root ? positiveId(item.root) : null, parentId: item.parent ? positiveId(item.parent) : null, senderId: String(item.member?.mid ?? item.mid ?? ''), senderName: short(item.member?.uname, 128), text: clipped, textComplete: offset === 0 && end === full.length, contentHash, charStart: offset, charEnd: end, totalChars: full.length, nextCharOffset: end < full.length ? end : null, createdAt: Number(item.ctime) || 0, replies: Number(item.rcount) || 0 }; });
      return { operation, bvid: bv, items, source: externalSource(operation, bv, clock), coverage: { complete: false, rootId: root, ...(root ? { page: pn, total: raw.page?.count ?? null } : { cursor, next: raw.cursor?.next ?? null, isEnd: raw.cursor?.is_end === true }), textComplete: items.every(item => item.textComplete) } };
    }
    if (operation === 'frames') {
      const count = integer(args.num, 3, 1, LIMITS.frames); if (args.at !== undefined && (!Array.isArray(args.at) || !args.at.length || args.at.length > LIMITS.frames || args.at.some(at => !Number.isFinite(at) || at < 0))) fail('BILI_ARGUMENT');
      const raw = await http.json('api', '/x/player/videoshot', { bvid: bv, cid, index: 1 }, { auth, signal });
      const images = raw.image, indices = raw.index, cols = integer(raw.img_x_len, 10, 1, 100), rows = integer(raw.img_y_len, 10, 1, 100), width = integer(raw.img_x_size, 160, 1, 2048), height = integer(raw.img_y_size, 90, 1, 2048);
      if (!Array.isArray(images) || !images.length || images.length > 512 || !Array.isArray(indices) || !indices.length || indices.length > 100000 || indices.some((at, index) => !Number.isFinite(at) || at < 0 || index > 0 && at < indices[index - 1])) fail('BILI_STORYBOARD_UNAVAILABLE');
      const duration = page?.duration ?? meta.duration, last = indices.at(-1), coveredUntil = Math.min(duration || last, last), targets = args.at ?? Array.from({ length: count }, (_, index) => coveredUntil * (index + 1) / (count + 1));
      const selections = targets.map(requested => { let tile = 0, distance = Infinity; for (let i = 0; i < indices.length; i++) { const delta = Math.abs(indices[i] - requested); if (delta < distance) { distance = delta; tile = i; } } const perSheet = cols * rows, sheetIndex = Math.floor(tile / perSheet), index = tile % perSheet; if (sheetIndex >= images.length) fail('BILI_STORYBOARD_UNAVAILABLE'); return { requestedAt: requested, sampledAt: indices[tile], sheetIndex, cropRect: { x: index % cols * width, y: Math.floor(index / cols) * height, width, height }, requestWithinCoverage: requested <= coveredUntil }; });
      const sheets = []; let total = 0;
      for (const sheetIndex of new Set(selections.map(item => item.sheetIndex))) {
        const target = trustedUrl(images[sheetIndex], ['hdslb.com', 'bilibili.com'], http.localBases), fetched = await http.raw(target, { image: true, signal, max: LIMITS.imageBytes }), info = mediaInfo(fetched.bytes, 'image'); total += fetched.bytes.length;
        if (total > LIMITS.imageTotalBytes || info.width > 16384 || info.height > 16384 || selections.filter(item => item.sheetIndex === sheetIndex).some(item => item.cropRect.x + width > info.width || item.cropRect.y + height > info.height)) fail('BILI_IMAGE_CAPACITY');
        sheets.push({ sheetIndex, bytes: fetched.bytes, mime: info.mime, width: info.width, height: info.height });
      }
      const coverage = { kind: 'platform_storyboard', cid, page: page?.page ?? 1, totalPages: meta.totalPages, duration, coveredUntil, firstSampleAt: indices[0], lastSampleAt: last, continuousVideoDecoded: false, fullVideoCovered: false, individuallyCropped: false };
      let transformed;
      if (transformFrames) { transformed = await transformFrames({ sheets, selections, signal }); if (!Array.isArray(transformed) || transformed.length !== selections.length) fail('BILI_FRAME_TRANSFORM_INVALID'); let bytes = 0; for (const frame of transformed) { if (!(frame?.bytes instanceof Uint8Array) || !frame.bytes.byteLength || frame.bytes.byteLength > LIMITS.imageBytes) fail('BILI_FRAME_TRANSFORM_INVALID'); const info = mediaInfo(frame.bytes, 'image'); if (info.width > 2048 || info.height > 2048) fail('BILI_FRAME_TRANSFORM_INVALID'); frame.mime = info.mime; bytes += frame.bytes.byteLength; } if (bytes > LIMITS.imageTotalBytes) fail('BILI_FRAME_TRANSFORM_INVALID'); coverage.individuallyCropped = true; }
      return { operation, bvid: bv, selections, sheets, ...(transformed ? { frames: transformed } : {}), source: externalSource(operation, bv, clock, coverage), coverage, visualStatus: transformed ? 'cropped_bytes_require_host_image_attachment' : 'sprite_bytes_with_crop_rects_require_host_image_attachment', visualAvailable: false, note: '故事板采样不等于连续观看；未确认宿主附件与模型视觉能力。' };
    }
    fail('BILI_OPERATION_UNSUPPORTED');
  }
  async function prepare(args, auth, signal) {
    fields(args, ['operation', 'bvid', 'text', 'receiverUid', 'replyId', 'rootId']);
    const operation = args.operation;
    if (operation === 'comment' || operation === 'reply') {
      const bv = bvid(args.bvid), body = text(args.text, LIMITS.commentChars), meta = await getVideo(bv, auth, signal);
      const root = operation === 'reply' ? positiveId(args.rootId ?? args.replyId) : '0', parent = operation === 'reply' ? positiveId(args.replyId) : '0';
      return { operation, bvid: bv, path: '/x/v2/reply/add', base: 'api', contentHash: hash(body), form: { oid: meta.aid, type: '1', message: body, root, parent, csrf: auth.csrf }, public: { bvid: bv, rootId: root, parentId: parent } };
    }
    if (operation === 'share' || operation === 'message') {
      const receiver = uid(args.receiverUid), bv = operation === 'share' ? bvid(args.bvid) : null;
      const body = operation === 'share' ? (args.text ? text(args.text, LIMITS.messageChars) + '\n' : '') + videoUrl(bv) : text(args.text, LIMITS.messageChars);
      text(body, LIMITS.messageChars);
      return { operation, ...(bv ? { bvid: bv } : {}), base: 'message', path: '/web_im/v1/web_im/send_msg', contentHash: hash(body), form: { 'msg[sender_uid]': auth.accountId, 'msg[receiver_id]': receiver, 'msg[receiver_type]': '1', 'msg[msg_type]': '1', 'msg[msg_status]': '0', 'msg[content]': JSON.stringify({ content: body }), 'msg[timestamp]': String(Math.floor(clock() / 1000)), 'msg[new_face_version]': '0', 'msg[dev_id]': randomUUID(), 'from_firework': '0', 'build': '0', 'mobi_app': 'web', csrf_token: auth.csrf, csrf: auth.csrf }, public: { receiverUid: receiver, ...(bv ? { bvid: bv, sharingMethod: 'private_video_link' } : {}) } };
    }
    fail('BILI_OPERATION_UNSUPPORTED');
  }
  async function send(prepared, auth, signal) {
    const { value } = await http.raw(http.url(prepared.base, prepared.path), { method: 'POST', form: prepared.form, auth, signal });
    if (value.code !== 0) return { status: 'failed', code: 'BILI_PLATFORM_REJECTED' };
    const data = object(value.data) ? value.data : {};
    const rawId = ['comment', 'reply'].includes(prepared.operation) ? data.rpid_str ?? data.rpid ?? data.reply?.rpid_str ?? data.reply?.rpid : data.msg_key;
    if (typeof rawId === 'number' && !Number.isSafeInteger(rawId) || !['string', 'number'].includes(typeof rawId) || !String(rawId) || String(rawId) === '0') return { status: 'unknown', code: 'BILI_ACK_UNCONFIRMED' };
    return { status: 'delivered', messageId: id(rawId), messageIdKind: ['comment', 'reply'].includes(prepared.operation) ? 'rpid' : 'msg_key', receiptId: 'bilibili:' + String(rawId), confirmedBy: ['comment', 'reply'].includes(prepared.operation) ? 'bilibili-code0-rpid' : 'bilibili-code0-msg_key', deliveredAt: clock(), ...(prepared.operation === 'comment' || prepared.operation === 'reply' ? { publicVisibility: 'unknown' } : { readByRecipient: 'unknown' }) };
  }
  async function verifyReceipt(receipt, messageId, auth) {
    id(messageId); if (!receipt.target || !receipt.contentHash) return null;
    if (['comment', 'reply'].includes(receipt.operation)) {
      const meta = await getVideo(receipt.target.bvid, auth), root = receipt.target.rootId;
      const data = await http.json('api', root && root !== '0' ? '/x/v2/reply/reply' : '/x/v2/reply/main', root && root !== '0' ? { type: 1, oid: meta.aid, root, pn: 1, ps: 20 } : { type: 1, oid: meta.aid, mode: 3, next: 0, ps: 20 }, { auth });
      const candidate = (Array.isArray(data.replies) ? data.replies : []).find(item => String(item.rpid_str ?? item.rpid) === messageId);
      if (!candidate || String(candidate.member?.mid ?? candidate.mid) !== auth.accountId || hash(candidate.content?.message ?? '') !== receipt.contentHash || String(candidate.root ?? 0) !== receipt.target.rootId || String(candidate.parent ?? 0) !== receipt.target.parentId) return null;
      return { status: 'delivered', messageId, messageIdKind: 'rpid', receiptId: 'bilibili:' + messageId, confirmedBy: 'bilibili-existing-rpid', verifiedAt: clock(), publicVisibility: candidate.invisible ? 'unknown' : 'observed_in_platform_list' };
    }
    const data = await http.json('message', '/svr_sync/v1/svr_sync/fetch_session_msgs', { talker_id: receipt.target.receiverUid, session_type: 1, size: 50, build: 0, mobi_app: 'web' }, { auth });
    const candidate = (Array.isArray(data.messages) ? data.messages : []).find(item => String(item.msg_key) === messageId);
    if (!candidate || String(candidate.sender_uid) !== auth.accountId || candidate.receiver_id !== undefined && String(candidate.receiver_id) !== receipt.target.receiverUid || Number(candidate.msg_type) !== 1) return null;
    let content; try { content = JSON.parse(candidate.content); } catch { return null; }
    if (hash(content.content ?? '') !== receipt.contentHash) return null;
    return { status: 'delivered', messageId, messageIdKind: 'msg_key', receiptId: 'bilibili:' + messageId, confirmedBy: 'bilibili-existing-msg_key', verifiedAt: clock(), readByRecipient: 'unknown' };
  }
  return { probe, read, prepare, send, verifyReceipt, clearAuthCache() { wbi = null; } };
}
