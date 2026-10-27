import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import syncFs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createNativeRuntimeAssetsConfig,QQ_NATIVE_WRAPPER,QQ_NATIVE_BUNDLE_SHA256} from '../adapters/dsh/connections/qq-native/assets.mjs';

// Unit bootstrap boundary: fake native loader and fake vendor module, both local.
// Hash-port fixtures stand for the pinned files; no QQ native binary is loaded.
async function fixture(t,{changeConfig,throwNative,badBundle=false}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'xiangxu-native-loader-'));
  const assets=await createNativeRuntimeAssetsConfig(),main=path.join(root,'fake-vendor.mjs'),wrapper=path.join(root,'qq',QQ_NATIVE_WRAPPER.relativePath),markerPath=path.join(root,'state','marker.json'),configPath=path.join(root,'config.json');
  const code='export const originalModuleWasLoaded=true;\n';await fs.writeFile(main,code);const config={schemaVersion:'xiangxu-qq-native-config/1',host:'127.0.0.1',port:33991,token:'N'.repeat(43),bootId:'test-native-boot-0001',expectedAccountId:'10001',onebotApiUrl:'http://127.0.0.1:9/',onebotToken:'O'.repeat(43),qqInstallRoot:path.join(root,'qq'),officialBundlePath:main,officialBundleSha256:QQ_NATIVE_BUNDLE_SHA256,assetRoot:assets.assetRoot,assetHashes:{...assets.assetHashes},markerPath,journalRoot:path.join(root,'journal')};changeConfig?.(config);await fs.writeFile(configPath,JSON.stringify(config));
  const counts={dlopen:0,create:0,getSession:0},receivers=[],sameResult={},session={identity:'mock-only'};
  function Factory(){}Object.defineProperties(Factory,{getNTWrapperSession:{value:function(){counts.getSession++;return session;},writable:false,configurable:false},create:{value:()=>{counts.create++;throw Error('not called');},writable:false,configurable:false}});
  const original=function(holder,filename){counts.dlopen++;receivers.push(this);if(throwNative&&filename===wrapper)throw throwNative;holder.exports={NodeIQQNTWrapperSession:Factory,untouchedExport:17};return sameResult;};
  const processPort={env:{NAPCAT_MAIN_PATH:main,XIANGXU_QQ_NATIVE_CONFIG:configPath,NAPCAT_DISABLE_MULTI_PROCESS:'1'},dlopen:original,pid:process.pid,once(){}};
  const realHash=crypto.createHash.bind(crypto),wrapperContent=Buffer.from('FAKE_ONLY_NATIVE_WRAPPER_NO_CODE');
  const cryptoPort={...crypto,createHash(name){const chunks=[];return{update(value){chunks.push(Buffer.from(value));return this;},digest(format){const bytes=Buffer.concat(chunks);if(bytes.equals(Buffer.from(code)))return badBundle?'0'.repeat(64):QQ_NATIVE_BUNDLE_SHA256;if(bytes.equals(wrapperContent))return QQ_NATIVE_WRAPPER.sha256;return realHash(name).update(bytes).digest(format);}};}};
  const fsPort={...syncFs,lstatSync(file){if(path.resolve(file)===path.resolve(wrapper))return{isSymbolicLink:()=>false,isFile:()=>true,nlink:1,size:QQ_NATIVE_WRAPPER.bytes};return syncFs.lstatSync(file);},realpathSync(file){return path.resolve(file)===path.resolve(wrapper)?wrapper:syncFs.realpathSync(file);},readFileSync(file,...args){return path.resolve(file)===path.resolve(wrapper)?wrapperContent:syncFs.readFileSync(file,...args);}};
  const source=await fs.readFile(path.join(assets.assetRoot,'loader.cjs'),'utf8');
  const requirePort=name=>name==='node:fs'?fsPort:name==='node:crypto'?cryptoPort:name==='node:path'?path:name==='node:url'?{pathToFileURL:value=>new URL('file:///'+path.resolve(value).replaceAll('\\','/'))}:null;
  const script=new vm.Script(source,{filename:path.join(root,'virtual-vendor-directory','loadNapCat.js'),importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
  const completion=script.runInNewContext({require:requirePort,process:processPort,Buffer,setTimeout,clearTimeout,URL});
  t.after(async()=>{const resolved=path.resolve(root);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('xiangxu-native-loader-'));await fs.rm(resolved,{recursive:true,force:true});});
  return{completion,processPort,original,Factory,wrapper,counts,receivers,sameResult,session,config,markerPath};
}
test('loader uses absolute configured assets despite a different virtual vendor dirname',async t=>{
  const f=await fixture(t);await f.completion;assert.notEqual(f.processPort.dlopen,f.original);const marker=JSON.parse(await fs.readFile(f.markerPath,'utf8'));assert.ok(marker.codes.includes('QQ_NATIVE_HOOK_INSTALLED'));assert.equal(marker.ready,false);assert.equal(JSON.stringify(marker).includes(f.config.token),false);const holder={};assert.equal(f.processPort.dlopen(holder,f.wrapper),f.sameResult);assert.equal(f.receivers[0],f.processPort);assert.equal(f.processPort.dlopen,f.original);assert.notEqual(holder.exports.NodeIQQNTWrapperSession,f.Factory);assert.equal(holder.exports.untouchedExport,17);assert.equal(holder.exports.NodeIQQNTWrapperSession.getNTWrapperSession('nt_2'),f.session);assert.equal(holder.exports.NodeIQQNTWrapperSession,f.Factory);assert.deepEqual(f.counts,{dlopen:1,create:0,getSession:1});
});
test('non-target dlopen returns original result with original receiver and leaves target hook pending',async t=>{
  const f=await fixture(t);await f.completion;const hook=f.processPort.dlopen,receiver={};assert.equal(hook.call(receiver,{},path.join(os.tmpdir(),'different-wrapper.node')),f.sameResult);assert.equal(f.receivers[0],receiver);assert.equal(f.processPort.dlopen,hook);hook({},f.wrapper);assert.equal(f.processPort.dlopen,f.original);assert.equal(f.counts.create,0);
});
test('original native error keeps identity and restores dlopen without swallowing the official failure',async t=>{
  const originalError=new Error('fake-only-original-native-error'),f=await fixture(t,{throwNative:originalError});await f.completion;assert.throws(()=>f.processPort.dlopen({},f.wrapper),error=>error===originalError);assert.equal(f.processPort.dlopen,f.original);assert.equal(f.counts.getSession,0);
});
test('asset mismatch disables only native bootstrap while preserving original import and loader',async t=>{
  const f=await fixture(t,{changeConfig:value=>{value.assetHashes['service.mjs']='0'.repeat(64);}});await f.completion;assert.equal(f.processPort.dlopen,f.original);const marker=JSON.parse(await fs.readFile(f.markerPath,'utf8'));assert.ok(marker.codes.includes('QQ_NATIVE_ASSET_SHA_MISMATCH'));assert.equal(f.counts.dlopen,0);
});
test('vendor bundle hash mismatch fails before running unverified vendor code',async t=>{
  const f=await fixture(t,{badBundle:true});await assert.rejects(f.completion,{code:'QQ_NATIVE_BUNDLE_SHA_MISMATCH'});assert.equal(f.processPort.dlopen,f.original);await assert.rejects(fs.readFile(f.markerPath),{code:'ENOENT'});assert.equal(f.counts.dlopen,0);
});
test('bootstrap refuses a marker in vendor installation before any file write there',async t=>{
  const f=await fixture(t,{changeConfig:value=>{value.markerPath=path.join(value.qqInstallRoot,'forbidden-marker.json');}});await f.completion;await assert.rejects(fs.readFile(f.config.markerPath),{code:'ENOENT'});assert.equal(f.processPort.dlopen,f.original);
});
