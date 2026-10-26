import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryRepository,PersonaRuntime} from '../core/index.js';

async function fixture(t,{enabled=true,calls=8,complete,config:overrides={},text='我那时很难过，后来有了不同的理解。',countTokens=value=>Array.from(value).length}={}){
 const root=await mkdtemp(join(tmpdir(),'persona-advice-'));
 const config={...overrides,reviewAssistant:{...overrides.reviewAssistant,enabled},processingLimits:{...overrides.processingLimits,consolidationCallsPerSegment:calls}};
 const repository=new MemoryRepository({root,config}),runtime=new PersonaRuntime({repository,config,autoSchedule:false,model:{countTokens,complete}});
 await runtime.open();
 await repository.ingest({sourceSessionId:'actual-session',sourceEventId:'actual-event',sourceKind:'user',contentClass:'participant_dialogue',role:'user',origin:'user',channelId:'actual-channel',personId:null,text});
 t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true})});
 return{repository,runtime};
}
test('assistant disabled by default does not add a model call or authority',async t=>{
 const purposes=[];const f=await fixture(t,{enabled:false,complete:async request=>{purposes.push(request.purpose);assert.equal(JSON.parse(request.messages.at(-1).content).reviewAssistant,null);return{patch:{entries:[]}}}});
 assert.equal((await f.runtime.consolidate()).committed,true);assert.deepEqual(purposes,['consolidation']);
});
test('actual assistant advice can be disregarded and cannot write its suggested personality patch',async t=>{
 const purposes=[];let seen;
 const f=await fixture(t,{complete:async request=>{
  purposes.push(request.purpose);
  if(request.purpose==='memory_assistant'){assert.equal(request.maxOutputTokens,1024);return{text:JSON.stringify({entries:[{documentKey:'persona',recordId:'anchor',value:{text:'must be changed'}}],observations:[{category:'possible_context',detail:'Possible context omission; the personality decides.',recordIds:[]}]})};}
  seen=JSON.parse(request.messages.at(-1).content);return{patch:{entries:[]}};
 }});
 const result=await f.runtime.consolidate();assert.equal(result.committed,true);assert.deepEqual(purposes,['memory_assistant','consolidation']);
 assert.equal(seen.reviewAssistant.advisoryOnly,true);assert.equal(seen.reviewAssistant.entries,undefined);assert.equal((await f.repository.getPersona()).version,0);
 const run=await f.repository.getConsolidationRun(result.run.runId);assert.equal(run.reviewState.modelCalls,2);assert.equal(run.reviewState.assistantReceipt.status,'completed');
 assert.deepEqual((await f.repository.getUsage()).map(x=>x.purpose),purposes);
});
test('an unavailable optional assistant is reported and the personality can still commit unchanged',async t=>{
 let helper=0,main=0;const f=await fixture(t,{complete:async request=>{if(request.purpose==='memory_assistant'){helper++;throw Object.assign(new Error('uncertain provider outcome'),{code:'MODEL_INCOMPLETE'})}main++;const body=JSON.parse(request.messages.at(-1).content);assert.equal(body.reviewAssistant.status,'unavailable');return{patch:{entries:[]}};}});
 assert.equal((await f.runtime.consolidate()).committed,true);assert.equal(helper,1);assert.equal(main,1);
});
test('a shared one-call segment reserves execution for the personality',async t=>{
 const purposes=[];const f=await fixture(t,{calls:1,complete:async request=>{purposes.push(request.purpose);const body=JSON.parse(request.messages.at(-1).content);assert.equal(body.reviewAssistant.errorCode,'SHARED_CALL_BUDGET_RESERVED_FOR_PERSONALITY');return{patch:{entries:[]}};}});
 assert.equal((await f.runtime.consolidate()).committed,true);assert.deepEqual(purposes,['consolidation']);
});
test('retrying the same actual context page does not pay the assistant again',async t=>{
 let helper=0,main=0;const f=await fixture(t,{complete:async request=>{
  if(request.purpose==='memory_assistant'){helper++;return{text:'{"observations":[]}'}}main++;
  return{patch:main===1?{entries:[],readContext:{cursor:0}}:{entries:[]}};
 }});
 assert.equal((await f.runtime.consolidate()).committed,true);assert.equal(helper,1);assert.equal(main,2);
});
test('an explicit retry after a failed main call reuses the persisted assistant receipt',async t=>{
 let helper=0,main=0;const f=await fixture(t,{complete:async request=>{
  if(request.purpose==='memory_assistant'){helper++;return{text:'{"observations":[]}'}}main++;
  if(main===1)throw Object.assign(new Error('main response incomplete'),{code:'MODEL_INCOMPLETE'});return{patch:{entries:[]}};
 }});
 const run=await f.repository.prepareConsolidation();await assert.rejects(f.runtime.consolidate({runId:run.runId}),{code:'MODEL_INCOMPLETE'});
 const paused=await f.repository.getConsolidationRun(run.runId);assert.equal(paused.reviewState.assistantReceipt.status,'completed');
 assert.equal((await f.runtime.consolidate({runId:run.runId})).committed,true);assert.equal(helper,1);assert.equal(main,2);
});

test('long real-port inputs reserve advice space, keep identical source fragments and expose the actual shared call budget',async t=>{
 const source='长资料：不是我的决定😀é。'.repeat(700),calls=32,inputBudget=24576,requests=[],mainParts=[];
 let latestHelper=null,helperCount=0,adviceCount=0;
 const countTokens=value=>Buffer.byteLength(value,'utf8');
 const f=await fixture(t,{text:source,calls,countTokens,config:{processingLimits:{consolidationInputChars:16000,consolidationRequestTokens:inputBudget},reviewAssistant:{maxReportChars:2000}},complete:async request=>{
  const previousCalls=requests.length;requests.push(request.purpose);
  assert.ok(countTokens(JSON.stringify(request.messages))<=inputBudget);
  const body=JSON.parse(request.messages.at(-1).content);
  if(request.purpose==='memory_assistant'){
   helperCount++;latestHelper=body;
   return{text:JSON.stringify({observations:[{category:'possible_context',detail:'保真建议：请保留否定词和当时的情境😀。'.repeat(80),recordIds:body.input.chat.map(record=>record.id)}]})};
  }
  assert.notEqual(body.reviewAssistant,null);
  assert.equal(body.page.callBudget.used,previousCalls);
  assert.equal(body.page.callBudget.remaining,calls-previousCalls);
  if(body.reviewAssistant.status==='available'){
   assert.deepEqual(body.input.chat,latestHelper.input.chat);assert.deepEqual(body.input.hot,latestHelper.input.hot);
   assert.deepEqual(body.traceMaterial,latestHelper.traceMaterial);assert.deepEqual(body.input.context,latestHelper.memoryContext);
   if(body.reviewAssistant.observations.length){adviceCount++;assert.match(body.reviewAssistant.observations[0].detail,/保真建议/);}
  }else assert.ok(['omitted','skipped','unavailable','unknown'].includes(body.reviewAssistant.status));
  mainParts.push(...body.input.chat.map(record=>record.text));
  return{patch:{entries:[]}};
 }});
 const result=await f.runtime.consolidate();
 assert.equal(result.committed,true);assert.ok(helperCount>1);assert.ok(adviceCount>0);
 assert.equal(mainParts.join(''),source);assert.ok(requests.length<=calls);
 assert.equal((await f.repository.readSources({sourceRefs:[{sourceSessionId:'actual-session',sourceEventId:'actual-event'}]}))[0].text,source);
 assert.equal((await f.repository.getConsolidationRun(result.run.runId)).reviewState.modelCalls,requests.length);
});

test('a narrow actual input budget skips an unusable extra assistant call and tells the personality why',async t=>{
 const countTokens=value=>Buffer.byteLength(value,'utf8');let normalLength;
 const ordinary=await fixture(t,{enabled:false,text:'短',countTokens,complete:async request=>{normalLength=countTokens(JSON.stringify(request.messages));return{patch:{entries:[]}};}});
 assert.equal((await ordinary.runtime.consolidate()).committed,true);
 const purposes=[],limit=normalLength+240;
 const f=await fixture(t,{text:'短',countTokens,config:{processingLimits:{consolidationRequestTokens:limit}},complete:async request=>{
  purposes.push(request.purpose);assert.ok(countTokens(JSON.stringify(request.messages))<=limit);
  assert.equal(request.purpose,'consolidation');const body=JSON.parse(request.messages.at(-1).content);
  assert.equal(body.reviewAssistant.status,'skipped');assert.equal(body.reviewAssistant.errorCode,'ASSISTANT_REPORT_INPUT_BUDGET');
  assert.equal(body.page.callBudget.used,0);assert.equal(body.page.callBudget.remaining,8);return{patch:{entries:[]}};
 }});
 assert.equal((await f.runtime.consolidate()).committed,true);assert.deepEqual(purposes,['consolidation']);
});

test('an input budget too small for source and advice status makes no model call and consumes no source',async t=>{
 const purposes=[];const f=await fixture(t,{config:{processingLimits:{consolidationRequestTokens:1}},complete:async request=>{purposes.push(request.purpose);return{patch:{entries:[]}};}});
 const run=await f.repository.prepareConsolidation(),before=await f.repository.getPending();
 await assert.rejects(f.runtime.consolidate({runId:run.runId}),{code:'MODEL_INPUT_BUDGET'});
 assert.deepEqual(purposes,[]);assert.deepEqual(await f.repository.getPending(),before);
 const paused=await f.repository.getConsolidationRun(run.runId);assert.equal(paused.status,'prepared');assert.equal(paused.reviewState.modelCalls,0);
 assert.equal((await f.repository.getRuntime()).consolidationCursors.global,undefined);
});

test('explicit source forgetting redacts committed advice and patch bodies while preserving unrelated technical receipts',async t=>{
 const secret='WITHDRAWN_COMMITTED_BODY_这段原文不能从已提交助手报告复活',unrelated='UNRELATED_DIAGNOSTIC_STAYS';
 const f=await fixture(t,{text:'unrelated first event',complete:async request=>{
  const body=JSON.parse(request.messages.at(-1).content),isSecret=body.input.chat.some(record=>record.text.includes(secret));
  if(request.purpose==='memory_assistant')return{text:JSON.stringify({observations:[{detail:isSecret?secret:unrelated,recordIds:[]}]})};
  return{patch:{entries:isSecret?[{documentKey:'global:index',recordId:'secret_memory',expectedVersion:body.inputVersions['global:index'],operation:'upsert',value:{text:secret}}]:[]}};
 }});
 const first=await f.runtime.consolidate(),source=await f.repository.ingest({sourceSessionId:'actual-session',sourceEventId:'withdrawn-event',sourceKind:'user',contentClass:'participant_dialogue',role:'user',origin:'user',channelId:'actual-channel',personId:null,text:secret});
 const second=await f.runtime.consolidate(),before=await f.repository.getConsolidationRun(second.run.runId);
 assert.ok(JSON.stringify(before).includes(secret));assert.equal(before.sourceDependencies.format,'sha256-identities/1');
 assert.ok(!JSON.stringify(before.sourceDependencies).includes(secret));assert.equal(before.sourceDependencies.complete,true);
 await f.repository.forget({scope:'unknown',ids:[source.record.id],reason:'explicit request'});
 const after=await f.repository.getConsolidationRun(second.run.runId);
 assert.equal(after.status,'committed');assert.deepEqual(after.commitMarker,before.commitMarker);
 assert.equal(after.reviewState.modelCalls,before.reviewState.modelCalls);assert.equal(after.reviewState.assistantReceipt.status,'completed');
 assert.equal(after.reviewState.assistantReceipt.report,undefined);assert.equal(after.reviewState.assistantReceipt.reportRemoved,true);
 assert.deepEqual(after.validatedPatch,[]);assert.equal(after.contentRevocation.reason,'source_revoked');assert.ok(!JSON.stringify(after).includes(secret));
 assert.ok(JSON.stringify(await f.repository.getConsolidationRun(first.run.runId)).includes(unrelated));
 await f.repository.close();await f.repository.open();
 assert.ok(!(await f.repository.listConsolidationRuns()).some(run=>JSON.stringify(run).includes(secret)));
 assert.equal(await f.repository.getMemoryRecord('secret_memory'),null);
 assert.equal((await f.runtime.consolidate({runId:second.run.runId})).duplicate,true);
});

test('natural source eviction does not erase committed advice or reinterpretation diagnostics',async t=>{
 const detail='NATURAL_RETENTION_当时的感受可以继续保留';
 const f=await fixture(t,{text:detail,complete:async request=>request.purpose==='memory_assistant'?{text:JSON.stringify({observations:[{detail,recordIds:[]}]})}:{patch:{entries:[]}}});
 const source=(await f.repository.readSources({sourceRefs:[{sourceSessionId:'actual-session',sourceEventId:'actual-event'}]}))[0],result=await f.runtime.consolidate();
 const before=await f.repository.getConsolidationRun(result.run.runId);
 await f.repository.clearPending([source.eventId]);await f.repository.evictSources([source.id]);
 assert.deepEqual(await f.repository.getConsolidationRun(result.run.runId),before);
 await f.repository.close();await f.repository.open();
 assert.ok(JSON.stringify(await f.repository.getConsolidationRun(result.run.runId)).includes(detail));
});

test('legacy committed advice without complete provenance is scrubbed after explicit forgetting and on reopened legacy replay',async t=>{
 const detail='LEGACY_WITHDRAWN_DIAGNOSTIC_不可回查原文';let calls=0;
 const f=await fixture(t,{text:detail,complete:async request=>{calls++;return request.purpose==='memory_assistant'?{text:JSON.stringify({observations:[{detail,recordIds:[]}]})}:{patch:{entries:[]}};}});
 const source=(await f.repository.readSources({sourceRefs:[{sourceSessionId:'actual-session',sourceEventId:'actual-event'}]}))[0],result=await f.runtime.consolidate();
 const legacy=await f.repository.getConsolidationRun(result.run.runId);delete legacy.sourceDependencies;
 const journal='journal/runs/'+legacy.runId+'.json';await f.repository.store.transaction({runId:'legacy-shape-fixture',json:{[journal]:legacy}});
 await f.repository.forget({scope:'unknown',ids:[source.id],reason:'explicit request'});
 let after=await f.repository.getConsolidationRun(legacy.runId);
 assert.equal(after.status,'committed');assert.equal(after.contentRevocation.reason,'legacy_dependency_unavailable');assert.ok(!JSON.stringify(after).includes(detail));
 assert.deepEqual(after.commitMarker,legacy.commitMarker);
 // Reintroduce an old diagnostic as an isolated restore-shaped fixture, not a new model run.
 await f.repository.store.transaction({runId:'old-diagnostic-replay-fixture',json:{[journal]:legacy}});
 await f.repository.close();await f.repository.open();after=await f.repository.getConsolidationRun(legacy.runId);
 assert.ok(!JSON.stringify(after).includes(detail));assert.equal(after.reviewState.assistantReceipt.reportRemoved,true);
 assert.equal(calls,2);
});
