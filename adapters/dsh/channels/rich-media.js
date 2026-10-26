import { createHash } from 'node:crypto';
import { mediaInfo } from '../media/io.js';

export const RICH_LIMITS = Object.freeze({ segments:256, snapshotBytes:131072, textChars:16000, media:32, mentions:64, replies:32, faces:64, forwards:32, forwardMessages:32, forwardDepth:2, mediaBytes:8388608, transcriptChars:8000, operationMs:30000 });
export const ONEBOT_RICH_SOURCES = Object.freeze({onebotApi:'https://github.com/botuniverse/onebot-11/blob/master/api/public.md',segments:'https://github.com/botuniverse/onebot-11/blob/master/message/segment.md',napcatRecord:'https://github.com/NapNeko/NapCatQQ/blob/3420f0b76d7dc0ac92cde1663f21ea27f61e13bb/packages/napcat-onebot/action/file/GetRecord.ts',napcatFile:'https://github.com/NapNeko/NapCatQQ/blob/3420f0b76d7dc0ac92cde1663f21ea27f61e13bb/packages/napcat-onebot/action/file/GetFile.ts',napcatForward:'https://github.com/NapNeko/NapCatQQ/blob/3420f0b76d7dc0ac92cde1663f21ea27f61e13bb/packages/napcat-onebot/action/go-cqhttp/GetForwardMsg.ts',checkedOn:'2026-10-27'});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const digest=value=>createHash('sha256').update(Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const clone=value=>structuredClone(value);
const fileId=value=>typeof value==='string'&&/^[A-Za-z0-9_.@+-]{1,512}$/.test(value)&&value!=='.'&&value!=='..'?value:null;
export function normalizeForwardId(value){if(fileId(value))return value;if(typeof value==='string'&&value.length<=512&&value.length%4===0&&/^[A-Za-z0-9+/]+={0,2}$/.test(value)&&Buffer.from(value,'base64').toString('base64')===value)return value;return null;}
function id(value,{numeric=false,message=false}={}){if(typeof value==='number'){if(!Number.isSafeInteger(value))fail('ONEBOT_ID_INVALID','消息引用标识超出保真范围');value=String(value);}if(typeof value!=='string'||!value||value.length>256||/[\u0000-\u0020\u007f]/.test(value))fail('ONEBOT_ID_INVALID','消息引用标识无效');if(numeric){if(!(message?/^-?\d+$/:/^\d+$/).test(value)||!Number.isSafeInteger(Number(value))||!message&&Number(value)<1)fail('ONEBOT_ID_INVALID','OneBot11消息引用需要保真数字标识');return String(Number(value));}return value;}
function safeOriginal(segments){
  let omitted=false,nodes=0;
  const placeholder=value=>object(value)&&value.transportOmitted===true&&/^[a-f0-9]{64}$/.test(value.sha256??'')&&Object.keys(value).every(key=>['transportOmitted','sha256'].includes(key));
  const sensitive=/^(?:url|path|file_path|local_path|download_url|base64|access[_-]?token|token|api[_-]?key|authorization|cookie|password|secret)$/i;
  const walk=(value,key='',depth=0,verbatim=false)=>{
    if(++nodes>8192||depth>16)fail('ONEBOT_EVENT_CAPACITY','消息段结构超过技术容量');
    if(!verbatim&&!placeholder(value)&&(sensitive.test(key)||/^(?:file|file_id)$/i.test(key)&&!fileId(value)||typeof value==='string'&&/^(?:https?:|file:|data:|base64:|[a-z]:[\\/]|\\\\|\.\.?[\\/]|\/)/i.test(value))){if(value===undefined)fail('ONEBOT_MESSAGE_FORMAT','消息段含非JSON字段');omitted=true;return{transportOmitted:true,sha256:digest(value)};}
    if(typeof value==='string'||value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
    if(Array.isArray(value))return value.map(item=>walk(item,'',depth+1,verbatim));
    if(!object(value))fail('ONEBOT_MESSAGE_FORMAT','原消息段必须是有限JSON');const result={};
    for(const[name,item]of Object.entries(value)){if(['__proto__','prototype','constructor'].includes(name))fail('ONEBOT_MESSAGE_FORMAT','消息段含保留字段');result[name]=walk(item,name,depth+1,verbatim||key==='data'&&name==='text');}return result;
  };
  return{segments:segments.map(segment=>({type:segment.type,data:walk(segment.data,'data')})),omitted};
}

/** Exact text and ordered segment facts are separate; no locator is fetched by this decoder. */
export function decodeOneBotSegments(segments,{protocol='onebot11'}={}){
  if(!Array.isArray(segments)||segments.length>RICH_LIMITS.segments)fail('ONEBOT_MESSAGE_FORMAT','OneBot消息必须是有界消息段数组');
  const texts=[],types=new Set(),mentions=[],replies=[],faces=[],media=[],forwards=[];const numeric=protocol==='onebot11';
  for(const [segmentIndex,segment]of segments.entries()){
    if(!object(segment)||typeof segment.type!=='string'||!segment.type||segment.type.length>64||!object(segment.data))fail('ONEBOT_MESSAGE_FORMAT','OneBot消息段无效');const data=segment.data;
    if(segment.type==='text'){if(typeof data.text!=='string')fail('ONEBOT_MESSAGE_FORMAT','文字消息段缺少原文');texts.push(data.text);continue;}types.add(segment.type);
    if(['at','mention','mention_all'].includes(segment.type)){const raw=segment.type==='mention_all'?'all':data.qq??data.user_id;if(raw==='all')mentions.push({segmentIndex,userId:null,all:true});else mentions.push({segmentIndex,userId:id(raw,{numeric}),all:false});}
    else if(segment.type==='reply')replies.push({segmentIndex,messageId:id(data.id??data.message_id,{numeric,message:true})});
    else if(segment.type==='face'){if(!['number','string'].includes(typeof data.id)||!/^\d{1,6}$/.test(String(data.id)))fail('ONEBOT_MESSAGE_FORMAT','表情标识无效');const face=Number(data.id);if(!Number.isSafeInteger(face)||face<0||face>100000)fail('ONEBOT_MESSAGE_FORMAT','表情标识无效');faces.push({segmentIndex,faceId:String(face)});}
    else if(['image','record','audio','voice','video','file'].includes(segment.type)){const kind=segment.type==='image'?'image':['record','audio','voice'].includes(segment.type)?'audio':segment.type;const value=fileId(data.file_id??data.file);media.push({segmentIndex,kind,...(value?{fileId:value}:{}),status:'unresolved',reason:value?'bridge_resolution_required':'bridge_file_id_missing'});}
    else if(['forward','node'].includes(segment.type)){const value=normalizeForwardId(data.id??data.res_id??data.message_id);forwards.push({segmentIndex,...(value?{forwardId:value}:{}),embedded:Array.isArray(data.content),status:'unread'});}
  }
  const text=texts.join('');if(Array.from(text).length>RICH_LIMITS.textChars)fail('ONEBOT_EVENT_CAPACITY','文字超过技术容量，未截断原话');
  for(const[rows,max]of[[mentions,RICH_LIMITS.mentions],[replies,RICH_LIMITS.replies],[faces,RICH_LIMITS.faces],[media,RICH_LIMITS.media],[forwards,RICH_LIMITS.forwards]])if(rows.length>max)fail('ONEBOT_EVENT_CAPACITY','丰富消息引用超过技术容量');
  const original=safeOriginal(segments),rich={schemaVersion:'xiangxu-onebot-rich/1',protocol,originalSegments:original.segments,rawSegmentsSha256:digest(segments),transportLocatorsOmitted:original.omitted,mentions,replies,faces,media,forwards,hasStructuredContent:types.size>0,perception:{images:'not_attached',audio:'not_transcribed'}};
  if(Buffer.byteLength(JSON.stringify(rich))>RICH_LIMITS.snapshotBytes)fail('ONEBOT_EVENT_CAPACITY','丰富消息快照超过技术容量，未截断原始段');return{text,unsupportedSegments:[...types],rich};
}

export function validateRichEvent(value,{text}={}){
  if(!object(value)||value.schemaVersion!=='xiangxu-onebot-rich/1'||!['onebot11','onebot12'].includes(value.protocol)||!Array.isArray(value.originalSegments)||!/^([a-f0-9]{64})$/.test(value.rawSegmentsSha256)||typeof value.transportLocatorsOmitted!=='boolean'||typeof value.hasStructuredContent!=='boolean'||!object(value.perception))fail('ONEBOT_RICH_INVALID','丰富消息事实格式无效');
  const bounded=[['mentions',RICH_LIMITS.mentions],['replies',RICH_LIMITS.replies],['faces',RICH_LIMITS.faces],['media',RICH_LIMITS.media],['forwards',RICH_LIMITS.forwards]];for(const[name,max]of bounded)if(!Array.isArray(value[name])||value[name].length>max)fail('ONEBOT_RICH_INVALID','丰富消息引用格式无效');
  if(value.originalSegments.length>RICH_LIMITS.segments||Buffer.byteLength(JSON.stringify(value))>RICH_LIMITS.snapshotBytes)fail('ONEBOT_EVENT_CAPACITY','丰富消息事实超过技术容量');
  for(const segment of value.originalSegments)if(!object(segment)||typeof segment.type!=='string'||!object(segment.data))fail('ONEBOT_RICH_INVALID','原始段快照无效');
  for(const rows of bounded.map(([name])=>value[name]))for(const item of rows)if(!object(item)||!Number.isInteger(item.segmentIndex)||item.segmentIndex<0||item.segmentIndex>=value.originalSegments.length)fail('ONEBOT_RICH_INVALID','丰富消息索引无效');
  const normalized=decodeOneBotSegments(value.originalSegments,{protocol:value.protocol});for(const name of['mentions','replies','faces','media','forwards','hasStructuredContent'])if(JSON.stringify(normalized.rich[name])!==JSON.stringify(value[name]))fail('ONEBOT_RICH_INVALID','丰富消息引用与原始段不一致');
  if(text!==undefined&&text!==normalized.text)fail('ONEBOT_RICH_INVALID','原始文字与消息段不一致');
  if(Object.keys(value).some(key=>!['schemaVersion','protocol','originalSegments','rawSegmentsSha256','transportLocatorsOmitted','mentions','replies','faces','media','forwards','hasStructuredContent','perception'].includes(key))||Object.keys(value.perception).some(key=>!['images','audio'].includes(key))||value.perception.images!=='not_attached'||value.perception.audio!=='not_transcribed')fail('ONEBOT_RICH_INVALID','入站原始段不能冒认已经获得媒体理解');
  // Transport omissions are explicit hash placeholders. An externally supplied snapshot cannot smuggle a raw URL/key back in.
  if(normalized.rich.transportLocatorsOmitted)fail('ONEBOT_RICH_INVALID','丰富消息快照含未移除的传输凭据或定位符');
  return clone(value);
}

export function decodeForwardMessages(value,{protocol='onebot11',depth=0}={}){
  if(depth>RICH_LIMITS.forwardDepth)fail('ONEBOT_FORWARD_CAPACITY','合并转发嵌套超过技术容量');const messages=value?.messages??value?.message;
  if(!Array.isArray(messages)||messages.length>RICH_LIMITS.forwardMessages)fail('ONEBOT_FORWARD_CAPACITY','合并转发消息数量无效或超过技术容量');
  const items=messages.map((node,index)=>{if(!object(node))fail('ONEBOT_FORWARD_FORMAT','合并转发节点无效');const data=node.type==='node'?node.data:node;if(!object(data))fail('ONEBOT_FORWARD_FORMAT','合并转发节点缺失');const content=data.content??data.message;
    if(!Array.isArray(content))return{index,status:'unparsed',reason:'bridge_returned_non_segment_content',text:null,claimedSender:null};
    const decoded=decodeOneBotSegments(content,{protocol}),sender=data.sender??{},rawId=sender.user_id??data.user_id??data.uin;let userId=null;if(rawId!==undefined)userId=id(rawId,{numeric:protocol==='onebot11'});const name=sender.nickname??data.nickname??data.name;if(name!==undefined&&(typeof name!=='string'||Array.from(name).length>256||/[\u0000-\u001f\u007f]/.test(name)))fail('ONEBOT_FORWARD_CAPACITY','转发署名字段超过技术容量或无效');if(data.time!==undefined&&(!Number.isFinite(data.time)||data.time<0||!Number.isSafeInteger(Math.round(data.time*1000))))fail('ONEBOT_FORWARD_FORMAT','转发时间无效');
    const embeddedForwards=content.filter(segment=>segment?.type==='forward'&&Array.isArray(segment.data?.content)).map(segment=>decodeForwardMessages({messages:segment.data.content},{protocol,depth:depth+1}));
    return{index,status:'read',claimedSender:{userId,displayName:name??null,identityVerified:false},createdAt:data.time!==undefined?Math.round(data.time*1000):null,text:decoded.text,rich:decoded.rich,...(embeddedForwards.length?{embeddedForwards}:{})};});
  const result={status:'completed',items,total:items.length,complete:true,source:'onebot-forward-api',currentSenderIsForwardAuthor:false};if(Buffer.byteLength(JSON.stringify(result))>RICH_LIMITS.snapshotBytes)fail('ONEBOT_FORWARD_CAPACITY','合并转发内容超过技术容量，未冒称全部读取');return result;
}

/** Container/header validation, not codec playback or model perception. */
export function sniffInboundMedia(bytes,kind){
  if(!(bytes instanceof Uint8Array)||!bytes.byteLength||bytes.byteLength>RICH_LIMITS.mediaBytes)fail('ONEBOT_MEDIA_CAPACITY','媒体字节为空或超过技术容量');const b=Buffer.from(bytes);
  if(kind==='image'){const info=mediaInfo(b,'image');return{mime:info.mime,width:info.width,height:info.height,containerValidated:true};}
  if(kind!=='audio')fail('ONEBOT_MEDIA_UNSUPPORTED','此解析口仅提供图片和音频字节');let mime;
  if(b.length>=44&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WAVE'&&b.readUInt32LE(4)+8===b.length){let at=12,fmt=false,data=false;while(at+8<=b.length){const name=b.toString('ascii',at,at+4),n=b.readUInt32LE(at+4),start=at+8;if(start+n>b.length)fail('ONEBOT_MEDIA_FORMAT','WAV数据截断');if(name==='fmt '){if(n<16||![1,3,65534].includes(b.readUInt16LE(start))||b.readUInt16LE(start+2)<1||b.readUInt16LE(start+2)>8||b.readUInt32LE(start+4)<8000||b.readUInt32LE(start+4)>192000)fail('ONEBOT_MEDIA_FORMAT','WAV格式头无效');fmt=true;}if(name==='data'&&n>0)data=true;at=start+n+n%2;}if(!fmt||!data||at!==b.length)fail('ONEBOT_MEDIA_FORMAT','WAV缺少音频数据');mime='audio/wav';}
  else if(b.length>=32&&b.toString('ascii',0,4)==='OggS'&&b[4]===0&&(b.includes(Buffer.from('OpusHead'))||b.includes(Buffer.from('vorbis'))))mime='audio/ogg';
  else if(b.length>=42&&b.toString('ascii',0,4)==='fLaC')mime='audio/flac';
  else if(b.length>12&&(b.toString('ascii',0,6)==='#!AMR\n'||b.toString('ascii',0,9)==='#!AMR-WB\n'))mime='audio/amr';
  else {let at=0;if(b.toString('ascii',0,3)==='ID3'&&b.length>=10){if([...b.subarray(6,10)].some(n=>n>127))fail('ONEBOT_MEDIA_FORMAT','MP3标签长度无效');at=10+((b[6]<<21)|(b[7]<<14)|(b[8]<<7)|b[9]);}if(at+4<b.length&&b[at]===255&&(b[at+1]&224)===224&&(b[at+1]&6)!==0&&(b[at+2]&240)!==0&&(b[at+2]&240)!==240&&(b[at+2]&12)!==12)mime='audio/mpeg';}
  if(!mime)fail('ONEBOT_MEDIA_FORMAT','未识别到支持的音频容器');return{mime,containerValidated:true};
}

const strictBase64=value=>{if(typeof value!=='string'||value.length>Math.ceil(RICH_LIMITS.mediaBytes/3)*4||value.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))fail('ONEBOT_MEDIA_FORMAT','桥接Base64格式或容量无效');const bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value)fail('ONEBOT_MEDIA_FORMAT','桥接Base64不是完整标准编码');return bytes;};
async function boundedPort(work,signal){signal.throwIfAborted();let abort;const aborted=new Promise((_,reject)=>{abort=()=>reject(Object.assign(new Error('配置的媒体解析端口已取消或超时'),{code:'ONEBOT_MEDIA_ABORTED'}));signal.addEventListener('abort',abort,{once:true});});try{return await Promise.race([Promise.resolve().then(work),aborted]);}finally{signal.removeEventListener('abort',abort);}}

/** Only bridge-confirmed base64 or an explicitly trusted attachment port can supply bytes. */
export async function resolveBridgeMedia(action,{kind,fileId:requested},ports={}){
  ports.signal?.throwIfAborted();const selected=fileId(requested);if(!selected||!['image','audio'].includes(kind))fail('ONEBOT_MEDIA_REFERENCE','媒体解析只接收实际桥文件ID与image/audio类型');const response=await action(kind==='image'?'get_image':'get_record',{file:selected,...(kind==='audio'?{out_format:'wav'}:{})});
  if(!object(response))fail('ONEBOT_MEDIA_UNCONFIRMED','桥未返回媒体描述');const deadline=AbortSignal.timeout(RICH_LIMITS.operationMs),signal=ports.signal?AbortSignal.any([ports.signal,deadline]):deadline;let bytes;
  if(typeof response.base64==='string'&&response.base64)bytes=strictBase64(response.base64);
  else if(typeof ports.attachmentPort?.resolveBridgeMedia==='function'){
    let trustedUrl;const raw=response.url;if(typeof raw==='string'&&raw){try{const url=new URL(raw);if(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&(ports.trustedMediaOrigins??[]).includes(url.origin))trustedUrl=url.href;}catch{}}
    const value=await boundedPort(()=>ports.attachmentPort.resolveBridgeMedia({kind,fileId:selected,...(trustedUrl?{trustedUrl}:{}),signal,bridgeConfirmed:true}),signal);bytes=value?.bytes;
  }
  if(!(bytes instanceof Uint8Array))return{status:'unresolved',kind,fileId:selected,reason:'bridge_returned_no_safe_bytes',perception:{attached:false,transcribed:false}};
  const info=sniffInboundMedia(bytes,kind),result={status:'resolved',kind,fileId:selected,bytes:Buffer.from(bytes),mime:info.mime,sha256:digest(Buffer.from(bytes)),containerValidated:true,...(info.width?{width:info.width,height:info.height}:{}),perception:{attached:false,transcribed:false}};
  if(kind==='audio'&&typeof ports.sttPort?.transcribe==='function'){try{const value=await boundedPort(()=>ports.sttPort.transcribe({bytes:result.bytes,mime:result.mime,signal,source:{kind:'onebot-bridge-media',fileId:selected}}),signal);if(value?.status==='completed'&&typeof value.text==='string'&&Array.from(value.text).length<=RICH_LIMITS.transcriptChars&&typeof value.providerId==='string'&&value.providerId.length<=256)result.transcript={text:value.text,providerId:value.providerId,source:'configured-stt',isUserOriginalText:false};else result.transcription={status:'unavailable',code:'STT_NOT_CONFIRMED'};}catch(error){result.transcription={status:'unavailable',code:/^[A-Z0-9_]{1,80}$/.test(error?.code??'')?error.code:'STT_FAILED'};}result.perception.transcribed=Boolean(result.transcript);}
  return result;
}
