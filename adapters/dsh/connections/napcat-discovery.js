import path from 'node:path';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
/** Resolve the local Tencent client without executing an installer or reading account data. */
export function discoverQqExecutable({platform=process.platform,environment=process.env,exists=existsSync,query}={}){
 if(platform!=='win32')return null;
 const read=query??(key=>execFileSync('reg.exe',['query',key,'/v','UninstallString'],{encoding:'utf8',windowsHide:true,timeout:2000,stdio:['ignore','pipe','ignore']}));
 for(const key of['HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ','HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ','HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ']){
  try{const raw=String(read(key)).match(/UninstallString\s+REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/i)?.[1];if(!raw)continue;const value=raw.replace(/%([^%]+)%/g,(all,name)=>Object.entries(environment).find(([k])=>k.toLowerCase()===name.toLowerCase())?.[1]??all),exe=value.match(/^\s*"([^"]+)"/)?.[1]??value.match(/^\s*(.*?\.exe)(?:\s|$)/i)?.[1];if(!exe||!path.win32.isAbsolute(exe)||path.win32.basename(exe).toLowerCase()!=='uninstall.exe')continue;const target=path.win32.join(path.win32.dirname(exe),'QQ.exe');if(exists(target))return target;}catch{}
 }
 for(const base of[environment.ProgramFiles,environment['ProgramFiles(x86)'],environment.LOCALAPPDATA]){if(!base)continue;for(const name of['Tencent/QQNT/QQ.exe','Tencent/QQ/QQ.exe','Programs/QQ/QQ.exe']){const target=path.win32.join(base,name);if(exists(target))return target;}}
 return null;
}
