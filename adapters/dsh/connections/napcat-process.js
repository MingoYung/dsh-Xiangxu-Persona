import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const pathKey = value => path.resolve(value).replaceAll('\\', '/').toLowerCase();
const validPid = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;

/** Read process metadata only. No client userdata, broad process kill or ownership adoption. */
export function createOwnedQqProcessVerifier({ platform = process.platform, execFilePort = run, clock = Date.now } = {}) {
  const observed = new Map();
  return async function isOwnedNativeProcess(pid, { launcher, qqPath, bootId, startedAt } = {}) {
    if (platform !== 'win32' || !validPid(pid) || !validPid(launcher?.pid) || !path.isAbsolute(qqPath ?? '') ||
      typeof bootId !== 'string' || !bootId || bootId.length > 256 || !Number.isSafeInteger(startedAt)) return false;
    // The only interpolated value is a validated uint32 PID.
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $rows=[Collections.Generic.List[object]]::new(); $seen=[Collections.Generic.HashSet[uint32]]::new(); $currentId=[uint32]${pid}; for($index=0;$index -lt 24 -and $currentId -gt 0;$index++){ if(-not $seen.Add($currentId)){break}; $entry=Get-CimInstance Win32_Process -Filter ('ProcessId='+$currentId); if(-not $entry){break}; $rows.Add([pscustomobject]@{pid=[uint32]$entry.ProcessId;parentPid=[uint32]$entry.ParentProcessId;path=[string]$entry.ExecutablePath;createdAt=$entry.CreationDate.ToUniversalTime().ToString('o')}); $currentId=[uint32]$entry.ParentProcessId }; ConvertTo-Json -InputObject @($rows.ToArray()) -Compress`;
    let rows;
    try {
      const result = await execFilePort('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 131072 });
      rows = JSON.parse(result.stdout.replace(/^\ufeff/, '').trim());
    } catch { return false; }
    if (!Array.isArray(rows) || !rows.length || rows.length > 24) return false;
    const first = rows[0], created = Date.parse(first.createdAt);
    if (first.pid !== pid || typeof first.path !== 'string' || pathKey(first.path) !== pathKey(qqPath) ||
      !Number.isFinite(created) || created < startedAt || created > clock() + 1000) return false;
    const prior = observed.get(bootId);
    if (prior) return prior.pid === pid && prior.launcherPid === launcher.pid && prior.path === pathKey(first.path) && prior.createdAt === first.createdAt;
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
    observed.set(bootId, { pid, launcherPid: launcher.pid, path: pathKey(first.path), createdAt: first.createdAt });
    return true;
  };
}
