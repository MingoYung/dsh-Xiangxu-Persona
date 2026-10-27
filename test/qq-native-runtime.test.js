import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {startNativeService,validateNativeConfig,QQ_NATIVE_LIMITS} from '../adapters/dsh/connections/qq-native/service.mjs';
import {createNativeJournal} from '../adapters/dsh/connections/qq-native/journal.mjs';
import {createNativeRuntimeAssetsConfig,QQ_NATIVE_ABI_VERSION,QQ_NATIVE_ASSET_FILES} from '../adapters/dsh/connections/qq-native/assets.mjs';
import {createQQNativeClient} from '../adapters/dsh/connections/qq-native-client.js';

// These are local JS fakes. No QQ installation, native addon, official bundle,
// model, external service or real contact is loaded by this test file.
async function fixture(t,overrides={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'xiangxu-native-runtime-'));
  const config={schemaVersion:'xiangxu-qq-native-config/1',host:'127.0.0.1',port:0,token:'N'.repeat(43),bootId:'test-native-boot-0001',expectedAccountId:'10001',onebotApiUrl:'http://127.0.0.1:9/',onebotToken:'O'.repeat(43),qqInstallRoot:path.join(root,'qq'),officialBundlePath:path.join(root,'vendor','napcat.mjs'),assetRoot:path.join(root,'assets'),markerPath:path.join(root,'state','marker.json'),journalRoot:path.join(root,'journal'),abiVersion:QQ_NATIVE_ABI_VERSION,...overrides.config};
  const state={ready:true,accountId:'10001',friends:[],setting:1,questions:[],reportedUid:'',getterResult:{result:0},requestResult:{result:0},queryCalls:[],requestCalls:[],getBuddyCalls:0,removed:[],listener:null,requestImpl:null,getterImpl:null};
  const buddy={addKernelBuddyListener(listener){state.listener=listener;return 7;},removeKernelBuddyListener(id){state.removed.push(id);state.listener=null;},getTargetBuddySettingByType(...args){assert.equal(this,buddy);state.queryCalls.push(args);if(state.getterImpl)return state.getterImpl(...args);setImmediate(()=>state.listener?.onCheckBuddySettingResult({buddyUin:args[0],buddyUid:state.reportedUid,phoneNumber:'',addFriendSetting:state.setting,question:state.questions}));return state.getterResult;},reqToAddFriends(payload){assert.equal(this,buddy);state.requestCalls.push(payload);return state.requestImpl?state.requestImpl(payload):state.requestResult;}};
  const session={getBuddyService(){state.getBuddyCalls++;return buddy;}};
  const onebotPort=async(action,params)=>{if(action==='get_friend_list')return{status:'ok',retcode:0,data:state.friends.map(user_id=>({user_id}))};if(action==='get_stranger_info')return{status:'ok',retcode:0,data:{user_id:params.user_id,uid:'u_onebot_metadata'}};throw new Error('Unexpected mock OneBot action');};
  const service=await startNativeService({session,config,onebotPort,readinessPort:async()=>({accountId:state.accountId,ready:state.ready}),queryTimeoutMs:100,nativeTimeoutMs:100,healthIntervalMs:0,...overrides.ports});
  t.after(async()=>{await service.close();const resolved=path.resolve(root);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('xiangxu-native-runtime-'));await fs.rm(resolved,{recursive:true,force:true});});
  const http=async(route,value={},headers={})=>{const response=await fetch('http://127.0.0.1:'+service.port+route,{method:'POST',headers:{authorization:'Bearer '+config.token,'x-xiangxu-boot-id':config.bootId,'content-type':'application/json',...headers},body:JSON.stringify(value)});return{status:response.status,body:await response.json()};};
  return{root,config,state,buddy,service,http};
}
const ask=f=>f.service.query({userId:'20002'});
const request=(f,q,id='operation-1',text='hello')=>f.service.request({operationId:id,optionsRef:q.optionsRef,text});
const journalRecord=operationId=>({schemaVersion:'xiangxu-qq-native-operation/1',operationId,accountId:'10001',fingerprint:'a'.repeat(64),state:'prepared',nativeCalls:null,nativeCallUpperBound:1,userId:'20002',targetRef:'qqtarget_'+'a'.repeat(32),optionsRef:'qqopts_'+'b'.repeat(32),bootId:'old-native-boot-0001',createdAt:1,updatedAt:1});

test('asset descriptor pins every original runtime file and exact supported ABI',async()=>{
  const value=await createNativeRuntimeAssetsConfig();assert.equal(value.abiVersion,QQ_NATIVE_ABI_VERSION);assert.deepEqual(Object.keys(value.assetHashes).sort(),[...QQ_NATIVE_ASSET_FILES].sort());assert.ok(path.isAbsolute(value.loaderPath));for(const hash of Object.values(value.assetHashes))assert.match(hash,/^[a-f0-9]{64}$/);
});
test('inspect gates native service acquisition on readiness and emits no credentials',async t=>{
  const f=await fixture(t);f.state.ready=false;let result=await f.service.inspect();assert.equal(result.ready,false);assert.equal(f.state.getBuddyCalls,0);f.state.ready=true;result=await f.service.inspect();assert.equal(result.ready,true);assert.equal(result.accountId,'10001');assert.deepEqual(result.capabilities.respond,{supported:false,available:false});const marker=JSON.parse(await fs.readFile(f.config.markerPath,'utf8'));assert.equal(marker.phase,'ready');assert.equal(marker.pid,process.pid);assert.equal(marker.port,f.service.port);assert.equal(JSON.stringify(result).includes(f.config.token),false);assert.equal(JSON.stringify(marker).includes(f.config.onebotToken),false);
});
test('query correlates native UIN and preserves empty reported UID in the single proven request DTO',async t=>{
  const f=await fixture(t),q=await ask(f);assert.equal(q.relationship,'not_friend');assert.equal(q.requirements.supported,true);assert.deepEqual(f.state.queryCalls,[['20002','',1]]);assert.deepEqual(f.state.removed,[7]);assert.equal('buddyUid'in q,false);assert.equal('setting'in q,false);
  const r=await request(f,q);assert.equal(r.state,'submitted');assert.equal(r.friendshipConfirmed,false);assert.equal(r.nativeCalls,1);assert.deepEqual(f.state.requestCalls,[{buddyUin:'20002',buddyUid:'',phoneNumber:'',addFriendSetting:1,answer:null,remark:null,defaultCatgory:null,verifyInfo:'hello',securityVerify:null,sourceID:0,sourceSubID:0,qzoneNotWatch:false,qzoneNotWatched:false,onlyChat:false}]);
});
test('callback may carry native UID from its own domain; unrelated UIN callbacks are ignored',async t=>{
  const f=await fixture(t);f.state.getterImpl=uin=>{setImmediate(()=>{f.state.listener.onCheckBuddySettingResult({buddyUin:'77777',buddyUid:'u_wrong',addFriendSetting:1,question:[]});f.state.listener.onCheckBuddySettingResult({buddyUin:uin,buddyUid:'u_native_domain',addFriendSetting:1,question:[]});});return{result:0};};const q=await ask(f);await request(f,q);assert.equal(f.state.requestCalls[0].buddyUid,'u_native_domain');
});
test('already verified friend is accepted without native query or request',async t=>{
  const f=await fixture(t);f.state.friends=['20002'];const q=await ask(f),r=await request(f,q);assert.equal(q.relationship,'friend');assert.equal(r.state,'accepted');assert.equal(r.confirmedBy,'friend_list');assert.equal(r.nativeCalls,0);assert.equal(f.state.queryCalls.length,0);assert.equal(f.state.requestCalls.length,0);
});
test('unsupported native setting or verification questions never cause a request',async t=>{
  const f=await fixture(t);for(const [setting,questions]of [[2,[]],[1,['challenge']]]){f.state.setting=setting;f.state.questions=questions;const q=await ask(f),r=await request(f,q,'unsupported-'+setting+questions.length);assert.equal(q.requirements.supported,false);assert.equal(r.state,'unsupported');assert.equal(r.nativeCalls,0);}assert.equal(f.state.requestCalls.length,0);
});
test('duplicate operation persists across native service boots and never replays',async t=>{
  const f=await fixture(t),q=await ask(f),first=await request(f,q);assert.equal(first.state,'submitted');const duplicate=await request(f,q);assert.equal(duplicate.duplicate,true);assert.equal(f.state.requestCalls.length,1);await f.service.close();
  const again=await startNativeService({session:{getBuddyService:()=>f.buddy},config:{...f.config,bootId:'test-native-boot-0002'},onebotPort:async()=>({status:'ok',retcode:0,data:[]}),readinessPort:async()=>({accountId:'10001',ready:true}),healthIntervalMs:0});try{const old=await again.request({operationId:'operation-1',optionsRef:q.optionsRef,text:'hello'});assert.equal(old.state,'submitted');assert.equal(old.duplicate,true);assert.equal(f.state.requestCalls.length,1);}finally{await again.close();}
});
test('same operation with altered content is a conflict before any second invocation',async t=>{
  const f=await fixture(t),q=await ask(f);await request(f,q);await assert.rejects(request(f,q,'operation-1','changed'),{code:'QQ_NATIVE_OPERATION_CONFLICT'});assert.equal(f.state.requestCalls.length,1);
});
test('only result zero submits; void, thrown and timed out native acknowledgments stay unknown without replay',async t=>{
  const f=await fixture(t);for(const [name,impl]of [['void',()=>undefined],['throw',()=>{throw new Error(f.config.token+' '+f.config.onebotToken);} ],['hang',()=>new Promise(()=>{})]]){f.state.requestImpl=impl;const q=await ask(f),r=await request(f,q,'op-'+name);assert.equal(r.state,'unknown');assert.equal(r.friendshipConfirmed,undefined);const again=await request(f,q,'op-'+name);assert.equal(again.duplicate,true);assert.equal(JSON.stringify(r).includes(f.config.token),false);assert.equal(JSON.stringify(r).includes(f.config.onebotToken),false);}assert.equal(f.state.requestCalls.length,3);
});
test('explicit nonzero native response fails and its bounded result remains in durable history',async t=>{
  const f=await fixture(t);f.state.requestResult={result:42,errMsg:'platform rejected'};const q=await ask(f),r=await request(f,q);assert.equal(r.state,'failed');assert.equal(r.resultCode,42);f.state.friends=['20002'];const accepted=await f.service.status({operationId:r.operationId});assert.equal(accepted.state,'accepted');assert.equal(accepted.confirmedBy,'friend_list');const records=await fs.readdir(f.config.journalRoot),record=JSON.parse(await fs.readFile(path.join(f.config.journalRoot,records[0]),'utf8'));assert.ok(record.history.some(value=>value.state==='failed'&&value.resultCode===42&&value.message==='platform rejected'));assert.equal(f.state.requestCalls.length,1);
});
test('interrupted prepared record is unknown after restart and retains an upper bound without retry',async t=>{
  const f=await fixture(t),q=await ask(f),operationId='interrupted',journal=createNativeJournal({journalRoot:f.config.journalRoot});await journal.prepare({schemaVersion:'xiangxu-qq-native-operation/1',operationId,accountId:'10001',fingerprint:createHash('sha256').update(JSON.stringify({optionsRef:q.optionsRef,text:'hello'})).digest('hex'),userId:'20002',targetRef:q.targetRef,optionsRef:q.optionsRef,state:'prepared',bootId:'previous-boot-id',nativeCalls:null,nativeCallUpperBound:1,createdAt:1,updatedAt:1});const result=await request(f,q,operationId);assert.equal(result.state,'unknown');assert.equal(result.nativeCalls,null);assert.equal(result.nativeCallUpperBound,1);assert.equal(f.state.requestCalls.length,0);
});
test('failure to persist final result leaves prepared operation durable and never replays',async t=>{
  let journal;const f=await fixture(t,{ports:{journalPort:{read:(...args)=>journal.read(...args),prepare:(...args)=>journal.prepare(...args),update:async(record,patch)=>{if(patch.state==='submitted')throw new Error('mock disk fault');return journal.update(record,patch);}}}});journal=createNativeJournal({journalRoot:f.config.journalRoot});const q=await ask(f);await assert.rejects(request(f,q),/mock disk fault/);const r=await request(f,q);assert.equal(r.state,'unknown');assert.equal(r.nativeCalls,null);assert.equal(f.state.requestCalls.length,1);
});
test('query deadline covers missing callback, late getter rejection and hung getter after callback',async t=>{
  const f=await fixture(t);f.state.getterImpl=()=>({result:0});await assert.rejects(ask(f),{code:'QQ_NATIVE_QUERY_TIMEOUT'});f.state.getterImpl=uin=>{setImmediate(()=>f.state.listener.onCheckBuddySettingResult({buddyUin:uin,buddyUid:'',addFriendSetting:1,question:[]}));return new Promise((_,reject)=>setTimeout(()=>reject(new Error('late native getter failure')),20));};await assert.rejects(ask(f),/late native getter failure/);f.state.getterImpl=uin=>{setImmediate(()=>f.state.listener.onCheckBuddySettingResult({buddyUin:uin,buddyUid:'',addFriendSetting:1,question:[]}));return new Promise(()=>{});};await assert.rejects(ask(f),{code:'QQ_NATIVE_QUERY_TIMEOUT'});assert.deepEqual(f.state.removed,[7,7,7]);
});
test('offline invalidates existing options and changing account disables the same captured session permanently',async t=>{
  const f=await fixture(t),q=await ask(f);f.state.ready=false;assert.equal((await f.service.inspect()).ready,false);f.state.ready=true;await assert.rejects(request(f,q),{code:'QQ_NATIVE_OPTIONS_STALE'});f.state.accountId='30003';assert.equal((await f.service.inspect()).ready,false);f.state.accountId='10001';await assert.rejects(ask(f),{code:'QQ_NATIVE_ACCOUNT_CHANGED'});assert.equal(f.state.requestCalls.length,0);
});
test('a callback from a pre-offline query cannot become fresh options after same-account recovery',async t=>{
  const f=await fixture(t);let reply;f.state.getterImpl=uin=>{reply=()=>f.state.listener.onCheckBuddySettingResult({buddyUin:uin,buddyUid:'',addFriendSetting:1,question:[]});return{result:0};};const pending=ask(f),stale=assert.rejects(pending,{code:'QQ_NATIVE_QUERY_STALE'});while(!reply)await new Promise(resolve=>setImmediate(resolve));f.state.ready=false;await f.service.inspect();f.state.ready=true;reply();await stale;assert.equal(f.state.requestCalls.length,0);
});
test('expired options and references issued by a different boot fail before native request',async t=>{
  let now=100;const f=await fixture(t,{ports:{clock:()=>now}}),q=await ask(f);now+=QQ_NATIVE_LIMITS.optionsMs;await assert.rejects(request(f,q),{code:'QQ_NATIVE_OPTIONS_STALE'});await assert.rejects(f.service.request({operationId:'unknown-ref',optionsRef:'qqopts_'+'0'.repeat(32),text:''}),{code:'QQ_NATIVE_OPTIONS_STALE'});assert.equal(f.state.requestCalls.length,0);
});
test('status is ordered after the in-flight request and reconciles friendship without another native operation',async t=>{
  const f=await fixture(t);let release;f.state.requestImpl=()=>new Promise(resolve=>{release=resolve;});const q=await ask(f),pending=request(f,q);while(!release)await new Promise(resolve=>setImmediate(resolve));const checked=f.service.status({operationId:'operation-1'});f.state.friends=['20002'];release({result:0});const first=await pending,last=await checked;assert.equal(first.state,'submitted');assert.equal(last.state,'accepted');assert.equal(last.confirmedBy,'friend_list');assert.equal(f.state.requestCalls.length,1);
});
test('loopback HTTP requires exact bearer and boot, rejects browser origins and unrecognized fields',async t=>{
  const f=await fixture(t);for(const headers of [{authorization:'Bearer invalid'},{'x-xiangxu-boot-id':'wrong-boot'},{origin:'https://example.invalid'}]){const r=await f.http('/v1/inspect',{},headers);assert.ok([401,403].includes(r.status));assert.equal(r.body.protocol,'xiangxu-qq-native/1');assert.ok(r.body.error.code.startsWith('QQ_NATIVE_'));assert.equal(JSON.stringify(r.body).includes(f.config.token),false);}assert.equal((await f.http('/v1/inspect',{extra:true})).status,400);assert.equal((await f.http('/v1/inspect',{}, {'content-type':'text/plain'})).status,415);assert.equal((await f.http('/v1/inspect',{})).body.ready,true);assert.equal(f.state.requestCalls.length,0);
});
test('request body capacity is enforced and no raw native setting or token reaches JSON output',async t=>{
  const f=await fixture(t);const cap=await f.http('/v1/friend/query',{userId:'2'.repeat(QQ_NATIVE_LIMITS.bodyBytes)});assert.equal(cap.status,413);const q=await f.http('/v1/friend/query',{userId:'20002'});assert.equal(q.status,200);const json=JSON.stringify(q.body);assert.equal(json.includes('u_onebot_metadata'),false);assert.equal(json.includes('reportedUid'),false);assert.equal(json.includes(f.config.token),false);
});
test('journal capacity is enforced without evicting unknown operations or blocking duplicate reads',async t=>{
  const f=await fixture(t),journal=createNativeJournal({journalRoot:f.config.journalRoot,maxEntries:1}),record={schemaVersion:'xiangxu-qq-native-operation/1',operationId:'first',accountId:'10001',fingerprint:'a'.repeat(64),state:'unknown',nativeCalls:null,nativeCallUpperBound:1};assert.equal((await journal.prepare(record)).created,true);await assert.rejects(journal.prepare({...record,operationId:'second'}),{code:'QQ_NATIVE_JOURNAL_CAPACITY'});assert.equal((await journal.prepare(record)).created,false);assert.equal((await journal.read('10001','first')).state,'unknown');
});
test('unsafe config cannot bind public hosts, cross account or write state into QQ installation',async t=>{
  const f=await fixture(t);for(const patch of [{host:'0.0.0.0'},{markerPath:path.join(f.config.qqInstallRoot,'marker.json')},{onebotApiUrl:'http://example.invalid/'},{abiVersion:'unknown'},{expectedAccountId:'invalid'}])assert.throws(()=>validateNativeConfig({...f.config,...patch}));assert.equal(f.state.requestCalls.length,0);
});
test('technical readiness marker follows later OneBot startup without any friend query or request',async t=>{
  const f=await fixture(t,{ports:{healthIntervalMs:10}});f.state.ready=false;await f.service.inspect();f.state.ready=true;let marker;for(let i=0;i<100;i++){await new Promise(resolve=>setTimeout(resolve,10));marker=JSON.parse(await fs.readFile(f.config.markerPath,'utf8'));if(marker.ready)break;}assert.equal(marker.ready,true);assert.equal(marker.phase,'ready');assert.equal(f.state.queryCalls.length,0);assert.equal(f.state.requestCalls.length,0);
});
test('production client and real loopback runtime interoperate through query, submitted, duplicate and accepted receipts',async t=>{
  const f=await fixture(t),runtime={enabled:true,protocol:'xiangxu-qq-native/1',abiVersion:QQ_NATIVE_ABI_VERSION,baseUrl:'http://127.0.0.1:'+f.service.port,token:f.config.token,bootId:f.config.bootId,expectedAccountId:'10001'},client=createQQNativeClient();assert.equal((await client.inspect(runtime)).ready,true);const q=await client.query(runtime,{userId:'20002'}),args={operationId:'client-operation',optionsRef:q.optionsRef,text:'mock-only'};const first=await client.request(runtime,args);assert.equal(first.state,'submitted');assert.equal((await client.request(runtime,args)).duplicate,true);f.state.friends=['20002'];const last=await client.status(runtime,{operationId:args.operationId});assert.equal(last.state,'accepted');assert.equal(last.confirmedBy,'friend_list');assert.equal(f.state.requestCalls.length,1);
});
test('native request late result does not revise unknown or start a second invocation',async t=>{
  const f=await fixture(t);let late;f.state.requestImpl=()=>new Promise(resolve=>{late=resolve;});const q=await ask(f),first=await request(f,q);assert.equal(first.state,'unknown');late({result:0});await new Promise(resolve=>setImmediate(resolve));const next=await request(f,q);assert.equal(next.state,'unknown');assert.equal(f.state.requestCalls.length,1);
});
test('close aborts a waiting native query and cannot wait forever on an async native request',async t=>{
  const f=await fixture(t);f.state.getterImpl=()=>({result:0});const pending=ask(f),rejected=assert.rejects(pending,{code:'QQ_NATIVE_CLOSED'});await new Promise(resolve=>setTimeout(resolve,10));await f.service.close();await rejected;assert.equal(f.state.requestCalls.length,0);
  const g=await fixture(t);g.state.requestImpl=()=>new Promise(()=>{});const q=await ask(g),requesting=request(g,q);while(!g.state.requestCalls.length)await new Promise(resolve=>setImmediate(resolve));await g.service.close();assert.equal((await requesting).state,'unknown');
});
test('independent journal writers serialize count and claim with wx admission, not the native service queue',async t=>{
  const f=await fixture(t);let entered,release,counted=0;const counting=new Promise(resolve=>{entered=resolve;}),resume=new Promise(resolve=>{release=resolve;});
  const a=createNativeJournal({journalRoot:f.config.journalRoot,maxEntries:1,fsPort:{...fs,readdir:async file=>{counted++;entered();await resume;return fs.readdir(file);}}}),b=createNativeJournal({journalRoot:f.config.journalRoot,maxEntries:1});
  const first=a.prepare(journalRecord('parallel-a'));await counting;
  await assert.rejects(b.prepare(journalRecord('parallel-b')),{code:'QQ_NATIVE_JOURNAL_BUSY'});assert.equal(counted,1);assert.equal((await fs.readdir(f.config.journalRoot)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).length,0);
  release();assert.equal((await first).created,true);await assert.rejects(fs.lstat(path.join(f.config.journalRoot,'.prepare.lock')),{code:'ENOENT'});
  await assert.rejects(b.prepare(journalRecord('parallel-b')),{code:'QQ_NATIVE_JOURNAL_CAPACITY'});assert.equal((await fs.readdir(f.config.journalRoot)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).length,1);await assert.rejects(fs.lstat(path.join(f.config.journalRoot,'.prepare.lock')),{code:'ENOENT'});assert.equal(f.state.requestCalls.length,0);
});
test('crash admission claim never expires automatically, while existing operations remain readable and deduplicated',async t=>{
  const f=await fixture(t),journal=createNativeJournal({journalRoot:f.config.journalRoot});await journal.prepare({...journalRecord('existing'),state:'unknown'});
  const lock=path.join(f.config.journalRoot,'.prepare.lock'),claim=JSON.stringify({schemaVersion:'xiangxu-qq-native-admission/1',pid:1,token:'foreign-crash-claim'});await fs.writeFile(lock,claim);await fs.utimes(lock,new Date(0),new Date(0));
  assert.equal((await journal.read('10001','existing')).state,'unknown');assert.equal((await journal.prepare({...journalRecord('existing'),state:'unknown'})).created,false);await assert.rejects(journal.prepare(journalRecord('new-after-crash')),{code:'QQ_NATIVE_JOURNAL_BUSY'});assert.equal(await fs.readFile(lock,'utf8'),claim);assert.equal(f.state.requestCalls.length,0);
});
test('admission busy prevents a native invocation and a later explicit attempt can proceed after operator recovery',async t=>{
  const f=await fixture(t),q=await ask(f),lock=path.join(f.config.journalRoot,'.prepare.lock');await fs.mkdir(f.config.journalRoot,{recursive:true});await fs.writeFile(lock,JSON.stringify({schemaVersion:'xiangxu-qq-native-admission/1',pid:1,token:'foreign-lock'}));
  await assert.rejects(request(f,q),{code:'QQ_NATIVE_JOURNAL_BUSY'});assert.equal(f.state.requestCalls.length,0);assert.equal((await fs.readdir(f.config.journalRoot)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).length,0);
  // Test-only explicit operator recovery. The product never removes this stale lock.
  await fs.unlink(lock);assert.equal((await request(f,q)).state,'submitted');assert.equal(f.state.requestCalls.length,1);
});
test('failed operation sync preserves its prepared claim, releases only admission and never replays',async t=>{
  let journal,fault=true;const f=await fixture(t,{ports:{journalPort:{read:(...args)=>journal.read(...args),prepare:(...args)=>journal.prepare(...args),update:(...args)=>journal.update(...args)}}});
  journal=createNativeJournal({journalRoot:f.config.journalRoot,fsPort:{...fs,open:async(file,...args)=>{const handle=await fs.open(file,...args);if(fault&&/^[a-f0-9]{64}\.json$/.test(path.basename(file))&&args[0]==='wx'){fault=false;return{writeFile:(...values)=>handle.writeFile(...values),sync:async()=>{throw new Error('simulated operation sync failure');},close:()=>handle.close()};}return handle;}}});
  const q=await ask(f);await assert.rejects(request(f,q),/simulated operation sync failure/);await assert.rejects(fs.lstat(path.join(f.config.journalRoot,'.prepare.lock')),{code:'ENOENT'});assert.equal((await journal.read('10001','operation-1')).state,'prepared');const again=await request(f,q);assert.equal(again.state,'unknown');assert.equal(again.nativeCalls,null);assert.equal(f.state.requestCalls.length,0);
});
test('finally cannot delete a foreign token written into the same admission inode',async t=>{
  const f=await fixture(t);let enter,release;const arrived=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const journal=createNativeJournal({journalRoot:f.config.journalRoot,fsPort:{...fs,readdir:async file=>{enter();await gate;return fs.readdir(file);}}}),pending=journal.prepare(journalRecord('foreign-token')),rejected=assert.rejects(pending,{code:'QQ_NATIVE_JOURNAL_BUSY'});await arrived;
  const lock=path.join(f.config.journalRoot,'.prepare.lock'),claim=JSON.parse(await fs.readFile(lock,'utf8'));claim.token='foreign-token';await fs.writeFile(lock,JSON.stringify(claim));release();await rejected;assert.equal(JSON.parse(await fs.readFile(lock,'utf8')).token,'foreign-token');assert.equal((await journal.read('10001','foreign-token')).state,'prepared');
});
test('finally cannot delete a replacement inode after handle loss even when token and PID were copied',async t=>{
  const f=await fixture(t);let enter,release,admissionHandle;const arrived=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const journal=createNativeJournal({journalRoot:f.config.journalRoot,fsPort:{...fs,open:async(file,...args)=>{const handle=await fs.open(file,...args);if(path.basename(file)==='.prepare.lock')admissionHandle=handle;return handle;},readdir:async file=>{enter();await gate;return fs.readdir(file);}}}),pending=journal.prepare(journalRecord('foreign-inode')),rejected=assert.rejects(pending,{code:'QQ_NATIVE_JOURNAL_BUSY'});await arrived;
  const lock=path.join(f.config.journalRoot,'.prepare.lock'),claim=await fs.readFile(lock,'utf8'),previous=await fs.lstat(lock),replacement=path.join(f.config.journalRoot,'replacement.lock');
  try{await fs.writeFile(replacement,claim);assert.notEqual((await fs.lstat(replacement)).ino,previous.ino);await admissionHandle.close();await fs.rename(replacement,lock);}finally{release();}
  await rejected;assert.equal(await fs.readFile(lock,'utf8'),claim);assert.notEqual((await fs.lstat(lock)).ino,previous.ino);
});
