import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_PARAMETERS } from '../adapters/dsh/tool-schema.js';
import { createBilibiliService } from '../adapters/dsh/bilibili/service.js';

const READS = ['search', 'recommend', 'video', 'subtitles', 'comments', 'frames'];
const WRITES = ['comment', 'reply', 'share', 'message'];
const context = { memoryRoot: process.cwd(), accountId: '1234', deliveryId: 'contract-only' };
function assertCorrection(error, invoked) {
  assert.equal(error.code, 'BILI_OPERATION_UNSUPPORTED');
  assert.match(error.message, new RegExp('action:' + invoked));
  for (const operation of [...READS, ...WRITES]) assert.ok(error.message.includes(operation), 'Correction names ' + operation);
  assert.match(error.message, /not rerouted or sent/);
  return true;
}

test('platform action and operation schemas expose the actual Bilibili read/write pairing and QQ capability contract', () => {
  const schema = TOOL_PARAMETERS.persona_platform;
  for (const field of ['action', 'operation']) {
    assert.equal(typeof schema[field].description, 'string');
    for (const operation of [...READS, ...WRITES]) assert.ok(schema[field].description.includes(operation));
    assert.match(schema[field].description, /QQ\/WeChat/); assert.match(schema[field].description, /capability/);
  }
  assert.deepEqual(schema.action.enum, ['inspect', 'read', 'execute', 'accounts', 'job', 'cancel_job', 'assets']);
  assert.deepEqual(schema.operation.enum, [...READS, ...WRITES]);
});

test('Bilibili search and other reads invoked through execute fail with an actionable correction before auth or network', async t => {
  let reads = 0, writes = 0, grants = 0, requests = 0;
  const service = createBilibiliService({ storage: { async read() { reads++; return null; }, async write() { writes++; } }, authorize: async () => { grants++; return true; }, fetchImpl: async () => { requests++; throw Error('No network allowed'); } });
  t.after(() => service.close()); await service.ready;
  for (const operation of [...READS, 'not-an-operation']) assert.throws(() => service.execute({ operation }, context), error => assertCorrection(error, 'execute'));
  assert.equal(reads, 1); assert.equal(writes, 0); assert.equal(grants, 0); assert.equal(requests, 0);
  assert.equal((await service.inspect()).enabled, false);
});

test('Bilibili writes invoked through read remain rejected with the correct action and complete legal operation list', async t => {
  let writes = 0, grants = 0, requests = 0;
  const service = createBilibiliService({ storage: { async read() { return null; }, async write() { writes++; } }, authorize: async () => { grants++; return true; }, fetchImpl: async () => { requests++; throw Error('No network allowed'); } });
  t.after(() => service.close()); await service.ready;
  for (const operation of [...WRITES, 'not-an-operation']) assert.throws(() => service.read({ operation }, context), error => assertCorrection(error, 'read'));
  assert.equal(writes, 0); assert.equal(grants, 0); assert.equal(requests, 0);
  await assert.rejects(service.read({ operation: 'video', bvid: 'BV1234567890' }, context), { code: 'BILI_DISABLED' });
  await assert.rejects(service.execute({ operation: 'message', receiverUid: '5678', text: 'not sent' }, context), { code: 'BILI_DISABLED' });
  assert.equal(writes, 0); assert.equal(grants, 0); assert.equal(requests, 0);
});
