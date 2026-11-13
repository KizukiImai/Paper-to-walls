// Minimal PNG decoder for trusted, generated RGB/RGBA fixtures. Not used by the application.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
export function readPng(file) {
  const bytes = readFileSync(file), chunks = []; let width, height, channels;
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Not PNG');
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8), data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); if (data[8] !== 8 || ![2, 6].includes(data[9]) || data[12]) throw new Error('Unsupported fixture encoding'); channels = data[9] === 2 ? 3 : 4; }
    if (type === 'IDAT') chunks.push(data); offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels, rgb = new Uint8Array(height * stride);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? rgb[y * stride + x - channels] : 0, b = y ? rgb[(y - 1) * stride + x] : 0, c = y && x >= channels ? rgb[(y - 1) * stride + x - channels] : 0;
      rgb[y * stride + x] = raw[y * (stride + 1) + x + 1] + (filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? paeth(a, b, c) : (() => { throw new Error('Invalid filter'); })());
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) { data[i * 4] = rgb[i * channels]; data[i * 4 + 1] = rgb[i * channels + 1]; data[i * 4 + 2] = rgb[i * channels + 2]; data[i * 4 + 3] = channels === 4 ? rgb[i * channels + 3] : 255; }
  return { width, height, data };
}
