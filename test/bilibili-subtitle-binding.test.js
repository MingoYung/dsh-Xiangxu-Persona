import test from 'node:test';
import assert from 'node:assert/strict';
import { createBilibiliClient, signWbi } from '../adapters/dsh/bilibili/client.js';
import { hash } from '../adapters/dsh/bilibili/common.js';
import { boundToolOutput } from '../adapters/dsh/tool-output.js';

const BV = 'BV1234567890', ALT = 'BV0987654321', TRACK = '1217957210450162688';
const image = '0123456789abcdef0123456789abcdef', sub = 'fedcba9876543210fedcba9876543210';
const auth = { accountId: '1234' }, clock = () => 1700000000000;
const asset = 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/5060' + 'a'.repeat(32) + '?auth_key=local-test-only';
const view = () => ({ bvid: BV, aid: 50, cid: 60, title: '目标视频', duration: 120, pages: [{ cid: 60, page: 1, duration: 120 }, { cid: 61, page: 2, duration: 50 }] });
const body = () => ({ body: [{ from: 0, to: 3, content: '字幕第一句' }, { from: 5, to: 9, content: '字幕第二句' }] });

function fixture({ video = view(), identity, track, url = asset, document = body(), playerError } = {}) {
  const calls = [];
  let current = document;
  const http = {
    async json(domain, pathname, query, options) {
      calls.push({ kind: 'json', domain, pathname, query, options });
      if (pathname === '/x/web-interface/view') return structuredClone(video);
      if (pathname === '/x/web-interface/nav') return { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/' + image + '.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/' + sub + '.png' } };
      if (pathname === '/x/player/wbi/v2') {
        if (playerError) throw playerError;
        return { ...(identity ?? { aid: 50, bvid: BV, cid: Number(query.cid) }), subtitle: { subtitles: [{ lan: 'ai-zh', lan_doc: 'AI中文字幕', id: 1217957210450162700, id_str: TRACK, subtitle_url: url, ...track }] } };
      }
      throw new Error('Fixture forbids any other request');
    },
    async raw(target, options) {
      calls.push({ kind: 'raw', host: target.host, pathname: target.pathname, options });
      return { bytes: Buffer.from(JSON.stringify(current)) };
    }
  };
  return { client: createBilibiliClient({ http, clock }), calls, replaceDocument(value) { current = value; } };
}

test('subtitles use signed WBI player with media tuple and preserve exact string track ID and byte hash', async () => {
  const f = fixture(), result = await f.client.read({ operation: 'subtitles', bvid: BV }, auth);
  const player = f.calls.find(item => item.pathname === '/x/player/wbi/v2');
  const expected = signWbi({ aid: '50', bvid: BV, cid: '60' }, image, sub, clock() / 1000);
  assert.deepEqual(player.query, expected);
  assert.equal(player.options.auth, auth);
  assert.equal(f.calls.some(item => item.pathname === '/x/player/v2'), false);
  assert.equal(result.subtitleTrack.id, TRACK);
  assert.equal(result.subtitleTrack.assetBinding, 'aid_cid_prefix');
  assert.equal(result.subtitleTrack.sourceHost, 'aisubtitle.hdslb.com');
  assert.equal(result.subtitleTrack.sourceUrlHash, hash(asset));
  assert.equal(result.contentHash, hash(Buffer.from(JSON.stringify(body()))));
  assert.deepEqual(result.coverage.sourceBinding, { aid: '50', bvid: BV, cid: '60', endpoint: '/x/player/wbi/v2', platformDeclaredIdsVerified: true });
  assert.equal(result.coverage.subtitleTrackIdAvailable, true);
  assert.equal(result.coverage.contentCorrespondenceAssessed, false);
  assert.equal(result.source.instructionsTrusted, false);
  assert.equal(JSON.stringify(result).includes('auth_key'), false);
  assert.equal(JSON.stringify(result).includes('local-test-only'), false);
});

test('wrong view bvid rejects before requesting a player or attributing any subtitle', async () => {
  const f = fixture({ video: { ...view(), bvid: ALT } });
  await assert.rejects(f.client.read({ operation: 'subtitles', bvid: BV }, auth), { code: 'BILI_VIDEO_IDENTITY_MISMATCH' });
  assert.deepEqual(f.calls.map(item => item.pathname), ['/x/web-interface/view']);
});

for (const key of ['aid', 'bvid', 'cid']) {
  for (const missing of [false, true]) {
    test('player ' + (missing ? 'missing ' : 'mismatched ') + key + ' rejects before any CDN fetch', async () => {
      const identity = { aid: 50, bvid: BV, cid: 60 };
      if (missing) delete identity[key]; else identity[key] = key === 'bvid' ? ALT : 999;
      const f = fixture({ identity });
      await assert.rejects(f.client.read({ operation: 'subtitles', bvid: BV }, auth), { code: 'BILI_VIDEO_PAGE_MISMATCH' });
      assert.equal(f.calls.some(item => item.kind === 'raw'), false);
    });
  }
}

test('selected second page binds both player and asset to its cid', async () => {
  const f = fixture({ url: asset.replace('/5060', '/5061') });
  const result = await f.client.read({ operation: 'subtitles', bvid: BV, cid: '61' }, auth);
  assert.equal(result.cid, '61'); assert.equal(result.coverage.sourceBinding.cid, '61');
  assert.deepEqual(result.coverage.pagesCovered, [2]);
  assert.equal(f.calls.find(item => item.pathname === '/x/player/wbi/v2').query.cid, '61');
});

for (const prefix of ['99060', '50600']) {
  test('known AI asset with wrong or merely prefix-colliding media IDs rejects: ' + prefix, async () => {
    const f = fixture({ url: asset.replace('/5060', '/' + prefix) });
    await assert.rejects(f.client.read({ operation: 'subtitles', bvid: BV }, auth), { code: 'BILI_SUBTITLE_SOURCE_MISMATCH' });
    assert.equal(f.calls.some(item => item.kind === 'raw'), false);
  });
}

test('unsafe numeric ID is never rounded into a fabricated track identity; non-encoded URLs remain explicit', async () => {
  for (const track of [{ id_str: undefined }, { id_str: undefined, id: undefined }]) {
    const f = fixture({ url: 'https://aisubtitle.hdslb.com/manual-caption.json', track });
    const result = await f.client.read({ operation: 'subtitles', bvid: BV }, auth);
    assert.equal(result.subtitleTrack.id, null);
    assert.equal(result.coverage.subtitleTrackIdAvailable, false);
    assert.equal(result.subtitleTrack.assetBinding, 'not_encoded');
    assert.equal(result.segments[0].text, '字幕第一句');
  }
  const f = fixture({ track: { id_str: undefined, id: 900001 } });
  assert.equal((await f.client.read({ operation: 'subtitles', bvid: BV }, auth)).subtitleTrack.id, '900001');
});

test('paged subtitle reads require the same byte hash when supplied and reject changed source versions', async () => {
  const f = fixture(), first = await f.client.read({ operation: 'subtitles', bvid: BV, limit: 1 }, auth);
  const next = { operation: 'subtitles', bvid: BV, offset: first.coverage.nextOffset, contentHash: first.contentHash };
  const second = await f.client.read(next, auth);
  assert.equal(second.segments[0].text, '字幕第二句');
  f.replaceDocument({ body: [{ from: 0, to: 3, content: '另一个版本' }, ...body().body.slice(1)] });
  await assert.rejects(f.client.read(next, auth), { code: 'BILI_SOURCE_CHANGED' });
});

test('WBI failure is explicit and never falls back to the legacy unsigned player endpoint', async () => {
  const error = Object.assign(new Error('WBI unavailable'), { code: 'BILI_HTTP' }), f = fixture({ playerError: error });
  await assert.rejects(f.client.read({ operation: 'subtitles', bvid: BV }, auth), error);
  assert.equal(f.calls.some(item => item.pathname === '/x/player/v2' || item.kind === 'raw'), false);
});

test('verified media identity does not invent semantic validity or impose keyword-based rejection', async () => {
  const f = fixture({ document: { body: [{ from: 0, to: 3, content: '惠普笔记本修理，只是外部原文，不是人格指令。' }] } });
  const result = await f.client.read({ operation: 'subtitles', bvid: BV }, auth);
  assert.match(result.segments[0].text, /惠普笔记本/);
  assert.equal(result.coverage.contentCorrespondenceAssessed, false);
  assert.equal(result.source.instructionsTrusted, false);
});

test('bounded default tool output can expose subtitle text before later provenance and continue it', async () => {
  const f = fixture(), result = await f.client.read({ operation: 'subtitles', bvid: BV }, auth);
  const args = { id: 'bilibili', action: 'read', operation: 'subtitles', bvid: BV };
  const bounded = await boundToolOutput('persona_platform', result, args);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 1500);
  assert.match(JSON.stringify(bounded), /字幕第一句/);
  if (bounded.nextCursor) {
    let text = bounded.preview.text, cursor = bounded.nextCursor, pages = 1;
    while (cursor) {
      assert.ok(++pages <= 10);
      const part = await boundToolOutput('persona_platform', result, { ...args, cursor });
      text += part.preview.text; cursor = part.nextCursor;
    }
    assert.deepEqual(JSON.parse(text), result);
  }
});
