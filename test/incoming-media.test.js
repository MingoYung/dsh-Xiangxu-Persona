import test from 'node:test';
import assert from 'node:assert/strict';
import { createOneBotClient, decodeOneBotEvent } from '../adapters/dsh/channels/onebot.js';
import { createIncomingMediaPort, INCOMING_MEDIA_LIMITS } from '../adapters/dsh/channels/incoming-media.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==','base64');
const profile={platform:'qq',protocol:'onebot11',accountId:'10001',apiUrl:'http://127.0.0.1:9',accessToken:'isolated-fixture'};
const event=(count=1)=>decodeOneBotEvent(profile,{post_type:'message',message_type:'private',self_id:10001,user_id:20002,message_id:30003,time:1,message:Array.from({length:count},(_,index)=>({type:'image',data:{file:'actual-image-'+index+'.png'}}))});
function port(saveImages){return createIncomingMediaPort({ctx:{get:key=>key==='attachments'?{saveImages}:key==='llm'?{resolveModelInfo:async()=>({inputModalities:['text','image']})}:undefined}});}

test('actual OneBot get_image base64 reaches the host attachment API and clears stale unresolved status',async()=>{
  let requests=0,attachments=0;
  const client=createOneBotClient(profile,{fetchImpl:async(url,init)=>{
    requests++;assert.equal(url,'http://127.0.0.1:9/get_image');assert.deepEqual(JSON.parse(init.body),{file:'actual-image-0.png'});
    assert.equal(init.headers.authorization,'Bearer isolated-fixture');
    return Response.json({status:'ok',retcode:0,data:{file:'C:/bridge-only/cache.png',url:'https://not-fetched.invalid/private',base64:png.toString('base64')}});
  }});
  const media=port(async images=>{attachments++;assert.deepEqual(images,[{data:png,mediaType:'image/png'}]);return[{id:'actual-host-image'}];});
  try{
    const result=await media.prepare(event(),{client,config:{resolveIncomingMedia:true}});
    assert.equal(requests,1);assert.equal(attachments,1);assert.deepEqual(result.images,[{id:'actual-host-image'}]);
    assert.equal(result.rich.media[0].status,'image_attached');assert.equal(result.rich.media[0].reason,undefined);
    assert.equal(result.rich.media[0].bytes,png.length);assert.equal(result.rich.perception.images,'image_attached');
    assert.equal(result.rich.perception.understandingConfirmed,false);assert.equal(JSON.stringify(result.rich).includes('bridge-only'),false);
  }finally{media.close();}
});

test('a bridge returning only locators remains unread and reports missing bytes rather than false capacity exhaustion',async()=>{
  let requests=0,attachments=0;
  const client=createOneBotClient(profile,{fetchImpl:async()=>{requests++;return Response.json({status:'ok',retcode:0,data:{file:'C:/private/do-not-read.png',url:'https://untrusted.invalid/do-not-fetch'}});}});
  const media=port(async()=>{attachments++;throw new Error('must not attach');});
  try{
    const result=await media.prepare(event(),{client,config:{resolveIncomingMedia:true}});
    assert.equal(requests,1);assert.equal(attachments,0);assert.deepEqual(result.images,[]);
    assert.equal(result.rich.media[0].status,'not_attached');assert.equal(result.rich.media[0].reason,'bridge_returned_no_safe_bytes');
    assert.match(result.rich.media[0].resolution,/enableLocalFile2Url/);assert.equal(result.rich.perception.images,'not_attached');
    assert.equal(JSON.stringify(result).includes('do-not-read'),false);assert.equal(JSON.stringify(result).includes('do-not-fetch'),false);
  }finally{media.close();}
});

test('unsupported bridges and empty-byte responses have distinct honest causes',async()=>{
  const media=port(async()=>{throw new Error('must not attach');});
  try{
    for(const [loaded,reason]of [[{status:'unsupported'},'bridge_media_unsupported'],[{},'incoming_media_bytes_unavailable'],[{bytes:new Uint8Array()},'incoming_media_bytes_unavailable']]){
      const result=await media.prepare(event(),{client:{resolveMedia:async()=>loaded},config:{resolveIncomingMedia:true}});
      assert.equal(result.rich.media[0].reason,reason);assert.equal(result.rich.media[0].status,'not_attached');assert.deepEqual(result.images,[]);
    }
  }finally{media.close();}
});

test('real aggregate byte exhaustion still stops attachment without claiming the remaining image was read',async()=>{
  let attachments=0;const media=port(async()=>[{id:'image-'+(++attachments)}]),bytes=Buffer.alloc(INCOMING_MEDIA_LIMITS.totalBytes/2);
  try{
    const result=await media.prepare(event(3),{client:{resolveMedia:async()=>({bytes,mime:'image/png'})},config:{resolveIncomingMedia:true}});
    assert.equal(attachments,2);assert.equal(result.images.length,2);assert.equal(result.rich.media[2].reason,'incoming_media_capacity');
    assert.equal(result.rich.media[2].status,'not_attached');assert.equal(result.rich.media[2].bytes,undefined);
  }finally{media.close();}
});
