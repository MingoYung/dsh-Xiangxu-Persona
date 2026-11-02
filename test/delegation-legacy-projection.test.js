import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createTaskArchive,taskHash} from '../adapters/dsh/delegation/archive.js';
import {createDelegationService} from '../adapters/dsh/delegation/service.js';

async function fixture(t,{count=1,rawFor}={}){
  const root=await mkdtemp(join(tmpdir(),'xiangxu-legacy-result-')),archive=createTaskArchive({root});await archive.ready;
  const old=[];for(let n=0;n<count;n++){
    const sourceRefs=[{sourceSessionId:'human',sourceEventId:'question-'+n}];
    const {task}=await archive.reserve({requestId:'legacy-'+n,requestHash:taskHash('intent-'+n),sessionId:'worker-'+n,parentSessionId:'parent',title:'legacy',sourceRefs,sourceRecordIds:[]});
    const raw=rawFor?.(n) ?? JSON.stringify({output:[{type:'reasoning',text:'fixture-process-marker-'+n},{type:'text',text:'public result '+n}],stopReason:'completed'});
    const doc=await archive.putDocument(task.taskId,{key:'legacy-native',name:'final-result.json',kind:'final_report',text:raw,encoding:'utf8',mime:'application/json'});
    await archive.patch(task.taskId,{status:'completed',capture:{afterSeq:0,complete:true,errorCode:null},resultDocumentId:doc.documentId,summary:{text:'public result '+n,truncated:false,documentId:doc.documentId}});
    old.push({taskId:task.taskId,doc,raw,sourceRefs});
  }await archive.close();
  const services=[],host={start:async()=>{throw Error('must not start');},inspect:async()=>{throw Error('sealed original unavailable');},readEvents:async()=>{throw Error('must not fetch');},registerTask:async()=>{},close:async()=>{}};
  const open=()=>{const service=createDelegationService({archiveRoot:root,host});services.push(service);return service;};
  t.after(async()=>{for(const s of services)await s.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true});});
  return {root,old,open};
}
const whole=async(service,taskId,documentId)=>{let offset=0,text='';while(true){const page=await service.read({taskId,documentId,offset,maxChars:23});text+=page.text;if(page.complete)return text;assert.ok(page.nextOffset>offset);offset=page.nextOffset;}};

test('sealed legacy native results gain a public view without touching original bytes or using the lost host',async t=>{
  const f=await fixture(t),old=f.old[0],service=f.open();await service.ready;
  const before=JSON.parse(await readFile(join(f.root,old.taskId,'manifest.json'),'utf8'));
  const current=await service.get({taskId:old.taskId});assert.notEqual(current.resultDocumentId,old.doc.documentId);
  assert.equal(await whole(service,old.taskId,current.resultDocumentId),'public result 0');
  assert.equal(await whole(service,old.taskId,old.doc.documentId),old.raw);
  const after=JSON.parse(await readFile(join(f.root,old.taskId,'manifest.json'),'utf8'));
  assert.deepEqual(after.documents.find(d=>d.documentId===old.doc.documentId),before.documents.find(d=>d.documentId===old.doc.documentId));
  assert.equal(after.documents.length,before.documents.length+1);await service.close();
  const recovered=f.open();await recovered.ready;const again=await recovered.get({taskId:old.taskId});
  assert.equal(again.resultDocumentId,current.resultDocumentId);assert.equal(again.documentCount,current.documentCount);
  const material=await recovered.material({taskId:old.taskId,documentId:old.doc.documentId,maxChars:23});assert.equal(material.memoryWritten,false);
  await recovered.forgetSources({sourceRefs:old.sourceRefs});await assert.rejects(recovered.read({taskId:old.taskId,documentId:current.resultDocumentId}),{code:'TASK_SOURCE_REVOKED'});
});

test('lazy projection metadata changes do not invalidate the next list page by themselves',async t=>{
  const f=await fixture(t,{count:2}),service=f.open();await service.ready;
  const a=await service.list({parentSessionId:'parent',limit:1}),b=await service.list({parentSessionId:'parent',limit:1,cursor:a.nextCursor});
  assert.equal(a.total,2);assert.equal(b.complete,true);assert.notEqual(a.items[0].taskId,b.items[0].taskId);
  for(const item of [...a.items,...b.items])assert.match(await whole(service,item.taskId,item.resultDocumentId),/^public result [01]$/);
  const facts=await service.sourceFacts({sourceRefs:f.old.flatMap(t=>t.sourceRefs),parentSessionIds:['parent'],limit:1});
  assert.equal(facts.items.length,1);assert.equal(facts.truncated,true);assert.equal(facts.items[0].relation,'dependency_reference');
  assert.equal(Object.hasOwn(facts.items[0],'answered'),false);
});

test('oversized or malformed legacy views remain explicit unavailable items without hiding other tasks or rewriting originals',async t=>{
  const oversized=JSON.stringify({text:'x'.repeat(4*1024*1024+1)});
  const f=await fixture(t,{count:3,rawFor:n=>n===0?oversized:n===1?'broken legacy JSON':undefined}),service=f.open();await service.ready;
  const page=await service.list({parentSessionId:'parent',limit:20});assert.equal(page.items.length,3);
  for(const [n,code] of [[0,'TASK_PUBLIC_PROJECTION_CAPACITY'],[1,'TASK_LEGACY_RESULT_INVALID']]){
    const old=f.old[n],item=page.items.find(row=>row.taskId===old.taskId);
    assert.equal(item.resultDocumentId,null);assert.equal(item.summary,null);
    assert.deepEqual({available:item.publicProjection.available,code:item.publicProjection.code,originalDocumentId:item.publicProjection.originalDocumentId},{available:false,code,originalDocumentId:old.doc.documentId});
    const detail=await service.get({taskId:old.taskId});assert.equal(detail.documents[0].documentId,old.doc.documentId);
    const stored=JSON.parse(await readFile(join(f.root,old.taskId,'manifest.json'),'utf8'));
    assert.equal(stored.resultDocumentId,old.doc.documentId);assert.equal(stored.documents.length,1);
    const original=await service.read({taskId:old.taskId,documentId:old.doc.documentId,maxChars:23});assert.equal(original.text,old.raw.slice(0,23));
  }
  const normal=page.items.find(row=>row.taskId===f.old[2].taskId);assert.equal(await whole(service,normal.taskId,normal.resultDocumentId),'public result 2');
});
