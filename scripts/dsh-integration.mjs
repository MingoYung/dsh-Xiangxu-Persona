import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const redact = value => String(value).replace(/\b(?:sk|key)-[A-Za-z0-9_-]{12,}\b/g, '[redacted-key]').replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[redacted]').replace(/((?:api[_-]?key|access[_-]?token|authorization)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]');
const safe = value => JSON.parse(redact(JSON.stringify(value)));
const textOf = message => (message?.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
const readJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };

export function optionsFrom(argv = process.argv.slice(2), env = process.env) {
  const flag = name => argv.includes(name);
  const value = (name, fallback) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; };
  const install = env.DSH_TEST_INSTALL ?? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'DSH NEXT');
  return { projectRoot, profile: 'persona-memory-validation', home: env.DSH_TEST_HOME ?? env.DSH_HOME ?? join(homedir(), '.dsh'),
    exe: join(install, 'DSH NEXT.exe'), cli: join(install, 'resources', 'app.asar', 'lib', 'desktop-cli.js'),
    pluginCli: join(install, 'resources', 'app.asar', 'lib', 'plugin-cli.js'),
    artifacts: resolve(value('--artifacts', env.DSH_TEST_ARTIFACTS ?? join(projectRoot, 'work', 'dsh-integration'))),
    fixtureOnly: flag('--fixture-only'), realOnly: flag('--real-only'), baseOnly: flag('--base-only'),
    provider: env.DSH_TEST_PROVIDER, model: env.DSH_TEST_MODEL,
    requestTimeout: Number(env.DSH_TEST_TIMEOUT_MS ?? 120000), installTimeout: Number(env.DSH_TEST_INSTALL_TIMEOUT_MS ?? 180000) };
}

async function nativeCommand(options, args, label, entry = options.cli) {
  const child = spawn(options.exe, [entry, ...args], { cwd: projectRoot, windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: options.home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
  const result = await new Promise((done, reject) => {
    const timer = setTimeout(() => { child.kill(); done({ code: null, timedOut: true }); }, options.installTimeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); done({ code, signal, timedOut: false }); });
  });
  await writeFile(join(options.artifacts, label + '.stdout.txt'), redact(stdout));
  await writeFile(join(options.artifacts, label + '.stderr.txt'), redact(stderr));
  return { ...result, stdout: redact(stdout), stderr: redact(stderr) };
}

async function prepareProfile(options) {
  const profileDir = join(options.home, 'profiles', options.profile);
  let manifest = await readJson(join(profileDir, 'package.json'));
  if (!manifest) {
    const init = await nativeCommand(options, ['--profile', options.profile, '--from-default-profile', 'sdk', '--help'], 'profile-init');
    if (init.code !== 0) throw Object.assign(new Error('Native SDK profile initialization failed; inspect profile-init diagnostics'), { code: 'PROFILE_INIT_FAILED' });
    manifest = await readJson(join(profileDir, 'package.json'));
  }
  const bundles = manifest?.dsh?.profile?.bundles ?? [];
  if (!bundles.includes('@deepseek-ai/dsh-sdk-app')) throw Object.assign(new Error('The named validation profile is not a dedicated SDK profile; refusing replacement'), { code: 'PROFILE_CONFLICT' });
  const unexpected = Object.keys(manifest.dependencies ?? {}).filter(x => x !== '@local/persona-memory');
  if (unexpected.length) throw Object.assign(new Error('Validation profile contains unrelated dependencies; refusing package changes'), { code: 'PROFILE_CONFLICT' });
  if (!options.baseOnly) {
    if (!existsSync(join(projectRoot, 'adapters', 'dsh', 'index.js'))) throw Object.assign(new Error('DSH adapter entry is not ready; no package operation started'), { code: 'ADAPTER_NOT_READY' });
    // This is the installed Desktop package-operation carrier, not a handwritten profile edit.
    const install = await nativeCommand(options, [options.profile, 'add', projectRoot], 'plugin-install', options.pluginCli);
    if (install.code !== 0) throw Object.assign(new Error('Native plugin installation failed; inspect plugin-install diagnostics'), { code: 'PLUGIN_INSTALL_FAILED' });
  }
  return profileDir;
}

const fixturePlugin = String.raw`
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export const inject = ['llm', 'agentDefaultModel'];
const txt = m => (m.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
const serial = v => JSON.parse(JSON.stringify(v, (k,x) => k === 'signal' ? undefined : x));
export function apply(ctx, config) {
  mkdirSync(config.artifacts, {recursive:true});
  const capture = (kind, options) => appendFileSync(join(config.artifacts,'requests.jsonl'), JSON.stringify({kind,at:Date.now(),provider:options.provider,model:options.model,tools:(options.tools||[]).map(x=>x.name),messages:serial(options.messages||[])})+'\n');
  const route = ctx.get('agentDefaultModel').currentSelection();
  process.stderr.write('PERSONA_VALIDATION_ROUTE '+JSON.stringify({provider:route.provider,model:route.model,reasoningEffort:route.reasoningEffort})+'\n');
  ctx.on('llm/stream', (options,next) => {capture('host-llm-stream-input',options);return next();});
  const captureState=(kind,agent,position={})=>{
    const state=ctx.get('personaMemory')?.agents?.get(agent?.id);
    appendFileSync(join(config.artifacts,'adapter-state.jsonl'),JSON.stringify({kind,at:Date.now(),sessionId:agent?.id,...position,
      currentTurn:state?.currentTurn,eventTurn:state?.eventTurn,
      admittedByTurn:state?[...state.admittedByTurn].map(([turn,ids])=>({turn,ids:[...ids]})):[],
      activeByTurn:state?[...state.activeByTurn.keys()]:[]})+'\n');
  };
  ctx.on('agent/pre-step',async(payload,next)=>{
    captureState('pre-step-before',payload.agent,{turn:payload.turn,step:payload.step});
    const decision=await next();captureState('pre-step-after',payload.agent,{turn:payload.turn,step:payload.step,decision:decision.kind});return decision;
  });
  ctx.on('session/event',(session,event)=>{
    if(['assistant/message','turn/end','user/message'].includes(event.type)) captureState(event.type,{id:session.id},{seq:event.seq,turn:event.data?.turn});
  });
  if (config.attachPreset) ctx.on('agent/created', async ({agent,source}) => {
    const presets=ctx.get('agentPresets');
    if(source==='resume') await presets.mount(agent.ctx,'persona-memory');
    else await presets.select(agent,'persona-memory');
    const coordinator=ctx.get('personaMemory');
    if(!coordinator) throw new Error('Persona coordinator is unavailable in the isolated test engine');
    await coordinator.attachAgent(agent);
    // Test isolation: scope-local persona tools survive; unrelated global coding tools are hidden.
    agent.ctx.tools.restrict({allow:[]});
  });
  if (!config.fixture) return;
  const provider = 'persona-fixture-validation';
  const metadata = (p,m) => ({provider:p,id:m,name:'Deterministic host integration fixture',context:{contextWindow:65536},defaultMaxTokens:4096,inputModalities:['text'],systemPromptUpdate:'in-history'});
  const tool = (name,args) => ({type:'tool-call',id:'fixture_'+randomUUID(),name,arguments:JSON.stringify(args)});
  const adapter = {
    providerInfo:p=>({id:p,name:'Deterministic validation fixture (not a real model)'}),
    providerRetryPolicy:()=>undefined, imageRequestPricing:()=>undefined,
    imageRequestTarget:(_p,_m,x)=>({width:x.width,height:x.height,maxBytes:x.bytes}),
    listModels:p=>Promise.resolve([{id:'fixture-v1',name:'Host fixture'}]),
    resolveModel:(p,m)=>Promise.resolve(metadata(p,m)),
    prepareCall:async(p,m)=>({model:metadata(p,m),stream:options=>adapter.stream(options)}),
    async *stream(options) {
      capture('fixture-provider-received-request',options);
      const messages=options.messages||[], joined=messages.map(txt).join('\n');
      let block;
      if (joined.includes('Organize this selected increment')) {
        let increment;try{increment=JSON.parse(txt(messages.at(-1)));}catch{increment={};}
        const currentRefs=(increment.input?.chat||[]).slice(0,2).map(r=>({sourceSessionId:r.sourceSessionId,sourceEventId:r.sourceEventId,available:true}));
        const refs=currentRefs.length?currentRefs:(increment.input?.context?.persona?.anchor?.srcRefs??[]);
        block={type:'text',text:JSON.stringify({entries:[{documentKey:'persona',expectedVersion:increment.inputVersions?.persona??0,operation:'upsert',recordId:'anchor',value:{text:'PM_GROWN_FIXTURE I retain the lavender-tea interaction as part of this test personality.',srcRefs:refs}}]})};
      }
      else if (joined.includes('Express a JSON decision using optional identityPlan')) {
        let context;try{context=JSON.parse(txt(messages.at(-1)));}catch{context={};}
        const env=context.environment||{};
        block={type:'text',text:JSON.stringify({replyPlan:{action:'reply',target:{channelId:env.channelId||'dsh:'+env.sessionId,sessionId:env.sessionId||'',personId:null},pendingEventIds:[],replyAt:null,reason:'fixture chooses to reply'},nextCheckAt:null})};
      } else if (!options.tools?.length) block={type:'text',text:'PM_WAKE fixture independent reply'};
      else {
        let start=-1,sid='',which='normal';
        for(let i=0;i<messages.length;i++){const m=messages[i],s=txt(m),match=s.match(/PM_SESSION\s+(\S+)\s+PM_CASE\s+(\S+)/);if(m.role==='user'&&m.source?.kind==='user'&&match){start=i;sid=match[1];which=match[2].replace(/[.,;:]$/,'');}}
        const recent=messages.slice(start+1),calls=recent.flatMap(m=>(m.content||[]).filter(b=>b.type==='tool-call'));
        const has=name=>calls.some(c=>c.name===name);
        const target={channelId:'dsh:'+sid,sessionId:sid,personId:null};
        if(which==='sleep'&&!has('persona_decide')) block=tool('persona_decide',{sleepPlan:{action:'sleep',wakeCondition:'at_time',wakeAt:Date.now()+5000,reason:'fixture model chooses five second sleep'},nextCheckAt:null});
        else if(which==='event_sleep'&&!has('persona_decide')) block=tool('persona_decide',{sleepPlan:{action:'sleep',wakeCondition:'explicit_wake',wakeAt:null,reason:'fixture chooses event-based sleep'},nextCheckAt:null});
        else if(which.startsWith('queued')||which==='sleep'||which==='event_sleep') block={type:'text',text:'PM_WAKE queued messages received after fixture sleep'};
        else if(which==='inactive'&&!has('persona_decide')) block=tool('persona_decide',{replyPlan:{action:'listen',target,pendingEventIds:[],replyAt:null,recheckOn:['explicit_wake'],reason:'fixture chooses a timer across process restart'},nextCheckAt:Date.now()+6000});
        else if(which==='inactive'&&!calls.some(c=>{try{return c.name==='persona_decide'&&JSON.parse(c.arguments).replyPlan?.action==='reply';}catch{return false;}})) block=tool('persona_decide',{replyPlan:{action:'reply',target,pendingEventIds:[],replyAt:null,reason:'fixture replies after inactive target recovery'},nextCheckAt:null});
        else if(which==='inactive') block={type:'text',text:'PM_INACTIVE_RESUME scheduled decision recovered without SDK resume'};
        else if(which==='wait'&&!has('persona_decide')) block=tool('persona_decide',{replyPlan:{action:'listen',target,pendingEventIds:[],replyAt:null,recheckOn:['explicit_wake'],reason:'fixture chooses to listen until its own timer'},nextCheckAt:Date.now()+2000});
        else if(which==='wait'&&!calls.some(c=>{try{return c.name==='persona_decide'&&JSON.parse(c.arguments).replyPlan?.action==='reply';}catch{return false;}})) block=tool('persona_decide',{replyPlan:{action:'reply',target,pendingEventIds:[],replyAt:null,reason:'fixture decides to reply after selected recheck'},nextCheckAt:null});
        else if(which==='wait'||which==='wait_queued') block={type:'text',text:'PM_WAIT_RECHECK original pending input was available'};
        else if(!has('persona_decide')) block=tool('persona_decide',{replyPlan:{action:'reply',target,pendingEventIds:[],replyAt:null,reason:'fixture model chooses ordinary reply'},nextCheckAt:null});
        else if(!has('memory_search')) block=tool('memory_search',{query:'PM_FACT lavender-tea',scope:'all',limit:5});
        else block={type:'text',text:'PM_FINAL_normal lavender-tea'};
      }
      yield {type:'block-start',index:0,blockType:block.type};
      if(block.type==='text') yield {type:'text-delta',index:0,text:block.text};
      else yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};
      yield {type:'block-end',index:0,block};
      yield {type:'finish',reason:{kind:'stop'}};
    }
  };
  ctx.llm.registerAdapter([provider],adapter);
}
`;

async function writeOverlay(options, dir, fixture) {
  await mkdir(dir, { recursive: true });
  const plugin = join(options.artifacts, 'host-validation-plugin.mjs');
  await writeFile(plugin, fixturePlugin);
  const overlay = join(dir, 'test-overlay.yml');
  const entries = [
    { id: 'tools', config: { mode: 'native' } },
    { insert: [
      ...(!options.baseOnly ? [{ id:'agent-preset-registry',name:'@deepseek-ai/dsh-agent-preset-registry',config:{default:'persona-memory'} }] : []),
      { id:'persona-validation-probe',name:pathToFileURL(plugin).href,config:{artifacts:dir,fixture,attachPreset:!options.baseOnly} },
    ] },
  ];
  // JSON is a valid YAML patch-list representation and avoids quoting local paths.
  await writeFile(overlay, JSON.stringify(entries,null,2));
  return overlay;
}

async function operatorCommand(memoryRoot, command, dir) {
  const child=spawn(process.execPath,[join(projectRoot,'scripts','persona-cli.mjs'),'--root',memoryRoot,command],{cwd:projectRoot,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',x=>{stdout+=x;});child.stderr.on('data',x=>{stderr+=x;});
  const code=await new Promise((done,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Object.assign(new Error('Operator CLI timed out'),{code:'OPERATOR_TIMEOUT'}));},35000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);done(code);});});
  let response;try{response=JSON.parse(stdout);}catch{throw Object.assign(new Error('Operator CLI did not return JSON'),{code:'OPERATOR_PROTOCOL'});}
  await appendFile(join(dir,'operator.jsonl'),JSON.stringify(safe({command,code,response,stderr}))+'\n');
  if(code!==0||!response.ok)throw Object.assign(new Error('Operator command failed: '+command),{code:'OPERATOR_FAILED',data:safe(response)});
  return response;
}

class RpcProcess {
  constructor(options, overlay, dir, memoryRoot) {
    this.options=options;this.dir=dir;this.events=[];this.pending=new Map();this.counter=0;this.route=null;this.closed=false;this.lines='';this.stderrLines='';this.logTail=Promise.resolve();
    this.child=spawn(options.exe,[options.cli,'--profile',options.profile,'--patch',overlay],{cwd:projectRoot,windowsHide:true,
      env:{...process.env,ELECTRON_RUN_AS_NODE:'1',DSH_HOME:options.home,PERSONA_MEMORY_ROOT:memoryRoot},stdio:['pipe','pipe','pipe']});
    this.child.stdout.setEncoding('utf8');this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data',chunk=>{this.lines+=chunk;let i;while((i=this.lines.indexOf('\n'))>=0){const line=this.lines.slice(0,i);this.lines=this.lines.slice(i+1);this.consume(line);}});
    this.child.stderr.on('data',chunk=>{this.logTail=this.logTail.then(()=>appendFile(join(dir,'stderr.txt'),redact(chunk)));this.stderrLines+=chunk;let i;while((i=this.stderrLines.indexOf('\n'))>=0){const line=this.stderrLines.slice(0,i);this.stderrLines=this.stderrLines.slice(i+1);if(line.startsWith('PERSONA_VALIDATION_ROUTE ')){try{this.route=JSON.parse(line.slice('PERSONA_VALIDATION_ROUTE '.length));}catch{}}}});
    this.exit=new Promise(done=>{this.child.once('close',(code,signal)=>{this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Object.assign(new Error('DSH child exited before RPC response'),{code:'CHILD_EXIT',exitCode:code}));}this.pending.clear();done({code,signal});});});
    this.child.once('error',error=>{this.spawnError=error;});
  }
  consume(line) {
    let frame;try{frame=JSON.parse(line);}catch{this.protocolNoise=(this.protocolNoise||[]).concat(redact(line)).slice(-10);return;}
    this.logTail=this.logTail.then(()=>appendFile(join(this.dir,'rpc.jsonl'),JSON.stringify(safe(frame))+'\n'));
    if(frame.id!==undefined){const p=this.pending.get(frame.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(frame.id);if(frame.error)p.reject(Object.assign(new Error(redact(frame.error.message)),{code:frame.error.code,data:safe(frame.error.data??null)}));else p.resolve(frame.result);}
    else if(frame.method)this.events.push(frame);
  }
  request(method,params={},timeout=this.options.requestTimeout) {
    if(this.closed)return Promise.reject(Object.assign(new Error('DSH process is closed'),{code:'CHILD_CLOSED'}));
    const id=++this.counter;
    this.logTail=this.logTail.then(()=>appendFile(join(this.dir,'client-requests.jsonl'),JSON.stringify(safe({jsonrpc:'2.0',id,method,params}))+'\n'));
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Object.assign(new Error('RPC timeout for '+method),{code:'RPC_TIMEOUT'}));},timeout);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  }
  async waitFor(predicate,timeout=this.options.requestTimeout){const until=Date.now()+timeout;while(Date.now()<until){const result=await predicate();if(result)return result;const broken=this.events.find(f=>f.method==='session.event'&&f.params.event.type==='turn/end'&&f.params.event.data.reason?.kind==='error');if(broken){const detail=broken.params.event.data.reason.error??{};throw Object.assign(new Error(redact(detail.message??'Native DSH turn failed')),{code:detail.code??'HOST_TURN_ERROR',data:safe(detail)});}if(this.closed)throw Object.assign(new Error('DSH process closed while waiting'),{code:'CHILD_CLOSED'});await sleep(30);}throw Object.assign(new Error('Condition timed out'),{code:'CONDITION_TIMEOUT'});}
  eventsFor(sid){return this.events.filter(f=>f.method==='session.event'&&f.params.sessionId===sid).map(f=>f.params.event);}
  async close(){if(this.closed){await this.logTail;return this.exit;}try{await this.request('shutdown',{},10000);}catch{}this.child.stdin.end();let waitTimer;const ended=await Promise.race([this.exit,new Promise(done=>{waitTimer=setTimeout(()=>done(null),10000);})]);clearTimeout(waitTimer);if(!ended){this.child.kill();await this.exit;}await this.logTail;return ended??this.exit;}
}

function summarizeSession(events){const calls=events.filter(e=>e.type==='tool/call').map(e=>e.data?.name??e.data?.toolName??e.data?.call?.name);const assistant=events.filter(e=>e.type==='assistant/message');return {eventCount:events.length,toolCalls:calls,visibleAssistant:assistant.map(e=>({seq:e.seq,time:e.time,text:textOf(e.data.message)})).filter(x=>x.text),turnEnds:events.filter(e=>e.type==='turn/end').map(e=>safe(e.data))};}
async function dialogueRecords(memoryRoot) {
  const paths=[join(memoryRoot,'staging','events.jsonl')];
  for(const entry of await readdir(join(memoryRoot,'people'),{withFileTypes:true}).catch(()=>[]))if(entry.isDirectory())paths.push(join(memoryRoot,'people',entry.name,'stream.jsonl'));
  const records=[];for(const path of paths){try{records.push(...(await readFile(path,'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)));}catch(error){if(error.code!=='ENOENT')throw error;}}
  return records;
}
const errorSummary=error=>({code:error.code??error.name,message:redact(error.message),data:safe(error.data??null)});

async function runEngine(options, fixture) {
  const label=fixture?'deterministic-host-fixture':'real-model';const dir=join(options.runArtifacts??options.artifacts,label);const memoryRoot=join(dir,'memory');await mkdir(memoryRoot,{recursive:true});
  const sourceDigests={};for(const file of ['adapters/dsh/index.js','adapters/dsh/model.js','adapters/dsh/normalize.js','adapters/dsh/control.js','core/index.js','core/runtime.js','core/repository.js','core/store.js','core/schema.js','core/prompts.js','package.json','cordis.patch.yml','scripts/dsh-integration.mjs']){try{sourceDigests[file]=createHash('sha256').update(await readFile(join(projectRoot,file))).digest('hex');}catch{}}
  const overlay=await writeOverlay(options,dir,fixture);const rpc=new RpcProcess(options,overlay,dir,memoryRoot);const report={label,fixture,sourceDigests,startedAt:new Date().toISOString(),checks:{},memoryRoot,claims:{realDshEngine:true,realModel:!fixture&&!options.baseOnly,externalHttpWireObserved:false}};
  try {
    await rpc.waitFor(()=>rpc.route||rpc.spawnError,20000);if(rpc.spawnError)throw rpc.spawnError;
    const provider=fixture?'persona-fixture-validation':options.provider??rpc.route?.provider??'deepseek-official';
    const model=fixture?'fixture-v1':options.model??rpc.route?.model??'deepseek-flash';
    report.route={provider,model,source:fixture?'test-only deterministic provider':options.provider||options.model?'explicit test environment':'host non-secret default selection'};
    report.initialize=await rpc.request('initialize',{cwd:projectRoot,provider,model,maxTokens:4096});
    report.checks.initialized=report.initialize.serverInfo?.name==='deepseek-harness-sdk-runtime';
    if(options.baseOnly){report.status='base-initialize-passed';return report;}
    const sid='persona_validation_'+(fixture?'fixture_':'real_')+randomUUID().replaceAll('-','');report.sessionId=sid;
    const prompt='PM_SESSION '+sid+' PM_CASE normal PM_FACT lavender-tea. This is a dedicated integration test. First use persona_decide to choose a reply for this session (not sleep). Then use memory_search with scope all for PM_FACT. Finally answer briefly and include PM_FINAL_normal. I prefer lavender tea.';
    report.promptReceipt=await rpc.request('session/prompt',{sessionId:sid,contentBlocks:[{type:'text',text:prompt}]});
    await rpc.request('session/wait',{sessionId:sid});
    let normal=summarizeSession(rpc.eventsFor(sid));report.normal=normal;
    report.checks.personaDecideCalled=normal.toolCalls.includes('persona_decide');report.checks.memorySearchCalled=normal.toolCalls.includes('memory_search');report.checks.visibleFinal=normal.visibleAssistant.some(x=>x.text.includes('PM_FINAL_normal'));
    const requests=await readFile(join(dir,'requests.jsonl'),'utf8').then(s=>s.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x))).catch(()=>[]);
    const providerRequests=requests.filter(x=>x.kind==='fixture-provider-received-request');
    const thisSessionRequests=(fixture?providerRequests:requests).filter(x=>x.messages.some(m=>textOf(m).includes(sid)));
    report.checks.personaToolsInActualRequest=thisSessionRequests.some(x=>x.tools.includes('persona_decide')&&x.tools.includes('memory_search'));
    report.checks.personaTextInActualRequest=thisSessionRequests.some(x=>x.messages.some(m=>textOf(m).includes('[environment]')&&textOf(m).includes('[relationship]')));
    report.requestObservation=fixture?'The deterministic provider received these actual DSH request messages; no external HTTP model was involved.':'Observed llm/stream host request input; external provider HTTP wire was not captured.';
    if(fixture){
      const before=rpc.eventsFor(sid).length;
      await rpc.request('session/prompt',{sessionId:sid,contentBlocks:[{type:'text',text:'PM_SESSION '+sid+' PM_CASE sleep. Choose a five-second sleep through persona_decide.'}]});
      await rpc.waitFor(async()=>{const state=await readJson(join(memoryRoot,'global','state.json'));return state?.sleep?.state==='sleeping'?state:null;},20000);
      const sleeping=await readJson(join(memoryRoot,'global','state.json'));report.sleepChosen=safe(sleeping.sleep);const wakeAt=sleeping.sleep.wakeAt;
      await rpc.request('session/prompt',{sessionId:sid,contentBlocks:[{type:'text',text:'PM_SESSION '+sid+' PM_CASE queued1. First message while asleep.'}]});
      await rpc.request('session/prompt',{sessionId:sid,contentBlocks:[{type:'text',text:'PM_SESSION '+sid+' PM_CASE queued2. Second message while asleep.'}]});
      await sleep(Math.max(0,Math.min(1000,wakeAt-Date.now()-100)));
      const during=rpc.eventsFor(sid).slice(before).filter(e=>e.type==='assistant/message'&&e.time<wakeAt&&textOf(e.data.message));
      report.checks.sleepHasNoVisibleOutput=during.length===0;
      await rpc.waitFor(()=>rpc.eventsFor(sid).some(e=>e.type==='assistant/message'&&e.time>=wakeAt&&textOf(e.data.message).includes('PM_WAKE')),30000);
      await rpc.request('session/wait',{sessionId:sid});
      report.afterWake=summarizeSession(rpc.eventsFor(sid));
      report.checks.wokeAndReplied=report.afterWake.visibleAssistant.some(x=>x.time>=wakeAt&&x.text.includes('PM_WAKE'));
      const state=await readJson(join(memoryRoot,'global','state.json'));report.checks.awakeRestored=state?.sleep?.state==='awake';
      report.checks.singleWakeVisibleReply=report.afterWake.visibleAssistant.filter(x=>x.time>=wakeAt&&x.text.includes('PM_WAKE')).length===1;
      const grown=await rpc.waitFor(async()=>{const p=await readJson(join(memoryRoot,'self','persona.json'));return p?.version>0&&p.anchor?.text?.startsWith('PM_GROWN_FIXTURE')?p:null;},15000);
      report.consolidation={personaVersion:grown.version,anchorText:grown.anchor.text,sourceReferences:grown.anchor.srcRefs?.length??0};
      report.checks.nonemptyConsolidationCommitted=grown.version>0&&grown.anchor.text.includes('PM_GROWN_FIXTURE');
      const files=['staging/events.jsonl','journal/intake.jsonl'];const allRecords=[];for(const name of files){try{allRecords.push(await readFile(join(memoryRoot,name),'utf8'));}catch{}}
      report.checks.queuedInputsRecorded=allRecords.some(x=>x.includes('queued1'))&&allRecords.some(x=>x.includes('queued2'));
      // Exercise rejection independently of sleep: persona itself chooses a timed recheck.
      await rpc.request('session/prompt',{sessionId:sid,contentBlocks:[{type:'text',text:'PM_SESSION '+sid+' PM_CASE wait. Choose listen and reconsider in two seconds.'}]});
      const waitState=await rpc.waitFor(async()=>{const value=await readJson(join(memoryRoot,'global','state.json'));return value?.currentDecision?.replyPlan?.action==='listen'&&value.schedule?.nextCheckAt?value:null;},20000);
      const marker='PM_REJECTED_ORIGINAL_'+randomUUID().replaceAll('-','');report.waitMarker=marker;report.recheckAt=waitState.schedule.nextCheckAt;
      const pendingReceipt=await rpc.request('session/prompt',{sessionId:sid,contentBlocks:[{type:'text',text:'PM_SESSION '+sid+' PM_CASE wait_queued '+marker+' Keep this actual input available after the current listen decision.'}]});
      await sleep(Math.max(0,Math.min(300,report.recheckAt-Date.now()-100)));
      report.checks.listenRejectedBeforeRecheck=!rpc.eventsFor(sid).some(e=>e.type==='user/message'&&e.data.id===pendingReceipt.messageId&&e.time<report.recheckAt);
      await rpc.waitFor(()=>rpc.eventsFor(sid).some(e=>e.type==='assistant/message'&&e.time>=report.recheckAt&&textOf(e.data.message).includes('PM_WAIT_RECHECK')),30000);
      await rpc.request('session/wait',{sessionId:sid});
      const observed=await readFile(join(dir,'requests.jsonl'),'utf8').then(s=>s.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)));
      report.checks.rejectedOriginalInProviderRequest=observed.some(x=>x.kind==='fixture-provider-received-request'&&x.at>=report.recheckAt&&x.messages.some(m=>textOf(m).includes(marker)));
      report.checks.timedRecheckProducedVisibleReply=rpc.eventsFor(sid).some(e=>e.type==='assistant/message'&&e.time>=report.recheckAt&&textOf(e.data.message).includes('PM_WAIT_RECHECK'));
      const operatorStatus=await operatorCommand(memoryRoot,'status',dir);report.checks.operatorStatus=operatorStatus.result?.available===true;
      await operatorCommand(memoryRoot,'mute',dir);
      const muted=await operatorCommand(memoryRoot,'status',dir);report.checks.operatorMute=muted.result?.runtime?.globalMuted===true;
      await operatorCommand(memoryRoot,'resume',dir);
      const resumed=await operatorCommand(memoryRoot,'status',dir);report.checks.operatorResume=resumed.result?.runtime?.globalMuted===false;
      const explicitStart=Date.now();
      await rpc.request('session/prompt',{sessionId:sid,contentBlocks:[{type:'text',text:'PM_SESSION '+sid+' PM_CASE event_sleep. Choose sleep until an explicit wake signal.'}]});
      await rpc.waitFor(async()=>{const s=await readJson(join(memoryRoot,'global','state.json'));return s?.sleep?.state==='sleeping'&&s.sleep.wakeCondition==='explicit_wake';},20000);
      report.checks.eventSleepNeedsNoWallClock=(await readJson(join(memoryRoot,'global','state.json'))).sleep.wakeAt===null;
      await operatorCommand(memoryRoot,'wake',dir);
      await rpc.waitFor(()=>rpc.eventsFor(sid).some(e=>e.type==='assistant/message'&&e.time>=explicitStart&&textOf(e.data.message).includes('PM_WAKE')),30000);
      await rpc.request('session/wait',{sessionId:sid});
      report.checks.operatorExplicitWake=(await readJson(join(memoryRoot,'global','state.json')))?.sleep?.state==='awake';
      await rpc.close();
      // Native session/wait drains the agent loop, not the plugin's async intake.
      // Shutdown disposes the coordinator and waits for intake before this baseline.
      const beforeRestart=await dialogueRecords(memoryRoot);
      const restartDir=join(dir,'restart');await mkdir(restartDir,{recursive:true});
      const restartOverlay=await writeOverlay(options,restartDir,true);const restarted=new RpcProcess(options,restartOverlay,restartDir,memoryRoot);
      try {
        await restarted.waitFor(()=>restarted.route,20000);
        await restarted.request('initialize',{cwd:projectRoot,provider,model,maxTokens:4096});
        await restarted.request('session/resume',{sessionId:sid});await restarted.request('session/wait',{sessionId:sid});
        const afterResume=await dialogueRecords(memoryRoot);
        const key=r=>r.sourceSessionId+'|'+r.sourceEventId+'|'+r.role;
        const beforeKeys=new Set(beforeRestart.map(key)), afterKeys=new Set(afterResume.map(key));
        report.resumeDialogue={beforeCount:beforeRestart.length,afterCount:afterResume.length,
          added:afterResume.filter(r=>!beforeKeys.has(key(r))).map(r=>({sourceEventId:r.sourceEventId,role:r.role,sourceKind:r.sourceKind})),
          removed:beforeRestart.filter(r=>!afterKeys.has(key(r))).map(r=>({sourceEventId:r.sourceEventId,role:r.role,sourceKind:r.sourceKind}))};
        report.checks.resumeDoesNotDuplicateDialogue=afterResume.length===beforeRestart.length&&new Set(afterResume.map(key)).size===afterResume.length;
        const restartPrompt='PM_SESSION '+sid+' PM_CASE normal PM_FACT after_restart. Dedicated restart test: choose reply via persona_decide, search memory, then say PM_FINAL_normal.';
        const restartReceipt=await restarted.request('session/prompt',{sessionId:sid,contentBlocks:[{type:'text',text:restartPrompt}]});await restarted.request('session/wait',{sessionId:sid});
        const restartSummary=summarizeSession(restarted.eventsFor(sid));report.restart=restartSummary;
        report.checks.resumedAgentUsesPersonaTools=restartSummary.toolCalls.includes('persona_decide')&&restartSummary.toolCalls.includes('memory_search');
        report.checks.resumedAgentReplies=restartSummary.visibleAssistant.some(x=>x.text.includes('PM_FINAL_normal'));
        await restarted.request('session/prompt',{sessionId:sid,contentBlocks:[{type:'text',text:'PM_SESSION '+sid+' PM_CASE inactive. Choose your own six second recheck, then listen.'}]});
        const inactiveState=await restarted.waitFor(async()=>{const s=await readJson(join(memoryRoot,'global','state.json'));return s?.currentDecision?.replyPlan?.action==='listen'&&s.schedule?.nextCheckAt?s:null;},20000);
        report.inactiveRecheckAt=inactiveState.schedule.nextCheckAt;await restarted.close();
        const inactiveDir=join(dir,'inactive-resume');await mkdir(inactiveDir,{recursive:true});
        const inactiveOverlay=await writeOverlay(options,inactiveDir,true);const inactive=new RpcProcess(options,inactiveOverlay,inactiveDir,memoryRoot);
        try {
          await inactive.waitFor(()=>inactive.route,20000);
          await inactive.request('initialize',{cwd:projectRoot,provider,model,maxTokens:4096});
          // Deliberately no session/resume or session/prompt: runtime's chosen timer must restore its target.
          await inactive.waitFor(()=>inactive.eventsFor(sid).some(e=>e.type==='assistant/message'&&textOf(e.data.message).includes('PM_INACTIVE_RESUME')),30000);
          report.checks.inactiveTargetAutoResumed=inactive.eventsFor(sid).some(e=>e.type==='assistant/message'&&textOf(e.data.message).includes('PM_INACTIVE_RESUME'));
          const autoRequests=await readFile(join(inactiveDir,'requests.jsonl'),'utf8').then(s=>s.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)));
          report.checks.inactiveResumePersonaRequest=autoRequests.some(x=>x.kind==='fixture-provider-received-request'&&x.tools.includes('persona_decide')&&x.messages.some(m=>textOf(m).includes('[relationship]')));
          const coldControls=inactive.eventsFor(sid).filter(e=>e.type==='user/message'&&e.data.source?.kind==='persona-memory:control');
          report.checks.completedReplyIsNotPendingAgain=coldControls.length>0&&coldControls.every(e=>!(e.data.source.pendingSourceRefs??[]).some(r=>r.sourceEventId===restartReceipt.messageId));
          report.inactiveResumeActivation='Native runtime timer only; SDK initialize, no external session/resume or prompt';
        } finally {report.inactiveExit=await inactive.close();}
      } finally {report.restartExit=await restarted.close();}
    }
    report.status=Object.values(report.checks).every(Boolean)?'passed':'failed';
  }catch(error){report.status='failed';report.error=errorSummary(error);report.eventsSeen=rpc.events.length;report.protocolNoise=rpc.protocolNoise;}
  finally{report.exit=await rpc.close();report.finishedAt=new Date().toISOString();await writeFile(join(dir,'result.json'),JSON.stringify(safe(report),null,2));}
  return report;
}

export async function runIntegration(options=optionsFrom()) {
  await mkdir(options.artifacts,{recursive:true});
  if(!existsSync(options.exe))throw Object.assign(new Error('Installed DSH NEXT executable was not found'),{code:'HOST_NOT_FOUND'});
  if(Boolean(options.provider)!==Boolean(options.model))throw new Error('Set DSH_TEST_PROVIDER and DSH_TEST_MODEL together');
  await prepareProfile(options);
  options.runArtifacts=join(options.artifacts,'run-'+Date.now()+'-'+randomUUID().slice(0,8));await mkdir(options.runArtifacts,{recursive:true});
  const result={runArtifacts:options.runArtifacts,startedAt:new Date().toISOString(),profile:options.profile,home:options.home,projectRoot,artifactRoot:options.artifacts,runs:[]};
  if(!options.fixtureOnly)result.runs.push(await runEngine(options,false));
  if(!options.realOnly&&!options.baseOnly)result.runs.push(await runEngine(options,true));
  result.finishedAt=new Date().toISOString();result.status=result.runs.every(x=>x.status==='passed'||x.status==='base-initialize-passed')?'passed':'partial-or-failed';
  await writeFile(join(options.artifacts,'result.json'),JSON.stringify(safe(result),null,2));
  return result;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  runIntegration().then(result=>{console.log(JSON.stringify({status:result.status,artifactRoot:result.artifactRoot,runs:result.runs.map(x=>({label:x.label,status:x.status,route:x.route,checks:x.checks,error:x.error}))},null,2));process.exitCode=result.status==='passed'?0:1;}).catch(error=>{console.error(JSON.stringify(errorSummary(error)));process.exitCode=1;});
}
