import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeClient } from '../adapters/dsh/connections/bridge.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5UkAAAAASUVORK5CYII=','base64');
function fixture({version='4.18.41',actions=null}={}) {
  const calls=[],hooks={}; let actualAccount='100001',online=true;
  const client=createBridgeClient({platform:'qq',protocol:'onebot11',accountId:'100001',apiUrl:'http://127.0.0.1:39741',accessToken:'isolated-test-secret'},{fetchImpl:async(url,init)=>{const name=new URL(url).pathname.slice(1),payload=JSON.parse(init.body);calls.push({name,payload,init});if(hooks[name]){const value=await hooks[name](payload);if(value!==undefined)return Response.json(value);}
    if(name==='get_supported_actions'&&!actions)return Response.json({status:'failed',retcode:1404});
    const data=name==='get_supported_actions'?actions:name==='get_version_info'?{app_name:'NapCat',app_version:version}:name==='get_login_info'?{user_id:actualAccount}:name==='get_status'?{online,good:online}:name==='can_send_record'||name==='can_send_image'?{yes:true}:name==='send_qzone_msg'?{tid:'tid-isolated-1'}:name==='set_qq_profile'?{result:0}:null;
    return Response.json({status:'ok',retcode:0,data});}});
  return {client,calls,hooks,setAccount:v=>{actualAccount=v;},setOnline:v=>{online=v;},mutations:()=>calls.filter(v=>['set_qq_avatar','set_qq_profile','send_qzone_msg'].includes(v.name))};
}
test('pinned official NapCat version advertises only implemented account operations without claiming calls or dynamic reads',async()=>{
  const f=fixture();await f.client.inspectCapabilities();const caps=f.client.inspectAccountCapabilities();assert.deepEqual(caps.operations,{'profile.avatar':true,'profile.update':true,'feed.publish':true});assert.equal(caps.accountId,'100001');assert.equal((await f.client.inspectCapabilities())['call.voice'].supported,false);assert.equal((await f.client.inspectCapabilities())['feed.read'].supported,false);
  const old=fixture({version:'unverified'});await old.client.inspectCapabilities();assert.equal(old.client.inspectAccountCapabilities().operations['feed.publish'],false);
  const explicit=fixture({version:'unverified',actions:['set_qq_avatar']});await explicit.client.inspectCapabilities();assert.equal(explicit.client.inspectAccountCapabilities().operations['profile.avatar'],true);assert.equal(explicit.client.inspectAccountCapabilities().operations['feed.publish'],false);
});
test('avatar uses a verified current QQ account and actual image bytes, accepting the upstream verified null result',async()=>{
  const f=fixture();await f.client.inspectCapabilities();const result=await f.client.executeAccount('profile.avatar',{bytes:png,mime:'image/png'},{operationId:'avatar-call'});assert.equal(result.status,'completed');assert.equal(result.confirmedBy,'onebot-api-success');assert.equal(result.accountId,'100001');assert.equal(f.mutations().length,1);assert.deepEqual(f.mutations()[0].payload,{file:'base64://'+png.toString('base64')});assert.equal(f.mutations()[0].init.headers.authorization,'Bearer isolated-test-secret');
});
test('Qzone maps explicit visibility, selected targets and multi-image payloads to the real publish action and returns tid',async()=>{
  const f=fixture();await f.client.inspectCapabilities();const result=await f.client.executeAccount('feed.publish',{text:'隔离测试正文',images:[{bytes:png,mime:'image/png'}],visibility:16,targetUserIds:['200002']},{operationId:'feed-call'});assert.equal(result.status,'completed');assert.equal(result.tid,'tid-isolated-1');assert.deepEqual(f.mutations()[0].payload,{content:'隔离测试正文',ugc_right:16,images:['base64://'+png.toString('base64')],target_uins:['200002']});assert.equal(f.calls.some(v=>v.name==='send_like'),false);
});
test('missing Qzone tid, lost response and invalid avatar acknowledgement remain unknown and are never retried',async()=>{
  for(const operation of ['feed.publish','profile.avatar']){const f=fixture();await f.client.inspectCapabilities();f.hooks[operation==='feed.publish'?'send_qzone_msg':'set_qq_avatar']=()=>({status:'ok',retcode:0,data:{}});const payload=operation==='feed.publish'?{text:'test',visibility:64,images:[],targetUserIds:[]}:{bytes:png,mime:'image/png'};assert.equal((await f.client.executeAccount(operation,payload,{operationId:'unknown-call'})).status,'unknown');assert.equal(f.mutations().length,1);}
  const f=fixture();await f.client.inspectCapabilities();f.hooks.send_qzone_msg=()=>{throw Error('isolated-test-secret');};const result=await f.client.executeAccount('feed.publish',{text:'test',visibility:64},{operationId:'lost-call'});assert.equal(result.status,'unknown');assert.equal(f.mutations().length,1);assert.equal(JSON.stringify(result).includes('isolated-test-secret'),false);
});
test('profile updates map declared fields but require business result zero rather than HTTP success alone',async()=>{
  const f=fixture();await f.client.inspectCapabilities();let result=await f.client.executeAccount('profile.update',{nickname:'名字',signature:'',sex:'female'},{operationId:'profile-call'});assert.equal(result.status,'completed');assert.deepEqual(f.mutations()[0].payload,{nickname:'名字',personal_note:'',sex:2});
  f.hooks.set_qq_profile=()=>({status:'ok',retcode:0,data:{result:123}});result=await f.client.executeAccount('profile.update',{nickname:'名字'},{operationId:'profile-fail'});assert.equal(result.status,'failed');
  f.hooks.set_qq_profile=()=>({status:'ok',retcode:0,data:null});assert.equal((await f.client.executeAccount('profile.update',{nickname:'名字'},{operationId:'profile-unknown'})).status,'unknown');
});
test('offline or mismatched bridge login rejects before account writes, and argument paths cannot bypass image bytes',async()=>{
  const f=fixture();await f.client.inspectCapabilities();f.setAccount('300003');await assert.rejects(f.client.executeAccount('profile.avatar',{bytes:png,mime:'image/png'},{operationId:'wrong-account'}));assert.equal(f.mutations().length,0);
  f.setAccount('100001');f.setOnline(false);await assert.rejects(f.client.executeAccount('feed.publish',{text:'test',visibility:1},{operationId:'offline'}));assert.equal(f.mutations().length,0);
  await assert.rejects(f.client.executeAccount('profile.avatar',{file:'http://example.invalid/avatar.png'},{operationId:'path'}));
  await assert.rejects(f.client.executeAccount('feed.publish',{text:'test',visibility:16,targetUserIds:[]},{operationId:'bad-scope'}));assert.equal(f.mutations().length,0);
});
test('stopping or cancelling during the final account probe fences dispatch before any avatar or Qzone mutation',async()=>{
  for(const reason of ['stopped','aborted']){
    const f=fixture();await f.client.inspectCapabilities();let enter,finish,allowed=true;const entered=new Promise(done=>{enter=done;}),finished=new Promise(done=>{finish=done;}),controller=new AbortController();
    f.hooks.get_status=async()=>{enter();await finished;return{status:'ok',retcode:0,data:{online:true,good:true}};};
    const pending=f.client.executeAccount('profile.avatar',{bytes:png,mime:'image/png'},{operationId:'final-probe-fence-'+reason,signal:controller.signal,assertCurrent:()=>allowed});
    await entered;if(reason==='stopped')allowed=false;else controller.abort();finish();await assert.rejects(pending);assert.equal(f.mutations().length,0);
  }
});
test('an asynchronous assertion cannot be mistaken for a synchronous authorization fence',async()=>{
  const f=fixture();await f.client.inspectCapabilities();await assert.rejects(f.client.executeAccount('feed.publish',{text:'test',visibility:64},{operationId:'async-fence',assertCurrent:async()=>{throw Error('late rejection');}}),{code:'ONEBOT_ACCOUNT_FENCE'});assert.equal(f.mutations().length,0);
});
