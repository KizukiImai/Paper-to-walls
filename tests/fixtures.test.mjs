import test from 'node:test';
import assert from 'node:assert/strict';
import { readPng } from './helpers/png.mjs';
import { readFileSync } from 'node:fs';
import { warpImage, recognize, estimatePaper } from '../web/lib/vision-core.js';
const cases = [['room',8],['rectangle',4],['L',2],['T',3],['cross',4],['diagonal',1],['gap',2],['thick',1],['handdrawn-lighting',8]];
for (const [name, expected] of cases) test(`PNG fixture at processing resolution: ${name}`, () => {
  const image=readPng(new URL(`../web/samples/${name}.png`,import.meta.url));
  const corners=[{x:0,y:0},{x:image.width-1,y:0},{x:image.width-1,y:image.height-1},{x:0,y:image.height-1}];
  const result=recognize(warpImage(image,corners,0,1200));
  assert.equal(result.graph.walls.length,expected,JSON.stringify(result.graph));
});
test('perspective camera-like fixture rectifies to eight walls',()=>{
  const image=readPng(new URL('../web/samples/perspective.png',import.meta.url));
  const {corners,aspect}=JSON.parse(readFileSync(new URL('../web/samples/perspective-corners.json',import.meta.url)));
  const result=recognize(warpImage(image,corners,aspect,1200));
  assert.equal(result.graph.walls.length,8,JSON.stringify(result.graph));
});
test('automatic paper candidate stays close to synthetic paper corners',()=>{
  const image=readPng(new URL('../web/samples/perspective.png',import.meta.url));
  const {corners}=JSON.parse(readFileSync(new URL('../web/samples/perspective-corners.json',import.meta.url)));
  const estimated=estimatePaper(image);assert.equal(estimated.confidence,'candidate');
  assert.ok(estimated.corners.every((p,i)=>Math.hypot(p.x-corners[i].x,p.y-corners[i].y)<20));
});
