import * as THREE from 'three';

// Clip in homogeneous coordinates before dividing by W, including near/far
// planes. This also handles segments crossing behind a perspective camera.
export function projectSegment(start, end, matrix, width, height) {
  const a = new THREE.Vector4(...start, 1).applyMatrix4(matrix);
  const b = new THREE.Vector4(...end, 1).applyMatrix4(matrix);
  let low = 0, high = 1;
  for (const axis of ['x', 'y', 'z']) for (const sign of [-1, 1]) {
    const f = a.w + sign * a[axis], g = b.w + sign * b[axis];
    if (f < 0 && g < 0) return;
    if (f < 0) low = Math.max(low, f / (f - g));
    if (g < 0) high = Math.min(high, f / (f - g));
  }
  if (low > high) return;
  const p = a.clone().lerp(b, low), q = a.clone().lerp(b, high);
  if (p.w <= 0 || q.w <= 0) return;
  return [p, q].map(v => [(v.x / v.w + 1) * width / 2, (1 - v.y / v.w) * height / 2]);
}

/** Transient canvas graphics: never added to the Three.js scene or raycaster. */
export class NavigationDiagnosticOverlay {
  constructor(viewport, output, colors, document = globalThis.document) {
    this.viewport = viewport; this.output = output; this.colors = colors; this.document = document;
    this.canvas = document.createElement('canvas');
    this.canvas.hidden = true;
    this.canvas.setAttribute('aria-hidden', 'true');
    Object.assign(this.canvas.style, { position: 'fixed', pointerEvents: 'none', zIndex: '9998', display: 'none' });
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.matrix = new THREE.Matrix4();
    this.screenCoordinates = 'ndc';
  }
  color(tone) { return `rgb(${this.colors[tone].join(',')})`; }
  clear() {
    // Host canvas display rules can override the HTML hidden attribute.
    this.canvas.hidden = true; this.canvas.style.display = 'none';
    this.output.replaceChildren(); this.frame = undefined;
  }
  draw(diagnostics, camera, isCurrent, dpr = globalThis.devicePixelRatio || 1, now = performance.now() / 1000) {
    if (!diagnostics.enabled) { if (this.frame) this.clear(); return; }
    const changed = !this.frame || this.frame.revision !== diagnostics.revision
      || (this.frame.expiresAt !== undefined && now >= this.frame.expiresAt);
    if (changed) this.frame = diagnostics.presentation();
    const frame = this.frame;
    if (frame.context !== undefined && !isCurrent(frame.context)) { this.clear(); return; }
    if (changed) {
      const rows = frame.lines.length ? frame.lines : [{ text: 'Start a navigation gesture to inspect queries and pose writes.', tone: 'text' }];
      this.output.replaceChildren(...rows.map(row => {
        const line = this.document.createElement('span');
        line.style.display = 'block'; line.style.color = this.color(row.tone);
        line.textContent = row.text; return line;
      }));
    }
    const rect = this.viewport.getBoundingClientRect();
    const { width, height } = rect;
    this.canvas.hidden = width <= 0 || height <= 0;
    this.canvas.style.display = this.canvas.hidden ? 'none' : 'block';
    if (this.canvas.hidden) return;
    Object.assign(this.canvas.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${width}px`, height: `${height}px` });
    const w = Math.round(width * dpr), h = Math.round(height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    camera.updateMatrixWorld(true);
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // Reproject retained evidence every frame, including native camera motion.
    for (const segment of frame.segments) {
      const points = projectSegment(segment.start, segment.end, this.matrix, width, height);
      if (!points) continue;
      ctx.globalAlpha = segment.opacity ?? 1;
      ctx.strokeStyle = this.color(segment.tone); ctx.lineWidth = segment.width;
      ctx.beginPath(); ctx.moveTo(...points[0]); ctx.lineTo(...points[1]); ctx.stroke();
    }
    ctx.globalAlpha = .65;
    ctx.font = '12px system-ui'; ctx.textBaseline = 'bottom'; ctx.lineJoin = 'round';
    for (const marker of frame.markers) {
      // This integration records NDC samples, so resize does not scale twice.
      const x = this.screenCoordinates === 'pixels' ? marker.point[0] : (marker.point[0] + 1) * width / 2;
      const y = this.screenCoordinates === 'pixels' ? marker.point[1] : (1 - marker.point[1]) * height / 2;
      ctx.strokeStyle = this.color(marker.tone); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x - 9, y); ctx.lineTo(x + 9, y);
      ctx.moveTo(x, y - 9); ctx.lineTo(x, y + 9); ctx.stroke();
      ctx.fillStyle = this.color(marker.tone);
      marker.label.split('\n').forEach((label, index) => {
        // Dark outline preserves label readability over both bright and dark geometry.
        ctx.strokeStyle = '#111'; ctx.lineWidth = 3;
        ctx.strokeText(label, x + 12, y - 8 + index * 15);
        ctx.fillText(label, x + 12, y - 8 + index * 15);
      });
    }
    ctx.globalAlpha = 1;
  }
  dispose() { this.clear(); this.canvas.remove(); }
}
