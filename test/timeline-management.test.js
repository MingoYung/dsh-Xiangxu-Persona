import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagementService } from '../adapters/dsh/management.js';
import { MemoryRepository } from '../core/repository.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function fixture() {
  let version = 1;
  const rows = Array.from({ length: 27 }, (_, i) => ({ id: 'record-' + i, recordType: 'chat', role: i % 2 ? 'assistant' : 'user',
    personId: i % 2 ? null : 'known-person', scope: i % 2 ? 'staging' : 'person', sourceAt: i + 1,
    sourceSessionId: 'actual-session', sourceEventId: 'actual-' + i, text: '原始交流😀' + i,
    timeline: { title: '完整经历' + i, occurredAt: i + 1, recordedAt: i + 2, feltThen: '当时表达', meaningNow: '现在理解' } }));
  const calls = [];
  const repo = {
    getTimelineStatus: async () => ({ recent: { count: 27, chars: 200 }, long_term: { count: 0, chars: 0 }, archive: { count: 0, chars: 0 }, automaticDeletion: false }),
    browseTimeline: async args => {
      calls.push(structuredClone(args));
      const selected = rows.filter(row => !Object.hasOwn(args, 'personId') || row.personId === args.personId);
      const to = Math.min(selected.length, args.offset + args.limit);
      return { items: selected.slice(args.offset, to).map(row => ({ ...row, tier: args.tier })), total: selected.length,
        offset: args.offset, nextOffset: to < selected.length ? to : null, revision: 'timeline-version-' + version };
    },
  };
  const service = createManagementService({ getCoordinator: () => ({ repository: repo }) });
  return { service, calls, change: () => { version++; } };
}

test('owner timeline pages preserve actual source roles, tier and stable pagination without model calls', async () => {
  const { service, calls } = fixture();
  const status = await service.dispatch('memory.timeline.status'); assert.equal(status.automaticDeletion, false);
  const ids = []; let cursor;
  do {
    const page = await service.dispatch('memory.timeline.list', { tier: 'archive', pageSize: 12, ...(cursor ? { cursor } : {}) });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 131072);
    assert.equal(page.total, 27); assert.ok(page.items.every(row => row.tier === 'archive' && row.timeline.title && row.sourceSessionId === 'actual-session'));
    ids.push(...page.items.map(row => row.id)); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(new Set(ids).size, 27); assert.equal(calls.length, 3);
});

test('timeline cursors cannot cross changed storage revision or a different selected tier', async () => {
  const { service, change } = fixture();
  const first = await service.dispatch('memory.timeline.list', { tier: 'recent', pageSize: 12 });
  await assert.rejects(service.dispatch('memory.timeline.list', { tier: 'archive', pageSize: 12, cursor: first.nextCursor }), { code: 'MANAGEMENT_CURSOR_STALE' });
  change();
  await assert.rejects(service.dispatch('memory.timeline.list', { tier: 'recent', pageSize: 12, cursor: first.nextCursor }), { code: 'MANAGEMENT_CURSOR_STALE' });
});

test('timeline selection preserves explicit unknown identity and refuses unbounded or malformed inputs', async () => {
  const { service, calls } = fixture();
  const unknown = await service.dispatch('memory.timeline.list', { tier: 'long_term', personId: null, pageSize: 100 });
  assert.ok(unknown.items.every(row => row.personId === null)); assert.equal(calls[0].personId, null);
  for (const args of [{ tier: 'delete-all' }, { pageSize: 101 }, { query: 'x'.repeat(513) }, { cursor: 'x'.repeat(2049) },
    { cursor: Buffer.from(JSON.stringify({ offset: -1 })).toString('base64url') }]) {
    await assert.rejects(service.dispatch('memory.timeline.list', args));
  }
});

test('real repository tiers reach owner list and paged full detail without rewriting original words', async t => {
  const temp = await fs.realpath(os.tmpdir()), base = await fs.realpath(await fs.mkdtemp(path.join(temp, 'persona-timeline-owner-')));
  const repo = new MemoryRepository({ root: path.join(base, 'memory'), clock: () => 1000000000, config: { recentTargetChars: 3, longTermTargetChars: 3 } });
  t.after(async () => { await repo.close().catch(() => {}); assert.ok(path.resolve(base).startsWith(path.resolve(temp) + path.sep)); await fs.rm(base, { recursive: true, force: true }); });
  await repo.open();
  for (let i = 0; i < 3; i++) await repo.ingest({ sourceSessionId: 'same-session', sourceEventId: 'message-' + i,
    personId: null, sourceKind: 'user', contentClass: 'participant_dialogue', role: 'user', text: ['原话甲', '原话乙', '原话丙'][i],
    channelId: 'same-channel', sourceAt: 1000000000 - 20 + i * 10, observedAt: 1000000000 });
  const service = createManagementService({ getCoordinator: () => ({ repository: repo }) });
  const status = await service.dispatch('memory.timeline.status');
  for (const tier of ['recent', 'long_term', 'archive']) {
    assert.equal(status[tier].count, 1);
    const page = await service.dispatch('memory.timeline.list', { tier }); assert.equal(page.items.length, 1);
    assert.equal(page.items[0].tier, tier);
    let cursor, raw = '';
    do { const fragment = await service.dispatch('memory.detail', { id: page.items[0].id, pageChars: 100, ...(cursor ? { cursor } : {}) }); raw += fragment.text; cursor = fragment.nextCursor; } while (cursor);
    const detail = JSON.parse(raw); assert.equal(detail.text, tier === 'recent' ? '原话丙' : tier === 'long_term' ? '原话乙' : '原话甲');
    assert.equal(detail.timeline.format, 'persona-timeline/1'); assert.equal(detail.role, 'user');
  }
});
