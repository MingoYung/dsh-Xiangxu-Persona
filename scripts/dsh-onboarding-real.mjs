/** Small, explicitly opt-in live-model observation. No fixed model outputs.
 * node scripts/dsh-onboarding-real.mjs --real --artifacts ABS_PATH
 * Uses a dedicated native SDK profile in the user's DSH home so the normal
 * DSH credential service resolves the selected provider; never reads keys.
 * All persona roots, prompts and participants are synthetic and isolated.
 */
import { mkdir, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { optionsFrom, prepareProfile } from './dsh-integration.mjs';
import { start } from './dsh-real-lifecycle.mjs';
import { MemoryRepository } from '../core/repository.js';

const source=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const json=async file=>{try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const lines=async file=>{try{return(await readFile(file,'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return[];throw e;}};
const text=message=>(message?.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function digests(){const names=['package.json','cordis.patch.yml','scripts/dsh-onboarding-real.mjs','scripts/dsh-real-lifecycle.mjs'];async function walk(dir){for(const e of await readdir(join(source,dir),{withFileTypes:true})){const name=dir+'/'+e.name;if(e.isDirectory())await walk(name);else if(e.isFile()&&name.endsWith('.js'))names.push(name);}}await walk('core');await walk('adapters/dsh');return Object.fromEntries(await Promise.all(names.sort().map(async p=>[p,sha(await readFile(join(source,p)))])));}
const visible=events=>events.filter(e=>e.type==='assistant/message').map(e=>({seq:e.seq,at:e.time,text:text(e.data?.message??e.data),messageId:(e.data?.message??e.data)?.id})).filter(e=>e.text);
async function seed(root,style,initial){const repo=new MemoryRepository({root,config:{conversationStyle:style}});await repo.open();try{if(initial)await repo.updateSelfProfile({mode:'together',onboardingAcknowledged:true,initial},{actor:'user',expectedVersion:0});}finally{await repo.close();}}
async function waitIdle(e,root){const ok=await e.wait(async()=>!(await json(join(root,'global/state.json')))?.activeRunId,60000);if(!ok)throw Error('Existing model work did not drain; no next prompt sent');}
export async function runOnboardingReal(argv=process.argv.slice(2)){
  if(argv.includes('--help')){console.log('Usage: node scripts/dsh-onboarding-real.mjs --real --artifacts ABS_PATH\nOpt-in live DSH DeepSeek Flash, synthetic persona roots, up to 12 actual dispatches across all scenarios. Normal DSH credentials are resolved by DSH, never read by this runner.');return;}
  if(!argv.includes('--real'))throw Error('Live calls require the explicit --real flag.');
  if(process.platform!=='win32')throw Error('Installed DSH Windows SDK is required.');
  const arg=(name,fallback)=>{const i=argv.indexOf(name);return i<0?fallback:argv[i+1];};
  const base=resolve(arg('--artifacts',join(source,'work/onboarding-real'))),runId='run-'+Date.now()+'-'+randomUUID().slice(0,8),dir=join(base,runId);
  await mkdir(dir,{recursive:true});const defaults=optionsFrom([],process.env);
  const options={...defaults,profile:'xiangxu-onboarding-real-validation',provider:'deepseek-official',model:'deepseek-flash',artifacts:dir,maxActualDispatches:12};
  const report={runId,startedAt:new Date().toISOString(),status:'running',profile:options.profile,route:{provider:options.provider,model:options.model},maxActualDispatches:12,sourceDigests:await digests(),scenarios:[],claims:{realNativeDsh:true,realProvider:true,syntheticInputs:true,productionPersonaRead:false,productionProfileChanged:false,credentialService:'normal DSH service; no key read or copied',externalHttpWireCaptured:false,statisticalStyleComparison:false,longTermPersonalityProven:false},engines:[]};
  await writeFile(join(dir,'manifest.json'),JSON.stringify(report,null,2));await prepareProfile(options);
  let actualCount=0,current=null;
  const sync=()=>writeFile(join(dir,'progress.json'),JSON.stringify(report,null,2));
  async function scenario(name,e,root,sid,input,observeMs=0){
    const startAt=Date.now(),before=e.events(sid).length,item={name,sessionId:sid,input,startedAt:startAt};report.scenarios.push(item);await sync();
    try{item.receipt=await e.prompt(sid,input);await waitIdle(e,root);if(observeMs)await pause(observeMs);await waitIdle(e,root);item.status='observed';}
    catch(error){item.status='technical_failure';item.error={code:error.code??null,message:error.message};throw error;}
    finally{const events=e.events(sid).slice(before);item.messages=visible(events);item.toolCalls=events.filter(e=>e.type==='tool/call').map(e=>e.data);item.finishedAt=Date.now();item.selfProfile=await json(join(root,'self/profile.json'));item.schedule=(await json(join(root,'global/state.json')))?.schedule??null;await sync();console.log(JSON.stringify({scenario:name,status:item.status,visibleMessages:item.messages.length,visibleCharacters:item.messages.map(m=>Array.from(m.text).length)}));}
  }
  async function open(label,style,initial){
    if(actualCount>=12)throw Error('Live observation dispatch budget exhausted before a new engine.');
    const root=join(dir,label,'memory'),engineDir=join(dir,label,'engine');await seed(root,style,initial);
    const e=await start({...options,maxActualDispatches:12-actualCount},engineDir,root);current={e,root,label};return current;
  }
  async function close(){if(!current)return;const{e,root,label}=current;await waitIdle(e,root);const result=await e.close(),requests=await lines(join(e.dir,'provider-bound.jsonl')),usage=await lines(join(e.dir,'provider-usage.jsonl'));actualCount+=requests.length;let lockExists=true;try{await access(join(root,'writer.lock'));}catch(error){if(error.code==='ENOENT')lockExists=false;else throw error;}report.engines.push({label,root,exit:result,lockExists,actualDispatches:requests.length,requestRoutes:requests.map(r=>({provider:r.provider,model:r.model,reasoningEffort:r.reasoningEffort??null,purpose:r.purpose??null,requestSize:r.requestSize})),usage});current=null;await sync();}
  try{
    let e=await open('cold-short','short_chat');await scenario('cold-greeting',e.e,e.root,'onboarding_cold_'+randomUUID().replaceAll('-',''),'你好');await close();
    e=await open('profile-short','short_chat',{name:'小续',pronouns:'她',gender:'女性的虚拟形象',ageDescription:'二十五岁左右的成年形象',selfDescription:'这些是可商量的初始想法；希望日常说话自然简短。'});
    const A='onboarding_profile_'+randomUUID().replaceAll('-','');
    await scenario('initial-wishes-adoption',e.e,e.root,A,'你好，我是测试者林岚。你希望我怎么称呼你？初始想法只是参考，你可以采用、修改或者暂时留空。');
    await scenario('same-persona-new-window',e.e,e.root,'onboarding_fresh_'+randomUUID().replaceAll('-',''),'你好，你希望我怎么称呼你？');
    await scenario('short-companionship-and-optional-followup',e.e,e.root,A,'今天忙完了，坐下来有点累。',2500);await close();
    // One separate balanced sample is observational, not a statistical claim.
    if(actualCount<10){e=await open('balanced','balanced');await scenario('balanced-independent-sample',e.e,e.root,'onboarding_balanced_'+randomUUID().replaceAll('-',''),'今天忙完了，坐下来有点累。');await close();}
    report.status='completed';
  }catch(error){report.status='technical_failure';report.error={code:error.code??null,message:error.message};}
  finally{
    if(current)try{await close();}catch(error){report.cleanupError={code:error.code??null,message:error.message};try{const result=await current.e.close();report.forcedShutdown=result;}catch{} }
    report.actualDispatches=actualCount;report.finishedAt=new Date().toISOString();report.finalSourceDigests=await digests();report.sourceUnchanged=JSON.stringify(report.sourceDigests)===JSON.stringify(report.finalSourceDigests);
    report.limitations=['One sample per conversational condition, not a statistical evaluation.','No forced multi-bubble output or mandatory followup; scheduling and memory choices remain the persona’s.','The observation window is 2.5 seconds, not a long-term test.','UTF-8 input sizes are not tokenizer counts; cost is not estimated from bytes.'];
    await writeFile(join(dir,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({directory:dir,status:report.status,actualDispatches:report.actualDispatches,sourceUnchanged:report.sourceUnchanged,error:report.error,engines:report.engines.map(e=>({label:e.label,exit:e.exit,lockExists:e.lockExists}))}));
    if(report.status!=='completed'||!report.sourceUnchanged||report.cleanupError||report.engines.some(e=>e.exit?.code!==0||e.lockExists))process.exitCode=1;
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))runOnboardingReal().catch(error=>{console.error(JSON.stringify({status:'failed',code:error.code??null,message:error.message}));process.exitCode=1;});
