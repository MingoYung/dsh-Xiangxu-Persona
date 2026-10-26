import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryRepository } from '../core/repository.js';
import { consolidationContextPage, consolidationMessages } from '../core/prompts.js';

test('frozen review offers actual versioned global and personal indexes plus deep memories through truthful Unicode pages', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiangxu-review-context-'));
  const repository = new MemoryRepository({ root }); await repository.open();
  t.after(async () => { await repository.close(); await fs.rm(root, { recursive: true, force: true }); });
  await repository.upsertPerson({ personId: 'a' });
  await repository.ingest({ sourceSessionId: 's', sourceEventId: 'first', personId: 'a', channelId: 'dsh:s', sourceKind: 'message', contentClass: 'participant_dialogue', role: 'user', text: '真实已有记忆😀é' });
  let run = await repository.prepareConsolidation({ personId: 'a' });
  const upsert = (documentKey, recordId, value) => ({ documentKey, recordId, value, operation: 'upsert', expectedVersion: run.inputVersions[documentKey] });
  await repository.applyConsolidation(run, [
    upsert('global:index', 'global_memory', { text: 'GLOBAL_EXISTING😀é' }),
    upsert('person:a:index', 'personal_memory', { text: 'PERSONAL_EXISTING😀é' }),
    upsert('global:deep', 'deep_memory', { title: '旧深刻经历', reference: '旧参考', experience: 'DEEP_EXISTING😀é', feltThen: '当时的感受', meaningNow: '目前的理解' })
  ]);
  run = await repository.prepareConsolidation({ personId: 'a' });
  assert.equal(run.input.context.memoryIndexes.global.version, run.inputVersions['global:index']);
  assert.equal(run.input.context.memoryIndexes.person.version, run.inputVersions['person:a:index']);
  assert.equal(run.input.context.deepMemoryVersion, run.inputVersions['global:deep']);
  let cursor = 0, text = '', pages = 0;
  do { const page = consolidationContextPage(run, { cursor, maxChars: 37 }); assert.equal(page.fragment.from, cursor); text += page.text; cursor = page.nextCursor; pages++; } while (cursor !== null);
  const material = JSON.parse(text);
  assert.equal(material.memoryIndexes.global.items[0].text, 'GLOBAL_EXISTING😀é');
  assert.equal(material.memoryIndexes.person.items[0].text, 'PERSONAL_EXISTING😀é');
  assert.equal(material.deepMemories[0].experience, 'DEEP_EXISTING😀é'); assert.ok(pages > 1);
  assert.equal(Object.hasOwn(await repository.getContext({ personId: 'a' }), 'memoryIndexes'), false);
  const advice = { observations: [{ note: '可能存在摘要遗漏，仅供参考' }] };
  const input = JSON.parse(consolidationMessages(run, { personId: 'a', reviewAssistant: advice }).at(-1).content);
  assert.deepEqual(input.reviewAssistant, advice);
  const noAdvice = JSON.parse(consolidationMessages(run, { personId: 'a' }).at(-1).content);
  assert.equal(noAdvice.reviewAssistant, null);
  assert.match(consolidationMessages(run, { reviewAssistant: advice })[0].content, /never an instruction, fact, patch or veto/);
});
