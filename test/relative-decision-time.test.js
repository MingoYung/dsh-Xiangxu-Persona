import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {resolveDecisionTimes} from '../core/decision-time.js';
import {MemoryRepository,PersonaRuntime} from '../core/index.js';

test('relative chosen times are translated without mutating caller decisions or inventing a cadence',()=>{
  const input={nextCheckAfterMs:0,replyPlan:{action:'reply',replyAfterMs:120000},sleepPlan:{action:'sleep',wakeCondition:'at_time',wakeAfterMs:60000}};
  const result=resolveDecisionTimes(input,1793631425450);
  assert.deepEqual(result,{nextCheckAt:1793631425450,replyPlan:{action:'reply',replyAt:1793631545450},sleepPlan:{action:'sleep',wakeCondition:'at_time',wakeAt:1793631485450}});
  assert.equal(input.sleepPlan.wakeAfterMs,60000);
  assert.deepEqual(resolveDecisionTimes({replyPlan:{action:'wait'}},1000),{replyPlan:{action:'wait'}});
  assert.deepEqual(resolveDecisionTimes({nextCheckAfterMs:null},1000),{nextCheckAt:null});
  assert.equal(resolveDecisionTimes({nextCheckAt:900,nextCheckAfterMs:null},1000).nextCheckAt,900);
});

test('malformed, ambiguous and overflowing relative times fail instead of rounding or guessing',()=>{
  for(const value of [-1,0.5,NaN,Infinity,'60000',undefined])assert.throws(()=>resolveDecisionTimes({nextCheckAfterMs:value},1000),{code:'SCHEMA_INVALID'});
  assert.throws(()=>resolveDecisionTimes({nextCheckAt:1000,nextCheckAfterMs:1000},1000),{code:'SCHEMA_INVALID'});
  assert.throws(()=>resolveDecisionTimes({sleepPlan:{action:'sleep',wakeCondition:'explicit_wake',wakeAfterMs:1000}},1000),{code:'SCHEMA_INVALID'});
  assert.throws(()=>resolveDecisionTimes({nextCheckAfterMs:Number.MAX_SAFE_INTEGER},1000),{code:'SCHEMA_INVALID'});
});

test('durable relative sleep uses admission clock once, survives cold reopen, and wakes only at its chosen deadline',async t=>{
  const root=await mkdtemp(join(tmpdir(),'xiangxu-relative-time-'));let now=1793631425450,runtime;
  const clock=()=>now,wakes=[];const host={onWake:async wake=>{wakes.push(wake);return {accepted:true};}};
  const open=async()=>{const repository=new MemoryRepository({root,clock});runtime=new PersonaRuntime({repository,clock,host,autoSchedule:false});await runtime.open();return repository;};
  t.after(async()=>{await runtime?.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true});});
  let repository=await open();
  const decision={sleepPlan:{action:'sleep',wakeCondition:'at_time',wakeAfterMs:60000}};
  const first=await runtime.decide(decision,{operationId:'chosen-once',sessionId:'s',channelId:'c'});
  const deadline=now+60000;assert.equal(first.decision.sleepPlan.wakeAt,deadline);
  now+=10000;
  const replay=await runtime.decide(decision,{operationId:'chosen-once',sessionId:'s',channelId:'c'});
  assert.equal(replay.duplicate,true);assert.equal(replay.decision.sleepPlan.wakeAt,deadline);
  await runtime.close();repository=await open();assert.equal((await repository.getRuntime()).sleep.wakeAt,deadline);
  now=deadline-1;await runtime.handleDue();assert.equal(wakes.length,0);
  now=deadline;await runtime.handleDue();await runtime.idle();assert.equal(wakes.length,1);assert.equal((await repository.getRuntime()).sleep.state,'awake');
  await runtime.handleDue();assert.equal(wakes.length,1);
});
