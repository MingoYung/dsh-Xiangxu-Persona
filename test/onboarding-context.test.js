import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {selfProfileContext,conversationOrientation} from '../core/onboarding.js';
import {buildSnapshot,createTokenCounter} from '../core/prompts.js';
import {defaultConfig} from '../core/schema.js';
import {MemoryRepository} from '../core/repository.js';
import {PersonaRuntime} from '../core/runtime.js';

const counter=createTokenCounter();
test('self profile context keeps current identity separate from wishes and excludes past versions',async()=>{
  const profile={version:3,mode:'together',current:{name:'相续',gender:'未确定'},initial:{gender:'女性'},history:[{current:{name:'OLD_PRIVATE'}}],provenance:{current:{name:{sourceRefs:[{sourceSessionId:'s',sourceEventId:'a'}],sourceRecordIds:['record-a']}}}};
  const result=await selfProfileContext(profile,{counter,budget:350});
  const parsed=JSON.parse(result.text.split('\n')[1]);
  assert.equal(parsed.current.name,'相续');assert.equal(parsed.current.gender,'未确定');assert.equal(parsed.initialWishes.gender,'女性');
  assert.ok(!result.text.includes('OLD_PRIVATE'));assert.deepEqual(result.sourceDependencies.recordIds,['record-a']);
});
test('context budget omits a whole long field without cutting identity values or including its dependencies',async()=>{
  const result=await selfProfileContext({version:1,mode:'autonomous',current:{name:'相续',background:'长'.repeat(1200)},provenance:{current:{background:{sourceRefs:[{sourceSessionId:'private',sourceEventId:'not-shown'}]}}}},{counter,budget:200});
  const value=JSON.parse(result.text.split('\n')[1]);assert.equal(value.current.name,'相续');assert.equal(value.current.background,undefined);
  assert.equal(value.moreAvailable,true);assert.deepEqual(result.sourceDependencies.refs,[]);assert.ok(await counter.count(result.text)<=200);
});
test('empty and tiny-budget self descriptions do not fabricate an identity',async()=>{
  assert.equal((await selfProfileContext({current:{},initial:{}},{counter,budget:350})).text,'');
  assert.equal((await selfProfileContext({current:{name:'相续'}},{counter,budget:1})).text,'');
});
test('choosing autonomous initialization is visible even before any self fields have been filled',async()=>{
  const result=await selfProfileContext({version:1,mode:'autonomous',current:{},initial:{}},{counter,budget:350});
  const value=JSON.parse(result.text.split('\n')[1]);assert.equal(value.mode,'autonomous');assert.deepEqual(value.current,{});assert.deepEqual(value.initialWishes,{});
  assert.deepEqual(result.shown,[]);assert.deepEqual(result.sourceDependencies.refs,[]);
});
test('all conversation preferences preserve choice and keep a bounded shared context',async()=>{
  for(const style of ['short_chat','balanced','detailed']) {
    const config=defaultConfig({conversationStyle:style}),snapshot=await buildSnapshot({config,now:1,counter,material:{selfProfile:{version:1,mode:'together',current:{name:'相续'}}},context:{sessionId:'a',channelId:'dsh:a'}});
    assert.equal(snapshot.conversationStyle,style);assert.ok(snapshot.tokens<=2970);assert.ok(snapshot.injectedText.includes('相续'));
    assert.match(conversationOrientation(style),/不是字数、条数或频率要求/);
  }
});
test('same personality in a new session keeps its self profile and distinguishes no retrieval from an empty store',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'xiangxu-onboarding-'));const repo=new MemoryRepository({root});await repo.open();
  t.after(async()=>{await repo.close();await rm(root,{recursive:true,force:true});});
  await repo.updateSelfProfile({current:{name:'相续',ageDescription:'二十多岁的形象'}},{actor:'persona',expectedVersion:0});
  const runtime=new PersonaRuntime({repository:repo,model:{},host:{}});await runtime.open();
  const a=await runtime.compose({sessionId:'a',channelId:'dsh:a',personId:null});const b=await runtime.compose({sessionId:'b',channelId:'dsh:b',personId:null});
  assert.equal(a.selfProfileReference.version,b.selfProfileReference.version);assert.ok(a.injectedText.includes('相续')&&b.injectedText.includes('相续'));
  assert.match(b.injectedText,/not_requested/);assert.match(b.injectedText,/not_assessed/);assert.match(b.injectedText,/unassociated/);
  await runtime.close();
});
