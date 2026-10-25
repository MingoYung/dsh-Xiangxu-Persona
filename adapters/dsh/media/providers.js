import { LIMITS, endpoint, fields, object, plain, fail, hash, responseBytes, mediaInfo, clone } from './io.js';

export const MEDIA_PROVIDER_SOURCES = Object.freeze({ checkedOn:'2026-10-26', images:'https://developers.openai.com/api/reference/resources/images', comfyui:'https://docs.comfy.org/development/comfyui-server/comms_routes' });
const binding = value => /^[A-Za-z0-9_-]{1,80}$/.test(value);
export function providerConfig(kind, patch, prior = {}) {
  if (!['image','video'].includes(kind)) fail('MEDIA_INVALID','请选择图片或视频服务');
  fields(patch,['type','enabled','baseUrl','apiKey','clearApiKey','model','referenceMode','editTransport','downloadOrigins','workflow','promptNode','promptInput','referenceNode','referenceInput','outputNodeIds','allowRemote']);
  const next={kind,type:kind==='image'?'openai-images':'comfyui',enabled:false,baseUrl:'',apiKey:'',model:'',referenceMode:'none',editTransport:'json',downloadOrigins:[],workflow:null,promptNode:'',promptInput:'text',referenceNode:'',referenceInput:'image',outputNodeIds:[],allowRemote:false,...clone(prior),...clone(patch)};delete next.clearApiKey;
  if(patch.apiKey==='')next.apiKey=prior.apiKey??'';if(patch.clearApiKey!==undefined&&typeof patch.clearApiKey!=='boolean')fail('MEDIA_INVALID','清除密钥标记无效');if(patch.clearApiKey){if(patch.apiKey)fail('MEDIA_INVALID','不能同时更新并清除密钥');next.apiKey='';}
  if(!['openai-images','comfyui'].includes(next.type)||kind==='video'&&next.type!=='comfyui'||typeof next.enabled!=='boolean'||typeof next.allowRemote!=='boolean'||!['none','edit'].includes(next.referenceMode)||!['json','multipart'].includes(next.editTransport))fail('MEDIA_PROVIDER_CONFIG','服务类型或开关无效');
  plain(next.apiKey,'密钥',8192,true);plain(next.model,'模型',256,true);plain(next.baseUrl,'服务地址',2048,true);if(next.baseUrl)next.baseUrl=endpoint(next.baseUrl,next.allowRemote);
  if(/[\r\n\t]/.test(next.apiKey))fail('MEDIA_PROVIDER_CONFIG','API密钥不能包含换行或制表符');
  if(!Array.isArray(next.downloadOrigins)||next.downloadOrigins.length>8)fail('MEDIA_PROVIDER_CONFIG','额外下载来源无效');next.downloadOrigins=[...new Set(next.downloadOrigins.map(value=>{const checked=endpoint(value,next.allowRemote),url=new URL(checked);if(url.pathname!=='/'&&url.pathname!=='')fail('MEDIA_PROVIDER_CONFIG','下载来源只填写协议和主机');return url.origin;}))];
  for(const name of['promptNode','promptInput','referenceNode','referenceInput'])if(typeof next[name]!=='string'||next[name]&&!binding(next[name]))fail('MEDIA_PROVIDER_CONFIG','工作流绑定无效');
  if(!Array.isArray(next.outputNodeIds)||next.outputNodeIds.length>16||next.outputNodeIds.some(value=>typeof value!=='string'||!binding(value)))fail('MEDIA_PROVIDER_CONFIG','工作流输出节点无效');
  if(next.workflow!==null){if(!object(next.workflow)||Object.keys(next.workflow).length>256||Buffer.byteLength(JSON.stringify(next.workflow))>LIMITS.workflowBytes)fail('MEDIA_PROVIDER_CONFIG','工作流大小或格式无效');for(const node of Object.values(next.workflow))if(!object(node)||typeof node.class_type!=='string'||!object(node.inputs))fail('MEDIA_PROVIDER_CONFIG','请提供ComfyUI API格式的节点工作流');}
  if(next.type==='comfyui'&&next.workflow){if(!next.promptNode||!next.promptInput||!object(next.workflow[next.promptNode]?.inputs)||!Object.hasOwn(next.workflow[next.promptNode].inputs,next.promptInput))fail('MEDIA_PROVIDER_CONFIG','找不到提示词输入绑定');if(next.referenceMode==='edit'&&(!next.referenceNode||!next.referenceInput||!object(next.workflow[next.referenceNode]?.inputs)||!Object.hasOwn(next.workflow[next.referenceNode].inputs,next.referenceInput)))fail('MEDIA_PROVIDER_CONFIG','找不到参考图输入绑定');for(const id of next.outputNodeIds)if(!Object.hasOwn(next.workflow,id))fail('MEDIA_PROVIDER_CONFIG','找不到输出节点');}
  return next;
}
export function configured(value){return Boolean(value.baseUrl&&(value.type==='openai-images'?value.model:value.workflow&&value.promptNode&&value.promptInput));}
export function publicProvider(value, includeConfiguration=false){const{apiKey,workflow,...rest}=clone(value);return{...rest,...(includeConfiguration?{workflow}:{}),hasApiKey:Boolean(apiKey),configured:configured(value),capabilities:{generate:configured(value),reference:configured(value)&&value.referenceMode==='edit',asynchronous:value.type==='comfyui'},workflowConfigured:Boolean(workflow),...(workflow?{workflowSha256:hash(workflow)}:{})};}
export function fingerprint(value){const{apiKey,...publicConfig}=value;return hash(publicConfig);}
const join=(base,route)=>base.replace(/\/$/,'')+'/'+route.replace(/^\//,'');
async function request(fetchImpl,config,route,{body,method='GET',signal,json=true,max=LIMITS.responseBytes,form=false}={}){
  const headers={...(config.apiKey?{authorization:'Bearer '+config.apiKey}:{}),...(!form&&body!==undefined?{'content-type':'application/json'}:{})};
  let response;try{response=await fetchImpl(join(config.baseUrl,route),{method,headers,body:body===undefined?undefined:form?body:JSON.stringify(body),redirect:'error',signal});}catch(error){if(signal?.aborted)throw error;fail('MEDIA_NETWORK','媒体服务请求未获得确认');}
  if(!response.ok)fail('MEDIA_PROVIDER_HTTP','媒体服务返回HTTP '+response.status);
  const bytes=await responseBytes(response,max);if(!json)return bytes;
  try{return JSON.parse(bytes.toString('utf8'));}catch{fail('MEDIA_PROVIDER_RESPONSE','媒体服务没有返回有效JSON');}
}
export async function probeProvider(fetchImpl,config,signal){
  if(!configured(config))return{reachable:false,configurationValid:false,verifiedGeneration:false,reason:'provider_not_configured'};
  const result=await request(fetchImpl,config,config.type==='comfyui'?'object_info':'models/'+encodeURIComponent(config.model),{signal,max:LIMITS.responseBytes});
  if(config.type==='comfyui'){if(!object(result))fail('MEDIA_PROVIDER_RESPONSE','ComfyUI节点目录无效');const missing=[...new Set(Object.values(config.workflow).map(node=>node.class_type))].filter(name=>!Object.hasOwn(result,name));return{reachable:true,configurationValid:missing.length===0,missingNodeTypes:missing,verifiedGeneration:false};}
  return{reachable:true,configurationValid:typeof result?.id==='string',verifiedGeneration:false,model:typeof result?.id==='string'?result.id:null};
}
export async function submit(fetchImpl,config,job,reference,signal){
  if(reference&&config.referenceMode!=='edit')fail('MEDIA_REFERENCE_UNSUPPORTED','当前服务未配置参考图能力，没有降级为纯文字生成');
  if(config.type==='openai-images'){
    let body,form=false,route='images/generations';
    if(reference){route='images/edits';if(config.editTransport==='multipart'){form=true;body=new FormData();body.append('model',config.model);body.append('prompt',job.prompt);body.append('n','1');if(job.size)body.append('size',job.size);body.append('image[]',new Blob([reference.bytes],{type:reference.mime}),reference.filename);}else body={model:config.model,prompt:job.prompt,n:1,images:[{image_url:'data:'+reference.mime+';base64,'+reference.bytes.toString('base64')}],...(job.size?{size:job.size}:{})};}
    else body={model:config.model,prompt:job.prompt,n:1,...(job.size?{size:job.size}:{})};
    const response=await request(fetchImpl,config,route,{method:'POST',body,form,signal});
    if(!Array.isArray(response?.data)||response.data.length!==1)fail('MEDIA_PROVIDER_RESPONSE','图片服务没有返回一张可核实的结果');
    const item=response.data[0];let bytes;
    if(typeof item.b64_json==='string'){if(item.b64_json.length>Math.ceil(LIMITS.imageBytes*4/3)+4||!/^[A-Za-z0-9+/]*={0,2}$/.test(item.b64_json)||item.b64_json.length%4!==0)fail('MEDIA_PROVIDER_RESPONSE','图片Base64无效或超限');bytes=Buffer.from(item.b64_json,'base64');}
    else if(typeof item.url==='string')bytes=await downloadResult(fetchImpl,config,item.url,'image',signal);
    else fail('MEDIA_PROVIDER_RESPONSE','图片服务未返回图片字节或下载地址');
    mediaInfo(bytes,'image');return{status:'completed',outputs:[{bytes,name:'generated-image'}]};
  }
  const workflow=clone(config.workflow);workflow[config.promptNode].inputs[config.promptInput]=job.prompt;
  if(reference){const form=new FormData();form.append('image',new Blob([reference.bytes],{type:reference.mime}),reference.filename);form.append('type','input');form.append('overwrite','false');const uploaded=await request(fetchImpl,config,'upload/image',{method:'POST',body:form,form:true,signal,max:65536});const name=serverFile(uploaded);workflow[config.referenceNode].inputs[config.referenceInput]=(name.subfolder?name.subfolder+'/':'')+name.filename;}
  const result=await request(fetchImpl,config,'prompt',{method:'POST',body:{prompt:workflow,client_id:'xiangxu-'+job.jobId},signal,max:262144});
  if(typeof result?.prompt_id!=='string'||!result.prompt_id||result.prompt_id.length>256||result.node_errors&&Object.keys(result.node_errors).length)fail('MEDIA_PROVIDER_RESPONSE','ComfyUI未确认有效任务编号');
  return{status:'submitted',remoteJobId:result.prompt_id};
}
function serverFile(value){
  if(!object(value)||typeof(value.filename??value.name)!=='string')fail('MEDIA_PROVIDER_RESPONSE','媒体服务返回了无效文件信息');
  const filename=value.filename??value.name,subfolder=value.subfolder??'',type=value.type??'output';
  if(!filename||filename.length>256||/[\\/\u0000-\u001f]/.test(filename)||filename==='.'||filename==='..'||typeof subfolder!=='string'||subfolder.length>1024||subfolder.includes('\\')||subfolder.split('/').some(part=>part==='.'||part==='..')||subfolder.startsWith('/')||subfolder.includes(':')||!['input','output','temp'].includes(type))fail('MEDIA_PROVIDER_RESPONSE','服务媒体路径不安全');
  return{filename,subfolder,type};
}
export async function poll(fetchImpl,config,job,signal){
  if(config.type!=='comfyui'||!job.remoteJobId)fail('MEDIA_JOB_NOT_POLLABLE','当前任务没有可查询的远程编号');
  const response=await request(fetchImpl,config,'history/'+encodeURIComponent(job.remoteJobId),{signal,max:LIMITS.responseBytes});const history=response?.[job.remoteJobId];
  if(history===undefined)return{status:'submitted'};
  if(!object(history))fail('MEDIA_PROVIDER_RESPONSE','ComfyUI历史结果无效');
  if(history.status?.status_str==='error')return{status:'failed',error:{code:'MEDIA_REMOTE_EXECUTION_FAILED',message:'ComfyUI报告工作流执行失败'}};
  if(history.status?.completed!==true)return{status:'submitted'};
  if(!object(history.outputs))fail('MEDIA_PROVIDER_RESPONSE','ComfyUI完成但缺少输出');const files=[];
  for(const[id,node]of Object.entries(history.outputs)){if(config.outputNodeIds.length&&!config.outputNodeIds.includes(id))continue;if(!object(node))continue;for(const key of job.kind==='image'?['images']:['videos','gifs'])if(Array.isArray(node[key]))for(const value of node[key]){const f=serverFile(value);if(f.type!=='output')fail('MEDIA_PROVIDER_RESPONSE','只接收工作流明确输出的媒体文件');files.push(f);}}
  if(!files.length||files.length>LIMITS.outputAssets)fail('MEDIA_OUTPUT_CAPACITY','工作流没有目标媒体或输出数超过容量');
  const outputs=[];for(const file of files){const query=new URLSearchParams(file);const bytes=await request(fetchImpl,config,'view?'+query,{signal,json:false,max:job.kind==='image'?LIMITS.imageBytes:LIMITS.videoBytes});mediaInfo(bytes,job.kind);outputs.push({bytes,name:file.filename});}
  return{status:'completed',outputs};
}
export async function cancel(fetchImpl,config,job,signal){
  if(config.type!=='comfyui'||!job.remoteJobId)return{status:'unknown',error:{code:'MEDIA_CANCEL_NOT_CONFIRMED',message:'服务未提供可确认的取消操作'}};
  const queue=await request(fetchImpl,config,'queue',{signal,max:1048576});
  const pending=Array.isArray(queue?.queue_pending)&&queue.queue_pending.some(row=>Array.isArray(row)&&row[1]===job.remoteJobId);
  if(!pending)return{status:'unknown',error:{code:'MEDIA_CANCEL_NOT_CONFIRMED',message:'远程任务可能已执行；未中断其它工作流'}};
  await request(fetchImpl,config,'queue',{method:'POST',body:{delete:[job.remoteJobId]},signal,max:65536});
  const after=await request(fetchImpl,config,'queue',{signal,max:1048576});
  const remaining=['queue_pending','queue_running'].some(key=>Array.isArray(after?.[key])&&after[key].some(row=>Array.isArray(row)&&row[1]===job.remoteJobId));
  return remaining?{status:'unknown',error:{code:'MEDIA_CANCEL_NOT_CONFIRMED',message:'远程任务取消尚未确认'}}:{status:'cancelled'};
}
async function downloadResult(fetchImpl,config,value,kind,signal){
  let url;try{url=new URL(value);}catch{fail('MEDIA_DOWNLOAD_URL','媒体下载地址无效');}const base=new URL(config.baseUrl);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)fail('MEDIA_DOWNLOAD_URL','媒体下载地址不能夹带凭据或使用非HTTP协议');
  if(url.origin!==base.origin){if(!config.downloadOrigins.includes(url.origin))fail('MEDIA_DOWNLOAD_URL','跨站媒体下载需要用户明确配置额外来源');endpoint(url.origin,config.allowRemote);}
  let response;try{response=await fetchImpl(url,{redirect:'error',signal});}catch{fail('MEDIA_DOWNLOAD','媒体下载失败');}if(!response.ok)fail('MEDIA_DOWNLOAD','媒体下载返回HTTP '+response.status);return responseBytes(response,kind==='image'?LIMITS.imageBytes:LIMITS.videoBytes);
}
