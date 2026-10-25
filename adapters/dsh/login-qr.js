import qrcode from './vendor/qrcode.mjs';
/** Locally render only the authentication content returned by a connector. */
export function createLoginQr(value){
  if(typeof value!=='string'||!value||Buffer.byteLength(value)>2048)throw new TypeError('Login QR content exceeds capacity');
  const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new TypeError('Unsupported login QR content');
  if(url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new TypeError('Login requires HTTPS');
  const code=qrcode(0,'M');code.addData(value,'Byte');code.make();return'data:image/svg+xml;base64,'+Buffer.from(code.createSvgTag({cellSize:4,margin:16,scalable:true}),'utf8').toString('base64');
}
