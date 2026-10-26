import { createHash } from 'node:crypto';
const get = (ctx,key) => { try { return ctx.get?.(key,false) ?? ctx[key]; } catch { return undefined; } };
export const INCOMING_MEDIA_LIMITS = Object.freeze({ attachments: 4, totalBytes: 16777216, audioBytes: 8388608, transcriptChars: 8000, durationSeconds: 180, timeoutMs: 60000 });
const fail = code => { throw Object.assign(new Error('入站媒体未完成处理'),{code}); };
async function boundedAwait(promise,signal){
  if(signal.aborted)fail('INCOMING_MEDIA_CANCELLED');let abort;
  const interrupted=new Promise((_,reject)=>{abort=()=>reject(Object.assign(new Error('入站媒体处理已取消'),{code:'INCOMING_MEDIA_CANCELLED'}));signal.addEventListener('abort',abort,{once:true});});
  try{return await Promise.race([promise,interrupted]);}finally{signal.removeEventListener('abort',abort);}
}

/** PCM16 WAV to the actual DSH speech input format, bounded before allocation. */
export function mono16kWav(input) {
  const bytes = Buffer.from(input); if (bytes.length < 44 || bytes.length > INCOMING_MEDIA_LIMITS.audioBytes || bytes.toString('ascii',0,4)!=='RIFF' || bytes.toString('ascii',8,12)!=='WAVE') fail('INCOMING_AUDIO_FORMAT');
  let format, payload; for (let at=12; at+8<=bytes.length;) {
    const type=bytes.toString('ascii',at,at+4), length=bytes.readUInt32LE(at+4), start=at+8;
    if(start+length>bytes.length)fail('INCOMING_AUDIO_FORMAT');
    if(type==='fmt '){if(length<16)fail('INCOMING_AUDIO_FORMAT');format={codec:bytes.readUInt16LE(start),channels:bytes.readUInt16LE(start+2),rate:bytes.readUInt32LE(start+4),align:bytes.readUInt16LE(start+12),bits:bytes.readUInt16LE(start+14)};}
    if(type==='data'){if(payload)fail('INCOMING_AUDIO_FORMAT');payload=bytes.subarray(start,start+length);}at=start+length+(length%2);
  }
  if(!format||!payload||format.codec!==1||format.bits!==16||![1,2].includes(format.channels)||format.rate<8000||format.rate>96000||format.align!==format.channels*2||!payload.length||payload.length%format.align)fail('INCOMING_AUDIO_FORMAT');
  const samples=payload.length/format.align,duration=samples/format.rate;if(duration>INCOMING_MEDIA_LIMITS.durationSeconds)fail('INCOMING_AUDIO_DURATION');
  const count=Math.max(1,Math.floor(duration*16000)),out=Buffer.alloc(44+count*2);
  out.write('RIFF',0);out.writeUInt32LE(out.length-8,4);out.write('WAVEfmt ',8);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);out.writeUInt32LE(16000,24);out.writeUInt32LE(32000,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);out.write('data',36);out.writeUInt32LE(count*2,40);
  const sample=index=>{let value=0;for(let channel=0;channel<format.channels;channel++)value+=payload.readInt16LE(Math.min(samples-1,index)*format.align+channel*2);return value/format.channels;};
  for(let index=0;index<count;index++){const position=index*format.rate/16000,left=Math.floor(position),fraction=position-left;out.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(sample(left)*(1-fraction)+sample(left+1)*fraction))),44+index*2);}
  return out;
}

/** Optional host media ports. Received files remain data with their own actor
 * and recognition coverage; a transcript is not the person's typed original. */
export function createIncomingMediaPort({ ctx } = {}) {
  const controllers = new Set(); let closed=false,epoch=0;
  const cancel=()=>{epoch++;for(const controller of controllers)controller.abort();};
  return {
    async prepare(event,{client,binding,config={}}={}) {
      const rich=event.rich;if(!rich)return {rich:null,derived:[],images:[]};
      const cancelled=()=>({rich:{...structuredClone(rich),perception:{images:'not_attached',audio:'not_transcribed',reason:'incoming_media_processing_cancelled',understandingConfirmed:false}},derived:[],images:[]});
      if(closed)return cancelled();const startedEpoch=epoch;
      const result={rich:structuredClone(rich),derived:[],images:[]};
      if(config.resolveIncomingMedia!==true||typeof client?.resolveMedia!=='function'){result.rich.perception={...rich.perception,reason:'incoming_media_resolution_disabled_or_unsupported'};return result;}
      const media=(rich.media??[]).filter(m=>['image','audio'].includes(m.kind)),controller=new AbortController();controllers.add(controller);let total=0;
      try {
        const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(INCOMING_MEDIA_LIMITS.timeoutMs)]);
        if(closed)controller.abort();
        const attachments=get(ctx,'attachments'),llm=get(ctx,'llm'),selection=binding?.agentOptions??get(ctx,'agentDefaultModel')?.currentSelection?.()??{};
        let vision=false;if(attachments?.saveImages&&llm?.resolveModelInfo){try{vision=(await boundedAwait(llm.resolveModelInfo(selection.provider,selection.model,signal),signal))?.inputModalities?.includes('image')===true;}catch{}}
        for(const item of media.slice(0,INCOMING_MEDIA_LIMITS.attachments)){
          if(closed||signal.aborted||epoch!==startedEpoch)return cancelled();
          const entry=result.rich.media.find(m=>m.segmentIndex===item.segmentIndex);
          if(item.kind==='image'&&!vision){entry.status='not_attached';entry.reason='host_or_model_image_input_unavailable';continue;}
          if(item.kind==='audio'&&config.transcribeIncomingAudio!==true){entry.status='not_transcribed';entry.reason='incoming_audio_transcription_disabled';continue;}
          try {
            const loaded=await boundedAwait(client.resolveMedia({kind:item.kind,fileId:item.fileId},{signal}),signal);
            const bytes=loaded?.bytes;if(!(bytes instanceof Uint8Array)||!bytes.byteLength||total+bytes.byteLength>INCOMING_MEDIA_LIMITS.totalBytes){entry.reason='incoming_media_capacity';continue;}total+=bytes.byteLength;
            entry.sha256=createHash('sha256').update(bytes).digest('hex');entry.bytes=bytes.byteLength;
            if(item.kind==='image'){
              if(!['image/png','image/jpeg','image/webp'].includes(loaded.mime)){entry.reason='unsupported_image_format';continue;}
              const refs=await boundedAwait(attachments.saveImages([{data:Buffer.from(bytes),mediaType:loaded.mime}]),signal);
              if(closed||signal.aborted||epoch!==startedEpoch)return cancelled();
              if(!Array.isArray(refs)||refs.length!==1){entry.reason='host_attachment_unconfirmed';continue;}
              result.images.push(refs[0]);entry.status='image_attached';
            }else{
              const stt=get(ctx,'speechToText');if(!stt?.resolve||!stt?.transcribe){entry.reason='host_speech_input_unavailable';continue;}
              const spec=stt.resolve({audio:new Uint8Array(mono16kWav(bytes))}),transcribed=await boundedAwait(stt.transcribe(spec,signal),signal),text=typeof transcribed==='string'?transcribed:transcribed?.text??transcribed?.transcript;
              if(closed||signal.aborted||epoch!==startedEpoch)return cancelled();
              if(typeof text!=='string'||!text.trim()||Array.from(text).length>INCOMING_MEDIA_LIMITS.transcriptChars){entry.reason='transcript_empty_or_capacity';continue;}
              result.derived.push({kind:'audio_transcript',text,sourceSegmentIndex:item.segmentIndex,sourceMessageId:event.message.id,recognition:'host_stt_output',verbatimTypedText:false});entry.status='transcribed';
            }
          }catch(error){if(closed||signal.aborted||epoch!==startedEpoch)return cancelled();entry.status=item.kind==='image'?'not_attached':'not_transcribed';entry.reason=/^[A-Z0-9_]{1,80}$/.test(error?.code??'')?error.code:'incoming_media_processing_failed';}
        }
        result.rich.perception={images:result.images.length?'image_attached':'not_attached',audio:result.derived.length?'transcribed':'not_transcribed',processedMedia:Math.min(media.length,INCOMING_MEDIA_LIMITS.attachments),remainingMedia:Math.max(0,media.length-INCOMING_MEDIA_LIMITS.attachments),understandingConfirmed:false};
        return result;
      }finally{controllers.delete(controller);}
    },
    cancel,
    close(){closed=true;cancel();},
  };
}
