import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createChannelService} from '../adapters/dsh/channels/service.js';
import {createBridgeClient} from '../adapters/dsh/connections/bridge.js';

async function fixture(t, options={}) {
  let disk=null, account='100', online=true, calls=0;
  let c={memoryRoot:join(tmpdir(),'xiangxu-account-bridge'),ready:Promise.resolve(),agents:new Map()};
  const service=createChannelService({getCoordinator:()=>c,storage:{read:async()=>disk,write:async v=>{disk=structuredClone(v);}},port:0,
    channelPort:{create:async x=>x,send:async()=>({status:'accepted'}),close:async()=>{}},
    clientFactory:()=>({probe:async()=>({connected:online,accountId:account,capabilities:{text:true,group:true}}),
      inspectAccountCapabilities:async()=>({operations:{'profile.avatar':true,'feed.publish':true}}),
      executeAccount:async(_operation,_payload,context)=>{await options.beforeDispatch?.();context?.assertCurrent?.();calls++;return{status:'completed',confirmedBy:'test'};}})});
  await service.ready;t.after(()=>service.close());
  await service.configure({id:'qq',config:{apiUrl:'http://127.0.0.1:12345',accountId:'100',accessToken:'isolated',allowedPrivateIds:[],allowedGroupIds:[]}});await service.rotateIngress({id:'qq'});
  return{service,start:()=>service.start({id:'qq'}),setAccount:x=>{account=x;},offline:()=>{online=false;},replaceCoordinator:()=>{c={...c};},calls:()=>calls};
}
test('account port requires enabled bridge and exposes no connection secret or conversation target',async t=>{
  const f=await fixture(t);assert.equal(await f.service.getAccountBridge(),null);await f.start();
  const port=await f.service.getAccountBridge();assert.equal(port.identityVerified,true);assert.equal(port.operations['profile.avatar'],true);
  assert(!JSON.stringify(port).includes('isolated'));assert.equal(port.apiUrl,undefined);assert.equal(port.target,undefined);
  assert.equal((await port.executeAccount('profile.avatar',{},{})).status,'completed');assert.equal(f.calls(),1);
});
test('account port rechecks actual account and offline state before mutation',async t=>{
  const f=await fixture(t);await f.start();const port=await f.service.getAccountBridge();
  f.setAccount('200');await assert.rejects(port.executeAccount('feed.publish',{},{}),{code:'CHANNEL_ACCOUNT_MISMATCH'});assert.equal(f.calls(),0);
  f.setAccount('100');f.offline();await assert.rejects(port.executeAccount('feed.publish',{},{}),{code:'CHANNEL_ACCOUNT_MISMATCH'});assert.equal(f.calls(),0);
});
test('retained account port cannot survive stopped, reconfigured or suspended connection',async t=>{
  const f=await fixture(t);await f.start();const port=await f.service.getAccountBridge();await f.service.stop({id:'qq'});
  await assert.rejects(port.executeAccount('feed.publish',{},{}),{code:'CHANNEL_ACCOUNT_MISMATCH'});assert.equal(f.calls(),0);
  await f.service.configure({id:'qq',config:{accountId:'200'}});await f.start();
  await assert.rejects(port.executeAccount('feed.publish',{},{}),{code:'CHANNEL_ACCOUNT_MISMATCH'});
  const next=await f.service.getAccountBridge();assert.notEqual(next.connectionId,port.connectionId);await f.service.suspend();assert.equal(await f.service.getAccountBridge(),null);
});
test('fresh account tool discovers pinned real adapter actions without a prior settings-page visit',async t=>{
  const actions=[],responses={get_login_info:{user_id:100},get_status:{online:true,good:true},can_send_record:{yes:false},get_version_info:{app_name:'NapCat.Onebot',app_version:'4.18.41'},can_send_image:{yes:true}};
  const fetchImpl=async url=>{const action=new URL(url).pathname.slice(1);actions.push(action);return new Response(JSON.stringify({status:'ok',retcode:0,data:responses[action]??[]}));};
  let disk=null;const c={memoryRoot:join(tmpdir(),'xiangxu-account-discovery'),ready:Promise.resolve(),agents:new Map()};
  const service=createChannelService({getCoordinator:()=>c,port:0,storage:{read:async()=>disk,write:async v=>{disk=structuredClone(v);}},channelPort:{create:async x=>x,send:async()=>({status:'accepted'}),close:async()=>{}},clientFactory:profile=>createBridgeClient(profile,{fetchImpl})});
  t.after(()=>service.close());await service.ready;
  await service.configure({id:'qq',config:{apiUrl:'http://127.0.0.1:12345',accountId:'100',accessToken:'isolated',allowedPrivateIds:[],allowedGroupIds:[]}});await service.rotateIngress({id:'qq'});await service.start({id:'qq'});
  const port=await service.getAccountBridge();assert.equal(port.operations['profile.avatar'],true);assert.equal(port.operations['feed.publish'],true);assert(actions.includes('get_version_info'));
  assert(!actions.includes('send_qzone_msg'));assert(!actions.includes('set_qq_avatar'));
});
test('last dispatch fence blocks channel stop and personality replacement during driver wait',async t=>{
  for(const change of ['stop','personality']){
    let enter,release;const entered=new Promise(r=>{enter=r;}),wait=new Promise(r=>{release=r;});
    const f=await fixture(t,{beforeDispatch:async()=>{enter();await wait;}});await f.start();const port=await f.service.getAccountBridge(),pending=port.executeAccount('feed.publish',{},{});
    await entered;if(change==='stop')await f.service.stop({id:'qq'});else f.replaceCoordinator();release();
    await assert.rejects(pending,{code:'CHANNEL_ACCOUNT_MISMATCH'});assert.equal(f.calls(),0);
  }
});
