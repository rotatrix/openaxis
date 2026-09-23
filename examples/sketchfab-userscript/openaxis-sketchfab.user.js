// ==UserScript==
// @name         OpenAxis Sketchfab camera experiment
// @namespace    https://openaxis.dev/
// @version      0.1.0
// @description  Experimental independent camera and pivot controls inside Sketchfab viewers.
// @match        https://sketchfab.com/*
// @match        https://*.sketchfab.com/*
// @run-at       document-start
// @sandbox      raw
// @grant        none
// ==/UserScript==

/* Private renderer experiment; no device connection or remote dependencies.
 * Run in the page's MAIN world, including matching child frames.
 * Copyright (c) OpenAxis contributors. */
(function () {
  'use strict';
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const scale = (a, s) => a.map(v => v * s);
  const dot = (a, b) => a.reduce((v, x, i) => v + x * b[i], 0);
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const length = a => Math.hypot(...a);
  const unit = a => scale(a, 1 / length(a));
  function rotate(v, axis, angle) {
    const n = unit(axis), c = Math.cos(angle), s = Math.sin(angle);
    return add(add(scale(v, c), scale(cross(n, v), s)), scale(n, dot(n, v)*(1-c)));
  }
  class Camera {
    constructor(view, pivot) {
      if (view.length !== 16 || !Array.from(view).every(Number.isFinite)) throw Error('Invalid view matrix');
      // OSG uses column-major rigid view matrices. Rows are camera world axes.
      this.right = [view[0], view[4], view[8]];
      this.up = [view[1], view[5], view[9]];
      this.back = [view[2], view[6], view[10]];
      if ([this.right, this.up, this.back].some(v => Math.abs(length(v)-1) > 0.001) ||
          Math.abs(dot(this.right, this.up)) > 0.001 ||
          Math.abs(dot(cross(this.right, this.up), this.back)-1) > 0.001) {
        throw Error('Camera view is not a rigid right-handed transform');
      }
      this.eye = add(add(scale(this.right, -view[12]), scale(this.up, -view[13])), scale(this.back, -view[14]));
      this.pivot = pivot && pivot.length === 3 && pivot.every(Number.isFinite) ? [...pivot] : sub(this.eye, this.back);
    }
    matrix() {
      const r=this.right, u=this.up, b=this.back, p=this.eye;
      return [r[0],u[0],b[0],0,r[1],u[1],b[1],0,r[2],u[2],b[2],0,-dot(r,p),-dot(u,p),-dot(b,p),1];
    }
    move(axis, distance) {
      const delta = scale(this[axis], distance);
      this.eye = add(this.eye, delta);
      this.pivot = add(this.pivot, delta);
    }
    turn(axis, radians, orbit) {
      const about = [...this[axis]];
      if (orbit) this.eye = add(this.pivot, rotate(sub(this.eye, this.pivot), about, radians));
      this.right = unit(rotate(this.right, about, radians));
      this.up = unit(rotate(this.up, about, radians));
      // Re-orthogonalize to avoid accumulated drift.
      this.back = unit(cross(this.right, this.up));
      this.up = unit(cross(this.back, this.right));
    }
  }

  function installHook(Viewer, onViewer, getCamera) {
    const p = Viewer.prototype, frame = p.frame, render = p.renderingTraversal;
    if (typeof frame !== 'function' || typeof render !== 'function') throw Error('Unsupported renderer');
    function wrappedFrame(...args) { onViewer(this); return frame.apply(this, args); }
    function wrappedRender(...args) {
      const controlled = getCamera(this);
      if (!controlled) return render.apply(this, args);
      const view = this.getCamera().getViewMatrix(), saved = Array.from(view);
      const matrix = controlled.matrix();
      for (let i=0; i<16; i++) view[i] = matrix[i];
      // Restore even if rendering fails. Native camera state stays available on release.
      try { return render.apply(this, args); }
      finally { for (let i=0; i<16; i++) view[i] = saved[i]; }
    }
    p.frame = wrappedFrame;
    p.renderingTraversal = wrappedRender;
    return () => {
      if (p.frame === wrappedFrame) p.frame = frame;
      if (p.renderingTraversal === wrappedRender) p.renderingTraversal = render;
    };
  }
  function findEngineModule(factories) {
    return Object.keys(factories).filter(id => {
      const source = Function.prototype.toString.call(factories[id]);
      return source.includes('renderingTraversal') && source.includes('getInverseMatrix') && source.includes('osgViewer');
    });
  }
  // Allows the same shipped userscript to be exercised by Node tests, without a build.
  if (typeof module === 'object' && module.exports) { module.exports = { Camera, installHook, findEngineModule }; return; }
  if (typeof window === 'undefined' || window.__openaxisSketchfabExperiment) return;
  window.__openaxisSketchfabExperiment = true;

  let viewer, controlled, original, unhook, stopped = false;
  let panel, status, pivotInputs, stepInput, orbitInput, raf;
  const report = message => { if (status) status.textContent = message; };
  function capture(instance) {
    // One renderer per frame. Do not attach to thumbnails before the model viewer.
    if (!viewer && instance.getCamera && instance.getManipulator?.()) {
      viewer = instance;
      report('Camera found. Take control to begin.');
    }
  }
  function snapshot() {
    const pivot = [];
    viewer.getManipulator()?.getTarget?.(pivot);
    return new Camera(viewer.getCamera().getViewMatrix(), pivot);
  }
  function showPivot() { pivotInputs.forEach((el, i) => { el.value = controlled.pivot[i].toPrecision(8); }); }
  function redraw() {
    if (controlled && !stopped) { viewer.requestRedraw(); raf = requestAnimationFrame(redraw); }
  }
  function release() {
    controlled = undefined;
    cancelAnimationFrame(raf);
    viewer?.requestRedraw();
    report(viewer ? 'Released to Sketchfab. Native camera pose restored.' : 'Waiting for a camera frame…');
  }
  function act(action) {
    try {
      if (action === 'release') return release();
      if (!viewer) throw Error('Camera not found yet. Start the model and move its camera once.');
      if (action === 'take') {
        if (!controlled) {
          controlled = snapshot(); original = { view: controlled.matrix(), pivot: [...controlled.pivot] };
          stepInput.value = String(Math.max(length(sub(controlled.eye, controlled.pivot))*0.05, 0.001));
          showPivot(); redraw();
        }
        report('Independent camera active. Mouse navigation may conflict; use these controls.');
        return;
      }
      if (!controlled) throw Error('Take control first.');
      if (action === 'reset') { controlled = new Camera(original.view, original.pivot); showPivot(); return; }
      if (action === 'pivot') {
        const values = pivotInputs.map(el => el.value.trim() === '' ? NaN : Number(el.value));
        if (!values.every(Number.isFinite)) throw Error('Enter three finite world coordinates.');
        controlled.pivot = values; report('Pivot changed without moving the camera or model.'); return;
      }
      const [kind, axis, sign] = action.split(':');
      if (kind === 'move') {
        const step = Number(stepInput.value);
        if (!(step > 0 && Number.isFinite(step))) throw Error('Translation step must be positive.');
        controlled.move(axis, step * Number(sign)); showPivot();
      } else if (kind === 'turn') controlled.turn(axis, Number(sign)*Math.PI/36, orbitInput.checked);
    } catch (error) { report(error.message); }
  }
  function mount() {
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;top:12px;left:12px;z-index:2147483647';
    const root = panel.attachShadow({mode:'open'});
    root.innerHTML = `<style>
      :host{color-scheme:dark}section{font:12px/1.5 system-ui;color:#eee;background:#17212bee;padding:12px;border:1px solid #63829a;border-radius:8px;width:280px;box-shadow:0 4px 20px #0008}button,input{font:inherit;margin:2px;border:1px solid #63829a;border-radius:4px;background:#263c4d;color:white;padding:4px}button{cursor:pointer}button:hover{background:#41627a}input[type=number]{width:74px}p{margin:6px 0}summary{cursor:pointer;font-weight:bold}.status{color:#9edcff;min-height:36px}
      </style><section><details open><summary>OpenAxis · camera experiment</summary>
      <p class="status">Waiting for Sketchfab’s renderer…</p>
      <p><button data-action="take">Take control</button><button data-action="release">Release</button><button data-action="reset">Reset</button></p>
      <p>Camera translation · step <input aria-label="Translation step" id="step" type="number" value="0.1" min="0" step="any"></p>
      <p><button data-action="move:right:-1">Left</button><button data-action="move:right:1">Right</button><button data-action="move:up:1">Up</button><button data-action="move:up:-1">Down</button><button data-action="move:back:-1">Forward</button><button data-action="move:back:1">Back</button></p>
      <p>Rotation · 5° per click</p><p><button data-action="turn:up:1">Yaw +</button><button data-action="turn:up:-1">Yaw −</button><button data-action="turn:right:1">Pitch +</button><button data-action="turn:right:-1">Pitch −</button><button data-action="turn:back:1">Roll +</button><button data-action="turn:back:-1">Roll −</button></p>
      <p><label><input id="orbit" type="checkbox">Rotate around pivot (otherwise camera eye)</label></p>
      <p>Pivot · world X / Y / Z</p><p><input class="pivot" aria-label="Pivot X" type="number" step="any" value="0"><input class="pivot" aria-label="Pivot Y" type="number" step="any" value="0"><input class="pivot" aria-label="Pivot Z" type="number" step="any" value="0"><button data-action="pivot">Set pivot</button></p>
      <p>Experimental private hook. Changes only this tab’s rendered camera. No device connection. Release may jump to the native camera pose.</p>
      <button id="close">Remove experiment</button></details></section>`;
    status = root.querySelector('.status'); pivotInputs = [...root.querySelectorAll('.pivot')];
    stepInput = root.querySelector('#step'); orbitInput = root.querySelector('#orbit');
    root.addEventListener('click', e => { if (e.target.dataset.action) act(e.target.dataset.action); });
    // Keep panel interactions out of native mouse/keyboard navigation.
    for (const type of ['pointerdown','pointerup','mousedown','mouseup','wheel','keydown','keyup']) root.addEventListener(type, e => e.stopPropagation());
    root.querySelector('#close').onclick = () => { release(); stopped = true; unhook?.(); panel.remove(); };
    document.documentElement.append(panel);
  }
  let attempts = 0;
  function attach() {
    if (stopped) return;
    try {
      const chunks = window.webpackChunksketchfab;
      if (!chunks || chunks.push === Array.prototype.push || document.readyState !== 'complete') throw Error('Viewer is still loading.');
      let runtime;
      chunks.push([[`openaxis-camera-${Date.now()}`], {}, require => { runtime = require; }]);
      if (!runtime?.m) throw Error('Webpack runtime is unavailable in this script world. Use MAIN/raw injection.');
      const ids = findEngineModule(runtime.m);
      if (ids.length !== 1) throw Error(`Expected one compatible renderer module; found ${ids.length}.`);
      const exports = runtime(ids[0]);
      const engine = exports.Z ?? exports.default ?? exports;
      const Viewer = engine.osgViewer?.Viewer;
      if (!Viewer?.prototype?.renderingTraversal) throw Error('Renderer export has changed.');
      unhook = installHook(Viewer, capture, instance => instance === viewer ? controlled : undefined);
      report('Renderer hook installed. Start the model or move its camera to capture it.');
    } catch (error) {
      if (++attempts < 60) setTimeout(attach, 1000);
      else report(`Unavailable: ${error.message} Reload after enabling the script in matching frames.`);
    }
  }
  function start() { mount(); attach(); }
  // Avoid a duplicate overlay on the outer model page; its /embed frame gets its own script.
  if (/\/models\/[^/]+\/embed\/?$/.test(location.pathname)) {
    if (document.documentElement) start(); else addEventListener('DOMContentLoaded', start, {once:true});
  }
})();
