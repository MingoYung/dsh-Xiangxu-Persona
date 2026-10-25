import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,readdir,rename,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..'),argv=process.argv.slice(2);
const value=(flag,fallback)=>{const i=argv.indexOf(flag);return i<0?fallback:argv[i+1]};
const profile=value('--profile','desktop');if(!/^[A-Za-z0-9_-]+$/.test(profile))throw new Error('Invalid profile');
const home=resolve(value('--home',process.env.DSH_HOME??join(homedir(),'.dsh')));
const installation=resolve(value('--installation',join(process.env.LOCALAPPDATA??join(homedir(),'AppData','Local'),'Programs','DSH NEXT')));
const target=join(home,'profiles',profile),packagePath=join(target,'package.json'),pkg=JSON.parse(await readFile(join(project,'package.json'),'utf8'));
const before=JSON.parse(await readFile(packagePath,'utf8')),legacy='@local/persona-memory',name=pkg.name;
const hash=b=>createHash('sha256').update(b).digest('hex');
const backup=resolve(value('--backup',join(project,'..','backup','xiangxu-install-latest',profile)));
const currentLink=String(before.dependencies?.[name]??'').replaceAll('\\','/'),expectedLink='link:'+project.replaceAll('\\','/');
if(currentLink.toLowerCase()===expectedLink.toLowerCase()&&!before.dependencies?.[legacy]){console.log(JSON.stringify({status:'already_installed',profile,name,source:before.dependencies[name],note:'Normal DSH reload/restart reads the linked bundle and prebuilt management client.'}));}
else{
  await mkdir(backup,{recursive:true});let manifest;try{manifest=JSON.parse(await readFile(join(backup,'manifest.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(manifest&&manifest.target!==target)throw new Error('Backup slot belongs to another profile');
  if(!manifest){if((await readdir(backup)).length)throw new Error('Unmanaged backup directory');manifest={target,profile,at:new Date().toISOString(),files:[]};
    async function save(relative){const from=join(target,relative);let stat;try{stat=await lstat(from);}catch(e){if(e.code==='ENOENT')return;throw e;}if(stat.isSymbolicLink())throw new Error('Linked profile metadata is not supported');
      if(stat.isDirectory()){for(const name of await readdir(from))await save(join(relative,name));return;}
      const bytes=await readFile(from),to=join(backup,relative);await mkdir(dirname(to),{recursive:true});await writeFile(to+'.next',bytes);if(hash(await readFile(to+'.next'))!==hash(bytes))throw new Error('Backup mismatch');await rename(to+'.next',to);manifest.files.push({source:from,backup:to,sha256:hash(bytes)});}
    for(const entry of ['package.json','cordis.patch.yml','pnpm-lock.yaml','pnpm-workspace.yaml','.plugin-manager'])await save(entry);
    await writeFile(join(backup,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  }else for(const item of manifest.files)if(hash(await readFile(item.backup))!==item.sha256)throw new Error('Original metadata backup changed');
  async function native(command,argument){const child=spawn(join(installation,'DSH NEXT.exe'),[join(installation,'resources','app.asar','lib','plugin-cli.js'),profile,command,argument],{cwd:project,windowsHide:true,env:{...process.env,DSH_HOME:home,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const code=await new Promise((res,rej)=>{child.on('error',rej);child.on('exit',res)});if(code!==0)throw new Error('Native plugin manager failed ('+command+'), backup: '+backup+'. '+output.replace(/\b(?:sk|key)-[A-Za-z0-9_-]{12,}/g,'[redacted]').slice(-1200));}
  if(before.dependencies?.[legacy])await native('remove',legacy);
  await native('add',project);
  const after=JSON.parse(await readFile(packagePath,'utf8'));
  if(!after.dependencies?.[name]||after.dependencies?.[legacy])throw new Error('Renamed plugin migration did not reconcile');
  for(const[key,val]of Object.entries(before.dependencies??{}))if(key!==legacy&&key!==name&&after.dependencies?.[key]!==val)throw new Error('Unexpected change to '+key);
  for(const bundle of before.dsh?.profile?.bundles??[])if(bundle!==legacy&&!after.dsh?.profile?.bundles?.includes(bundle))throw new Error('An unrelated bundle disappeared');
  console.log(JSON.stringify({status:'installed',profile,name,source:after.dependencies[name],migratedLegacy:Boolean(before.dependencies?.[legacy]),backup,note:'Normal DSH reload/restart; Settings → 相续人格, optional preset 相续人格. Default preset and user memory are not replaced.'}));
}
