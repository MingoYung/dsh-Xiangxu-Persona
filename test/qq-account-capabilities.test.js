import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createQQAccountService } from '../adapters/dsh/connections/qq-account.js';
import { createBridgeClient } from '../adapters/dsh/connections/bridge.js';
import { createPermissionService } from '../adapters/dsh/permissions.js';
import { validateDshMaintenanceExtension } from '../adapters/dsh/maintenance-extensions.js';
import { MemoryRepository } from '../core/repository.js';
import { createBackup, restoreBackup, validateMemoryRoot } from '../core/maintenance.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5UkAAAAASUVORK5CYII=','base64'),sha=createHash('sha256').update(png).digest('hex'),assetId='asset-'+sha.slice(0,32),ACCOUNT='100001';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
async function fixture(t,{archiveFault}={}){
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'xiangxu-qq-capabilities-')),memoryRoot=path.join(base,'persona'),archiveRoot=path.join(memoryRoot,'extensions','qq-account'),coordinator={};
  let current={instanceId:'persona-a',memoryRoot,coordinator,ready:Promise.resolve()},bridge={accountId:ACCOUNT,enabled:true,connected:true,identityVerified:true,connectionId:'a'.repeat(64),operations:{'profile.avatar':true,'profile.update':true,'feed.publish':true}},authorization=async()=>true,readAssetHook=null,executeHook=null;
  const calls=[],grants=[],assetReads=[],services=[];
  const executeAccount=async(operation,payload,context)=>{calls.push({operation,payload,context});if(executeHook)return executeHook(operation,payload,context);return{status:'completed',operation,accountId:ACCOUNT,receiptId:'onebot-account:'+context.operationId,confirmedBy:'onebot-api-success',...(operation==='feed.publish'?{tid:'tid-mock-1'}:{})};};
  const getBridge=async()=>bridge&&{...bridge,operations:{...bridge.operations},executeAccount};
  const ports={getCoordinator:async()=>current&&{...current},getRuntime:async()=>{throw Error('native runtime is deliberately absent');},getBridge,readAsset:async args=>{assetReads.push(args);if(readAssetHook)return readAssetHook(args);return{bytes:png,mime:'image/png',asset:{assetId,sha256:sha}};},authorize:async args=>{grants.push(args);return authorization(args);},clock:()=>1800000000000,fetchImpl:async()=>{throw Error('No native HTTP or real QQ calls are allowed');},archiveFault};
  const make=()=>{const s=createQQAccountService(ports);services.push(s);return s;},service=make();
  t.after(async()=>{await Promise.all(services.map(s=>s.close()));await fs.rm(base,{recursive:true,force:true});});
  const execute=(operation,args={},id='trusted-account-call',s=service,context={})=>s.execute({accountOperation:operation,accountId:ACCOUNT,...args},{operationId:id,memoryRoot,sourceSessionId:'source-session',sourceRefs:[{sourceSessionId:'source-session',sourceEventId:'source-event'}],...context});
  return{base,memoryRoot,archiveRoot,ports,service,make,calls,grants,assetReads,execute,getBridge,get current(){return current;},set current(v){current=v;},get bridge(){return bridge;},set bridge(v){bridge=v;},set authorization(v){authorization=v;},set readAssetHook(v){readAssetHook=v;},set executeHook(v){executeHook=v;},async index(){return JSON.parse(await fs.readFile(path.join(archiveRoot,'index.json'),'utf8'));}};
}
test('account capabilities stay usable without native friend runtime, without archive initialization or implicit grants',async t=>{
  const f=await fixture(t),caps=await f.service.inspectCapabilities();assert.equal(caps.connected,true);assert.equal(caps.accountId,ACCOUNT);assert.equal(caps.items.find(v=>v.id==='profile.update').driverAvailable,true);assert.equal(caps.items.find(v=>v.id==='feed.publish').provider,'napcat-onebot-account');assert.equal(caps.items.find(v=>v.id==='friend.request').available,false);assert.equal(f.grants.length,0);await assert.rejects(fs.stat(f.archiveRoot),{code:'ENOENT'});
});
test('avatar is an account-level operation with durable preparation, exact owned image evidence and technical source role',async t=>{
  const f=await fixture(t);f.executeHook=async(operation,payload,context)=>{const index=await f.index(),prepared=JSON.parse(await fs.readFile(path.join(f.archiveRoot,'receipts',index.receipts[0].receiptId,'000000.json'),'utf8'));assert.equal(prepared.status,'prepared');assert.equal(prepared.operation,'profile.avatar');assert.deepEqual(prepared.request.assets,[{assetId,sha256:sha,bytes:png.length,mime:'image/png'}]);assert.equal(JSON.stringify(prepared).includes(png.toString('base64')),false);return{status:'completed',operation,accountId:ACCOUNT,receiptId:'receipt-'+context.operationId,confirmedBy:'onebot-api-success'};};
  const result=await f.execute('profile.avatar',{assetId});assert.equal(result.status,'completed');assert.equal(result.userId,null);assert.equal(result.operation,'profile.avatar');assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].payload.bytes,png);assert.equal(f.assetReads[0].memoryRoot,f.memoryRoot);assert.equal(f.grants[0].capability,'profile.update');
  const detail=await f.service.read({accountOperation:'receipt',accountId:ACCOUNT,receiptId:result.receiptId});assert.equal(JSON.parse(detail.text).prepared.source.humanDialogue,false);assert.equal(detail.bindingCreated,false);assert.deepEqual(await fs.readdir(f.memoryRoot),['extensions']);
});
test('Qzone stores explicit visibility and selected accounts, persists real tid, and same trusted call never republishes',async t=>{
  const f=await fixture(t),args={text:'测试说说',imageAssetIds:[assetId],visibility:16,targetUserIds:['200002']},result=await f.execute('feed.publish',args);assert.equal(result.result.tid,'tid-mock-1');assert.equal(f.grants[0].capability,'feed.publish');assert.equal(f.calls[0].payload.visibility,16);assert.deepEqual(f.calls[0].payload.targetUserIds,['200002']);assert.equal(f.calls[0].payload.images[0].mime,'image/png');const count=f.calls.length;
  assert.equal((await f.execute('feed.publish',args)).duplicate,true);assert.equal(f.calls.length,count);await assert.rejects(f.execute('feed.publish',{...args,visibility:128}),{code:'QQ_ACCOUNT_OPERATION_CONFLICT'});
  await f.service.close();const restored=f.make();f.bridge=null;assert.equal((await f.execute('feed.publish',args,'trusted-account-call',restored)).status,'completed');assert.equal(f.calls.length,count);
});
test('profile updates retain only explicit fields and do not turn into a friend operation',async t=>{
  const f=await fixture(t),result=await f.execute('profile.update',{nickname:'名字',signature:'',sex:'female'});assert.equal(result.userId,null);assert.equal(result.status,'completed');assert.deepEqual(f.calls[0].payload,{nickname:'名字',signature:'',sex:'female'});assert.equal(f.assetReads.length,0);
  await assert.rejects(f.service.read({accountOperation:'friend.status',accountId:ACCOUNT,receiptId:result.receiptId}),{code:'QQ_ACCOUNT_OPERATION'});
});
test('an ordinary permission grant is required once and is scoped to the actual persona and QQ account',async t=>{
  const f=await fixture(t),p=createPermissionService({getCoordinator:()=>f.current,getCapabilities:()=>f.service.inspectCapabilities(),storage:{read:async()=>null,write:async()=>{}}});t.after(()=>p.close());f.authorization=args=>p.authorize(args);
  await assert.rejects(f.execute('profile.avatar',{assetId}),{code:'QQ_ACCOUNT_PERMISSION'});assert.equal(f.calls.length,0);assert.equal(f.assetReads.length,0);await p.configure({id:'qq',allowed:['profile.update','feed.publish']});assert.equal((await f.execute('profile.avatar',{assetId},'granted-avatar')).status,'completed');assert.equal((await f.execute('feed.publish',{text:'仅自己',visibility:64},'granted-feed')).status,'completed');
  f.bridge={...f.bridge,accountId:'300003'};await assert.rejects(f.execute('profile.avatar',{assetId},'wrong-account'),{code:'QQ_ACCOUNT_UNAVAILABLE'});assert.equal(f.calls.length,2);
});
test('invalid visibility, fake paths, unknown sex and false image identity all fail before account writes',async t=>{
  const f=await fixture(t);
  for(const args of [{text:'x'},{text:'x',visibility:16},{text:'x',visibility:1,targetUserIds:['200002']},{text:'x',visibility:64,imageAssetIds:['http://example.invalid/p.png']}])await assert.rejects(f.execute('feed.publish',args),{code:'QQ_ACCOUNT_ARGUMENT'});
  await assert.rejects(f.execute('profile.avatar',{assetId,path:'C:/not-authorized.png'}),{code:'QQ_ACCOUNT_ARGUMENT'});await assert.rejects(f.execute('profile.update',{nickname:'名字',sex:'something'}),{code:'QQ_ACCOUNT_ARGUMENT'});
  f.readAssetHook=()=>({bytes:png,mime:'image/jpeg'});await assert.rejects(f.execute('profile.avatar',{assetId}),{code:'QQ_ACCOUNT_ASSET_CHANGED'});assert.equal(f.calls.length,0);
});
test('account or persona changes while an image is read reject before preparing or dispatching an account write',async t=>{
  for(const change of ['account','persona']){const f=await fixture(t),began=deferred(),finish=deferred();f.readAssetHook=async()=>{began.resolve();await finish.promise;return{bytes:png,mime:'image/png'};};const pending=f.execute('profile.avatar',{assetId});await began.promise;assert.equal(f.service.isBusy('persona-a'),true);if(change==='account')f.bridge={...f.bridge,accountId:'300003'};else f.current={...f.current,memoryRoot:path.join(f.base,'other')};finish.resolve();await assert.rejects(pending,{code:change==='account'?'QQ_ACCOUNT_ACCOUNT_CHANGED':'QQ_ACCOUNT_INSTANCE_CHANGED'});assert.equal(f.calls.length,0);await assert.rejects(fs.stat(path.join(f.archiveRoot,'index.json')),{code:'ENOENT'});}
});
test('lost write response and missing publication confirmation remain unknown without overwriting evidence or replay',async t=>{
  for(const failure of ['lost','missing-tid']){const f=await fixture(t),args={text:'test',visibility:64};f.executeHook=()=>{if(failure==='lost')throw Error('private bridge secret');return{status:'completed',accountId:ACCOUNT,operation:'feed.publish',receiptId:'onebot-account:mock',confirmedBy:'onebot-api-success'};};const result=await f.execute('feed.publish',args);assert.equal(result.status,'unknown');assert.equal(result.outcomeUnknown,true);assert.equal(f.calls.length,1);const original=await fs.readFile(path.join(f.archiveRoot,'receipts',result.receiptId,'000001.json'));await f.service.close();const reopened=f.make();assert.equal((await f.execute('feed.publish',args,'trusted-account-call',reopened)).status,'unknown');assert.equal(f.calls.length,1);assert.deepEqual(await fs.readFile(path.join(f.archiveRoot,'receipts',result.receiptId,'000001.json')),original);assert.equal(original.toString().includes('private bridge secret'),false);}
});
test('permission revocation after prepared persistence records no dispatch and cannot trigger a later retry',async t=>{
  const f=await fixture(t);let grants=0;f.authorization=()=>++grants<3;
  await assert.rejects(f.execute('profile.avatar',{assetId}),{code:'QQ_ACCOUNT_PERMISSION'});assert.equal(f.calls.length,0);const index=await f.index();assert.equal(index.receipts[0].status,'failed');const event=JSON.parse(await fs.readFile(path.join(f.archiveRoot,'receipts',index.receipts[0].receiptId,'000001.json'),'utf8'));assert.equal(event.transportCalls,0);assert.equal((await f.execute('profile.avatar',{assetId})).duplicate,true);assert.equal(f.calls.length,0);
});
test('account prepared WAL interruption becomes unknown after restart without dispatching the original write',async t=>{
  let crash=true;const f=await fixture(t,{archiveFault:stage=>{if(crash&&stage==='after_prepare'){crash=false;throw Error('isolated disk interruption');}}});await assert.rejects(f.execute('feed.publish',{text:'test',visibility:64}));assert.equal(f.calls.length,0);await f.service.close();const restarted=f.make();const result=await f.execute('feed.publish',{text:'test',visibility:64},'trusted-account-call',restarted);assert.equal(result.status,'unknown');assert.equal(result.duplicate,true);assert.equal(f.calls.length,0);const event=JSON.parse(await fs.readFile(path.join(f.archiveRoot,'receipts',result.receiptId,'000001.json'),'utf8'));assert.equal(event.transportCalls,null);assert.equal(event.event,'interrupted');
});
test('new completed, unknown and prepared account documents remain inside the existing explicitly admitted maintenance schema',async t=>{
  const f=await fixture(t);await f.execute('profile.avatar',{assetId},'avatar');await f.execute('feed.publish',{text:'test',visibility:64},'feed');await f.execute('profile.update',{nickname:'名字'},'profile');await f.service.releaseRoot(f.memoryRoot);
  let count=0;async function scan(dir,relative=''){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const rel=relative?relative+'/'+entry.name:entry.name;if(entry.isDirectory())await scan(path.join(dir,entry.name),rel);else{const value=JSON.parse(await fs.readFile(path.join(dir,entry.name),'utf8'));assert.equal(validateDshMaintenanceExtension({path:'extensions/qq-account/'+rel,value}),true);count++;}}}await scan(f.archiveRoot);assert.ok(count>=10);
});
test('actual bridge transport and permission service complete avatar and Qzone through the account port without a conversation binding',async t=>{
  const f=await fixture(t),writes=[];const driver=createBridgeClient({platform:'qq',protocol:'onebot11',accountId:ACCOUNT,apiUrl:'http://127.0.0.1:39745'},{fetchImpl:async(url,init)=>{const name=new URL(url).pathname.slice(1),payload=JSON.parse(init.body);if(['set_qq_avatar','send_qzone_msg'].includes(name))writes.push({name,payload});const data=name==='get_login_info'?{user_id:ACCOUNT}:name==='get_status'?{online:true,good:true}:name==='get_version_info'?{app_name:'NapCat',app_version:'4.18.41'}:name==='can_send_record'||name==='can_send_image'?{yes:true}:name==='send_qzone_msg'?{tid:'real-mock-tid'}:null;return Response.json({status:'ok',retcode:0,data});}});await driver.inspectCapabilities();
  const service=createQQAccountService({...f.ports,getBridge:async()=>({...f.bridge,operations:driver.inspectAccountCapabilities().operations,executeAccount:(...args)=>driver.executeAccount(...args)})});t.after(()=>service.close());
  assert.equal((await f.execute('profile.avatar',{assetId},'actual-avatar-port',service)).status,'completed');const result=await f.execute('feed.publish',{text:'only fixture',imageAssetIds:[assetId],visibility:4},'actual-qzone-port',service);assert.equal(result.result.tid,'real-mock-tid');assert.deepEqual(writes.map(v=>v.name),['set_qq_avatar','send_qzone_msg']);assert.equal(writes[1].payload.ugc_right,4);assert.equal(writes[1].payload.images[0],'base64://'+png.toString('base64'));
});
test('postdispatch account replacement preserves a returned Qzone tid as evidence while reporting outcome unknown',async t=>{
  const f=await fixture(t);f.executeHook=(operation,_payload,context)=>{f.bridge={...f.bridge,accountId:'300003',connectionId:'b'.repeat(64)};return{status:'completed',operation,accountId:ACCOUNT,receiptId:'receipt-'+context.operationId,tid:'returned-tid-before-change',confirmedBy:'onebot-api-success'};};
  const result=await f.execute('feed.publish',{text:'test',visibility:64});assert.equal(result.status,'unknown');assert.equal(f.calls.length,1);const detail=await f.service.read({accountOperation:'receipt',accountId:ACCOUNT,receiptId:result.receiptId});const event=JSON.parse(detail.text).events[0];assert.equal(event.response.tid,'returned-tid-before-change');assert.equal(event.status,'unknown');assert.equal((await f.execute('feed.publish',{text:'test',visibility:64})).duplicate,true);assert.equal(f.calls.length,1);
});
test('close after dispatch drains the bridge write and preserves unknown status without replay or a lingering writer lock',async t=>{
  const f=await fixture(t),began=deferred(),finish=deferred();f.executeHook=async(operation,_payload,context)=>{began.resolve();await finish.promise;return{status:'completed',operation,accountId:ACCOUNT,receiptId:'receipt-'+context.operationId,confirmedBy:'onebot-api-success'};};
  const pending=f.execute('profile.avatar',{assetId});await began.promise;assert.equal(f.service.isBusy('persona-a'),true);const closing=f.service.close();finish.resolve();const result=await pending;assert.equal(result.status,'unknown');await closing;await f.service.releaseRoot(f.memoryRoot);await assert.rejects(fs.stat(path.join(f.archiveRoot,'writer.lock')),{code:'ENOENT'});const reopened=f.make();assert.equal((await f.execute('profile.avatar',{assetId},'trusted-account-call',reopened)).status,'unknown');assert.equal(f.calls.length,1);
});
test('asset and target cardinality limits reject excess data before any account write',async t=>{
  const f=await fixture(t);f.readAssetHook=()=>({bytes:new Uint8Array(8388609),mime:'image/png'});await assert.rejects(f.execute('profile.avatar',{assetId}),{code:'QQ_ACCOUNT_CAPACITY'});
  await assert.rejects(f.execute('feed.publish',{text:'test',visibility:16,targetUserIds:Array.from({length:101},(_,i)=>String(200000+i))}),{code:'QQ_ACCOUNT_ARGUMENT'});
  await assert.rejects(f.execute('feed.publish',{text:'test',visibility:64,imageAssetIds:Array.from({length:10},(_,i)=>'asset-'+i.toString(16).padStart(32,'0'))}),{code:'QQ_ACCOUNT_ARGUMENT'});assert.equal(f.calls.length,0);
});
test('actual new account documents survive explicit same-root backup and restore byte-for-byte and remain readable',async t=>{
  const f=await fixture(t),repository=new MemoryRepository({root:f.memoryRoot});await repository.open();await repository.close();
  const result=await f.execute('feed.publish',{text:'完整保留',imageAssetIds:[assetId],visibility:4});await f.service.releaseRoot(f.memoryRoot);
  const original=await fs.readFile(path.join(f.archiveRoot,'receipts',result.receiptId,'000000.json')),event=await fs.readFile(path.join(f.archiveRoot,'receipts',result.receiptId,'000001.json')),options={extensionValidator:validateDshMaintenanceExtension},destination=path.join(f.base,'backup');
  await validateMemoryRoot(f.memoryRoot,options);await createBackup({root:f.memoryRoot,destination,...options});await restoreBackup({root:f.memoryRoot,source:destination,...options});assert.deepEqual(await fs.readFile(path.join(f.archiveRoot,'receipts',result.receiptId,'000000.json')),original);assert.deepEqual(await fs.readFile(path.join(f.archiveRoot,'receipts',result.receiptId,'000001.json')),event);const detail=await f.service.read({accountOperation:'receipt',accountId:ACCOUNT,receiptId:result.receiptId});assert.equal(JSON.parse(detail.text).current.status,'completed');assert.equal(f.calls.length,1);
});
