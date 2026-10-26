import test from 'node:test';
import assert from 'node:assert/strict';
import {scanProcessDependencies} from '../adapters/dsh/index.js';
import {normalizeDshEvent} from '../adapters/dsh/normalize.js';
import {boundToolOutput} from '../adapters/dsh/tool-output.js';

test('real tool result envelope IDs remain in original trace but are not memory record IDs',()=>{
  const data={turn:1,step:0,message:{id:'host-tool-message-uuid',role:'tool',source:{kind:'tool',callId:'call-a'},toolCallId:'call-a',content:[{type:'text',text:JSON.stringify({items:[{schemaVersion:'persona-memory/3',id:'actual-memory-id',srcRefs:[{sourceSessionId:'s',sourceEventId:'human'}]}],sourceRecordIds:['explicit-record-id']})}]}};
  const record=normalizeDshEvent({id:'s'},{type:'tool/result',seq:16,time:1,data}).hot[0],original=record.content.text;
  const result=scanProcessDependencies(record);
  assert.ok(result.recordIds.includes('actual-memory-id'));assert.ok(result.recordIds.includes('explicit-record-id'));
  assert.ok(!result.recordIds.includes('host-tool-message-uuid'));assert.deepEqual(result.refs,[{sourceSessionId:'s',sourceEventId:'human'}]);
  assert.equal(record.content.text,original);assert.ok(original.includes('host-tool-message-uuid'));assert.equal(record.kind,'tool_result');
});
test('platform IDs do not become memory identities while explicit memory references survive',()=>{
  const result=scanProcessDependencies({kind:'tool_result',sourceKind:'tool/result',content:{mode:'cached',text:JSON.stringify({message:{id:'transport',role:'tool',source:{kind:'tool'},content:[{type:'text',text:JSON.stringify({platforms:[{id:'qq'}],recordId:'reference-one',dependencyRecordIds:['reference-two'],injectedIds:['reference-three']})}]}})}});
  assert.deepEqual(result.recordIds.sort(),['reference-one','reference-three','reference-two']);
});
test('process scanning stays bounded and does not reinterpret ordinary dialogue IDs',()=>{
  let value={id:'platform'};for(let i=0;i<40;i++)value={next:value};
  const result=scanProcessDependencies({kind:'tool_result',sourceKind:'tool/result',content:{mode:'cached',text:JSON.stringify(value)}});
  assert.equal(result.complete,false);
  assert.ok(scanProcessDependencies({kind:'reasoning',sourceKind:'model',content:{mode:'cached',text:'{"recordId":"actual-reference"}'}}).recordIds.includes('actual-reference'));
});
test('bounded memory search headers keep explicit memory identity even without source refs',async()=>{
  const bounded=await boundToolOutput('memory_search',{items:[{schemaVersion:'persona-memory/3',id:'memory-without-source',text:'A retained self observation',srcRefs:[]}]},{query:'observation'},{counter:{count:async text=>text.length},budget:1500});
  const result=scanProcessDependencies({kind:'tool_result',sourceKind:'tool/result',content:{mode:'cached',text:JSON.stringify({message:{id:'host-envelope',role:'tool',source:{kind:'tool'},content:[{type:'text',text:JSON.stringify(bounded)}]}})}});
  assert.ok(result.recordIds.includes('memory-without-source'));assert.ok(!result.recordIds.includes('host-envelope'));
});
