import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { windowsPowerShellEnvironment } from '../adapters/dsh/compat/windows-powershell-env.js';

test('Windows PowerShell child environment isolates module paths without changing its parent', () => {
  const parent = Object.freeze({ Path: 'keep-path', PSModulePath: 'PowerShell-7-modules', psMODULEpath: 'mixed-case', TEMP: 'keep-temp', OTHER: 'keep-value' });
  assert.deepEqual(windowsPowerShellEnvironment(parent), { Path: 'keep-path', TEMP: 'keep-temp', OTHER: 'keep-value' });
  assert.equal(parent.PSModulePath, 'PowerShell-7-modules');
  assert.equal(parent.psMODULEpath, 'mixed-case');
  const before = { ...process.env };
  windowsPowerShellEnvironment();
  assert.deepEqual({ ...process.env }, before);
});

test('native Windows PowerShell can load signature and process commands with the child environment', { skip: process.platform !== 'win32' }, async () => {
  const file = path.win32.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = "$ErrorActionPreference='Stop'; $signature=Get-Command Get-AuthenticodeSignature; $cim=Get-Command Get-CimInstance; [pscustomobject]@{signature=$signature.ModuleName;process=$cim.ModuleName}|ConvertTo-Json -Compress";
  const result = await promisify(execFile)(file, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, env: windowsPowerShellEnvironment(), encoding: 'utf8', timeout: 15000, maxBuffer: 16384,
  });
  assert.deepEqual(JSON.parse(result.stdout.replace(/^\ufeff/, '').trim()), { signature: 'Microsoft.PowerShell.Security', process: 'CimCmdlets' });
});
