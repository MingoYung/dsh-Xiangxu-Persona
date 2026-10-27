'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto'),{pathToFileURL}=require('node:url');
const PROTOCOL='xiangxu-qq-native/1',ABI='qq-win-53644-req-to-friend/1';
const BUNDLE_SHA='7c66d0239d7effe73ab6e4920eddef732a8066fb47cd19539541c72055c5f0aa';
const WRAPPER_SHA='0d8b94448f4dafe7337b88d6a568b004224c37fcbe2bd1142c1af7624fbd534c';
const ASSETS=['assets.mjs','journal.mjs','loader.cjs','service.mjs','session-tap.mjs'];
const same=(a,b)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
let config=null,markerAllowed=false,nativeStarted=false,restoreHook=()=>{};const codes=[];
function safe(file){if(typeof file!=='string'||!path.isAbsolute(file))fail('QQ_NATIVE_PATH_INVALID');let cursor=path.parse(file).root;for(const part of file.slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,part);try{const stat=fs.lstatSync(cursor);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink!==1)fail('QQ_NATIVE_PATH_UNSAFE');}catch(error){if(error.code!=='ENOENT')throw error;}}}
function read(file,max){safe(file);const stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>max||!same(fs.realpathSync(file),file))fail('QQ_NATIVE_FILE_INVALID');return fs.readFileSync(file);}
function diagnostic(code){
  if(typeof code!=='string'||!(/^(QQ_NATIVE|SESSION_TAP)_[A-Z0-9_]{1,80}$/).test(code))return;
  if(!codes.includes(code)&&codes.length<24)codes.push(code);
  if(config&&markerAllowed&&!nativeStarted)try{safe(config.markerPath);fs.mkdirSync(path.dirname(config.markerPath),{recursive:true});safe(config.markerPath+'.next');const marker={schemaVersion:'xiangxu-qq-native-marker/1',protocol:PROTOCOL,bootId:config.bootId,pid:process.pid,phase:'bootstrap',ready:false,accountId:null,abiVersion:ABI,port:config.port,codes:[...codes]};fs.writeFileSync(config.markerPath+'.next',JSON.stringify(marker,null,2)+'\n',{mode:0o600});safe(config.markerPath);fs.renameSync(config.markerPath+'.next',config.markerPath);}catch{}
}
(async()=>{
  const main=process.env.NAPCAT_MAIN_PATH;
  // Import only the explicitly pinned original entry. Vendor files remain intact.
  if(digest(read(main,16777216))!==BUNDLE_SHA)fail('QQ_NATIVE_BUNDLE_SHA_MISMATCH');
  try{
    config=JSON.parse(read(process.env.XIANGXU_QQ_NATIVE_CONFIG,32768).toString('utf8'));
    if(config.schemaVersion!=='xiangxu-qq-native-config/1'||config.host!=='127.0.0.1'||!path.isAbsolute(config.markerPath??'')||!path.isAbsolute(config.assetRoot??'')||!path.isAbsolute(config.qqInstallRoot??'')||!same(config.officialBundlePath,main)||config.officialBundleSha256!==BUNDLE_SHA||!config.assetHashes||typeof config.assetHashes!=='object')fail('QQ_NATIVE_CONFIG_INVALID');
    const markerRelative=path.relative(config.qqInstallRoot,config.markerPath);if(!markerRelative||!markerRelative.startsWith('..')&&!path.isAbsolute(markerRelative))fail('QQ_NATIVE_CONFIG_PATH');
    if(typeof config.bootId!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(config.bootId)||!Number.isInteger(config.port)||config.port<0||config.port>65535)fail('QQ_NATIVE_CONFIG_INVALID');
    markerAllowed=true;
    diagnostic('QQ_NATIVE_LOADER_ENTERED');
    if(process.env.NAPCAT_DISABLE_MULTI_PROCESS!=='1'&&process.env.NAPCAT_DISABLE_MULTIPROCESSING!=='1')fail('QQ_NATIVE_SINGLE_PROCESS_REQUIRED');
    for(const name of ASSETS){const expected=config.assetHashes[name];if(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected)||digest(read(path.join(config.assetRoot,name),2097152))!==expected)fail('QQ_NATIVE_ASSET_SHA_MISMATCH');}
    if(Object.keys(config.assetHashes).some(name=>!ASSETS.includes(name)))fail('QQ_NATIVE_ASSET_UNKNOWN');
    const wrapper=path.join(config.qqInstallRoot,'versions','9.9.36-53644','resources','app','wrapper.node');
    if(fs.lstatSync(wrapper).size!==117866024||digest(read(wrapper,134217728))!==WRAPPER_SHA)fail('QQ_NATIVE_WRAPPER_UNSUPPORTED');
    const {installSessionTap}=await import(pathToFileURL(path.join(config.assetRoot,'session-tap.mjs')).href);
    const {startNativeService,validateNativeConfig}=await import(pathToFileURL(path.join(config.assetRoot,'service.mjs')).href);validateNativeConfig(config);
    const originalDescriptor=Object.getOwnPropertyDescriptor(process,'dlopen');
    if(!originalDescriptor||typeof originalDescriptor.value!=='function'||!originalDescriptor.writable&&!originalDescriptor.configurable)fail('QQ_NATIVE_DLOPEN_UNAVAILABLE');
    const original=originalDescriptor.value;
    const hook=function(...args){
      const target=typeof args[1]==='string'&&same(args[1],wrapper);let result;
      try{result=Reflect.apply(original,this,args);}catch(error){if(target)restoreHook();throw error;}
      if(target){restoreHook();try{
        const holder=Object.getOwnPropertyDescriptor(args[0],'exports');if(!holder||!Object.hasOwn(holder,'value'))fail('QQ_NATIVE_EXPORTS_UNAVAILABLE');
        const tap=installSessionTap(holder.value,{onDiagnostic:diagnostic,onCapture(session){
          diagnostic('QQ_NATIVE_ORIGINAL_SESSION_CAPTURED');
          void startNativeService({session,config,onDiagnostic:diagnostic}).then(service=>{
            nativeStarted=true;diagnostic('QQ_NATIVE_SERVICE_STARTED');
            const close=()=>{void service.close().catch(()=>diagnostic('QQ_NATIVE_CLOSE_FAILED'));};process.once('SIGTERM',close);process.once('SIGINT',close);
          }).catch(()=>diagnostic('QQ_NATIVE_SERVICE_START_FAILED'));
        }});diagnostic(tap.installed?'QQ_NATIVE_SESSION_TAP_INSTALLED':'QQ_NATIVE_SESSION_TAP_UNAVAILABLE');
      }catch{diagnostic('QQ_NATIVE_SESSION_TAP_FAILED');}}
      return result;
    };
    restoreHook=()=>{try{if(Object.getOwnPropertyDescriptor(process,'dlopen')?.value===hook)Object.defineProperty(process,'dlopen',originalDescriptor);}catch{diagnostic('QQ_NATIVE_HOOK_RESTORE_FAILED');}};
    Object.defineProperty(process,'dlopen',{...originalDescriptor,value:hook});diagnostic('QQ_NATIVE_HOOK_INSTALLED');
    const timer=setTimeout(restoreHook,120000);timer.unref();
  }catch(error){restoreHook();diagnostic(/^QQ_NATIVE_[A-Z0-9_]+$/.test(error?.code??'')?error.code:'QQ_NATIVE_BOOTSTRAP_UNAVAILABLE');}
  try{await import(pathToFileURL(main).href);}catch(error){restoreHook();throw error;}
})();
