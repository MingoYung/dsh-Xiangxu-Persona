import { lstat, readFile } from 'node:fs/promises';
import { createLoginQr } from './login-qr.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Owner-only composition behind the existing native DSH management route. */
export function createPersonaSurfaces({ management, channels, connections, permissions, speech, mobile, getCoordinator }) {
  if (typeof management?.dispatch !== 'function' || typeof getCoordinator !== 'function') throw new TypeError('Management and current coordinator ports are required');
  return {
    async dispatch(action, args = {}) {
      if (!object(args)) fail('BAD_MANAGEMENT_REQUEST', 'An argument object is required');
      if (action.startsWith('channels.')) {
        if (!channels) fail('CHANNEL_UNAVAILABLE', '聊天渠道服务尚未就绪');
        const method = action.slice(9);
        if (!['status', 'configure', 'start', 'stop', 'probe', 'rotateIngress', 'capabilities'].includes(method)) fail('BAD_MANAGEMENT_REQUEST', 'Unknown channel action');
        return channels[method](args);
      }
      if (action.startsWith('connections.')) {
        if (!connections) fail('CONNECTION_UNAVAILABLE', '扫码连接服务尚未就绪');
        const method = action.slice(12);
        if (!['status', 'start', 'poll', 'cancel', 'disconnect'].includes(method)) fail('BAD_MANAGEMENT_REQUEST', 'Unknown connection action');
        if (method === 'disconnect') await channels?.stop({ id: args.id });
        const result = await connections[method](args);
        const withQr = item => {
          if (!item?.qrContent) return item;
          try { return { ...item, qrDataUrl: createLoginQr(item.qrContent) }; }
          catch { return { ...item, qrDataUrl: null, qrUnavailable: true }; }
        };
        return Array.isArray(result?.connections) ? { ...result, connections: result.connections.map(withQr) } : withQr(result);
      }
      if (action.startsWith('permissions.')) {
        if (!permissions) fail('PERMISSION_UNAVAILABLE', '权限服务尚未就绪');
        const method = action.slice(12);
        if (!['inspect', 'configure', 'list', 'reset'].includes(method)) fail('BAD_MANAGEMENT_REQUEST', 'Unknown permission action');
        return permissions[method](args);
      }
      if (action.startsWith('tasks.')) {
        const c = await getCoordinator(args.instanceId);
        if (!c) fail('INSTANCE_UNLOADED', '先加载人格实例再查看独立任务');
        await c.ready;
        if (c.initializationError) throw c.initializationError;
        if (c.taskInitializationError || !c.tasks) fail('TASK_UNAVAILABLE', '独立任务服务暂不可用');
        const method = action.slice(6);
        if (!['inspect', 'list', 'get', 'read', 'readChunk', 'configureLimits', 'collect', 'cancel', 'archiveFile'].includes(method)) fail('BAD_MANAGEMENT_REQUEST', 'Unknown task management action');
        const input = { ...args }; for (const key of ['instanceId', 'actor', 'sourceRefs', 'sourceRecordIds', 'parentSessionId']) delete input[key];
        if (method === 'inspect') return { ...await c.tasks.inspect(), host: c.taskHost?.capabilities?.() ?? { available: false } };
        return c.tasks[method](input);
      }
      if (action.startsWith('media.')) {
        const c = await getCoordinator(args.instanceId);
        if (!c) fail('INSTANCE_UNLOADED', '先加载人格实例再使用形象与创作');
        await c.ready;
        if (c.initializationError) throw c.initializationError;
        if (c.mediaInitializationError || !c.media) fail('MEDIA_UNAVAILABLE', '形象与创作服务暂不可用');
        const method = action.slice(6);
        if (['uploadBegin', 'uploadChunk', 'uploadFinish', 'uploadCancel', 'readAssetChunk'].includes(method)) {
          if (!c.ownerAssets) fail('MEDIA_UNAVAILABLE', '资产传输服务暂不可用');
          return c.ownerAssets[method](args);
        }
        if (!['inspect', 'configureProvider', 'probeProvider', 'listAssets', 'getAsset', 'importReference', 'updateIdentity', 'generate', 'getJob', 'listJobs', 'cancelJob', 'exportManifest', 'deleteAsset'].includes(method)) fail('BAD_MANAGEMENT_REQUEST', 'Unknown media action');
        const input = { ...args }; delete input.instanceId; delete input.actor; delete input.sourceRefs; delete input.sourceRecordIds;
        if (method === 'deleteAsset') c.ownerAssets?.invalidate();
        if (method === 'updateIdentity' || method === 'generate') return c.media[method](input, { actor: 'user' });
        if (method === 'inspect') return c.media.inspect({ includeConfiguration: input.includeConfiguration === true });
        return c.media[method](input);
      }
      if (action.startsWith('mobile.')) {
        if (!mobile) fail('MOBILE_UNAVAILABLE', '手机聊天服务尚未就绪');
        const method = action.slice(7);
        if (!['status', 'configure', 'start', 'stop', 'pair', 'revoke'].includes(method)) fail('BAD_MANAGEMENT_REQUEST', 'Unknown mobile management action');
        const result = await mobile[method](args);
        if (method === 'pair' && result?.pairUrl) {
          // Pairing already succeeded. A QR rendering failure must not encourage
          // replaying a one-time operation or conceal the usable link.
          try { const { createPairingQr } = await import('./qr.js'); return { ...result, qrDataUrl: createPairingQr(result.pairUrl) }; }
          catch { return { ...result, qrDataUrl: null, qrUnavailable: true }; }
        }
        return result;
      }
      if (action.startsWith('voice.')) {
        const c = await getCoordinator(args.instanceId);
        if (!c) fail('INSTANCE_UNLOADED', '先加载一个人格实例再设置声音');
        await c.ready;
        if (c.initializationError) throw c.initializationError;
        const sessionKey = args.sessionKey ?? 'management-ui';
        if (action === 'voice.inspect') return { ...await c.voice.inspect(sessionKey), ...(c.speechCapabilities ? { providerCapabilities: c.speechCapabilities } : {}) };
        if (action === 'voice.registerCatalog') return c.voice.registerCatalog(sessionKey, args.catalog);
        if (action === 'voice.configure') return c.voice.configure(args.patch ?? Object.fromEntries(['mode', 'allowRemoteVoices', 'userSelection'].filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]])), { sessionKey });
        if (action === 'voice.preview') {
          if (!speech) return { status: 'unavailable', reason: 'speech_provider_missing' };
          const preferences = await c.voice.inspect(sessionKey);
          if (!preferences.effective.available) return { status: 'unavailable', reason: preferences.effective.reason };
          const selection = preferences.effective;
          try {
            const result = await speech.synthesize({ text: '你好，这是一段声音试听。', voiceId: selection.resolvedVoiceId, rate: selection.rate, pitch: selection.pitch });
            if (result.status !== 'generated') return result;
            const stat = await lstat(result.path);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 524288) return { status: 'unavailable', reason: 'preview_audio_capacity' };
            const bytes = await readFile(result.path);
            return { status: 'generated', mime: 'audio/wav', bytes: bytes.length, audioDataUrl: 'data:audio/wav;base64,' + bytes.toString('base64'), rateMapping: result.rateMapping, sapiRate: result.sapiRate };
          } finally { await speech.cleanup(); }
        }
        fail('BAD_MANAGEMENT_REQUEST', 'Unknown voice management action');
      }
      return management.dispatch(action, args);
    },
  };
}
