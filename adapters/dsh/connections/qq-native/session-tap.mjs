// One-shot capture of the official factory's own result.
// No native factory/service is invoked by installation or metadata inspection.
const own=(value,name)=>Object.getOwnPropertyDescriptor(value,name);
const data=descriptor=>Boolean(descriptor&&Object.hasOwn(descriptor,'value'));
const reference=value=>value!==null&&(typeof value==='object'||typeof value==='function');
const fail=code=>{throw Object.assign(new Error(code),{code});};

export function installSessionTap(nativeExports,{onCapture,onDiagnostic=()=>{}}={}){
  const state={schemaVersion:'xiangxu-qq-session-tap/1',installed:false,captured:false,firstCallObserved:false,restored:false,codes:[]};
  let originalEntry,facade;
  function diagnostic(code){if(!state.codes.includes(code)&&state.codes.length<16)state.codes.push(code);try{onDiagnostic(code);}catch{}}
  function restore(){
    if(!state.installed)return;
    state.installed=false;
    try{
      if(own(nativeExports,'NodeIQQNTWrapperSession')?.value!==facade){diagnostic('SESSION_TAP_EXPORT_CHANGED');return;}
      Object.defineProperty(nativeExports,'NodeIQQNTWrapperSession',originalEntry);state.restored=true;
    }catch{diagnostic('SESSION_TAP_RESTORE_FAILED');}
  }
  try{
    if(!reference(nativeExports)||typeof onCapture!=='function')fail('SESSION_TAP_CONFIG_INVALID');
    originalEntry=own(nativeExports,'NodeIQQNTWrapperSession');
    if(!data(originalEntry)||typeof originalEntry.value!=='function'||!originalEntry.writable||!originalEntry.configurable)fail('SESSION_TAP_EXPORT_SHAPE_UNVERIFIED');
    const originalFactory=originalEntry.value,method=own(originalFactory,'getNTWrapperSession'),prototype=own(originalFactory,'prototype');
    if(!data(method)||typeof method.value!=='function'||!data(prototype)||!reference(prototype.value))fail('SESSION_TAP_FACTORY_SHAPE_UNVERIFIED');
    const originalMethod=method.value;
    facade=function SessionFacade(...args){
      if(new.target)return Reflect.construct(originalFactory,args,new.target===facade?originalFactory:new.target);
      return Reflect.apply(originalFactory,this,args);
    };
    Object.setPrototypeOf(facade,originalFactory);
    Object.defineProperty(facade,'prototype',{value:prototype.value,writable:prototype.writable===true,enumerable:prototype.enumerable===true,configurable:false});
    for(const name of ['name','length']){const descriptor=own(originalFactory,name);if(data(descriptor))Object.defineProperty(facade,name,descriptor);}
    const intercepted=function getNTWrapperSession(...args){
      const first=state.installed&&!state.firstCallObserved;
      if(first)state.firstCallObserved=true;
      let result;
      try{result=Reflect.apply(originalMethod,originalFactory,args);}finally{if(first)restore();}
      if(first&&state.restored){
        if(args.length!==1||args[0]!=='nt_1')diagnostic('SESSION_TAP_CALL_SCOPE_UNEXPECTED');
        else if(!reference(result))diagnostic('SESSION_TAP_RESULT_SHAPE_UNVERIFIED');
        else{state.captured=true;try{onCapture(result);}catch{diagnostic('SESSION_TAP_CAPTURE_CALLBACK_FAILED');}}
      }
      return result;
    };
    const arity=own(originalMethod,'length');if(data(arity))Object.defineProperty(intercepted,'length',arity);
    Object.defineProperty(facade,'getNTWrapperSession',{...method,value:intercepted});
    Object.defineProperty(nativeExports,'NodeIQQNTWrapperSession',{...originalEntry,value:facade});state.installed=true;
  }catch(error){diagnostic(/^SESSION_TAP_[A-Z0-9_]+$/.test(error?.code??'')?error.code:'SESSION_TAP_INSTALL_FAILED');restore();}
  return{get installed(){return state.installed;},restore,snapshot:()=>JSON.parse(JSON.stringify(state))};
}

/** Only metadata from the class prototypes; never getBuddyService/addBuddy/etc. */
export function inspectFriendClassMethods(nativeExports){
  return[
    ['NodeIKernelBuddyService','reqToAddFriends'],
    ['NodeIKernelAddBuddyService','addBuddy'],
  ].map(([className,methodName])=>{
    const result={className,methodName,exists:false,type:'missing'};
    try{
      if(!reference(nativeExports))return result;
      const exported=own(nativeExports,className);if(!data(exported)){if(exported)result.type='accessor';return result;}
      if(!reference(exported.value))return result;
      const prototype=own(exported.value,'prototype');if(!data(prototype)||!reference(prototype.value)){if(prototype&&!data(prototype))result.type='accessor';return result;}
      const descriptor=own(prototype.value,methodName);if(!descriptor)return result;
      result.type=data(descriptor)?typeof descriptor.value:'accessor';result.exists=result.type==='function';
      if(result.exists){const arity=own(descriptor.value,'length');if(data(arity)&&Number.isSafeInteger(arity.value)&&arity.value>=0&&arity.value<=65535)result.arity=arity.value;}
    }catch{result.exists=false;result.type='unavailable';}
    return result;
  });
}
