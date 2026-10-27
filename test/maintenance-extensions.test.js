import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { JsonStore } from '../core/store.js';
import { MemoryRepository } from '../core/repository.js';
import { validateMemoryRoot, createBackup, validateBackup, restoreBackup, recoverRestore } from '../core/maintenance.js';
import { createInstanceManager } from '../adapters/dsh/instances.js';
import { createQQAccountService } from '../adapters/dsh/connections/qq-account.js';
import { requireNoWriter } from '../adapters/dsh/instance-lifecycle.js';
import { validateDshMaintenanceExtension as extensionValidator } from '../adapters/dsh/maintenance-extensions.js';

const options = { extensionValidator }, sha = value => createHash('sha256').update(value).digest('hex');
const receiptId = 'qqop-'+'a'.repeat(32), queryId = 'qqquery-'+'b'.repeat(32), optionsRef='qqopts_'+'c'.repeat(32), targetRef='qqtarget_'+'d'.repeat(32);
function documents() {
 const response={protocol:'xiangxu-qq-native/1',bootId:'isolated-native-boot',accountId:'10001',userId:'10002',optionsRef,targetRef,relationship:'not_friend',addFriendSetting:1,requirements:{supported:true,verificationText:true,questionCount:0},expiresAt:100000};
 const row={receiptId,accountId:'10001',userId:'10002',status:'submitted',revisions:1,createdAt:1000,updatedAt:1001};
 return {
  'index.json':{schemaVersion:'xiangxu-qq-account/1',instanceId:'default',revision:2,receipts:[row],queries:[{queryId,accountId:'10001',userId:'10002',optionsRef,targetRef,bootId:response.bootId,expiresAt:100000,createdAt:1000}]},
  ['queries/'+queryId+'.json']:{schemaVersion:'xiangxu-qq-account/1',instanceId:'default',accountId:'10001',receivedAt:1000,response},
  ['receipts/'+receiptId+'/000000.json']:{schemaVersion:'xiangxu-qq-account/1',receiptId,instanceId:'default',accountId:'10001',operationId:'isolated-operation',request:{accountId:'10001',userId:'10002',optionsRef,targetRef,text:'isolated fixture'},source:{sourceSessionId:'isolated-session',sourceRefs:[],sourceRecordIds:[],sourceKind:'qq-account-operation',humanDialogue:false,bindingCreated:false},runtime:{protocol:'xiangxu-qq-native/1',bootId:response.bootId,abiVersion:'qq-win-53644-req-to-friend/1'},createdAt:1000,status:'prepared',nativeCalls:null,nativeCallUpperBound:1,query:response},
  ['receipts/'+receiptId+'/000001.json']:{schemaVersion:'xiangxu-qq-account/1',receiptId,revision:1,event:'request_result',status:'submitted',at:1001,response:{state:'submitted',nativeCalls:1}},
 };
}
async function fixture(t) {
 const temporary=await fs.realpath(os.tmpdir()),base=await fs.realpath(await fs.mkdtemp(path.join(temporary,'xiangxu-maint-extension-'))),root=path.join(base,'memory'),backup=path.join(base,'backup');
 const repository=new MemoryRepository({root,clock:()=>1000});await repository.open();await repository.close();const archiveRoot=path.join(root,'extensions','qq-account'),store=new JsonStore(archiveRoot);await store.open();await store.transaction({runId:'isolated-archive',json:documents()});await store.close();
 const social={schemaVersion:'xiangxu-social-provider-state/1',version:0,jobs:[],assets:[],pendingDeletes:[],revokedSourceKeys:[],revokedRecordIds:[]};await fs.mkdir(path.join(root,'extensions','qq-social'));await fs.writeFile(path.join(root,'extensions','qq-social','state.json'),JSON.stringify(social));
 t.after(async()=>{await store.close();await repository.close();const relative=path.relative(temporary,base);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(base).startsWith('xiangxu-maint-extension-'));await fs.rm(base,{recursive:true,force:true});});return{base,root,backup,archiveRoot,store,repository};
}
async function snapshot(root) {const files=[];async function visit(dir,relative=''){for(const item of await fs.readdir(dir,{withFileTypes:true})){const name=relative?relative+'/'+item.name:item.name;if(item.isDirectory())await visit(path.join(dir,item.name),name);else files.push([name,sha(await fs.readFile(path.join(dir,item.name)))]);}}await visit(root);return files.sort((a,b)=>a[0].localeCompare(b[0]));}
async function managerFor(t,f,extra={}) {
 const coordinator=config=>{const repository=new MemoryRepository({root:config.memoryRoot,clock:()=>1000}),agents=new Map();return{memoryRoot:config.memoryRoot,repository,agents,runtime:{},ready:repository.open(),close:()=>repository.close(),readyState:async()=>({loaded:true})};};
 const manager=createInstanceManager({initialRoot:f.root,registryPath:path.join(f.base,'instances.json'),createCoordinator:coordinator,maintenanceOptions:options,...extra});await manager.ready;t.after(()=>manager.close());return manager;
}

test('real nested JsonStore archives require explicit adapter admission and survive backup plus restore byte-for-byte',async t=>{
 const f=await fixture(t),before=await snapshot(f.archiveRoot);await assert.rejects(validateMemoryRoot(f.root),{code:'SCHEMA_UNSUPPORTED'});const valid=await validateMemoryRoot(f.root,options);assert.ok(valid.files.some(file=>/^extensions\/qq-account\/\.wal\/[a-f0-9]{64}\.json$/.test(file.path)));await createBackup({root:f.root,destination:f.backup,...options});await assert.rejects(validateBackup(f.backup),{code:'SCHEMA_UNSUPPORTED'});await validateBackup(f.backup,options);await restoreBackup({root:f.root,source:f.backup,...options});assert.deepEqual(await snapshot(f.archiveRoot),before);assert.equal((await validateMemoryRoot(f.root,options)).preparedWal,0);
});
test('nested WAL digest failure and a checksummed unknown entry both fail before any backup is installed',async t=>{
 const f=await fixture(t),directory=path.join(f.archiveRoot,'.wal'),file=path.join(directory,(await fs.readdir(directory))[0]),original=await fs.readFile(file),wal=JSON.parse(original);wal.digest='0'.repeat(64);await fs.writeFile(file,JSON.stringify(wal));await assert.rejects(createBackup({root:f.root,destination:f.backup,...options}),{code:'CORRUPT_WAL'});await assert.rejects(fs.access(f.backup),{code:'ENOENT'});
 const altered=JSON.parse(original);altered.entries.push({path:'../outside.json',text:JSON.stringify({schemaVersion:'xiangxu-qq-account/1'})});altered.digest=sha(JSON.stringify(altered.entries));await fs.writeFile(file,JSON.stringify(altered));await assert.rejects(validateMemoryRoot(f.root,options),{code:'INVALID_EXTENSION'});await fs.writeFile(file,original);assert.ok(await validateMemoryRoot(f.root,options));
});
test('extension paths do not inherit admission from a valid schema or valid-looking WAL filename',async t=>{
 const f=await fixture(t),bad=path.join(f.archiveRoot,'unrecognized.json');await fs.writeFile(bad,JSON.stringify(documents()['index.json']));await assert.rejects(validateMemoryRoot(f.root,options),{code:'INVALID_EXTENSION'});await fs.unlink(bad);
 const wrong=path.join(f.archiveRoot,'.wal','0'.repeat(64)+'.json'),wal=JSON.parse(await fs.readFile(path.join(f.archiveRoot,'.wal',(await fs.readdir(path.join(f.archiveRoot,'.wal')))[0]),'utf8'));await fs.writeFile(wrong,JSON.stringify(wal));await assert.rejects(validateMemoryRoot(f.root,options),{code:'INVALID_EXTENSION'});await fs.unlink(wrong);
 const unrelated=path.join(f.root,'extensions','other');await fs.mkdir(unrelated);await fs.writeFile(path.join(unrelated,'index.json'),JSON.stringify(documents()['index.json']));await assert.rejects(validateMemoryRoot(f.root,options),{code:'SCHEMA_UNSUPPORTED'});
});
test('active nested writers block offline validation, backup and restore, while their locks never enter a backup',async t=>{
 const f=await fixture(t);await createBackup({root:f.root,destination:f.backup,...options});await f.store.open();const before=await snapshot(f.archiveRoot);await assert.rejects(validateMemoryRoot(f.root,options),{code:'WRITER_LOCKED'});await assert.rejects(createBackup({root:f.root,destination:f.backup,...options}),{code:'WRITER_LOCKED'});await assert.rejects(restoreBackup({root:f.root,source:f.backup,...options}),{code:'WRITER_LOCKED'});await assert.rejects(requireNoWriter(f.root),{code:'INSTANCE_WRITER_ACTIVE'});assert.deepEqual(await snapshot(f.archiveRoot),before);await f.store.close();const valid=await validateBackup(f.backup,options);assert.equal(valid.files.some(file=>file.path.endsWith('writer.lock')),false);
});
test('recognized stale nested locks are omitted, but an unknown nested lock remains fail-closed',async t=>{
 const f=await fixture(t),lock=path.join(f.archiveRoot,'writer.lock');await fs.writeFile(lock,JSON.stringify({pid:2147483647,token:'isolated-stale-token'}));assert.equal((await validateMemoryRoot(f.root,options)).files.some(file=>file.path.endsWith('writer.lock')),false);await fs.unlink(lock);const unknown=path.join(f.root,'extensions','other');await fs.mkdir(unknown);await fs.writeFile(path.join(unknown,'writer.lock'),JSON.stringify({pid:process.pid,token:'unknown'}));await assert.rejects(validateMemoryRoot(f.root,options),{code:'UNSUPPORTED_FILE'});
});
test('prepared nested WAL is checksum-validated and retains its deferred transaction for the extension writer',async t=>{
 const f=await fixture(t);const prepared=new JsonStore(f.archiveRoot,{fault:phase=>{if(phase==='after_prepare')throw Error('isolated interruption');}});await prepared.open();const current=documents()['index.json'];current.revision++;await assert.rejects(prepared.transaction({runId:'pending-archive',json:{'index.json':current}}),/interruption/);await prepared.close();assert.equal((await validateMemoryRoot(f.root,options)).preparedWal,1);await createBackup({root:f.root,destination:f.backup,...options});await restoreBackup({root:f.root,source:f.backup,...options});assert.equal((await validateMemoryRoot(f.root,options)).preparedWal,1);await f.store.open();assert.equal((await f.store.readJson('index.json')).revision,3);await f.store.close();assert.equal((await validateMemoryRoot(f.root,options)).preparedWal,0);
});
test('interrupted extension restore retains its journal until recovery receives the same validation port',async t=>{
 const f=await fixture(t),before=await snapshot(f.archiveRoot);await createBackup({root:f.root,destination:f.backup,...options});await assert.rejects(restoreBackup({root:f.root,source:f.backup,...options,fault:phase=>{if(phase==='after_root_moved')throw Error('isolated root switch interruption');}}),/root switch/);await assert.rejects(recoverRestore({root:f.root}),{code:'SCHEMA_UNSUPPORTED'});await assert.rejects(fs.access(f.root),{code:'ENOENT'});assert.equal((await recoverRestore({root:f.root,...options})).recovered,true);assert.deepEqual(await snapshot(f.archiveRoot),before);
});
test('instance maintenance passes extension validation through validate, backup, restore and recovery',async t=>{
 const f=await fixture(t),manager=await managerFor(t,f);assert.ok((await manager.maintenance.validate()).fileCount>0);await manager.maintenance.backup({destination:f.backup});await manager.maintenance.restore({source:f.backup});assert.equal(manager.current,null);await manager.maintenance.recover();await manager.load();assert.ok(manager.current);assert.ok((await manager.maintenance.validate()).fileCount>0);
});
test('instance clear removes the exact account archive and leaves the external shared native journal intact',async t=>{
 const f=await fixture(t),external=path.join(f.base,'managed-native-journal');await fs.mkdir(external);await fs.writeFile(path.join(external,'operation.json'),'shared platform receipt');const manager=await managerFor(t,f),preview=await manager.clearPreview();assert.ok(preview.files>4);const result=await manager.clear({confirmationToken:preview.confirmationToken,typedName:preview.requiresName});assert.equal(result.status,'cleared');assert.equal(result.remainingFiles,0);assert.deepEqual(await snapshot(f.root),[]);assert.equal(await fs.readFile(path.join(external,'operation.json'),'utf8'),'shared platform receipt');
});
test('clear refuses an unexpected revision or active nested writer and preserves all approved documents',async t=>{
 const f=await fixture(t),manager=await managerFor(t,f),bad=path.join(f.archiveRoot,'receipts',receiptId,'000065.json');await fs.writeFile(bad,'{}');const before=await snapshot(f.archiveRoot);await assert.rejects(manager.clearPreview(),{code:'INSTANCE_CLEAR_UNKNOWN_FILE'});assert.deepEqual(await snapshot(f.archiveRoot),before);await fs.unlink(bad);await f.store.open();const preview=await manager.clearPreview();await assert.rejects(manager.clear({confirmationToken:preview.confirmationToken,typedName:preview.requiresName}),{code:'INSTANCE_WRITER_ACTIVE'});assert.ok((await fs.stat(path.join(f.archiveRoot,'index.json'))).isFile());await f.store.close();
});

test('documents produced by the actual account service pass maintenance without copying a handwritten schema fixture',async t=>{
 const f=await fixture(t),isolatedRoot=path.join(f.base,'actual-service-memory'),repo=new MemoryRepository({root:isolatedRoot,clock:()=>1000});await repo.open();await repo.close();
 const runtime={enabled:true,protocol:'xiangxu-qq-native/1',abiVersion:'qq-win-53644-req-to-friend/1',bootId:'actual-service-isolated-boot',expectedAccountId:'10001',baseUrl:'http://127.0.0.1:31001',token:'isolated-native-authentication-token'},calls=[];
 const service=createQQAccountService({getCoordinator:()=>({instanceId:'default',memoryRoot:isolatedRoot,ready:Promise.resolve()}),getRuntime:()=>runtime,authorize:()=>true,clock:()=>1000,fetchImpl:async(url,request)=>{
  calls.push(url);assert.ok(url.startsWith(runtime.baseUrl+'/v1/'));assert.equal(request.headers.authorization,'Bearer '+runtime.token);const identity={protocol:runtime.protocol,bootId:runtime.bootId,accountId:runtime.expectedAccountId};
  if(url.endsWith('/inspect'))return Response.json({...identity,ready:true,abiVersion:runtime.abiVersion,capabilities:{query:{supported:true,available:true},request:{supported:true,available:true},respond:{supported:false,available:false}}});
  if(url.endsWith('/friend/query'))return Response.json({...identity,userId:'10002',targetRef,optionsRef,relationship:'not_friend',addFriendSetting:1,requirements:{supported:true,verificationText:true,questionCount:0},expiresAt:100000});
  if(url.endsWith('/friend/request')){const payload=JSON.parse(request.body);return Response.json({...identity,operationId:payload.operationId,optionsRef:payload.optionsRef,userId:'10002',targetRef,state:'submitted',nativeCalls:1,confirmedBy:'mock-native-receipt'});}
  throw Error('Unmocked transport route');
 }});
 t.after(()=>service.close());const queried=await service.read({accountOperation:'friend.query',userId:'10002'});await service.execute({accountOperation:'friend.request',accountId:'10001',optionsRef:queried.optionsRef,text:'isolated mocked operation'},{operationId:'isolated-service-contract',sourceSessionId:'fixture-session'});await service.close();
 assert.ok((await validateMemoryRoot(isolatedRoot,options)).files.some(file=>file.path.includes('/receipts/')));const saved=path.join(f.base,'actual-service-backup');await createBackup({root:isolatedRoot,destination:saved,...options});await restoreBackup({root:isolatedRoot,source:saved,...options});assert.ok(calls.some(url=>url.endsWith('/friend/query')));assert.ok(calls.every(url=>url.startsWith(runtime.baseUrl)),'all transport is the in-process mock');
});
