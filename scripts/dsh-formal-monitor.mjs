/** Pure provider budget/usage monitor for the FORMAL DSH desktop (REL-F2 §4).
 *
 * Split from scripts/dsh-real-lifecycle.mjs's test observer on purpose: that
 * observer injects personaMemory/agentDefaultModel and its agent/created hook
 * mounts the persona preset plus tool restrictions, which must never be applied
 * globally to the formal desktop. This monitor ONLY wraps the target provider
 * adapter's prepareCall so every real provider dispatch:
 *   - reserves atomically against the SAME shared whole budget file before the
 *     provider is invoked, and settles the returned usage afterwards;
 *   - appends minimal requestId/usage evidence (provider-bound.jsonl /
 *     provider-usage.jsonl / dispatch-budget.jsonl) in a dedicated engineDir,
 *     readable by the same engineUsage() accounting as isolated sittings.
 * It never touches persona prompts, presets, tool scopes or any model decision,
 * never observes unrelated provider registrations, and by default does NOT log
 * message bodies; logFullInputs is an explicit opt-in for the acceptance window.
 */
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export const formalMonitorSource = String.raw`
import {appendFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
export const inject=['llm'];
export function apply(ctx,config){
  mkdirSync(config.artifacts,{recursive:true});
  const save=(name,value)=>appendFileSync(join(config.artifacts,name),JSON.stringify(value)+'\n');
  let wrapped=false;
  const observe=()=>{
    if(wrapped)return;
    let registration;try{registration=ctx.llm.registration(config.provider);}catch{return;}
    const adapter=registration.adapter,original=adapter.prepareCall;
    if(typeof original!=='function')throw new Error('Provider lacks prepareCall');
    adapter.prepareCall=async function(...args){
      const call=await original.apply(this,args),dispatch=call.stream.bind(call);
      return {...call,stream:options=>(async function*(){
        if(Number.isFinite(config.wholeDeadline)&&Date.now()>=config.wholeDeadline){save('dispatch-budget.jsonl',{at:Date.now(),reason:'WHOLE_DEADLINE_PASSED',blockedBeforeProviderInvocation:true});throw Object.assign(new Error('Whole-set deadline passed; no further model request'),{code:'WHOLE_DEADLINE_PASSED'});}
        const requestId='formal_'+randomUUID();let startedAt=Date.now(),wholeBudget=null;
        try{
          wholeBudget=await import(config.wholeBudgetModule);
          const reserved=await wholeBudget.reserveWholeAttempt(config.wholeStatePath,{requestId});
          startedAt=reserved.requests[requestId].startedAt;
        }catch(error){save('dispatch-budget.jsonl',{at:Date.now(),reason:error.code??'WHOLE_GATE_FAILED',blockedBeforeProviderInvocation:true});throw error;}
        const messagesJson=JSON.stringify(options.messages??[]),toolsJson=JSON.stringify(options.tools??[]);
        const bound={kind:'formal-monitor-bound',requestId,startedAt,provider:options.provider,model:options.model,purpose:options.purpose,maxTokens:options.maxTokens,reasoningEffort:options.reasoningEffort,
          requestSize:{messagesJsonUtf8Bytes:Buffer.byteLength(messagesJson,'utf8'),messagesJsonCodePoints:Array.from(messagesJson).length,toolsJsonUtf8Bytes:Buffer.byteLength(toolsJson,'utf8'),tokenCount:null,accounting:'serialized adapter input sizes only; not tokenizer counts'},
          fullInputsLogged:false};
        save('provider-bound.jsonl',bound);
        if(config.logFullInputs===true){bound.fullInputsLogged=true;save('provider-input-full.jsonl',{requestId,startedAt,messages:options.messages,tools:options.tools});}
        let usage=null,finish=null;
        try{for await(const chunk of dispatch(options)){
          if(chunk.type==='usage')usage=chunk.usage;if(chunk.type==='finish')finish=chunk.reason;
          yield chunk;
        }}finally{try{save('provider-usage.jsonl',{requestId,startedAt,finishedAt:Date.now(),provider:options.provider,model:options.model,usage,finish});}finally{if(wholeBudget)await wholeBudget.settleWholeAttempt(config.wholeStatePath,requestId,usage);}}
      })()};
    };
    if(adapter.prepareCall===original)throw new Error('Formal monitor wrapper was not installed');
    wrapped=true;process.stderr.write('PM_FORMAL_MONITOR_READY '+JSON.stringify({provider:config.provider,model:config.model})+'\n');
    ctx.on('dispose',()=>{adapter.prepareCall=original;wrapped=false;save('dispatch-budget.jsonl',{at:Date.now(),reason:'monitor-disposed',prepareCallRestored:true});});
  };
  ctx.on('llm/adapters-updated',observe);observe();
}
`;

const projectRoot = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

export function formalMonitorConfig(options) {
  if (!options.artifacts) throw new Error('formal monitor requires a dedicated artifacts directory');
  if (!options.wholeStatePath) throw new Error('formal monitor requires the shared whole budget file');
  return {artifacts: options.artifacts, provider: options.provider, model: options.model,
    wholeStatePath: options.wholeStatePath,
    wholeBudgetModule: pathToFileURL(join(projectRoot, 'scripts', 'dsh-test-budget.mjs')).href,
    ...(Number.isFinite(options.wholeDeadline) ? {wholeDeadline: options.wholeDeadline} : {}),
    ...(options.logFullInputs === true ? {logFullInputs: true} : {})};
}
