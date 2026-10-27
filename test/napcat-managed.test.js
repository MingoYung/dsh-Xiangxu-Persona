import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {createNapcatManagedService} from '../adapters/dsh/connections/napcat-managed.js';
import {inspectNapcatZip,NAPCAT_ZIP_LIMITS} from '../adapters/dsh/connections/napcat-zip.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const tick=()=>new Promise(resolve=>setTimeout(resolve,2));
function crc32(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=value&1?0xedb88320^(value>>>1):value>>>1;}return(value^0xffffffff)>>>0;}
function zip(members){
  const locals=[],central=[];let offset=0;
  for(const member of members){
    const name=Buffer.from(member.name),content=Buffer.from(member.content??'fixture'),crc=crc32(content),local=Buffer.alloc(30),record=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(0x800,6);local.writeUInt32LE(crc,14);local.writeUInt32LE(content.length,18);local.writeUInt32LE(content.length,22);local.writeUInt16LE(name.length,26);
    record.writeUInt32LE(0x02014b50);record.writeUInt16LE(0x800,8);record.writeUInt32LE(crc,16);record.writeUInt32LE(content.length,20);record.writeUInt32LE(content.length,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE(member.attrs??0,38);record.writeUInt32LE(offset,42);
    locals.push(local,name,content);central.push(record,name);offset+=local.length+name.length+content.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(members.length,8);end.writeUInt16LE(members.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
const members=['napcat.mjs','loadNapCat.js','qqnt.json','NapCatWinBootMain.exe','NapCatWinBootHook.dll'].map(name=>({name}));
async function fixture(t,options={}){
  const base=await fs.mkdtemp(path.join(tmpdir(),'xiangxu-managed-qq-')),installRoot=path.join(base,'managed'),qqPath=path.join(base,'qq','QQ.exe'),archive=zip(members);
  await fs.mkdir(path.dirname(qqPath));await fs.writeFile(qqPath,'isolated fixture, never executed');
  let nativeRuntime=null,nativeOwned=true,nativeInspectHook=null,nativeInspectPatch={},nativePortHeld=false;
  const nativeCounts={reserve:0,release:0,inspect:0,owned:0},nativeOwnership=[];
  if(options.native){
    const assetRoot=path.join(base,'original-native-assets'),loaderPath=path.join(assetRoot,'loader.cjs'),wrapperRelativePath='versions/9.9.36-53644/resources/app/wrapper.node',wrapperPath=path.join(path.dirname(qqPath),...wrapperRelativePath.split('/'));
    await fs.mkdir(assetRoot,{recursive:true});await fs.mkdir(path.dirname(wrapperPath),{recursive:true});await fs.writeFile(loaderPath,'original fixture loader, never executed');await fs.writeFile(wrapperPath,'isolated wrapper fixture, never loaded');
    nativeRuntime={enabled:true,protocol:'xiangxu-qq-native/1',abiVersion:'qq-win-53644-req-to-friend/1',assetRoot,assetHashes:{'loader.cjs':sha(await fs.readFile(loaderPath))},loaderPath,wrapperRelativePath,wrapperSha256:sha(await fs.readFile(wrapperPath)),officialBundleSha256:sha(Buffer.from('fixture'))};
    if(options.nativeTamper==='asset')await fs.appendFile(loaderPath,' changed');else if(options.nativeTamper==='wrapper')await fs.appendFile(wrapperPath,' changed');else if(options.nativeTamper==='bundle')nativeRuntime.officialBundleSha256='0'.repeat(64);
  }
  const release={version:'fixture',url:'https://example.invalid/NapCat.zip',bytes:archive.length,sha256:options.badSha?'0'.repeat(64):sha(archive)};
  let current={instanceId:'persona-a',memoryRoot:path.join(base,'memory-a'),ready:Promise.resolve()},active=false,logged=false,initializing=false,accepted=false,loginError=null,accountId='12345678',webCredential=null,authGeneration=0,fetchHook=null,statusHook=null,spawned,config={network:{httpServers:[{name:'other-server',enable:false}],httpClients:[{name:'other-client',enable:false}],websocketServers:[{name:'retained'}]},retained:'unchanged'};
  const counts={download:0,spawn:0,configure:0,rotate:0,start:0,stop:0,resume:0,refresh:0,getQr:0,setConfig:0},requests=[];
  let profile={id:'qq',enabled:false,connected:false,config:{mode:'bridge'}},stopBusy=false,pauseConfigure=null,launchErrorOnce=options.launchErrorOnce===true;
  const snapshot=()=>({connections:[structuredClone(profile)]});
  const channels={
    status:async()=>{if(statusHook)await statusHook();return snapshot();},
    configure:async({config:value})=>{counts.configure++;if(pauseConfigure)await pauseConfigure;profile.config=structuredClone(value);return snapshot();},
    rotateIngress:async value=>{assert.equal(value.authMode,'onebot-hmac');counts.rotate++;return{callbackUrl:'http://127.0.0.1:17654/channels/qq/events',ingressToken:'isolated-hmac-secret',authMode:'onebot-hmac'};},
    start:async()=>{counts.start++;profile.enabled=true;profile.connected=true;profile.callbackUrl='http://127.0.0.1:17654/channels/qq/events';return snapshot();},
    probe:async()=>snapshot(),
    stop:async()=>{counts.stop++;if(stopBusy)throw Object.assign(new Error('busy'),{code:'CHANNEL_BUSY'});profile.enabled=false;profile.connected=false;return snapshot();},
    resume:async()=>{counts.resume++;profile.connected=true;return snapshot();}
  };
  const fetchImpl=async(url,request={})=>{
    if(fetchHook){const response=await fetchHook(url,request);if(response)return response;}
    if(url===release.url){counts.download++;return new Response(archive);}
    assert.match(url,/^http:\/\/127\.0\.0\.1:6099\/api\//);if(!active)throw Object.assign(new Error('offline'),{code:'ECONNREFUSED'});
    const body=JSON.parse(request.body);requests.push({route:new URL(url).pathname,body});let data;
    switch(new URL(url).pathname){
      case'/api/auth/login':assert.match(body.hash,/^[a-f0-9]{64}$/);webCredential='isolated-web-credential-'+(++authGeneration);data={Credential:webCredential};break;
      case'/api/QQLogin/CheckLoginStatus':data={isLogin:logged,coreReady:logged&&!initializing,qrLoginAccepted:accepted,loginPhase:initializing?'initializing':logged?'online':'qrcode_pending',loginError,qrcodeurl:'https://ntlogin.qq.com/qrlogin?code=isolated'};break;
      case'/api/QQLogin/GetQQLoginInfo':data={uin:accountId,nick:'fixture'};break;
      case'/api/QQLogin/GetQQLoginQrcode':counts.getQr++;assert.equal(logged,false);data={qrcode:'https://ntlogin.qq.com/qrlogin?code=isolated'};break;
      case'/api/QQLogin/RefreshQRcode':counts.refresh++;data={qrcodeurl:'https://ntlogin.qq.com/qrlogin?code=refreshed'};break;
      case'/api/OB11Config/GetConfig':data=structuredClone(config);break;
      case'/api/OB11Config/SetConfig':assert.equal(typeof body.config,'string');counts.setConfig++;config=JSON.parse(body.config);data={};break;
      default:throw new Error('Unexpected endpoint '+url);
    }
    if(!url.endsWith('/auth/login'))assert.equal(request.headers.authorization,'Bearer '+webCredential);
    return Response.json({code:0,data});
  };
  const spawnPort=(command,args,spawnOptions)=>{
    counts.spawn++;active=true;const child=new EventEmitter();if(options.native&&!launchErrorOnce)child.pid=4141;Object.assign(child,{stdout:new EventEmitter(),stderr:new EventEmitter(),exitCode:null,killed:false,kill(){this.killed=true;this.exitCode=0;active=false;this.emit('exit',0);return true;}});spawned={command,args,options:spawnOptions,child};if(launchErrorOnce){launchErrorOnce=false;active=false;setImmediate(()=>child.emit('error',Object.assign(new Error('isolated launcher unavailable'),{code:'ENOENT'})));}return child;
  };
  const runtimePorts={channels,getCoordinator:async()=>current,choosePorts:async()=>({web:6099,api:3000}),verifyQqExecutable:async()=>true,environment:{PATH:'fixture',NODE_OPTIONS:'secret-should-not-leak',ELECTRON_RUN_AS_NODE:'1'},delay:tick,...options.runtimePorts};
  if(options.confirmStop!==false)runtimePorts.stopOwnedProcess=async child=>{child?.kill();return true;};
  if(options.native){
    runtimePorts.reserveNativePort=async()=>{nativeCounts.reserve++;nativePortHeld=true;let released=false;return{port:3001,async release(){if(released)return;released=true;nativeCounts.release++;nativePortHeld=false;}};};
    runtimePorts.isOwnedNativeProcess=async(pid,context)=>{nativeCounts.owned++;nativeOwnership.push({pid,...context});return nativeOwned;};
    runtimePorts.inspectNativeRuntime=async descriptor=>{nativeCounts.inspect++;if(nativeInspectHook)await nativeInspectHook(descriptor);return{protocol:descriptor.protocol,bootId:descriptor.bootId,abiVersion:descriptor.abiVersion,accountId:descriptor.expectedAccountId,ready:true,capabilities:{query:{supported:true,available:true},request:{supported:true,available:true},respond:{supported:false,available:false}},...nativeInspectPatch};};
  }
  if(options.nativeClientReal)delete runtimePorts.inspectNativeRuntime;
  const make=()=>createNapcatManagedService({installRoot,qqPath,fetchImpl,spawnPort,runtimePorts,release,nativeRuntime:options.nativeProvider==='async'?async()=>nativeRuntime:options.nativeProvider==='promise'?Promise.resolve(nativeRuntime):options.nativeProvider==='reject'?async()=>{throw new Error('missing private asset');}:nativeRuntime});let service=make();
  t.after(async()=>{
    await service.close();
    const target=path.resolve(base),temp=path.resolve(tmpdir()),relative=path.relative(temp,target);
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(target).startsWith('xiangxu-managed-qq-'),'fixture cleanup must remain inside owned temp root');
    await fs.rm(target,{recursive:true,force:true});
  });
  return{base,installRoot,qqPath,release,channels,counts,requests,make,nativeRuntime,nativeCounts,nativeOwnership,get nativePortHeld(){return nativePortHeld;},setNativeOwned:value=>{nativeOwned=value;},setNativeInspectHook:value=>{nativeInspectHook=value;},setNativeInspectPatch:value=>{nativeInspectPatch=value;},get service(){return service;},set service(value){service=value;},get spawned(){return spawned;},get config(){return config;},get profile(){return profile;},setOwnerReady:value=>{current.ready=value;},setFetchHook:value=>{fetchHook=value;},setStatusHook:value=>{statusHook=value;},setAccount:value=>{accountId=value;},setStopBusy:value=>{stopBusy=value;},setPauseConfigure:value=>{pauseConfigure=value;},switchPersona:()=>{current={...current,instanceId:'persona-b',memoryRoot:path.join(base,'memory-b')};},logIn:()=>{logged=true;},logOut:()=>{logged=false;initializing=false;accepted=false;},setInitializing:value=>{logged=true;initializing=value;},setAccepted:value=>{accepted=value;},setLoginError:value=>{loginError=value;}};
}
async function startReady(f){let value=await f.service.start({instanceId:'persona-a'});for(let i=0;i<5000;i++){value=await f.service.inspect();if(!['installing'].includes(value.phase))break;await tick();}assert.notEqual(value.phase,'installing','background install must settle');return f.service.poll({instanceId:'persona-a',flowId:value.flowId});}
async function connect(f){const first=await startReady(f);f.logIn();await f.service.poll({instanceId:'persona-a',flowId:first.flowId});return f.service.connect({instanceId:'persona-a',flowId:first.flowId,allowedPrivateIds:['23456789'],allowedGroupIds:['34567890'],voiceMode:'text'});}

test('managed inspect is passive; owner start verifies/extracts without modifying QQ and exposes real QR state',async t=>{
  const f=await fixture(t);assert.equal((await f.service.inspect()).phase,'not_installed');await assert.rejects(fs.stat(f.installRoot),{code:'ENOENT'});assert.equal(f.counts.download,0);assert.equal(f.counts.spawn,0);
  const value=await startReady(f);assert.equal(value.phase,'waiting_login');assert.equal(value.installed,true);assert.match(value.qrContent,/ntlogin.qq.com/);assert.equal(value.livePlatformVerified,false);assert.equal(f.counts.spawn,1);assert.equal(f.spawned.options.windowsHide,true);assert.equal(f.spawned.options.env.NODE_OPTIONS,undefined);assert.equal(f.spawned.options.env.ELECTRON_RUN_AS_NODE,undefined);assert.equal(f.spawned.options.env.NAPCAT_WORKDIR,path.join(f.installRoot,'runtime'));assert.deepEqual(f.spawned.args,[f.qqPath,path.join(f.installRoot,'versions','fixture','NapCatWinBootHook.dll')]);
  const web=JSON.parse(await fs.readFile(path.join(f.installRoot,'runtime','config','webui.json'),'utf8'));assert.equal(web.host,'127.0.0.1');assert.ok(web.token.length>=40);assert.equal(JSON.stringify(value).includes(web.token),false);assert.equal(await fs.readFile(f.qqPath,'utf8'),'isolated fixture, never executed');
  const marker=JSON.parse(await fs.readFile(path.join(f.installRoot,'versions','fixture','install.json'),'utf8'));assert.equal(marker.files.length,5);assert.equal(marker.archiveSha256,f.release.sha256);
});
test('integrity failure fails before extraction or subprocess',async t=>{
  const f=await fixture(t,{badSha:true});const value=await startReady(f);assert.equal(value.phase,'failed');assert.equal(value.error.code,'NAPCAT_DOWNLOAD_INTEGRITY');assert.equal(f.counts.spawn,0);await assert.rejects(fs.stat(path.join(f.installRoot,'versions')),{code:'ENOENT'});
});
test('QQ logged-in and core-ready are distinct; explicit QR refresh is not repeated by normal polling',async t=>{
  const f=await fixture(t),first=await startReady(f),args={instanceId:'persona-a',flowId:first.flowId};await f.service.poll(args);assert.equal(f.counts.refresh,0);const refreshed=await f.service.poll({...args,refreshQr:true});assert.match(refreshed.qrContent,/refreshed/);assert.equal(f.counts.refresh,1);
  f.setInitializing(true);const pending=await f.service.poll({...args,refreshQr:true});assert.equal(pending.phase,'waiting_login');assert.equal(pending.qrContent,null);assert.equal(pending.loginPhase,'initializing');assert.match(pending.progressMessage,/核心/);assert.equal(f.counts.getQr,0);assert.equal(f.counts.refresh,1);
  f.setInitializing(false);const authorized=await f.service.poll(args);assert.equal(authorized.phase,'authorized');assert.deepEqual(authorized.loginAccount,{accountId:'12345678',displayName:'fixture'});assert.equal(authorized.connected,false);
});
test('connect requires actual login and configures explicit scopes with independent loopback API and HMAC callback',async t=>{
  const f=await fixture(t),first=await startReady(f),args={instanceId:'persona-a',flowId:first.flowId,allowedPrivateIds:['23456789'],allowedGroupIds:['34567890']};await assert.rejects(f.service.connect(args),{code:'NAPCAT_LOGIN_REQUIRED'});f.logIn();const value=await f.service.connect(args);assert.equal(value.phase,'connected');assert.equal(f.profile.config.accountId,'12345678');assert.deepEqual(f.profile.config.allowedPrivateIds,['23456789']);assert.deepEqual(f.profile.config.allowedGroupIds,['34567890']);assert.equal(f.profile.config.apiUrl,'http://127.0.0.1:3000');assert.equal(f.profile.config.allowRemote,false);
  const server=f.config.network.httpServers.find(v=>v.name==='xiangxu-managed-http'),client=f.config.network.httpClients.find(v=>v.name==='xiangxu-managed-events');assert.equal(server.host,'127.0.0.1');assert.equal(server.token,f.profile.config.accessToken);assert.equal(client.token,'isolated-hmac-secret');assert.notEqual(server.token,client.token);assert.equal(client.reportSelfMessage,false);assert.equal(f.config.retained,'unchanged');assert.deepEqual(f.config.network.websocketServers,[{name:'retained'}]);assert.equal(f.config.network.httpServers[0].name,'other-server');assert.equal(f.config.network.httpClients[0].name,'other-client');assert.equal(JSON.stringify(value).includes(server.token),false);assert.equal(f.service.isBusy('persona-a'),false);
});
test('stale flow and personality switch cannot configure another personality',async t=>{
  const f=await fixture(t),first=await startReady(f);f.logIn();await assert.rejects(f.service.poll({instanceId:'persona-a',flowId:'old'}),{code:'NAPCAT_FLOW_STALE'});f.switchPersona();await assert.rejects(f.service.connect({instanceId:'persona-a',flowId:first.flowId,allowedPrivateIds:[],allowedGroupIds:[]}),{code:'NAPCAT_INSTANCE_CHANGED'});assert.equal(f.counts.configure,0);
});
test('connect marks busy through mutations and rechecks the current personality after awaits',async t=>{
  const f=await fixture(t);let release;const hold=new Promise(resolve=>{release=resolve;});f.setPauseConfigure(hold);const pending=connect(f);while(!f.counts.configure)await tick();assert.equal(f.service.isBusy('persona-a'),true);f.switchPersona();release();await assert.rejects(pending,{code:'NAPCAT_INSTANCE_CHANGED'});assert.equal(f.counts.rotate,0);assert.equal(f.counts.start,0);assert.equal(f.service.isBusy('persona-a'),false);
});
test('normal close preserves restore intent and enabled scope; resume uses existing component and human stop opts out',async t=>{
  const f=await fixture(t);await connect(f);const before=structuredClone(f.profile.config),downloads=f.counts.download,rotations=f.counts.rotate;await f.service.close();assert.equal(f.profile.enabled,true);f.service=f.make();await f.service.resume();for(let i=0;i<5000&&(await f.service.inspect()).phase!=='connected';i++)await tick();assert.equal((await f.service.inspect()).phase,'connected');assert.equal(f.counts.resume,1);assert.equal(f.counts.download,downloads);assert.equal(f.counts.rotate,rotations);assert.deepEqual(f.profile.config,before);
  const value=await f.service.stop({flowId:(await f.service.inspect()).flowId});assert.equal(value.phase,'stopped');assert.equal(f.profile.enabled,false);assert.equal(JSON.parse(await fs.readFile(path.join(f.installRoot,'managed-state.json'),'utf8')).desired,null);
});
test('busy channel stop preserves restore intent and active setup state',async t=>{
  const f=await fixture(t),connected=await connect(f),before=await fs.readFile(path.join(f.installRoot,'managed-state.json'),'utf8');f.setStopBusy(true);await assert.rejects(f.service.stop({flowId:connected.flowId}),{code:'CHANNEL_BUSY'});assert.equal((await f.service.inspect()).phase,'connected');assert.equal(f.spawned.child.killed,false);assert.equal(await fs.readFile(path.join(f.installRoot,'managed-state.json'),'utf8'),before);f.setStopBusy(false);
});
test('resume needing a fresh login waits for QR and restores the exact prior scope after owner poll',async t=>{
  const f=await fixture(t);await connect(f);const config=structuredClone(f.profile.config),rotations=f.counts.rotate;await f.service.close();f.logOut();f.service=f.make();await f.service.resume();let value;for(let i=0;i<5000;i++){value=await f.service.inspect();if(value.phase==='waiting_login')break;await tick();}assert.equal(value.phase,'waiting_login');assert.equal(value.connected,false);assert.equal(f.counts.resume,0);f.logIn();const final=await f.service.poll({instanceId:'persona-a',flowId:value.flowId});assert.equal(final.phase,'connected');assert.equal(f.counts.resume,1);assert.equal(f.counts.rotate,rotations);assert.deepEqual(f.profile.config,config);
});
test('same flow resumes a previously connected account after fresh login without reconfiguring',async t=>{
  const f=await fixture(t),first=await connect(f),args={instanceId:'persona-a',flowId:first.flowId},before={...f.counts},config=structuredClone(f.profile.config),transport=structuredClone(f.config),saved=await fs.readFile(path.join(f.installRoot,'managed-state.json'),'utf8');
  f.logOut();f.profile.connected=false;const waiting=await f.service.poll(args);assert.equal(waiting.phase,'waiting_login');assert.equal(waiting.apiReady,false);assert.equal(f.counts.resume,0);f.logIn();
  const restored=await f.service.poll(args);assert.equal(restored.phase,'connected');assert.equal(restored.connected,true);assert.equal(restored.apiReady,true);assert.equal(restored.loginAccount.accountId,'12345678');assert.deepEqual(f.counts,{...before,resume:before.resume+1});assert.deepEqual(f.profile.config,config);assert.deepEqual(f.config,transport);assert.equal(await fs.readFile(path.join(f.installRoot,'managed-state.json'),'utf8'),saved);assert.equal(f.service.isBusy('persona-a'),false);
  await f.service.poll(args);assert.equal(f.counts.resume,before.resume+1);
});
test('same-flow recovery preserves an already authorized autonomous wildcard scope',async t=>{
  const f=await fixture(t),first=await connect(f),args={instanceId:'persona-a',flowId:first.flowId};await f.service.connect({...args,allowedPrivateIds:['*'],allowedGroupIds:['*'],voiceMode:'text'});const before={...f.counts},config=structuredClone(f.profile.config),transport=structuredClone(f.config);
  f.logOut();f.profile.connected=false;await f.service.poll(args);f.logIn();assert.equal((await f.service.poll(args)).phase,'connected');assert.deepEqual(f.profile.config,config);assert.deepEqual(f.config,transport);assert.deepEqual(f.profile.config.allowedPrivateIds,['*']);assert.deepEqual(f.profile.config.allowedGroupIds,['*']);assert.deepEqual(f.counts,{...before,resume:before.resume+1});
});
test('manual stop after a login loss prevents same-account reauthentication from restoring access',async t=>{
  const f=await fixture(t),first=await connect(f),args={instanceId:'persona-a',flowId:first.flowId};f.logOut();await f.service.poll(args);assert.equal((await f.service.stop(args)).phase,'stopped');const before={...f.counts};f.logIn();await assert.rejects(f.service.poll(args),{code:'NAPCAT_FLOW_CANCELLED'});assert.equal((await f.service.resume()).phase,'stopped');assert.deepEqual(f.counts,before);assert.equal(f.profile.enabled,false);assert.equal(JSON.parse(await fs.readFile(path.join(f.installRoot,'managed-state.json'),'utf8')).desired,null);
});
test('same-flow reauthentication with a different account never restores the old account binding',async t=>{
  const f=await fixture(t),first=await connect(f),args={instanceId:'persona-a',flowId:first.flowId};f.logOut();await f.service.poll(args);f.setAccount('87654321');f.logIn();const rejected=await f.service.poll(args);assert.equal(rejected.phase,'failed');assert.equal(rejected.error.code,'NAPCAT_ACCOUNT_CHANGED');assert.equal(f.counts.resume,0);assert.equal(f.profile.enabled,false);assert.equal(f.profile.config.accountId,'12345678');const before={...f.counts};f.setAccount('12345678');await f.service.poll(args);assert.deepEqual(f.counts,before);
});
test('a personality switch during same-flow account confirmation cannot restore the earlier instance',async t=>{
  const f=await fixture(t),first=await connect(f),args={instanceId:'persona-a',flowId:first.flowId};f.logOut();await f.service.poll(args);f.logIn();let entered=false,release;const hold=new Promise(resolve=>{release=resolve;});f.setFetchHook(async url=>{if(url.endsWith('/GetQQLoginInfo')){entered=true;await hold;}});const polling=f.service.poll(args);for(let i=0;i<5000&&!entered;i++)await tick();assert.equal(entered,true);const before={...f.counts};f.switchPersona();release();const rejected=await polling;assert.notEqual(rejected.phase,'connected');assert.deepEqual(f.counts,before);assert.equal(f.counts.resume,0);
});
for(const changed of ['disabled','mode','account','api'])test('same-flow recovery does not override a changed channel '+changed,async t=>{
  const f=await fixture(t),first=await connect(f),args={instanceId:'persona-a',flowId:first.flowId};f.logOut();f.profile.connected=false;await f.service.poll(args);
  if(changed==='disabled')f.profile.enabled=false;else if(changed==='mode')f.profile.config.mode='official';else if(changed==='account')f.profile.config.accountId='87654321';else f.profile.config.apiUrl='http://127.0.0.1:3001';
  const before={...f.counts},profile=structuredClone(f.profile),transport=structuredClone(f.config);f.logIn();const rejected=await f.service.poll(args);assert.notEqual(rejected.phase,'connected');assert.deepEqual(f.counts,before);assert.equal(f.counts.resume,0);assert.deepEqual(f.profile,profile);assert.deepEqual(f.config,transport);await f.service.poll(args);assert.deepEqual(f.counts,before);
});
for(const action of ['stop','close'])test(action+' during awaited same-flow login confirmation prevents queued recovery',async t=>{
  const f=await fixture(t),first=await connect(f),args={instanceId:'persona-a',flowId:first.flowId};f.logOut();await f.service.poll(args);f.logIn();let entered=false,release;const hold=new Promise(resolve=>{release=resolve;});f.setFetchHook(async url=>{if(url.endsWith('/GetQQLoginInfo')){entered=true;await hold;}});const polling=f.service.poll(args);for(let i=0;i<5000&&!entered;i++)await tick();assert.equal(entered,true);if(action==='stop')await f.service.stop(args);else await f.service.close();const before={...f.counts};release();const final=await polling;assert.equal(final.phase,'stopped');assert.equal(final.connected,false);assert.deepEqual(f.counts,before);assert.equal(f.counts.resume,0);
});
test('login diagnostics retain a useful reason while hiding secret-like values and links',async t=>{
  const f=await fixture(t),first=await startReady(f),web=JSON.parse(await fs.readFile(path.join(f.installRoot,'runtime','config','webui.json'),'utf8'));f.setLoginError('Core init failed #2132 '+web.token+' https://qq.com/private?token=hidden');const value=await f.service.poll({instanceId:'persona-a',flowId:first.flowId});assert.equal(value.error.code,'NAPCAT_LOGIN_ERROR');assert.match(value.error.message,/#2132/);assert.equal(value.error.message.includes(web.token),false);assert.equal(value.error.message.includes('token=hidden'),false);
});
test('stop never claims that launcher exit proves the entire QQ process tree has exited',async t=>{
  const f=await fixture(t,{confirmStop:false}),first=await startReady(f);f.spawned.child.exitCode=0;f.spawned.child.emit('exit',0);const value=await f.service.stop({flowId:first.flowId});assert.equal(value.phase,'failed');assert.equal(value.error.code,'NAPCAT_STOP_UNCONFIRMED');assert.equal(value.manualCloseRequired,true);
});
test('cancelled old launch cannot spawn after its WebUI await resolves',async t=>{
  const f=await fixture(t);let release,entered=false;const hold=new Promise(resolve=>{release=resolve;});f.setFetchHook(async url=>{if(!entered&&url.endsWith('/auth/login')){entered=true;await hold;}});await f.service.start({instanceId:'persona-a'});for(let i=0;i<5000&&!entered;i++)await tick();assert.equal(entered,true);f.switchPersona();const second=await f.service.start({instanceId:'persona-b'});release();for(let i=0;i<5000&&(await f.service.inspect()).phase==='installing';i++)await tick();const final=await f.service.poll({instanceId:'persona-b',flowId:second.flowId});assert.equal(final.phase,'waiting_login');assert.equal(f.counts.spawn,1);assert.equal(final.instanceId,'persona-b');
});
test('new start waits for old stop so a stale stop cannot kill the replacement flow',async t=>{
  const f=await fixture(t),first=await startReady(f),old=f.spawned.child;let release,entered=false;const hold=new Promise(resolve=>{release=resolve;});f.setStatusHook(async()=>{entered=true;await hold;});const stopping=f.service.stop({flowId:first.flowId});for(let i=0;i<5000&&!entered;i++)await tick();assert.equal(entered,true);f.switchPersona();let started=false;const starting=f.service.start({instanceId:'persona-b'}).then(value=>{started=true;return value;});await tick();assert.equal(started,false);f.setStatusHook(null);release();await stopping;const second=await starting;for(let i=0;i<5000&&(await f.service.inspect()).phase==='installing';i++)await tick();const final=await f.service.poll({instanceId:'persona-b',flowId:second.flowId});assert.equal(final.phase,'waiting_login');assert.equal(old.killed,true);assert.equal(f.spawned.child.killed,false);assert.equal(f.counts.spawn,2);
});
test('close during owner readiness does not create a flow, download or spawn afterward',async t=>{
  const f=await fixture(t);let release;const hold=new Promise(resolve=>{release=resolve;});f.setOwnerReady(hold);const starting=f.service.start({instanceId:'persona-a'});const rejected=assert.rejects(starting,{code:'NAPCAT_CLOSED'});await tick();const closing=f.service.close();release();await rejected;await closing;assert.equal(f.counts.download,0);assert.equal(f.counts.spawn,0);assert.equal((await f.service.inspect()).flowId,null);
});
test('a changed platform account invalidates the bound connection and disables only owned transports',async t=>{
  const f=await fixture(t),first=await connect(f);f.setAccount('87654321');const final=await f.service.poll({instanceId:'persona-a',flowId:first.flowId});assert.equal(final.phase,'failed');assert.equal(final.error.code,'NAPCAT_ACCOUNT_CHANGED');assert.equal(final.apiReady,false);assert.equal(final.connected,false);assert.equal(f.profile.enabled,false);assert.equal(f.profile.config.accountId,'12345678');assert.equal(f.config.network.httpServers.find(v=>v.name==='xiangxu-managed-http').enable,false);assert.equal(f.config.network.httpServers[0].name,'other-server');assert.equal(f.config.network.httpClients[0].name,'other-client');
});
for(const phase of ['connected','authorized'])for(const route of ['/QQLogin/CheckLoginStatus','/QQLogin/GetQQLoginInfo'])test('one expired WebUI credential recovers '+phase+' polling at '+route+' without reconnecting',async t=>{
  const f=await fixture(t),first=phase==='connected'?await connect(f):await startReady(f),args={instanceId:'persona-a',flowId:first.flowId};
  if(phase==='authorized'){f.logIn();assert.equal((await f.service.poll(args)).phase,'authorized');}
  const before={...f.counts},authBefore=f.requests.filter(v=>v.route==='/api/auth/login').length;let attempts=0;
  f.setFetchHook(async url=>{if(new URL(url).pathname==='/api'+route&&++attempts===1)return new Response('',{status:401});});
  const recovered=await f.service.poll(args);assert.equal(recovered.phase,phase);assert.equal(recovered.error,null);assert.equal(recovered.connected,phase==='connected');assert.equal(recovered.apiReady,phase==='connected');assert.equal(recovered.loginAccount.accountId,'12345678');assert.equal(attempts,2);assert.equal(f.requests.filter(v=>v.route==='/api/auth/login').length,authBefore+1);assert.deepEqual(f.counts,before);
  f.setFetchHook(null);assert.equal((await f.service.poll(args)).phase,phase);assert.equal(f.requests.filter(v=>v.route==='/api/auth/login').length,authBefore+1);
});
test('waiting-login polling transparently replaces a rejected WebUI read credential once',async t=>{
  const f=await fixture(t),first=await startReady(f),args={instanceId:'persona-a',flowId:first.flowId};let rejected=false;const authBefore=f.requests.filter(v=>v.route==='/api/auth/login').length;f.setFetchHook(async url=>{if(!rejected&&url.endsWith('/CheckLoginStatus')){rejected=true;return new Response('',{status:401});}});const recovered=await f.service.poll(args);assert.equal(recovered.phase,'waiting_login');assert.equal(recovered.error,null);assert.equal(f.requests.filter(v=>v.route==='/api/auth/login').length,authBefore+1);const final=await f.service.poll(args);assert.equal(final.error,null);assert.equal(f.requests.filter(v=>v.route==='/api/auth/login').length,authBefore+1);assert.equal(f.counts.setConfig,0);
});
for(const route of ['/QQLogin/CheckLoginStatus','/QQLogin/GetQQLoginInfo'])test('repeated 401 at '+route+' stops after one reauthentication and one reread',async t=>{
  const f=await fixture(t),first=await connect(f),args={instanceId:'persona-a',flowId:first.flowId},before={...f.counts},authBefore=f.requests.filter(v=>v.route==='/api/auth/login').length;let attempts=0;
  f.setFetchHook(async url=>{if(new URL(url).pathname==='/api'+route){attempts++;return new Response('',{status:401});}});
  const failed=await f.service.poll(args);assert.equal(failed.phase,'failed');assert.equal(failed.error.code,'NAPCAT_HTTP_FAILED');assert.equal(attempts,2);assert.equal(f.requests.filter(v=>v.route==='/api/auth/login').length,authBefore+1);assert.deepEqual(f.counts,before);await f.service.poll(args);assert.equal(attempts,2);
});
test('WebUI reauthentication rejection is not retried or converted into a connected state',async t=>{
  const f=await fixture(t),first=await connect(f),before={...f.counts};let reads=0,auth=0;
  f.setFetchHook(async url=>{if(url.endsWith('/CheckLoginStatus')){reads++;return new Response('',{status:401});}if(url.endsWith('/auth/login')){auth++;return new Response('',{status:401});}});
  const failed=await f.service.poll({instanceId:'persona-a',flowId:first.flowId});assert.equal(failed.phase,'failed');assert.equal(failed.error.code,'NAPCAT_HTTP_FAILED');assert.equal(reads,1);assert.equal(auth,1);assert.deepEqual(f.counts,before);
});
test('a non-authentication read failure does not reauthenticate or reread',async t=>{
  const f=await fixture(t),first=await connect(f),authBefore=f.requests.filter(v=>v.route==='/api/auth/login').length;let attempts=0;
  f.setFetchHook(async url=>{if(url.endsWith('/CheckLoginStatus')){attempts++;return new Response('',{status:503});}});
  const failed=await f.service.poll({instanceId:'persona-a',flowId:first.flowId});assert.equal(failed.error.code,'NAPCAT_HTTP_FAILED');assert.equal(attempts,1);assert.equal(f.requests.filter(v=>v.route==='/api/auth/login').length,authBefore);
});
for(const route of ['/OB11Config/GetConfig','/OB11Config/SetConfig'])test('401 at '+route+' rejects connect without automatically replaying configuration',async t=>{
  const f=await fixture(t),first=await startReady(f),args={instanceId:'persona-a',flowId:first.flowId,allowedPrivateIds:['23456789'],allowedGroupIds:['34567890']};f.logIn();await f.service.poll(args);const authBefore=f.requests.filter(v=>v.route==='/api/auth/login').length;let attempts=0;
  f.setFetchHook(async url=>{if(new URL(url).pathname==='/api'+route){attempts++;return new Response('',{status:401});}});
  await assert.rejects(f.service.connect(args),{code:'NAPCAT_HTTP_FAILED'});assert.equal(attempts,1);assert.equal(f.counts.setConfig,0);assert.equal(f.counts.start,0);assert.equal(f.counts.rotate,0);assert.equal(f.requests.filter(v=>v.route==='/api/auth/login').length,authBefore);assert.equal((await f.service.inspect()).phase,'failed');
});
test('a QR-refresh 401 clears the cache but does not replay the requested mutation',async t=>{
  const f=await fixture(t),first=await startReady(f),args={instanceId:'persona-a',flowId:first.flowId},authBefore=f.requests.filter(v=>v.route==='/api/auth/login').length;let attempts=0;
  f.setFetchHook(async url=>{if(url.endsWith('/RefreshQRcode')){attempts++;return new Response('',{status:401});}});
  const failed=await f.service.poll({...args,refreshQr:true});assert.equal(failed.error.code,'NAPCAT_HTTP_FAILED');assert.equal(attempts,1);assert.equal(f.counts.refresh,0);assert.equal(f.requests.filter(v=>v.route==='/api/auth/login').length,authBefore);const final=await f.service.poll(args);assert.equal(final.error,null);assert.equal(attempts,1);assert.equal(f.requests.filter(v=>v.route==='/api/auth/login').length,authBefore+1);
});
test('stop during an awaited resume never deadlocks on its queued restore or resumes after manual stop',async t=>{
  const f=await fixture(t);await connect(f);await f.service.close();f.service=f.make();let releaseAccount,accountEntered=false;const accountHold=new Promise(resolve=>{releaseAccount=resolve;});f.setFetchHook(async url=>{if(url.endsWith('/GetQQLoginInfo')){accountEntered=true;await accountHold;}});const resumed=await f.service.resume(),duplicate=await f.service.resume();assert.equal(duplicate.flowId,resumed.flowId);for(let i=0;i<5000&&!accountEntered;i++)await tick();assert.equal(accountEntered,true);
  let releaseStatus,statusEntered=false;const statusHold=new Promise(resolve=>{releaseStatus=resolve;});f.setStatusHook(async()=>{statusEntered=true;await statusHold;});const stopping=f.service.stop({flowId:resumed.flowId});for(let i=0;i<5000&&!statusEntered;i++)await tick();assert.equal(statusEntered,true);releaseAccount();await tick();f.setStatusHook(null);releaseStatus();const stopped=await Promise.race([stopping,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('stop must settle without queued-restore deadlock')),3000);timer.unref();})]);assert.equal(stopped.phase,'stopped');await tick();assert.equal(f.counts.resume,0);assert.equal(f.profile.enabled,false);
});
test('a launcher that never obtained a process id can be retried after its spawn error',async t=>{
  const f=await fixture(t,{launchErrorOnce:true});await f.service.start({instanceId:'persona-a'});for(let i=0;i<5000&&(await f.service.inspect()).phase!=='failed';i++)await tick();assert.equal((await f.service.inspect()).error.code,'NAPCAT_LAUNCH_FAILED');const final=await startReady(f);assert.equal(final.phase,'waiting_login');assert.equal(f.counts.spawn,2);
});

test('ZIP accepts normal members and rejects traversal, Windows aliases, symlinks, duplicate paths and conflicts',()=>{
  assert.equal(inspectNapcatZip(zip(members)).entries.length,5);
  for(const name of ['../escape','/absolute','C:/drive','inside/../escape','CON.txt','trailing.','trailing ','file:stream','a//b'])assert.throws(()=>inspectNapcatZip(zip([{name}])),{code:'NAPCAT_ARCHIVE_PATH'});
  assert.throws(()=>inspectNapcatZip(zip([{name:'link',attrs:0xa0000000}])),{code:'NAPCAT_ARCHIVE_PATH'});
  assert.throws(()=>inspectNapcatZip(zip([{name:'same'},{name:'SAME'}])),{code:'NAPCAT_ARCHIVE_PATH'});
  assert.throws(()=>inspectNapcatZip(zip([{name:'parent'},{name:'parent/file'}])),{code:'NAPCAT_ARCHIVE_PATH'});
});
test('ZIP validates all member CRC and capacity before extraction',()=>{
  const bytes=zip(members);bytes[30+Buffer.byteLength(members[0].name)]^=1;assert.throws(()=>inspectNapcatZip(bytes),{code:'NAPCAT_ARCHIVE_INTEGRITY'});
  assert.throws(()=>inspectNapcatZip(zip(members),{limits:{...NAPCAT_ZIP_LIMITS,totalBytes:1}}),{code:'NAPCAT_ARCHIVE_CAPACITY'});
});

async function nativeConfig(f){const file=f.spawned?.options.env.XIANGXU_QQ_NATIVE_CONFIG;assert.ok(file,'native config path');return JSON.parse(await fs.readFile(file,'utf8'));}
async function nativeMarker(f,patch={}){const cfg=await nativeConfig(f);await fs.writeFile(cfg.markerPath,JSON.stringify({schemaVersion:'xiangxu-qq-native-marker/1',protocol:'xiangxu-qq-native/1',bootId:cfg.bootId,pid:5151,phase:'ready',ready:true,accountId:f.profile.config.accountId??'12345678',abiVersion:f.nativeRuntime.abiVersion,port:cfg.port,codes:[],...patch}));return cfg;}

test('native bootstrap is disabled by default and never exposes private runtime fields through inspect',async t=>{
 const f=await fixture(t);await connect(f);assert.equal(await f.service.getNativeRuntime(),null);assert.equal(f.spawned.options.env.XIANGXU_QQ_NATIVE_CONFIG,undefined);assert.equal(f.spawned.options.env.NAPCAT_DISABLE_MULTI_PROCESS,undefined);assert.equal(f.spawned.options.env.NAPCAT_LOAD_PATH,path.join(f.installRoot,'versions','fixture','loadNapCat.js'));
});
for(const nativeProvider of [undefined,'async','promise'])test('verified original native assets bootstrap through '+(nativeProvider??'object')+' metadata without editing official files',async t=>{
 const f=await fixture(t,{native:true,nativeProvider});await connect(f);const env=f.spawned.options.env,cfg=await nativeMarker(f),before=await fs.readFile(path.join(f.installRoot,'versions','fixture','napcat.mjs'),'utf8');assert.equal(env.NAPCAT_DISABLE_MULTI_PROCESS,'1');assert.equal(env.NAPCAT_LOAD_PATH,f.nativeRuntime.loaderPath);assert.equal(cfg.schemaVersion,'xiangxu-qq-native-config/1');assert.equal(cfg.host,'127.0.0.1');assert.equal(cfg.expectedAccountId,null);assert.equal(cfg.onebotToken,f.profile.config.accessToken);assert.equal(cfg.onebotApiUrl,'http://127.0.0.1:3000');assert.equal(cfg.assetRoot,f.nativeRuntime.assetRoot);assert.equal(cfg.officialBundleSha256,f.nativeRuntime.officialBundleSha256);assert.equal(before,'fixture');assert.equal(f.nativePortHeld,false);assert.deepEqual([f.nativeCounts.reserve,f.nativeCounts.release],[1,1]);
 const runtime=await f.service.getNativeRuntime();assert.deepEqual(Object.keys(runtime).sort(),['abiVersion','baseUrl','bootId','enabled','expectedAccountId','protocol','token'].sort());assert.equal(runtime.bootId,cfg.bootId);assert.equal(runtime.token,cfg.token);assert.equal(runtime.expectedAccountId,'12345678');assert.equal(runtime.baseUrl,'http://127.0.0.1:3001');assert.equal(f.nativeOwnership[0].launcher,f.spawned.child);assert.equal(f.nativeOwnership[0].bootId,cfg.bootId);assert.ok(Number.isFinite(f.nativeOwnership[0].startedAt));assert.equal(f.nativeCounts.inspect,1);
 const publicStatus=JSON.stringify(await f.service.inspect());for(const secret of [cfg.token,cfg.markerPath,cfg.journalRoot,env.XIANGXU_QQ_NATIVE_CONFIG,cfg.assetRoot])assert.equal(publicStatus.includes(secret),false);assert.equal(f.requests.some(r=>/friend|send|request/i.test(r.route)),false);
});
for(const nativeTamper of ['asset','wrapper','bundle'])test('native '+nativeTamper+' hash mismatch falls back to ordinary OneBot without native reservation',async t=>{
 const f=await fixture(t,{native:true,nativeTamper});const value=await connect(f);assert.equal(value.phase,'connected');assert.equal(await f.service.getNativeRuntime(),null);assert.equal(f.spawned.options.env.XIANGXU_QQ_NATIVE_CONFIG,undefined);assert.equal(f.spawned.options.env.NAPCAT_LOAD_PATH,path.join(f.installRoot,'versions','fixture','loadNapCat.js'));assert.equal(f.nativeCounts.reserve,0);
});
test('an unavailable async native asset provider leaves ordinary OneBot usable',async t=>{const f=await fixture(t,{native:true,nativeProvider:'reject'});assert.equal((await connect(f)).phase,'connected');assert.equal(await f.service.getNativeRuntime(),null);assert.equal(f.nativeCounts.reserve,0);});
test('native getter requires an owned marker and actual live authenticated inspect',async t=>{
 const f=await fixture(t,{native:true});await connect(f);assert.equal(await f.service.getNativeRuntime(),null);await nativeMarker(f);f.setNativeOwned(false);assert.equal(await f.service.getNativeRuntime(),null);assert.equal(f.nativeCounts.inspect,0);f.setNativeOwned(true);f.setNativeInspectHook(async()=>{throw new Error('isolated offline port');});assert.equal(await f.service.getNativeRuntime(),null);f.setNativeInspectHook(null);assert.equal((await f.service.getNativeRuntime()).enabled,true);
});
for(const mismatch of ['boot','account','pid','abi','port'])test('native '+mismatch+' marker mismatch never hands out a stale private descriptor',async t=>{
 const f=await fixture(t,{native:true});await connect(f);await nativeMarker(f);assert.ok(await f.service.getNativeRuntime());const patch={boot:{bootId:'other-boot'},account:{accountId:'87654321'},pid:{pid:5152},abi:{abiVersion:'different-abi'},port:{port:3002}}[mismatch];await nativeMarker(f,patch);assert.equal(await f.service.getNativeRuntime(),null);await nativeMarker(f);assert.equal(await f.service.getNativeRuntime(),null,'invalidated native boot cannot be revived from a stale marker');
});
test('native runtime is unavailable while login is lost and remains invalid after stop or close',async t=>{
 const f=await fixture(t,{native:true}),connected=await connect(f),args={instanceId:'persona-a',flowId:connected.flowId};await nativeMarker(f);assert.ok(await f.service.getNativeRuntime());f.logOut();await f.service.poll(args);assert.equal(await f.service.getNativeRuntime(),null);f.logIn();await f.service.poll(args);assert.ok(await f.service.getNativeRuntime());await f.service.stop(args);assert.equal(await f.service.getNativeRuntime(),null);await f.service.close();assert.equal(await f.service.getNativeRuntime(),null);
});
test('native runtime account change stops the prior account and invalidates private runtime',async t=>{
 const f=await fixture(t,{native:true}),connected=await connect(f);await nativeMarker(f);assert.ok(await f.service.getNativeRuntime());f.setAccount('87654321');await f.service.poll({instanceId:'persona-a',flowId:connected.flowId});assert.equal(await f.service.getNativeRuntime(),null);assert.equal(f.profile.enabled,false);
});
test('stopping during native readiness cannot return a late descriptor',async t=>{
 const f=await fixture(t,{native:true}),connected=await connect(f);await nativeMarker(f);let entered=false,release;const hold=new Promise(r=>{release=r;});f.setNativeInspectHook(async()=>{entered=true;await hold;});const pending=f.service.getNativeRuntime();for(let i=0;i<5000&&!entered;i++)await tick();assert.equal(entered,true);await f.service.stop({instanceId:'persona-a',flowId:connected.flowId});release();assert.equal(await pending,null);
});
test('a personality switch during native readiness never publishes the earlier instance descriptor',async t=>{
 const f=await fixture(t,{native:true});await connect(f);await nativeMarker(f);let entered=false,release;const hold=new Promise(r=>{release=r;});f.setNativeInspectHook(async()=>{entered=true;await hold;});const pending=f.service.getNativeRuntime();for(let i=0;i<5000&&!entered;i++)await tick();assert.equal(entered,true);f.switchPersona();release();assert.equal(await pending,null);
});
test('native resume uses a fresh boot and credentials tied to the prior confirmed account',async t=>{
 const f=await fixture(t,{native:true});await connect(f);const old=await nativeMarker(f);assert.ok(await f.service.getNativeRuntime());await f.service.close();f.service=f.make();await f.service.resume();for(let i=0;i<5000&&(await f.service.inspect()).phase!=='connected';i++)await tick();assert.equal((await f.service.inspect()).phase,'connected');const current=await nativeMarker(f);assert.notEqual(current.bootId,old.bootId);assert.notEqual(current.token,old.token);assert.equal(current.expectedAccountId,'12345678');assert.equal((await f.service.getNativeRuntime()).bootId,current.bootId);
});

for(const patch of [{ready:false},{bootId:'restarted-boot'},{accountId:'87654321'},{abiVersion:'other-abi'},{capabilities:{}},{capabilities:{query:{supported:true,available:true},request:{supported:true},respond:{supported:false,available:false}}}])test('native live inspect rejects stale or incomplete readiness '+JSON.stringify(patch),async t=>{
 const f=await fixture(t,{native:true});await connect(f);await nativeMarker(f);f.setNativeInspectPatch(patch);assert.equal(await f.service.getNativeRuntime(),null);assert.equal((await f.service.inspect()).phase,'connected','OneBot remains connected when native is unavailable');
});
test('busy channel stop does not disable a still-active native boot',async t=>{const f=await fixture(t,{native:true}),connected=await connect(f);await nativeMarker(f);const before=await f.service.getNativeRuntime();f.setStopBusy(true);await assert.rejects(f.service.stop({flowId:connected.flowId}),{code:'CHANNEL_BUSY'});assert.deepEqual(await f.service.getNativeRuntime(),before);f.setStopBusy(false);});
test('query-only native readiness is retained without claiming an unavailable request capability',async t=>{const f=await fixture(t,{native:true});await connect(f);await nativeMarker(f);f.setNativeInspectPatch({capabilities:{query:{supported:true,available:true},request:{supported:false,available:false},respond:{supported:false,available:false}}});assert.ok(await f.service.getNativeRuntime());});

test('native getter uses the actual authenticated client protocol before handing out a descriptor',async t=>{
 const f=await fixture(t,{native:true,nativeClientReal:true});await connect(f);const cfg=await nativeMarker(f),calls=[];let wrongBoot=false;
 f.setFetchHook(async(url,request)=>{
  if(!url.startsWith('http://127.0.0.1:3001/'))return;
  calls.push({url,request});assert.equal(url,'http://127.0.0.1:3001/v1/inspect');assert.equal(request.method,'POST');assert.equal(request.redirect,'error');assert.equal(request.headers.authorization,'Bearer '+cfg.token);assert.equal(request.headers['x-xiangxu-boot-id'],cfg.bootId);assert.deepEqual(JSON.parse(request.body),{});
  return Response.json({protocol:'xiangxu-qq-native/1',bootId:wrongBoot?'other-boot':cfg.bootId,accountId:'12345678',abiVersion:cfg.abiVersion,ready:true,capabilities:{query:{supported:true,available:true},request:{supported:true,available:true},respond:{supported:false,available:false}}});
 });
 const runtime=await f.service.getNativeRuntime();assert.ok(runtime);assert.equal(runtime.bootId,cfg.bootId);assert.equal(f.nativeCounts.inspect,0,'the injected inspector is not used');assert.equal(calls.length,1);
 wrongBoot=true;assert.equal(await f.service.getNativeRuntime(),null);assert.equal(calls.length,2);assert.equal((await f.service.inspect()).phase,'connected');assert.equal(calls.some(call=>/friend|request|query/.test(call.url)),false,'managed readiness never executes account actions');
});
