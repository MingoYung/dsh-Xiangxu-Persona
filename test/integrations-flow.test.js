import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeOneBotEvent } from '../adapters/dsh/channels/onebot.js';
import { createDshChannelPort } from '../adapters/dsh/channels/native.js';
import { createChannelService } from '../adapters/dsh/channels/service.js';
import { normalizeDshEvent } from '../adapters/dsh/normalize.js';
import { createIncomingMediaPort, mono16kWav } from '../adapters/dsh/channels/incoming-media.js';
import { attachPlatformImages, renderPlatformOutput } from '../adapters/dsh/platform-images.js';
import { MemoryRepository } from '../core/index.js';
import { createDshCoordinator } from '../adapters/dsh/index.js';
import { createManagementService } from '../adapters/dsh/management.js';
import { boundToolOutput } from '../adapters/dsh/tool-output.js';
import { requireNoWriter, scanManagedText } from '../adapters/dsh/instance-lifecycle.js';

const profile = { platform:'qq',protocol:'onebot11',accountId:'100' };
const event = (message_id=1,message=[{type:'face',data:{id:14}}]) => ({post_type:'message',message_type:'group',self_id:100,user_id:11,group_id:200,message_id,time:1000,message,sender:{user_id:11}});
async function temp(t) { const dir=await realpath(await mkdtemp(join(tmpdir(),'xiangxu-integration-flow-')));t.after(()=>rm(dir,{recursive:true,force:true}));return dir; }
function wav(rate=16000,channels=1){const n=rate/100,bytes=Buffer.alloc(44+n*channels*2);bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(channels,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*channels*2,28);bytes.writeUInt16LE(channels*2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);return bytes;}

test('structured-only native mail preserves actor, original empty text, independent media-derived material and replay idempotence',async t=>{
  const root=await temp(t),decoded=decodeOneBotEvent(profile,event()),messages=[];
  const sessionId='xiangxu-social-'+'a'.repeat(32),agent={id:sessionId,session:{id:sessionId,deriveMessages:()=>messages},inbox:{nextTurn:[],nextStep:[]},followup:m=>messages.push(m)};
  const coordinator={memoryRoot:root,ready:Promise.resolve(),registerExternalChannel:async()=>{},attachAgent:async()=>{}};
  const port=createDshChannelPort({ctx:{agents:{get:()=>agent},get:key=>key==='sessions'?{flush:async()=>{}}:undefined},getCoordinator:()=>coordinator});
  const binding={sessionId,memoryRoot:root,facts:decoded};
  const structured={rich:decoded.rich,derived:[{kind:'audio_transcript',text:'识别出的句子',sourceSegmentIndex:1,verbatimTypedText:false}],images:[]};
  const input={messageId:'rich-message',text:'',structured,sourceFacts:{messageId:'1',sourceAt:1000000}};
  await port.send(binding,input);await port.send(binding,input);assert.equal(messages.length,1);
  const normalized=normalizeDshEvent({id:sessionId},{type:'user/message',data:messages[0],time:1000000});
  assert.equal(normalized.dialogue.text,'');assert.equal(normalized.dialogue.role,'user');assert.equal(normalized.dialogue.sourceAt,1000000);
  assert.equal(normalized.hot.length,1);assert.equal(normalized.hot[0].kind,'plugin_state');assert.equal(normalized.hot[0].speakerId,null);assert(normalized.hot[0].content.text.includes('识别出的句子'));
  const repo=new MemoryRepository({root});await repo.open();t.after(()=>repo.close());await repo.ingest(normalized.dialogue);await repo.captureHot(normalized.hot[0]);
  const context=await repo.getContext({personId:null});assert.equal(context.records[0].text,'');assert.equal(context.records.some(r=>r.text.includes('识别出的句子')),false);await port.close();
});

test('channel intake accepts media-only events and fingerprints rich facts before native dispatch',async t=>{
  const root=await temp(t);let disk=null;const received=[];const service=createChannelService({getCoordinator:()=>({memoryRoot:root,ready:Promise.resolve(),agents:new Map()}),port:0,storage:{read:async()=>disk,write:async next=>{disk=structuredClone(next);}},channelPort:{create:async b=>b,send:async(b,m)=>received.push(m),close:async()=>{}},clientFactory:()=>({probe:async()=>({connected:true,status:'connected',capabilities:{text:true,group:true}})})});t.after(()=>service.close());await service.ready;
  await service.configure({id:'qq',config:{apiUrl:'http://127.0.0.1:32123',accountId:'100',allowedGroupIds:['200']}});const ingress=await service.rotateIngress({id:'qq'}),status=await service.start({id:'qq'}),url=status.connections[0].callbackUrl;
  const post=async payload=>{const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+ingress.ingressToken},body:JSON.stringify(payload)});return{http:response.status,body:await response.json()};};
  assert.equal((await post(event())).body.status,'accepted');assert.equal(received[0].text,'');assert.equal(received[0].structured.rich.faces[0].faceId,'14');
  assert.equal((await post(event())).body.duplicate,true);assert.equal(received.length,1);
  const conflict=await post(event(1,[{type:'face',data:{id:15}}]));assert.equal(conflict.http,400);assert.equal(conflict.body.error.code,'CHANNEL_MESSAGE_CONFLICT');
});

test('host STT and vision are actual separate ports; transcripts are marked derived and unsupported formats remain unresolved',async()=>{
  const decoded=decodeOneBotEvent(profile,event(2,[{type:'record',data:{file:'actual-bridge-file'}}]));let calls=0;
  const port=createIncomingMediaPort({ctx:{get:key=>key==='speechToText'?{resolve:spec=>{assert.equal(Buffer.from(spec.audio).readUInt32LE(24),16000);return spec;},transcribe:async()=>{calls++;return{text:'真实测试转写'};}}:undefined}});
  const client={resolveMedia:async()=>({bytes:wav(48000,2),mime:'audio/wav'})};
  const skipped=await port.prepare(decoded,{client,config:{resolveIncomingMedia:true,transcribeIncomingAudio:false}});assert.equal(calls,0);assert.equal(skipped.derived.length,0);
  const prepared=await port.prepare(decoded,{client,config:{resolveIncomingMedia:true,transcribeIncomingAudio:true}});assert.equal(calls,1);assert.equal(prepared.derived[0].verbatimTypedText,false);assert.equal(prepared.rich.perception.understandingConfirmed,false);assert.equal(prepared.rich.media[0].status,'transcribed');
  assert.throws(()=>mono16kWav(Buffer.from('silk is not a wave')),{code:'INCOMING_AUDIO_FORMAT'});port.close();
});

test('Bilibili storyboard bytes become real image attachments only with declared model vision and never raw JSON bytes',async()=>{
  const result={sheets:[{bytes:Buffer.from('fixture-image-bytes'),mime:'image/png',sheetIndex:0,width:10,height:10}],coverage:{continuousVideoDecoded:false,individuallyCropped:false}};
  const unavailable=await attachPlatformImages({},null,result);assert.equal(unavailable.visualAvailable,false);assert.equal(JSON.stringify(unavailable).includes('fixture-image-bytes'),false);
  const ctx={get:key=>key==='attachments'?{saveImages:async images=>{assert.equal(images[0].mediaType,'image/png');return[{id:'host-attachment'}];}}:key==='llm'?{resolveModelInfo:async()=>({inputModalities:['text','image']})}:undefined};
  const attached=await attachPlatformImages(ctx,{options:{provider:'fixture',model:'vision'}},result);assert.equal(attached.imageAttached,true);assert.equal(attached.coverage.continuousVideoDecoded,false);assert.equal(renderPlatformOutput({},attached)[1].type,'image');assert.equal(renderPlatformOutput({},attached)[1].attachment.id,'host-attachment');
});

test('extension text participates in clear preview while an auxiliary writer prevents deletion',async t=>{
  const root=await temp(t);await mkdir(join(root,'extensions/qq-social'),{recursive:true});await writeFile(join(root,'extensions/qq-social/state.json'),'{}');await writeFile(join(root,'extensions/qq-social/state.json.writer.lock'),'{}');
  const plan=await scanManagedText(root,[{instanceId:'fixture',memoryRoot:root}],'fixture');assert.deepEqual(plan.files.map(f=>f.path),['extensions/qq-social/state.json']);await assert.rejects(requireNoWriter(root),{code:'INSTANCE_WRITER_ACTIVE'});
});

test('actual coordinator memory tool returns paged references and records each displayed page without a context scope error',async t=>{
  const root=await temp(t),tools=new Map(),handlers=new Map();
  const scope={on:(name,handler)=>{handlers.set(name,handler);return()=>handlers.delete(name);},tools:{restrict:()=>()=>{},register:tool=>{tools.set(tool.name,tool);return()=>tools.delete(tool.name);}}};
  const agent={id:'native-memory-fixture',ctx:scope,status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{id:'native-memory-fixture',header:{},deriveMessages:()=>[]}};
  const coordinator=createDshCoordinator({agents:{get:()=>agent},get:()=>undefined,llm:{}},{memoryRoot:root,operatorControl:false});await coordinator.ready;t.after(()=>coordinator.close());await coordinator.attachAgent(agent);
  await coordinator.repository.ingest({sourceSessionId:'source',sourceEventId:'event',sourceKind:'user',channelId:'source',contentClass:'participant_dialogue',personId:null,role:'user',text:'原话'.repeat(2000),sourceAt:1,observedAt:1});
  const tool=tools.get('memory_search'),args={query:'原话',scope:'all'},first=await tool.execute(args,{agent,callId:'memory-page-1'});
  assert.notEqual(first.status,'memory_error');assert.equal(first.items.length,1);assert(first.nextCursor);
  const second=await tool.execute({...args,cursor:first.nextCursor},{agent,callId:'memory-page-2'});assert.notEqual(second.status,'memory_error');assert.equal(second.items[0].fragment.from,first.items[0].fragment.to);
  const diagnostics=await coordinator.repository.getRetrievalDiagnostics();assert.equal(diagnostics.exposure[0].toolReferences,2);assert.equal(diagnostics.automaticRecall,false);
});

test('management search cursor stays valid when only the evaluation clock advances; explanation length does not break body paging',async t=>{
  const root=await temp(t);let now=1000;const repo=new MemoryRepository({root,clock:()=>now});await repo.open();t.after(()=>repo.close());
  for(let index=0;index<3;index++)await repo.ingest({sourceSessionId:'source',sourceEventId:'event'+index,sourceKind:'user',channelId:'source',contentClass:'participant_dialogue',personId:null,role:'user',text:'茶'+index,sourceAt:index,observedAt:index});
  const management=createManagementService({getCoordinator:()=>({ready:Promise.resolve(),repository:repo})}),args={query:'茶',scope:'all',pageSize:1};
  const first=await management.dispatch('memory.search',args);assert(first.nextCursor);now=2000;const second=await management.dispatch('memory.search',{...args,cursor:first.nextCursor});assert.notEqual(first.items[0].id,second.items[0].id);
  const long='a'.repeat(2000),result={items:[{id:'long',personId:null,scope:'global',recordType:'memory',text:long,retrieval:{channels:['lexical'],matchedTerms:[long],associationPaths:[['x'.repeat(200),'y'.repeat(200)]]}}]};
  const output=await boundToolOutput('memory_search',result,{query:long},{budget:1500});assert(output.items[0].text.length>0);assert.equal(output.items[0].retrieval.explanationDetailsOmitted,true);assert(output.nextCursor);
});
