import test from 'node:test';
import assert from 'node:assert/strict';
import { recognize, thin, homography, warpImage, estimatePaper } from '../web/lib/vision-core.js';
import { projectPoint, validQuad } from '../web/lib/geometry.js';

export function raster(lines, width = 400, height = 320, thickness = 7) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [ax, ay, bx, by] of lines) {
    for (let y = Math.max(0, Math.floor(Math.min(ay, by) - thickness)); y < Math.min(height, Math.max(ay, by) + thickness + 1); y++)
      for (let x = Math.max(0, Math.floor(Math.min(ax, bx) - thickness)); x < Math.min(width, Math.max(ax, bx) + thickness + 1); x++)
        if (projectPoint({ x, y }, { x: ax, y: ay }, { x: bx, y: by }).distance <= thickness / 2) { const k = (y * width + x) * 4; data[k] = data[k + 1] = data[k + 2] = 20; }
  }
  return { data, width, height };
}
const rect = [[60, 50, 340, 50], [340, 50, 340, 270], [340, 270, 60, 270], [60, 270, 60, 50]];
const cases = [
  ['rectangle', rect, 4],
  ['L junction', [[60, 50, 60, 270], [60, 270, 340, 270]], 2],
  ['T junction', [[60, 60, 340, 60], [200, 60, 200, 270]], 3],
  ['cross junction', [[60, 160, 340, 160], [200, 50, 200, 270]], 4],
  ['diagonal', [[70, 60, 330, 260]], 1],
  ['intentional gap', [[60, 160, 170, 160], [210, 160, 340, 160]], 2],
  ['room and internal walls', [...rect, [200, 270, 200, 130], [200, 130, 340, 130]], 8]
];
for (const [name, lines, expected] of cases) test(`recognize: ${name}`, () => {
  const result = recognize(raster(lines));
  assert.equal(result.graph.walls.length, expected, JSON.stringify(result.graph));
  assert.ok(result.graph.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)));
});
test('thick single stroke is one wall, not two boundaries', () => assert.equal(recognize(raster([[60, 160, 340, 160]], 400, 320, 21)).graph.walls.length, 1));
test('blank image has no walls', () => assert.equal(recognize(raster([])).graph.walls.length, 0));
test('nearby parallel walls are not merged', () => assert.equal(recognize(raster([[60, 140, 340, 140], [60, 165, 340, 165]])).graph.walls.length, 2));
test('thinning preserves a one-pixel stroke', () => {
  const a = new Uint8Array(100); for (let x = 2; x < 8; x++) a[50 + x] = 1;
  assert.deepEqual(thin(a, 10, 10), a);
});
test('homography identity', () => {
  const p = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const h = homography(p, p); assert.ok(Math.abs(h[0] - 1) < 1e-8 && Math.abs(h[4] - 1) < 1e-8 && Math.abs(h[8] - 1) < 1e-8);
});
test('perspective correction preserves a clean rectangle', () => {
  const image = raster(rect), corners = [{ x: 0, y: 0 }, { x: 399, y: 0 }, { x: 399, y: 319 }, { x: 0, y: 319 }];
  const result = recognize(warpImage(image, corners, 0, 400)); assert.equal(result.graph.walls.length, 4);
});
test('self-crossing crop is rejected', () => assert.equal(validQuad([{ x: 0, y: 0 }, { x: 200, y: 200 }, { x: 200, y: 0 }, { x: 0, y: 200 }]), false));
test('paper estimation returns valid bounds on white image', () => assert.equal(validQuad(estimatePaper(raster([])).corners), true));
