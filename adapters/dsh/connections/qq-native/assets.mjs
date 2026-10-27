import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

export const QQ_NATIVE_PROTOCOL='xiangxu-qq-native/1';
export const QQ_NATIVE_ABI_VERSION='qq-win-53644-req-to-friend/1';
export const QQ_NATIVE_WRAPPER=Object.freeze({relativePath:'versions/9.9.36-53644/resources/app/wrapper.node',bytes:117866024,sha256:'0d8b94448f4dafe7337b88d6a568b004224c37fcbe2bd1142c1af7624fbd534c'});
export const QQ_NATIVE_BUNDLE_SHA256='7c66d0239d7effe73ab6e4920eddef732a8066fb47cd19539541c72055c5f0aa';
export const QQ_NATIVE_ASSET_FILES=Object.freeze(['assets.mjs','journal.mjs','loader.cjs','service.mjs','session-tap.mjs']);

export async function createNativeRuntimeAssetsConfig({assetRoot=path.dirname(fileURLToPath(import.meta.url)),fsPort=fs}={}){
  assetRoot=path.resolve(assetRoot);const assetHashes={};
  for(const name of QQ_NATIVE_ASSET_FILES){
    const file=path.join(assetRoot,name);let cursor=path.parse(file).root;
    for(const part of file.slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,part);const stat=await fsPort.lstat(cursor);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink!==1)throw Object.assign(new Error('Native runtime assets must be regular owned files'),{code:'QQ_NATIVE_ASSET_PATH'});}
    const stat=await fsPort.lstat(file);if(!stat.isFile()||stat.size>2097152)throw Object.assign(new Error('Native runtime asset size is invalid'),{code:'QQ_NATIVE_ASSET_CAPACITY'});
    assetHashes[name]=createHash('sha256').update(await fsPort.readFile(file)).digest('hex');
  }
  return{enabled:true,protocol:QQ_NATIVE_PROTOCOL,abiVersion:QQ_NATIVE_ABI_VERSION,assetRoot,assetHashes,loaderPath:path.join(assetRoot,'loader.cjs'),wrapperRelativePath:QQ_NATIVE_WRAPPER.relativePath,wrapperSha256:QQ_NATIVE_WRAPPER.sha256,officialBundleSha256:QQ_NATIVE_BUNDLE_SHA256};
}
