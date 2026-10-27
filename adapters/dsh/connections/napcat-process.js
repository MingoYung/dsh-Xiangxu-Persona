import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const pathKey = value => path.resolve(value).replaceAll('\\', '/').toLowerCase();
const validPid = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;

/** Read process metadata only. No client userdata, broad process kill or ownership adoption. */
export function createOwnedQqProcessController({ platform = process.platform, execFilePort = run, clock = Date.now } = {}) {
  const observed = new Map();
  async function processRows(pid) {
    // The only interpolated value is a validated uint32 PID.
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $rows=[Collections.Generic.List[object]]::new(); $seen=[Collections.Generic.HashSet[uint32]]::new(); $currentId=[uint32]${pid}; for($index=0;$index -lt 24 -and $currentId -gt 0;$index++){ if(-not $seen.Add($currentId)){break}; $entry=Get-CimInstance Win32_Process -Filter ('ProcessId='+$currentId); if(-not $entry){break}; $rows.Add([pscustomobject]@{pid=[uint32]$entry.ProcessId;parentPid=[uint32]$entry.ParentProcessId;path=[string]$entry.ExecutablePath;createdAt=$entry.CreationDate.ToUniversalTime().ToString('o')}); $currentId=[uint32]$entry.ParentProcessId }; ConvertTo-Json -InputObject @($rows.ToArray()) -Compress`;
    let rows;
    try {
      const result = await execFilePort('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 131072 });
      rows = JSON.parse(result.stdout.replace(/^\ufeff/, '').trim());
    } catch { return null; }
    return Array.isArray(rows) && rows.length && rows.length <= 24 ? rows : null;
  }
  async function isOwnedNativeProcess(pid, { launcher, qqPath, bootId, startedAt } = {}) {
    if (platform !== 'win32' || !validPid(pid) || !validPid(launcher?.pid) || !path.isAbsolute(qqPath ?? '') ||
      typeof bootId !== 'string' || !bootId || bootId.length > 256 || !Number.isSafeInteger(startedAt)) return false;
    const rows=await processRows(pid);if(!rows)return false;
    const first = rows[0], created = Date.parse(first.createdAt);
    if (first.pid !== pid || typeof first.path !== 'string' || pathKey(first.path) !== pathKey(qqPath) ||
      !Number.isFinite(created) || created < startedAt || created > clock() + 1000) return false;
    const prior = observed.get(bootId);
    if (prior) return prior.pid === pid && prior.launcherPid === launcher.pid && prior.startedAt === startedAt && prior.path === pathKey(first.path) && prior.createdAt === first.createdAt;
    let belongs = pid === launcher.pid;
    for (let index = 0; index < rows.length && !belongs; index++) {
      const item = rows[index], at = Date.parse(item.createdAt);
      if (!validPid(item.pid) || !validPid(item.parentPid) || !Number.isFinite(at) || at < startedAt) return false;
      if (item.parentPid === launcher.pid) {
        const parent = rows[index + 1];
        // If the numeric launcher PID was reused, its new birth cannot precede
        // this QQ child. A launcher which has already exited has no such row.
        if (parent && (parent.pid !== launcher.pid || !Number.isFinite(Date.parse(parent.createdAt)) || Date.parse(parent.createdAt) < startedAt || Date.parse(parent.createdAt) > at)) return false;
        belongs = true; break;
      }
      const next = rows[index + 1];
      if (!next || item.parentPid !== next.pid || Date.parse(next.createdAt) > at) return false;
    }
    if (!belongs) return false;
    if (observed.size >= 32) observed.delete(observed.keys().next().value);
    observed.set(bootId, { pid, launcherPid: launcher.pid, path: pathKey(first.path), createdAt: first.createdAt, startedAt });
    return true;
  }
  async function getOwnedProcessProof(pid, options) {
    if(await isOwnedNativeProcess(pid,options)!==true)return null;
    return {schemaVersion:'xiangxu-owned-qq-process/1',bootId:options.bootId,...observed.get(options.bootId)};
  }
  async function restoreOwnedProcess(proof, {qqPath,bootId,startedAt,launcherPid}={}) {
    if(platform!=='win32'||proof?.schemaVersion!=='xiangxu-owned-qq-process/1'||typeof bootId!=='string'||!bootId||bootId.length>256||proof.bootId!==bootId||
      !validPid(proof.pid)||!validPid(launcherPid)||proof.launcherPid!==launcherPid||!Number.isSafeInteger(startedAt)||startedAt<0||proof.startedAt!==startedAt||
      typeof proof.path!=='string'||!path.isAbsolute(qqPath??'')||pathKey(proof.path)!==pathKey(qqPath)||typeof proof.createdAt!=='string')return false;
    const at=Date.parse(proof.createdAt);if(!Number.isFinite(at)||at<startedAt||at>clock()+1000)return false;
    const rows=await processRows(proof.pid),first=rows?.[0];
    if(first?.pid!==proof.pid||typeof first.path!=='string'||pathKey(first.path)!==pathKey(qqPath)||first.createdAt!==proof.createdAt)return false;
    const existing=observed.get(bootId);
    if(existing&&(existing.pid!==proof.pid||existing.createdAt!==proof.createdAt||existing.launcherPid!==launcherPid))return false;
    if(observed.size>=32&&!existing)observed.delete(observed.keys().next().value);
    observed.set(bootId,{pid:proof.pid,launcherPid,path:pathKey(first.path),createdAt:first.createdAt,startedAt});return true;
  }
  async function stopOwnedProcess(launcher, { qqPath, native } = {}) {
    if (!native || await isOwnedNativeProcess(native.pid, { launcher, qqPath, bootId: native.bootId, startedAt: native.startedAt }) !== true) return false;
    const pinned = observed.get(native.bootId);
    if (!pinned) return false;
    // The child PID alone never authorizes termination. The independent Windows
    // process handle must match the executable and full creation timestamp.
    const payload = Buffer.from(JSON.stringify({ pid: pinned.pid, path: path.resolve(qqPath), createdAt: pinned.createdAt }), 'utf8').toString('base64');
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class XiangxuOwnedProcess {
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h,uint flags,StringBuilder file,ref uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr h,uint exitCode);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  public static IntPtr Pin(uint pid,string file,string birth) {
    var h=OpenProcess(0x101001,false,pid); if(h==IntPtr.Zero)throw new Exception("open");
    long c,e,k,u;uint size=32768;var actual=new StringBuilder((int)size);
    if(!GetProcessTimes(h,out c,out e,out k,out u)||!QueryFullProcessImageName(h,0,actual,ref size)||
       !String.Equals(actual.ToString(),file,StringComparison.OrdinalIgnoreCase)||
       DateTime.FromFileTimeUtc(c).Ticks/10!=DateTime.Parse(birth,null,System.Globalization.DateTimeStyles.RoundtripKind).ToUniversalTime().Ticks/10){CloseHandle(h);throw new Exception("identity");}
    return h;
  }
  public static bool Stop(IntPtr h){return (WaitForSingleObject(h,0)==0||TerminateProcess(h,0))&&WaitForSingleObject(h,5000)==0;}
}
'@
$handles=[Collections.Generic.List[IntPtr]]::new();$confirmed=$false
try {
  $all=@(Get-CimInstance Win32_Process);$root=$all|Where-Object ProcessId -eq ([uint32]$expected.pid)
  if(-not $root -or $root.ExecutablePath -ine $expected.path -or $root.CreationDate.ToUniversalTime().Ticks -ne ([datetime]::Parse($expected.createdAt).ToUniversalTime().Ticks)){throw 'root identity'}
  $owned=[Collections.Generic.List[object]]::new();$owned.Add($root);$seen=[Collections.Generic.HashSet[uint32]]::new();[void]$seen.Add([uint32]$root.ProcessId)
  for($cursor=0;$cursor -lt $owned.Count;$cursor++){
    if($owned.Count -gt 256){throw 'tree capacity'};$parent=$owned[$cursor]
    foreach($entry in $all){if($entry.ParentProcessId -eq $parent.ProcessId -and -not $seen.Contains([uint32]$entry.ProcessId)){
      if($entry.CreationDate.ToUniversalTime() -lt $parent.CreationDate.ToUniversalTime() -or $entry.ExecutablePath -ine $expected.path){throw 'child identity'}
      [void]$seen.Add([uint32]$entry.ProcessId);$owned.Add($entry)
    }}
  }
  foreach($entry in $owned){$handles.Add([XiangxuOwnedProcess]::Pin([uint32]$entry.ProcessId,$expected.path,$entry.CreationDate.ToUniversalTime().ToString('o')))}
  $confirmed=$true
  foreach($handle in $handles){if(-not [XiangxuOwnedProcess]::Stop($handle)){$confirmed=$false}}
  foreach($entry in @(Get-CimInstance Win32_Process)){
    if(($seen.Contains([uint32]$entry.ProcessId) -or $seen.Contains([uint32]$entry.ParentProcessId)) -and $entry.CreationDate.ToUniversalTime() -ge $root.CreationDate.ToUniversalTime()){$confirmed=$false}
  }
} catch {$confirmed=$false} finally {foreach($handle in $handles){[void][XiangxuOwnedProcess]::CloseHandle($handle)}}
[pscustomobject]@{confirmed=$confirmed}|ConvertTo-Json -Compress`;
    try {
      const result = await execFilePort('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 16384 });
      const value = JSON.parse(result.stdout.replace(/^\ufeff/, '').trim());
      if (value?.confirmed === true) { observed.delete(native.bootId); return true; }
    } catch {}
    return false;
  }
  return { isOwnedNativeProcess, getOwnedProcessProof, restoreOwnedProcess, stopOwnedProcess };
}

export function createOwnedQqProcessVerifier(options) { return createOwnedQqProcessController(options).isOwnedNativeProcess; }
