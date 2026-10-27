import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDshCoordinator,inspectPersonaPromptProjection} from '../adapters/dsh/index.js';

const freeze = value => { if(value && typeof value === 'object' && !Object.isFrozen(value)){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value; };
const text = value => value.content.filter(block=>block.type==='text').map(block=>block.text).join('\n');
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'persona-prompt-projection-')),handlers=new Map(),events=new Map(),nodes=[];
  const scope={on(name,handler){handlers.set(name,handler);},tools:{restrict(){return()=>{};},register(){}}};
  const session={id:'projection-session',header:{},surface:{nodes},eventAt:seq=>events.get(seq),deriveEventMessage:event=>{
    const message=event.type==='user/message'?event.data:event.data?.message;
    return message?.content.length===0?null:message;
  },deriveMessages(){return nodes.map(seq=>this.deriveEventMessage(events.get(seq))).filter(Boolean);},requestHeader:()=>({config:{provider:'test',model:'fixture'}})};
  const agent={id:session.id,session,ctx:scope,inbox:{nextTurn:[],nextStep:[]},followup(message){this.inbox.nextTurn.push(message);}};
  const coordinator=createDshCoordinator({agents:{get:()=>agent},get:()=>undefined,llm:{}},{memoryRoot:root});
  await coordinator.ready;await coordinator.attachAgent(agent);
  t.after(async()=>{await coordinator.close();await rm(root,{recursive:true,force:true});});
  const assembly=await coordinator.preparePersonaAssembly(agent,{sections:[{name:'host-preserved',text:'Host section remains part of the authoritative assembly.'}]});
  const section=name=>assembly.sections.find(row=>row.name==='persona-memory:'+name).text;
  const current={protocolText:section('protocol'),conversationText:section('conversation'),liveText:section('live')};
  function append(type,message){const seq=nodes.length,event=freeze({seq,type,surfaceOp:'append',data:type==='user/message'?message:{message}});events.set(seq,event);nodes.push(seq);return event;}
  const system=(id,live=current.liveText,source={kind:'system-prompt'})=>freeze({id,role:'system',source,content:[{type:'text',text:'Host section remains part of the authoritative assembly.\n\n'+current.conversationText+'\n\n'+current.protocolText+'\n\n'+live}]});
  const oldLive=at=>'[environment]\n'+JSON.stringify({target:{sessionId:session.id},now:at})+'\n\n[retained-reference]\nold snapshot '+at;
  const user=id=>freeze({id,role:'user',source:{kind:'user'},content:[{type:'text',text:id}]});
  return{coordinator,session,agent,handlers,events,nodes,append,system,oldLive,user,current};
}

test('owned repeated full prompt snapshots request one native replacement series without mutating any original event',async t=>{
  const f=await fixture(t);f.append('system/message',f.system('old-1',f.oldLive(1)));f.append('user/message',f.user('first-user'));
  const call=freeze({id:'assistant-tool-call',role:'assistant',source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'tool-call',id:'call-1',name:'memory_search',arguments:'{"query":"first"}'}]});
  const result=freeze({id:'result-1',role:'tool',source:{kind:'tool',name:'memory_search'},toolCallId:'call-1',content:[{type:'text',text:'{"items":[]}'}]});
  f.append('assistant/message',call);f.append('tool/result',result);f.append('system/message',f.system('old-2',f.oldLive(2)));
  const answer=freeze({id:'answer',role:'assistant',source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'text',text:'Original answer'}]});f.append('assistant/message',answer);f.append('system/message',f.system('current'));
  const before=[...f.events.values()],messages=f.session.deriveMessages(),decision=inspectPersonaPromptProjection(f.session,f.current);
  assert.equal(decision.startsRequestSeries,true);assert.equal(decision.ownedSystemNodes,3);assert.equal(decision.reason,'replace_owned_persona_projection');
  assert.deepEqual([...f.events.values()],before);assert.deepEqual(f.session.deriveMessages(),messages);
  assert.strictEqual(f.session.deriveMessages().find(m=>m.id==='assistant-tool-call'),call);assert.strictEqual(f.session.deriveMessages().find(m=>m.toolCallId==='call-1'),result);
  assert.deepEqual(f.session.deriveMessages().filter(m=>m.role!=='system').map(m=>m.id),['first-user','assistant-tool-call','result-1','answer']);
});

test('a changed live snapshot requests native replacement while the unchanged authoritative snapshot does not',async t=>{
  const f=await fixture(t);f.append('system/message',f.system('old',f.oldLive(1)));assert.equal(inspectPersonaPromptProjection(f.session,f.current).startsRequestSeries,true);
  f.events.set(0,freeze({seq:0,type:'system/message',surfaceOp:'append',data:{message:f.system('latest')}}));
  const unchanged=inspectPersonaPromptProjection(f.session,f.current);assert.equal(unchanged.startsRequestSeries,false);assert.equal(unchanged.reason,'current_projection_unchanged');
});

test('a current snapshot that is only a prefix of stale material is still replaced',async t=>{
  const f=await fixture(t);f.append('system/message',f.system('stale-extra',f.current.liveText+' stale trailing facts'));
  assert.equal(inspectPersonaPromptProjection(f.session,f.current).startsRequestSeries,true);
});

test('dormant empty host system tails stay dormant and do not force another replacement',async t=>{
  const f=await fixture(t);f.append('system/message',f.system('latest'));f.append('system/message',freeze({id:'cleared-tail',role:'system',source:{kind:'system-prompt'},content:[]}));
  const result=inspectPersonaPromptProjection(f.session,f.current);assert.equal(result.startsRequestSeries,false);assert.equal(result.systemNodes,2);assert.equal(result.activeSystemNodes,1);
});

for(const kind of ['foreign-source','unknown-protocol','non-text-system','projected-system'])test('foreign system history remains untouched: '+kind,async t=>{
  const f=await fixture(t);f.append('system/message',f.system('old-1',f.oldLive(1)));f.append('system/message',f.system('old-2',f.oldLive(2)));
  let foreign=f.system('foreign');if(kind==='foreign-source')foreign=freeze({...foreign,source:{kind:'another-plugin'}});
  if(kind==='unknown-protocol')foreign=freeze({...foreign,content:[{type:'text',text:text(foreign).replace('你有一份跨会话连续的记忆','Another independent instruction')} ]});
  if(kind==='non-text-system')foreign=freeze({...foreign,content:[{type:'image',image:'not-a-persona-snapshot'}]});
  const added=f.append('system/message',foreign);if(kind==='projected-system'){const original=f.session.deriveEventMessage;f.session.deriveEventMessage=event=>event===added?freeze({...foreign,content:[{type:'text',text:'A different live projected system message'}]}):original(event);}
  const before=JSON.stringify([...f.events.values()]);assert.equal(inspectPersonaPromptProjection(f.session,f.current).startsRequestSeries,false);assert.equal(JSON.stringify([...f.events.values()]),before);
});

test('a different session target cannot be treated as this persona snapshot',async t=>{
  const f=await fixture(t);f.append('system/message',f.system('other-session',f.oldLive(1).replace(f.session.id,'different-session')));
  assert.equal(inspectPersonaPromptProjection(f.session,f.current).reason,'different_persona_target');assert.equal(inspectPersonaPromptProjection(f.session,f.current).startsRequestSeries,false);
});

test('missing fields and unknown surface nodes keep the existing surface unchanged',async t=>{
  const f=await fixture(t);f.append('system/message',f.system('old',f.oldLive(1)));
  const cases=[undefined,{}, {...f.session,eventAt:undefined},{...f.session,deriveEventMessage:undefined},{...f.session,surface:{nodes:[999]}},{...f.session,surface:{nodes:[0,0]}},{...f.session,eventAt:seq=>({...f.events.get(seq),type:'future/message'})},{...f.session,eventAt:seq=>({...f.events.get(seq),surfaceOp:undefined})},{...f.session,eventAt:()=>{throw Error('unknown retained event');}}];
  const before=JSON.stringify([...f.events.values()]);for(const session of cases)assert.equal(inspectPersonaPromptProjection(session,f.current).startsRequestSeries,false);
  assert.equal(inspectPersonaPromptProjection(f.session,{}).startsRequestSeries,false);assert.equal(JSON.stringify([...f.events.values()]),before);
});

test('the real coordinator returns startsRequestSeries and preserves the downstream admission batch',async t=>{
  const f=await fixture(t);f.append('system/message',f.system('old',f.oldLive(1)));const arrival=f.user('latest-user'),extra=freeze({id:'tool-context',role:'tool',source:{kind:'tool',name:'fixture'},toolCallId:'kept-call',content:[{type:'text',text:'Original tool result'}]}),messages=[arrival,extra];
  f.handlers.get('agent/inbox/claimed')({message:arrival,turn:1});
  const entered=await f.handlers.get('agent/pre-step')({messages:[arrival],turn:1},async()=>({kind:'enter',messages}));
  assert.equal(entered.startsRequestSeries,true);assert.deepEqual(entered.messages,messages);assert.strictEqual(entered.messages[1],extra);
  assert.equal(f.coordinator.agents.get(f.agent.id).promptProjection.reason,'replace_owned_persona_projection');
  assert.equal(f.session.deriveMessages().length,1);assert.strictEqual(f.session.deriveMessages()[0],f.events.get(0).data.message);
});

test('a foreign system appended during asynchronous admission is checked before setting the native flag',async t=>{
  const f=await fixture(t);f.append('system/message',f.system('old',f.oldLive(1)));let inserted=false;const original=f.coordinator.repository.getPending.bind(f.coordinator.repository);
  f.coordinator.repository.getPending=async()=>{const rows=await original();if(!inserted){inserted=true;f.append('system/message',freeze({id:'foreign-late',role:'system',source:{kind:'another-plugin'},content:[{type:'text',text:'Independent instruction must remain'}]}));}return rows;};
  const arrival=f.user('latest-user');f.handlers.get('agent/inbox/claimed')({message:arrival,turn:1});const entered=await f.handlers.get('agent/pre-step')({messages:[arrival],turn:1},async()=>({kind:'enter',messages:[arrival]}));
  assert.notEqual(entered.startsRequestSeries,true);assert.equal(f.coordinator.agents.get(f.agent.id).promptProjection.reason,'foreign_or_projected_system');assert.equal(f.session.deriveMessages().at(-1).id,'foreign-late');
});
