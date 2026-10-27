import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {QQ_NATIVE_PROTOCOL,QQ_NATIVE_ABI_VERSION} from './assets.mjs';
import {createNativeJournal,operationIdValid} from './journal.mjs';

export const QQ_NATIVE_LIMITS=Object.freeze({bodyBytes:16384,responseBytes:1048576,options:128,optionsMs:300000,queryMs:10000,nativeMs:10000,queue:16,journalEntries:2048,textChars:512});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const fail=(code,status=503)=>{throw Object.assign(new Error(code),{code,httpStatus:status});};
const uin=value=>typeof value==='string'&&/^\d{1,16}$/.test(value)&&Number.isSafeInteger(Number(value))&&Number(value)>0;
const ref=(prefix)=>prefix+randomBytes(16).toString('hex');
const safeCode=error=>typeof error?.code==='string'&&/^QQ_NATIVE_[A-Z0-9_]{1,80}$/.test(error.code)?error.code:'QQ_NATIVE_OPERATION_UNKNOWN';
function method(value,name){for(let depth=0;value&&depth<5;depth++,value=Object.getPrototypeOf(value)){const descriptor=Object.getOwnPropertyDescriptor(value,name);if(descriptor)return Object.hasOwn(descriptor,'value')&&typeof descriptor.value==='function'?descriptor.value:null;}return null;}
function within(base,file){const relative=path.relative(path.resolve(base),path.resolve(file));return !relative||!relative.startsWith('..')&&!path.isAbsolute(relative);}

export function validateNativeConfig(config){
  if(!object(config)||config.schemaVersion!=='xiangxu-qq-native-config/1'||config.host!=='127.0.0.1'||!Number.isInteger(config.port)||config.port<0||config.port>65535||typeof config.token!=='string'||!/^[A-Za-z0-9_-]{40,256}$/.test(config.token)||typeof config.bootId!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(config.bootId)||config.expectedAccountId!==null&&!uin(config.expectedAccountId))fail('QQ_NATIVE_CONFIG_INVALID',400);
  for(const key of ['markerPath','journalRoot','qqInstallRoot','officialBundlePath','assetRoot'])if(!path.isAbsolute(config[key]??''))fail('QQ_NATIVE_CONFIG_PATH',400);
  if(within(config.qqInstallRoot,config.markerPath)||within(config.qqInstallRoot,config.journalRoot)||config.markerPath===config.officialBundlePath)fail('QQ_NATIVE_CONFIG_PATH',400);
  let url;try{url=new URL(config.onebotApiUrl);}catch{fail('QQ_NATIVE_ONEBOT_URL',400);}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||typeof config.onebotToken!=='string'||!config.onebotToken||config.onebotToken.length>4096||/[\u0000-\u001f\u007f]/.test(config.onebotToken)||config.onebotToken===config.token)fail('QQ_NATIVE_ONEBOT_URL',400);
  if(config.abiVersion!==undefined&&config.abiVersion!==QQ_NATIVE_ABI_VERSION)fail('QQ_NATIVE_ABI_MISMATCH',400);
  return config;
}

/** Same-session native transport. The caller owns capability permission and persona policy. */
export async function startNativeService({session,config,fetchImpl=fetch,fsPort=fs,clock=Date.now,onebotPort,readinessPort,journalPort,queryTimeoutMs=QQ_NATIVE_LIMITS.queryMs,nativeTimeoutMs=QQ_NATIVE_LIMITS.nativeMs,healthIntervalMs=2000,onDiagnostic=()=>{}}={}){
  validateNativeConfig(config);if(!session||typeof session!=='object')fail('QQ_NATIVE_SESSION_UNAVAILABLE');
  if(!Number.isInteger(queryTimeoutMs)||queryTimeoutMs<1||queryTimeoutMs>60000||!Number.isInteger(nativeTimeoutMs)||nativeTimeoutMs<1||nativeTimeoutMs>60000||!Number.isInteger(healthIntervalMs)||healthIntervalMs<0||healthIntervalMs>60000)fail('QQ_NATIVE_CONFIG_INVALID',400);
  const journal=journalPort??createNativeJournal({journalRoot:config.journalRoot,fsPort});
  const options=new Map(),controller=new AbortController(),codes=[];let closed=false,accountId=null,ready=false,accountChanged=false,generation=0,buddy=null,tail=Promise.resolve(),queued=0,active=0,boundPort=config.port;
  const inFlight=new Set(),secretHash=digest(config.token);
  function diagnostic(code){if(!codes.includes(code)&&codes.length<24)codes.push(code);try{onDiagnostic(code);}catch{}}
  function message(error){let value=String(error?.message??'');for(const secret of [config.token,config.onebotToken])value=value.replaceAll(secret,'[redacted]');return value.replace(/https?:\/\/\S+/g,'[platform-link]').replace(/[A-Za-z0-9_-]{40,}/g,'[redacted]').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,512);}
  async function safe(file){let cursor=path.parse(path.resolve(file)).root;for(const part of path.resolve(file).slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,part);try{const stat=await fsPort.lstat(cursor);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink!==1)fail('QQ_NATIVE_STATE_PATH');}catch(error){if(error.code!=='ENOENT')throw error;}}}
  let markerTail=Promise.resolve();
  function marker(phase){const value={schemaVersion:'xiangxu-qq-native-marker/1',protocol:QQ_NATIVE_PROTOCOL,bootId:config.bootId,pid:process.pid,phase,ready,accountId,abiVersion:QQ_NATIVE_ABI_VERSION,port:boundPort,codes:[...codes]};const task=markerTail.then(async()=>{let temporary;try{await safe(config.markerPath);await fsPort.mkdir(path.dirname(config.markerPath),{recursive:true});temporary=config.markerPath+'.next-'+randomUUID();await safe(temporary);const handle=await fsPort.open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}await safe(config.markerPath);await fsPort.rename(temporary,config.markerPath);}catch{diagnostic('QQ_NATIVE_MARKER_WRITE_FAILED');if(temporary)try{await fsPort.unlink(temporary);}catch{}}});markerTail=task.catch(()=>{});return task;}
  async function onebot(action,params={}){
    if(onebotPort)return onebotPort(action,params);
    const response=await fetchImpl(new URL(action,config.onebotApiUrl.replace(/\/?$/,'/')).href,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:'Bearer '+config.onebotToken},body:JSON.stringify(params),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});
    if(!response.ok)fail('QQ_NATIVE_ONEBOT_UNAVAILABLE');const declared=Number(response.headers.get('content-length'));if(Number.isFinite(declared)&&declared>QQ_NATIVE_LIMITS.responseBytes)fail('QQ_NATIVE_RESPONSE_CAPACITY');
    const chunks=[];let bytes=0;for await(const chunk of response.body){bytes+=chunk.length;if(bytes>QQ_NATIVE_LIMITS.responseBytes)fail('QQ_NATIVE_RESPONSE_CAPACITY');chunks.push(Buffer.from(chunk));}return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async function current(){
    try{
    if(closed)fail('QQ_NATIVE_CLOSED');if(accountChanged)fail('QQ_NATIVE_ACCOUNT_CHANGED');
    let found;
    if(readinessPort)found=await readinessPort();
    else{const login=await onebot('get_login_info'),status=await onebot('get_status');found={accountId:login.status==='ok'&&login.retcode===0?String(login.data?.user_id??''):null,ready:status.status==='ok'&&status.retcode===0&&status.data?.online===true&&status.data?.good===true};}
    if(closed)fail('QQ_NATIVE_CLOSED');
    if(!uin(found?.accountId)||found.ready!==true){fail('QQ_NATIVE_NOT_READY');}
    if(config.expectedAccountId!==null&&config.expectedAccountId!==found.accountId||accountId!==null&&accountId!==found.accountId){ready=false;accountChanged=true;options.clear();await marker('account_changed');fail('QQ_NATIVE_ACCOUNT_CHANGED');}
    accountId=found.accountId;
    if(!buddy){const get=method(session,'getBuddyService');if(!get)fail('QQ_NATIVE_BUDDY_UNAVAILABLE');buddy=Reflect.apply(get,session,[]);}
    ready=true;return accountId;
    }catch(error){ready=false;generation++;options.clear();throw error;}
  }
  const envelope=value=>({protocol:QQ_NATIVE_PROTOCOL,bootId:config.bootId,accountId,...value});
  function capability(){const query=Boolean(buddy&&method(buddy,'getTargetBuddySettingByType')&&method(buddy,'addKernelBuddyListener')&&method(buddy,'removeKernelBuddyListener'));return{query:{supported:query,available:query&&ready},request:{supported:query&&Boolean(method(buddy,'reqToAddFriends')),available:query&&Boolean(method(buddy,'reqToAddFriends'))&&ready},respond:{supported:false,available:false}};}
  async function inspect(){try{await current();}catch(error){ready=false;diagnostic(safeCode(error));}await marker(closed?'closed':ready?'ready':'waiting_account');return envelope({ready,abiVersion:QQ_NATIVE_ABI_VERSION,capabilities:capability(),busy:active>0,limits:QQ_NATIVE_LIMITS});}
  function queue(work){if(closed)return Promise.reject(Object.assign(new Error('QQ_NATIVE_CLOSED'),{code:'QQ_NATIVE_CLOSED'}));if(queued>=QQ_NATIVE_LIMITS.queue)return Promise.reject(Object.assign(new Error('QQ_NATIVE_QUEUE_CAPACITY'),{code:'QQ_NATIVE_QUEUE_CAPACITY'}));queued++;const task=tail.then(async()=>{active++;try{return await work();}finally{active--;}});tail=task.catch(()=>{});return task.finally(()=>{queued--;});}
  async function isFriend(userId){const result=await onebot('get_friend_list');if(result.status!=='ok'||result.retcode!==0||!Array.isArray(result.data))fail('QQ_NATIVE_FRIEND_LIST_UNCONFIRMED');return result.data.some(item=>String(item?.user_id??'')===userId);}
  function remember(userId,setting,relationship){
    for(const [id,value]of options)if(value.expiresAt<=clock())options.delete(id);
    if(options.size>=QQ_NATIVE_LIMITS.options)fail('QQ_NATIVE_OPTIONS_CAPACITY',429);
    const targetRef='qqtarget_'+digest([accountId,userId]).slice(0,32),optionsRef=ref('qqopts_'),expiresAt=clock()+QQ_NATIVE_LIMITS.optionsMs;
    options.set(optionsRef,{accountId,userId,targetRef,optionsRef,expiresAt,setting,relationship,generation});
    const supported=relationship==='friend'||setting.addFriendSetting===1&&setting.question.length===0;
    return envelope({targetRef,optionsRef,userId,relationship,addFriendSetting:setting?.addFriendSetting??null,requirements:{supported,verificationText:relationship!=='friend',questionCount:setting?.question.length??0,...(!supported?{code:'QQ_NATIVE_REQUIREMENTS_UNSUPPORTED'}:{})},expiresAt});
  }
  async function query({userId}={}){return queue(async()=>{
    if(!uin(userId))fail('QQ_NATIVE_USER_ID',400);await current();const queryGeneration=generation;
    if(await isFriend(userId)){await current();if(queryGeneration!==generation)fail('QQ_NATIVE_QUERY_STALE',409);return remember(userId,null,'friend');}
    const stranger=await onebot('get_stranger_info',{user_id:Number(userId)});
    if(stranger.status!=='ok'||stranger.retcode!==0||String(stranger.data?.user_id??'')!==userId||typeof stranger.data.uid!=='string'||!/^u_[A-Za-z0-9_-]{1,128}$/.test(stranger.data.uid))fail('QQ_NATIVE_TARGET_UNCONFIRMED');
    const getter=method(buddy,'getTargetBuddySettingByType'),add=method(buddy,'addKernelBuddyListener'),remove=method(buddy,'removeKernelBuddyListener');if(!getter||!add||!remove)fail('QQ_NATIVE_QUERY_UNAVAILABLE');
    let resolveSetting,rejectSetting,rejectDeadline,listenerId,timer;
    const pending=new Promise((resolve,reject)=>{resolveSetting=resolve;rejectSetting=reject;});
    const deadline=new Promise((_,reject)=>{rejectDeadline=reject;});
    const aborted=()=>rejectDeadline(Object.assign(new Error('QQ_NATIVE_CLOSED'),{code:'QQ_NATIVE_CLOSED'}));controller.signal.addEventListener('abort',aborted,{once:true});
    const listener=new Proxy({onCheckBuddySettingResult(value){
      if(!object(value)||String(value.buddyUin??'')!==userId)return;
      const reportedUid=typeof value.buddyUid==='string'?value.buddyUid:null;
      if(reportedUid===null||reportedUid.length>256||/[\u0000-\u0020\u007f]/.test(reportedUid)||!Number.isSafeInteger(value.addFriendSetting)||!Array.isArray(value.question)||value.question.length>16||value.question.some(q=>typeof q!=='string'||q.length>2048))return;
      resolveSetting({reportedUid,reportedUin:userId,phoneNumber:typeof value.phoneNumber==='string'?value.phoneNumber:'',addFriendSetting:value.addFriendSetting,question:[...value.question]});
    }},{get(target,key){if(Reflect.has(target,key))return Reflect.get(target,key);return typeof key==='string'&&key.startsWith('on')?()=>{}:undefined;}});
    try{
      listenerId=Reflect.apply(add,buddy,[listener]);timer=setTimeout(()=>rejectDeadline(Object.assign(new Error('QQ_NATIVE_QUERY_TIMEOUT'),{code:'QQ_NATIVE_QUERY_TIMEOUT'})),queryTimeoutMs);
      const nativeAck=Promise.resolve().then(()=>Reflect.apply(getter,buddy,[userId,'',1])).then(result=>{if(!object(result)||result.result!==0)fail('QQ_NATIVE_QUERY_REJECTED');});
      const [setting]=await Promise.race([Promise.all([pending,nativeAck]),deadline]);await current();if(queryGeneration!==generation)fail('QQ_NATIVE_QUERY_STALE',409);return remember(userId,setting,'not_friend');
    }finally{clearTimeout(timer);controller.signal.removeEventListener('abort',aborted);if(Number.isSafeInteger(listenerId)&&listenerId>=0)try{Reflect.apply(remove,buddy,[listenerId]);}catch{diagnostic('QQ_NATIVE_LISTENER_REMOVE_FAILED');}}
  });}
  const publicReceipt=(record,duplicate=false)=>envelope(Object.fromEntries(Object.entries({...record,duplicate}).filter(([key])=>['operationId','userId','targetRef','optionsRef','state','nativeCalls','nativeCallUpperBound','confirmedBy','friendshipConfirmed','alreadyFriend','code','resultCode','createdAt','updatedAt','duplicate','message'].includes(key))));
  async function existing(operationId,fingerprint){let record=await journal.read(accountId,operationId);if(!record)return null;if(fingerprint&&record.fingerprint!==fingerprint)fail('QQ_NATIVE_OPERATION_CONFLICT',409);if(record.state==='prepared'&&!inFlight.has(operationId))record=await journal.update(record,{state:'unknown',nativeCalls:record.nativeCallUpperBound===0?0:null,code:'QQ_NATIVE_INTERRUPTED_UNKNOWN',updatedAt:clock()});return record;}
  async function request({operationId,optionsRef,text}={}){return queue(async()=>{
    if(!operationIdValid(operationId)||typeof optionsRef!=='string'||!/^qqopts_[a-f0-9]{32}$/.test(optionsRef)||typeof text!=='string'||[...text].length>QQ_NATIVE_LIMITS.textChars||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))fail('QQ_NATIVE_REQUEST_INVALID',400);
    await current();const fingerprint=digest({optionsRef,text}),prior=await existing(operationId,fingerprint);if(prior)return publicReceipt(prior,true);
    const option=options.get(optionsRef);if(!option||option.accountId!==accountId||option.generation!==generation||option.expiresAt<=clock())fail('QQ_NATIVE_OPTIONS_STALE',409);
    const alreadyFriend=await isFriend(option.userId),at=clock();
    if(!alreadyFriend&&(option.setting?.addFriendSetting!==1||option.setting.question.length!==0))return envelope({operationId,userId:option.userId,targetRef:option.targetRef,optionsRef,state:'unsupported',nativeCalls:0,nativeCallUpperBound:0,code:'QQ_NATIVE_REQUIREMENTS_UNSUPPORTED'});
    const prepared={schemaVersion:'xiangxu-qq-native-operation/1',operationId,accountId,fingerprint,userId:option.userId,targetRef:option.targetRef,optionsRef,state:'prepared',bootId:config.bootId,nativeCalls:null,nativeCallUpperBound:alreadyFriend?0:1,createdAt:at,updatedAt:at};
    const reserved=await journal.prepare(prepared);if(!reserved.created){const record=await existing(operationId,fingerprint);return publicReceipt(record,true);}
    if(alreadyFriend)return publicReceipt(await journal.update(prepared,{state:'accepted',nativeCalls:0,alreadyFriend:true,friendshipConfirmed:true,confirmedBy:'friend_list',updatedAt:clock()}));
    const add=method(buddy,'reqToAddFriends');if(!add)return publicReceipt(await journal.update(prepared,{state:'unsupported',nativeCalls:0,nativeCallUpperBound:0,code:'QQ_NATIVE_REQUEST_UNAVAILABLE',updatedAt:clock()}));
    try{await current();if(option.generation!==generation)fail('QQ_NATIVE_OPTIONS_STALE',409);}catch(error){return publicReceipt(await journal.update(prepared,{state:'failed',nativeCalls:0,nativeCallUpperBound:0,code:safeCode(error),updatedAt:clock()}));}
    const payload={buddyUin:option.userId,buddyUid:option.setting.reportedUid,phoneNumber:'',addFriendSetting:option.setting.addFriendSetting,answer:null,remark:null,defaultCatgory:null,verifyInfo:text||null,securityVerify:null,sourceID:0,sourceSubID:0,qzoneNotWatch:false,qzoneNotWatched:false,onlyChat:false};
    inFlight.add(operationId);let patch,nativeTimer;
    try{const deadline=new Promise((_,reject)=>{nativeTimer=setTimeout(()=>reject(Object.assign(new Error('QQ_NATIVE_REQUEST_ACK_TIMEOUT'),{code:'QQ_NATIVE_REQUEST_ACK_TIMEOUT'})),nativeTimeoutMs);});const result=await Promise.race([Promise.resolve().then(()=>Reflect.apply(add,buddy,[payload])),deadline]);patch=result?.result===0?{state:'submitted',resultCode:0,confirmedBy:'native-result-zero',friendshipConfirmed:false}:Number.isSafeInteger(result?.result)&&result.result!==0?{state:'failed',resultCode:result.result,code:'QQ_NATIVE_REQUEST_REJECTED',message:message({message:result.errMsg??''})}:{state:'unknown',code:'QQ_NATIVE_REQUEST_ACK_UNCONFIRMED'};}
    catch(error){patch={state:'unknown',code:'QQ_NATIVE_REQUEST_THROWN_UNKNOWN',message:message(error)};}
    finally{clearTimeout(nativeTimer);inFlight.delete(operationId);}
    return publicReceipt(await journal.update(prepared,{...patch,nativeCalls:1,nativeCallUpperBound:1,updatedAt:clock()}));
  });}
  async function status({operationId}={}){return queue(async()=>{
    if(!operationIdValid(operationId))fail('QQ_NATIVE_OPERATION_ID',400);await current();let record=await existing(operationId);if(!record)fail('QQ_NATIVE_OPERATION_NOT_FOUND',404);
    if(record.state!=='accepted'&&await isFriend(record.userId))record=await journal.update(record,{state:'accepted',friendshipConfirmed:true,confirmedBy:'friend_list',updatedAt:clock()});
    return publicReceipt(record);
  });}
  async function body(incoming){const chunks=[];let bytes=0;for await(const chunk of incoming){bytes+=chunk.length;if(bytes>QQ_NATIVE_LIMITS.bodyBytes)fail('QQ_NATIVE_BODY_CAPACITY',413);chunks.push(chunk);}let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('QQ_NATIVE_BODY_INVALID',400);}if(!object(value))fail('QQ_NATIVE_BODY_INVALID',400);return value;}
  const server=http.createServer((incoming,outgoing)=>{void(async()=>{
    const send=(httpStatus,value)=>{outgoing.writeHead(httpStatus,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});outgoing.end(JSON.stringify(value));};
    try{
      if(incoming.method!=='POST')fail('QQ_NATIVE_METHOD',405);
      if(incoming.headers.host!=='127.0.0.1:'+boundPort||incoming.headers.origin!==undefined)fail('QQ_NATIVE_ORIGIN',403);
      const authorization=incoming.headers.authorization,token=typeof authorization==='string'&&authorization.startsWith('Bearer ')?authorization.slice(7):'';
      if(!token||token.length>256||!timingSafeEqual(Buffer.from(digest(token)),Buffer.from(secretHash))||incoming.headers['x-xiangxu-boot-id']!==config.bootId)fail('QQ_NATIVE_AUTH_REQUIRED',401);
      if(String(incoming.headers['content-type']??'').split(';')[0].toLowerCase()!=='application/json')fail('QQ_NATIVE_CONTENT_TYPE',415);
      const value=await body(incoming),keys=Object.keys(value);let result;
      if(incoming.url==='/v1/inspect'&&keys.length===0)result=await inspect();
      else if(incoming.url==='/v1/friend/query'&&keys.length===1&&keys[0]==='userId')result=await query(value);
      else if(incoming.url==='/v1/friend/request'&&keys.length===3&&keys.every(key=>['operationId','optionsRef','text'].includes(key)))result=await request(value);
      else if(incoming.url==='/v1/friend/status'&&keys.length===1&&keys[0]==='operationId')result=await status(value);
      else fail('QQ_NATIVE_ROUTE_OR_FIELDS',400);
      send(200,result);
    }catch(error){send(error.httpStatus??503,{protocol:QQ_NATIVE_PROTOCOL,bootId:config.bootId,accountId:null,error:{code:safeCode(error),message:'QQ账号操作未完成；请核对连接状态与实际平台要求。'}});}
  })();});
  server.maxConnections=16;server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=3000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,'127.0.0.1',resolve);});boundPort=server.address().port;await marker('waiting_account');
  let healthBusy=false;const health=healthIntervalMs?setInterval(()=>{if(healthBusy||closed)return;healthBusy=true;void inspect().finally(()=>{healthBusy=false;});},healthIntervalMs):null;health?.unref();
  async function close(){if(closed)return;closed=true;ready=false;clearInterval(health);controller.abort();server.closeIdleConnections?.();await new Promise(resolve=>server.close(resolve));await tail;await marker('closed');}
  return{inspect,query,request,status,close,get port(){return boundPort;},get busy(){return active>0;}};
}
