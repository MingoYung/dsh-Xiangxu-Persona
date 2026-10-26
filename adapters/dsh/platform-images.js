const get = (ctx,key) => { try { return ctx.get?.(key,false) ?? ctx[key]; } catch { return undefined; } };
export const PLATFORM_IMAGE_LIMITS = Object.freeze({ images: 4, bytes: 16777216 });
/** Images are real host attachments, never base64 text in persona memory. */
export async function attachPlatformImages(ctx, agent, result, signal) {
  const { sheets, ...metadata } = result ?? {};
  if (!Array.isArray(sheets) || !sheets.length) return result;
  const descriptions = sheets.map(({ bytes, ...sheet }) => ({ ...sheet, bytesLength: bytes?.byteLength ?? 0 }));
  const base = { ...metadata, sheets: descriptions, visualAvailable: false, imageAttached: false };
  const attachments = get(ctx,'attachments'), llm = get(ctx,'llm');
  if (!attachments?.saveImages || !llm?.resolveModelInfo) return { ...base, imageUnavailable: 'host_image_service_missing' };
  if (sheets.length > PLATFORM_IMAGE_LIMITS.images || sheets.reduce((n,s)=>n+(s.bytes?.byteLength??0),0) > PLATFORM_IMAGE_LIMITS.bytes || sheets.some(s=>!(s.bytes instanceof Uint8Array)||!s.bytes.length||!['image/jpeg','image/png','image/webp'].includes(s.mime))) return { ...base, imageUnavailable: 'attachment_capacity' };
  try {
    const config = agent?.session?.requestHeader?.()?.config ?? agent?.options ?? {};
    const model = await llm.resolveModelInfo(config.provider,config.model,signal);
    if (!model?.inputModalities?.includes('image')) return { ...base, imageUnavailable: 'model_does_not_declare_image_input' };
    const refs = await attachments.saveImages(sheets.map(s=>({ data: Buffer.from(s.bytes), mediaType: s.mime })));
    if (!Array.isArray(refs)||refs.length!==sheets.length) return { ...base, imageUnavailable:'host_attachment_unconfirmed' };
    return { ...base, imageAttached: true, visualAvailable: true, images: refs, visualCoverage: 'storyboard_sheets_with_selected_crop_rectangles; not continuous video frames' };
  } catch { return { ...base, imageUnavailable: 'host_image_attachment_failed' }; }
}

export function renderPlatformOutput(_args,value) {
  const { images, ...rest } = value ?? {};
  return [{ type:'text',text:JSON.stringify(rest) }, ...(Array.isArray(images)?images.map(attachment=>({type:'image',attachment})):[])];
}
