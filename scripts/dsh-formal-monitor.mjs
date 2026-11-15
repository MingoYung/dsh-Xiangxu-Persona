/** Pure session-scoped budget/usage monitor for a FORMAL DSH acceptance window.
 * Every provider is observed, but only explicitly selected sessions and their
 * real host-header descendants reserve/settle the shared whole budget. Native
 * requests carry sessionId; Xiangxu auxiliary requests carry xiangxuAccounting.
 * No prompts, presets, tools, generation parameters or persona choices change.
 * An explicit scope is required: legacy provider-wide installers must not be
 * mistaken for a session filter. No message bodies are logged by default.
 */
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export function normalizeFormalScope(scope) {
  const nonempty = value => typeof value === 'string' && value.trim().length > 0;
  if (!scope || scope.mode !== 'sessions' || !Array.isArray(scope.sessionIds)
    || !scope.sessionIds.length || !scope.sessionIds.every(nonempty) || !nonempty(scope.memoryRoot)
    || scope.includeDescendants !== undefined && typeof scope.includeDescendants !== 'boolean') {
    throw Object.assign(new Error('Formal acceptance monitor requires explicit sessionIds and memoryRoot (scope.mode=sessions)'), {code: 'FORMAL_MONITOR_SCOPE_REQUIRED'});
  }
  return {mode: 'sessions', sessionIds: [...new Set(scope.sessionIds)], memoryRoot: scope.memoryRoot,
    includeDescendants: scope.includeDescendants !== false};
}

export const formalMonitorSource = String.raw`
import {appendFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
const normalizeScope=${normalizeFormalScope.toString()};
export const inject=['llm'];
export function apply(ctx,config){
  const scope=normalizeScope(config.scope),selected=new Set(scope.sessionIds);
  const rootKey=value=>typeof value==='string'&&value?process.platform==='win32'?resolve(value).toLowerCase():resolve(value):null;
  const selectedRoot=rootKey(scope.memoryRoot);
  mkdirSync(config.artifacts,{recursive:true});
  const save=(name,value)=>appendFileSync(join(config.artifacts,name),JSON.stringify(value)+'\n');
  const service=name=>{try{return ctx.get?.(name,false)??ctx[name];}catch{return undefined;}};
  const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
  async function headerFor(id){
    const live=service('sessions')?.get?.(id)?.header??service('agents')?.get?.(id)?.session?.header;
    if(live)return live;
    const query=service('sessionQuery');
    if(typeof query?.observeSession!=='function')return null;
    const lease=await query.observeSession(id,{projectionMode:'none'});
    try{return lease?.header?{id:lease.header.id,parentSession:lease.header.parentSession}:null;}
    finally{if(lease?.[Symbol.dispose])lease[Symbol.dispose]();else if(lease?.[Symbol.asyncDispose])await lease[Symbol.asyncDispose]();}
  }
  async function classify(options){
    const aux=options.xiangxuAccounting,native=options.sessionId;
    const valid=value=>typeof value==='string'&&value.length>0;
    const ownAux=aux&&rootKey(aux.memoryRoot)===selectedRoot;
    if(aux&&valid(native)&&valid(aux.sessionId)&&native!==aux.sessionId)
      fail('FORMAL_MONITOR_SCOPE_CONFLICT','Native and auxiliary session attribution disagree');
    if(aux&&!ownAux&&!valid(native))return {included:false,reason:'other-persona'};
    const id=valid(native)?native:ownAux&&valid(aux.sessionId)?aux.sessionId:null;
    if(!id){
      if(ownAux)fail('FORMAL_MONITOR_SCOPE_UNRESOLVED','Selected-persona auxiliary call has no attributable session');
      return {included:false,reason:'no-session-attribution'};
    }
    const ancestry=[],seen=new Set();let current=id;
    while(current){
      if(seen.has(current))fail('FORMAL_MONITOR_SCOPE_UNRESOLVED','Session ancestry contains a cycle');
      seen.add(current);ancestry.push(current);
      if(selected.has(current))return {included:true,sessionId:id,rootSessionId:current,ancestry,via:valid(native)?'native':'xiangxuAccounting'};
      if(!scope.includeDescendants)return {included:false,sessionId:id,reason:'other-session'};
      let header;try{header=await headerFor(current);}catch{fail('FORMAL_MONITOR_SCOPE_UNRESOLVED','Cannot read session ancestry');}
      if(!header||header.id!==current)fail('FORMAL_MONITOR_SCOPE_UNRESOLVED','Cannot verify the real session header');
      const parent=header.parentSession;
      if(parent==null||parent==='')return {included:false,sessionId:id,reason:'other-session'};
      if(!valid(parent))fail('FORMAL_MONITOR_SCOPE_UNRESOLVED','Invalid parent session in host header');
      current=parent;
    }
  }
  const wrapped=new Map();let disposed=false;
  const observe=()=>{
    if(disposed)return;
    if(typeof ctx.llm.listProviders!=='function')fail('FORMAL_MONITOR_HOST_UNSUPPORTED','Host must expose llm.listProviders');
    for(const provider of ctx.llm.listProviders()){
      const adapter=ctx.llm.registration(provider.id).adapter;
      if(wrapped.has(adapter))continue;
      const original=adapter.prepareCall;
      if(typeof original!=='function')fail('FORMAL_MONITOR_HOST_UNSUPPORTED','Provider lacks prepareCall');
      const wrapper=async function(...args){
        const call=await original.apply(this,args),dispatch=call.stream.bind(call);
        return {...call,stream:options=>(async function*(){
          if(disposed){yield*dispatch(options);return;}
          let match;
          try{match=await classify(options);}catch(error){save('dispatch-budget.jsonl',{at:Date.now(),reason:error.code,blockedBeforeProviderInvocation:true});throw error;}
          save('scope-dispatch.jsonl',{at:Date.now(),provider:options.provider,model:options.model,purpose:options.xiangxuAccounting?.purpose??options.purpose,...match});
          if(!match.included){yield*dispatch(options);return;}
          if(Number.isFinite(config.wholeDeadline)&&Date.now()>=config.wholeDeadline){save('dispatch-budget.jsonl',{at:Date.now(),reason:'WHOLE_DEADLINE_PASSED',blockedBeforeProviderInvocation:true});throw Object.assign(new Error('Whole-set deadline passed; no further model request'),{code:'WHOLE_DEADLINE_PASSED'});}
          const requestId='formal_'+randomUUID();let startedAt=Date.now(),wholeBudget=null;
          try{
            wholeBudget=await import(config.wholeBudgetModule);
            const reserved=await wholeBudget.reserveWholeAttempt(config.wholeStatePath,{requestId});
            startedAt=reserved.requests[requestId].startedAt;
          }catch(error){save('dispatch-budget.jsonl',{at:Date.now(),reason:error.code??'WHOLE_GATE_FAILED',blockedBeforeProviderInvocation:true});throw error;}
          let usage=null,finish=null;
          try{
            const messagesJson=JSON.stringify(options.messages??[]),toolsJson=JSON.stringify(options.tools??[]);
            save('provider-bound.jsonl',{kind:'formal-monitor-bound',requestId,startedAt,provider:options.provider,model:options.model,
              purpose:options.xiangxuAccounting?.purpose??options.purpose,maxTokens:options.maxTokens,reasoningEffort:options.reasoningEffort,scope:match,
              requestSize:{messagesJsonUtf8Bytes:Buffer.byteLength(messagesJson,'utf8'),messagesJsonCodePoints:Array.from(messagesJson).length,toolsJsonUtf8Bytes:Buffer.byteLength(toolsJson,'utf8'),tokenCount:null,accounting:'serialized adapter input sizes only; not tokenizer counts'},
              fullInputsLogged:config.logFullInputs===true});
            if(config.logFullInputs===true)save('provider-input-full.jsonl',{requestId,startedAt,messages:options.messages,tools:options.tools});
            for await(const chunk of dispatch(options)){
              if(chunk.type==='usage')usage=chunk.usage;if(chunk.type==='finish')finish=chunk.reason;
              yield chunk;
            }
          }finally{try{save('provider-usage.jsonl',{requestId,startedAt,finishedAt:Date.now(),provider:options.provider,model:options.model,usage,finish});}finally{if(wholeBudget)await wholeBudget.settleWholeAttempt(config.wholeStatePath,requestId,usage);}}
        })()};
      };
      adapter.prepareCall=wrapper;wrapped.set(adapter,{original,wrapper});
    }
    process.stderr.write('PM_FORMAL_MONITOR_READY '+JSON.stringify({scopeMode:scope.mode,sessionIds:scope.sessionIds,providers:ctx.llm.listProviders().map(p=>p.id)})+'\n');
  };
  ctx.on('llm/adapters-updated',observe);
  ctx.effect(()=>()=>{disposed=true;for(const [adapter,{original,wrapper}] of wrapped){const restored=adapter.prepareCall===wrapper;if(restored)adapter.prepareCall=original;save('dispatch-budget.jsonl',{at:Date.now(),reason:'monitor-disposed',prepareCallRestored:restored});}wrapped.clear();});
  observe();
}
`;

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

export function formalMonitorConfig(options) {
  if (!options.artifacts) throw new Error('formal monitor requires a dedicated artifacts directory');
  if (!options.wholeStatePath) throw new Error('formal monitor requires the shared whole budget file');
  const scope = normalizeFormalScope(options.scope);
  return {artifacts: options.artifacts, scope,
    wholeStatePath: options.wholeStatePath,
    wholeBudgetModule: pathToFileURL(join(projectRoot, 'scripts', 'dsh-test-budget.mjs')).href,
    ...(Number.isFinite(options.wholeDeadline) ? {wholeDeadline: options.wholeDeadline} : {}),
    ...(options.logFullInputs === true ? {logFullInputs: true} : {})};
}
