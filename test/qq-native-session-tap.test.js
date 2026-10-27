import test from 'node:test';
import assert from 'node:assert/strict';
import {installSessionTap,inspectFriendClassMethods} from '../adapters/dsh/connections/qq-native/session-tap.mjs';

// Every constructor, factory and service in this suite is a local fake. Importing
// this suite never loads QQ, the official bundle, a native addon or a server.
const PRIVATE_ERROR='PRIVATE_MOCK_NATIVE_ERROR_DO_NOT_RECORD';
function fixture({getError,onCapture,onDiagnostic}={}){
  const counts={get:0,create:0,buddy:0,add:0},calls=[],captures=[],diagnostics=[];
  const session={getBuddyService(){counts.buddy++;throw new Error('service must not be called by the tap');}};
  const callResult={kind:'factory-call-result'},constructCalls=[];
  function OriginalFactory(...args){
    constructCalls.push({receiver:this,args,newTarget:new.target});
    if(new.target){this.constructedArgs=args;return;}
    return callResult;
  }
  const originalGet=function(...args){
    counts.get++;calls.push({receiver:this,args});if(getError)throw getError;return session;
  };
  const create=function(){counts.create++;throw new Error('create must not be called by the tap');};
  Object.defineProperties(OriginalFactory,{
    getNTWrapperSession:{value:originalGet,writable:false,configurable:false,enumerable:true},
    create:{value:create,writable:false,configurable:false},
  });
  const otherExport={identity:'unmodified'},nativeExports={otherExport};
  Object.defineProperty(nativeExports,'NodeIQQNTWrapperSession',{value:OriginalFactory,writable:true,configurable:true,enumerable:false});
  const originalDescriptor=Object.getOwnPropertyDescriptor(nativeExports,'NodeIQQNTWrapperSession');
  const getDescriptor=Object.getOwnPropertyDescriptor(OriginalFactory,'getNTWrapperSession');
  const tap=installSessionTap(nativeExports,{
    onCapture:onCapture??(value=>captures.push(value)),
    onDiagnostic:onDiagnostic??(code=>diagnostics.push(code)),
  });
  return{tap,nativeExports,OriginalFactory,originalGet,originalDescriptor,getDescriptor,otherExport,counts,calls,captures,diagnostics,session,constructCalls,callResult};
}

function assertOriginalNamespace(f){
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.nativeExports,'NodeIQQNTWrapperSession'),f.originalDescriptor);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.OriginalFactory,'getNTWrapperSession'),f.getDescriptor);
  assert.equal(f.nativeExports.otherExport,f.otherExport);
}

test('installation only replaces the permitted namespace slot and never creates or queries a session',()=>{
  const f=fixture();assert.equal(f.tap.installed,true);
  assert.notEqual(f.nativeExports.NodeIQQNTWrapperSession,f.OriginalFactory);
  assert.deepEqual(f.counts,{get:0,create:0,buddy:0,add:0});assert.equal(f.constructCalls.length,0);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.OriginalFactory,'getNTWrapperSession'),f.getDescriptor);
  assert.equal(f.nativeExports.otherExport,f.otherExport);
  f.tap.restore();assertOriginalNamespace(f);
});

test('the exact nt_1 call delegates with the real factory receiver, returns the same object and restores before capture',()=>{
  let f,captured;
  f=fixture({onCapture(value){assertOriginalNamespace(f);captured=value;}});
  const facade=f.nativeExports.NodeIQQNTWrapperSession;
  assert.equal(facade.getNTWrapperSession.length,0,'observed native arity zero must not be treated as a zero-argument API');
  const result=facade.getNTWrapperSession.call({unrelatedReceiver:true},'nt_1');
  assert.equal(result,f.session);assert.equal(captured,f.session);
  assert.equal(f.calls[0].receiver,f.OriginalFactory);assert.deepEqual(f.calls[0].args,['nt_1']);
  assert.equal(f.counts.get,1);assertOriginalNamespace(f);
  assert.deepEqual({create:f.counts.create,buddy:f.counts.buddy,add:f.counts.add},{create:0,buddy:0,add:0});
});

test('capture is limited to the first intercepted get call even when a retained facade is called again',()=>{
  const f=fixture(),facade=f.nativeExports.NodeIQQNTWrapperSession;
  assert.equal(facade.getNTWrapperSession('nt_1'),f.session);
  assert.equal(facade.getNTWrapperSession('nt_1'),f.session);
  assert.deepEqual(f.captures,[f.session]);assert.equal(f.counts.get,2);assertOriginalNamespace(f);
});

test('nonmatching first-call arguments are passed unchanged, restore the namespace and do not capture later',()=>{
  const extra={identity:true};
  for(const args of [[],['nt_2'],['nt_1',extra],[new String('nt_1')]]){
    const f=fixture(),facade=f.nativeExports.NodeIQQNTWrapperSession;
    assert.equal(Reflect.apply(facade.getNTWrapperSession,null,args),f.session);
    assert.equal(f.calls[0].receiver,f.OriginalFactory);assert.deepEqual(f.calls[0].args,args);
    assert.equal(f.captures.length,0);assertOriginalNamespace(f);
    assert.equal(facade.getNTWrapperSession('nt_1'),f.session);assert.equal(f.captures.length,0);
  }
});

test('an original factory error keeps its identity and restores the original namespace before escaping',()=>{
  const error=new Error(PRIVATE_ERROR),f=fixture({getError:error}),facade=f.nativeExports.NodeIQQNTWrapperSession;
  assert.throws(()=>facade.getNTWrapperSession('nt_1'),value=>value===error);
  assert.equal(f.captures.length,0);assert.equal(f.counts.get,1);assertOriginalNamespace(f);
  assert.equal(JSON.stringify(f.tap.snapshot()).includes(PRIVATE_ERROR),false);
});

test('capture and diagnostic callback errors never replace the original return value',()=>{
  let captureCalls=0,diagnosticCalls=0;
  const f=fixture({onCapture(){captureCalls++;throw new Error(PRIVATE_ERROR);},onDiagnostic(){diagnosticCalls++;throw new Error(PRIVATE_ERROR);}});
  assert.equal(f.nativeExports.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1'),f.session);
  assert.equal(captureCalls,1);assert.ok(diagnosticCalls>0);assertOriginalNamespace(f);
  assert.equal(JSON.stringify(f.tap.snapshot()).includes(PRIVATE_ERROR),false);
});

test('restore and a first intercepted call both preserve a later third-party namespace replacement',()=>{
  const first=fixture(),thirdParty=function ThirdParty(){};
  Object.defineProperty(first.nativeExports,'NodeIQQNTWrapperSession',{...first.originalDescriptor,value:thirdParty});
  first.tap.restore();first.tap.restore();assert.equal(first.nativeExports.NodeIQQNTWrapperSession,thirdParty);
  const second=fixture(),facade=second.nativeExports.NodeIQQNTWrapperSession;
  Object.defineProperty(second.nativeExports,'NodeIQQNTWrapperSession',{...second.originalDescriptor,value:thirdParty});
  assert.equal(facade.getNTWrapperSession('nt_1'),second.session);
  assert.equal(second.nativeExports.NodeIQQNTWrapperSession,thirdParty);
});

test('facade call and construction preserve the original prototype, receiver and newTarget rules',()=>{
  const f=fixture(),facade=f.nativeExports.NodeIQQNTWrapperSession,receiver={},arg={identity:true};
  assert.equal(Object.getPrototypeOf(facade),f.OriginalFactory);assert.equal(facade.prototype,f.OriginalFactory.prototype);
  assert.equal(facade.call(receiver,arg),f.callResult);
  assert.equal(f.constructCalls[0].receiver,receiver);assert.deepEqual(f.constructCalls[0].args,[arg]);assert.equal(f.constructCalls[0].newTarget,undefined);
  const direct=new facade(arg,7);
  assert.equal(f.constructCalls[1].newTarget,f.OriginalFactory);assert.deepEqual(direct.constructedArgs,[arg,7]);
  assert.ok(direct instanceof facade);assert.ok(direct instanceof f.OriginalFactory);
  class Derived extends facade{}
  const derived=new Derived(arg);
  assert.equal(f.constructCalls[2].newTarget,Derived);assert.ok(derived instanceof Derived);assert.ok(derived instanceof facade);assert.ok(derived instanceof f.OriginalFactory);
  assert.equal(f.counts.get,0);assert.equal(f.counts.create,0);f.tap.restore();assertOriginalNamespace(f);
});

test('unknown namespace/factory descriptors fail conservatively without evaluating accessors',()=>{
  let getterCalls=0;
  const accessorNamespace={};Object.defineProperty(accessorNamespace,'NodeIQQNTWrapperSession',{get(){getterCalls++;throw new Error(PRIVATE_ERROR);}});
  function GetterFactory(){}
  Object.defineProperty(GetterFactory,'getNTWrapperSession',{get(){getterCalls++;throw new Error(PRIVATE_ERROR);}});
  const factoryAccessor={NodeIQQNTWrapperSession:GetterFactory};
  function NonFunctionMethodFactory(){}
  Object.defineProperty(NonFunctionMethodFactory,'getNTWrapperSession',{value:17});
  const badMethod={NodeIQQNTWrapperSession:NonFunctionMethodFactory};
  function LockedFactory(){}
  Object.defineProperty(LockedFactory,'getNTWrapperSession',{value:function(){throw new Error('must not call');}});
  const lockedNamespace={};Object.defineProperty(lockedNamespace,'NodeIQQNTWrapperSession',{value:LockedFactory,writable:false,configurable:false});
  for(const nativeExports of [null,undefined,12,{},accessorNamespace,factoryAccessor,badMethod,lockedNamespace]){
    const before=nativeExports&&typeof nativeExports==='object'?Object.getOwnPropertyDescriptor(nativeExports,'NodeIQQNTWrapperSession'):undefined;
    const tap=installSessionTap(nativeExports,{onCapture(){throw new Error('unsupported shapes must not capture');},onDiagnostic(){throw new Error(PRIVATE_ERROR);}});
    assert.equal(tap.installed,false);tap.restore();
    if(before)assert.deepEqual(Object.getOwnPropertyDescriptor(nativeExports,'NodeIQQNTWrapperSession'),before);
    assert.equal(JSON.stringify(tap.snapshot()).includes(PRIVATE_ERROR),false);
  }
  assert.equal(getterCalls,0);
});

test('friend method inspection returns only descriptor metadata and never invokes either service',()=>{
  let nativeCalls=0;
  function BuddyService(){}function AddBuddyService(){}
  Object.defineProperty(BuddyService.prototype,'reqToAddFriends',{value:function(a,b,c,d,e){nativeCalls++;}});
  Object.defineProperty(AddBuddyService.prototype,'addBuddy',{value:function(a,b){nativeCalls++;}});
  const rows=inspectFriendClassMethods({NodeIKernelBuddyService:BuddyService,NodeIKernelAddBuddyService:AddBuddyService});
  assert.equal(rows.length,2);assert.equal(nativeCalls,0);
  const first=rows.find(row=>row.className==='NodeIKernelBuddyService'),second=rows.find(row=>row.className==='NodeIKernelAddBuddyService');
  assert.deepEqual(first,{className:'NodeIKernelBuddyService',methodName:'reqToAddFriends',exists:true,type:'function',arity:5});
  assert.deepEqual(second,{className:'NodeIKernelAddBuddyService',methodName:'addBuddy',exists:true,type:'function',arity:2});
});

test('friend inspection never reads namespace or method getters and handles absent classes',()=>{
  let getterCalls=0;function AddBuddyService(){}
  Object.defineProperty(AddBuddyService.prototype,'addBuddy',{get(){getterCalls++;throw new Error(PRIVATE_ERROR);}});
  const nativeExports={NodeIKernelAddBuddyService:AddBuddyService};
  Object.defineProperty(nativeExports,'NodeIKernelBuddyService',{get(){getterCalls++;throw new Error(PRIVATE_ERROR);}});
  const rows=inspectFriendClassMethods(nativeExports);assert.equal(getterCalls,0);assert.equal(rows.length,2);
  const accessor=rows.find(row=>row.className==='NodeIKernelAddBuddyService');assert.equal(accessor.exists,false);assert.equal(accessor.type,'accessor');assert.equal('arity'in accessor,false);
  assert.equal(JSON.stringify(rows).includes(PRIVATE_ERROR),false);
  const absent=inspectFriendClassMethods({});assert.equal(absent.length,2);assert.ok(absent.every(row=>row.exists===false));
});
