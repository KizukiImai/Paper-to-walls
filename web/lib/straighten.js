/** Geometry-only straightening of traced strokes. No images or network calls. */
import { distance, simplifyPolyline, clamp } from './geometry.js';

export function straighteningTolerance(strength, width = 1200, height = 900) {
  const amount = clamp(Number.isFinite(strength) ? strength : 40, 0, 100) / 100;
  // 0 is pixel-noise cleanup, not an assertion that a pixel skeleton is a perfect line.
  return (0.65 + 31.35 * amount ** 1.65) * Math.max(width, height) / 1200;
}

/** Orthogonal least-squares line. Unlike endpoint-only RDP, all stroke pixels contribute. */
export function fitLine(points, axisAngle = 0) {
  const n = points.length;
  const center = points.reduce((p, q) => ({ x: p.x + q.x / n, y: p.y + q.y / n }), { x: 0, y: 0 });
  let xx = 0, xy = 0, yy = 0;
  for (const p of points) { const x = p.x - center.x, y = p.y - center.y; xx += x*x; xy += x*y; yy += y*y; }
  let angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const threshold = Math.sin(axisAngle * Math.PI / 180);
  if (axisAngle > 0 && Math.abs(Math.sin(angle)) <= threshold) angle = 0;
  else if (axisAngle > 0 && Math.abs(Math.cos(angle)) <= threshold) angle = Math.PI / 2;
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const project = p => { const t = (p.x-center.x)*dx + (p.y-center.y)*dy; return { x: center.x+t*dx, y: center.y+t*dy }; };
  return { a: project(points[0]), b: project(points[n-1]), center, nx: -dy, ny: dx };
}

/**
 * RDP preserves significant bends; TLS averages pen wobble within each section.
 * Endpoints with the same ORIGINAL coordinate share one solved junction. Never
 * join disconnected paths just because the straightening amount is high.
 */
export function straightenPaths(paths, { strength = 40, width = 1200, height = 900, axisSnap = true, axisAngle = 3 } = {}) {
  const tolerance = straighteningTolerance(strength, width, height), segments = [], joints = new Map();
  const addJoint = (original, segment, end) => {
    const key = `${original.x.toFixed(4)},${original.y.toFixed(4)}`;
    if (!joints.has(key)) joints.set(key, { original, members: [] });
    joints.get(key).members.push({ segment, end });
  };
  for (const path of paths) {
    if (path.length < 2) continue;
    let pieces = [path];
    if (path.length > 3 && distance(path[0], path[path.length-1]) < 2) {
      let far = 1;
      for (let i=2; i<path.length-1; i++) if (distance(path[0], path[i]) > distance(path[0], path[far])) far=i;
      pieces = [path.slice(0, far+1), path.slice(far)];
    }
    for (const piece of pieces) {
      const simplified = simplifyPolyline(piece, tolerance);
      let start = 0;
      for (let i=1; i<simplified.length; i++) {
        let end = start+1;
        while (end < piece.length-1 && piece[end] !== simplified[i]) end++;
        const support = piece.slice(start, end+1);
        if (distance(support[0], support[support.length-1]) >= 1) {
          const fitted = fitLine(support, axisSnap ? axisAngle : 0);
          const segment = { ...fitted };
          segments.push(segment);
          addJoint(support[0], segment, 'a'); addJoint(support[support.length-1], segment, 'b');
        }
        start = end;
      }
    }
  }
  for (const { original, members } of joints.values()) {
    if (members.length < 2) continue;
    let aa=0, ab=0, bb=0, ra=0, rb=0;
    for (const {segment:s} of members) {
      const k=s.nx*s.center.x+s.ny*s.center.y;
      aa+=s.nx*s.nx; ab+=s.nx*s.ny; bb+=s.ny*s.ny; ra+=s.nx*k; rb+=s.ny*k;
    }
    const determinant=aa*bb-ab*ab;
    let p;
    if (determinant > 0.02) p = { x:(ra*bb-rb*ab)/determinant, y:(rb*aa-ra*ab)/determinant };
    else p = members.reduce((out, {segment:s,end}) => ({x:out.x+s[end].x/members.length, y:out.y+s[end].y/members.length}), {x:0,y:0});
    // Avoid unstable intersections of almost parallel fitted lines. Preserve topology.
    if (distance(p, original) > Math.max(3, tolerance*2.5)) p={...original};
    for (const {segment,end} of members) segment[end]={...p};
  }
  return segments.filter(s=>distance(s.a,s.b)>=1).map(s=>({a:s.a,b:s.b}));
}
