import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createBackup, restoreBackup, validateMemoryRoot, recoverRestore } from '../../core/maintenance.js';
import { defaultConfig } from '../../core/schema.js';
import { INSTANCE_LIMITS, CLEAR_SCOPE, CLEAR_EXCLUDED, safeInstanceRoot as rootPath, readInstanceMetadata as readBounded,
  writeInstanceMetadata, scanManagedText, clearVersion, acquireClearGate, requireNoWriter, deleteManagedPlan, createSessionOwnershipStore } from './instance-lifecycle.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const clone = value => structuredClone(value);
const same = (a,b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
async function admit(root) {
  let files; try { files=await fs.readdir(root); } catch(error) { if(error.code==='ENOENT')return;throw error; }
  if (!files.length || files.every(name=>name==='operator')) return;
  const config=await readBounded(path.join(root,'config.json'),1048576).catch(error=>{if(error.code==='ENOENT')fail('INSTANCE_NOT_MEMORY','目标目录包含其他文件，不能作为新记忆库');throw error;});
  if(JSON.parse(config).schemaVersion!=='persona-memory/3')fail('INSTANCE_SCHEMA','此目录不是兼容的persona-memory/3记忆库');
}

/** Host lifecycle only. No autonomous personality decisions are created here. */
export function createInstanceManager({ initialRoot, config={}, createCoordinator, registryPath, onLoaded=async()=>{}, onStarted=async()=>{}, onStopping=async()=>{}, beforeMaintenance=async()=>{}, isBusy=()=>false,
  lifecycleClock=Date.now, lifecycleUnlink=fs.unlink, maintenanceOptions={} }) {
  const firstRoot=path.resolve(initialRoot), location=registryPath??path.join(path.dirname(firstRoot),path.basename(firstRoot)+'.instances.json');
  let registry, active=null, activeId=null, closed=false, lastError=null, tail=Promise.resolve();
  const queue=work=>{const result=tail.then(work);tail=result.catch(()=>{});return result;};
  const emptyAgents=new Map();
  const attachments=new Map(), attachmentClosed=new WeakSet();
  const previews=new Map(), ownership=createSessionOwnershipStore(location+'.ownership.json',()=>registry?.items??[]);
  const blocked=item=>!!item.archivedAt||['clearing','partial','cleared'].includes(item.clearStatus);
  const now=()=>new Date(lifecycleClock()).toISOString();
  function requireLoadable(item){if(blocked(item))fail('INSTANCE_RETIRED','此人格已归档或清除，请先按状态恢复；残留文本不能直接加载');}
  function liveCount(){return registry.items.filter(item=>item.clearStatus!=='cleared').length;}
  async function registryFingerprint(){try{return createHash('sha256').update(await readBounded(location,INSTANCE_LIMITS.registryBytes)).digest('hex');}catch(error){if(error.code==='ENOENT')return null;throw error;}}
  async function capture(item,coordinator=activeId===item.instanceId?active:null){
    const ids=[...(coordinator?.agents?.values()??[])].map(value=>value.agent?.session?.id).filter(id=>typeof id==='string'&&id);
    const count=await ownership.capture(item,ids);item.retiredSessionCount=count;return count;
  }
  async function persist() {
    const version=registry.version??0;registry.version=version+1;
    try{await writeInstanceMetadata(location,registry,INSTANCE_LIMITS.registryBytes);}catch(error){registry.version=version;throw error;}
  }
  function descriptor(args={}) {
    const id=args.instanceId??registry.selectedInstanceId;
    const item=registry.items.find(x=>x.instanceId===id);if(!item)fail('INSTANCE_NOT_FOUND','未找到选中的人格实例');return item;
  }
  async function stop() {
    const previous=active;
    if(previous)try{
      // A channel may be awaiting host agent/created while it drains. Its
      // attachment must be able to finish without waiting behind this stop.
      await onStopping(previous);attachmentClosed.add(previous);
      await Promise.allSettled([...(attachments.get(previous)??[])]);
      await previous.close();
    }catch(error){lastError={code:'INSTANCE_CLOSE_FAILED',message:error.message};throw error;}
    active=null;activeId=null;
  }
  async function start(item) {
    requireLoadable(item);
    await rootPath(item.memoryRoot);await admit(item.memoryRoot);
    let saved={};try{const values=JSON.parse(await readBounded(path.join(item.memoryRoot,'config.json'),1048576));saved=Object.fromEntries(Object.keys(defaultConfig()).filter(key=>Object.hasOwn(values,key)).map(key=>[key,values[key]]));}catch(error){if(error.code!=='ENOENT')throw error;}
    const coordinator=createCoordinator({ ...config,...saved,memoryRoot:item.memoryRoot });
    try {await coordinator.ready;if(coordinator.initializationError)throw coordinator.initializationError;await onLoaded(coordinator);}
    catch(error){await coordinator.close().catch(()=>{});throw error;}
    active=coordinator;activeId=item.instanceId;lastError=null;await onStarted(coordinator);
  }
  async function ensureIdle() {
    if(!active)return;
    const state=await active.repository.getRuntime();
    if(await isBusy(activeId)||Object.values(state.execution?.consolidationJobs??{}).some(job=>job.status==='running')||[...active.agents.values()].some(value=>value.agent?.status==='running'))
      fail('INSTANCE_BUSY','当前有正在执行的对话或整理，请在完成后切换实例');
  }
  async function mayAttach(agent, root=active?.memoryRoot) {
    if(!root)return false;
    if(active&&same(active.memoryRoot,root)&&attachmentClosed.has(active))return false;
    const item=registry.items.find(value=>same(value.memoryRoot,root));if(!item||blocked(item))return false;
    const owner=await ownership.ownerOf(agent.session.id);if(owner)return owner===item.instanceId;
    const hasSession=async memoryRoot=>{
      try {return Object.hasOwn(JSON.parse(await readBounded(path.join(memoryRoot,'host-checkpoints.json'),8388608)).sessions??{},agent.session.id);}
      catch(error){if(error.code==='ENOENT')return false;throw error;}
    };
    if(await hasSession(root))return true;
    for(const item of registry.items)if(!same(item.memoryRoot,root)&&await hasSession(item.memoryRoot))return false;
    return true;
  }
  async function switchTo(item,{ autoLoad=true }={}) {
    requireLoadable(item);
    await ensureIdle();const previous=activeId?descriptor({instanceId:activeId}):null;
    const before={selectedInstanceId:registry.selectedInstanceId,autoLoad:registry.autoLoad};
    if(previous)await capture(previous);await stop();
    try{await start(item);registry.selectedInstanceId=item.instanceId;registry.autoLoad=autoLoad;await persist();}
    catch(error){const failure={code:error.code??'INSTANCE_LOAD_FAILED',message:error.message};Object.assign(registry,before);
      try{await stop();if(previous)await start(previous);}catch(recovery){failure.recovery={code:recovery.code??'INSTANCE_RECOVERY_FAILED',message:recovery.message};}
      lastError=failure;throw error;}
    return manager.listInstances();
  }
  async function maintain(kind,args={}) {
    await manager.ready;return queue(async()=>{
      const item=descriptor(args);requireLoadable(item);const wasActive=activeId===item.instanceId;
      if(wasActive)await ensureIdle();
      await beforeMaintenance(kind,item);
      if(wasActive){await capture(item);await stop();}
      let result,error;
      try {
        if(kind==='validate')result=await validateMemoryRoot(item.memoryRoot,maintenanceOptions);
        if(kind==='backup')result=await createBackup({...maintenanceOptions,root:item.memoryRoot,destination:await rootPath(args.destination)});
        if(kind==='restore')result=await restoreBackup({...maintenanceOptions,root:item.memoryRoot,source:await rootPath(args.source)});
        if(kind==='recover')result=await recoverRestore({...maintenanceOptions,root:item.memoryRoot});
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
  async function preview(args={}) {
    const item=descriptor(args);if(item.clearStatus==='cleared')fail('INSTANCE_ALREADY_CLEARED','此人格文本资料已清除');
    const plan=await scanManagedText(item.memoryRoot,registry.items,item.instanceId,[location,ownership.file]);
    const version=clearVersion(item,plan,registry.version??0),token=randomUUID(),expires=lifecycleClock()+INSTANCE_LIMITS.previewTtlMs;
    for(const [key,value] of previews)if(value.expires<=lifecycleClock())previews.delete(key);
    while(previews.size>=INSTANCE_LIMITS.previews)previews.delete(previews.keys().next().value);
    previews.set(token,{instanceId:item.instanceId,version,expires,registryFingerprint:await registryFingerprint()});
    return{instanceId:item.instanceId,name:item.name,memoryRoot:item.memoryRoot,scope:[...CLEAR_SCOPE],excluded:[...CLEAR_EXCLUDED],files:plan.files.length,bytes:plan.bytes,
      requiresName:item.name,confirmationToken:token,version,expiresAt:new Date(expires).toISOString()};
  }
  async function clear(args={}) {
    const item=descriptor(args),saved=previews.get(args.confirmationToken);
    if(!saved||saved.instanceId!==item.instanceId||saved.expires<=lifecycleClock())fail('INSTANCE_CLEAR_CONFIRMATION','清除预览不存在或已过期，请重新预览');
    if(args.typedName!==item.name)fail('INSTANCE_CLEAR_NAME','请输入与预览完全相同的人格名称；未清除资料');
    if(await registryFingerprint()!==saved.registryFingerprint)fail('INSTANCE_CLEAR_STALE','磁盘中的实例登记已变化，请重新打开设置并预览；未清除资料');
    if(item.clearStatus==='cleared')fail('INSTANCE_ALREADY_CLEARED','此人格文本资料已清除');
    let plan=await scanManagedText(item.memoryRoot,registry.items,item.instanceId,[location,ownership.file]);
    if(clearVersion(item,plan,registry.version??0)!==saved.version)fail('INSTANCE_CLEAR_STALE','预览后资料或实例状态已变化，请重新预览；未清除资料');
    if(registry.items.filter(value=>value.clearStatus==='cleared').length>=INSTANCE_LIMITS.cleared)fail('INSTANCE_REGISTRY_CAPACITY','清除墓碑已达技术容量，未清除资料');
    // Reserve enough registry space for the durable in-progress state and receipt.
    if(Buffer.byteLength(JSON.stringify(registry))+2048>INSTANCE_LIMITS.registryBytes)fail('INSTANCE_REGISTRY_CAPACITY','实例登记空间不足，未清除资料');
    const wasActive=activeId===item.instanceId;if(wasActive)await ensureIdle();
    await capture(item);await beforeMaintenance('clear',item);
    const gate=await acquireClearGate(item.memoryRoot);previews.delete(args.confirmationToken);
    try{
      if(wasActive)await stop();
      if(registry.selectedInstanceId===item.instanceId)registry.autoLoad=false;
      await persist(); // Persist the stopped state even if the next scan finds an unknown new file.
      await requireNoWriter(item.memoryRoot);await capture(item);
      const stoppedPlan=await scanManagedText(item.memoryRoot,registry.items,item.instanceId,[location,ownership.file]);
      if(stoppedPlan.fingerprint!==plan.fingerprint)fail('INSTANCE_CLEAR_STALE','实例已停用；停机收据或资料发生变化，请重新预览。尚未删除任何文件');
      plan=stoppedPlan;item.clearStatus='clearing';item.clearStartedAt=now();await persist();
      const result=await deleteManagedPlan(plan,{unlink:lifecycleUnlink});
      let remaining,scanError;
      try{remaining=await scanManagedText(item.memoryRoot,registry.items,item.instanceId,[location,ownership.file]);}catch(error){scanError=error;}
      // A failed final scan cannot prove emptiness. Report conservative remaining
      // counts and retain a durable partial tombstone instead of reloading it.
      const remainingFiles=remaining?.files.length??Math.max(1,plan.files.length-result.deletedFiles),remainingBytes=remaining?.bytes??plan.bytes;
      const success=!scanError&&remainingFiles===0;
      item.clearStatus=success?'cleared':'partial';if(success)item.clearedAt=now();
      item.remainingFiles=remainingFiles;item.remainingBytes=remainingBytes;
      const errors=[...result.errors];if(scanError)errors.push({path:'',code:scanError.code??'INSTANCE_CLEAR_SCAN_FAILED'});
      item.clearErrorCount=errors.length;await persist();
      return{status:item.clearStatus,instanceId:item.instanceId,deletedFiles:result.deletedFiles,remainingFiles,remainingBytes,errors};
    }finally{await gate.release();}
  }
  const manager={
    get current(){return active;},get runtime(){return active?.runtime;},get repository(){return active?.repository;},get agents(){return active?.agents??emptyAgents;},
    get errors(){return active?.errors??(lastError?[lastError]:[]);},get initializationError(){return lastError;},get memoryRoot(){return active?.memoryRoot??registry?.items.find(x=>x.instanceId===registry.selectedInstanceId)?.memoryRoot??firstRoot;},
    getCoordinator(instanceId){if(instanceId&&instanceId!==activeId)return null;return active;},
    canAttachAgent:mayAttach,
    async listInstances(){await manager.ready;const cleared=registry.items.filter(item=>item.clearStatus==='cleared'),visible=[...registry.items.filter(item=>item.clearStatus!=='cleared'),...cleared.slice(-INSTANCE_LIMITS.listedCleared)];return{items:clone(visible).map(item=>({...item,loaded:item.instanceId===activeId,selected:item.instanceId===registry.selectedInstanceId})),activeInstanceId:activeId,selectedInstanceId:registry.selectedInstanceId,autoLoad:registry.autoLoad,error:lastError,counts:{live:liveCount(),cleared:cleared.length},clearedListComplete:cleared.length<=INSTANCE_LIMITS.listedCleared};},
    async load(args={}){await manager.ready;return queue(async()=>{if(closed)fail('MANAGER_CLOSED','管理器已关闭');
      let item;
      if(args.memoryRoot){const root=await rootPath(args.memoryRoot);item=registry.items.find(value=>same(value.memoryRoot,root));
        if(!item){if(liveCount()>=INSTANCE_LIMITS.active)fail('INSTANCE_REGISTRY_CAPACITY','最多保留16个未清除实例');const name=String(args.name??'相续人格').trim();if(!name||name.length>80)fail('INSTANCE_NAME','人格名称须为1至80个字符');item={instanceId:'instance_'+randomUUID(),name,memoryRoot:root};registry.items.push(item);}}
      else item=descriptor(args);
      return switchTo(item,{autoLoad:args.autoLoad!==false});
    });},
    async unload(args={}){await manager.ready;return queue(async()=>{const item=descriptor(args);if(activeId===item.instanceId){await ensureIdle();await capture(item);await stop();await capture(item);}if(item.instanceId===registry.selectedInstanceId)registry.autoLoad=false;await persist();return manager.listInstances();});},
    async create(args={}){await manager.ready;const name=String(args.name??'新相续人格').trim();if(!name||name.length>80)fail('INSTANCE_NAME','人格名称须为1至80个字符');return manager.load({name,memoryRoot:path.join(path.dirname(firstRoot),path.basename(firstRoot)+'-'+randomUUID()),autoLoad:args.autoLoad});},
    async archive(args={}){await manager.ready;return queue(async()=>{const item=descriptor(args);if(item.clearStatus)fail('INSTANCE_RETIRED','已清除或部分清除的人格不能归档');if(item.archivedAt)return manager.listInstances();
      if(activeId===item.instanceId){await ensureIdle();await capture(item);await stop();}await requireNoWriter(item.memoryRoot);await capture(item);item.archivedAt=now();if(registry.selectedInstanceId===item.instanceId)registry.autoLoad=false;await persist();return manager.listInstances();});},
    async restore(args={}){await manager.ready;return queue(async()=>{const item=descriptor(args);if(item.clearStatus)fail('INSTANCE_RETIRED','清除记录不能恢复为人格；请新建独立人格');if(!item.archivedAt)fail('INSTANCE_NOT_ARCHIVED','此人格没有归档');item.archivedAt=null;await persist();return args.activate===true?switchTo(item):manager.listInstances();});},
    async clearPreview(args={}){await manager.ready;return queue(()=>preview(args));},
    async clear(args={}){await manager.ready;return queue(()=>clear(args));},
    async select(args={}){return manager.load(args);},
    maintenance:{validate:args=>maintain('validate',args),backup:args=>maintain('backup',args),restore:args=>maintain('restore',args),recover:args=>maintain('recover',args)},
    async attachAgent(agent){await manager.ready;if(!active||closed||attachmentClosed.has(active))return{status:'unloaded'};
      const coordinator=active,item=descriptor({instanceId:activeId}),pending=attachments.get(coordinator)??new Set();attachments.set(coordinator,pending);
      const task=(async()=>{if(!await mayAttach(agent,coordinator.memoryRoot))return{status:'different_instance'};
        await ownership.capture(item,[agent.session.id]);
        if(closed||active!==coordinator||activeId!==item.instanceId||attachmentClosed.has(coordinator))return{status:'unloaded'};
        return coordinator.attachAgent(agent);})();
      pending.add(task);try{return await task;}finally{pending.delete(task);if(!pending.size)attachments.delete(coordinator);}
    },
    observeEvent:(...args)=>active?.observeEvent(...args),notifyEnvironment:(...args)=>active?.notifyEnvironment(...args),
    async readyState(){await manager.ready;return active?active.readyState():{available:false,loaded:false};},
    async close(){await manager.ready;return queue(async()=>{closed=true;let error;try{if(activeId)await capture(descriptor({instanceId:activeId}));}catch(failure){error=failure;}await stop();if(error)throw error;});},
  };
  manager.ready=(async()=>{
    await rootPath(firstRoot);
    try {
      registry=JSON.parse(await readBounded(location,INSTANCE_LIMITS.registryBytes));if(registry.schemaVersion!=='persona-instances/1'||(registry.version!==undefined&&(!Number.isSafeInteger(registry.version)||registry.version<0))||!Array.isArray(registry.items)||registry.items.length>INSTANCE_LIMITS.active+INSTANCE_LIMITS.cleared||liveCount()>INSTANCE_LIMITS.active||registry.items.filter(item=>item.clearStatus==='cleared').length>INSTANCE_LIMITS.cleared)fail('INSTANCE_REGISTRY_SCHEMA','实例登记格式不支持');
      const ids=new Set(),roots=new Set();for(const item of registry.items){if(typeof item.instanceId!=='string'||!item.instanceId||item.instanceId.length>256||ids.has(item.instanceId)||typeof item.name!=='string'||!item.name||item.name.length>80||![undefined,null,'clearing','partial','cleared'].includes(item.clearStatus))fail('INSTANCE_REGISTRY_SCHEMA','实例登记字段无效');ids.add(item.instanceId);item.memoryRoot=await rootPath(item.memoryRoot);const key=process.platform==='win32'?item.memoryRoot.toLowerCase():item.memoryRoot;if(roots.has(key))fail('INSTANCE_REGISTRY_SCHEMA','实例登记目录重复');roots.add(key);}
    }catch(error){if(error.code!=='ENOENT')throw error;registry={schemaVersion:'persona-instances/1',selectedInstanceId:'default',autoLoad:config.enabled!==false,items:[{instanceId:'default',name:'相续人格',memoryRoot:firstRoot}]};}
    await ownership.load();
    if(registry.autoLoad&&config.enabled!==false&&!blocked(descriptor())){try{await start(descriptor());}catch(error){lastError={code:error.code??'INSTANCE_LOAD_FAILED',message:error.message};}}
    return manager;
  })();
  return manager;
}
