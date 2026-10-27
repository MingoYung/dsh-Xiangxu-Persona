import {inflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export const NAPCAT_ZIP_LIMITS=Object.freeze({archiveBytes:67108864,entries:12000,fileBytes:134217728,totalBytes:536870912});
const CRC_TABLE=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const value of bytes)crc=CRC_TABLE[(crc^value)&255]^(crc>>>8);return(crc^0xffffffff)>>>0;}
function safeName(raw){const name=new TextDecoder('utf-8',{fatal:true}).decode(raw).replaceAll('\\','/');
  if(!name||name.length>1024||name.startsWith('/')||/[\u0000-\u001f\u007f:]/u.test(name))fail('NAPCAT_ARCHIVE_PATH','组件包含不安全的归档路径');
  const directory=name.endsWith('/'),relative=directory?name.slice(0,-1):name,parts=relative.split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))fail('NAPCAT_ARCHIVE_PATH','组件包含不安全的归档路径');
  return{relative,directory};
}
/** Validate all member paths/types, bounds and content before an installer writes anything. */
export function inspectNapcatZip(input,{limits=NAPCAT_ZIP_LIMITS}={}){
  const bytes=Buffer.isBuffer(input)?input:Buffer.from(input);if(bytes.length<22||bytes.length>limits.archiveBytes)fail('NAPCAT_ARCHIVE_CAPACITY','组件压缩包大小无效');
  let end=-1;for(let p=bytes.length-22;p>=Math.max(0,bytes.length-65557);p--)if(bytes.readUInt32LE(p)===0x06054b50&&p+22+bytes.readUInt16LE(p+20)===bytes.length){end=p;break;}
  if(end<0)fail('NAPCAT_ARCHIVE_FORMAT','组件压缩包目录缺失');
  const disk=bytes.readUInt16LE(end+4),centralDisk=bytes.readUInt16LE(end+6),count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),offset=bytes.readUInt32LE(end+16);
  if(disk||centralDisk||bytes.readUInt16LE(end+8)!==count||!count||count===65535||count>limits.entries||offset+size!==end)fail('NAPCAT_ARCHIVE_FORMAT','不支持此组件压缩格式');
  let p=offset,total=0;const entries=[],names=new Map(),ranges=[];
  for(let n=0;n<count;n++){
    if(p+46>end||bytes.readUInt32LE(p)!==0x02014b50)fail('NAPCAT_ARCHIVE_FORMAT','组件目录结构无效');
    const flags=bytes.readUInt16LE(p+8),method=bytes.readUInt16LE(p+10),crc=bytes.readUInt32LE(p+16),compressed=bytes.readUInt32LE(p+20),uncompressed=bytes.readUInt32LE(p+24),nameLen=bytes.readUInt16LE(p+28),extraLen=bytes.readUInt16LE(p+30),commentLen=bytes.readUInt16LE(p+32),attrs=bytes.readUInt32LE(p+38),local=bytes.readUInt32LE(p+42);
    if(flags&1||![0,8].includes(method)||uncompressed>limits.fileBytes||compressed>limits.archiveBytes||bytes.readUInt16LE(p+34)!==0||p+46+nameLen+extraLen+commentLen>end)fail('NAPCAT_ARCHIVE_FORMAT','组件成员格式或容量无效');
    const raw=bytes.subarray(p+46,p+46+nameLen),name=safeName(raw),alias=name.relative.toLowerCase(),type=(attrs>>>16)&0xf000;
    if(![0,0x8000,0x4000].includes(type)||attrs&0x400||type===0x4000&&!name.directory||names.has(alias))fail('NAPCAT_ARCHIVE_PATH','组件包含链接、特殊文件或重复路径');
    names.set(alias,name.directory);total+=uncompressed;if(total>limits.totalBytes)fail('NAPCAT_ARCHIVE_CAPACITY','组件解压容量超过限制');
    if(local+30>offset||bytes.readUInt32LE(local)!==0x04034b50||bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method)fail('NAPCAT_ARCHIVE_FORMAT','组件本地成员头无效');
    const localName=bytes.readUInt16LE(local+26),localExtra=bytes.readUInt16LE(local+28),start=local+30+localName+localExtra;
    if(localName!==nameLen||!bytes.subarray(local+30,local+30+localName).equals(raw)||start+compressed>offset)fail('NAPCAT_ARCHIVE_FORMAT','组件路径或数据范围不一致');
    ranges.push([local,start+compressed]);const entry={...name,method,crc,compressedBytes:compressed,bytes:uncompressed,start};
    const content=readNapcatZipMember(bytes,entry);entry.sha256=createHash('sha256').update(content).digest('hex');entries.push(entry);p+=46+nameLen+extraLen+commentLen;
  }
  if(p!==offset+size)fail('NAPCAT_ARCHIVE_FORMAT','组件目录长度不一致');
  ranges.sort((a,b)=>a[0]-b[0]);for(let i=1;i<ranges.length;i++)if(ranges[i][0]<ranges[i-1][1])fail('NAPCAT_ARCHIVE_FORMAT','组件成员数据重叠');
  for(const [name,directory]of names){const parts=name.split('/');for(let i=1;i<parts.length;i++)if(names.get(parts.slice(0,i).join('/'))===false)fail('NAPCAT_ARCHIVE_PATH','组件文件与目录路径冲突');if(directory&&entries.find(e=>e.relative.toLowerCase()===name)?.bytes)fail('NAPCAT_ARCHIVE_FORMAT','组件目录不能携带文件内容');}
  return{entries,totalBytes:total,archiveBytes:bytes.length};
}
export function readNapcatZipMember(input,entry){const bytes=Buffer.isBuffer(input)?input:Buffer.from(input),packed=bytes.subarray(entry.start,entry.start+entry.compressedBytes);let content;
  try{content=entry.method===0?Buffer.from(packed):inflateRawSync(packed,{maxOutputLength:Math.max(1,entry.bytes)});}catch{fail('NAPCAT_ARCHIVE_FORMAT','组件成员不能安全解压');}
  if(content.length!==entry.bytes||crc32(content)!==entry.crc)fail('NAPCAT_ARCHIVE_INTEGRITY','组件成员校验不一致');return content;
}
