import { clamp, distance, projectPoint, graphSegments, segmentsToGraph, normalizeGraph } from './geometry.js';

export class PlanEditor {
  constructor(canvas, getState, actions) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.getState = getState; this.actions = actions;
    this.zoom = 1; this.tx = 0; this.ty = 0; this.pointers = new Map(); this.pending = null; this.cursor = null;
    this.observer = new ResizeObserver(() => { this.resize(); }); this.observer.observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', e => this.down(e)); canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', e => this.up(e)); canvas.addEventListener('pointercancel', e => this.up(e));
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('wheel', e => {
      e.preventDefault(); const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      this.zoomAt(Math.exp(-e.deltaY * 0.001), x, y);
    }, { passive: false });
    canvas.addEventListener('keydown', e => {
      if (e.key === 'Escape') { this.pending = null; this.actions.select(null); this.draw(); }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.actions.deleteSelected(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.actions.redo() : this.actions.undo(); }
    });
    this.resize();
  }
  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect(); this.width = Math.max(r.width, 1); this.height = Math.max(r.height, 1);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * dpr); this.canvas.height = Math.round(this.height * dpr); this.dpr = dpr;
    if (!this.fitted) this.fit(); else this.draw();
  }
  fit() {
    const s = this.getState(); if (!s.width || !s.height) { this.draw(); return; }
    this.zoom = Math.max(0.03, Math.min((this.width - 72) / s.width, (this.height - 72) / s.height));
    this.tx = (this.width - s.width * this.zoom) / 2; this.ty = (this.height - s.height * this.zoom) / 2;
    this.fitted = true; this.draw();
  }
  zoomAt(factor, x = this.width / 2, y = this.height / 2) {
    const old = this.zoom; this.zoom = clamp(old * factor, 0.03, 15);
    this.tx = x - (x - this.tx) * this.zoom / old; this.ty = y - (y - this.ty) * this.zoom / old; this.draw();
  }
  screen(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  world(p) { return { x: (p.x - this.tx) / this.zoom, y: (p.y - this.ty) / this.zoom }; }
  pointInside(p) { const s = this.getState(); return { x: clamp(p.x, 0, s.width - 1), y: clamp(p.y, 0, s.height - 1) }; }
  snap(p) {
    const s = this.getState(), point = this.pointInside(p); if (!s.snapEnabled) return point;
    const threshold = 11 / this.zoom;
    const node = s.graph.nodes.find(n => distance(n, point) < threshold); if (node) return { x: node.x, y: node.y };
    let nearest = null;
    for (const edge of graphSegments(s.graph)) { const projection = projectPoint(point, edge.a, edge.b); if (projection.distance < threshold && (!nearest || projection.distance < nearest.distance)) nearest = projection; }
    if (nearest) return nearest.point;
    if (this.pending) {
      const dx = point.x - this.pending.x, dy = point.y - this.pending.y;
      if (Math.abs(dy) < Math.abs(dx) * 0.0524) point.y = this.pending.y;
      else if (Math.abs(dx) < Math.abs(dy) * 0.0524) point.x = this.pending.x;
    }
    return point;
  }
  down(e) {
    const s = this.getState(); if (!s.width || s.disabled) return;
    this.canvas.focus({ preventScroll: true }); this.canvas.setPointerCapture(e.pointerId);
    const screen = this.screen(e); this.pointers.set(e.pointerId, screen);
    if (this.pointers.size === 2) {
      if (this.drag?.type === 'node' || this.drag?.type === 'edge') this.actions.edit(this.drag.before, false);
      this.drag = null;
      const [a, b] = [...this.pointers.values()]; this.pinch = { distance: distance(a, b), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }; return;
    }
    const p = this.world(screen);
    if (e.button === 1 || e.button === 2 || s.tool === 'pan') { this.drag = { type: 'pan', start: screen, tx: this.tx, ty: this.ty }; return; }
    if (s.mode === 'crop') {
      const i = s.corners.findIndex(c => distance(c, p) < 20 / this.zoom);
      if (i !== -1) this.drag = { type: 'corner', index: i };
      return;
    }
    if (s.tool === 'add') {
      const point = this.snap(p);
      if (!this.pending) this.pending = point;
      else if (distance(this.pending, point) >= 2) {
        const segments = graphSegments(s.graph); segments.push({ a: this.pending, b: point });
        this.actions.edit(segmentsToGraph(segments, s.snapEnabled ? 3 : 0), true); this.pending = null;
      }
      this.draw(); return;
    }
    const node = s.graph.nodes.find(n => distance(n, p) < 12 / this.zoom);
    if (node && s.tool !== 'delete') { this.drag = { type: 'node', nodeId: node.id, start: p, before: structuredClone(s.graph) }; return; }
    let selected = null, best = 10 / this.zoom;
    for (const seg of graphSegments(s.graph)) { const d = projectPoint(p, seg.a, seg.b).distance; if (d < best) { selected = seg; best = d; } }
    this.actions.select(selected?.id ?? null);
    if (selected && s.tool === 'delete') { this.actions.deleteSelected(); return; }
    if (selected) this.drag = { type: 'edge', ids: s.graph.walls.filter(w => w.id === selected.id).flatMap(w => [w.a, w.b]), start: p, before: structuredClone(s.graph) };
    this.draw();
  }
  move(e) {
    const screen = this.screen(e); if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, screen);
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()], mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d = distance(a, b);
      this.zoomAt(d / Math.max(1, this.pinch.distance), mid.x, mid.y);
      this.tx += mid.x - this.pinch.mid.x; this.ty += mid.y - this.pinch.mid.y;
      this.pinch = { distance: d, mid }; this.draw(); return;
    }
    const p = this.world(screen), s = this.getState(); this.cursor = this.snap(p);
    if (!this.drag) { if (this.pending) this.draw(); return; }
    if (this.drag.type === 'pan') { this.tx = this.drag.tx + screen.x - this.drag.start.x; this.ty = this.drag.ty + screen.y - this.drag.start.y; }
    else if (this.drag.type === 'corner') this.actions.corner(this.drag.index, this.pointInside(p));
    else if (this.drag.type === 'node' || this.drag.type === 'edge') {
      const g = structuredClone(this.drag.before), dx = p.x - this.drag.start.x, dy = p.y - this.drag.start.y;
      for (const n of g.nodes) if (this.drag.type === 'node' ? n.id === this.drag.nodeId : this.drag.ids.includes(n.id)) {
        n.x = clamp(n.x + dx, 0, s.width - 1); n.y = clamp(n.y + dy, 0, s.height - 1);
      }
      this.actions.edit(g, false);
    }
    this.draw();
  }
  up(e) {
    this.pointers.delete(e.pointerId);
    if (this.pinch) { if (this.pointers.size < 2) this.pinch = null; this.drag = null; return; }
    if (this.drag && ['node', 'edge'].includes(this.drag.type)) {
      const s = this.getState();
      // Rebuild topology only on release; connected nodes move together during the drag.
      this.actions.edit(segmentsToGraph(graphSegments(normalizeGraph(s.graph)), s.snapEnabled ? 3 : 0), true);
    }
    this.drag = null; this.draw();
  }
  draw() {
    const ctx = this.ctx; if (!ctx) return;
    const s = this.getState();
    ctx.setTransform(this.dpr || 1, 0, 0, this.dpr || 1, 0, 0); ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = '#f1f2ee'; ctx.fillRect(0, 0, this.width, this.height);
    ctx.fillStyle = '#d8dcd5';
    for (let x = ((this.tx % 24) + 24) % 24; x < this.width; x += 24) for (let y = ((this.ty % 24) + 24) % 24; y < this.height; y += 24) ctx.fillRect(x, y, 1.2, 1.2);
    if (!s.width) return;
    ctx.save(); ctx.translate(this.tx, this.ty); ctx.scale(this.zoom, this.zoom);
    ctx.shadowColor = '#14252513'; ctx.shadowBlur = 22 / this.zoom; ctx.shadowOffsetY = 4 / this.zoom;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, s.width, s.height); ctx.shadowColor = 'transparent';
    if (s.image && (s.mode === 'crop' || s.showImage || s.diagnostic !== 'none')) {
      ctx.globalAlpha = s.mode === 'crop' || s.diagnostic !== 'none' ? 1 : 0.35;
      ctx.drawImage(s.image, 0, 0, s.width, s.height); ctx.globalAlpha = 1;
    }
    if (s.mode === 'crop') {
      ctx.beginPath(); ctx.rect(0, 0, s.width, s.height); ctx.moveTo(s.corners[0].x, s.corners[0].y); for (const p of s.corners.slice(1)) ctx.lineTo(p.x, p.y); ctx.closePath();
      ctx.fillStyle = '#102e3470'; ctx.fill('evenodd');
      ctx.beginPath(); s.corners.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
      ctx.strokeStyle = '#007f78'; ctx.lineWidth = 2.2 / this.zoom; ctx.stroke();
      for (let i = 0; i < 4; i++) {
        const p = s.corners[i]; ctx.beginPath(); ctx.arc(p.x, p.y, 10 / this.zoom, 0, Math.PI * 2); ctx.fillStyle = '#007f78'; ctx.fill();
        ctx.lineWidth = 2 / this.zoom; ctx.strokeStyle = '#fff'; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = `bold ${10 / this.zoom}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), p.x, p.y + 0.5 / this.zoom);
      }
    } else if (s.diagnostic === 'none') {
      for (const seg of graphSegments(s.graph)) {
        const selected = seg.id === s.selected; ctx.beginPath(); ctx.moveTo(seg.a.x, seg.a.y); ctx.lineTo(seg.b.x, seg.b.y);
        ctx.lineCap = 'round'; ctx.strokeStyle = selected ? '#df7b3e' : '#167d78'; ctx.lineWidth = (selected ? 4.5 : 3.2) / this.zoom; ctx.stroke();
        if (selected && s.pixelsPerMeter) {
          const text = (distance(seg.a, seg.b) / s.pixelsPerMeter).toFixed(2) + ' m';
          ctx.font = `600 ${12 / this.zoom}px monospace`; ctx.fillStyle = '#974b23'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          ctx.fillText(text, (seg.a.x + seg.b.x) / 2, (seg.a.y + seg.b.y) / 2 - 12 / this.zoom);
        }
      }
      if (s.showNodes) for (const n of s.graph.nodes) {
        ctx.beginPath(); ctx.arc(n.x, n.y, 4.5 / this.zoom, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
        ctx.strokeStyle = '#167d78'; ctx.lineWidth = 1.8 / this.zoom; ctx.stroke();
      }
      if (this.pending && this.cursor) {
        ctx.beginPath(); ctx.moveTo(this.pending.x, this.pending.y); ctx.lineTo(this.cursor.x, this.cursor.y); ctx.setLineDash([6 / this.zoom, 4 / this.zoom]);
        ctx.strokeStyle = '#df7b3e'; ctx.lineWidth = 2 / this.zoom; ctx.stroke(); ctx.setLineDash([]);
      }
    }
    ctx.restore();
    this.actions.zoom?.(Math.round(this.zoom * 100));
  }
}
