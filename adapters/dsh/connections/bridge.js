import { createOneBotClient } from '../channels/onebot.js';
import { capabilities, fail, identifier, mediaBytes, requestJson, targetRoute } from './common.js';

/** Additional OneBot actions are advertised only after the driver identifies
 * itself as NapCat, or explicitly enumerates the corresponding action. */
export function createBridgeClient(profile, { fetchImpl = fetch, clock = Date.now } = {}) {
  const base = createOneBotClient(profile, { fetchImpl, clock }), v11 = profile.protocol === 'onebot11', url = new URL(profile.apiUrl);
  let supported = capabilities(['chat.text']);
  async function action(name, params = {}, deliveryId) {
    const destination = v11 ? new URL(name, url.href.replace(/\/?$/, '/')) : url;
    const payload = v11 ? params : { action: name, params, self: { platform: profile.platform, user_id: profile.accountId }, ...(deliveryId ? { echo: deliveryId } : {}) };
    const result = await requestJson(fetchImpl, destination, { body: payload, headers: profile.accessToken ? { authorization: 'Bearer ' + profile.accessToken } : {} });
    if (result.status === 'failed' && Number.isSafeInteger(result.retcode) && result.retcode !== 0) fail('ONEBOT_ACTION_REJECTED');
    if (result.status !== 'ok' || result.retcode !== 0 || !v11 && deliveryId !== undefined && result.echo !== undefined && result.echo !== deliveryId) fail('ONEBOT_ACTION_UNCONFIRMED'); return result.data;
  }
  async function inspectCapabilities() {
    const list = ['chat.text', ...(base.capabilities.voice ? ['chat.voice'] : [])];
    let actions = [], napcat = false;
    try { const data = await action('get_supported_actions'); if (Array.isArray(data)) actions = data.filter(value => typeof value === 'string'); } catch {}
    if (v11) try { const version = await action('get_version_info'); napcat = /napcat/i.test(String(version?.app_name ?? '')); } catch {}
    if (v11 && napcat) {
      list.push('chat.sticker', 'chat.mention', 'message.read', 'message.forward.read', 'message.reply', 'message.retract', 'contacts.read', 'groups.read', 'chat.video');
      try { const image = await action('can_send_image'); if (image?.yes === true) list.push('chat.image'); } catch {}
    }
    if (actions.includes('delete_message')) list.push('message.retract');
    if (actions.includes('get_friend_list')) list.push('contacts.read');
    if (actions.includes('get_group_list')) list.push('groups.read');
    if(v11&&actions.includes('send_group_msg'))list.push('chat.mention');
    if(v11&&actions.includes('get_msg'))list.push('message.read');
    if(v11&&actions.includes('get_forward_msg'))list.push('message.forward.read');
    supported = {...capabilities(list),...Object.fromEntries(['chat.mention','message.read','message.forward.read'].map(id=>[id,{supported:list.includes(id),reason:list.includes(id)?null:'桥未确认此操作'}]))}; return supported;
  }
  const route = target => targetRoute(target, profile.platform, profile.accountId);
  async function send(target, segments, deliveryId) {
    if(v11){const result=await base.sendSegments(target,segments,{deliveryId});return result.status==='delivered'?{...result,messageIdKind:'server_id'}:result;}
    const selected = route(target), params = v11 ? { [selected.type === 'group' ? 'group_id' : 'user_id']: Number(selected.id), message: segments } : { detail_type: selected.type, [selected.type === 'group' ? 'group_id' : 'user_id']: selected.id, message: segments };
    const result = await action(v11 ? selected.type === 'group' ? 'send_group_msg' : 'send_private_msg' : 'send_message', params, deliveryId);
    const raw = result?.message_id; const messageId = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : typeof raw === 'string' && raw ? raw : null;
    return messageId ? { status: 'delivered', deliveryId, messageId, messageIdKind: 'server_id', receiptId: 'onebot:' + messageId, deliveredAt: clock(), confirmedBy: 'onebot-message-id' } : { status: 'unknown', deliveryId, code: 'ONEBOT_MESSAGE_ID_MISSING' };
  }
  async function execute(target, capability, payload, { deliveryId } = {}) {
    route(target); identifier(deliveryId, '交付编号', 160);
    if (capability === 'chat.text') return base.sendText(target, payload.text, { deliveryId });
    if (capability === 'chat.voice') return base.sendVoice(target, payload.bytes, { deliveryId });
    if (!supported[capability]?.supported) return { status: 'unsupported', code: 'CAPABILITY_UNSUPPORTED' };
    try {
      if(capability==='message.read')return base.getMessage({messageId:payload.messageId});
      if(capability==='message.forward.read')return base.getForward({forwardId:payload.forwardId});
      if (capability === 'contacts.read' || capability === 'groups.read') {
        const data = await action(capability === 'contacts.read' ? 'get_friend_list' : 'get_group_list');
        if (!Array.isArray(data)) fail('ONEBOT_LIST_UNCONFIRMED');
        return { status: 'completed', data: data.slice(0, 50).map(item => ({ id: String(item.user_id ?? item.group_id ?? '').slice(0, 256), name: String(item.nickname ?? item.user_name ?? item.group_name ?? '').slice(0, 128) })), complete: data.length <= 50, total: data.length, confirmedBy: 'onebot-api-success' };
      }
      if (capability === 'message.retract') { const messageId = identifier(payload.messageId); const numeric = Number(messageId); if (v11 && !Number.isSafeInteger(numeric)) fail('ONEBOT_MESSAGE_ID_INVALID'); await action(v11 ? 'delete_msg' : 'delete_message', { message_id: v11 ? numeric : messageId }, deliveryId); return { status: 'completed', receiptId: 'onebot-retract:' + deliveryId, affectedMessageId: messageId, confirmedBy: 'onebot-api-success' }; }
      if (capability === 'chat.sticker') { if(!['number','string'].includes(typeof payload.stickerId)||!/^\d{1,6}$/.test(String(payload.stickerId)))fail('ONEBOT_STICKER_ID');const face = Number(payload.stickerId); if (!Number.isSafeInteger(face) || face < 0 || face > 100000) fail('ONEBOT_STICKER_ID'); return send(target, [{ type: 'face', data: { id: face } }], deliveryId); }
      if(capability==='chat.mention'){const selected=route(target);if(selected.type!=='group')fail('ONEBOT_MENTION_TARGET','提及段仅在实际群聊目标使用');if(typeof payload.mentionAll!=='boolean'&&payload.mentionAll!==undefined)fail('ONEBOT_MENTION_TARGET');if(payload.mentionAll===true&&payload.mentionUserId!==undefined)fail('ONEBOT_MENTION_TARGET');const qq=payload.mentionAll===true?'all':identifier(payload.mentionUserId,'提及用户');if(qq!=='all'&&(!/^\d+$/.test(qq)||!Number.isSafeInteger(Number(qq))||Number(qq)<1))fail('ONEBOT_MENTION_TARGET');const segments=[{type:'at',data:{qq}}];if(payload.text!==undefined){if(typeof payload.text!=='string'||Array.from(payload.text).length>16000)fail('ONEBOT_TEXT_CAPACITY');if(payload.text)segments.push({type:'text',data:{text:payload.text}});}return send(target,segments,deliveryId);}
      if (capability === 'message.reply') { const quote = identifier(payload.quoteMessageId), text = payload.text; if (typeof text !== 'string' || !text || Array.from(text).length > 16000) fail('ONEBOT_TEXT_CAPACITY'); return send(target, [{ type: 'reply', data: { id: quote } }, { type: 'text', data: { text } }], deliveryId); }
      if (capability === 'chat.image' || capability === 'chat.video') return send(target, [{ type: capability === 'chat.image' ? 'image' : 'video', data: { file: 'base64://' + mediaBytes(payload).toString('base64') } }], deliveryId);
      return { status: 'unsupported', code: 'CAPABILITY_UNSUPPORTED' };
    } catch (error) { return { status: ['CONNECTION_AUTH_REJECTED', 'ONEBOT_ACTION_REJECTED'].includes(error.code) ? 'failed' : 'unknown', deliveryId, code: error.code ?? 'ONEBOT_OPERATION_UNKNOWN' }; }
  }
  return { ...base, inspectCapabilities, execute, get capabilities() { return base.capabilities; } };
}
