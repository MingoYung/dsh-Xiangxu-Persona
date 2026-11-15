import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../core/store.js';
import { createInstanceManager } from '../adapters/dsh/instances.js';
import { createNativeDeliveryFacts } from '../adapters/dsh/native-delivery-facts.js';
import { scanManagedText } from '../adapters/dsh/instance-lifecycle.js';

test('native delivery facts are included in clear previews and removed only by confirmed instance clear', async t => {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const base = await fs.realpath(await fs.mkdtemp(path.join(temporaryRoot, 'xiangxu-delivery-clear-')));
  const root = path.join(base, 'memory');
  const createCoordinator = ({ memoryRoot }) => {
    const store = new JsonStore(memoryRoot);
    const facts = createNativeDeliveryFacts({ store, clock: () => 100 });
    const ready = (async () => {
      await store.open();
      await store.transaction({ json: { 'config.json': { schemaVersion: 'persona-memory/3' } } });
      await facts.open();
      await facts.admit([{ eventId: 'ev-clear', sourceSessionId: 'clear-session', sourceEventId: 'clear-input', text: 'input' }],
        { sessionId: 'clear-session', turn: 1, streamObserved: true });
      await facts.recordOutput({ sourceSessionId: 'clear-session', sourceEventId: 'clear-reply', channelId: 'dsh:clear-session',
        text: 'reply', status: 'delivered', deliveredAt: 100, evidence: 'native_visible_assistant_event', settledPendingEventIds: ['ev-clear'] });
    })();
    return { memoryRoot, agents: new Map(), ready,
      repository: { getRuntime: async () => ({ execution: { consolidationJobs: {} } }) },
      close: async () => { await ready; await store.close(); } };
  };
  const manager = createInstanceManager({ initialRoot: root, registryPath: path.join(base, 'instances.json'), createCoordinator });
  t.after(async () => {
    await manager.close();
    assert.ok(base.startsWith(temporaryRoot + path.sep) && path.basename(base).startsWith('xiangxu-delivery-clear-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  await manager.ready;
  assert.equal(manager.initializationError, null);
  const file = path.join(root, 'host-delivery-facts.json');
  const before = await fs.readFile(file);
  const facts = JSON.parse(before);
  assert.equal(facts.presentations.length, 1);
  assert.equal(facts.outputs[0].sourceEventId, 'clear-reply');

  const sentinel = path.join(root, 'host-delivery-facts-copy.json');
  await fs.writeFile(sentinel, before);
  await assert.rejects(manager.clearPreview(), { code: 'INSTANCE_CLEAR_UNKNOWN_FILE' });
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual(await fs.readFile(sentinel), before);
  assert.ok(manager.current, 'an unknown filename must leave the active instance intact');
  await fs.unlink(sentinel);

  const { items } = await manager.listInstances();
  const plan = await scanManagedText(root, items, 'default');
  const entry = plan.files.find(row => row.path === 'host-delivery-facts.json');
  assert.equal(entry?.bytes, before.length, 'the delivery facts must belong to the exact managed clear plan');
  const preview = await manager.clearPreview();
  assert.equal(preview.files, plan.files.length);
  assert.deepEqual(await fs.readFile(file), before, 'a preview must leave actual delivery evidence unchanged');
  const receipt = await manager.clear({ confirmationToken: preview.confirmationToken, typedName: preview.requiresName });
  assert.equal(receipt.status, 'cleared');
  assert.equal(receipt.remainingFiles, 0);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.equal(manager.current, null);
});
