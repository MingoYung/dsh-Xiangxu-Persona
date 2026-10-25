import test from 'node:test';
import assert from 'node:assert/strict';
import { createPairingQr } from '../adapters/dsh/qr.js';

test('pairing QR is a local SVG matrix with a quiet zone and no remote image URL', () => {
  const output = createPairingQr('http://192.168.1.20:17653/#pair=' + 'a'.repeat(43));
  const svg = Buffer.from(output.split(',')[1], 'base64').toString('utf8');
  assert.match(output, /^data:image\/svg\+xml;base64,/);
  assert.match(svg, /<svg/); assert.match(svg, /<path/); assert.match(svg, /viewBox/);
  assert.doesNotMatch(svg, /<script|<image|pair=|192\.168/);
});

test('QR input accepts only bounded web pairing URLs, without query credentials', () => {
  for (const url of ['javascript:alert(1)', 'http://user:pass@localhost/#pair=' + 'a'.repeat(43),
    'http://localhost/?token=secret#pair=' + 'a'.repeat(43), 'http://localhost/#pair=small', 'http://localhost/#pair=' + 'a'.repeat(2000)]) assert.throws(() => createPairingQr(url));
});
