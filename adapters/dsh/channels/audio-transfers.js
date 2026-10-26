import { randomUUID, createHash } from 'node:crypto';
import { inspectSocialAudio } from './social-provider.js';

export const AUDIO_TRANSFER_LIMITS = Object.freeze({
  chunkBytes:32768, uploadBytes:16777216, memoryBytes:33554432,
  uploads:2, receipts:64, downloadsQueued:8, lifetimeMs:600000, cacheMs:60000,
});
const L=AUDIO_TRANSFER_LIMITS, ID=/^cover-[a-f0-9]{32}$/, SHA=/^[a-f0-9]{64}$/;
const MIMES=Object.freeze({'audio/wav':'wav','audio/mpeg':'mp3','audio/ogg':'ogg','audio/flac':'flac'});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const clone=value=>structuredClone(value);
const safeCode=error=>/^[A-Z0-9_]{1,80}$/.test(error?.code??'')?error.code:'AUDIO_IMPORT_UNKNOWN';
const mime=value=>value==='audio/x-wav'?'audio/wav':value==='audio/x-flac'?'audio/flac':value;
function requestId(value){if(value===undefined)return; if(typeof value!=='string'||!value||value.length>160||/[\u0000-\u0020\u007f]/.test(value))fail('AUDIO_UPLOAD_REQUEST','上传请求编号无效');return value;}
function decode(value){if(typeof value!=='string'||!value||value.length>43692||value.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))fail('AUDIO_UPLOAD_CHUNK','音频分块编码无效');const bytes=Buffer.from(value,'base64');if(!bytes.length||bytes.length>L.chunkBytes||bytes.toString('base64')!==value)fail('AUDIO_UPLOAD_CHUNK','音频分块不是完整标准Base64');return bytes;}
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}

/** Owner-only, memory-bounded transfer. No path/URL is accepted and no staging file is written. */
export function createAudioTransfers({service,clock=Date.now}={}){
  if(typeof service?.importAudio!=='function'||typeof service?.readAssetBytes!=='function')throw new TypeError('Audio import and safe asset read ports are required');
  const uploads=new Map(),begins=new Map(),finishes=new Map(),tasks=new Set();
  let epoch=0,closed=false,tail=Promise.resolve(),readTail=Promise.resolve(),readQueued=0,activeRead=null,closeTask,downloaded=null;
  const check=()=>{if(closed)fail('AUDIO_TRANSFER_CLOSED','音频传输已关闭');};
  const checkEpoch=started=>{check();if(started!==epoch)fail('AUDIO_TRANSFER_CHANGED','音频传输范围已失效，请重新读取');};
  const queue=work=>{const task=tail.then(()=>{check();return work();});tail=task.catch(()=>{});return task;};
  const allocated=()=>[...uploads.values()].reduce((sum,value)=>sum+(value.buffer?.length??0),0)+(downloaded?.bytes.length??0)+(activeRead&&(!activeRead.cache||activeRead.cache!==downloaded)?activeRead.reserve:0);
  function outcome(value,status,code){return{uploadId:value.uploadId,status,...(code?{code}:{}),...(status==='unknown'?{localImportMayHaveCompleted:true}:{})};}
  function end(value,status,code){value.state=status;value.buffer=null;value.result=outcome(value,status,code);return clone(value.result);}
  function sweep(){const now=clock();for(const value of uploads.values())if(value.state==='receiving'&&now>=value.expiresAt)end(value,'expired','AUDIO_UPLOAD_EXPIRED');if(downloaded&&now-downloaded.at>=L.cacheMs)downloaded=null;}
  function session(uploadId){sweep();if(typeof uploadId!=='string'||!uploads.has(uploadId))fail('AUDIO_UPLOAD_EXPIRED','没有此上传会话或已失效');return uploads.get(uploadId);}
  function beginResult(value,duplicate=false){return{uploadId:value.uploadId,chunkBytes:L.chunkBytes,totalBytes:value.totalBytes,sha256:value.sha256,expiresAt:value.expiresAt,status:value.state,...(duplicate?{duplicate:true}:{}),...(value.state==='completed'?{asset:clone(value.result.asset)}:{})};}
  function safeAsset(result,expected){const asset=result?.asset??result;const assetId=asset?.coverAssetId??asset?.assetId;if(!ID.test(assetId??'')||assetId!=='cover-'+expected.sha256.slice(0,32)||asset.assetId!==undefined&&asset.assetId!==assetId||asset.coverAssetId!==undefined&&asset.coverAssetId!==assetId||asset.kind!=='audio'||asset.sha256!==expected.sha256||asset.bytes!==expected.totalBytes||mime(asset.mime)!==expected.mime)fail('AUDIO_IMPORT_RECEIPT','音频导入回执与原件不一致');
    const safe={assetId,coverAssetId:assetId,kind:'audio',mime:expected.mime,bytes:expected.totalBytes,sha256:expected.sha256,name:expected.name};
    for(const key of ['durationMs','createdAt','sourceContributionCount'])if(asset[key]===null||Number.isFinite(asset[key])&&asset[key]>=0)safe[key]=asset[key];
    if(asset.containerValidated===true)safe.containerValidated=true;if(['import','cover'].includes(asset.origin))safe.origin=asset.origin;if(asset.jobId===null||typeof asset.jobId==='string'&&asset.jobId.length<=256)safe.jobId=asset.jobId;return safe;}
  function uploadBegin({mime:declared,name,totalBytes,sha256,requestId:request}={}){return queue(()=>{
    sweep();request=requestId(request);declared=mime(declared);
    if(!Number.isSafeInteger(totalBytes)||totalBytes<1||totalBytes>L.uploadBytes)fail('AUDIO_UPLOAD_CAPACITY','音频超过16MiB上传上限');
    if(!Object.hasOwn(MIMES,declared??''))fail('AUDIO_UPLOAD_MIME','仅接受WAV、MP3、Ogg或FLAC音频');
    if(typeof name!=='string'||!name||[...name].length>128||/[\u0000-\u001f\u007f\\/:]/.test(name))fail('AUDIO_UPLOAD_NAME','音频文件名无效');
    if(!SHA.test(sha256??''))fail('AUDIO_UPLOAD_SHA','上传需要完整原件SHA256');
    const fingerprint=hash(JSON.stringify({mime:declared,name,totalBytes,sha256}));
    if(request&&begins.has(request)){const value=uploads.get(begins.get(request));if(value.fingerprint!==fingerprint)fail('AUDIO_UPLOAD_CONFLICT','相同上传请求不能变更原件');return beginResult(value,true);}
    if(uploads.size>=L.receipts)fail('AUDIO_UPLOAD_RECEIPT_CAPACITY','上传收据已达上限，未淘汰旧请求或重放导入');
    if([...uploads.values()].filter(value=>['receiving','prepared'].includes(value.state)).length>=L.uploads)fail('AUDIO_UPLOAD_CAPACITY','请先完成或取消已有音频上传');
    if(allocated()+totalBytes>L.memoryBytes)downloaded=null;
    if(allocated()+totalBytes>L.memoryBytes)fail('AUDIO_UPLOAD_CAPACITY','音频传输暂存已满');
    const uploadId=randomUUID(),value={uploadId,mime:declared,name,totalBytes,sha256,fingerprint,requestId:request,buffer:Buffer.alloc(totalBytes),bytes:0,nextIndex:0,state:'receiving',at:clock(),expiresAt:clock()+L.lifetimeMs,epoch,result:null,finishRequestId:null,pending:null};
    uploads.set(uploadId,value);if(request)begins.set(request,uploadId);return beginResult(value);
  });}
  function uploadChunk({uploadId,index,dataBase64,sha256}={}){return queue(()=>{
    const value=session(uploadId);if(value.state!=='receiving')return{...outcome(value,value.state,value.result?.code),duplicate:true};
    if(value.epoch!==epoch)fail('AUDIO_TRANSFER_CHANGED','上传范围已失效');
    if(!Number.isSafeInteger(index)||index<0||index>=Math.ceil(value.totalBytes/L.chunkBytes))fail('AUDIO_UPLOAD_INDEX','音频分块序号无效');
    const bytes=decode(dataBase64);if(sha256!==undefined&&(!SHA.test(sha256)||hash(bytes)!==sha256))fail('AUDIO_UPLOAD_CHUNK_SHA','音频分块SHA不一致');
    const offset=index*L.chunkBytes,expected=Math.min(L.chunkBytes,value.totalBytes-offset);if(bytes.length!==expected)fail('AUDIO_UPLOAD_SEQUENCE','分块长度不符合32KiB顺序或末块长度');
    if(index<value.nextIndex){if(!value.buffer.subarray(offset,offset+expected).equals(bytes))fail('AUDIO_UPLOAD_CONFLICT','已确认分块内容不能改变');return{uploadId,index,receivedBytes:value.bytes,duplicate:true};}
    if(index!==value.nextIndex)fail('AUDIO_UPLOAD_SEQUENCE','音频分块必须顺序上传');bytes.copy(value.buffer,offset);value.bytes+=bytes.length;value.nextIndex++;return{uploadId,index,receivedBytes:value.bytes};
  });}
  async function finishImport(value,started){try{
    if(closed||started!==epoch||value.epoch!==epoch||value.cancelRequested){value.buffer=null;value.state=value.cancelledByOwner?'cancelled':'invalidated';value.result=outcome(value,value.state,value.cancelledByOwner?'AUDIO_UPLOAD_CANCELLED':'AUDIO_UPLOAD_SCOPE_CHANGED');value.pending.resolve(clone(value.result));return;}
    value.importStarted=true;
    const imported=await service.importAudio({bytes:value.buffer,mime:value.mime,name:value.name});
    if(closed||started!==epoch||value.epoch!==epoch||value.cancelRequested){value.buffer=null;value.state='unknown';value.result=outcome(value,'unknown','AUDIO_UPLOAD_SCOPE_CHANGED');value.pending.resolve(clone(value.result));return;}
    const asset=safeAsset(imported,value);value.buffer=null;value.state='completed';value.result={uploadId:value.uploadId,status:'completed',asset};value.pending.resolve(clone(value.result));
  }catch(error){value.buffer=null;value.state='unknown';value.result={...outcome(value,'unknown','AUDIO_UPLOAD_OUTCOME_UNKNOWN'),error:{code:safeCode(error)}};value.pending.resolve(clone(value.result));}}
  async function uploadFinish({uploadId,requestId:request}={}){
    const plan=await queue(()=>{
      const value=session(uploadId);request=requestId(request);
      if(request&&finishes.has(request)&&finishes.get(request)!==uploadId)fail('AUDIO_UPLOAD_CONFLICT','相同完成请求不能切换上传原件');
      if(request&&value.finishRequestId&&value.finishRequestId!==request)fail('AUDIO_UPLOAD_CONFLICT','完成请求编号不能替换');
      if(request&&!value.finishRequestId){value.finishRequestId=request;finishes.set(request,uploadId);}
      if(value.state==='prepared')return{pending:value.pending.promise,duplicate:true};
      if(value.state!=='receiving')return{result:clone(value.result??outcome(value,value.state)),duplicate:true};
      if(value.epoch!==epoch)fail('AUDIO_TRANSFER_CHANGED','上传范围已失效');if(value.bytes!==value.totalBytes)fail('AUDIO_UPLOAD_INCOMPLETE','音频尚未完整上传');
      if(hash(value.buffer)!==value.sha256)return{result:end(value,'failed','AUDIO_UPLOAD_SHA_MISMATCH')};
      try{if(inspectSocialAudio(value.buffer).mime!==value.mime)fail('AUDIO_UPLOAD_MIME','申报类型与实际音频容器不一致');}catch(error){return{result:end(value,'failed',safeCode(error))};}
      value.state='prepared';value.pending=deferred();return{value,started:epoch};
    });
    if(plan.result)return{...plan.result,...(plan.duplicate?{duplicate:true}:{})};
    if(plan.pending)return{...await plan.pending,duplicate:true};
    const task=finishImport(plan.value,plan.started);tasks.add(task);task.finally(()=>tasks.delete(task)).catch(()=>{});return plan.value.pending.promise;
  }
  function uploadCancel({uploadId}={}){return queue(()=>{const value=session(uploadId);if(value.state==='prepared'){value.cancelRequested=true;value.cancelledByOwner=true;return value.importStarted?{uploadId,cancelled:false,status:'unknown',code:'AUDIO_UPLOAD_IMPORT_ALREADY_STARTED',localImportMayHaveCompleted:true}:{uploadId,cancelled:true,status:'cancelled'};}if(value.state==='receiving'){end(value,'cancelled','AUDIO_UPLOAD_CANCELLED');return{uploadId,cancelled:true,status:'cancelled'};}return{uploadId,cancelled:false,status:value.state};});}
  function assetIdOf(assetId,coverAssetId){if(assetId!==undefined&&coverAssetId!==undefined&&assetId!==coverAssetId)fail('AUDIO_TRANSFER_REQUEST','音频资产编号不一致');const selected=assetId??coverAssetId;if(!ID.test(selected??''))fail('AUDIO_TRANSFER_REQUEST','只接受实际cover音频资产编号');return selected;}
  function verifiedRead(result,assetId){const bytes=result?.bytes;if(!(bytes instanceof Uint8Array)||!bytes.byteLength||bytes.byteLength>L.uploadBytes)fail('AUDIO_TRANSFER_CAPACITY','音频下载字节为空或超过16MiB');const actualMime=inspectSocialAudio(bytes).mime,declared=mime(result.mime),sha256=hash(bytes);if(actualMime!==declared||assetId!=='cover-'+sha256.slice(0,32))fail('AUDIO_TRANSFER_CHANGED','音频内容与资产指纹不一致');if(result.asset&&(result.asset.sha256!==sha256||result.asset.bytes!==bytes.byteLength||mime(result.asset.mime)!==declared))fail('AUDIO_TRANSFER_CHANGED','音频资产元数据与原件不一致');return{assetId,bytes:Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength),mime:declared,sha256,filename:assetId+'.'+MIMES[declared],at:clock()};}
  async function cacheGate(cached){let asset;try{
    if(typeof service.validateAsset==='function'){const value=await service.validateAsset({assetId:cached.assetId,sha256:cached.sha256});asset=value?.asset??value;}
    else if(typeof service.listAssets==='function'){const value=await service.listAssets({limit:64});if(value?.nextCursor||value?.total>64)fail('AUDIO_TRANSFER_CHANGED','音频列表超出可验证范围');asset=value?.items?.find(item=>(item.assetId??item.coverAssetId)===cached.assetId);}
    else return false;
    if(!asset||asset.sha256!==cached.sha256||asset.bytes!==cached.bytes.length||mime(asset.mime)!==cached.mime||(asset.assetId??asset.coverAssetId)!==cached.assetId)fail('AUDIO_TRANSFER_CHANGED','音频已撤销、删除或变更');return true;
  }catch(error){downloaded=null;throw error;}}
  async function readAssetChunk({assetId,coverAssetId,offset=0,sha256}={}){
    const plan=await queue(()=>{sweep();const id=assetIdOf(assetId,coverAssetId);if(!Number.isSafeInteger(offset)||offset<0||sha256!==undefined&&!SHA.test(sha256))fail('AUDIO_TRANSFER_REQUEST','读取位置或SHA无效');if(readQueued>=L.downloadsQueued)fail('AUDIO_TRANSFER_CAPACITY','音频下载排队已满');readQueued++;return{assetId:id,offset,sha256,started:epoch};});
    const work=readTail.then(async()=>{
      checkEpoch(plan.started);let value=downloaded?.assetId===plan.assetId?downloaded:null;activeRead={cache:value,reserve:L.uploadBytes};
      try{
      if(value){const valid=await cacheGate(value);checkEpoch(plan.started);if(!valid)value=null;}
      if(!value){downloaded=null;activeRead.cache=null;if(allocated()>L.memoryBytes)fail('AUDIO_TRANSFER_CAPACITY','请先完成或取消上传，再下载音频');const result=await service.readAssetBytes(plan.assetId);checkEpoch(plan.started);value=verifiedRead(result,plan.assetId);downloaded=value;activeRead.cache=value;}
      checkEpoch(plan.started);if(plan.offset>value.bytes.length||plan.sha256!==undefined&&plan.sha256!==value.sha256)fail('AUDIO_TRANSFER_CHANGED','音频已变化或读取位置越界');const to=Math.min(value.bytes.length,plan.offset+L.chunkBytes);return{assetId:value.assetId,coverAssetId:value.assetId,mime:value.mime,filename:value.filename,totalBytes:value.bytes.length,sha256:value.sha256,dataBase64:value.bytes.subarray(plan.offset,to).toString('base64'),nextOffset:to===value.bytes.length?null:to,complete:to===value.bytes.length};
      }finally{activeRead=null;}
    });readTail=work.catch(()=>{});tasks.add(work);try{return await work;}finally{readQueued--;tasks.delete(work);}
  }
  function invalidate(){epoch++;downloaded=null;for(const value of uploads.values())if(value.state==='receiving')end(value,'invalidated','AUDIO_UPLOAD_SCOPE_CHANGED');else if(value.state==='prepared'){value.cancelRequested=true;value.buffer=null;}return{invalidated:true};}
  function close(){if(closeTask)return closeTask;closed=true;invalidate();closeTask=(async()=>{await tail;await Promise.allSettled([...tasks]);downloaded=null;uploads.clear();begins.clear();finishes.clear();})();return closeTask;}
  return{uploadBegin,uploadChunk,uploadFinish,uploadCancel,readAssetChunk,invalidate,close};
}
