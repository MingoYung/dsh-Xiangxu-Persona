import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {MemoryRepository} from '../core/repository.js';

test('one native event may have distinct accepted reasoning and task-metadata provenance without last-row overwrite',async t=>{
  const root=await mkdtemp(join(tmpdir(),'xiangxu-source-variants-'));
  const repository=new MemoryRepository({root});await repository.open();
  t.after(async()=>{await repository.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true});});
  await repository.upsertPerson({personId:'b'});
  const common={sourceSessionId:'actual-session',sourceEventId:'actual-event',sourceRole:'assistant',sourceOrigin:'ai_initiated',available:true};
  for(const [kind,sourceKind] of [['reasoning','model'],['tool_call','persona-task:metadata']])await repository.captureHot({personId:'b',sourceRef:{...common,sourceKind},sourceKind,kind,origin:'ai_initiated',content:{mode:'cached',text:'fixture',chars:7},sourceAt:1,observedAt:1});
  const run=await repository.prepareConsolidation({personId:'b'});
  const entry=(id,ref)=>({documentKey:'persona',expectedVersion:run.inputVersions.persona,operation:'upsert',recordId:'habits:'+id,value:{scope:'global',personId:null,epistemic:'interpretation',text:'fixture habit '+id,srcRefs:[ref]}});
  await assert.rejects(repository.applyConsolidation(run,[entry('forged',{...common,sourceKind:'model',sourceRole:'user'})]),error=>error.code==='SCHEMA_INVALID');
  await assert.rejects(repository.applyConsolidation(run,[entry('forged-pair',{...common,sourceKind:'model',sourceOrigin:'system'})]),error=>error.code==='SCHEMA_INVALID');
  await repository.applyConsolidation(run,[entry('reasoning',{...common,sourceKind:'model'}),entry('metadata',{...common,sourceKind:'persona-task:metadata'})]);
  const persona=await repository.store.readJson('self/persona.json');
  assert.deepEqual(persona.habits.map(h=>h.srcRefs[0].sourceKind),['model','persona-task:metadata']);
  assert.ok(persona.habits.every(h=>h.srcRefs[0].sourceRole==='assistant'));
});
