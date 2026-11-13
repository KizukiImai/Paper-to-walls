import test from 'node:test';
import assert from 'node:assert/strict';
import { straighteningTolerance, straightenPaths, fitLine } from '../web/lib/straighten.js';
import { vectorizePaths, recognize, warpImage } from '../web/lib/vision-core.js';
import { readPng } from './helpers/png.mjs';
const wavy = (x0=100,x1=700,y=250,amplitude=8) => Array.from({length:x1-x0+1},(_,i)=>({x:x0+i,y:y+amplitude*Math.sin(i/(x1-x0)*Math.PI*8)}));
const config = {minLength:5,snap:0,axisSnap:false};
test('straightening tolerance is monotonic and relative to processing resolution',()=>{
  for(let s=0;s<100;s++) assert.ok(straighteningTolerance(s+1)>straighteningTolerance(s));
  assert.equal(straighteningTolerance(70,600,450)*2,straighteningTolerance(70,1200,900));
});
test('wobbly stroke becomes one fitted line, not many bent wall pieces',()=>{
  const paths=[wavy()],copy=structuredClone(paths);
  const low=vectorizePaths(paths,900,650,{...config,straightness:0});
  const high=vectorizePaths(paths,900,650,{...config,straightness:80});
  assert.ok(low.graph.walls.length>10);assert.equal(high.graph.walls.length,1);
  assert.deepEqual(paths,copy,'raw centerlines must remain immutable');
  assert.deepEqual(vectorizePaths(paths,900,650,{...config,straightness:0}),low,'decreasing strength must restore detail');
});
test('least squares uses entire stroke, not just shaky endpoints',()=>{
  const points=wavy();points[0].y+=10;points.at(-1).y+=10;
  const line=fitLine(points,3);assert.ok(Math.abs(line.a.y-250)<1);assert.ok(Math.abs(line.b.y-250)<1);
});
test('strong correction keeps intentional gaps and separated parallel strokes',()=>{
  const paths=[wavy(100,300),wavy(350,700),wavy(100,700,320)];
  const {graph}=vectorizePaths(paths,900,650,{...config,straightness:100});
  assert.equal(graph.walls.length,3);
  assert.equal(graph.nodes.length,6);
});
test('diagonal fitting does not force diagonal strokes horizontal',()=>{
  const path=Array.from({length:501},(_,i)=>({x:100+i,y:70+i*.45+5*Math.sin(i/50)}));
  const [line]=straightenPaths([path],{strength:100,width:900,height:650});
  assert.ok(Math.abs((line.b.y-line.a.y)/(line.b.x-line.a.x)-.45)<.02);
});
test('right-angle corner survives high straightening',()=>{
  const path=[...Array.from({length:301},(_,i)=>({x:100+i,y:100})),...Array.from({length:301},(_,i)=>({x:400,y:100+i}))];
  const {graph}=vectorizePaths([path],900,650,{...config,straightness:100});assert.equal(graph.walls.length,2);
});
test('horizontal snap is independent of straightening strength',()=>{
  const path=Array.from({length:501},(_,i)=>({x:100+i,y:100+i*Math.tan(6*Math.PI/180)}));
  const a=straightenPaths([path],{strength:80,axisAngle:3})[0],b=straightenPaths([path],{strength:80,axisAngle:8})[0];
  assert.ok(Math.abs(a.a.y-a.b.y)>40);assert.ok(Math.abs(b.a.y-b.b.y)<.001);
});
for(const [name,expected] of [['wavy-line',1],['wavy-room',8]]) test(`raster hand-wobble fixture: ${name} changes with UI parameter`,()=>{
  const image=readPng(new URL(`../web/samples/${name}.png`,import.meta.url));const {width:w,height:h}=image;
  const rectified=warpImage(image,[{x:0,y:0},{x:w-1,y:0},{x:w-1,y:h-1},{x:0,y:h-1}],0,1200);
  const low=recognize(rectified,{straightness:0}),high=recognize(rectified,{straightness:80});
  assert.equal(high.graph.walls.length,expected);assert.ok(low.graph.walls.length>expected*2);
  if(name==='wavy-line') assert.ok(Math.abs(high.graph.nodes[0].y-high.graph.nodes[1].y)<0.001,'axis snapped line must be exactly horizontal despite skeleton spurs');
  if(name==='wavy-room') {
    const degrees=high.graph.nodes.map(n=>high.graph.walls.filter(w=>w.a===n.id||w.b===n.id).length);
    assert.equal(degrees.filter(d=>d===3).length,2,'both T junctions remain connected');
  }
});
