import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('legacy QQ publication cannot silently change provider or choose a public visibility',async()=>{
  const source=(await readFile(new URL('../adapters/dsh/index.js',import.meta.url),'utf8')).replaceAll('\r\n','\n');
  const marker='coordinator.platformPort = ',start=source.indexOf(marker),end=source.indexOf(';\n      return coordinator;',start);assert(start>=0&&end>start);
  let writes=0,provider='napcat-onebot-account';
  const coordinator={memoryRoot:'isolated',socialProviders:{execute:async()=>{writes++;return{status:'completed'};}}};
  const caps=async()=>({accountId:'100',items:[{id:'feed.publish',supported:true,provider}]});
  const factory=new Function('coordinator','channels','permissions','platformCapabilities','bilibili','social','qqAccounts','executeQQAccountOperation','return ('+source.slice(start+marker.length,end)+');');
  const port=factory(coordinator,{}, {authorize:async()=>true},caps,null,null,null,null);
  const input={platform:'qq',action:'execute',capability:'feed.publish',text:'isolated fixture',requestId:'trusted-host-call'};
  await assert.rejects(port(input),{code:'QQ_ACCOUNT_SCOPE_REQUIRED'});assert.equal(writes,0);
  provider='optional-extension';assert.equal((await port(input)).status,'completed');assert.equal(writes,1,'existing explicitly configured optional path remains usable when it is the reported source');
});
