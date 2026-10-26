import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInstanceManager } from '../adapters/dsh/instances.js';

async function fixture(t,options={}) {
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'xiangxu-instances-'))), root=path.join(base,'memory'), registryPath=path.join(base,'instances.json'), calls=[];
  let busy=false;
  const createCoordinator=config=>{
    calls.push({kind:'open',root:config.memoryRoot,config});
    if(config.memoryRoot.endsWith('fail'))throw new Error('explicit failing root');
    const agents=new Map();let stopped=false;
    return{memoryRoot:config.memoryRoot,ready:Promise.resolve(),agents,repository:{getRuntime:async()=>({execution:{consolidationJobs:{}}})},
      attachAgent:async agent=>{if(stopped)throw new Error('stale attachment');agents.set(agent.id,{agent});return{attached:true};},
      async close(){stopped=true;calls.push({kind:'close',root:config.memoryRoot});},runtime:{},readyState:async()=>({loaded:true})};
  };
  const manager=createInstanceManager({initialRoot:root,registryPath,createCoordinator,isBusy:async()=>busy,...options});await manager.ready;
  t.after(async()=>{await manager.close();await fs.rm(base,{recursive:true,force:true});});
  return{base,root,registryPath,manager,calls,setBusy:value=>{busy=value;},createCoordinator};
}
test('explicit unload persists across restart, load is single-writer and async busy prevents closing a running operation',async t=>{
  const f=await fixture(t);assert.equal((await f.manager.listInstances()).activeInstanceId,'default');
  f.setBusy(true);await assert.rejects(f.manager.unload(),{code:'INSTANCE_BUSY'});assert.equal(f.calls.filter(x=>x.kind==='close').length,0);
  f.setBusy(false);await f.manager.unload();assert.equal(f.manager.getCoordinator(),null);assert.equal((await f.manager.listInstances()).autoLoad,false);
  await f.manager.close();const cold=createInstanceManager({initialRoot:f.root,registryPath:f.registryPath,createCoordinator:f.createCoordinator});await cold.ready;
  assert.equal(cold.getCoordinator(),null);await cold.load();assert.ok(cold.getCoordinator());await cold.close();
});
test('a failed selected load restores the previously active instance without pretending it switched',async t=>{
  const f=await fixture(t);await assert.rejects(f.manager.load({memoryRoot:path.join(f.base,'fail')}),/explicit failing root/);
  assert.equal((await f.manager.listInstances()).activeInstanceId,'default');assert.equal(f.calls.filter(x=>x.kind==='open').length,3);
});
test('failed registry persistence closes the new writer before restoring the previous instance',async t=>{
  const f=await fixture(t),next=path.join(f.base,'next');await fs.mkdir(f.registryPath);
  await assert.rejects(f.manager.load({memoryRoot:next}));
  assert.equal((await f.manager.listInstances()).activeInstanceId,'default');
  assert.deepEqual(f.calls.slice(-3).map(x=>[x.kind,x.root]),[['open',next],['close',next],['open',f.root]]);
  assert.equal((await f.manager.listInstances()).selectedInstanceId,'default');
});
test('registered roots reject unrelated directories, disk roots and links without touching their contents',async t=>{
  const f=await fixture(t),unrelated=path.join(f.base,'documents');await fs.mkdir(unrelated);await fs.writeFile(path.join(unrelated,'keep.txt'),'keep');
  await assert.rejects(f.manager.load({memoryRoot:unrelated}),{code:'INSTANCE_NOT_MEMORY'});assert.equal(await fs.readFile(path.join(unrelated,'keep.txt'),'utf8'),'keep');
  await assert.rejects(f.manager.load({memoryRoot:path.parse(f.base).root}),{code:'INSTANCE_PATH'});
});
test('saved technical settings survive a manager reload instead of being replaced by bundle defaults',async t=>{
  const f=await fixture(t,{config:{consolidationMode:'sleep'}});await fs.mkdir(f.root,{recursive:true});
  await fs.writeFile(path.join(f.root,'config.json'),JSON.stringify({schemaVersion:'persona-memory/3',consolidationMode:'on_write'}));
  await f.manager.unload();await f.manager.load();assert.equal(f.calls.filter(x=>x.kind==='open').at(-1).config.consolidationMode,'on_write');
});
test('switching instances does not attach an existing conversation owned by another memory root',async t=>{
  const f=await fixture(t),agent={id:'session-a',session:{id:'session-a'}};await fs.mkdir(f.root,{recursive:true});
  await fs.writeFile(path.join(f.root,'config.json'),JSON.stringify({schemaVersion:'persona-memory/3'}));
  await fs.writeFile(path.join(f.root,'host-checkpoints.json'),JSON.stringify({sessions:{'session-a':10}}));
  await f.manager.load({memoryRoot:path.join(f.base,'second'),name:'第二实例'});assert.deepEqual(await f.manager.attachAgent(agent),{status:'different_instance'});
  assert.deepEqual(await f.manager.attachAgent({id:'new',session:{id:'new'}}),{attached:true});
});
