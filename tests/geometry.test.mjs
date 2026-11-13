import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentsToGraph, mergeSegments, graphToLayout, layoutToGraph, validateLayout } from '../web/lib/geometry.js';
import { readFileSync } from 'node:fs';
const segment = (ax, ay, bx, by) => ({ a: { x: ax, y: ay }, b: { x: bx, y: by } });
test('T intersection splits long wall', () => assert.equal(segmentsToGraph([segment(0, 0, 100, 0), segment(50, 0, 50, 100)], 0).walls.length, 3));
test('cross intersection makes four connected edges', () => {
  const g = segmentsToGraph([segment(0, 50, 100, 50), segment(50, 0, 50, 100)], 0); assert.equal(g.walls.length, 4);
  assert.ok(g.nodes.some(n => g.walls.filter(w => w.a === n.id || w.b === n.id).length === 4));
});
test('gap is not closed with zero gap tolerance', () => assert.equal(mergeSegments([segment(0, 0, 40, 0), segment(60, 0, 100, 0)]).length, 2));
test('collinear fragments merge', () => assert.equal(mergeSegments([segment(0, 0, 50, 0), segment(50, 0, 100, 0)]).length, 1));
test('parallel walls remain separate', () => assert.equal(mergeSegments([segment(0, 0, 100, 0), segment(0, 10, 100, 10)]).length, 2));
test('coordinates invert image Y and use metres', () => {
  const g = segmentsToGraph([segment(100, 100, 500, 100)], 0);
  const value = graphToLayout(g, { pixelsPerMeter: 100, origin: { x: 0, y: 400 }, wallHeight: 2.5, wallThickness: 0.15, layoutId: 'test', revision: 1 });
  assert.deepEqual(value.walls[0], { id: 'wall-001', ax: 1, ay: 3, bx: 5, by: 3 });
});
test('validation rejects duplicate ids and string coordinates', () => {
  const v = { schemaVersion: 1, layoutId: 'x', revision: 1, units: 'm', wallHeight: 2.5, wallThickness: 0.15, walls: [{ id: 'a', ax: '0', ay: 0, bx: 1, by: 0 }] };
  assert.ok(validateLayout(v).length); v.walls[0].ax = 0; v.walls.push({ ...v.walls[0] }); assert.ok(validateLayout(v).length);
});
test('validation accepts an explicit clear request', () => assert.deepEqual(validateLayout({ schemaVersion: 1, layoutId: 'clear', revision: 1, units: 'm', wallHeight: 2.5, wallThickness: 0.15, walls: [] }), []));
test('sample JSON schema is compatible and round-trips geometry', () => {
  const layout = JSON.parse(readFileSync(new URL('../web/samples/sample_floorplan.json', import.meta.url)));
  assert.deepEqual(validateLayout(layout), []); const converted = layoutToGraph(layout);
  const result = graphToLayout(converted.graph, { ...converted, ...layout });
  const pairs = l => l.walls.map(w => [[w.ax, w.ay], [w.bx, w.by]].sort().join('|')).sort();
  assert.deepEqual(pairs(result), pairs(layout));
});
test('multiple endpoint extensions do not distort later intersections', () => {
  const g = segmentsToGraph([
    segment(1008, 763, 1008, 197), segment(1004, 192, 196, 192),
    segment(192, 196, 192, 764), segment(197, 768, 1005, 768),
    segment(1008, 480, 604, 480), segment(600, 484, 600, 768)
  ], 5);
  assert.equal(g.walls.length, 8);
  assert.ok(g.nodes.some(n => n.x === 1008 && n.y === 480));
  const nodes = new Map(g.nodes.map(n => [n.id,n]));
  assert.ok(g.walls.every(w => nodes.get(w.a).x === nodes.get(w.b).x || nodes.get(w.a).y === nodes.get(w.b).y));
});
