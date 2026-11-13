/** Small dependency-free WebGL renderer. Data dimensions match the Unity JSON exactly.
 * Three-dimensional display uses (JSON x, height, -JSON y), reflecting handedness only.
 */
const normalize = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
const subtract = (a, b) => a.map((v, i) => v - b[i]);
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
function multiply(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
  return out;
}
function perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
function lookAt(eye, target) {
  const z = normalize(subtract(eye, target)), x = normalize(cross3([0, 1, 0], z)), y = cross3(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1]);
}
export class WallPreview {
  constructor(canvas, onError = () => {}) {
    this.canvas = canvas; this.onError = onError; this.pointers = new Map(); this.angle = 0.65; this.elevation = 0.85; this.distance = 12; this.target = [0, 0, 0];
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) return new SoftwareWallPreview(canvas, onError);
    canvas.dataset.renderer = 'webgl';
    this.gl = gl;
    const vertex = `attribute vec3 aPosition; attribute vec3 aNormal; attribute vec3 aColor; uniform mat4 uMatrix; uniform float uGrow; varying vec3 vColor; varying vec3 vNormal; void main(){ vec3 p=aPosition; p.y*=uGrow; gl_Position=uMatrix*vec4(p,1.0); vNormal=aNormal; vColor=aColor; }`;
    const fragment = `precision mediump float; varying vec3 vColor; varying vec3 vNormal; uniform float uLit; void main(){ float light=0.67+0.33*max(dot(normalize(vNormal),normalize(vec3(-0.5,1.0,0.7))),0.0); gl_FragColor=vec4(vColor*mix(1.0,light,uLit),1.0); }`;
    const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    try {
      const vs = shader(gl.VERTEX_SHADER, vertex), fs = shader(gl.FRAGMENT_SHADER, fragment), program = gl.createProgram();
      gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      gl.deleteShader(vs); gl.deleteShader(fs); this.program = program;
      this.position = gl.getAttribLocation(program, 'aPosition'); this.normal = gl.getAttribLocation(program, 'aNormal'); this.color = gl.getAttribLocation(program, 'aColor');
      this.matrix = gl.getUniformLocation(program, 'uMatrix'); this.grow = gl.getUniformLocation(program, 'uGrow'); this.lit = gl.getUniformLocation(program, 'uLit');
      this.triangles = gl.createBuffer(); this.lines = gl.createBuffer(); this.triangleCount = 0; this.lineCount = 0; this.progress = 1;
    } catch (error) { this.failed = true; onError(`3D表示の初期化に失敗しました: ${error.message}`); return; }
    this.observer = new ResizeObserver(() => this.render()); this.observer.observe(canvas.parentElement);
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); this.panning = e.button === 2 || e.shiftKey; });
    canvas.addEventListener('pointermove', e => {
      if (!this.pointers.has(e.pointerId)) return;
      const old = this.pointers.get(e.pointerId), dx = e.clientX - old.x, dy = e.clientY - old.y;
      if (this.pointers.size === 2) {
        const other = [...this.pointers.entries()].find(([id]) => id !== e.pointerId)[1];
        const before = Math.hypot(old.x - other.x, old.y - other.y), after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        this.distance *= before / Math.max(after, 1); this.pan(dx / 2, dy / 2);
      } else if (this.panning) this.pan(dx, dy);
      else { this.angle -= dx * 0.007; this.elevation = Math.max(0.08, Math.min(1.565, this.elevation + dy * 0.007)); }
      this.distance = Math.max(this.span * 0.25, Math.min(this.span * 30, this.distance));
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); this.render();
    });
    const release = e => this.pointers.delete(e.pointerId);
    canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('wheel', e => { e.preventDefault(); this.distance *= Math.exp(e.deltaY * 0.001); this.distance = Math.max(this.span * 0.25, Math.min(this.span * 30, this.distance)); this.render(); }, { passive: false });
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); onError('3D描画が中断しました。ページを開き直す前にJSONを保存してください。'); });
  }
  pan(dx, dy) {
    const factor = this.distance / Math.max(200, this.canvas.clientHeight);
    this.target[0] -= (Math.cos(this.angle) * dx + Math.sin(this.angle) * dy) * factor;
    this.target[2] += (Math.sin(this.angle) * dx - Math.cos(this.angle) * dy) * factor;
  }
  update(layout, { fit = false, animate = false } = {}) {
    if (this.failed) return; const oldCenter = this.center?.slice(), oldSpan = this.span; this.layout = layout;
    const triangles = [], lines = [];
    const vertex = (list, p, n, color) => list.push(...p, ...n, ...color);
    const face = (points, color) => {
      const normal = normalize(cross3(subtract(points[1], points[0]), subtract(points[2], points[0])));
      for (const i of [0, 1, 2, 0, 2, 3]) vertex(triangles, points[i], normal, color);
    };
    const line = (a, b, color = [0.38, 0.51, 0.49]) => { vertex(lines, a, [0, 1, 0], color); vertex(lines, b, [0, 1, 0], color); };
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const w of layout.walls) {
      const a = [w.ax, 0, -w.ay], b = [w.bx, 0, -w.by], dx = b[0] - a[0], dz = b[2] - a[2], length = Math.hypot(dx, dz);
      if (!length) continue; const nx = -dz / length * layout.wallThickness / 2, nz = dx / length * layout.wallThickness / 2, h = layout.wallHeight;
      const p = [[a[0] + nx, 0, a[2] + nz], [b[0] + nx, 0, b[2] + nz], [b[0] - nx, 0, b[2] - nz], [a[0] - nx, 0, a[2] - nz]];
      const q = p.map(v => [v[0], h, v[2]]);
      face([q[0], q[1], q[2], q[3]], [0.73, 0.85, 0.81]);
      for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; face([p[i], p[j], q[j], q[i]], [0.89, 0.91, 0.86]); line(q[i], q[j]); line(p[i], q[i]); }
      for (const v of p) { minX = Math.min(minX, v[0]); maxX = Math.max(maxX, v[0]); minZ = Math.min(minZ, v[2]); maxZ = Math.max(maxZ, v[2]); }
    }
    if (!Number.isFinite(minX)) { minX = minZ = -2.5; maxX = maxZ = 2.5; }
    this.span = Math.max(maxX - minX, maxZ - minZ, layout.wallHeight, 1);
    const margin = this.span * 0.14, floorY = -0.012;
    face([[minX - margin, floorY, maxZ + margin], [maxX + margin, floorY, maxZ + margin], [maxX + margin, floorY, minZ - margin], [minX - margin, floorY, minZ - margin]], [0.93, 0.94, 0.91]);
    const step = 10 ** Math.round(Math.log10(this.span / 5));
    for (let x = Math.floor((minX - margin) / step) * step; x <= maxX + margin; x += step) line([x, 0, minZ - margin], [x, 0, maxZ + margin], [0.82, 0.85, 0.81]);
    for (let z = Math.floor((minZ - margin) / step) * step; z <= maxZ + margin; z += step) line([minX - margin, 0, z], [maxX + margin, 0, z], [0.82, 0.85, 0.81]);
    this.center = [(minX + maxX) / 2, layout.wallHeight * 0.3, (minZ + maxZ) / 2];
    const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.triangles); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(triangles), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lines); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lines), gl.STATIC_DRAW);
    this.triangleCount = triangles.length / 9; this.lineCount = lines.length / 9;
    if (!fit && this.hasFit && oldCenter) { this.target = this.target.map((v, i) => v + this.center[i] - oldCenter[i]); this.distance *= this.span / oldSpan; }
    if (fit || !this.hasFit) { this.fit(); this.hasFit = true; }
    if (animate) this.animate(); else { this.progress = 1; this.render(); }
  }
  fit() {
    if (this.failed) return;
    this.target = this.center?.slice() || [0, 0, 0]; this.distance = (this.span || 5) * 2.25; this.angle = 0.65; this.elevation = 0.85; this.render();
  }
  top() { this.angle = 0; this.elevation = 1.565; this.render(); }
  animate() {
    cancelAnimationFrame(this.animation); const start = performance.now();
    const tick = now => { const t = Math.min(1, (now - start) / 850); this.progress = 1 - (1 - t) ** 3; this.render(); if (t < 1) this.animation = requestAnimationFrame(tick); };
    this.animation = requestAnimationFrame(tick);
  }
  render() {
    if (this.failed || !this.gl) return;
    const gl = this.gl, dpr = Math.min(window.devicePixelRatio || 1, 2), rect = this.canvas.parentElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const width = Math.round(rect.width * dpr), height = Math.round(rect.height * dpr);
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    gl.viewport(0, 0, width, height); gl.clearColor(0.945, 0.949, 0.933, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST);
    gl.useProgram(this.program);
    const viewDistance = this.distance * Math.max(1, height / width);
    const r = viewDistance * Math.cos(this.elevation), eye = [this.target[0] + r * Math.sin(this.angle), this.target[1] + viewDistance * Math.sin(this.elevation), this.target[2] + r * Math.cos(this.angle)];
    const matrix = multiply(perspective(Math.PI / 4.5, width / height, Math.max(0.005, (this.span || 5) / 1000), (this.span || 5) * 200), lookAt(eye, this.target));
    gl.uniformMatrix4fv(this.matrix, false, matrix); gl.uniform1f(this.grow, Math.max(0.001, this.progress));
    const bind = buffer => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      for (const [loc, offset] of [[this.position, 0], [this.normal, 12], [this.color, 24]]) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 36, offset); }
    };
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1); bind(this.triangles); gl.uniform1f(this.lit, 1); gl.drawArrays(gl.TRIANGLES, 0, this.triangleCount);
    gl.disable(gl.POLYGON_OFFSET_FILL); bind(this.lines); gl.uniform1f(this.lit, 0); gl.drawArrays(gl.LINES, 0, this.lineCount);
  }
}

/** Software fallback for GPU-disabled browsers. Coordinates and camera remain 3D;
 * painter sorting is approximate for intersecting faces. JSON is never approximated. */
class SoftwareWallPreview {
  constructor(canvas, onError) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.onError = onError;
    if (!this.ctx) { this.failed = true; onError('プレビューを初期化できません。JSON出力は利用できます。'); return; }
    canvas.dataset.renderer = 'software'; this.pointers = new Map(); this.angle = 0.65; this.elevation = 0.85; this.distance = 12; this.target = [0, 0, 0]; this.span = 5; this.progress = 1; this.faces = [];
    this.observer = new ResizeObserver(() => this.render()); this.observer.observe(canvas.parentElement);
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); this.panning = e.button === 2 || e.shiftKey; });
    canvas.addEventListener('pointermove', e => {
      if (!this.pointers.has(e.pointerId)) return;
      const old = this.pointers.get(e.pointerId), dx = e.clientX - old.x, dy = e.clientY - old.y;
      if (this.pointers.size === 2) {
        const other = [...this.pointers.entries()].find(([id]) => id !== e.pointerId)[1];
        this.distance *= Math.hypot(old.x - other.x, old.y - other.y) / Math.max(1, Math.hypot(e.clientX - other.x, e.clientY - other.y)); this.pan(dx / 2, dy / 2);
      } else if (this.panning) this.pan(dx, dy);
      else { this.angle -= dx * 0.007; this.elevation = Math.max(0.08, Math.min(1.565, this.elevation + dy * 0.007)); }
      this.distance = Math.max(this.span * 0.6, Math.min(this.span * 30, this.distance));
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); this.render();
    });
    const release = e => this.pointers.delete(e.pointerId);
    canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('wheel', e => { e.preventDefault(); this.distance = Math.max(this.span * 0.6, Math.min(this.span * 30, this.distance * Math.exp(e.deltaY * 0.001))); this.render(); }, { passive: false });
  }
  pan(dx, dy) {
    const f = this.distance / Math.max(200, this.canvas.clientHeight);
    this.target[0] -= (Math.cos(this.angle) * dx + Math.sin(this.angle) * dy) * f;
    this.target[2] += (Math.sin(this.angle) * dx - Math.cos(this.angle) * dy) * f;
  }
  update(layout, { fit = false, animate = false } = {}) {
    if (this.failed) return;
    const oldCenter = this.center?.slice(), oldSpan = this.span; this.layout = layout; this.faces = [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const face = (p, color) => {
      const n = normalize(cross3(subtract(p[1], p[0]), subtract(p[2], p[0]))), light = 0.67 + 0.33 * Math.max(0, dot3(n, normalize([-0.5, 1, 0.7])));
      this.faces.push({ points: p, color: `rgb(${color.map(c => Math.round(c * light)).join(',')})` });
    };
    for (const w of layout.walls) {
      const dx = w.bx - w.ax, dz = -w.by + w.ay, length = Math.hypot(dx, dz); if (!length) continue;
      const nx = -dz / length * layout.wallThickness / 2, nz = dx / length * layout.wallThickness / 2;
      const p = [[w.ax + nx, 0, -w.ay + nz], [w.bx + nx, 0, -w.by + nz], [w.bx - nx, 0, -w.by - nz], [w.ax - nx, 0, -w.ay - nz]];
      const q = p.map(v => [v[0], layout.wallHeight, v[2]]);
      face(q, [186, 217, 207]);
      for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; face([p[i], p[j], q[j], q[i]], [227, 232, 220]); }
      for (const v of p) { minX = Math.min(minX, v[0]); maxX = Math.max(maxX, v[0]); minZ = Math.min(minZ, v[2]); maxZ = Math.max(maxZ, v[2]); }
    }
    if (!Number.isFinite(minX)) { minX = minZ = -2.5; maxX = maxZ = 2.5; }
    this.span = Math.max(maxX - minX, maxZ - minZ, layout.wallHeight, 1);
    this.center = [(minX + maxX) / 2, layout.wallHeight * 0.35, (minZ + maxZ) / 2];
    const margin = this.span * 0.14;
    this.floor = [[minX - margin, 0, maxZ + margin], [maxX + margin, 0, maxZ + margin], [maxX + margin, 0, minZ - margin], [minX - margin, 0, minZ - margin]];
    this.grid = []; const step = 10 ** Math.round(Math.log10(this.span / 5));
    for (let x = Math.floor((minX - margin) / step) * step; x <= maxX + margin; x += step) this.grid.push([[x, 0, minZ - margin], [x, 0, maxZ + margin]]);
    for (let z = Math.floor((minZ - margin) / step) * step; z <= maxZ + margin; z += step) this.grid.push([[minX - margin, 0, z], [maxX + margin, 0, z]]);
    if (!fit && this.hasFit && oldCenter) { this.target = this.target.map((v, i) => v + this.center[i] - oldCenter[i]); this.distance *= this.span / oldSpan; }
    if (fit || !this.hasFit) { this.fit(); this.hasFit = true; }
    if (animate) this.animate(); else { this.progress = 1; this.render(); }
  }
  fit() { this.target = this.center?.slice() || [0, 0, 0]; this.distance = this.span * 2.25; this.angle = 0.65; this.elevation = 0.85; this.render(); }
  top() { this.angle = 0; this.elevation = 1.565; this.render(); }
  animate() {
    cancelAnimationFrame(this.animation); const start = performance.now();
    const tick = now => { const t = Math.min(1, (now - start) / 850); this.progress = 1 - (1 - t) ** 3; this.render(); if (t < 1) this.animation = requestAnimationFrame(tick); }; this.animation = requestAnimationFrame(tick);
  }
  render() {
    if (this.failed || !this.ctx) return;
    const rect = this.canvas.parentElement.getBoundingClientRect(), width = rect.width, height = rect.height, dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (!width || !height) return;
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) { this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr); }
    const ctx = this.ctx; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#f1f2ee'; ctx.fillRect(0, 0, width, height);
    if (!this.floor) return;
    const viewDistance = this.distance * Math.max(1, height / width);
    const r = viewDistance * Math.cos(this.elevation), eye = [this.target[0] + r * Math.sin(this.angle), this.target[1] + viewDistance * Math.sin(this.elevation), this.target[2] + r * Math.cos(this.angle)];
    const m = multiply(perspective(Math.PI / 4.5, width / height, Math.max(0.005, this.span / 1000), this.span * 200), lookAt(eye, this.target));
    const project = p => {
      const x = p[0], y = p[1] * Math.max(0.001, this.progress), z = p[2];
      const w = m[3] * x + m[7] * y + m[11] * z + m[15]; if (w < 0.01) return null;
      return { x: ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) * width / 2, y: (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * height / 2, z: (m[2] * x + m[6] * y + m[10] * z + m[14]) / w };
    };
    const polygon = (points, fill, stroke) => {
      if (points.some(p => !p)) return;
      ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill(); if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 0.65; ctx.stroke(); }
    };
    polygon(this.floor.map(project), '#e8ece3', '#cdd6c8');
    ctx.strokeStyle = '#d2dacb'; ctx.lineWidth = 0.6;
    for (const pair of this.grid) { const [a, b] = pair.map(project); if (!a || !b) continue; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    const faces = this.faces.map(f => ({ ...f, points: f.points.map(project) })).filter(f => f.points.every(Boolean));
    faces.sort((a, b) => b.points.reduce((sum, p) => sum + p.z, 0) - a.points.reduce((sum, p) => sum + p.z, 0));
    for (const f of faces) polygon(f.points, f.color, '#729286');
    ctx.font = '9px monospace'; ctx.fillStyle = '#9aa58d'; ctx.textAlign = 'left'; ctx.fillText('SOFTWARE 3D', 17, 23);
  }
}
