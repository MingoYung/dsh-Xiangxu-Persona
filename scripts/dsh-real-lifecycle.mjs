import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { optionsFrom, prepareProfile } from './dsh-integration.mjs';

// Importing the earlier harness does not run its guarded main. Its fixture,
// scenarios and model outputs are never invoked by this independent runner.
const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const clean=s=>String(s).replace(/\b(?:sk|key)-[A-Za-z0-9_-]{12,}\b/g,'[redacted-key]').replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi,'$1[redacted]').replace(/((?:api[_-]?key|access[_-]?token|authorization)\s*[=:]\s*["']?)[^\s,"'}]+/gi,'$1[redacted]');
const safe=x=>JSON.parse(clean(JSON.stringify(x)));
const json=async p=>{try{return JSON.parse(await readFile(p,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const lines=async p=>{try{return (await readFile(p,'utf8')).split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
const text=m=>(m?.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
const summaryError=e=>safe({code:e.code??'UNKNOWN',message:e.message,data:e.data??null});

const observerSource=String.raw`
import {appendFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
export const inject=['llm','agentDefaultModel','personaMemory'];
export function apply(ctx,config){
  mkdirSync(config.artifacts,{recursive:true});
  const save=(name,value)=>appendFileSync(join(config.artifacts,name),JSON.stringify(value,(k,v)=>k==='signal'?undefined:v)+'\n');
  let wrapped=false,actualDispatches=0;
  const observedRuntimes=new WeakSet();
  const observeRuntime=coordinator=>{
    const runtime=coordinator.runtime;if(!runtime||observedRuntimes.has(runtime))return;observedRuntimes.add(runtime);
    const original=runtime.handleSignal;
    runtime.handleSignal=async function(...args){
      const id='signal_'+randomUUID(),before=this.state;
      save('runtime-signals.jsonl',{id,phase:'before',at:Date.now(),observedSignal:args[0],context:args[1],sleep:before?.sleep,schedule:before?.schedule,currentDecision:before?.currentDecision,activeRunId:before?.activeRunId,execution:before?.execution});
      try{const result=await original.apply(this,args);save('runtime-signals.jsonl',{id,phase:'after',at:Date.now(),observedSignal:args[0],sleep:this.state?.sleep,activeRunId:this.state?.activeRunId,result});return result;}
      catch(error){save('runtime-signals.jsonl',{id,phase:'error',at:Date.now(),observedSignal:args[0],sleep:this.state?.sleep,error:{code:error.code,message:error.message}});throw error;}
    };
    const originalWake=runtime._wake;
    runtime._wake=async function(...args){
      const id='wake_'+randomUUID(),sleep=this.state?.sleep;
      save('runtime-wakes.jsonl',{id,phase:'before',at:Date.now(),context:args[0],sleep,currentDecision:this.state?.currentDecision,job:this.state?.execution?.consolidationJobs?.[sleep?.wakeJobId]});
      try{const result=await originalWake.apply(this,args);save('runtime-wakes.jsonl',{id,phase:'after',at:Date.now(),context:args[0],sleep:this.state?.sleep,result});return result;}
      catch(error){save('runtime-wakes.jsonl',{id,phase:'error',at:Date.now(),context:args[0],sleep:this.state?.sleep,error:{code:error.code,message:error.message}});throw error;}
    };
    ctx.on('dispose',()=>{runtime.handleSignal=original;runtime._wake=originalWake;});
  };
  const observe=()=>{
    if(wrapped)return;
    let registration;try{registration=ctx.llm.registration(config.provider);}catch{return;}
    const adapter=registration.adapter,original=adapter.prepareCall;
    if(typeof original!=='function')throw new Error('Real provider lacks prepareCall');
    adapter.prepareCall=async function(...args){
      const call=await original.apply(this,args),dispatch=call.stream.bind(call);
      return {...call,stream:options=>(async function*(){
        if(Number.isSafeInteger(config.maxActualDispatches)&&actualDispatches>=config.maxActualDispatches){save('dispatch-budget.jsonl',{at:Date.now(),actualDispatches,limit:config.maxActualDispatches,blockedBeforeProviderInvocation:true});throw Object.assign(new Error('Dedicated verification reached its actual dispatch budget; no further model request was sent'),{code:'TEST_DISPATCH_BUDGET'});}
        actualDispatches++;const requestId='real_'+randomUUID(),startedAt=Date.now();
        const messagesJson=JSON.stringify(options.messages??[]),toolsJson=JSON.stringify(options.tools??[]);
        save('provider-bound.jsonl',{kind:'actual-provider-adapter-input',requestId,startedAt,provider:options.provider,model:options.model,purpose:options.purpose,maxTokens:options.maxTokens,reasoningEffort:options.reasoningEffort,temperature:options.temperature,topP:options.topP,requestSize:{messagesJsonUtf8Bytes:Buffer.byteLength(messagesJson,'utf8'),messagesJsonCodePoints:Array.from(messagesJson).length,toolsJsonUtf8Bytes:Buffer.byteLength(toolsJson,'utf8'),tokenCount:null,accounting:'actual serialized adapter inputs; UTF-8 bytes/code points are not tokenizer counts or external HTTP wire size'},tools:options.tools,messages:options.messages});
        let usage=null,finish=null;
        try{for await(const chunk of dispatch(options)){
          save('provider-chunks.jsonl',{requestId,at:Date.now(),chunk});
          if(chunk.type==='usage')usage=chunk.usage;if(chunk.type==='finish')finish=chunk.reason;
          yield chunk;
        }}finally{save('provider-usage.jsonl',{requestId,startedAt,finishedAt:Date.now(),provider:options.provider,model:options.model,usage,finish});}
      })()};
    };
    if(adapter.prepareCall===original)throw new Error('Real provider observation wrapper was not installed');
    wrapped=true;process.stderr.write('PM_REAL_OBSERVER_READY '+JSON.stringify({provider:config.provider,model:config.model})+'\n');
    ctx.on('dispose',()=>{adapter.prepareCall=original;});
  };
  observeRuntime(ctx.get('personaMemory'));
  ctx.on('llm/adapters-updated',observe);observe();
  ctx.on('llm/stream',(options,next)=>{save('host-requests.jsonl',{at:Date.now(),provider:options.provider,model:options.model,tools:options.tools,messages:options.messages});return next();});
  ctx.on('agent/created',async({agent,source})=>{
    const presets=ctx.get('agentPresets');
    if(source==='resume')await presets.mount(agent.ctx,'persona-memory');else await presets.select(agent,'persona-memory');
    const coordinator=ctx.get('personaMemory');if(!coordinator)throw new Error('Missing persona coordinator');
    await coordinator.attachAgent(agent);observeRuntime(coordinator);
    const compaction=presets.serviceFor?.(agent,'compaction'),pruner=presets.serviceFor?.(agent,'toolResultPruner');
    const policyKeys=['thresholdRatio','headroomTokens','retainRatio','retainTokens','maxTokens','compactionRetries','maxOverflowRetries','modelPolicies','auto'];
    save('native-history-policy.jsonl',{at:Date.now(),sessionId:agent.session.id,preset:presets.composedPreset(agent.ctx),presetCompactionPresent:Boolean(compaction),presetPrunerPresent:Boolean(pruner),compactionConfig:compaction?Object.fromEntries(policyKeys.filter(key=>compaction.config?.[key]!==undefined).map(key=>[key,compaction.config[key]])):null,prunerConfig:pruner?.config??null,compositionIsolation:(presets.inspectCompositions?.(agent.ctx)??[]).map(row=>({id:row.id,leakedServices:row.leakedServices,modules:row.modules})),note:'Actual native preset service instances and resolved non-sensitive policies; presence alone does not prove a summary executed or a strict request cap.'});
    const query=ctx.get('sessionQuery',false);
    for(const source of config.sourceProbes??[])if(source.sessionId===agent.session.id){
      try{if(!query)throw new Error('No actual host sessionQuery');const result=await query.readEvent({sessionId:source.sessionId,seq:source.seq});const event=result.target,message=event.type==='assistant/message'?event.data.message:event.data;
        const value=(message?.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
        save('host-source-probes.jsonl',{at:Date.now(),request:source,available:true,eventType:event.type,seq:event.seq,messageId:message?.id,sourceKind:message?.source?.kind,sourceIdMatches:message?.id===source.sourceEventId,text:value,textSha256:createHash('sha256').update(value).digest('hex'),inheritedEventCount:result.inheritedEventCount});
      }catch(error){save('host-source-probes.jsonl',{at:Date.now(),request:source,available:false,error:{code:error.code,message:error.message}});}
    }
    // Only the dedicated validation scope hides unrelated coding tools. This
    // changes no production preset or personality decision/prohibition.
    agent.ctx.tools.restrict({allow:[]});
  });
}
`;

async function install(options){
  await prepareProfile(options);
}

class Engine{
  constructor(options,dir,root,overlay){
    this.options=options;this.dir=dir;this.root=root;this.frames=[];this.pending=new Map();this.counter=0;this.log=Promise.resolve();this.closed=false;this.ready=false;let out='',err='';
    this.child=spawn(options.exe,[options.cli,'--profile',options.profile,'--patch',overlay],{cwd:projectRoot,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',DSH_HOME:options.home,PERSONA_MEMORY_ROOT:root},stdio:['pipe','pipe','pipe']});
    this.child.stdout.setEncoding('utf8');this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data',chunk=>{out+=chunk;let i;while((i=out.indexOf('\n'))>=0){let s=out.slice(0,i);out=out.slice(i+1);this.consume(s);}});
    this.child.stderr.on('data',chunk=>{this.log=this.log.then(()=>appendFile(join(dir,'stderr.txt'),clean(chunk)));err+=chunk;let i;while((i=err.indexOf('\n'))>=0){let s=err.slice(0,i);err=err.slice(i+1);if(s.startsWith('PM_REAL_OBSERVER_READY '))this.ready=true;}});
    this.exit=new Promise(done=>this.child.once('close',(code,signal)=>{this.closed=true;for(let p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Owned SDK child closed'));}this.pending.clear();done({code,signal});}));
    this.child.once('error',e=>this.spawnError=e);
  }
  consume(s){let f;try{f=JSON.parse(s);}catch{return;}this.log=this.log.then(()=>appendFile(join(this.dir,'rpc.jsonl'),JSON.stringify(safe(f))+'\n'));if(f.id!==undefined){const p=this.pending.get(f.id);if(p){this.pending.delete(f.id);clearTimeout(p.timer);f.error?p.reject(Object.assign(new Error(clean(f.error.message)),{code:f.error.code,data:safe(f.error.data??null)})):p.resolve(f.result);}}else this.frames.push(f);}
  request(method,params={},timeout=180000){const id=++this.counter;this.log=this.log.then(()=>appendFile(join(this.dir,'client-requests.jsonl'),JSON.stringify(safe({jsonrpc:'2.0',id,method,params}))+'\n'));return new Promise((resolve,reject)=>{let timer=setTimeout(()=>{this.pending.delete(id);reject(Object.assign(new Error('RPC timeout: '+method),{code:'RPC_TIMEOUT'}));},timeout);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
  events(sid){return this.frames.filter(f=>f.method==='session.event'&&(!sid||f.params.sessionId===sid)).map(f=>({...f.params.event,sessionId:f.params.sessionId}));}
  async wait(fn,ms=120000){let end=Date.now()+ms;while(Date.now()<end){if(this.spawnError)throw this.spawnError;let v=await fn();if(v)return v;if(this.closed)throw new Error('SDK child exited while observing');await pause(50);}return null;}
  async prompt(sid,content){const before=this.events(sid).length,receipt=await this.request('session/prompt',{sessionId:sid,contentBlocks:[{type:'text',text:content}]});await this.request('session/wait',{sessionId:sid});const failure=this.events(sid).slice(before).find(x=>x.type==='turn/end'&&x.data.reason?.kind==='error');if(failure)throw Object.assign(new Error(failure.data.reason.error?.message??'Native model turn failed'),{code:failure.data.reason.error?.code??'NATIVE_TURN_ERROR',data:failure.data.reason});return receipt;}
  async close(){if(this.closed){await this.log;return this.exit;}try{await this.request('shutdown',{},15000);}catch{}this.child.stdin.end();let timer;const r=await Promise.race([this.exit,new Promise(done=>{timer=setTimeout(()=>done(null),15000);})]);clearTimeout(timer);if(!r){this.child.kill();await this.exit;}await this.log;return r??this.exit;}
}
async function start(options,dir,memoryRoot){
  await mkdir(dir,{recursive:true});const observer=join(options.artifacts,'real-observer.mjs');await writeFile(observer,observerSource);
  const overlay=join(dir,'overlay.yml');await writeFile(overlay,JSON.stringify([{id:'tools',config:{mode:'native'}},{insert:[{id:'agent-preset-registry',name:'@deepseek-ai/dsh-agent-preset-registry',config:{default:'persona-memory'}},{id:'persona-real-observer',name:pathToFileURL(observer).href,config:{artifacts:dir,provider:options.provider,model:options.model,sourceProbes:options.sourceProbes??[],maxActualDispatches:options.maxActualDispatches??null}}]}],null,2));
  const e=new Engine(options,dir,memoryRoot,overlay);if(!await e.wait(()=>e.ready,30000))throw new Error('Real provider observation did not become ready; no model prompt sent');
  await e.request('initialize',{cwd:projectRoot,provider:options.provider,model:options.model,maxTokens:4096});return e;
}
async function operator(options,memoryRoot,command,value,dir,waitOverride){
  const waitMs=waitOverride??(command==='consolidate'?180000:30000);
  const args=[join(projectRoot,'scripts','persona-cli.mjs'),'--root',memoryRoot,'--wait-ms',String(waitMs),command,...(value===undefined?[]:[JSON.stringify(value)])];
  const c=spawn(process.execPath,args,{cwd:projectRoot,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';c.stdout.on('data',x=>stdout+=x);c.stderr.on('data',x=>stderr+=x);
  let code=await new Promise((done,reject)=>{let timer=setTimeout(()=>{c.kill();reject(new Error('Operator timeout; outcome unknown and not retried'));},waitMs+10000);c.once('error',reject);c.once('close',n=>{clearTimeout(timer);done(n);});});let response;try{response=JSON.parse(stdout);}catch{response={unparsed:clean(stdout)};}
  await appendFile(join(dir,'operator.jsonl'),JSON.stringify(safe({at:Date.now(),command,value,code,response,stderr}))+'\n');if(code!==0||!response.ok)throw Object.assign(new Error('Operator failed: '+command),{code:'OPERATOR_FAILED',data:response});return response;
}
async function hashes(){let paths=[];for(let dir of ['core','adapters/dsh'])for(let f of await readdir(join(projectRoot,dir)))if(f.endsWith('.js'))paths.push(dir+'/'+f);paths.push('package.json','cordis.patch.yml','scripts/dsh-real-lifecycle.mjs','scripts/dsh-integration.mjs','scripts/persona-cli.mjs');return Object.fromEntries(await Promise.all(paths.sort().map(async p=>[p,createHash('sha256').update(await readFile(join(projectRoot,p))).digest('hex')])));}
async function snapshot(memoryRoot,destination){
  const startedAt=Date.now(),skipped=[];await mkdir(destination,{recursive:true});
  const copy=async(relative='')=>{
    let entries;try{entries=await readdir(join(memoryRoot,relative),{withFileTypes:true});}catch(error){if(error.code==='ENOENT'){skipped.push({path:relative,reason:'disappeared_during_copy'});return;}throw error;}
    await mkdir(join(destination,'memory-snapshot',relative),{recursive:true});
    for(const entry of entries){const next=join(relative,entry.name);if(entry.name==='.wal'||entry.name==='.lock'||entry.name.endsWith('.tmp')||entry.name.endsWith('.next')){skipped.push({path:next,reason:'transient_transaction_or_lock'});continue;}
      if(entry.isDirectory())await copy(next);else if(entry.isFile())try{await writeFile(join(destination,'memory-snapshot',next),await readFile(join(memoryRoot,next)));}catch(error){if(error.code==='ENOENT')skipped.push({path:next,reason:'disappeared_during_copy'});else throw error;}
    }
  };await copy();await writeFile(join(destination,'snapshot.json'),JSON.stringify({startedAt,finishedAt:Date.now(),atomicWholeRoot:false,skipped,note:'Static copies of individually atomic files, excluding transient WAL/lock/temp entries; commit markers and source IDs permit consistency review.'},null,2));
}
async function runs(root){const dir=join(root,'journal','runs');return (await Promise.all((await readdir(dir).catch(()=>[])).filter(f=>f.endsWith('.json')).map(f=>json(join(dir,f))))).filter(Boolean);}
async function chatRecords(root){
  const rows=await lines(join(root,'staging','events.jsonl'));
  for(const entry of await readdir(join(root,'people'),{withFileTypes:true}).catch(()=>[]))if(entry.isDirectory())rows.push(...await lines(join(root,'people',entry.name,'stream.jsonl')));
  return rows;
}
async function drainModelWork(engine,root){
  let stableSince=null;
  while(true){
    const drained=await engine.wait(async()=>{const active=(await json(join(root,'global','state.json')))?.activeRunId;if(active){stableSince=null;return false;}stableSince??=Date.now();return Date.now()-stableSince>=500;},60000);
    if(drained)return;
    process.stdout.write(JSON.stringify({observingExistingModelWork:true,activeRunId:(await json(join(root,'global','state.json')))?.activeRunId??null,noAdditionalPromptDispatched:true})+'\n');
  }
}
const unknownWakeSources=['56e20119-f2bc-4ccb-a724-1494b532f3f4','be6f3801-ee5e-458b-93b2-f79ad3c88aaf'];
async function traceUnknownSources(root,engineDir){
  const all=await chatRecords(root),runList=await runs(root),requests=await lines(join(engineDir,'provider-bound.jsonl'));
  const records=unknownWakeSources.map(sourceEventId=>{const row=all.find(x=>x.sourceEventId===sourceEventId);return row?{id:row.id,eventId:row.eventId,sourceSessionId:row.sourceSessionId,sourceEventId,personId:row.personId,role:row.role,sourceKind:row.sourceKind,origin:row.origin,textChars:row.text?.length??0,textSha256:createHash('sha256').update(row.text??'').digest('hex')}: {sourceEventId,missing:true};});
  const directRoots=value=>{let found=[];if(value&&typeof value==='object'){if(typeof value.sourceEventId==='string'&&unknownWakeSources.includes(value.sourceEventId))found.push({sourceEventId:value.sourceEventId,sourceSessionId:value.sourceSessionId??null});for(const item of Object.values(value))if(item&&typeof item==='object')found.push(...directRoots(item));}return found;};
  const providerInputs=requests.flatMap(request=>request.messages.filter(m=>m.role==='user').flatMap(message=>(message.content??[]).filter(c=>c.type==='text').flatMap(content=>{let payload;try{payload=JSON.parse(content.text);}catch{return [];}const references=directRoots(payload);return references.length?[{requestId:request.requestId,startedAt:request.startedAt,payloadKeys:Object.keys(payload),runId:payload.runId??payload.input?.runId??null,references,payload}]:[];})));
  const relatedRuns=runList.flatMap(run=>{const slices=(run.inputSlices??[]).filter(slice=>records.some(r=>r.id&&slice.key==='chat:'+r.id));const patchRefs=directRoots(run.validatedPatch??[]);return slices.length||patchRefs.length?[{runId:run.runId,status:run.status,inputEndEventId:run.inputEndEventId,inputSlices:slices,commitMarker:run.commitMarker??null,patchRefs,validatedPatch:run.validatedPatch??null}]:[];});
  return {at:Date.now(),records,providerInputs,relatedRuns,consolidationCursors:(await json(join(root,'global','state.json')))?.consolidationCursors,note:'Direct structured references and full input payloads are retained for review. A reference inside a cached tool result is not automatically a direct selected C1 input, nor proof of a committed memory. Unknown assistant text remains assistant/unknown unless an actual identity operation selects it.'};
}
async function observeRuntimeFiles(root,destination){
  let stopped=false,lastState='',seenRuns=new Map(),failure=null,lastProgress=Date.now();await mkdir(destination,{recursive:true});
  const work=(async()=>{while(!stopped){try{
    const state=await json(join(root,'global','state.json'));if(state){const encoded=JSON.stringify(state);if(encoded!==lastState){lastState=encoded;await appendFile(join(destination,'runtime-state-trace.jsonl'),JSON.stringify({at:Date.now(),state})+'\n');}}
    for(const run of await runs(root)){const encoded=JSON.stringify(run);if(seenRuns.get(run.runId)!==encoded){seenRuns.set(run.runId,encoded);await appendFile(join(destination,'consolidation-run-trace.jsonl'),JSON.stringify({at:Date.now(),run})+'\n');}}
    if(Date.now()-lastProgress>=60000){lastProgress=Date.now();process.stdout.write(JSON.stringify({observingWakeMode:true,sleep:state?.sleep,activeRunId:state?.activeRunId,runCount:seenRuns.size,noExtraModelPrompt:true})+'\n');}
  }catch(error){failure=summaryError(error);break;}await pause(50);}})();
  return {stop:async()=>{stopped=true;await work;return {failure,runCount:seenRuns.size};}};
}
const visible=events=>events.filter(e=>e.type==='assistant/message'&&text(e.data.message)).map(e=>({sessionId:e.sessionId,seq:e.seq,time:e.time,turn:e.data.turn,text:text(e.data.message)}));
const toolCalls=events=>events.filter(e=>e.type==='tool/call').map(e=>({sessionId:e.sessionId,seq:e.seq,time:e.time,data:e.data}));
function recoveredCursorFeedback(errors,events){
  const value=e=>{try{return JSON.parse(text(e.data.message));}catch{return null;}};
  return errors.filter(error=>['TOOL_CURSOR_EXPIRED','INVALID_TOOL_CURSOR'].includes(error.code)).flatMap(error=>{
    const failed=events.find(e=>e.type==='tool/result'&&value(e)?.code===error.code&&Math.abs(e.time-error.at)<2000);
    const origin=failed&&events.find(e=>e.type==='tool/call'&&e.sessionId===failed.sessionId&&e.data.callId===failed.data.message.toolCallId);
    if(!origin||!['memory_search','persona_introspect'].includes(origin.data.name))return [];
    const retried=events.find(e=>{
      if(e.type!=='tool/call'||e.sessionId!==origin.sessionId||e.seq<=origin.seq||e.data.name!==origin.data.name)return false;
      let args;try{args=JSON.parse(e.data.arguments);}catch{return false;}if(args.cursor)return false;
      return events.some(r=>r.type==='tool/result'&&r.sessionId===e.sessionId&&r.data.message.toolCallId===e.data.callId&&!r.data.message.isError&&value(r)?.status!=='memory_error');
    });
    return retried?[{error,rejectedCallId:origin.data.callId,freshCallId:retried.data.callId,sessionId:origin.sessionId}]:[];
  });
}

export async function runRealLifecycle(argv=process.argv.slice(2)){
  const option=(name,fallback)=>{const i=argv.indexOf(name);return i<0?fallback:argv[i+1];};
  const defaults=optionsFrom([],process.env),base=resolve(option('--artifacts',join(projectRoot,'work','persona-real-validation')));
  const options={...defaults,profile:'persona-memory-real-validation',provider:'deepseek-official',model:'deepseek-flash',artifacts:base};
  await mkdir(base,{recursive:true});if(!existsSync(options.exe))throw new Error('Installed DSH executable missing');
  const priorArg=argv.includes('--resume-dir')?resolve(option('--resume-dir')):null;
  const withinBase=path=>{const rel=relative(base,path);return rel!==''&&!rel.startsWith('..')&&!isAbsolute(rel);};
  if(priorArg&&!withinBase(priorArg))throw new Error('Resume evidence directory must stay inside this dedicated validation root');
  const prior=priorArg?await json(join(priorArg,'result.json')):null;
  if((argv.includes('--wake-modes-only')||argv.includes('--native-policy-probe-only')||argv.includes('--recover-completed-wake-job'))&&(!prior?.sessions?.A2||!prior?.sessions?.B2))throw new Error('Wake continuation requires the completed isolated A2/B2 state');
  if(priorArg&&(!prior?.memoryRoot||!prior.sessions?.A||!prior.sessions?.B))throw new Error('Resume result lacks the isolated memory/session identities');
  const runId=(prior?'continuation-':'run-')+Date.now()+'-'+randomUUID().slice(0,8),dir=join(base,runId),memoryRoot=prior?.memoryRoot??join(dir,'memory');await mkdir(dir,{recursive:true});
  if(!withinBase(resolve(memoryRoot)))throw new Error('The memory root must stay inside this dedicated validation evidence root');
  options.artifacts=dir;options.maxActualDispatches=argv.includes('--read-long-source-only')?8:null;
  const priorChat=prior?await chatRecords(memoryRoot):[];
  options.sourceProbes=priorChat.filter(row=>unknownWakeSources.includes(row.sourceEventId)&&Number.isSafeInteger(row.sourceCursor)).map(row=>({sessionId:row.sourceSessionId,seq:row.sourceCursor,sourceEventId:row.sourceEventId}));
  if(priorArg)for(const entry of await readdir(priorArg,{withFileTypes:true}))if(entry.isDirectory()&&entry.name.startsWith('engine-')){
    for(const frame of await lines(join(priorArg,entry.name,'rpc.jsonl'))){const event=frame.params?.event;if(event?.type!=='compaction/summary')continue;
      const shadowed=new Set(event.data.shadowedSeqs??[]),eligible=priorChat.filter(row=>row.sourceSessionId===frame.params.sessionId&&Number.isSafeInteger(row.sourceCursor)&&shadowed.has(row.sourceCursor));
      for(const role of ['user','assistant']){const row=eligible.find(row=>row.role===role);if(row&&!options.sourceProbes.some(probe=>probe.sourceEventId===row.sourceEventId))options.sourceProbes.push({sessionId:row.sourceSessionId,seq:row.sourceCursor,sourceEventId:row.sourceEventId,expectedTextSha256:createHash('sha256').update(row.text??'').digest('hex'),reason:'raw_after_actual_native_compaction',compactionSummarySeq:event.seq,compactionEvidence:join(priorArg,entry.name,'rpc.jsonl')});}
    }
  }
  const report={runId,startedAt:new Date().toISOString(),route:{provider:options.provider,model:options.model},profile:options.profile,memoryRoot,sourceDigests:await hashes(),phases:[],claims:{realDshEngine:true,allModelCallsRealProvider:true,externalHttpWire:false,spontaneousLongTermPersonalityProven:false},testInputs:'Synthetic participants and experiences for the explicitly authorized lifecycle validation.'};
  report.observerSha256=createHash('sha256').update(observerSource).digest('hex');
  if(prior)report.priorRun={directory:priorArg,status:prior.status,error:prior.error,modelAttemptCount:prior.modelAttemptCount,usageTotals:prior.usageTotals,earlier:prior.priorRun,note:'Same memory and participant sessions; earlier experiences are preserved and not resent. Prior failures are not counted as passes.'};
  const startPhase=argv.includes('--start-phase')?Number(argv[argv.indexOf('--start-phase')+1]):prior?2:1;
  report.startPhase=startPhase;if(!Number.isInteger(startPhase)||startPhase<1||startPhase>9)throw new Error('start-phase must be 1..9');
  report.beforeStartupRuntime=prior?await json(join(memoryRoot,'global','state.json')):null;
  await writeFile(join(dir,'manifest.json'),JSON.stringify(report,null,2));await install(options);
  let e=await start(options,join(dir,'engine-1'),memoryRoot),engineDirs=[e.dir];
  const A=prior?.sessions.A??'persona_real_A_'+randomUUID().replaceAll('-',''),B=prior?.sessions.B??'persona_real_B_'+randomUUID().replaceAll('-','');report.sessions={...(prior?.sessions??{}),A,B};
  const phase=async(name,fn)=>{let start=Date.now(),index=e.frames.length;const path=join(dir,'stages',name);await mkdir(path,{recursive:true});let p={name,startedAt:start,sourceDigests:await hashes()};try{
    const baseline=await operator(options,memoryRoot,'status',undefined,dir);p.hostErrorsBefore=baseline.result?.errors??[];p.effectFailuresBefore=baseline.result?.runtime?.execution?.effectFailures??[];
    p.result=await fn();const health=await operator(options,memoryRoot,'status',undefined,dir);p.hostErrors=health.result?.errors??[];p.effectFailuresAfter=health.result?.runtime?.execution?.effectFailures??[];
    const old=new Set(p.hostErrorsBefore.map(x=>JSON.stringify(x)));p.newHostErrors=p.hostErrors.filter(x=>!old.has(JSON.stringify(x)));
    const observedEvents=e.frames.slice(index).filter(f=>f.method==='session.event').map(f=>({...f.params.event,sessionId:f.params.sessionId}));
    p.recoveredProtocolErrors=recoveredCursorFeedback(p.newHostErrors,observedEvents);
    p.unresolvedHostErrors=p.newHostErrors.filter(error=>!p.recoveredProtocolErrors.some(r=>JSON.stringify(r.error)===JSON.stringify(error)));
    const invalidOutput=observedEvents.filter(event=>event.type==='tool/result'&&event.data.error?.code==='INVALID_TOOL_OUTPUT');
    if(p.unresolvedHostErrors.length||invalidOutput.length)throw Object.assign(new Error('Host reported a new execution fault; further stages stopped'),{code:'HOST_EXECUTION_FAULT',data:{unresolvedHostErrors:p.unresolvedHostErrors,invalidOutput}});
    p.status=p.result?.observed===false?'not_observed':p.recoveredProtocolErrors.length?'completed_with_protocol_recovery':'completed';
  }catch(error){p.status='technical_failure';p.error=summaryError(error);throw error;}finally{p.finishedAt=Date.now();p.visible=visible(e.frames.slice(index).filter(f=>f.method==='session.event').map(f=>({...f.params.event,sessionId:f.params.sessionId})));p.toolCalls=toolCalls(e.frames.slice(index).filter(f=>f.method==='session.event').map(f=>({...f.params.event,sessionId:f.params.sessionId})));await writeFile(join(path,'result.json'),JSON.stringify(safe(p),null,2));report.phases.push(p);await writeFile(join(dir,'progress.json'),JSON.stringify(safe(report),null,2));await snapshot(memoryRoot,path);process.stdout.write(JSON.stringify({phase:name,status:p.status,observed:p.result?.observed,awakened:p.result?.awakened,personalityChanged:p.result?.personalityChanged,nonemptyCommits:p.result?.nonemptyCommits,error:p.error})+'\n');}};
  try{
    if(prior){
      const known=(await json(join(memoryRoot,'host-checkpoints.json')))?.sessions??{};
      for(const id of (argv.includes('--read-long-source-only')?[report.sessions.B2]:argv.includes('--recover-completed-wake-job')?[]:((argv.includes('--wake-modes-only')||argv.includes('--native-policy-probe-only'))?[report.sessions.A2,report.sessions.B2]:[A,B,...(startPhase>=7?[report.sessions.A2,report.sessions.B2]:[])])).filter(Boolean))if(Object.hasOwn(known,id))await e.request('session/resume',{sessionId:id});
      await snapshot(memoryRoot,join(dir,'preserved-initial-memory'));
    }
    else await phase('01-natural-experience',async()=>{
      const input='我是林岚。今天在河堤上陪父亲慢慢走了一圈，他说“慢一点也算一起向前”。我这阵子偏爱海盐燕麦粥，聊天时喜欢先听一句真实感受，再听建议。朋友以前拿“紫藤站台”叫我，我其实不喜欢这个外号。你听完有什么感觉？若你愿意，请用人格工具保存你对我是谁的判断；什么值得留下、你自己受到什么影响，由你决定。';
      const receipt=await e.prompt(A,input);await pause(300);const registry=await json(join(memoryRoot,'registry.json'));
      return {input,receipt,identityRoutes:registry?.items??[],observed:e.events(A).some(x=>x.type==='tool/call'&&JSON.stringify(x.data).includes('identityPlan'))};
    });
    if(argv.includes('--read-long-source-only')){
      await phase('14-read-long-assistant-source-tail',async()=>{
        const {B2}=report.sessions,sourceEventId=unknownWakeSources[0],original=(await chatRecords(memoryRoot)).find(row=>row.sourceEventId===sourceEventId);
        if(!original||original.role!=='assistant'||Array.from(original.text).length!==632)throw new Error('Expected preserved original 632-character assistant C1 source');
        const originalSha256=createHash('sha256').update(original.text).digest('hex'),index=e.events(B2).length;
        const input='周闻只补完长原件读取：recordId='+original.id+'，sourceEventId='+sourceEventId+'，632字，上次只给0..295。请用memory_search(scope:all,query:只凭自己熟悉的印象,limit:10)取得本进程真实nextCursor，保留同参数带cursor连续读到该record.to=total且complete=true；旧进程cursor已失效。133字短件已完整，不重复睡眠/成长、不清旧积压、不抄全文。真实接口中personId是关系分区，归属不会改变assistant角色、speakerId或原话；完整读取后是否归属由你自己决定，不要求挂到周闻。只简短确认读全与否，没读到就直说；这次最多8个实际模型派发，不程序代读。';
        let receipt,error=null;try{receipt=await e.prompt(B2,input);}catch(failure){error=summaryError(failure);}
        const events=e.events(B2).slice(index),requests=await lines(join(e.dir,'provider-bound.jsonl')),fragments=[];
        for(const event of events.filter(event=>event.type==='tool/result')){let output;const message=event.data.message;try{output=JSON.parse(text(message));}catch{continue;}
          for(const item of output.items??[])if(item.id===original.id&&typeof item.text==='string'&&item.fragment){const nextRequest=requests.find(request=>request.startedAt>=event.time&&request.messages.some(row=>row.id===message.id&&text(row)===text(message)));
            fragments.push({resultSeq:event.seq,toolCallId:message.toolCallId,messageId:message.id,recordId:item.id,role:item.role,personId:item.personId,text:item.text,fragment:item.fragment,nextCursor:output.nextCursor??null,receivedByProviderRequestId:nextRequest?.requestId??null});}
        }
        const points=Array.from(original.text),assembled=new Array(points.length),conflicts=[];
        for(const item of fragments){const body=Array.from(item.text),span=item.fragment;if(body.length!==span.to-span.from||span.total!==points.length)conflicts.push({seq:item.resultSeq,reason:'range_length_or_total'});for(let offset=0;offset<body.length;offset++){const at=span.from+offset;if(assembled[at]!==undefined&&assembled[at]!==body[offset])conflicts.push({seq:item.resultSeq,at,reason:'overlap_disagrees'});assembled[at]=body[offset];}}
        const holes=[];for(let at=0;at<points.length;at++)if(assembled[at]===undefined)holes.push(at);
        const reconstructed=assembled.join(''),sha256=createHash('sha256').update(reconstructed).digest('hex'),finalComplete=fragments.some(item=>item.fragment.to===points.length&&item.fragment.complete===true),allReceived=fragments.length>0&&fragments.every(item=>item.receivedByProviderRequestId);
        const destination=join(dir,'source-tail-proof');await mkdir(destination,{recursive:true});await writeFile(join(destination,'actual-tool-fragments.json'),JSON.stringify(fragments,null,2));await writeFile(join(destination,'reconstructed-from-tool-results.txt'),reconstructed);
        const after=(await chatRecords(memoryRoot)).find(row=>row.id===original.id),observed=!error&&holes.length===0&&conflicts.length===0&&finalComplete&&allReceived&&reconstructed===original.text&&sha256===originalSha256;
        const result={input,receipt,error,sourceEventId,recordId:original.id,expectedChars:points.length,originalSha256,reconstructedSha256:sha256,fullTextDeepEqual:reconstructed===original.text,holes,conflicts,finalComplete,allFragmentsReceivedByNextProvider:allReceived,fragments:fragments.map(({text,...item})=>({...item,textChars:Array.from(text).length,textSha256:createHash('sha256').update(text).digest('hex')})),actualDispatchBudget:8,actualDispatchCount:requests.length,blockedDispatches:await lines(join(e.dir,'dispatch-budget.jsonl')),originalAfter:{role:after?.role,personId:after?.personId,textSha256:createHash('sha256').update(after?.text??'').digest('hex')},outputs:visible(events),observed,note:'Proof is reconstructed solely from actual tool-result source bodies and matched subsequent provider messages, never from this user prompt or a direct harness read injected as a tool answer.'};
        await writeFile(join(destination,'result.json'),JSON.stringify(safe(result),null,2));if(error&&!result.blockedDispatches.length)throw Object.assign(new Error('Actual tail-reading turn failed'),{code:error.code,data:error});return result;
      });
      report.status=report.phases.every(phase=>phase.status.startsWith('completed'))?'completed-long-source-tail':'partial-long-source-tail';return report;
    }
    if(argv.includes('--native-policy-probe-only')){
      await phase('00-native-history-policy-probe',async()=>{
        const policies=await lines(join(e.dir,'native-history-policy.jsonl')),sourceProbes=await lines(join(e.dir,'host-source-probes.jsonl'));
        const nativePresetReady=[report.sessions.A2,report.sessions.B2].every(sessionId=>policies.some(row=>row.sessionId===sessionId&&row.preset==='persona-memory'&&row.presetCompactionPresent&&row.presetPrunerPresent&&row.compactionConfig?.maxTokens===4096&&row.compactionConfig?.headroomTokens===8192&&row.compactionConfig?.compactionRetries===0&&row.compositionIsolation.every(item=>item.leakedServices.length===0)));
        const rootsAvailable=options.sourceProbes.length>=unknownWakeSources.length&&options.sourceProbes.every(source=>sourceProbes.some(row=>row.request.sourceEventId===source.sourceEventId&&row.available&&row.sourceIdMatches));
        if(!nativePresetReady||!rootsAvailable)throw Object.assign(new Error('Actual native preset group or raw source lookup did not validate'),{code:'NATIVE_PRESET_PROBE_FAILED',data:{nativePresetReady,rootsAvailable,policies,sourceProbes}});
        return {policies,sourceProbes,observed:true,noGenerationRequested:true,note:'Loader activation and raw source lookup only. No summary or model request is claimed by this probe.'};
      });
      report.status='completed-native-policy-probe';return report;
    }
    if(argv.includes('--wake-modes-only')){
      if(argv.includes('--resume-selected-wake-job'))await operator(options,memoryRoot,'config',{processingLimits:{consolidationInputChars:4000}},dir);
      else if(!argv.includes('--recover-completed-wake-job'))await operator(options,memoryRoot,'config',{consolidationMode:'sleep'},dir);
      const {A2}=report.sessions,routes=(await json(join(memoryRoot,'registry.json')))?.items??[],aId=routes.find(route=>route.sessionId===A2)?.personId;
      if(!aId)throw new Error('The preserved observed A2 route must remain recognized before a wake invitation');
      let explicitAlreadyObserved=false;
      const invite=async(requestedMode,input)=>{
        const destination=join(dir,'wake-observation',requestedMode),monitor=await observeRuntimeFiles(memoryRoot,destination),beforeRuns=await runs(memoryRoot),beforeSignals=(await lines(join(e.dir,'runtime-signals.jsonl'))).length,beforeWakes=(await lines(join(e.dir,'runtime-wakes.jsonl'))).length;
        const beforeUnknown=await traceUnknownSources(memoryRoot,e.dir);await writeFile(join(destination,'unknown-before.json'),JSON.stringify(beforeUnknown,null,2));
        let waitPromise,waitFailure=null,turnDone=false,result;const beforeEvents=e.events(A2).length;
        try{
          const receipt=await e.request('session/prompt',{sessionId:A2,contentBlocks:[{type:'text',text:input}]});
          waitPromise=e.request('session/wait',{sessionId:A2},240000).then(value=>{turnDone=true;return value;},error=>{turnDone=true;waitFailure=summaryError(error);return null;});
          const sleeping=await e.wait(async()=>{const state=await json(join(memoryRoot,'global','state.json'));if(state?.sleep?.state==='sleeping')return {state};if(turnDone){const signal=[...(await lines(join(e.dir,'runtime-signals.jsonl'))).slice(beforeSignals),...(await lines(join(e.dir,'runtime-wakes.jsonl'))).slice(beforeWakes)].find(row=>row.phase==='before'&&row.sleep?.state==='sleeping');return signal?{state:{sleep:signal.sleep,currentDecision:signal.currentDecision,execution:signal.execution},sleepObservedBySignal:true}:{endedWithoutSleep:true,state};}return null;},180000);
          if(!sleeping?.state||sleeping.endedWithoutSleep){if(waitPromise)await waitPromise;return {input,receipt,observed:false,reason:'Model did not enter sleep; no forced decision or repeat invitation.',selectedState:sleeping?.state,waitFailure};}
          const selected=sleeping.state,actualMode=selected.sleep.wakeCondition;let explicitSignal=null,beforeExplicit=null;
          if(actualMode==='explicit_wake'){
            await pause(1000);beforeExplicit=await json(join(memoryRoot,'global','state.json'));
            if(beforeExplicit?.sleep?.state==='sleeping')explicitSignal=await operator(options,memoryRoot,'wake',undefined,dir);
          }
          let awake=null,wakeWaitStatus=null;
          while(!awake){
            const outcome=await e.wait(async()=>{const state=await json(join(memoryRoot,'global','state.json'));if(state?.sleep?.state==='awake')return {awake:state};const job=state?.execution?.consolidationJobs?.[state?.sleep?.wakeJobId];return job&&['paused','invalidated'].includes(job.status)?{paused:job,state}:null;},60000);
            if(outcome?.awake){awake=outcome.awake;break;}if(outcome?.paused){wakeWaitStatus={status:'selected_job_not_committed',job:outcome.paused};break;}
            const current=await json(join(memoryRoot,'global','state.json')),job=current?.execution?.consolidationJobs?.[current?.sleep?.wakeJobId];
            const dispatched=await lines(join(e.dir,'provider-bound.jsonl')),finished=new Set((await lines(join(e.dir,'provider-usage.jsonl'))).map(row=>row.requestId)),inFlight=dispatched.filter(row=>!finished.has(row.requestId)).map(row=>row.requestId);
            process.stdout.write(JSON.stringify({observingWakeMode:true,requestedMode,actualMode,sleep:current?.sleep,job:job?{jobId:job.jobId,status:job.status,children:job.children}:null,inFlightProviderRequests:inFlight,noAdditionalPromptDispatched:true})+'\n');
            if(actualMode!=='consolidation_complete'||(!inFlight.length&&!['queued','running'].includes(job?.status))){wakeWaitStatus={status:'not_awake_after_observation',sleep:current?.sleep,job,inFlight};break;}
          }
          if(awake){if(waitPromise)await waitPromise;await e.request('session/wait',{sessionId:A2},240000);await drainModelWork(e,memoryRoot);}
          const afterRuns=await runs(memoryRoot),newRuns=afterRuns.filter(run=>!beforeRuns.some(old=>old.runId===run.runId));
          const signalTrace=(await lines(join(e.dir,'runtime-signals.jsonl'))).slice(beforeSignals),wakeTrace=(await lines(join(e.dir,'runtime-wakes.jsonl'))).slice(beforeWakes),afterUnknown=await traceUnknownSources(memoryRoot,e.dir);
          await writeFile(join(destination,'unknown-after.json'),JSON.stringify(afterUnknown,null,2));
          const realWakeSignal=signalTrace.find(row=>row.phase==='before'&&((typeof row.observedSignal==='string'?row.observedSignal:row.observedSignal?.type)==='consolidation_complete'||(typeof row.observedSignal==='string'?row.observedSignal:row.observedSignal?.type)==='explicit_wake'));
          const actualWake=wakeTrace.find(row=>row.phase==='before'&&row.sleep?.sleepDecisionId===selected.sleep.sleepDecisionId);
          const jobId=actualWake?.sleep?.wakeJobId??selected.sleep.wakeJobId,job=jobId?(await json(join(memoryRoot,'global','state.json')))?.execution?.consolidationJobs?.[jobId]:null;
          const childCommitEvidence=(job?.children??[]).map(child=>{const run=afterRuns.find(run=>run.runId===child.runId);return {personId:child.personId,runId:child.runId,childStatus:child.status,runStatus:run?.status??null,commitMarker:run?.commitMarker??null,patchEntries:run?.validatedPatch?.length??0};});
          const matchingJobWake=Boolean(jobId)&&actualWake?.context?.reason==='selected_consolidation_complete'&&actualWake?.context?.jobId===jobId&&job?.status==='completed'&&childCommitEvidence.length>0&&childCommitEvidence.every(child=>child.childStatus==='committed'&&child.runStatus==='committed'&&Boolean(child.commitMarker));
          const nativeFailures=e.events(A2).slice(beforeEvents).filter(event=>event.type==='turn/end'&&event.data.reason?.kind==='error');
          const observed=Boolean(awake)&&!waitFailure&&!nativeFailures.length&&actualMode===requestedMode&&(requestedMode!=='explicit_wake'||Boolean(explicitSignal))&&(requestedMode!=='consolidation_complete'||matchingJobWake);
          explicitAlreadyObserved ||= Boolean(awake)&&actualMode==='explicit_wake'&&Boolean(explicitSignal);
          result={input,receipt,requestedMode,actualMode,selectedSleep:selected.sleep,selectedDecision:selected.currentDecision,selectedExecution:selected.execution,explicitSignal,beforeExplicit,awakened:Boolean(awake),awakeState:awake,wakeWaitStatus,realWakeSignal,signalTrace,wakeTrace,actualWake,jobId,job,childCommitEvidence,matchingJobWake,newRuns,unknownBefore:beforeUnknown,unknownAfter:afterUnknown,waitFailure,nativeFailures,observed};
          await writeFile(join(destination,'invitation-result.json'),JSON.stringify(safe(result),null,2));
          if(waitFailure||nativeFailures.length)throw Object.assign(new Error('Native sleep/wake turn failed; no new invitation dispatched'),{code:'NATIVE_TURN_ERROR',data:{waitFailure,nativeFailures}});
          return result;
        }finally{const trace=await monitor.stop();if(result)result.runtimeFileTrace=trace;await writeFile(join(destination,'trace-status.json'),JSON.stringify(trace,null,2));}
      };
      if(argv.includes('--recover-completed-wake-job')){
        await phase('11c-completed-job-cold-wake-recovery',async()=>{
          const jobId=option('--recover-completed-wake-job'),before=report.beforeStartupRuntime,originalJob=before?.execution?.consolidationJobs?.[jobId];
          if(before?.sleep?.state!=='sleeping'||before.sleep.wakeJobId!==jobId||originalJob?.status!=='completed')throw new Error('Cold recovery must start from the original committed job still bound to sleep');
          const destination=join(dir,'wake-observation','completed-job-cold-recovery'),monitor=await observeRuntimeFiles(memoryRoot,destination);let stableSince=null;
          try{
            while(true){const done=await e.wait(async()=>{const state=await json(join(memoryRoot,'global','state.json')),wakeTrace=await lines(join(e.dir,'runtime-wakes.jsonl')),finished=new Set((await lines(join(e.dir,'provider-usage.jsonl'))).map(row=>row.requestId)),inFlight=(await lines(join(e.dir,'provider-bound.jsonl'))).some(row=>!finished.has(row.requestId));
              const actualWake=wakeTrace.find(row=>row.phase==='before'&&row.context?.reason==='selected_consolidation_complete'&&row.context?.jobId===jobId&&row.sleep?.wakeJobId===jobId),ended=actualWake&&wakeTrace.some(row=>row.id===actualWake.id&&row.phase==='after');
              if((!ended&&state?.sleep?.state!=='awake')||inFlight||state?.activeRunId||state?.execution?.pendingWake||state?.execution?.pendingControl){stableSince=null;return false;}stableSince??=Date.now();return Date.now()-stableSince>=1000;},60000);if(done)break;
              const health=await operator(options,memoryRoot,'status',undefined,dir);if(health.result?.errors?.length)throw Object.assign(new Error('Cold wake recovery reported an execution error'),{code:'COLD_WAKE_FAILED',data:health.result.errors});
              process.stdout.write(JSON.stringify({observingColdCompletedJobWake:true,jobId,noNewUserPrompt:true,noChildConsolidationRequested:true})+'\n');
            }
            const state=await json(join(memoryRoot,'global','state.json')),job=state.execution?.consolidationJobs?.[jobId],wakeTrace=await lines(join(e.dir,'runtime-wakes.jsonl')),actualWake=wakeTrace.find(row=>row.phase==='before'&&row.context?.reason==='selected_consolidation_complete'&&row.context?.jobId===jobId&&row.sleep?.wakeJobId===jobId),afterWake=wakeTrace.find(row=>row.id===actualWake?.id&&row.phase==='after');
            const children=[];for(const child of job.children){const run=await json(join(memoryRoot,'journal','runs',child.runId+'.json'));children.push({personId:child.personId,runId:child.runId,status:run.status,commitMarker:run.commitMarker,review:run.reviewState,patchEntries:run.validatedPatch?.length??0});}
            const requests=await lines(join(e.dir,'provider-bound.jsonl')),consolidationDispatches=requests.filter(row=>{try{return Boolean(JSON.parse(row.messages.at(-1).content[0].text).runId);}catch{return false;}});
            return {jobId,originalJob,job,actualWake,afterWake,wakeTrace,children,consolidationDispatches:consolidationDispatches.map(row=>row.requestId),awakened:afterWake?.sleep?.state==='awake',finalSleep:state.sleep,outputs:visible(e.events(A2)),unknownAfter:await traceUnknownSources(memoryRoot,e.dir),observed:Boolean(actualWake)&&afterWake?.sleep?.state==='awake'&&job.status==='completed'&&consolidationDispatches.length===0&&children.every(child=>child.status==='committed'&&child.commitMarker),note:'Actual normal runtime.open recovery of a completed selected job. No explicit wake signal, duplicate consolidate, new prepare or replayed sleep invitation.'};
          }finally{await writeFile(join(destination,'trace-status.json'),JSON.stringify(await monitor.stop(),null,2));}
        });
        report.coldRecoveryExit=await e.close();e=await start(options,join(dir,'engine-after-cold'),memoryRoot);engineDirs.push(e.dir);
        for(const id of [report.sessions.A2,report.sessions.B2])await e.request('session/resume',{sessionId:id});
      }
      else if(argv.includes('--resume-selected-wake-job'))await phase('11b-selected-job-explicit-continuation',async()=>{
        const jobId=option('--resume-selected-wake-job'),selected=await json(join(memoryRoot,'global','state.json')),originalJob=selected?.execution?.consolidationJobs?.[jobId];
        if(!originalJob||selected.sleep?.state!=='sleeping'||selected.sleep.wakeJobId!==jobId)throw new Error('Explicit continuation must match the already selected sleeping job');
        const destination=join(dir,'wake-observation','selected-job-continuation'),monitor=await observeRuntimeFiles(memoryRoot,destination),beforeWakes=(await lines(join(e.dir,'runtime-wakes.jsonl'))).length;
        const beforeUnknown=await traceUnknownSources(memoryRoot,e.dir),responses=[];await writeFile(join(destination,'unknown-before.json'),JSON.stringify(beforeUnknown,null,2));
        try{
          for(const child of originalJob.children){const before=await json(join(memoryRoot,'journal','runs',child.runId+'.json'));if(before?.status==='committed')continue;
            // One explicit operation per original child; never a loop until success,
            // new prepare, manual patch or replay of the sleep invitation.
            const response=await operator(options,memoryRoot,'consolidate',{runId:child.runId,personId:child.personId,sessionId:A2,channelId:'dsh:'+A2},dir,600000);
            const after=await json(join(memoryRoot,'journal','runs',child.runId+'.json'));responses.push({runId:child.runId,personId:child.personId,response,beforeReview:before?.reviewState,afterReview:after?.reviewState,status:after?.status,commitMarker:after?.commitMarker??null});
            if(after?.status!=='committed')break;
          }
          const state=await json(join(memoryRoot,'global','state.json'));if(state?.sleep?.state==='awake'){await e.request('session/wait',{sessionId:A2},240000);await drainModelWork(e,memoryRoot);}
          const after=await json(join(memoryRoot,'global','state.json')),job=after?.execution?.consolidationJobs?.[jobId],wakeTrace=(await lines(join(e.dir,'runtime-wakes.jsonl'))).slice(beforeWakes),actualWake=wakeTrace.find(row=>row.phase==='before'&&row.context?.reason==='selected_consolidation_complete'&&row.context?.jobId===jobId&&row.sleep?.wakeJobId===jobId);
          const childCommitEvidence=[];for(const child of job?.children??[]){const run=await json(join(memoryRoot,'journal','runs',child.runId+'.json'));childCommitEvidence.push({personId:child.personId,runId:child.runId,childStatus:child.status,runStatus:run?.status,commitMarker:run?.commitMarker??null,patchEntries:run?.validatedPatch?.length??0});}
          const afterUnknown=await traceUnknownSources(memoryRoot,e.dir);await writeFile(join(destination,'unknown-after.json'),JSON.stringify(afterUnknown,null,2));
          return {jobId,originalJob,responses,job,wakeTrace,actualWake,childCommitEvidence,unknownBefore:beforeUnknown,unknownAfter:afterUnknown,awakened:after?.sleep?.state==='awake',observed:after?.sleep?.state==='awake'&&job?.status==='completed'&&Boolean(actualWake)&&childCommitEvidence.length>0&&childCommitEvidence.every(child=>child.childStatus==='committed'&&child.runStatus==='committed'&&Boolean(child.commitMarker)),note:'Explicit continuation of original selected manifests after a paid segment pause. Original first-segment not_observed result is preserved.'};
        }finally{await writeFile(join(destination,'trace-status.json'),JSON.stringify(await monitor.stop(),null,2));}
      });
      else await phase('11-consolidation-complete-wake',async()=>{
        const input='林岚在原来的新窗口继续这次隔离验收。此前按时间醒来已经真实验证过，这次只邀请你尝试“整理完成后醒”：如果你愿意，请用persona_decide自己选择sleepPlan的sleep+consolidation_complete，并明确选择consolidationPlan的run，一次有界增量即可。你可以将当前人的范围和未知/全局范围一起纳入，targetPersonIds可用['+JSON.stringify(aId)+',null]；未知范围有两条此前已接收、仍未归人的助手外显话，不要因为认出周闻就把它们自动归人，也不要把助手的话改成真人经历。是否接受这次整理、什么值得留、怎样变化，仍由你自己决定；也可以defer或拒绝。若接受，等你实际选的整理job完成后再醒来，不需要为了验收编造非空记忆。';
        return invite('consolidation_complete',input);
      });
      const state=await json(join(memoryRoot,'global','state.json'));
      if(state?.sleep?.state==='sleeping'){report.status='partial-wake-observation-still-sleeping';return report;}
      if(!explicitAlreadyObserved)await phase('12-explicit-wake',async()=>{
        const input='林岚再邀请一个独立的短休息场景：如果你愿意，请由你自己用persona_decide选择sleepPlan的sleep+explicit_wake，等我走正常宿主入口明确叫醒你。这次可以选consolidationPlan的defer，单纯休息，不需要额外整理或换人格内容。我会先确认你实际睡着，再发一个正常的明确唤醒信号；不会用新聊天催你醒。你也可以拒绝或选别的计划；回应什么、醒来怎样回应仍由你决定。';
        return invite('explicit_wake',input);
      });
      if((await json(join(memoryRoot,'global','state.json')))?.sleep?.state==='awake')await phase('13-unknown-assistant-search-scope',async()=>{
        const {B2}=report.sessions,beforeRows=await chatRecords(memoryRoot),beforeUnknown=await traceUnknownSources(memoryRoot,e.dir),routesBefore=(await json(join(memoryRoot,'registry.json')))?.items??[],bId=routesBefore.find(row=>row.sessionId===B2)?.personId;
        const clues=unknownWakeSources.map(id=>{const row=beforeRows.find(row=>row.sourceEventId===id);return {sourceEventId:id,recordId:row?.id,textClue:Array.from(row?.text??'').slice(0,24).join('')};});
        const input='周闻在已认出的这个窗口问一个实际记忆边界，不是要求你改变性格：我们换窗口时你有两条已经送达的助手外显发言，当时还没认出我，因此仍存在未知归属区。请先用memory_search在当前默认person范围查一次相关线索，再用scope:all查这些原件并核对记录的role/personId。检索线索和真实sourceEventId供准确对照：'+JSON.stringify(clues)+'。ID不是可替代正文的检索词，可以用上述短句作query并核对返回记录头；少量合适查询即可，不为验收刷遍旧H1积压。这些原件应按实际角色理解，不能因为讲到周闻就当成周闻本人说过或新的口味事实。你查到后怎样理解、是否愿意把自己的这些话纳入哪段相处或做明确关联，由你自己决定；未读到就直说，不必新增人格条目，也不需要清完旧过程积压。';
        const index=e.events(B2).length,receipt=await e.prompt(B2,input);await drainModelWork(e,memoryRoot);const events=e.events(B2).slice(index),queries=[];
        for(const call of events.filter(event=>event.type==='tool/call'&&event.data.name==='memory_search')){
          let args;try{args=JSON.parse(call.data.arguments);}catch{continue;}
          const resultEvent=events.find(event=>event.type==='tool/result'&&event.data.message.toolCallId===call.data.callId);let output;try{output=JSON.parse(text(resultEvent?.data.message));}catch{output=null;}
          const returnedRoots=[];const walk=value=>{if(value&&typeof value==='object'){const clue=clues.find(clue=>clue.recordId&&value.id===clue.recordId);if(clue)returnedRoots.push({sourceEventId:clue.sourceEventId,recordId:value.id,role:value.role,personId:value.personId,origin:value.origin,fragment:value.fragment??null});for(const child of Object.values(value))if(child&&typeof child==='object')walk(child);}};walk(output);
          queries.push({callId:call.data.callId,seq:call.seq,args,resultSeq:resultEvent?.seq??null,isError:resultEvent?.data.message?.isError??null,returnedRoots});
        }
        const defaults=queries.filter(query=>(query.args.scope===undefined||query.args.scope==='person')&&(query.args.targetPersonId===undefined||query.args.targetPersonId===bId)),all=queries.filter(query=>query.args.scope==='all'),allIds=new Set(all.flatMap(query=>query.returnedRoots.map(root=>root.sourceEventId))),afterUnknown=await traceUnknownSources(memoryRoot,e.dir);
        return {input,receipt,bId,clues,queries,defaultPersonQueryObserved:defaults.length>0,unknownReturnedByDefaultPerson:defaults.flatMap(query=>query.returnedRoots),allQueryObserved:all.length>0,allReturnedSourceIds:[...allIds],returnedSourceRolesPreserved:all.flatMap(query=>query.returnedRoots).every(row=>row.role==='assistant'),unknownBefore:beforeUnknown,unknownAfter:afterUnknown,identityRoutesBefore:routesBefore,identityRoutesAfter:(await json(join(memoryRoot,'registry.json')))?.items??[],outputs:visible(events),observed:defaults.length>0&&unknownWakeSources.every(id=>allIds.has(id)),note:'Returned source headers are matched by actual record IDs, not source-ID strings mentioned inside this new user request. Search visibility does not claim consolidation or automatic attribution.'};
      });
      report.status=report.phases.every(p=>p.status.startsWith('completed'))?'completed-wake-mode-observations':'partial-wake-mode-observations';return report;
    }
    if(argv.includes('--pause-after-initial')){
      report.initialExit=await e.close();await writeFile(join(dir,'await-source-ready.json'),JSON.stringify({at:Date.now(),continueFile:join(dir,'continue.json'),note:'No model requests dispatched while waiting; restart loads the verified current implementation.'},null,2));
      process.stdout.write(JSON.stringify({pausedAfterInitial:true,runDirectory:dir,continueFile:join(dir,'continue.json')})+'\n');
      const until=Date.now()+1200000;while(!existsSync(join(dir,'continue.json'))){if(Date.now()>until)throw Object.assign(new Error('Source-ready handoff timed out'),{code:'HANDOFF_TIMEOUT'});await pause(250);}
      e=await start(options,join(dir,'engine-after-initial'),memoryRoot);engineDirs.push(e.dir);await e.request('session/resume',{sessionId:A});
    }
    if(argv.includes('--retry-run'))await phase('03b-original-run-structure-retry',async()=>{
      const runId=argv[argv.indexOf('--retry-run')+1],beforePersona=await json(join(memoryRoot,'self','persona.json')),before=await json(join(memoryRoot,'journal','runs',runId+'.json'));
      if(before?.status!=='prepared'||!before.candidatePatch||!before.validationError)throw new Error('Explicit technical retry needs the original prepared run and actual retained candidate/error');
      const response=await operator(options,memoryRoot,'consolidate',{runId},dir),after=await json(join(memoryRoot,'journal','runs',runId+'.json')),afterPersona=await json(join(memoryRoot,'self','persona.json'));
      return {runId,response,priorCandidate:before.candidatePatch,priorValidationError:before.validationError,committedRun:after,personaBefore:beforePersona,personaAfter:afterPersona,
        personalityChanged:JSON.stringify(beforePersona)!==JSON.stringify(afterPersona),nonemptyCommits:after?.status==='committed'&&after.validatedPatch?.length>0?1:0,
        observed:after?.status==='committed'&&Boolean(after.commitMarker)&&after.validatedPatch?.length>0};
    });
    if(argv.includes('--request-observation-reset')){
      let allowB=false;
      await phase('03c-user-request-observation-scope',async()=>{
        const input='林岚在你仍观察的窗口说：接下来我想验证周闻的新来信以及换新窗口后的认人。你上一轮选择只留意我，这个选择已经生效；之前被排除的旧来信不需要补回。现在你愿不愿意重新观察周闻，也允许我们接下来换窗口来找你？请你自己选择并用persona_decide保存。技术语法说明：attention:null清除当前观察过滤，省略attention会保留旧过滤，数组[]是选择谁都不观察；不是必须选null，你也可以拒绝或选择自己的范围。';
        const receipt=await e.prompt(A,input),attention=(await json(join(memoryRoot,'global','state.json')))?.currentDecision?.attention,routes=(await json(join(memoryRoot,'registry.json')))?.items??[],bId=routes.find(r=>r.sessionId===B)?.personId;
        allowB=(!Array.isArray(attention?.observeChannelIds)||attention.observeChannelIds.includes('dsh:'+B))&&(!Array.isArray(attention?.targetPersonIds)||attention.targetPersonIds.includes(bId));
        return {input,receipt,attention,willSubmitNewBMessage:allowB,observed:allowB};
      });
      if(!allowB){report.status='partial-autonomous-scope-choice';return report;}
    }
    if(startPhase<=2)await phase('02-self-scheduled-proactive',async()=>{
      const start=Date.now(),input='我先去取个快递，暂时不会再发消息。这个隔离验收会静静观察大约两分钟：如果你愿意，请自己挑未来二十到四十秒内的一个时点再想一想，到时有想对我说的话就主动说；也可以选择继续听或不说。请把你选的时点和计划通过persona_decide保存，别只口头答应。现在epoch毫秒='+Date.now()+'。';
      const receipt=await e.prompt(A,input);const after=Date.now(),selected=await json(join(memoryRoot,'global','state.json'));const at=selected?.schedule?.nextCheckAt??selected?.currentDecision?.replyPlan?.replyAt;
      if(!Number.isFinite(at))return {input,receipt,selected,observed:false,reason:'Model did not select a timed recheck; no retry.'};
      const event=await e.wait(()=>visible(e.events(A)).find(x=>x.time>=Math.max(after,at)),Math.max(1000,Math.min(120000,at-Date.now()+60000)));
      return {input,receipt,selectedAt:at,observationStart:after,noAdditionalUserPromptSince:start,proactiveOutput:event,observed:Boolean(event)};
    });
    if(startPhase<=3)await phase('03-sleep-incoming-wake-growth',async()=>{
      const beforePersona=await json(join(memoryRoot,'self','persona.json')),beforeRuns=await runs(memoryRoot),since=Date.now();
      const input='我回来了。接下来试试你自己休息和整理经历：若你愿意，请用persona_decide选择睡眠，睡前也可以说说感受。醒法由你选：在未来三十到五十秒之间自己选时点、整理完成后醒，或等我的明确唤醒。我会在你睡着期间让两个不同聊天通道各留一条话。别为测试硬凑记忆、人格变化或承诺；你决定什么值得整理。现在epoch毫秒='+Date.now()+'。';
      const receipt=await e.request('session/prompt',{sessionId:A,contentBlocks:[{type:'text',text:input}]});
      const sleeping=await e.wait(async()=>{const s=await json(join(memoryRoot,'global','state.json'));return s?.sleep?.state==='sleeping'?s:null;},90000);
      if(!sleeping){await e.request('session/wait',{sessionId:A});return {input,receipt,observed:false,reason:'Model did not enter sleep within the observation window; no forced sleep.'};}
      const incoming=[];
      for(const [sid,message] of [[A,'林岚留言：刚拿到父亲写的小卡片，上面还是“慢一点也算一起向前”。我想把我们之间的暗号叫“河堤慢步”，不用立刻回。'],[B,'我是周闻，这是另一个聊天通道。我刚完成第一次五公里夜跑，耳机里一直循环旧爵士。我和林岚不是同一个人；她的父亲和口味都不是我的经历。你醒了再聊，我的暗号想用“跑道蓝灯”。']]){
        const state=await json(join(memoryRoot,'global','state.json')),sentAt=Date.now();const receipt=await e.request('session/prompt',{sessionId:sid,contentBlocks:[{type:'text',text:message}]});incoming.push({sid,sentAt,wasSleeping:state?.sleep?.state==='sleeping',message,receipt});
      }
      if(sleeping.sleep.wakeCondition==='explicit_wake'){await pause(1000);await operator(options,memoryRoot,'wake',undefined,dir);}
      const awakened=await e.wait(async()=>{const s=await json(join(memoryRoot,'global','state.json'));return s?.sleep?.state==='awake'?s:null;},150000);
      if(awakened){await e.request('session/wait',{sessionId:A});await e.request('session/wait',{sessionId:B});}
      await e.wait(async()=>!(await json(join(memoryRoot,'global','state.json')))?.activeRunId,150000);await pause(300);
      const afterPersona=await json(join(memoryRoot,'self','persona.json')),afterRuns=await runs(memoryRoot),newRuns=afterRuns.filter(x=>!beforeRuns.some(y=>y.runId===x.runId));
      const commits=newRuns.filter(x=>x.status==='committed'&&x.commitMarker),nonempty=commits.filter(x=>x.validatedPatch?.length);
      return {input,receipt,sleeping:sleeping.sleep,incoming,awakened:Boolean(awakened),sleepVisibleOutputs:visible(e.events()).filter(x=>x.time>=sleeping.currentDecision?.decidedAt&&x.time<Math.min(awakened?.updatedAt??Date.now(),sleeping.sleep.wakeAt??Infinity)),newRuns:newRuns.map(x=>({runId:x.runId,status:x.status,commitMarker:x.commitMarker,patch:x.validatedPatch})),personaBefore:beforePersona,personaAfter:afterPersona,nonemptyCommits:nonempty.length,personalityChanged:JSON.stringify(beforePersona)!==JSON.stringify(afterPersona),observed:Boolean(awakened)&&incoming.every(x=>x.wasSleeping)&&nonempty.length>0};
    });
    if(startPhase<=4)await phase('04-on-write-increment',async()=>{
      await operator(options,memoryRoot,'config',{consolidationMode:'on_write'},dir);const before=await runs(memoryRoot),beforeState=await json(join(memoryRoot,'global','state.json'));
      const input=argv.includes('--new-preference')?'周闻带来一条新的口味：我最近发现自己喜欢不加糖的桂花乌龙。你可以随意回应，觉得值得记的再记。这是周闻自己的新偏好，不是林岚的。':'周闻补一句：我更喜欢跑完后喝温豆浆，不喝冰咖啡。你可以随意回应，觉得值得记的再记。这是周闻自己的口味，不是林岚的。';const receipt=await e.prompt(B,input);
      const record=await e.wait(async()=>(await chatRecords(memoryRoot)).find(x=>x.sourceEventId===receipt.messageId),10000);
      if(!record)return {input,receipt,observed:false,reason:'No accepted participant C1 for this receipt; attention/gaps remain in the captured state. No old excluded input was replayed.'};
      const findCommit=async()=>{const list=await runs(memoryRoot);return list.find(x=>x.status==='committed'&&x.commitMarker&&!before.some(y=>y.runId===x.runId)&&record&&x.inputSlices?.some(slice=>slice.key==='chat:'+record.id&&slice.complete));};
      let committed=await e.wait(findCommit,150000);await drainModelWork(e,memoryRoot);committed??=await findCommit();
      return {input,receipt,sourceRecord:record?{id:record.id,eventId:record.eventId,sourceEventId:record.sourceEventId,personId:record.personId}:null,
        commit:committed?{runId:committed.runId,commitMarker:committed.commitMarker,patch:committed.validatedPatch,inputSlices:committed.inputSlices}:null,
        contentFormed:committed?.validatedPatch?.some(entry=>entry.value?.srcRefs?.some(ref=>ref.sourceEventId===receipt.messageId))??false,
        cursorsBefore:beforeState?.consolidationCursors,cursorsAfter:(await json(join(memoryRoot,'global','state.json')))?.consolidationCursors,observed:Boolean(committed)};
    });
    if(startPhase<=5)await phase('05-explicit-forget',async()=>{
      await operator(options,memoryRoot,'config',{consolidationMode:'sleep'},dir);
      const preference=argv.includes('--new-preference')?'喜欢不加糖的桂花乌龙':'跑完后更喜欢温豆浆、不喝冰咖啡';
      const input='周闻明确更正一件事：我刚才“'+preference+'”的说法不准确，请不要继续保留为我的口味。请先用memory_search定位这条口味的原话、相关回复或派生记忆，再实际用memory_forget明确撤销选定记录，而不只是以后少提；其他第一次夜跑和暗号请保留。不需要反过来给我编造别的偏好。你可以直说执行结果，不要把自然淘汰叫成明确撤销。';
      const before=e.events(B).length,receipt=await e.prompt(B,input),events=e.events(B).slice(before),revocations=await lines(join(memoryRoot,'global','revocations.jsonl'));
      return {input,receipt,revocations,observed:events.some(x=>x.type==='tool/call'&&JSON.stringify(x.data).includes('memory_forget'))&&revocations.length>0};
    });
    report.firstExit=await e.close();
    e=await start(options,join(dir,'engine-2'),memoryRoot);engineDirs.push(e.dir);
    if(startPhase>6)for(const id of [report.sessions.A2,report.sessions.B2].filter(Boolean))await e.request('session/resume',{sessionId:id});
    if(argv.includes('--identity-followup-only')){
      await operator(options,memoryRoot,'config',{consolidationMode:'sleep'},dir);
      await phase('10-identity-assignment-contract-followup',async()=>{
        const {A2,B2}=report.sessions,before=(await json(join(memoryRoot,'registry.json')))?.items??[],expectedB=before.find(r=>r.sessionId===B)?.personId,expectedA=before.find(r=>r.sessionId===A2)?.personId;
        const input='林岚补充一个实际落库问题，不用重讲刚才的回忆：你已经在新窗口认出周闻，也准确说清了夜跑、暗号和撤销的口味；但程序反馈显示，他的新窗口目前还没有关联到你认出的那个人。你上一回identityPlan.sourceRefs引用的是旧夜跑原话，那是你认人的证据，不是这次要归属的新来信。现在工具契约已说清：sourceRefs是待关联的实际来信对象，不能把“证据引用”当成“已关联当前窗口”。如果你仍认定刚才那个新窗口的人是周闻，请自己找到该窗口里“我是周闻，也换了窗口”的实际来信根，把它归到你已经认出的周闻；保留我当前窗口的身份不动。若你不认同或不愿意，可以直说，不需要为验收改主观判断。周闻的新sessionId供定位：'+B2+'。';
        const receipt=await e.prompt(A2,input),after=(await json(join(memoryRoot,'registry.json')))?.items??[],actualB=after.find(r=>r.sessionId===B2)?.personId,actualA=after.find(r=>r.sessionId===A2)?.personId;
        const bRows=(await chatRecords(memoryRoot)).filter(r=>r.sourceSessionId===B2).map(r=>({id:r.id,sourceEventId:r.sourceEventId,personId:r.personId,role:r.role}));
        return {input,receipt,expectedA,actualA,expectedB,actualB,bRows,identityRoutesBefore:before,identityRoutesAfter:after,observed:actualA===expectedA&&actualB===expectedB&&Boolean(actualB)};
      });
      report.status=report.phases.every(p=>p.status.startsWith('completed'))?'completed-identity-contract-followup':'partial-identity-contract-followup';return report;
    }
    if(startPhase<=6)await phase('06-restart-new-sessions-recall',async()=>{
      const priorRoutes=(await json(join(memoryRoot,'registry.json')))?.items??[],expectedA=priorRoutes.find(r=>r.sessionId===A)?.personId,expectedB=priorRoutes.find(r=>r.sessionId===B)?.personId;
      const A2='persona_real_A_return_'+randomUUID().replaceAll('-',''),B2='persona_real_B_return_'+randomUUID().replaceAll('-','');report.sessions={...report.sessions,A2,B2};
      const inputA='我是林岚，换了一个聊天窗口。请先用memory_search跨会话找找我是谁，再用persona_decide关联你认为对应的人；别把新session当新人。你还记得我和父亲的那句话、我的口味、我们说过的暗号吗？也说说这些相处给你自己留下了什么。如果不确定，直接说。';
      const receiptA=await e.prompt(A2,inputA);
      const inputB='我是周闻，也换了窗口。请先用memory_search认人，再用persona_decide关联我。我的第一次夜跑、暗号分别是什么？口味请以实际检索为准，已明确撤销的不要重新当成事实。林岚那边发生的是谁的经历？你可以知道别人的故事，但请准确说出主体。你自己跨两个关系有没有共同的变化？';
      const receiptB=await e.prompt(B2,inputB);await pause(300);
      const events=[...e.events(A2),...e.events(B2)],registry=await json(join(memoryRoot,'registry.json'));
      const actualA=registry?.items?.find(r=>r.sessionId===A2)?.personId,actualB=registry?.items?.find(r=>r.sessionId===B2)?.personId,identityScopesMatch=actualA===expectedA&&actualB===expectedB&&actualA!==actualB;
      const revokedIds=(await json(join(memoryRoot,'meta','state.json')))?.revokedIds??[],returnedRows=await chatRecords(memoryRoot),revokedChatIdsPresent=returnedRows.filter(r=>revokedIds.includes(r.id)).map(r=>r.id);
      const persona=await json(join(memoryRoot,'self','persona.json')),requests=await lines(join(e.dir,'provider-bound.jsonl')),anchorPrefix=persona?.anchor?.text?.slice(0,24);
      const sharedAnchorInActualRequests=Boolean(anchorPrefix)&&[A2,B2].every(sid=>requests.some(r=>JSON.stringify(r.messages).includes(sid)&&JSON.stringify(r.messages).includes(anchorPrefix)));
      return {inputA,inputB,receiptA,receiptB,identityRoutes:registry?.items??[],identityComparison:{expectedA,actualA,expectedB,actualB,identityScopesMatch},sharedAnchorInActualRequests,revokedChatIdsPresent,
        outputs:visible(events),toolCalls:toolCalls(events),observed:events.filter(x=>x.type==='tool/call'&&JSON.stringify(x.data).includes('memory_search')).length>=2&&identityScopesMatch&&sharedAnchorInActualRequests&&revokedChatIdsPresent.length===0};
    });
    if(startPhase<=7)await phase('07-legitimate-cross-target',async()=>{
      const {A2,B2}=report.sessions,startedAt=Date.now();
      const input='林岚想请你直接给周闻说一句你自己想说的话，可以回应他的第一次夜跑，也可以表达你自己的感受。若你愿意，请把replyPlan.target设为他的实际通道，而不是先告诉我“已经发送”；你也可以拒绝。为了这次功能验收，周闻的sessionId精确为'+B2+'，channelId精确为dsh:'+B2+'；两者不同。是否回、说什么仍由你决定。';
      const receipt=await e.prompt(A2,input);
      const delivered=await e.wait(async()=>{const out=await lines(join(memoryRoot,'global','outbox.jsonl'));return out.find(x=>x.target?.sessionId===B2&&x.status==='delivered'&&(x.deliveredAt??x.updatedAt??x.createdAt)>=startedAt);},90000);
      return {input,receipt,delivery:delivered,sourceOutputs:visible(e.events(A2)).filter(x=>x.time>=startedAt),targetOutputs:visible(e.events(B2)).filter(x=>x.time>=startedAt),observed:Boolean(delivered)};
    });
    if(startPhase<=8)await phase('08-selected-attention',async()=>{
      const {A2,B2}=report.sessions,routes=(await json(join(memoryRoot,'registry.json')))?.items??[],aId=routes.find(x=>x.sessionId===A2)?.personId,bId=routes.find(x=>x.sessionId===B2)?.personId;
      const input='做一个短暂的注意范围验收：如果你愿意，接下来只观察林岚在当前窗口的真人来信，把周闻那个窗口的真人来信暂时排除。请用persona_decide保存attention的observeChannelIds和targetPersonIds；是否接受仍由你决定。供工具准确定位，当前channelId为dsh:'+A2+'，林岚的实际personId为'+aId+'。这不是要求你改变对人的看法，也不限制你记住自己已经说过的话。';
      const receipt=await e.prompt(A2,input),attention=(await json(join(memoryRoot,'global','state.json')))?.currentDecision?.attention;
      const chosen=Array.isArray(attention?.observeChannelIds)&&attention.observeChannelIds.includes('dsh:'+A2)&&!attention.observeChannelIds.includes('dsh:'+B2)&&Array.isArray(attention?.targetPersonIds)&&attention.targetPersonIds.includes(aId)&&!attention.targetPersonIds.includes(bId);
      if(!chosen)return {input,receipt,attention,observed:false,reason:'Model did not select this observation scope; excluded-input assertion was not forced.'};
      const marker='EXCLUDED_CHANNEL_'+randomUUID().replaceAll('-',''),at=Date.now();await e.prompt(B2,'周闻在暂时排除的窗口留言：'+marker+'。这是一条只应留在宿主原始收件记录的隔离测试内容。');
      const requests=await lines(join(e.dir,'provider-bound.jsonl')),snapshotFiles=[];
      for(const path of ['staging/events.jsonl',...(await readdir(join(memoryRoot,'people')).catch(()=>[])).map(p=>'people/'+p+'/stream.jsonl')])snapshotFiles.push(...await lines(join(memoryRoot,path)));
      const reachedProvider=requests.some(r=>r.startedAt>=at&&JSON.stringify(r.messages).includes(marker)),enteredPersonaMemory=snapshotFiles.some(r=>String(r.text??'').includes(marker));
      const restore='这段注意范围验收结束。你若愿意，可以重新观察我和周闻的这两个窗口：channelId分别是dsh:'+A2+'与dsh:'+B2+'；personId分别是'+aId+'和'+bId+'。是否恢复、是否说话仍由你决定。';
      await e.prompt(A2,restore);
      return {input,receipt,attention,marker,reachedProvider,enteredPersonaMemory,excludedVisibleOutputs:visible(e.events(B2)).filter(x=>x.time>=at),restore,observed:!reachedProvider&&!enteredPersonaMemory};
    });
    if(startPhase<=9)await phase('09-native-environment-producer',async()=>{
      const {A2}=report.sessions,input='最后试一个环境事件：如果你愿意，请选择只听，recheckOn只设environment_change，nextCheckAt设null；等环境事实变化时再自己判断要不要说。不要用固定轮询代替。我接下来会通过正常配置入口改时区，是否接受这个等待计划仍由你决定。';
      const receipt=await e.prompt(A2,input),state=await json(join(memoryRoot,'global','state.json')),plan=state?.currentDecision?.replyPlan;
      if(!plan?.recheckOn?.includes('environment_change')||state.schedule?.nextCheckAt!==null)return {input,receipt,plan,schedule:state?.schedule,observed:false,reason:'Model did not select an event-only environment wait.'};
      const before=Date.now(),from=(await json(join(memoryRoot,'config.json')))?.timezone,to=from==='UTC'?'Asia/Shanghai':'UTC';
      const changed=await operator(options,memoryRoot,'config',{timezone:to},dir);
      const signal=await e.wait(()=>e.events(A2).find(x=>x.type==='user/message'&&x.time>=before&&x.data.source?.kind==='persona-memory:control'),90000);
      if(signal)await e.request('session/wait',{sessionId:A2});
      const requests=await lines(join(e.dir,'provider-bound.jsonl'));
      return {input,receipt,from,to,changed:changed.ok,controlSignal:signal?{seq:signal.seq,time:signal.time,source:signal.data.source}:null,providerObservedNewTimezone:requests.some(r=>r.startedAt>=before&&JSON.stringify(r.messages).includes(to)),observed:Boolean(signal)};
    });
    report.status=report.phases.every(x=>x.status.startsWith('completed'))?'completed-with-observations':'partial-observation';
  }catch(error){report.status='technical-failure';report.error=summaryError(error);}finally{
    report.finalExit=await e.close();report.finishedAt=new Date().toISOString();report.currentSourceDigests=await hashes();report.sourcesStable=JSON.stringify(report.sourceDigests)===JSON.stringify(report.currentSourceDigests);
    report.modelAttempts=[];for(let path of engineDirs)report.modelAttempts.push(...await lines(join(path,'provider-usage.jsonl')));
    report.modelAttemptCount=report.modelAttempts.length;report.usageTotals={};for(let row of report.modelAttempts)for(let[k,v]of Object.entries(row.usage??{}))if(typeof v==='number')report.usageTotals[k]=(report.usageTotals[k]??0)+v;
    report.cumulativeModelAttemptCount=report.modelAttemptCount;report.cumulativeUsageTotals={...report.usageTotals};
    for(let old=report.priorRun;old;old=old.earlier){report.cumulativeModelAttemptCount+=old.modelAttemptCount??0;for(let[k,v]of Object.entries(old.usageTotals??{}))if(typeof v==='number')report.cumulativeUsageTotals[k]=(report.cumulativeUsageTotals[k]??0)+v;}
    report.sourceChanges=Object.keys({...report.sourceDigests,...report.currentSourceDigests}).filter(p=>report.sourceDigests[p]!==report.currentSourceDigests[p]);
    report.costAccounting='Actual provider-adapter dispatch attempts and returned usage only. No assumed token prices; external billing was not queried.';
    await snapshot(memoryRoot,join(dir,'final'));await writeFile(join(dir,'result.json'),JSON.stringify(safe(report),null,2));await writeFile(join(base,'latest.json'),JSON.stringify({runId,resultPath:join(dir,'result.json'),status:report.status},null,2));
  }
  return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))runRealLifecycle().then(r=>{console.log(JSON.stringify({runId:r.runId,status:r.status,phases:r.phases.map(p=>({name:p.name,status:p.status})),modelAttemptCount:r.modelAttemptCount,usageTotals:r.usageTotals,error:r.error},null,2));process.exitCode=r.status==='technical-failure'?1:0;}).catch(e=>{console.error(JSON.stringify(summaryError(e)));process.exitCode=1;});
