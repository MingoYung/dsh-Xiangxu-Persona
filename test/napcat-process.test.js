import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import { createOwnedQqProcessVerifier, createOwnedQqProcessController } from '../adapters/dsh/connections/napcat-process.js';

const now = Date.now(), start = now - 10000, qqPath = path.resolve('fixture-QQ/QQ.exe');
const row = (pid, parentPid, offset = 1, file = qqPath) => ({ pid, parentPid, path: file, createdAt: new Date(start + offset).toISOString() });
const options = { launcher: { pid: 100 }, qqPath, startedAt: start, bootId: 'test-boot' };
test('QQ native ownership requires the exact QQ executable and owned launcher ancestry', async () => {
  let rows = [row(300, 200, 3), row(200, 100, 2)];
  const calls = [], verify = createOwnedQqProcessVerifier({ platform: 'win32', clock: () => now, execFilePort: async (...args) => { calls.push(args); return { stdout: JSON.stringify(rows) }; } });
  assert.equal(await verify(300, options), true);
  assert.equal(calls[0][2].windowsHide, true);
  assert.match(Buffer.from(calls[0][1].at(-1), 'base64').toString('utf16le'), /ProcessId/);
  rows = [row(300, 200, 4), row(200, 100, 2)];
  assert.equal(await verify(300, options), false, 'a reused PID must not inherit ownership');
});
test('QQ native verifier rejects unrelated, older, mismatched and malformed process metadata', async () => {
  for (const rows of [[row(300, 999)], [row(300, 100, -5000)], [row(300, 100, -1)], [row(300, 100, 3, path.resolve('other-QQ/QQ.exe'))], [row(300, 200, 2), row(200, 100, 3)], [row(300, 100, 3), row(100, 99, 4)], [row(300, 100, 3), row(100, 99, -1)], {}]) {
    const verify = createOwnedQqProcessVerifier({ platform: 'win32', clock: () => now, execFilePort: async () => ({ stdout: JSON.stringify(rows) }) });
    assert.equal(await verify(300, options), false);
  }
});
test('QQ process inspection errors, non-Windows and invalid PIDs cannot establish ownership', async () => {
  let calls = 0;
  const execFilePort = async () => { calls++; throw Error('unavailable'); };
  assert.equal(await createOwnedQqProcessVerifier({ platform: 'win32', execFilePort })(300, options), false);
  assert.equal(await createOwnedQqProcessVerifier({ platform: 'linux', execFilePort })(300, options), false);
  assert.equal(await createOwnedQqProcessVerifier({ platform: 'win32', execFilePort })('300;unsafe', options), false);
  assert.equal(calls, 1);
});
test('owned stop pins exact process handles and verifies exit before confirming restart eligibility', async () => {
  const scripts=[];
  const controller=createOwnedQqProcessController({platform:'win32',clock:()=>now,execFilePort:async(_file,args,options)=>{
    const script=Buffer.from(args.at(-1),'base64').toString('utf16le');scripts.push(script);
    assert.equal(options.windowsHide,true);
    return {stdout:JSON.stringify(script.includes('Add-Type')?{confirmed:true}:[row(300,100,3)])};
  }});
  assert.equal(await controller.stopOwnedProcess(options.launcher,{qqPath,native:{pid:300,bootId:options.bootId,startedAt:start}}),true);
  assert.equal(scripts.length,2);
  assert.match(scripts[1],/GetProcessTimes/);assert.match(scripts[1],/QueryFullProcessImageName/);
  assert.match(scripts[1],/CloseHandle/);assert.match(scripts[1],/WaitForSingleObject/);
  assert.doesNotMatch(scripts[1],/taskkill|Stop-Process/);
});
test('owned stop never reaches a termination command for unproven or reused QQ identity',async()=>{
  let rows=[row(300,100,3)],stops=0;
  const controller=createOwnedQqProcessController({platform:'win32',clock:()=>now,execFilePort:async(_file,args)=>{
    const script=Buffer.from(args.at(-1),'base64').toString('utf16le');if(script.includes('Add-Type'))stops++;
    return{stdout:JSON.stringify(rows)};
  }});
  assert.equal(await controller.isOwnedNativeProcess(300,options),true);
  rows=[row(300,100,4)];assert.equal(await controller.stopOwnedProcess(options.launcher,{qqPath,native:{pid:300,bootId:options.bootId,startedAt:start}}),false);
  assert.equal(await controller.stopOwnedProcess(options.launcher,{qqPath,native:null}),false);
  assert.equal(stops,0);
});
test('termination failure or unconfirmed residual processes cannot authorize a new launch',async()=>{
  for(const result of [{confirmed:false},{},null,'invalid']){
    const controller=createOwnedQqProcessController({platform:'win32',clock:()=>now,execFilePort:async(_file,args)=>({stdout:Buffer.from(args.at(-1),'base64').toString('utf16le').includes('Add-Type')?JSON.stringify(result):JSON.stringify([row(300,100,3)])})});
    assert.equal(await controller.stopOwnedProcess(options.launcher,{qqPath,native:{pid:300,bootId:options.bootId,startedAt:start}}),false);
  }
});
test('Windows native identity helper compiles and pins only the current disposable test process', {skip:process.platform!=='win32'},async()=>{
  let source;
  const controller=createOwnedQqProcessController({platform:'win32',clock:()=>now,execFilePort:async(_file,args)=>{
    const script=Buffer.from(args.at(-1),'base64').toString('utf16le');
    if(script.includes('Add-Type')){source=script;return{stdout:'{"confirmed":false}'};}
    return{stdout:JSON.stringify([row(300,100,3)])};
  }});
  await controller.stopOwnedProcess(options.launcher,{qqPath,native:{pid:300,bootId:options.bootId,startedAt:start}});
  const helper=source.match(/Add-Type -TypeDefinition @'[\s\S]*?\n'@/)[0];
  const command=`$ErrorActionPreference='Stop';${helper}\n$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}';$h=[XiangxuOwnedProcess]::Pin([uint32]$p.ProcessId,$p.ExecutablePath,$p.CreationDate.ToUniversalTime().ToString('o'));[void][XiangxuOwnedProcess]::CloseHandle($h);$rejected=$false;try{[XiangxuOwnedProcess]::Pin([uint32]$p.ProcessId,'C:\\wrong-QQ.exe',$p.CreationDate.ToUniversalTime().ToString('o'))}catch{$rejected=$true};[pscustomobject]@{pinned=$true;wrongPathRejected=$rejected}|ConvertTo-Json -Compress`;
  const result=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,encoding:'utf8'});
  assert.deepEqual(JSON.parse(result.stdout.trim()),{pinned:true,wrongPathRejected:true});
});
test('cold controller restores only the exact previously proven process birth and boot',async()=>{
  let rows=[row(300,100,3)];const ports={platform:'win32',clock:()=>now,execFilePort:async()=>({stdout:JSON.stringify(rows)})};
  const first=createOwnedQqProcessController(ports),proof=await first.getOwnedProcessProof(300,options);
  assert.equal(proof.schemaVersion,'xiangxu-owned-qq-process/1');assert.equal(proof.createdAt,rows[0].createdAt);
  const context={qqPath,bootId:options.bootId,startedAt:start,launcherPid:100},cold=createOwnedQqProcessController(ports);
  rows=[row(300,999,3)];
  assert.equal(await cold.isOwnedNativeProcess(300,options),false,'cold startup may not guess ownership from current marker');
  assert.equal(await cold.restoreOwnedProcess(proof,context),true);
  assert.equal(await cold.isOwnedNativeProcess(300,options),true,'pinned identity survives launcher exit and parent PID reuse');
  for(const altered of [{...proof,pid:301},{...proof,createdAt:row(300,100,4).createdAt},{...proof,bootId:'other'},{...proof,path:path.resolve('other/QQ.exe')},{...proof,launcherPid:999},{...proof,schemaVersion:'invalid'}]){
    assert.equal(await createOwnedQqProcessController(ports).restoreOwnedProcess(altered,context),false);
  }
  rows=[row(300,999,4)];assert.equal(await cold.restoreOwnedProcess(proof,context),false);assert.equal(await cold.isOwnedNativeProcess(300,options),false);
});
