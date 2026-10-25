import qrcode from './vendor/qrcode.mjs';

/** The pairing URL stays on this machine; no third-party QR image service. */
export function createPairingQr(value) {
  if (typeof value !== 'string' || value.length > 1024) throw new TypeError('Pairing URL exceeds the QR limit');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || !/^#pair=[A-Za-z0-9_-]{32,128}$/.test(url.hash)) throw new TypeError('Expected a mobile pairing URL');
  const normalized = url.href;
  if (normalized.length > 1024) throw new TypeError('Pairing URL exceeds the QR limit');
  const code = qrcode(0, 'M');
  code.addData(normalized, 'Byte'); code.make();
  const svg = code.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}
