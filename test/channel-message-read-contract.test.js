import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelService } from '../adapters/dsh/channels/service.js';
import { createBridgeClient } from '../adapters/dsh/connections/bridge.js';
import { TOOL_PARAMETERS } from '../adapters/dsh/tool-schema.js';

test('message reads reject missing references before binding lookup, bridge probes, writes or requests', async t => {
  let clients = 0, writes = 0;
  const service = createChannelService({
    storage: { read: async () => null, write: async () => { writes++; } },
    getCoordinator: () => null,
    channelPort: { create: async () => { throw new Error('No native channel may be created'); }, send: async () => { throw new Error('No native input may be sent'); }, close: async () => {} },
    clientFactory: () => { clients++; throw new Error('No bridge may be reached'); },
  });
  await service.ready; t.after(() => service.close());
  const before = writes;
  for (const [capability, field, code] of [
    ['message.read', 'messageId', 'CHANNEL_MESSAGE_ID_REQUIRED'],
    ['message.forward.read', 'forwardId', 'CHANNEL_FORWARD_ID_REQUIRED'],
  ]) {
    for (const value of [undefined, null, '', '  ']) {
      await assert.rejects(service.execute({ sessionId: 'dsh:actual-route', requestId: 'test-read', capability,
        payload: value === undefined ? {} : { [field]: value } }), error => {
        assert.equal(error.code, code); assert.match(error.message, new RegExp(field));
        assert.match(error.message, /sessionId\/channelId/); return true;
      });
    }
  }
  assert.equal(clients, 0); assert.equal(writes, before);
});

async function bridgeFixture() {
  const requests = []; let mismatched = false;
  const bridge = createBridgeClient({ platform: 'qq', protocol: 'onebot11', accountId: '10001', apiUrl: 'http://127.0.0.1:9' }, {
    fetchImpl: async (url, options) => {
      const action = new URL(url).pathname.slice(1), body = JSON.parse(options.body);
      requests.push({ action, body });
      let data;
      if (action === 'get_supported_actions') data = ['get_msg', 'get_forward_msg'];
      else if (action === 'get_version_info') data = { app_name: 'read-contract-fixture' };
      else if (action === 'get_msg') data = { message_id: mismatched ? 999 : body.message_id,
        sender: { user_id: 20002 }, message: [{ type: 'text', data: { text: 'actual original' } }] };
      else if (action === 'get_forward_msg') data = { messages: [{ sender: { user_id: 20003 }, message: [{ type: 'text', data: { text: 'actual forward' } }] }] };
      else throw new Error('Unexpected action ' + action);
      return new Response(JSON.stringify({ status: 'ok', retcode: 0, data }), { headers: { 'content-type': 'application/json' } });
    },
  });
  await bridge.inspectCapabilities();
  return { bridge, requests, setMismatch: () => { mismatched = true; },
    target: { platform: 'qq', accountId: '10001', conversation: { type: 'group', id: '30001' } } };
}

test('bridge direct reads expose missing/invalid identifiers without a get_msg request or rejected promise', async () => {
  const f = await bridgeFixture(), before = f.requests.length;
  const absent = await f.bridge.execute(f.target, 'message.read', {}, { deliveryId: 'read-missing' });
  assert.equal(absent.status, 'failed'); assert.equal(absent.code, 'CHANNEL_MESSAGE_ID_REQUIRED');
  const missingForward = await f.bridge.execute(f.target, 'message.forward.read', {}, { deliveryId: 'forward-missing' });
  assert.equal(missingForward.status, 'failed'); assert.equal(missingForward.code, 'CHANNEL_FORWARD_ID_REQUIRED');
  for (const messageId of ['dsh:session-id', 'im-' + 'a'.repeat(64), '9007199254740992']) {
    const invalid = await f.bridge.execute(f.target, 'message.read', { messageId }, { deliveryId: 'read-invalid' });
    assert.equal(invalid.status, 'failed'); assert.equal(invalid.code, 'ONEBOT_MESSAGE_ID_INVALID');
    assert.match(invalid.message, /signed numeric/);
  }
  assert.equal(f.requests.length, before);
});

test('bridge read uses an actual signed platform ID and preserves mismatch failures after awaiting the driver', async () => {
  const f = await bridgeFixture();
  const message = await f.bridge.execute(f.target, 'message.read', { messageId: '-88' }, { deliveryId: 'read-real' });
  assert.equal(message.status, 'completed'); assert.equal(message.messageId, '-88'); assert.equal(message.text, 'actual original');
  assert.deepEqual(f.requests.at(-1), { action: 'get_msg', body: { message_id: -88 } });
  const forwarded = await f.bridge.execute(f.target, 'message.forward.read', { forwardId: 'real-forward-resource' }, { deliveryId: 'forward-real' });
  assert.equal(forwarded.status, 'completed'); assert.equal(forwarded.items[0].text, 'actual forward');
  assert.deepEqual(f.requests.at(-1), { action: 'get_forward_msg', body: { id: 'real-forward-resource' } });
  f.setMismatch();
  const mismatch = await f.bridge.execute(f.target, 'message.read', { messageId: '-88' }, { deliveryId: 'read-mismatch' });
  assert.equal(mismatch.code, 'ONEBOT_MESSAGE_MISMATCH'); assert.notEqual(mismatch.status, 'completed');
});

test('model-visible reference descriptions name required platform fields and distinguish routes from resources', () => {
  for (const field of ['messageId', 'forwardId']) {
    assert.match(TOOL_PARAMETERS.persona_platform[field].description, /REQUIRED/);
    assert.match(TOOL_PARAMETERS.persona_platform[field].description, /sessionId/);
  }
  assert.match(TOOL_PARAMETERS.persona_platform.messageId.description, /externalInput.platformMessageId/);
  assert.match(TOOL_PARAMETERS.persona_platform.messageId.description, /signed numeric string/);
});
