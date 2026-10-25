import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicReplaceWithRetry } from '../../core/store.js';
import { createBackup, restoreBackup, validateMemoryRoot, recoverRestore } from '../../core/maintenance.js';
import { defaultConfig } from '../../core/schema.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const clone = value => structuredClone(value);
const same = (a,b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
async function readBounded(file, limit) {
  const stat=await fs.lstat(file);if(stat.isSymbolicLink()||!stat.isFile())fail('INSTANCE_PATH','实例元数据必须是普通文件');
  if(stat.size>limit)fail('INSTANCE_METADATA_CAPACITY','实例元数据超过读取上限');
  const handle=await fs.open(file,'r');try{const buffer=Buffer.alloc(limit+1);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);if(bytesRead>limit)fail('INSTANCE_METADATA_CAPACITY','实例元数据超过读取上限');return buffer.subarray(0,bytesRead).toString('utf8');}finally{await handle.close();}
}
async function rootPath(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) fail('INSTANCE_PATH', '请选择绝对记忆目录');
  const root = path.resolve(input); if (same(root,path.parse(root).root)) fail('INSTANCE_PATH','不能把磁盘根目录作为记忆库');
  let current = path.parse(root).root;
  for (const part of root.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current,part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) fail('INSTANCE_PATH','记忆目录不能经过符号链接或目录联接'); }
    catch(error) { if(error.code!=='ENOENT')throw error; }
  }
  return root;
}
async function admit(root) {
  let files; try { files=await fs.readdir(root); } catch(error) { if(error.code==='ENOENT')return;throw error; }
  if (!files.length || files.every(name=>name==='operator')) return;
  const config=await readBounded(path.join(root,'config.json'),1048576).catch(error=>{if(error.code==='ENOENT')fail('INSTANCE_NOT_MEMORY','目标目录包含其他文件，不能作为新记忆库');throw error;});
  if(JSON.parse(config).schemaVersion!=='persona-memory/3')fail('INSTANCE_SCHEMA','此目录不是兼容的persona-memory/3记忆库');
}

/** Host lifecycle only. No autonomous personality decisions are created here. */
export function createInstanceManager({ initialRoot, config={}, createCoordinator, registryPath, onLoaded=async()=>{}, isBusy=()=>false }) {
  const firstRoot=path.resolve(initialRoot), location=registryPath??path.join(path.dirname(firstRoot),path.basename(firstRoot)+'.instances.json');
  let registry, active=null, activeId=null, closed=false, lastError=null, tail=Promise.resolve();
  const queue=work=>{const result=tail.then(work);tail=result.catch(()=>{});return result;};
  const emptyAgents=new Map();
  async function persist() {
    const text=JSON.stringify(registry,null,2)+'\n';if(Buffer.byteLength(text)>65536)fail('INSTANCE_REGISTRY_CAPACITY','实例登记已超过64KiB');
    await rootPath(path.dirname(location));await fs.mkdir(path.dirname(location),{recursive:true});
    try{if((await fs.lstat(location)).isSymbolicLink())fail('INSTANCE_PATH','实例登记不能是链接');}catch(error){if(error.code!=='ENOENT')throw error;}
    const tmp=location+'.next',handle=await fs.open(tmp,'w');try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}
    await atomicReplaceWithRetry(tmp,location);
  }
  function descriptor(args={}) {
    const id=args.instanceId??registry.selectedInstanceId;
    const item=registry.items.find(x=>x.instanceId===id);if(!item)fail('INSTANCE_NOT_FOUND','未找到选中的人格实例');return item;
  }
  async function stop() {
    const previous=active;
    if(previous)try{await previous.close();}catch(error){lastError={code:'INSTANCE_CLOSE_FAILED',message:error.message};throw error;}
    active=null;activeId=null;
  }
  async function start(item) {
    await rootPath(item.memoryRoot);await admit(item.memoryRoot);
    let saved={};try{const values=JSON.parse(await readBounded(path.join(item.memoryRoot,'config.json'),1048576));saved=Object.fromEntries(Object.keys(defaultConfig()).filter(key=>Object.hasOwn(values,key)).map(key=>[key,values[key]]));}catch(error){if(error.code!=='ENOENT')throw error;}
    const coordinator=createCoordinator({ ...config,...saved,memoryRoot:item.memoryRoot });
    try {await coordinator.ready;if(coordinator.initializationError)throw coordinator.initializationError;await onLoaded(coordinator);}
    catch(error){await coordinator.close().catch(()=>{});throw error;}
    active=coordinator;activeId=item.instanceId;lastError=null;
  }
  async function ensureIdle() {
    if(!active)return;
    const state=await active.repository.getRuntime();
    if(await isBusy(activeId)||Object.values(state.execution?.consolidationJobs??{}).some(job=>job.status==='running')||[...active.agents.values()].some(value=>value.agent?.status==='running'))
      fail('INSTANCE_BUSY','当前有正在执行的对话或整理，请在完成后切换实例');
  }
  async function mayAttach(agent, root=active?.memoryRoot) {
    if(!root)return false;
    const hasSession=async memoryRoot=>{
      try {return Object.hasOwn(JSON.parse(await readBounded(path.join(memoryRoot,'host-checkpoints.json'),8388608)).sessions??{},agent.session.id);}
      catch(error){if(error.code==='ENOENT')return false;throw error;}
    };
    if(await hasSession(root))return true;
    for(const item of registry.items)if(!same(item.memoryRoot,root)&&await hasSession(item.memoryRoot))return false;
    return true;
  }
  async function switchTo(item,{ autoLoad=true }={}) {
    await ensureIdle();const previous=activeId?descriptor({instanceId:activeId}):null;
    const before={selectedInstanceId:registry.selectedInstanceId,autoLoad:registry.autoLoad};
    await stop();
    try{await start(item);registry.selectedInstanceId=item.instanceId;registry.autoLoad=autoLoad;await persist();}
    catch(error){const failure={code:error.code??'INSTANCE_LOAD_FAILED',message:error.message};Object.assign(registry,before);
      try{await stop();if(previous)await start(previous);}catch(recovery){failure.recovery={code:recovery.code??'INSTANCE_RECOVERY_FAILED',message:recovery.message};}
      lastError=failure;throw error;}
    return manager.listInstances();
  }
  async function maintain(kind,args={}) {
    await manager.ready;return queue(async()=>{
      const item=descriptor(args);const wasActive=activeId===item.instanceId;
      if(wasActive){await ensureIdle();await stop();}
      let result,error;
      try {
        if(kind==='validate')result=await validateMemoryRoot(item.memoryRoot);
        if(kind==='backup')result=await createBackup({root:item.memoryRoot,destination:await rootPath(args.destination)});
        if(kind==='restore')result=await restoreBackup({root:item.memoryRoot,source:await rootPath(args.source)});
        if(kind==='recover')result=await recoverRestore({root:item.memoryRoot});
      }catch(failure){error=failure;}
      // Validate/backup resume the exact previously loaded instance. Restore and
      // recovery remain stopped: reopening may release saved timers/model work.
      if(wasActive&&['validate','backup'].includes(kind))try{await start(item);}catch(failure){if(!error)error=failure;}
      if(['restore','recover'].includes(kind)){registry.autoLoad=false;await persist();}
      if(error)throw error;
      const receipt={...result};if(Array.isArray(receipt.files)){receipt.fileCount=receipt.files.length;delete receipt.files;}
      return{...receipt,instanceId:item.instanceId,loaded:activeId===item.instanceId,requiresLoad:['restore','recover'].includes(kind)};
    });
  }
  const manager={
    get current(){return active;},get runtime(){return active?.runtime;},get repository(){return active?.repository;},get agents(){return active?.agents??emptyAgents;},
    get errors(){return active?.errors??(lastError?[lastError]:[]);},get initializationError(){return lastError;},get memoryRoot(){return active?.memoryRoot??registry?.items.find(x=>x.instanceId===registry.selectedInstanceId)?.memoryRoot??firstRoot;},
    getCoordinator(instanceId){if(instanceId&&instanceId!==activeId)return null;return active;},
    canAttachAgent:mayAttach,
    async listInstances(){await manager.ready;return{items:clone(registry.items).map(item=>({...item,loaded:item.instanceId===activeId,selected:item.instanceId===registry.selectedInstanceId})),activeInstanceId:activeId,selectedInstanceId:registry.selectedInstanceId,autoLoad:registry.autoLoad,error:lastError};},
    async load(args={}){await manager.ready;return queue(async()=>{if(closed)fail('MANAGER_CLOSED','管理器已关闭');
      let item;
      if(args.memoryRoot){const root=await rootPath(args.memoryRoot);item=registry.items.find(value=>same(value.memoryRoot,root));
        if(!item){if(registry.items.length>=16)fail('INSTANCE_REGISTRY_CAPACITY','最多登记16个实例');item={instanceId:'instance_'+randomUUID(),name:String(args.name??'相续人格').slice(0,80),memoryRoot:root};registry.items.push(item);}}
      else item=descriptor(args);
      return switchTo(item,{autoLoad:args.autoLoad!==false});
    });},
    async unload(args={}){await manager.ready;return queue(async()=>{const item=descriptor(args);if(activeId===item.instanceId){await ensureIdle();await stop();}if(item.instanceId===registry.selectedInstanceId)registry.autoLoad=false;await persist();return manager.listInstances();});},
    async select(args={}){return manager.load(args);},
    maintenance:{validate:args=>maintain('validate',args),backup:args=>maintain('backup',args),restore:args=>maintain('restore',args),recover:args=>maintain('recover',args)},
    async attachAgent(agent){await manager.ready;if(!active)return{status:'unloaded'};if(!await mayAttach(agent))return{status:'different_instance'};return active.attachAgent(agent);},
    observeEvent:(...args)=>active?.observeEvent(...args),notifyEnvironment:(...args)=>active?.notifyEnvironment(...args),
    async readyState(){await manager.ready;return active?active.readyState():{available:false,loaded:false};},
    async close(){await manager.ready;return queue(async()=>{closed=true;await stop();});},
  };
  manager.ready=(async()=>{
    await rootPath(firstRoot);
    try {
      registry=JSON.parse(await readBounded(location,65536));if(registry.schemaVersion!=='persona-instances/1'||!Array.isArray(registry.items)||registry.items.length>16)fail('INSTANCE_REGISTRY_SCHEMA','实例登记格式不支持');
      for(const item of registry.items){if(typeof item.instanceId!=='string'||typeof item.name!=='string')fail('INSTANCE_REGISTRY_SCHEMA','实例登记字段无效');await rootPath(item.memoryRoot);}
    }catch(error){if(error.code!=='ENOENT')throw error;registry={schemaVersion:'persona-instances/1',selectedInstanceId:'default',autoLoad:config.enabled!==false,items:[{instanceId:'default',name:'相续人格',memoryRoot:firstRoot}]};}
    if(registry.autoLoad&&config.enabled!==false){try{await start(descriptor());}catch(error){lastError={code:error.code??'INSTANCE_LOAD_FAILED',message:error.message};}}
    return manager;
  })();
  return manager;
}
