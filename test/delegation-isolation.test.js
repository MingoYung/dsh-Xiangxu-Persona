import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createDelegationIsolation,isDelegationMetadata} from '../adapters/dsh/delegation/isolation.js';
import {normalizeDshEvent} from '../adapters/dsh/normalize.js';
import {MemoryRepository} from '../core/repository.js';

const taskId='task-'+ 'a'.repeat(32),documentId='doc-'+ 'b'.repeat(32),session={id:'parent-session'};
const call=(id='call-task',action='read')=>({type:'assistant/message',seq:3,data:{turn:1,message:{id:'assistant-call',role:'assistant',content:[{type:'tool-call',id,name:'persona_task',arguments:JSON.stringify({action,taskId,documentId,prompt:'PRIVATE_TASK_PROMPT',title:'PRIVATE_TITLE',offset:0,limit:200})}]}}});
const result=(id='call-task',value={taskId,documentId,status:'completed',text:'PRIVATE_TASK_TEXT'})=>({type:'tool/result',seq:4,time:120,data:{turn:1,step:2,message:{id:'result-message',role:'tool',toolCallId:id,source:{kind:'tool',callId:id},content:[{type:'text',text:JSON.stringify(value)}]},error:{message:'PRIVATE_ERROR_DETAIL'}}});
async function normalized(isolation,event,options={}){const projected=await isolation.projectEventForMemory(session,event);return projected.skip?{dialogue:null,hot:[],ignored:projected.reason}:normalizeDshEvent(session,projected.event,{now:130,...isolation.normalizationOptions(session),...options});}

test('trusted worker session role prevents AI delegation kind:user from entering human originals or temporary personality process',async()=>{
  const worker={sessionId:'child-session',taskId,parentSessionId:session.id,origin:'assistant_delegation',workerPresetId:'xiangxu-task-worker'};
  const isolation=createDelegationIsolation({lookupWorker:id=>id===worker.sessionId?worker:null});
  const event={type:'user/message',seq:1,data:{id:'worker-instruction',role:'user',source:{kind:'user'},content:[{type:'text',text:'AI_WRITTEN_TASK_INSTRUCTION'}]}};
  assert.equal(isolation.isWorkerSession(worker.sessionId),true);
  const output=normalizeDshEvent({id:worker.sessionId},event,isolation.normalizationOptions(worker.sessionId));
  assert.equal(output.dialogue,null);assert.deepEqual(output.hot,[]);assert.equal(output.ignored,'delegation_worker_session');
  assert.equal((await isolation.projectEventForMemory({id:worker.sessionId},event)).skip,true);
  assert.equal(normalizeDshEvent(session,event,isolation.normalizationOptions(session)).dialogue.text,'AI_WRITTEN_TASK_INSTRUCTION');
  isolation.close();
});

test('message-provided worker or metadata tags cannot suppress actual human dialogue',async()=>{
  const isolation=createDelegationIsolation();
  const event={type:'user/message',seq:1,data:{id:'real-user',executionRole:'worker',taskId,source:{kind:'user',executionRole:'worker',origin:'assistant_delegation'},content:[{type:'text',text:'REAL_HUMAN_TEXT',memoryClass:'persona-task:metadata'}]}};
  assert.equal(isolation.isWorkerSession(session),false);
  assert.equal((await normalized(isolation,event)).dialogue.text,'REAL_HUMAN_TEXT');
  assert.equal(normalizeDshEvent(session,event).dialogue.role,'user');isolation.close();
});

test('mixed assistant text, reasoning and unrelated tools keep their meaning while task arguments become navigational metadata',async()=>{
  const isolation=createDelegationIsolation(),event=call();
  event.data.message.content.unshift({type:'reasoning',text:'MY_OWN_REASONING'},{type:'text',text:'MY_VISIBLE_REPLY'});
  event.data.message.content.push({type:'tool-call',id:'memory-query',name:'memory_search',arguments:'{"query":"PERSONAL_QUERY"}'});
  const before=structuredClone(event),projection=await isolation.projectEventForMemory(session,event),out=normalizeDshEvent(session,projection.event);
  assert.deepEqual(event,before);assert.equal(out.dialogue.text,'MY_VISIBLE_REPLY');
  assert.equal(out.hot[0].content.text,'MY_OWN_REASONING');assert.equal(out.hot[2].blockIndex,2);assert.equal(out.hot[2].sourceKind,'persona-task:metadata');
  assert(!out.hot[2].content.text.includes('PRIVATE_TASK_PROMPT'));assert(!out.hot[2].content.text.includes('PRIVATE_TITLE'));
  assert(out.hot[2].content.text.includes(taskId));assert.equal(out.hot[2].sourceRef.sourceRole,'assistant');
  assert(out.hot[3].content.text.includes('PERSONAL_QUERY'));assert.equal(out.hot[3].sourceKind,'model');
  assert.equal(projection.event.seq,event.seq);assert.equal(out.hot[2].sourceRef.sourceEventId,'assistant-call');isolation.close();
});

test('actual task tool results retain IDs and completeness without copying engineering text, names, summaries or error messages',async()=>{
  const isolation=createDelegationIsolation();await isolation.projectEventForMemory(session,call());
  const event=result('call-task',{taskId,documentId,status:'completed',offset:0,totalChars:50000,nextCursor:'opaque-cursor',complete:false,
    title:'PRIVATE_TASK_TITLE',summary:{text:'PRIVATE_SUMMARY'},text:'PRIVATE_REPORT',documents:[{documentId,name:'PRIVATE_FILENAME',kind:'report',bytes:10000,chars:5000}],untrusted:{text:'PRIVATE_EXTRA'}});
  const raw=JSON.stringify(event),projection=await isolation.projectEventForMemory(session,event),out=normalizeDshEvent(session,projection.event),body=JSON.stringify(out);
  assert.equal(JSON.stringify(event),raw);for(const text of['PRIVATE_REPORT','PRIVATE_SUMMARY','PRIVATE_FILENAME','PRIVATE_TASK_TITLE','PRIVATE_EXTRA','PRIVATE_ERROR_DETAIL'])assert(!body.includes(text));
  assert(body.includes(taskId));assert(body.includes(documentId));const navigation=JSON.parse(JSON.parse(out.hot[0].content.text).message.content[0].text);assert.equal(navigation.hasMore,true);assert.equal(navigation.complete,false);
  assert.equal(out.dialogue,null);assert.equal(out.hot[0].sourceKind,'persona-task:metadata');assert.equal(out.hot[0].sourceRef.sourceRole,'assistant');assert(isDelegationMetadata(projection.event.data));isolation.close();
});

test('cold source and host-trace rereads resolve actual call identity instead of reopening raw task bodies',async()=>{
  const invocations=[],lookupCall=async request=>{invocations.push(request);return{name:'persona_task',arguments:JSON.parse(call().data.message.content[0].arguments)}};
  const live=createDelegationIsolation({lookupCall});await live.projectEventForMemory(session,call());const original=result();
  const a=await normalized(live,original);live.close();
  const cold=createDelegationIsolation({lookupCall});const b=await normalized(cold,original);
  assert.deepEqual(b,a);assert.equal(invocations.length,1);assert.equal(invocations[0].callId,'call-task');assert(!JSON.stringify(b).includes('PRIVATE_TASK_TEXT'));cold.close();
});

test('call identity is scoped to the actual parent session and is found in actual derived messages when available',async()=>{
  const isolation=createDelegationIsolation();isolation.registerCall({id:'unrelated-session'},'same-id',{name:'memory_search',arguments:{query:'x'}});
  const historySession={id:session.id,deriveMessages:()=>[{role:'assistant',content:[{type:'tool-call',id:'same-id',name:'persona_task',arguments:'{"action":"status","taskId":"'+taskId+'"}'}]}]};
  const projection=await isolation.projectEventForMemory(historySession,result('same-id'));
  assert(projection.isolated);assert(!JSON.stringify(projection.event).includes('PRIVATE_TASK_TEXT'));isolation.close();
});

test('unresolved or malformed tool call IDs fail closed to explicit source-unavailable navigation; old no-ID events keep compatibility',async()=>{
  const isolation=createDelegationIsolation();
  for(const id of['unresolved','bad\ncall','x'.repeat(600)]){const projection=await isolation.projectEventForMemory(session,result(id));assert.equal(projection.unresolved,true);assert(!JSON.stringify(projection.event).includes('PRIVATE_TASK_TEXT'));assert(JSON.stringify(projection.event).includes('originalRetainedByHost'));}
  const legacy=result();delete legacy.data.message.toolCallId;delete legacy.data.message.source.callId;
  assert.equal((await isolation.projectEventForMemory(session,legacy)).event,legacy);isolation.close();
});

test('a different tool cannot claim to be a task by putting routing tags inside its result',async()=>{
  const isolation=createDelegationIsolation();isolation.registerCall(session,'ordinary-call',{name:'memory_search',arguments:{query:'a'}});
  const event=result('ordinary-call',{name:'persona_task',memoryClass:'persona-task:metadata',text:'ORIGINAL_MEMORY_RESULT'});
  event.data.name='persona_task';const projection=await isolation.projectEventForMemory(session,event);assert.equal(projection.event,event);assert.equal(projection.isolated,false);
  assert.equal(normalizeDshEvent(session,event).hot[0].sourceKind,'tool/result');isolation.close();
});

test('tool/call and direct execute registration supply actual task identity without trusting a tool-result payload',async()=>{
  const isolation=createDelegationIsolation();await isolation.projectEventForMemory(session,{type:'tool/call',seq:2,data:{call:{id:'actual-call',name:'persona_task',arguments:{action:'spawn',prompt:'PRIVATE_DISPATCH'}}}});
  assert((await isolation.projectEventForMemory(session,result('actual-call'))).isolated);
  isolation.registerCall(session,'direct-call',{name:'persona_task',arguments:{action:'retain',taskId,documentId}});
  const out=await normalized(isolation,result('direct-call',{taskId,documentId,retained:true,text:'PRIVATE_RETAIN_RESULT_COPY'}));assert(!JSON.stringify(out).includes('PRIVATE_RETAIN_RESULT_COPY'));assert(JSON.stringify(out).includes('retain'));isolation.close();
});

test('metadata cache eviction cannot reopen a task result when a host lookup remains available',async()=>{
  let lookups=0;const isolation=createDelegationIsolation({maxCalls:1,lookupCall:async()=>{lookups++;return{name:'persona_task',arguments:{action:'status',taskId}}}});
  isolation.registerCall(session,'old',{name:'persona_task',arguments:{action:'spawn'}});isolation.registerCall(session,'new',{name:'memory_search'});
  const projection=await isolation.projectEventForMemory(session,result('old'));assert.equal(lookups,1);assert(projection.isolated);assert(!JSON.stringify(projection.event).includes('PRIVATE_TASK_TEXT'));isolation.close();
});

test('normal consolidation sees navigation until an actual selected task material is explicitly offered for autonomous review',async t=>{
  const root=await mkdtemp(join(tmpdir(),'xiangxu-task-isolation-')),repository=new MemoryRepository({root});await repository.open();
  t.after(async()=>{await repository.close();assert(resolve(root).startsWith(resolve(tmpdir())+sep+'xiangxu-task-isolation-'));await rm(root,{recursive:true,force:true});});
  const isolation=createDelegationIsolation();t.after(()=>isolation.close());await isolation.projectEventForMemory(session,call());
  const output=await normalized(isolation,result());for(const record of output.hot)await repository.captureHot(record);
  let run=await repository.prepareConsolidation();assert(!JSON.stringify(run.input).includes('PRIVATE_TASK_TEXT'));assert(JSON.stringify(run.input).includes(taskId));
  // This is the explicit material selected by the personality, not an automatic classification decision.
  await repository.captureHot({personId:null,sourceKind:'persona-task:retained',origin:'system',kind:'tool_result',speakerId:null,
    sourceRef:{sourceSessionId:'child-session',sourceEventId:'task-material:'+documentId+':selected',sourceKind:'persona-task:retained',sourceRole:'assistant',sourceOrigin:'system',available:true},
    content:{mode:'cached',text:'SELF_SELECTED_RESEARCH_CONCLUSION',chars:33},dependencyRefs:[],dependencyRecordIds:[],dependencyScanComplete:true});
  run=await repository.prepareConsolidation();assert(JSON.stringify(run.input).includes('SELF_SELECTED_RESEARCH_CONCLUSION'));assert(!run.input.chat.some(item=>item.role==='user'));
});

test('archive_file keeps its actual action and document range without retaining the file path',async()=>{const isolation=createDelegationIsolation();const event=call();event.data.message.content[0].arguments=JSON.stringify({action:'archive_file',taskId,path:'PRIVATE_WORKSPACE_PATH',documentOffset:20,documentLimit:5});const out=await normalized(isolation,event);const navigation=JSON.parse(JSON.parse(out.hot[0].content.text).arguments);assert.equal(navigation.action,'archive_file');assert.equal(navigation.documentOffset,20);assert.equal(navigation.documentLimit,5);assert(!JSON.stringify(out).includes('PRIVATE_WORKSPACE_PATH'));isolation.close();});

test('a paginated task card preserves total document count, next document offset and incomplete capture independently from completed task status',async()=>{const isolation=createDelegationIsolation();await isolation.projectEventForMemory(session,call());const out=await normalized(isolation,result('call-task',{taskId,status:'completed',documentCount:51,documentsComplete:false,nextDocumentOffset:20,documents:[{documentId,name:'PRIVATE_DOCUMENT_NAME',bytes:9}],capture:{afterSeq:23,complete:false,errorCode:'TASK_CAPACITY',text:'PRIVATE_CAPTURE_BODY'},errorCode:'TASK_CAPACITY'}));const nav=JSON.parse(JSON.parse(out.hot[0].content.text).message.content[0].text);assert.equal(nav.status,'completed');assert.equal(nav.documentCount,51);assert.equal(nav.listedDocuments,1);assert.equal(nav.documentsComplete,false);assert.equal(nav.nextDocumentOffset,20);assert.deepEqual(nav.capture,{afterSeq:23,complete:false,errorCode:'TASK_CAPACITY'});assert.equal(nav.errorCode,'TASK_CAPACITY');assert(!JSON.stringify(out).includes('PRIVATE_'));isolation.close();});

test('a starting task stays starting and unresolved free-form status text is not copied',async()=>{const isolation=createDelegationIsolation();await isolation.projectEventForMemory(session,call());const out=await normalized(isolation,result('call-task',{taskId,status:'starting'}));const nav=JSON.parse(JSON.parse(out.hot[0].content.text).message.content[0].text);assert.equal(nav.status,'starting');const weird=await normalized(isolation,result('call-task',{taskId,status:'PRIVATE_STATUS_TEXT'}));assert(!JSON.stringify(weird).includes('PRIVATE_STATUS_TEXT'));isolation.close();});

test('closed isolation cannot classify or project a later event',async()=>{
  const isolation=createDelegationIsolation();isolation.close();assert.throws(()=>isolation.isWorkerSession(session),{code:'DELEGATION_ISOLATION_CLOSED'});await assert.rejects(isolation.projectEventForMemory(session,result()),{code:'DELEGATION_ISOLATION_CLOSED'});
});
