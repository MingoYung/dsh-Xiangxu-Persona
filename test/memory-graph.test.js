import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { MemoryRepository } from '../core/repository.js';
import { createBackup, restoreBackup } from '../core/maintenance.js';
import { MEMORY_GRAPH_LIMITS as L, projectMemoryGraph, validateMemoryGraphInput } from '../core/memory-graph.js';
import { retrievalRecordKey } from '../core/retrieval.js';

async function fixture(t, config = {}) {
  const parent=await fs.realpath(os.tmpdir()),base=await fs.realpath(await fs.mkdtemp(path.join(parent,'xiangxu-graph-'))),repo=new MemoryRepository({root:path.join(base,'memory'),config,clock:()=>100000});
  await repo.open();for(const personId of ['alice','bob'])await repo.upsertPerson({personId});
  t.after(async()=>{await repo.close();assert.ok(base.startsWith(parent+path.sep));await fs.rm(base,{recursive:true,force:true});});return {repo,base};
}
const chat=(event,personId='alice',extra={})=>({personId,role:'user',sourceSessionId:'actual-session',sourceEventId:event,sourceKind:'user',contentClass:'participant_dialogue',channelId:'fixture',text:event,...extra});
async function put(repo, records, personId=null, field='index'){
  const run=await repo.prepareConsolidation({personId}),key=personId?'person:'+personId+':'+field:'global:'+field;
  await repo.applyConsolidation(run,records.map(item=>({documentKey:key,expectedVersion:run.inputVersions[key],operation:'upsert',recordId:item.id,value:field==='codes'?{label:item.id,meaning:'',cues:[],expandIds:[],occurrences:0,srcRefs:[],...item}:{kind:'fact',srcRefs:[],...item}})));
}
async function hashes(repo){const out={};for(const file of await repo.store.listFiles())out[file.path]=createHash('sha256').update(await fs.readFile(path.join(repo.root,file.path))).digest('hex');return out;}
const row=(id,extra={})=>({id,recordType:'memory',schemaVersion:'persona-memory/3',scope:'global',personId:null,text:id,srcRefs:[],...extra});
const meta=(extra={})=>({version:1,sources:{},personIds:['alice','bob'],revokedIds:[],revokedSources:[],...extra});

test('empty graphs are detached read-only local projections without all-memory scans, raw history or embedding',async t=>{
  const {repo}=await fixture(t),before=await hashes(repo);repo._allMemory=()=>{throw Error('Full-memory scan forbidden');};repo._records=()=>{throw Error('Timeline scan forbidden');};repo._retrieval.search=()=>{throw Error('Embedding forbidden');};
  const graph=await repo.getMemoryGraph();assert.equal(graph.format,'persona-memory-graph/1');assert.equal(graph.nodes.length,0);assert.equal(graph.coverage.entireStoreRead,false);assert.equal(graph.coverage.total,null);assert.equal(graph.coverage.rawScope,'none');assert.equal(graph.automaticRecall,false);
  assert.equal(graph.coverage.documentsRead.some(x=>/timeline|stream/.test(x.path)),false);assert.deepEqual(await hashes(repo),before);
});

test('stored links and source provenance produce typed edges, and similar prose creates no inferred link',async t=>{
  const {repo}=await fixture(t),source=await repo.ingest(chat('actual-origin',null));
  const ref={sourceSessionId:source.record.sourceSessionId,sourceEventId:source.record.sourceEventId,available:true};
  await put(repo,[{id:'a',text:'same words',relatedMemoryIds:['b'],srcRefs:[ref]},{id:'b',text:'same words'},{id:'c',text:'same words'}]);
  const graph=await repo.getMemoryGraph(),a=graph.nodes.find(x=>x.recordId==='a'),b=graph.nodes.find(x=>x.recordId==='b'),c=graph.nodes.find(x=>x.recordId==='c');
  assert.ok(graph.edges.some(x=>x.source===a.id&&x.target===b.id&&x.kind==='related'&&x.basis.field==='relatedMemoryIds'));
  assert.equal(graph.edges.some(x=>[x.source,x.target].includes(c.id)),false);assert.ok(graph.nodes.some(x=>x.kind==='source'&&x.sourceRef.sourceEventId==='actual-origin'));assert.ok(graph.edges.some(x=>x.kind==='source_session'));
  assert.equal(graph.coverage.rawScope,'none');assert.equal(graph.nodes.some(x=>x.recordType==='chat'),false);
});

test('person scopes never load another person document or connect a same-ID record from another relationship',async t=>{
  const {repo}=await fixture(t);await put(repo,[{id:'same',text:'Alice',relatedMemoryIds:['bob-only']}],'alice');await put(repo,[{id:'same',text:'Bob'},{id:'bob-only',text:'Bob-only'}],'bob');
  const graph=await repo.getMemoryGraph({scope:'person',personId:'alice'});assert.ok(graph.nodes.filter(x=>x.kind==='record').every(x=>x.personId==='alice'));assert.equal(JSON.stringify(graph).includes('Bob-only'),false);
  assert.equal(graph.coverage.documentsRead.some(x=>x.path.startsWith('people/bob/')),false);assert.equal(graph.edges.some(x=>x.kind==='related'),false);assert.ok(graph.coverage.unresolvedLinks.unavailable>0);
  const bob=await repo.getMemoryGraph({scope:'person',personId:'bob'});assert.notEqual(graph.nodes.find(x=>x.recordId==='same').id,bob.nodes.find(x=>x.recordId==='same').id);
});

test('same-ID records of different types are distinct nodes but unqualified link targets remain ambiguous',async t=>{
  const {repo}=await fixture(t);await put(repo,[{id:'a',text:'start',relatedMemoryIds:['same']},{id:'same',text:'memory'}]);await put(repo,[{id:'same',meaning:'code'}],null,'codes');
  const graph=await repo.getMemoryGraph();assert.equal(graph.nodes.filter(x=>x.recordId==='same').length,2);assert.equal(graph.edges.some(x=>x.kind==='related'),false);assert.ok(graph.coverage.unresolvedLinks.ambiguous>0);
});

test('explicit seed and queries select within the bounded scope, with actual typed replacement/expansion bases',async t=>{
  const {repo}=await fixture(t);await put(repo,[{id:'a',text:'tea',supersedesIds:['b']},{id:'b',text:'older tea'},{id:'c',text:'unrelated'}]);
  const key=retrievalRecordKey(row('a')),graph=await repo.getMemoryGraph({seedRecordKey:key});assert.equal(graph.nodes[0].recordKey,key);assert.equal(graph.nodes.some(x=>x.recordId==='c'),false);assert.ok(graph.edges.some(x=>x.kind==='supersedes'));
  const found=await repo.getMemoryGraph({query:'unrelated',recordTypes:['memory']});assert.deepEqual(found.nodes.filter(x=>x.kind==='record').map(x=>x.recordId),['c']);
});

test('default unknown scope asks to select an original and does not imply the memory store is empty',async t=>{
  const {repo}=await fixture(t);await repo.ingest(chat('unknown',null));const graph=await repo.getMemoryGraph({scope:'unknown'});
  assert.equal(graph.coverage.total,null);assert.ok(graph.coverage.reasons.includes('select_original_for_unknown_scope'));assert.equal(graph.coverage.rawScope,'none');assert.equal(graph.nodes.length,0);
});

test('selected raw shard supplies same-person originals and factual session grouping without returning raw bodies',async t=>{
  const {repo}=await fixture(t,{recentTargetChars:0,longTermTargetChars:0});const first=await repo.ingest(chat('first','alice',{text:'private raw body one'}));await repo.ingest(chat('second','alice',{text:'private raw body two'}));await repo.ingest(chat('foreign','bob',{text:'foreign raw body'}));
  const key=retrievalRecordKey({...first.record,recordType:'chat',scope:'person'}),graph=await repo.getMemoryGraph({scope:'person',personId:'alice',seedRecordKey:key});
  assert.equal(graph.coverage.rawScope,'selected_shard');assert.equal(graph.coverage.selectedShardRecords,2);assert.equal(graph.nodes.filter(x=>x.recordType==='chat').length,2);assert.equal(graph.nodes.filter(x=>x.kind==='session').length,1);
  assert.ok(graph.edges.filter(x=>x.kind==='source_session').every(x=>x.basis.sourceSessionId==='actual-session'));assert.equal(JSON.stringify(graph).includes('private raw body'),false);assert.equal(JSON.stringify(graph).includes('foreign raw body'),false);
  assert.equal(graph.nodes[0].recordKey,key);assert.ok(graph.nodes[0].sourceRef);assert.equal(graph.nodes[0].role,'user');assert.equal(graph.nodes[0].speakerId,'alice');
});

test('an explicit archive source reads its actual shard and does not inspect an unrelated corrupt archive',async t=>{
  const {repo}=await fixture(t,{recentTargetChars:0,longTermTargetChars:0,retention:{journalMaxBytes:16384}});const first=await repo.ingest(chat('first','alice',{text:'a'.repeat(3600)}));await repo.ingest(chat('second','bob',{text:'b'.repeat(3600)}));const catalog=await repo.getTimelineStatus();assert.equal(catalog.archiveFiles.length,2);
  await fs.writeFile(path.join(repo.root,catalog.archiveFiles[1].path),'unrelated damaged shard');
  const graph=await repo.getMemoryGraph({scope:'person',personId:'alice',sourceRef:{sourceSessionId:'actual-session',sourceEventId:'first'}});
  assert.ok(graph.nodes.some(x=>x.recordId===first.record.id));assert.deepEqual(graph.coverage.documentsRead.filter(x=>x.path.startsWith('timeline/archive/')).map(x=>x.path),[catalog.archiveFiles[0].path]);
});

test('a selected archive checksum mismatch is reported rather than turned into graph data',async t=>{
  const {repo}=await fixture(t,{recentTargetChars:0,longTermTargetChars:0});await repo.ingest(chat('one','alice'));const catalog=await repo.getTimelineStatus(),file=path.join(repo.root,catalog.archiveFiles[0].path),text=await fs.readFile(file,'utf8');await fs.writeFile(file,text.replace('"text":"one"','"text":"two"'));
  await assert.rejects(repo.getMemoryGraph({scope:'person',personId:'alice',sourceRef:{sourceSessionId:'actual-session',sourceEventId:'one'}}),{code:'TIMELINE_ARCHIVE_CORRUPT'});
});

test('explicit source selection cannot cross the requested relationship or use a forged storage path',async t=>{
  const {repo}=await fixture(t);await repo.ingest(chat('bob-event','bob'));let graph=await repo.getMemoryGraph({scope:'person',personId:'alice',sourceRef:{sourceSessionId:'actual-session',sourceEventId:'bob-event'}});
  assert.equal(graph.coverage.rawScope,'none');assert.ok(graph.coverage.reasons.includes('selected_source_outside_scope'));
  const file=path.join(repo.root,'meta/state.json'),value=JSON.parse(await fs.readFile(file,'utf8'));value.sources[JSON.stringify(['actual-session','bob-event'])].storagePath='self/persona.json';await fs.writeFile(file,JSON.stringify(value));
  await assert.rejects(repo.getMemoryGraph({scope:'person',personId:'bob',sourceRef:{sourceSessionId:'actual-session',sourceEventId:'bob-event'}}),{code:'SCHEMA_INVALID'});
});

test('oversized metadata is never read and yields explicit unavailable coverage within hard budgets',async t=>{
  const {repo}=await fixture(t),file=path.join(repo.root,'meta/state.json');await fs.appendFile(file,' '.repeat(L.metadataBytes));
  const graph=await repo.getMemoryGraph();assert.equal(graph.readBudget.bytesRead,0);assert.equal(graph.nodes.length,0);assert.equal(graph.coverage.catalogueComplete,false);assert.equal(graph.coverage.total,null);assert.equal(graph.coverage.documentsSkipped[0].path,'meta/state.json');assert.equal(graph.coverage.documentsSkipped[0].reason,'file_byte_limit');
});

test('oversized business documents are skipped before reading, not scanned and then cut to a node limit',async t=>{
  const {repo}=await fixture(t);await put(repo,[{id:'a',text:'saved'}]);const file=path.join(repo.root,'global/index.json');await fs.appendFile(file,' '.repeat(L.documentBytes));
  const graph=await repo.getMemoryGraph();assert.equal(graph.nodes.some(x=>x.recordId==='a'),false);assert.ok(graph.coverage.documentsSkipped.some(x=>x.path==='global/index.json'&&x.reason==='file_byte_limit'));assert.equal(graph.coverage.catalogueComplete,false);assert.equal(graph.coverage.documentsRead.some(x=>x.path==='global/index.json'),false);
});

test('the cumulative read budget skips later files rather than exceeding four MiB',async t=>{
  const {repo}=await fixture(t),pad=async(relative,size)=>{const file=path.join(repo.root,relative),raw=await fs.readFile(file);await fs.writeFile(file,Buffer.concat([raw,Buffer.alloc(size-raw.length,32)]));};
  await pad('meta/state.json',1900000);await pad('self/persona.json',500000);
  for(const name of ['index','codes','pending','impression']){const relative='people/alice/'+name+'.json',value={schemaVersion:'persona-memory/3',version:0,updatedAt:0,items:[],signatures:[],events:[]};await fs.mkdir(path.dirname(path.join(repo.root,relative)),{recursive:true});await fs.writeFile(path.join(repo.root,relative),JSON.stringify(value));await pad(relative,500000);}
  const graph=await repo.getMemoryGraph({scope:'person',personId:'alice'});assert.ok(graph.readBudget.bytesRead<=L.bytes);assert.ok(graph.coverage.documentsSkipped.some(x=>x.reason==='total_byte_limit'));assert.equal(graph.coverage.catalogueComplete,false);
});

test('row limits disclose partial coverage and suppress links whose unseen collision cannot be excluded',async t=>{
  const {repo}=await fixture(t),items=Array.from({length:2200},(_,i)=>row('r'+i,{recordType:undefined,relatedMemoryIds:i===0?['r1']:[],kind:'fact'}));
  await fs.mkdir(path.join(repo.root,'global'),{recursive:true});await fs.writeFile(path.join(repo.root,'global/index.json'),JSON.stringify({schemaVersion:'persona-memory/3',version:1,items}));
  const graph=await repo.getMemoryGraph();assert.equal(graph.readBudget.rowsVisited,L.rows);assert.ok(graph.coverage.reasons.includes('row_limit'));assert.equal(graph.coverage.catalogueComplete,false);assert.equal(graph.edges.some(x=>x.kind==='related'),false);assert.ok(graph.coverage.unresolvedLinks.unread>0);
});

test('bounded source-metadata indexing does not scan every receipt or resolve bare links from an incomplete index',async t=>{
  const {repo}=await fixture(t);await put(repo,[{id:'a',text:'start',relatedMemoryIds:['b']},{id:'b',text:'target'}]);
  const file=path.join(repo.root,'meta/state.json'),value=JSON.parse(await fs.readFile(file,'utf8'));
  for(let i=0;i<L.metadataEntries+1;i++)value.sources[JSON.stringify(['many','e'+i])]={id:'raw'+i,personId:null};
  await fs.writeFile(file,JSON.stringify(value));const graph=await repo.getMemoryGraph();
  assert.equal(graph.readBudget.metadataEntriesVisited,L.metadataEntries);assert.equal(graph.coverage.metadataIndexComplete,false);assert.ok(graph.coverage.reasons.includes('metadata_entry_limit'));assert.equal(graph.edges.some(x=>x.kind==='related'),false);
});

test('node, edge and serialized response caps hold even with long source identities and dense links',()=>{
  const rows=Array.from({length:120},(_,i)=>row('r'+i,{text:'short',relatedMemoryIds:Array.from({length:120},(_,j)=>'r'+j)}));
  let graph=projectMemoryGraph({rows,options:{limit:120,edgeLimit:200},meta:meta()});assert.equal(graph.nodes.length,120);assert.equal(graph.edges.length,200);assert.ok(graph.coverage.reasons.includes('edge_limit'));
  const sourceSessionId='会'.repeat(512),sources={};for(let i=0;i<120;i++){const ref={sourceSessionId,sourceEventId:'事'.repeat(500)+i};sources[JSON.stringify([ref.sourceSessionId,ref.sourceEventId])]={id:'o'+i,personId:null};rows[i].srcRefs=[ref];rows[i].relatedMemoryIds=[];}
  graph=projectMemoryGraph({rows:rows.slice(0,20),options:{limit:120},meta:meta({sources})});assert.ok(Buffer.byteLength(JSON.stringify(graph))<=L.responseBytes);assert.ok(graph.nodes.length<=120);assert.ok(graph.edges.length<=200);assert.ok(graph.coverage.reasons.includes('response_byte_limit'));
});

test('graph projection and explicit source reading never revive a revoked source after an older backup restore',async t=>{
  const {repo,base}=await fixture(t),source=await repo.ingest(chat('forget-me','alice'));await put(repo,[{id:'derived',text:'withdrawn',srcRefs:[{sourceSessionId:'actual-session',sourceEventId:'forget-me'}]}],'alice');
  await repo.close();await createBackup({root:repo.root,destination:path.join(base,'backup')});await repo.open();await repo.forget({ids:[source.record.id],targetPersonId:'alice',reason:'fixture withdrawal'});await repo.close();await restoreBackup({root:repo.root,source:path.join(base,'backup')});await repo.open();
  const graph=await repo.getMemoryGraph({scope:'person',personId:'alice',sourceRef:{sourceSessionId:'actual-session',sourceEventId:'forget-me'}});assert.equal(graph.nodes.length,0);assert.ok(graph.coverage.reasons.includes('selected_source_unavailable'));assert.equal(JSON.stringify(graph).includes('withdrawn'),false);
});

test('returned graph mutations cannot change storage or the next view',async t=>{
  const {repo}=await fixture(t);await put(repo,[{id:'a',text:'original'}]);const before=await hashes(repo),graph=await repo.getMemoryGraph();graph.nodes[0].label='changed';graph.coverage.reasons.push('invented');assert.equal((await repo.getMemoryGraph()).nodes[0].label,'original');assert.deepEqual(await hashes(repo),before);
});

test('graph input rejects unsafe paths, cross-scope parameters and unbounded budgets before source reads',async t=>{
  const {repo}=await fixture(t);for(const input of [{root:'C:/'},{scope:'all'},{scope:'person',personId:'../bob'},{scope:'global',personId:'alice'},{limit:121},{edgeLimit:201},{query:'x'.repeat(201)},{recordTypes:['neuron']},{seedRecordKey:'not-json'},{sourceRef:{sourceSessionId:'s',sourceEventId:'e',storagePath:'elsewhere'}}])await assert.rejects(repo.getMemoryGraph(input),{code:'SCHEMA_INVALID'});
  await repo.close();await assert.rejects(repo.getMemoryGraph(),{code:'STORE_CLOSED'});
});

test('ambiguous full composite source identities are not presented as a uniquely selectable seed',async t=>{
  const {repo}=await fixture(t);const one=await repo.ingest(chat('one','alice',{id:'same'}));await repo.ingest(chat('two','alice',{id:'same'}));const seedRecordKey=retrievalRecordKey({...one.record,recordType:'chat',scope:'person'});
  await assert.rejects(repo.getMemoryGraph({scope:'person',personId:'alice',seedRecordKey,sourceRef:{sourceSessionId:'actual-session',sourceEventId:'one'}}),{code:'MEMORY_RECORD_AMBIGUOUS'});
});

test('pure input validation never accepts a person/key mismatch as another graph scope',()=>{
  assert.throws(()=>validateMemoryGraphInput({seedRecordKey:JSON.stringify(['memory','global','alice','m'])}),{code:'SCHEMA_INVALID'});
  const graph=projectMemoryGraph({rows:[row('a'),row('a',{personId:'alice',scope:'person'})],options:{scope:'global'},meta:meta()});assert.equal(graph.nodes.length,1);assert.equal(graph.nodes[0].personId,null);
});
