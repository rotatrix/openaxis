import { NavigationSession, OpenAxisClient, UNAVAILABLE, type CameraPoseValue, type NavigationAdapter, type NavigationStateMessage, type Vec3 } from '@openaxis/sdk';
import { manageFocus } from './focus-manager.js';

/** A canvas document measured in drawing units, with a fixed XY orientation. */
export class CanvasView {
  static readonly minExtent = 2;
  static readonly maxExtent = 80000;
  alive = true;
  width = 1;
  height = 1;
  cursor?: { x: number; y: number };
  pose: CameraPoseValue = { t: [0, 0, 10], r: [0, 0, 0], ortho_extent: 800 };
  read(): CameraPoseValue { return structuredClone(this.pose); }
  write(pose: CameraPoseValue, anchor?: Vec3) {
    if (!pose.ortho_extent || pose.ortho_extent < 0 || !Number.isFinite(pose.ortho_extent)) return false;
    const extent = Math.max(CanvasView.minExtent, Math.min(CanvasView.maxExtent, pose.ortho_extent));
    const t: Vec3 = [...pose.t];
    if (anchor && extent !== pose.ortho_extent) {
      // Preserve the anchor's projected position when constraining zoom. Merely
      // clamping the lens retains the overshoot translation and causes drift.
      const ratio = extent / pose.ortho_extent;
      t[0] = anchor[0] + (t[0] - anchor[0]) * ratio;
      t[1] = anchor[1] + (t[1] - anchor[1]) * ratio;
    }
    this.pose = { t, r: [0, 0, 0], ortho_extent: extent };
    return true;
  }
  world(x: number, y: number): [number, number] {
    const units = this.pose.ortho_extent! / this.height;
    return [this.pose.t[0] + (x - this.width / 2) * units, this.pose.t[1] - (y - this.height / 2) * units];
  }
  pan(dx: number, dy: number) {
    const units = this.pose.ortho_extent! / this.height;
    this.pose.t[0] -= dx * units; this.pose.t[1] += dy * units;
  }
  zoom(x: number, y: number, delta: number) {
    const before = this.world(x, y);
    this.write({ ...this.read(), ortho_extent: Math.exp(Math.max(Math.log(CanvasView.minExtent), Math.min(Math.log(CanvasView.maxExtent), Math.log(this.pose.ortho_extent!) + delta * .001))) });
    const after = this.world(x, y);
    this.pose.t[0] += before[0] - after[0]; this.pose.t[1] += before[1] - after[1];
  }
}

// #region adapter
export class CanvasNavigationAdapter implements NavigationAdapter<CanvasView> {
  constructor(private view: CanvasView) {}
  captureContext() { return this.view.alive ? this.view : undefined; }
  isCurrent(context: CanvasView) { return this.view.alive && context === this.view; }
  beginQuery() {
    const pose = this.view.read();
    const aspect = this.view.width / this.view.height;
    const cursor = this.view.cursor && { ...this.view.cursor };
    return { resolve(name: string): unknown {
      switch (name) {
        case 'document.id': return 'workflow-diagram';
        case 'world.orientation': return { forward: [0, 0, -1], up: [0, 1, 0], handedness: 'right' };
        case 'camera.pose': return pose;
        case 'viewport.aspect': return aspect;
        case 'viewport.cursor': return cursor ?? UNAVAILABLE;
        default: return UNAVAILABLE;
      }
    } };
  }
  applyPose(context: CanvasView, pose: CameraPoseValue, _navigation?: NavigationStateMessage, pivot?: Vec3) {
    if (!this.isCurrent(context) || !context.write(pose, pivot)) return { success: false };
    return { success: true, realizedPose: context.read() };
  }
}
// #endregion adapter

export function startCanvasDemo(canvas: HTMLCanvasElement) {
  const view = new CanvasView();
  const ctx = canvas.getContext('2d')!;
  const client = new OpenAxisClient({ clientName: 'demo-viewspace-2d' });
  const session = new NavigationSession(client, new CanvasNavigationAdapter(view));
  const status = document.getElementById('status')!;
  const fm = manageFocus(client, {
    metadata: () => ({ tags: ['demo-3d-services', 'viewspace.2d'], capabilities: ['navigation'] }),
    onState: (state: string) => { status.textContent = `Rotatrix: ${state}`; },
    onPauseChange: () => session.contextChanged(),
  });
  const key = /Mac/i.test(navigator.platform) ? 'Ctrl' : /Linux/i.test(navigator.platform) ? 'Super' : 'Win';
  document.getElementById('activation')!.textContent = `${key}+Shift or btn4 activates pan and zoom (if not remapped)`;
  const detach: (() => void)[] = [];
  function listen(target: EventTarget, name: string, fn: EventListener, options?: AddEventListenerOptions) {
    target.addEventListener(name, fn, options); detach.push(() => target.removeEventListener(name, fn, options));
  }
  function resize() {
    view.width = Math.max(1, canvas.clientWidth); view.height = Math.max(1, canvas.clientHeight);
    canvas.width = Math.round(view.width * devicePixelRatio); canvas.height = Math.round(view.height * devicePixelRatio);
    view.cursor = undefined; session.contextChanged();
  }
  let drag: { id: number; x: number; y: number } | undefined;
  const pixel = (e: PointerEvent | WheelEvent) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  listen(canvas, 'pointerdown', event => {
    const e = event as PointerEvent; if (e.button !== 0) return;
    canvas.focus(); fm.resume(); canvas.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  listen(canvas, 'pointermove', event => {
    const e = event as PointerEvent, [x, y] = pixel(e);
    view.cursor = x >= 0 && y >= 0 && x <= view.width && y <= view.height
      ? { x: 2 * x / view.width - 1, y: 1 - 2 * y / view.height } : undefined;
    if (drag?.id === e.pointerId) {
      view.pan(e.clientX - drag.x, e.clientY - drag.y);
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY }; session.nativeCameraChanged();
    }
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(canvas, name, () => { drag = undefined; });
  listen(canvas, 'pointerleave', () => { view.cursor = undefined; });
  listen(canvas, 'wheel', event => {
    const e = event as WheelEvent; e.preventDefault(); const [x, y] = pixel(e);
    view.zoom(x, y, e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? view.height : 1));
    session.nativeCameraChanged();
  }, { passive: false });
  const reset = () => { view.pose = new CanvasView().read(); session.nativeCameraChanged(); };
  listen(document.getElementById('reset')!, 'click', reset);
  listen(window, 'keydown', event => { if ((event as KeyboardEvent).key.toLowerCase() === 'r') reset(); });
  listen(window, 'resize', resize);
  listen(window, 'blur', () => { drag = undefined; view.cursor = undefined; session.contextChanged(); });
  listen(window, 'pagehide', event => {
    session.contextChanged(); drag = undefined; view.cursor = undefined;
    if (!(event as PageTransitionEvent).persisted) void shutdown();
  });
  let frame = 0;
  function draw() {
    if (!view.alive) return;
    frame = requestAnimationFrame(draw);
    const scale = view.height / view.pose.ortho_extent!;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.fillStyle = '#121c29'; ctx.fillRect(0, 0, view.width, view.height);
    ctx.translate(view.width / 2 - view.pose.t[0] * scale, view.height / 2 + view.pose.t[1] * scale);
    ctx.scale(scale, scale);
    ctx.strokeStyle = '#263548'; ctx.lineWidth = 1 / scale;
    for (let x = -700; x <= 700; x += 50) { ctx.beginPath(); ctx.moveTo(x, -400); ctx.lineTo(x, 400); ctx.stroke(); }
    for (let y = -400; y <= 400; y += 50) { ctx.beginPath(); ctx.moveTo(-700, y); ctx.lineTo(700, y); ctx.stroke(); }
    const nodes = [[-420, 0, 'Capture', 'Collect ideas'], [-140, 0, 'Design', 'Explore a solution'], [140, 0, 'Build', 'Make it work'], [420, 0, 'Review', 'Share and improve']] as const;
    ctx.strokeStyle = '#71c8ed'; ctx.lineWidth = 3;
    for (let i = 0; i < 3; i++) {
      const x = nodes[i][0] + 110; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 60, 0); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + 50, -6); ctx.lineTo(x + 60, 0); ctx.lineTo(x + 50, 6); ctx.stroke();
    }
    const tasks = [
      [['Listen', 'Interview three people', 'Save one surprising quote'], ['Collect', 'Gather sketches and links', 'Keep the strange ideas'], ['Connect', 'Group recurring themes', 'Find the missing question']],
      [['Sketch', 'Try three directions', 'Start with the simplest'], ['Prototype', 'Make one path tangible', 'Leave room for discovery'], ['Choose', 'Compare the tradeoffs', 'Write down the why']],
      [['Assemble', 'Build a small vertical slice', 'Make the happy path work'], ['Test', 'Try the awkward cases', 'Check the tiny details'], ['Polish', 'Remove one rough edge', 'Make the next step obvious']],
      [['Share', 'Show it to someone new', 'Watch before explaining'], ['Reflect', 'Name what surprised you', 'Keep one lesson'], ['Repeat', 'Pick the next experiment', 'Follow your curiosity']],
    ];
    for (const [stage, [x, y, title, detail]] of nodes.entries()) {
      ctx.strokeStyle = '#71c8ed'; ctx.lineWidth = 3;
      ctx.fillStyle = '#21364c'; ctx.beginPath(); ctx.roundRect(x - 110, y - 55, 220, 110, 12); ctx.fill(); ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillStyle = '#f1f7ff';
      ctx.font = '600 12px system-ui';
      ctx.fillText(title, x, y - 34);
      ctx.fillStyle = '#a9c2d9'; ctx.font = '7px system-ui';
      ctx.fillText(detail, x, y - 22);
      for (let task = 0; task < 3; task++) {
        const tx = x - 98 + task * 67;
        const [name, first, second] = tasks[stage][task];
        ctx.fillStyle = '#152738'; ctx.strokeStyle = ['#82d5c5', '#efc884', '#c1a9ed'][task];
        ctx.lineWidth = .6;
        ctx.beginPath(); ctx.roundRect(tx, y - 11, 62, 52, 3); ctx.fill(); ctx.stroke();
        ctx.textAlign = 'left'; ctx.fillStyle = '#e8f3ff'; ctx.font = '600 6px system-ui';
        ctx.fillText(`${stage + 1}.${task + 1}  ${name}`, tx + 4, y - 1);
        ctx.font = '3.4px system-ui';
        for (const [line, note] of [first, second].entries()) {
          const ty = y + 9 + line * 9;
          ctx.strokeStyle = '#82d5c5'; ctx.lineWidth = .35; ctx.strokeRect(tx + 4, ty - 2.5, 2.5, 2.5);
          ctx.fillStyle = '#c3d5e4'; ctx.fillText(note, tx + 9, ty);
        }
        ctx.fillStyle = '#efc884'; ctx.font = 'italic 3px system-ui';
        ctx.fillText(stage === 3 && task === 2 ? 'You found the next beginning.' : 'Small steps. Interesting discoveries.', tx + 4, y + 32);
        // A miniature notebook, always present at its own drawing scale.
        ctx.fillStyle = '#0d1b28'; ctx.strokeStyle = '#567c97'; ctx.lineWidth = .08;
        ctx.beginPath(); ctx.roundRect(tx + 33, y + 22, 25, 6, .4); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#efc884'; ctx.font = '600 .75px system-ui';
        ctx.fillText('FIELD JOURNAL / ' + name.toUpperCase(), tx + 34, y + 23.3);
        ctx.fillStyle = '#b7cfdf'; ctx.font = '.6px system-ui';
        ctx.fillText('01  Notice one thing you nearly missed.', tx + 34, y + 24.5);
        ctx.fillText('02  Make a tiny change. Try it again.', tx + 34, y + 25.5);
        ctx.fillText('03  Leave a useful clue for the next person.', tx + 34, y + 26.5);
        // Tiny progress dots reward a closer look without adding another control.
        for (let dot = 0; dot < 8; dot++) {
          ctx.fillStyle = dot <= stage + task ? '#82d5c5' : '#304b62';
          ctx.beginPath(); ctx.arc(tx + 5 + dot * 3, y + 37, .7, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    ctx.textAlign = 'left'; ctx.fillStyle = '#d5e9fb'; ctx.font = '600 30px system-ui'; ctx.fillText('From idea to delivery', -530, -160);
    ctx.font = '17px system-ui'; ctx.fillStyle = '#8ca5bf'; ctx.fillText('A workflow canvas · pan and zoom to explore', -530, -125);
    document.getElementById('zoom')!.textContent = `Zoom: ${Math.round(800 / view.pose.ortho_extent! * 100)}%`;
  }
  async function shutdown() {
    view.alive = false; cancelAnimationFrame(frame); detach.forEach(fn => fn());
    try { await fm.destroy(); } finally { session.close(); session.drain(); }
  }
  resize(); draw();
  return { view, session, shutdown };
}
