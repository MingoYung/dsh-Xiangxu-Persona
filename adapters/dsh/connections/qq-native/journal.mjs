import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export const operationIdValid=value=>typeof value==='string'&&value.length>0&&value.length<=160&&!/[\u0000-\u0020\u007f]/.test(value);
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function createNativeJournal({journalRoot,fsPort=fs,maxEntries=2048}={}){
  if(!path.isAbsolute(journalRoot??''))fail('QQ_NATIVE_JOURNAL_PATH');journalRoot=path.resolve(journalRoot);
  if(!Number.isInteger(maxEntries)||maxEntries<1||maxEntries>2048)fail('QQ_NATIVE_JOURNAL_CAPACITY');
  const fileFor=(accountId,operationId)=>{if(!operationIdValid(operationId)||!/^\d{1,16}$/.test(accountId??''))fail('QQ_NATIVE_OPERATION_ID');return path.join(journalRoot,createHash('sha256').update(JSON.stringify([accountId,operationId])).digest('hex')+'.json');};
  async function safe(file){let cursor=path.parse(file).root;for(const part of file.slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,part);try{const stat=await fsPort.lstat(cursor);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink!==1)fail('QQ_NATIVE_JOURNAL_PATH');}catch(error){if(error.code!=='ENOENT')throw error;}}}
  async function read(accountId,operationId){const file=fileFor(accountId,operationId);await safe(file);try{const stat=await fsPort.lstat(file);if(!stat.isFile()||stat.size>32768)fail('QQ_NATIVE_JOURNAL_CAPACITY');const record=JSON.parse(await fsPort.readFile(file,'utf8'));if(record.schemaVersion!=='xiangxu-qq-native-operation/1'||record.accountId!==accountId||record.operationId!==operationId||typeof record.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(record.fingerprint)||!['prepared','unknown','submitted','accepted','failed','unsupported'].includes(record.state))fail('QQ_NATIVE_JOURNAL_INVALID');return record;}catch(error){if(error.code==='ENOENT')return null;throw error;}}
  async function admission(){
    const file=path.join(journalRoot,'.prepare.lock'),token=randomUUID();await safe(file);let handle;
    try{handle=await fsPort.open(file,'wx',0o600);}catch(error){if(error.code==='EEXIST')fail('QQ_NATIVE_JOURNAL_BUSY');throw error;}
    let identity;
    const sameIdentity=stat=>identity&&stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.dev===identity.dev&&stat.ino===identity.ino&&stat.birthtimeMs===identity.birthtimeMs;
    async function release(){
      let owned=false;
      try{
        await safe(file);const before=await fsPort.lstat(file);
        if(sameIdentity(before)&&before.size<=2048){const claim=JSON.parse(await fsPort.readFile(file,'utf8')),after=await fsPort.lstat(file);owned=sameIdentity(after)&&claim.schemaVersion==='xiangxu-qq-native-admission/1'&&claim.token===token&&claim.pid===process.pid;}
      }catch{}finally{try{await handle?.close();}finally{handle=null;}}
      if(!owned)fail('QQ_NATIVE_JOURNAL_BUSY');
      // Other cooperative writers only open wx; none replaces an existing lock.
      await fsPort.unlink(file);
    }
    try{identity=await handle.stat();await handle.writeFile(JSON.stringify({schemaVersion:'xiangxu-qq-native-admission/1',pid:process.pid,token})+'\n');await handle.sync();}
    catch(error){try{await release();}catch{}throw error;}
    return release;
  }
  async function prepare(record){
    const file=fileFor(record.accountId,record.operationId);await safe(file);await fsPort.mkdir(journalRoot,{recursive:true});await safe(file);
    const prior=await read(record.accountId,record.operationId);if(prior)return{created:false,record:prior};
    const release=await admission();
    try{
      const existing=await read(record.accountId,record.operationId);if(existing)return{created:false,record:existing};
      const entries=await fsPort.readdir(journalRoot);if(entries.filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).length>=maxEntries)fail('QQ_NATIVE_JOURNAL_CAPACITY');
      const text=JSON.stringify(record,null,2)+'\n';if(Buffer.byteLength(text)>32768)fail('QQ_NATIVE_JOURNAL_CAPACITY');
      let handle;try{handle=await fsPort.open(file,'wx',0o600);}catch(error){if(error.code==='EEXIST')return{created:false,record:await read(record.accountId,record.operationId)};throw error;}
      try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}
      return{created:true,record};
    }finally{await release();}
  }
  async function update(record,patch){
    const file=fileFor(record.accountId,record.operationId),current=await read(record.accountId,record.operationId);
    if(!current||current.fingerprint!==record.fingerprint)fail('QQ_NATIVE_JOURNAL_CONFLICT');
    if(current.state==='accepted')return current;
    const {history:oldHistory=[],...snapshot}=current;if(!Array.isArray(oldHistory)||oldHistory.length>=16)fail('QQ_NATIVE_JOURNAL_CAPACITY');
    const next={...current,...patch,history:[...oldHistory,snapshot]},text=JSON.stringify(next,null,2)+'\n';if(Buffer.byteLength(text)>32768)fail('QQ_NATIVE_JOURNAL_CAPACITY');
    const temporary=file+'.next-'+randomUUID();await safe(file);await safe(temporary);
    try{const handle=await fsPort.open(temporary,'wx',0o600);try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}
      await safe(file);await fsPort.rename(temporary,file);return next;
    }catch(error){try{await fsPort.unlink(temporary);}catch{}throw error;}
  }
  return{read,prepare,update};
}
