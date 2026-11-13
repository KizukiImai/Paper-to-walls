import { straightenPaths } from './straighten.js';
import { distance, simplifyPolyline, mergeSegments, segmentsToGraph, validQuad, clamp, normalizeGraph } from './geometry.js';

export const DEFAULT_CONFIG = Object.freeze({ longSide: 1200, threshold: 12, windowSize: 51, minArea: 18, minLength: 16, simplify: 4, straightness: 40, axisAngle: 3, gap: 0, snap: 5, axisSnap: true });

/** Solve a small dense linear system with partial pivoting. */
export function solveLinear(matrix, rhs) {
  const n = rhs.length, a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let i = 0; i < n; i++) {
    let pivot = i; for (let j = i + 1; j < n; j++) if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
    if (Math.abs(a[pivot][i]) < 1e-10) throw new Error('四隅から補正を計算できません。四隅を広げて指定してください。');
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const div = a[i][i]; for (let k = i; k <= n; k++) a[i][k] /= div;
    for (let j = 0; j < n; j++) if (j !== i) { const factor = a[j][i]; for (let k = i; k <= n; k++) a[j][k] -= factor * a[i][k]; }
  }
  return a.map(r => r[n]);
}
export function homography(from, to) {
  const rows = [], rhs = [];
  from.forEach((p, i) => {
    const q = to[i];
    rows.push([p.x, p.y, 1, 0, 0, 0, -q.x * p.x, -q.x * p.y]); rhs.push(q.x);
    rows.push([0, 0, 0, p.x, p.y, 1, -q.y * p.x, -q.y * p.y]); rhs.push(q.y);
  });
  return [...solveLinear(rows, rhs), 1];
}
export function warpImage(image, corners, aspect = 0, longSide = 1200) {
  if (!validQuad(corners)) throw new Error('用紙の四隅が交差しているか、範囲が小さすぎます。左上から順に指定してください。');
  const top = distance(corners[0], corners[1]), bottom = distance(corners[3], corners[2]);
  const left = distance(corners[0], corners[3]), right = distance(corners[1], corners[2]);
  const ratio = aspect > 0 ? aspect : (top + bottom) / (left + right);
  if (ratio < 0.1 || ratio > 10) throw new Error('用紙の縦横比を確認してください。');
  const width = Math.round(ratio >= 1 ? longSide : longSide * ratio), height = Math.round(ratio >= 1 ? longSide / ratio : longSide);
  const dest = [{ x: 0, y: 0 }, { x: width - 1, y: 0 }, { x: width - 1, y: height - 1 }, { x: 0, y: height - 1 }];
  const h = homography(dest, corners), out = new Uint8ClampedArray(width * height * 4), src = image.data;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const den = h[6] * x + h[7] * y + 1, sx = (h[0] * x + h[1] * y + h[2]) / den, sy = (h[3] * x + h[4] * y + h[5]) / den;
    const k = (y * width + x) * 4; out[k + 3] = 255;
    if (sx < -0.01 || sy < -0.01 || sx > image.width - 0.99 || sy > image.height - 0.99) { out[k] = out[k + 1] = out[k + 2] = 255; continue; }
    const cx = clamp(sx, 0, image.width - 1), cy = clamp(sy, 0, image.height - 1), ix = Math.floor(cx), iy = Math.floor(cy), dx = cx - ix, dy = cy - iy;
    const ix1 = Math.min(ix + 1, image.width - 1), iy1 = Math.min(iy + 1, image.height - 1);
    for (let c = 0; c < 3; c++) out[k + c] = (1 - dy) * ((1 - dx) * src[(iy * image.width + ix) * 4 + c] + dx * src[(iy * image.width + ix1) * 4 + c]) + dy * ((1 - dx) * src[(iy1 * image.width + ix) * 4 + c] + dx * src[(iy1 * image.width + ix1) * 4 + c]);
  }
  return { width, height, data: out };
}
export function grayscale(image) {
  const out = new Uint8Array(image.width * image.height);
  for (let i = 0; i < out.length; i++) { const k = i * 4; out[i] = (image.data[k] * 77 + image.data[k + 1] * 150 + image.data[k + 2] * 29) >> 8; }
  return out;
}
export function adaptiveThreshold(gray, width, height, windowSize = 51, offset = 12) {
  const stride = width + 1, integral = new Float64Array(stride * (height + 1)), output = new Uint8Array(width * height);
  for (let y = 1; y <= height; y++) { let sum = 0; for (let x = 1; x <= width; x++) { sum += gray[(y - 1) * width + x - 1]; integral[y * stride + x] = integral[(y - 1) * stride + x] + sum; } }
  const radius = Math.floor(windowSize / 2);
  for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
    const x0 = Math.max(0, x - radius), x1 = Math.min(width, x + radius + 1), y0 = Math.max(0, y - radius), y1 = Math.min(height, y + radius + 1);
    const mean = (integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0]) / ((x1 - x0) * (y1 - y0));
    output[y * width + x] = gray[y * width + x] < Math.min(225, mean - offset) ? 1 : 0;
  }
  return output;
}
export function removeSmallComponents(binary, width, height, minArea = 18) {
  const result = binary.slice(), seen = new Uint8Array(result.length), queue = new Int32Array(result.length);
  const offsets = [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1];
  for (let p = 0; p < result.length; p++) if (result[p] && !seen[p]) {
    let head = 0, tail = 1; queue[0] = p; seen[p] = 1;
    while (head < tail) {
      const q = queue[head++], x = q % width;
      for (const off of offsets) { const n = q + off; if (n < 0 || n >= result.length || Math.abs(n % width - x) > 1 || seen[n] || !result[n]) continue; seen[n] = 1; queue[tail++] = n; }
    }
    if (tail < minArea) for (let i = 0; i < tail; i++) result[queue[i]] = 0;
  }
  return result;
}
/** Zhang–Suen parallel thinning, with correct two-subiteration deletion rules. */
export function thin(binary, width, height, maxIterations = 150) {
  const data = binary.slice(), remove = new Int32Array(data.length);
  let iteration = 0, changed = true;
  while (changed && iteration++ < maxIterations) {
    changed = false;
    for (let phase = 0; phase < 2; phase++) {
      let count = 0;
      for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
        const p = y * width + x; if (!data[p]) continue;
        const p2 = data[p - width], p3 = data[p - width + 1], p4 = data[p + 1], p5 = data[p + width + 1], p6 = data[p + width], p7 = data[p + width - 1], p8 = data[p - 1], p9 = data[p - width - 1];
        const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9; if (b < 2 || b > 6) continue;
        const a = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
        if (a !== 1) continue;
        if (phase === 0 ? (p2 * p4 * p6 || p4 * p6 * p8) : (p2 * p4 * p8 || p2 * p6 * p8)) continue;
        remove[count++] = p;
      }
      if (count) changed = true;
      for (let i = 0; i < count; i++) data[remove[i]] = 0;
    }
  }
  if (changed) throw new Error('線が太すぎて中心線の計算が収束しませんでした。細いペンか小さい処理解像度で試してください。');
  return data;
}

/** Trace the skeleton itself, rather than detecting both borders of each pen stroke. */
export function traceSkeleton(data, width, height) {
  const active = []; for (let i = 0; i < data.length; i++) if (data[i]) active.push(i);
  if (active.length > 120000) throw new Error('抽出された線が多すぎます。影・背景・文字を除いて再認識してください。');
  const adjacency = new Map();
  for (const p of active) {
    const x = p % width, y = (p / width) | 0, ns = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!(dx || dy) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
      const n = p + dy * width + dx; if (!data[n]) continue;
      // Suppress diagonal shortcuts around a 90° corner (otherwise a false branch appears).
      if (dx && dy && (data[p + dx] || data[p + dy * width])) continue;
      ns.push(n);
    }
    adjacency.set(p, ns);
  }
  const special = new Set(active.filter(p => adjacency.get(p).length !== 2));
  const nodeOf = new Map(), centers = [], clusters = [];
  for (const p of special) if (!nodeOf.has(p)) {
    const id = centers.length, stack = [p], cluster = []; nodeOf.set(p, id);
    while (stack.length) {
      const q = stack.pop(); cluster.push(q);
      for (const n of adjacency.get(q)) if (special.has(n) && !nodeOf.has(n)) { nodeOf.set(n, id); stack.push(n); }
    }
    centers.push({ x: cluster.reduce((s, q) => s + q % width, 0) / cluster.length, y: cluster.reduce((s, q) => s + ((q / width) | 0), 0) / cluster.length });
    clusters.push(cluster);
  }
  const visited = new Set(), paths = [];
  const key = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;
  const point = p => ({ x: p % width, y: (p / width) | 0 });
  for (let id = 0; id < clusters.length; id++) for (const p of clusters[id]) for (const n of adjacency.get(p)) {
    if (nodeOf.get(n) === id || visited.has(key(p, n))) continue;
    const path = [centers[id]]; let prev = p, current = n; visited.add(key(p, n));
    for (let guard = 0; guard <= active.length; guard++) {
      if (nodeOf.has(current)) { path.push(centers[nodeOf.get(current)]); break; }
      path.push(point(current));
      const next = adjacency.get(current).find(q => q !== prev);
      if (next === undefined || visited.has(key(current, next))) break;
      visited.add(key(current, next)); prev = current; current = next;
    }
    if (path.length >= 2) paths.push(path);
  }
  // Closed loops have no endpoints; visit them separately so rectangles never vanish.
  for (const p of active) for (const n of adjacency.get(p)) {
    if (visited.has(key(p, n)) || nodeOf.has(p)) continue;
    const path = [point(p)]; let prev = p, current = n; visited.add(key(p, n));
    for (let guard = 0; guard <= active.length; guard++) {
      path.push(point(current)); if (current === p) break;
      const next = adjacency.get(current).find(q => q !== prev);
      if (next === undefined || visited.has(key(current, next))) break;
      visited.add(key(current, next)); prev = current; current = next;
    }
    if (path.length > 2) paths.push(path);
  }
  return paths;
}
export function pathsToSegments(paths, tolerance = 2.5) {
  const segments = [];
  for (const path of paths) {
    let pieces = [path];
    if (path.length > 3 && distance(path[0], path[path.length - 1]) < 2) {
      let far = 1; for (let i = 2; i < path.length - 1; i++) if (distance(path[0], path[i]) > distance(path[0], path[far])) far = i;
      pieces = [path.slice(0, far + 1), path.slice(far)];
    }
    for (const piece of pieces) {
      const simplified = simplifyPolyline(piece, tolerance);
      for (let i = 1; i < simplified.length; i++) if (distance(simplified[i - 1], simplified[i]) >= 1) segments.push({ a: simplified[i - 1], b: simplified[i] });
    }
  }
  return segments;
}
export function recognize(image, config = {}, progress = () => {}) {
  const c = { ...DEFAULT_CONFIG, ...config }, { width, height } = image;
  progress('線と背景を分離しています', 25);
  const gray = grayscale(image), binary = removeSmallComponents(adaptiveThreshold(gray, width, height, c.windowSize, c.threshold), width, height, c.minArea);
  let ink = 0; for (const v of binary) ink += v;
  if (ink / binary.length > 0.35) throw new Error('黒い領域が多すぎます。用紙の四隅と二値化の設定を確認してください。');
  progress('ペンの中心線を抽出しています', 50);
  const skeleton = thin(binary, width, height);
  progress('直線と交点を整理しています', 75);
  const paths = traceSkeleton(skeleton, width, height);
  const { graph } = vectorizePaths(paths, width, height, c);
  progress('認識が完了しました', 100);
  return { graph, paths, binary, skeleton, stats: { inkRatio: ink / binary.length, pathCount: paths.length, wallCount: graph.walls.length } };
}

/** Reuse immutable traced paths when the UI changes correction strength. */
export function vectorizePaths(paths, width, height, config = {}) {
  const c = { ...DEFAULT_CONFIG, ...config };
  let segments = straightenPaths(paths, {strength:c.straightness, width, height, axisSnap:c.axisSnap, axisAngle:c.axisAngle});
  if (segments.length > 1800) throw new Error('線が複雑すぎます。直線化を強めるか、文字や背景を除いてください。');
  // Gap/parallel merge thresholds do NOT grow with the straightening slider.
  segments = mergeSegments(segments, { axisSnap:c.axisSnap, axisAngleDeg:c.axisAngle, gap:c.gap, perpendicular:2.5 });
  segments = segments.filter(s => distance(s.a, s.b) >= c.minLength);
  const graph = segmentsToGraph(segments, c.snap);
  // Least-squares fitting can extend endpoint coordinates just outside the paper.
  for (const n of graph.nodes) { n.x=clamp(n.x,0,width-1); n.y=clamp(n.y,0,height-1); }
  if (graph.walls.length > 1000) throw new Error('壁が1000本を超えました。画像の範囲と検出設定を見直してください。');
  return { graph:normalizeGraph(graph) };
}

/** Conservative paper candidate. Not a semantic paper detector: user always confirms corners. */
export function estimatePaper(image) {
  const w = image.width, h = image.height, stride = Math.max(1, Math.ceil(Math.max(w, h) / 360));
  const sw = Math.ceil(w / stride), sh = Math.ceil(h / stride), binary = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const i = (Math.min(h - 1, y * stride) * w + Math.min(w - 1, x * stride)) * 4; binary[y * sw + x] = Math.min(image.data[i], image.data[i + 1], image.data[i + 2]) > 170 ? 1 : 0; }
  const seen = new Uint8Array(binary.length); let largest = [];
  for (let p = 0; p < binary.length; p++) if (binary[p] && !seen[p]) {
    const queue = [p]; seen[p] = 1;
    for (let i = 0; i < queue.length; i++) for (const n of [queue[i] - 1, queue[i] + 1, queue[i] - sw, queue[i] + sw]) {
      if (n < 0 || n >= binary.length || Math.abs(n % sw - queue[i] % sw) > 1 || !binary[n] || seen[n]) continue;
      seen[n] = 1; queue.push(n);
    }
    if (queue.length > largest.length) largest = queue;
  }
  const full = [{ x: 0, y: 0 }, { x: w - 1, y: 0 }, { x: w - 1, y: h - 1 }, { x: 0, y: h - 1 }];
  if (largest.length < binary.length * 0.15 || largest.length > binary.length * 0.90) return { corners: full, confidence: 'full' };
  const points = largest.map(p => ({ x: Math.min(w - 1, (p % sw) * stride), y: Math.min(h - 1, ((p / sw) | 0) * stride) }));
  const extremum = (fn, maximum) => points.reduce((best, p) => (maximum ? fn(p) > fn(best) : fn(p) < fn(best)) ? p : best);
  const corners = [extremum(p => p.x + p.y, false), extremum(p => p.x - p.y, true), extremum(p => p.x + p.y, true), extremum(p => p.x - p.y, false)];
  return { corners: validQuad(corners) ? corners : full, confidence: validQuad(corners) ? 'candidate' : 'full' };
}
