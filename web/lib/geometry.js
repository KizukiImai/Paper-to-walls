/** Geometry shared by the editor, recognizer, exporter and tests. No DOM dependencies. */
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const clone = (value) => structuredClone(value);
export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
export const cross = (a, b) => a.x * b.y - a.y * b.x;
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const lerpPoint = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function projectPoint(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  const point = lerpPoint(a, b, clamp(t, 0, 1));
  return { point, t, distance: distance(p, point) };
}
export function boundsOf(points) {
  if (!points.length) return { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
export function simplifyPolyline(points, tolerance = 2.5) {
  if (points.length < 3) return points.slice();
  // Iterative Ramer–Douglas–Peucker: avoids recursion limits for long pen strokes.
  const keep = new Uint8Array(points.length); keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop(); let maxD = tolerance, index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = projectPoint(points[i], points[first], points[last]).distance;
      if (d > maxD) { maxD = d; index = i; }
    }
    if (index !== -1) { keep[index] = 1; stack.push([first, index], [index, last]); }
  }
  return points.filter((_, i) => keep[i]);
}
export function graphSegments(graph) {
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  return graph.walls.flatMap(w => nodes.has(w.a) && nodes.has(w.b) ? [{ a: { ...nodes.get(w.a) }, b: { ...nodes.get(w.b) }, id: w.id }] : []);
}
export function normalizeGraph(graph, minLength = 0.5) {
  const nodes = new Map(graph.nodes.filter(n => Number.isFinite(n.x) && Number.isFinite(n.y)).map(n => [n.id, n]));
  const seen = new Set(); const used = new Set();
  const walls = graph.walls.filter(w => {
    if (!nodes.has(w.a) || !nodes.has(w.b) || distance(nodes.get(w.a), nodes.get(w.b)) < minLength) return false;
    const key = [w.a, w.b].sort().join('|'); if (seen.has(key)) return false;
    seen.add(key); used.add(w.a); used.add(w.b); return true;
  });
  return { nodes: [...nodes.values()].filter(n => used.has(n.id)), walls };
}

/** Convert line segments into a graph; split actual crossings and near T/L joins. */
export function segmentsToGraph(input, snap = 5) {
  const segments = input.filter(s => distance(s.a, s.b) >= 1).map(s => ({ a: { x: s.a.x, y: s.a.y }, b: { x: s.b.x, y: s.b.y } }));
  if (segments.length > 1800) throw new Error('線が多すぎます。用紙の範囲を絞るか、ノイズ除去を強めてください。');
  // Keep all input endpoints immutable while computing intersections. Mutating a line
  // before testing its other intersections changes its parameterization and creates spurs.
  const cuts = segments.map(() => []);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i], r = sub(s.b, s.a), lr = distance(s.a, s.b);
    for (let j = i + 1; j < segments.length; j++) {
      const t = segments[j], d = sub(t.b, t.a), ld = distance(t.a, t.b), den = cross(r, d);
      if (Math.abs(den) <= 1e-6 * lr * ld) continue;
      const delta = sub(t.a, s.a), u = cross(delta, d) / den, v = cross(delta, r) / den;
      const epsilon = 1e-8;
      if (u >= -snap / lr - epsilon && u <= 1 + snap / lr + epsilon && v >= -snap / ld - epsilon && v <= 1 + snap / ld + epsilon) {
        cuts[i].push(u); cuts[j].push(v);
      }
    }
  }
  const nodes = [], walls = [], keys = new Set();
  const nodeTolerance = Math.max(0.25, Math.min(snap, 2.5));
  const nodeFor = p => {
    let n = nodes.find(n => distance(n, p) <= nodeTolerance);
    if (!n) { n = { id: `node-${nodes.length + 1}`, x: +p.x.toFixed(4), y: +p.y.toFixed(4) }; nodes.push(n); }
    return n.id;
  };
  segments.forEach((s, i) => {
    const tolerance = snap / distance(s.a, s.b) + 1e-8;
    const nearStart = cuts[i].filter(t => Math.abs(t) <= tolerance).sort((a, b) => Math.abs(a) - Math.abs(b));
    const nearEnd = cuts[i].filter(t => Math.abs(t - 1) <= tolerance).sort((a, b) => Math.abs(a - 1) - Math.abs(b - 1));
    const start = nearStart[0] ?? 0, end = nearEnd[0] ?? 1;
    const ts = [start, ...cuts[i].filter(t => t > start + 1e-8 && t < end - 1e-8), end].sort((a, b) => a - b);
    for (let k = 0; k < ts.length - 1; k++) {
      const a = nodeFor(lerpPoint(s.a, s.b, ts[k])), b = nodeFor(lerpPoint(s.a, s.b, ts[k + 1]));
      const key = [a, b].sort().join('|');
      if (a !== b && !keys.has(key)) { walls.push({ id: `wall-${String(walls.length + 1).padStart(3, '0')}`, a, b }); keys.add(key); }
    }
  });
  return normalizeGraph({ nodes, walls });
}

/** Coalesce duplicate/collinear segments. Separated parallel strokes remain independent. */
export function mergeSegments(input, { angleDeg = 3, perpendicular = 2, gap = 0, axisSnap = true, axisAngleDeg = angleDeg } = {}) {
  let segments = input.map(s => ({ a: { ...s.a }, b: { ...s.b } }));
  if (axisSnap) for (const s of segments) {
    const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
    if (Math.abs(dy) <= Math.abs(dx) * Math.tan(axisAngleDeg * Math.PI / 180)) s.a.y = s.b.y = (s.a.y + s.b.y) / 2;
    else if (Math.abs(dx) <= Math.abs(dy) * Math.tan(axisAngleDeg * Math.PI / 180)) s.a.x = s.b.x = (s.a.x + s.b.x) / 2;
  }
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      let len = distance(s.a, s.b); if (len < 1) continue;
      for (let j = i + 1; j < segments.length; j++) {
        const t = segments[j], lt = distance(t.a, t.b); if (lt < 1) continue;
        const dx = (s.b.x - s.a.x) / len, dy = (s.b.y - s.a.y) / len;
        const dot = Math.abs((dx * (t.b.x - t.a.x) + dy * (t.b.y - t.a.y)) / lt);
        if (dot < Math.cos(angleDeg * Math.PI / 180)) continue;
        const dist = p => Math.abs((p.x - s.a.x) * dy - (p.y - s.a.y) * dx);
        if (Math.max(dist(t.a), dist(t.b)) > perpendicular) continue;
        const proj = p => (p.x - s.a.x) * dx + (p.y - s.a.y) * dy;
        const lo = Math.min(proj(t.a), proj(t.b)), hi = Math.max(proj(t.a), proj(t.b));
        if (lo > len + gap || hi < -gap) continue;
        const origin = { ...s.a }, min = Math.min(0, lo), max = Math.max(len, hi);
        s.a = { x: origin.x + min * dx, y: origin.y + min * dy };
        s.b = { x: origin.x + max * dx, y: origin.y + max * dy };
        segments.splice(j--, 1); len = max - min; changed = true;
      }
    }
    if (!changed) break;
  }
  return segments;
}

export function validQuad(points) {
  if (!Array.isArray(points) || points.length !== 4 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  const turns = points.map((p, i) => cross(sub(points[(i + 1) % 4], p), sub(points[(i + 2) % 4], points[(i + 1) % 4])));
  const area = Math.abs(points.reduce((s, p, i) => s + cross(p, points[(i + 1) % 4]), 0)) / 2;
  return area > 100 && (turns.every(t => t > 0) || turns.every(t => t < 0));
}
export function graphToLayout(graph, { pixelsPerMeter, origin, wallHeight, wallThickness, layoutId, revision = 1 }) {
  if (!(pixelsPerMeter > 0) || !Number.isFinite(pixelsPerMeter)) throw new Error('縮尺が不正です。');
  const round = x => { const n = +x.toFixed(5); return Object.is(n, -0) ? 0 : n; };
  const layout = {
    schemaVersion: 1, layoutId, revision, units: 'm', wallHeight, wallThickness,
    walls: graphSegments(normalizeGraph(graph)).map(s => ({
      id: s.id,
      ax: round((s.a.x - origin.x) / pixelsPerMeter), ay: round((origin.y - s.a.y) / pixelsPerMeter),
      bx: round((s.b.x - origin.x) / pixelsPerMeter), by: round((origin.y - s.b.y) / pixelsPerMeter)
    }))
  };
  const errors = validateLayout(layout); if (errors.length) throw new Error(errors.join('\n'));
  return layout;
}
export function validateLayout(value, { requireRevision = true } = {}) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['JSONのルートはオブジェクトにしてください。'];
  if (value.schemaVersion !== 1) errors.push('schemaVersion は 1 が必要です。');
  if (value.units !== 'm') errors.push('units は m が必要です。');
  if (typeof value.layoutId !== 'string' || !value.layoutId.length || value.layoutId.length > 100) errors.push('layoutId は1〜100文字が必要です。');
  if (requireRevision && (!Number.isSafeInteger(value.revision) || value.revision < 1)) errors.push('revision は1以上の整数が必要です。');
  if (!Number.isFinite(value.wallHeight) || value.wallHeight < 0.1 || value.wallHeight > 20) errors.push('壁の高さは0.1〜20mにしてください。');
  if (!Number.isFinite(value.wallThickness) || value.wallThickness < 0.01 || value.wallThickness > 2) errors.push('壁の厚さは0.01〜2mにしてください。');
  if (!Array.isArray(value.walls) || value.walls.length > 1000) errors.push('walls は1000本以下の配列が必要です。');
  else {
    const ids = new Set();
    for (let i = 0; i < value.walls.length; i++) {
      const w = value.walls[i];
      if (!w || typeof w.id !== 'string' || !w.id.length || w.id.length > 100 || ids.has(w.id)) { errors.push(`壁${i + 1}: idが不正または重複しています。`); break; }
      ids.add(w.id);
      if (!['ax', 'ay', 'bx', 'by'].every(k => Number.isFinite(w[k]) && Math.abs(w[k]) <= 10000)) { errors.push(`壁${i + 1}: 座標は有限の数値（±10000m以内）が必要です。`); break; }
      if (Math.hypot(w.bx - w.ax, w.by - w.ay) < 0.001) { errors.push(`壁${i + 1}: 長さが1mm未満です。`); break; }
    }
  }
  return errors;
}
export function layoutToGraph(layout) {
  const errors = validateLayout(layout); if (errors.length) throw new Error(errors.join('\n'));
  const points = layout.walls.flatMap(w => [{ x: w.ax, y: w.ay }, { x: w.bx, y: w.by }]);
  const bounds = boundsOf(points), pixelsPerMeter = 1000 / Math.max(bounds.width, bounds.height, 1);
  const width = Math.round(bounds.width * pixelsPerMeter + 160), height = Math.round(bounds.height * pixelsPerMeter + 160);
  const origin = { x: 80 - bounds.minX * pixelsPerMeter, y: 80 + bounds.maxY * pixelsPerMeter };
  const map = (x, y) => ({ x: x * pixelsPerMeter + origin.x, y: origin.y - y * pixelsPerMeter });
  // Imported segment IDs remain valid even when the graph is normalized at crossings.
  const graph = segmentsToGraph(layout.walls.map(w => ({ a: map(w.ax, w.ay), b: map(w.bx, w.by) })), 0);
  return { graph, width: Math.max(width, 160), height: Math.max(height, 160), origin, pixelsPerMeter };
}
