import {extractSourceDependencies} from './source-dependencies.js';

// The current self-description is data, not a fixed character script. Initial
// wishes stay labelled as wishes; historical versions are never sent each turn.
const fields=['name','pronouns','gender','ageDescription','birthday','selfDescription','background'];
export const CONVERSATION_ORIENTATION = '你以持续的虚拟人格参与与人的相处，当前自我资料和记忆为你提供连续的背景。可以用日常、直接的语言回应对方当下的表达，也可以分享自己的想法或按意愿提供帮助。运行材料中的窗口、路由、工具和容量用于理解处境，不是见面时需要逐项汇报的事项；问到机制或实际故障影响交流时可准确解释。是否询问称呼、追问、说多少、分几次说，以及是否回应、回忆、反思和改变，仍由你选择。初始想法是用户的建议，current是目前保存的自我描述；未确定的信息可以留空。新会话不表示新建人格，未认出、未检索、检索无结果与资料为空是不同状态。';

export function conversationOrientation(style='short_chat') {
  const preference={short_chat:'用户的表达偏好是自然短聊：日常可以先说当下主要的意思，随对方回应或自己的后续想法继续，复杂内容仍可完整展开。表达参考（不是固定台词，也不是发生过的对话）：对方只说“你好”，可以像“你好呀，我在。”这样简单回应；想了解称呼时也可以自然问一句。',balanced:'用户希望按内容决定表达长短与节奏。',detailed:'用户偏好需要解释时完整展开，也可以自然地简短交流。'};
  return CONVERSATION_ORIENTATION+'\n'+(preference[style]??preference.short_chat)+'这只是交流偏好，不是字数、条数或频率要求，不要求每轮提问或分条。若想稍后补充，可以通过已有persona_decide.nextCheckAt选择再次判断的时机，并保留所指对话的实际replyPlan.target；届时结合已收到的最新来信重新决定，不是预先排队播放台词，也不是实时打断当前生成的机制。普通回复也可以就此结束，无需为了拆条调用空操作。';
}

export async function selfProfileContext(profile,{counter,budget=350}={}) {
  const empty={text:'',shown:[],omitted:[],sourceDependencies:{refs:[],recordIds:[],complete:true}};
  if(!profile)return empty;
  const configured=profile.version>0&&['together','autonomous'].includes(profile.mode);
  if(!configured&&!fields.some(f=>profile.current?.[f]||profile.initial?.[f]))return empty;
  const value={version:profile.version,mode:profile.mode,current:{},initialWishes:{}};
  const candidates=[];
  for(const group of ['current','initial'])for(const field of fields)if(profile[group]?.[field])candidates.push({group,field,text:profile[group][field]});
  if(budget<=0)return {...empty,omitted:candidates.map(x=>x.group+'.'+x.field)};
  const shown=[],omitted=[],provenance=[];
  const render=v=>'[self_profile]\n'+JSON.stringify(v)+'\n';
  // Keep every field that is shown complete; the full profile remains available
  // through introspection. Never turn a cut JSON fragment into a claimed age/name.
  for(const item of candidates) {
    const group=item.group==='initial'?'initialWishes':'current';value[group][item.field]=item.text;
    if(await counter.count(render({...value,moreAvailable:true}))<=budget) {
      shown.push(item.group+'.'+item.field);provenance.push(profile.provenance?.[item.group]?.[item.field]);
    }else {delete value[group][item.field];omitted.push(item.group+'.'+item.field);}
  }
  if(!shown.length&&!configured)return {...empty,omitted:candidates.map(x=>x.group+'.'+x.field)};
  const text=render({...value,moreAvailable:omitted.length>0});
  if(await counter.count(text)>budget)return {...empty,omitted:candidates.map(x=>x.group+'.'+x.field)};
  return {text,shown,omitted,sourceDependencies:extractSourceDependencies({refs:provenance.flatMap(p=>p?.sourceRefs??[]),recordIds:provenance.flatMap(p=>p?.sourceRecordIds??[])})};
}
