import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import * as THREE from 'three';
import { NavigationQuery, NavigationSession, OpenAxisConnectionManager, configureLogging, UNAVAILABLE } from '../../ts/sdk/dist/index.js';
import { Quat } from '../../ts/sdk/dist/geometry.js';
import { createSplatAdapter, moveCamera } from './lib/splat-navigation.js';

// Real demo scene, adapters, session and connection manager.
// Only rendering, browser events, the scheduler clock and transport are fakes.
async function demo(t) {
  const elements = new Map(), events = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      listeners: {}, open: false, style: {}, value: id === "speed" ? "3" : "right", innerHTML: "credit", textContent: "",
      querySelector: () => element("submit"), focus() {},
      setAttribute() {}, replaceChildren(...children) { this.children = children; }, remove() { this.removed = true; },
      addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); },
      removeEventListener(type, listener) { this.listeners[type] = this.listeners[type]?.filter(x => x !== listener); },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
      getContext: () => new Proxy({ createLinearGradient: () => ({ addColorStop() {} }) }, { get: (o, k) => o[k] ?? (() => {}) }),
    });
    return elements.get(id);
  }
  const scheduler = { callbacks: [], timers: [], post(callback) { this.callbacks.push(callback); },
    postAt(deadline, callback) { this.timers.push([deadline, callback]); } };
  const flush = () => { for (let n = 0; scheduler.callbacks.length; n++) {
    assert.ok(n < 100, 'scheduler made no progress'); scheduler.callbacks.shift()();
  } };
  let client, disposed = false; const pendingLoads = [];
  class Transport {
    state = 'disconnected'; url = 'ws://test'; listeners = new Set(); messages = []; generation = 0;
    constructor(options, listener) {
      client = this; if (listener) this.listeners.add(listener);
      this.handlers = new Proxy({}, { get: (_, name) => (...args) => {
        if (name === 'onStateChange') this.setState(args[0]);
        else this.navigation?.[name]?.(...args);
        flush();
      } });
    }
    get tags() { return this.messages.filter(m => m.type === 'tags').at(-1)?.tags ?? []; }
    get cancels() { return this.messages.filter(m => m.type === 'motion_cancel').map(m => m.gesture_id); }
    setState(state) { this.state = state; this.navigation?.onStateChange(state); for (const l of this.listeners) l.onStateChange?.(state); }
    async connect() { this.generation++; this.setState('connected'); }
    async disconnect() { this.setState('disconnected'); }
    addListener(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    attachNavigation(listener) { assert.equal(this.navigation, undefined); this.navigation = listener; return () => { this.navigation = undefined; }; }
    captureNavigationSender() {
      const generation = this.generation;
      return message => {
        assert.equal(this.state, 'connected'); assert.equal(this.generation, generation, 'retired connection');
        this.messages.push(structuredClone(message));
      };
    }
  }
  const context = {
    THREE: { ...THREE, WebGLRenderer: class {
      domElement = element('canvas');
      setSize() {} setPixelRatio() {} setAnimationLoop(fn) { this.loop = fn; } render() {} dispose() { disposed = true; }
    } },
    createSplatAdapter, moveCamera, AbortController, TextEncoder, File: class {}, zipSync: () => new Uint8Array(),
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    SparkRenderer: class extends THREE.Object3D { dispose() { this.disposed = true; } },
    SplatMesh: class extends THREE.Object3D {
      numSplats = 1;
      initialized = new Promise(resolve => pendingLoads.push(() => { resolve(this); return this; }));
      dispose() { this.disposed = true; }
    },
    OpenAxisClient: Transport, OpenAxisConnectionManager, configureLogging,
    NavigationSession: class extends NavigationSession {
      constructor(client, adapter, options) { super(client, adapter, { ...options, scheduler, clock: () => 0 }); }
    },
    UNAVAILABLE, Quat,
    document: { body: { appendChild() {}, prepend() {} }, hidden: false, hasFocus: () => true,
      getElementById: element, createElement: element, addEventListener() {}, removeEventListener() {} },
    innerWidth: 1200, innerHeight: 800, devicePixelRatio: 2,
    addEventListener(name, callback) { const list = events.get(name) ?? []; list.push(callback); events.set(name, list); },
    removeEventListener(name, callback) { events.set(name, events.get(name)?.filter(c => c !== callback) ?? []); },
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
    setTimeout, clearTimeout, performance, structuredClone, console: { ...console, info() {}, debug() {} },
    createStatusHUD: () => Object.assign(() => {}, { setPaused() {} }),
  };
  const focusSource = readFileSync(new URL('./lib/focus-manager.js', import.meta.url), 'utf8')
    .replace(/^import .*$/m, '').replaceAll('export ', '');
  runInNewContext(focusSource, context);
  const script = readFileSync(new URL('./lib/splat-explorer.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
  runInNewContext(script, context);
  const run = expression => { const value = runInNewContext(expression, context); flush(); return value; };
  async function settled() { await new Promise(resolve => setTimeout(resolve, 5)); flush(); }
  t.after(async () => { await run('shutdown()'); flush(); });
  await settled();
  let id = 0;
  function query(values, first, gestureId) {
    let result, error;
    const params = { values };
    if (first !== undefined) params.first = first;
    if (gestureId !== undefined) params.gesture_id = gestureId;
    client.handlers.onNavigationQuery(new NavigationQuery(
      { type: 'request', id: ++id, method: 'navigation.query', params },
      value => { result = value; }, code => { error = code; },
    ));
    return { result, error };
  }
  const dispatch = (type, event) => { element('canvas').listeners[type]?.forEach(listener => listener(event)); flush(); };
  const dispatchWindow = (type, event = {}) => { events.get(type)?.forEach(listener => listener(event)); flush(); };
  return { pendingLoads, client, run, query, dispatch, dispatchWindow, settled, flush, scheduler, disposed: () => disposed };
}

test('scan readiness, native keyboard motion and reset are wired to the real session', async t => {
  const d = await demo(t);
  assert.equal(d.run('loading'), true);
  d.pendingLoads.shift()(); await d.settled(); await d.settled();
  assert.equal(d.run('loading'), false);
  assert.equal(d.run('fm.lifecycle.state'), 'ready');
  d.client.handlers.onMotionStart(1); d.query(['camera.pose'], undefined, 1);
  d.run('keys.add("KeyW"); renderer.loop(0); renderer.loop(20);');
  assert.ok(d.client.messages.some(m => m.type === 'camera.delta'));
  d.run('resetView()'); await d.settled();
  assert.equal(d.run('keys.size'), 0);
  d.run('var retiredMesh = mesh;');
  await d.run('shutdown()');
  assert.equal(d.run('retiredMesh.disposed'), true);
  assert.equal(d.run('spark.disposed'), true);
  assert.equal(d.disposed(), true);
});

test('a scan completing after shutdown is disposed and cannot restart the connection', async t => {
  const d = await demo(t);
  assert.equal(d.pendingLoads.length, 1);
  await d.run('shutdown()');
  const lateMesh = d.pendingLoads.shift()(); await d.settled();
  assert.equal(lateMesh.disposed, true);
  assert.equal(d.run('mesh'), undefined);
  assert.equal(d.run('fm.lifecycle.state'), 'stopped');
  assert.equal(d.client.navigation, undefined);
});
