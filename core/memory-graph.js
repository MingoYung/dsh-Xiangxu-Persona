import { createHash } from 'node:crypto';
import { SCHEMA_VERSION, SchemaError, safeId, sourceKey, countChars } from './schema.js';
import { retrievalRecordKey } from './retrieval.js';

export const MEMORY_GRAPH_LIMITS = Object.freeze({ bytes: 4194304, files: 8, metadataBytes: 2097152,
  documentBytes: 524288, archiveBytes: 1048576, catalogBytes: 262144, rows: 2048,
  metadataEntries: 4096, nodes: 120, edges: 200, responseBytes: 114688, linksPerRecord: 128, labelChars: 80, previewChars: 160 });
export const MEMORY_GRAPH_TYPES = Object.freeze(['memory', 'code', 'deep', 'interpretation', 'facet', 'signature', 'habit', 'relation_signature', 'relation_event', 'chat']);
const object = v => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const short = (value, n) => Array.from(typeof value === 'string' ? value : '').slice(0, n).join('');
const time = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const sha = value => createHash('sha256').update(value).digest('hex');
export const graphError = (code, message) => Object.assign(new Error(message), { code });
export function parseGraphRecordKey(key) {
  if (typeof key !== 'string' || countChars(key) > 2000) throw new SchemaError('Invalid bounded graph record key');
  let parts; try { parts = JSON.parse(key); } catch { throw new SchemaError('Invalid graph record key'); }
  if (!Array.isArray(parts) || parts.length !== 4 || JSON.stringify(parts) !== key || !MEMORY_GRAPH_TYPES.includes(parts[0]) ||
    !['global', 'person', 'staging'].includes(parts[1]) || typeof parts[3] !== 'string' || !parts[3] || countChars(parts[3]) > 200) throw new SchemaError('Invalid graph record identity');
  if (parts[2] !== null) safeId(parts[2]);
  if (parts[1] === 'person' ? parts[2] === null : parts[2] !== null) throw new SchemaError('Graph scope and person disagree');
  return { recordType: parts[0], scope: parts[1], personId: parts[2], id: parts[3] };
}
export function validateMemoryGraphInput(input = {}) {
  if (!object(input) || Object.keys(input).some(key => !['scope','personId','seedRecordKey','sourceRef','query','recordTypes','limit','edgeLimit'].includes(key))) throw new SchemaError('Unknown memory graph option');
  const scope = input.scope ?? 'global', query = input.query ?? '', limit = input.limit ?? 80, edgeLimit = input.edgeLimit ?? 160;
  if (!['global','person','unknown'].includes(scope)) throw new SchemaError('Graph needs a selected global, person or unknown scope');
  if (scope === 'person') safeId(input.personId); else if (input.personId !== undefined && input.personId !== null) throw new SchemaError('personId is only valid for a person graph');
  if (typeof query !== 'string' || countChars(query) > 200 || !Number.isSafeInteger(limit) || limit < 1 || limit > MEMORY_GRAPH_LIMITS.nodes || !Number.isSafeInteger(edgeLimit) || edgeLimit < 1 || edgeLimit > MEMORY_GRAPH_LIMITS.edges) throw new SchemaError('Graph query or display budget is invalid');
  if (input.seedRecordKey !== undefined) parseGraphRecordKey(input.seedRecordKey);
  if (input.sourceRef !== undefined && (!object(input.sourceRef) || Object.keys(input.sourceRef).some(key => !['sourceSessionId','sourceEventId'].includes(key)) ||
    ['sourceSessionId','sourceEventId'].some(key => typeof input.sourceRef[key] !== 'string' || !input.sourceRef[key] || countChars(input.sourceRef[key]) > 512))) throw new SchemaError('Invalid explicit graph source reference');
  const types = input.recordTypes ?? MEMORY_GRAPH_TYPES;
  if (!Array.isArray(types) || types.length > MEMORY_GRAPH_TYPES.length || types.some(type => !MEMORY_GRAPH_TYPES.includes(type))) throw new SchemaError('Unknown graph record type');
  return { ...input, scope, personId: scope === 'person' ? input.personId : null, query, limit, edgeLimit, recordTypes: [...new Set(types)] };
}
export const graphScopeAllows = (row, options) => options.scope === 'person' ? row.scope === 'person' && row.personId === options.personId
  : options.scope === 'unknown' ? row.scope === 'staging' && row.personId === null : row.scope === 'global' && row.personId === null;

/** Extract only existing typed rows. No inference, embedding or personality mutation. */
export function graphDocumentRows(relative, document, maximum) {
  if (!object(document) || document.schemaVersion !== SCHEMA_VERSION) throw graphError('MEMORY_GRAPH_DOCUMENT_INVALID', 'Graph document has an unsupported format');
  const rows = []; let visited = 0, truncated = false;
  const put = (values, recordType, persona = false) => {
    if (!Array.isArray(values)) throw graphError('MEMORY_GRAPH_DOCUMENT_INVALID', 'Graph document list is unavailable');
    for (const value of values) {
      if (visited >= maximum) { truncated = true; break; } visited++;
      if (!object(value) || typeof value.id !== 'string' || !value.id || countChars(value.id) > 200) throw graphError('MEMORY_GRAPH_DOCUMENT_INVALID', 'Graph record identity is invalid');
      const row = { ...value, recordType, ...(persona && value.scope === undefined && value.personId == null ? { scope:'global',personId:null } : {}) };
      if (!['person','global'].includes(row.scope) || row.scope === 'person' && (typeof row.personId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(row.personId)) || row.scope === 'global' && row.personId !== null) throw graphError('MEMORY_GRAPH_DOCUMENT_INVALID', 'Graph record subject is invalid');
      rows.push(row);
    }
  };
  if (relative === 'self/persona.json') for (const [field,type] of [['facets','facet'],['signatures','signature'],['habits','habit']]) put(document[field],type,true);
  else if (relative.endsWith('/impression.json')) { put(document.signatures,'relation_signature'); put(document.events,'relation_event'); }
  else put(document.items, relative === 'global/deep.json' ? 'deep' : relative.endsWith('/codes.json') ? 'code' : relative.endsWith('/pending.json') ? 'interpretation' : 'memory');
  return { rows, visited, truncated };
}
const linkFields = Object.freeze([['relatedMemoryIds','related'],['expandIds','expands'],['supersedesIds','supersedes'],['replacementIds','replaces'],['timeline.relatedMemoryIds','related']]);
const refList = row => {
  if(row.recordType==='chat')return [{sourceSessionId:row.sourceSessionId,sourceEventId:row.sourceEventId}];
  if(!Array.isArray(row.srcRefs))throw graphError('MEMORY_GRAPH_DOCUMENT_INVALID','Graph source references are invalid');return row.srcRefs;
};
const narrative = row => [row.title,row.reference,row.label,row.text,row.desc,row.meaning,row.if,row.then,row.experience,row.feltThen,row.meaningNow,
  ...['title','background','process','outcome','details','feltThen','meaningNow'].map(key=>row.timeline?.[key]),...(row.keys??[]),...(row.cues??[])].filter(v=>typeof v==='string').join(' ');

/** Pure, detached, bounded view of selected real records and their recorded links. */
export function projectMemoryGraph({ rows, options: rawOptions = {}, meta, catalogueComplete = true, sourceIdentities = [], metadataIndexComplete = true, coverage = {}, readBudget = {}, revision = null }) {
  const options = validateMemoryGraphInput(rawOptions), revokedIds = new Set(meta.revokedIds ?? []), revokedSources = new Set(meta.revokedSources ?? []);
  const eligible = rows.filter(row => graphScopeAllows(row,options) && !row.retractedBy && !revokedIds.has(row.id) && !refList(row).some(ref=>revokedSources.has(sourceKey(ref))));
  const byId = new Map(), byKey = new Map();
  for (const row of eligible) { const values=byId.get(row.id)??[]; values.push(row);byId.set(row.id,values); const key=retrievalRecordKey(row);byKey.set(key,[...(byKey.get(key)??[]),row]); }
  const unresolved={ambiguous:0,unavailable:0,unread:0,outOfScope:0}, reasons=new Set(coverage.reasons??[]);
  const originalById=new Map();for(const item of sourceIdentities)if(graphScopeAllows(item,options)){const values=originalById.get(item.id)??[];values.push(item.recordKey);originalById.set(item.id,values);}
  if(options.seedRecordKey!==undefined&&sourceIdentities.filter(item=>item.recordKey===options.seedRecordKey&&graphScopeAllows(item,options)).length>1)throw graphError('MEMORY_RECORD_AMBIGUOUS','The selected original has more than one source identity');
  const resolveId = id => {
    if(!catalogueComplete||!metadataIndexComplete){unresolved.unread++;return null;}
    const values=byId.get(id)??[], identities=new Set([...(originalById.get(id)??[]),...values.map(retrievalRecordKey)]);
    if(values.length>1||identities.size>1||(originalById.get(id)?.length??0)>1){unresolved.ambiguous++;return null;}
    if(values.length!==1){unresolved.unavailable++;return null;}return values[0];
  };
  let candidates=eligible.filter(row=>options.recordTypes.includes(row.recordType));
  if(options.seedRecordKey!==undefined){const seed=byKey.get(options.seedRecordKey)??[];
    if(seed.length>1)throw graphError('MEMORY_RECORD_AMBIGUOUS','The selected graph record is ambiguous');
    if(!seed.length){candidates=[];reasons.add('seed_not_loaded');}
    else {const selected=new Set([options.seedRecordKey]);if(seed[0].recordType==='chat')for(const row of eligible)if(row.recordType==='chat')selected.add(retrievalRecordKey(row));for(const[field]of linkFields){const ids=field.startsWith('timeline.')?seed[0].timeline?.relatedMemoryIds:seed[0][field];for(const id of (Array.isArray(ids)?ids:[]).slice(0,MEMORY_GRAPH_LIMITS.linksPerRecord)){const row=resolveId(id);if(row)selected.add(retrievalRecordKey(row));}}
      candidates=candidates.filter(row=>selected.has(retrievalRecordKey(row)));}
  }
  if(options.query){const query=options.query.toLocaleLowerCase();candidates=candidates.filter(row=>narrative(row).toLocaleLowerCase().includes(query));}
  candidates.sort((a,b)=>Number(retrievalRecordKey(b)===options.seedRecordKey)-Number(retrievalRecordKey(a)===options.seedRecordKey)||(b.updatedAt??b.createdAt??b.sourceAt??0)-(a.updatedAt??a.createdAt??a.sourceAt??0)||retrievalRecordKey(a).localeCompare(retrievalRecordKey(b)));
  const nodes=[],edges=[],nodeMap=new Map(),edgeIds=new Set(),omittedNodeIds=new Set();let omittedEdges=0;
  const addNode=node=>{if(nodeMap.has(node.id))return true;if(nodes.length>=options.limit){omittedNodeIds.add(node.id);return false;}nodes.push(node);nodeMap.set(node.id,node);return true;};
  const addEdge=(source,target,kind,basis)=>{const id=sha(JSON.stringify([source,target,kind,basis]));if(edgeIds.has(id))return;if(!nodeMap.has(source)||!nodeMap.has(target))return;if(edges.length>=options.edgeLimit){omittedEdges++;return;}edgeIds.add(id);edges.push({id,source,target,kind,basis});};
  const selected=[];
  for(const row of candidates){const key=retrievalRecordKey(row);if((byKey.get(key)??[]).length>1){unresolved.ambiguous++;continue;}
    const label=row.timeline?.title||row.title||row.label||(row.recordType==='chat'?'交流原件':row.text||row.desc||row.reference||row.meaning||row.if)||row.id;
    if(addNode({id:key,kind:'record',recordKey:key,recordId:row.id,recordType:row.recordType,scope:row.scope,personId:row.personId,
      label:short(label,MEMORY_GRAPH_LIMITS.labelChars),preview:row.recordType==='chat'?'':short(row.text||row.desc||row.reference||row.meaning||row.if,MEMORY_GRAPH_LIMITS.previewChars),
      role:['user','assistant'].includes(row.role)?row.role:null,origin:['user','ai_reply','ai_initiated'].includes(row.origin)?row.origin:null,
      speakerId:typeof row.speakerId==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(row.speakerId)?row.speakerId:null,
      createdAt:time(row.createdAt??row.sourceAt),updatedAt:time(row.updatedAt),sourceAt:time(row.sourceAt),tier:['recent','long_term','archive'].includes(row.tier)?row.tier:null,sourceCount:refList(row).length,
      ...(row.recordType==='chat'&&[row.sourceSessionId,row.sourceEventId].every(v=>typeof v==='string'&&countChars(v)<=512)?{sourceRef:{sourceSessionId:row.sourceSessionId,sourceEventId:row.sourceEventId}}:{})}))selected.push(row);}
  const people=new Set(meta.personIds??[]);
  const addSession=(from,ref)=>{const id='session:'+JSON.stringify(ref.sourceSessionId);if(addNode({id,kind:'session',sourceSessionId:ref.sourceSessionId,label:'会话 · '+short(ref.sourceSessionId,32)}))addEdge(from,id,'source_session',{field:'sourceSessionId',sourceSessionId:ref.sourceSessionId});};
  for(const row of selected){const key=retrievalRecordKey(row);let used=0;
    for(const[field,kind]of linkFields){const ids=field.startsWith('timeline.')?row.timeline?.relatedMemoryIds:row[field];for(const id of Array.isArray(ids)?ids:[]){if(++used>MEMORY_GRAPH_LIMITS.linksPerRecord){reasons.add('record_link_limit');break;}const target=resolveId(id);if(target)addEdge(key,retrievalRecordKey(target),kind,{field,recordKey:key,targetId:id});}}
    for(const ref of refList(row)){if(++used>MEMORY_GRAPH_LIMITS.linksPerRecord){reasons.add('record_link_limit');break;}if(!object(ref)||['sourceSessionId','sourceEventId'].some(field=>typeof ref[field]!=='string'||!ref[field]||countChars(ref[field])>512)){unresolved.unavailable++;reasons.add('source_identity_unavailable');continue;}const sk=sourceKey(ref);if(revokedSources.has(sk))continue;
      const receipt=meta.sources?.[sk];if(!receipt||typeof receipt.id!=='string'||countChars(receipt.id)>200){unresolved.unread++;continue;}if(revokedIds.has(receipt.id))continue;
      if(row.recordType==='chat'){addSession(key,ref);continue;}
      const original=selected.find(item=>item.recordType==='chat'&&sourceKey(item)===sk);
      if(original){addEdge(key,retrievalRecordKey(original),'source',{field:'srcRefs',recordKey:key,sourceRef:{sourceSessionId:ref.sourceSessionId,sourceEventId:ref.sourceEventId}});continue;}
      const id='source:'+sk,sourceRef={sourceSessionId:ref.sourceSessionId,sourceEventId:ref.sourceEventId};
      if(addNode({id,kind:'source',label:'来源 · '+short(ref.sourceEventId,24),sourceRef,recordId:receipt.id,personId:receipt.personId??null,bodyLoaded:false})){addEdge(key,id,'source',{field:'srcRefs',recordKey:key,sourceRef});addSession(id,ref);}
    }
    const about=Array.isArray(row.aboutPersonIds)?row.aboutPersonIds:[];
    for(const personId of about){if(++used>MEMORY_GRAPH_LIMITS.linksPerRecord){reasons.add('record_link_limit');break;}if(!people.has(personId)){unresolved.unavailable++;continue;}const id='person:'+personId;
      if(addNode({id,kind:'person',personId,label:short(personId,80)}))addEdge(key,id,'about_person',{field:'aboutPersonIds',recordKey:key,personId});}
  }
  if(omittedNodeIds.size)reasons.add('node_limit');if(omittedEdges)reasons.add('edge_limit');if(Object.values(unresolved).some(value=>value>0))reasons.add('unresolved_links');
  const result={format:'persona-memory-graph/1',referenceOnly:true,automaticRecall:false,revision,nodes,edges,
    coverage:{...coverage,scope:options.scope,personId:options.personId,entireStoreRead:false,total:null,catalogueComplete,
      metadataIndexComplete,candidateRecords:eligible.length,matchingRecords:candidates.length,recordNodesShown:selected.length,nodesShown:nodes.length,edgesShown:edges.length,
      omittedNodes:omittedNodeIds.size,omittedEdges,unresolvedLinks:unresolved,truncated:!catalogueComplete||!metadataIndexComplete||reasons.size>0,reasons:[...reasons]},readBudget:{...MEMORY_GRAPH_LIMITS,...readBudget}};
  while(Buffer.byteLength(JSON.stringify(result))>MEMORY_GRAPH_LIMITS.responseBytes&&(edges.length||nodes.length)){
    if(edges.length){edges.pop();result.coverage.omittedEdges++;}
    else{nodes.pop();result.coverage.omittedNodes++;}
    result.coverage.truncated=true;result.coverage.reasons=[...new Set([...result.coverage.reasons,'response_byte_limit'])];
  }
  result.coverage.recordNodesShown=nodes.filter(node=>node.kind==='record').length;result.coverage.nodesShown=nodes.length;result.coverage.edgesShown=edges.length;
  return result;
}
