import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import * as THREE from 'three';
import { NavigationQuery, NavigationSession, OpenAxisConnectionManager, configureLogging, UNAVAILABLE } from '../../ts/sdk/dist/index.js';
import { Quat } from '../../ts/sdk/dist/geometry.js';

// Real demo scene, adapters, session and connection manager.
// Only rendering, browser events, the scheduler clock and transport are fakes.
async function demo(t) {
  const elements = new Map(), events = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      listeners: {}, open: false, style: {},
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
  let client, disposed = false;
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
      setSize() {} setPixelRatio() {} render() {} dispose() { disposed = true; }
    } },
    OpenAxisClient: Transport, OpenAxisConnectionManager, configureLogging,
    NavigationSession: class extends NavigationSession {
      constructor(client, adapter, options) { super(client, adapter, { ...options, scheduler, clock: () => 0 }); }
    },
    UNAVAILABLE, Quat,
    document: { body: { appendChild() {} }, hidden: false, hasFocus: () => true,
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
  const script = readFileSync(new URL('cube.html', import.meta.url), 'utf8')
    .match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^\s*import .*;$/gm, '');
  runInNewContext(script, context);
  const run = expression => { const value = runInNewContext(expression, context); flush(); return value; };
  async function settled() { await new Promise(resolve => setTimeout(resolve, 5)); flush(); }
  t.after(async () => { await run('shutdown()'); flush(); });
  for (let n = 0; run('fm.lifecycle.state') !== 'ready'; n++) { assert.ok(n < 100); await settled(); }
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
  return { client, run, query, dispatch, dispatchWindow, settled, flush, scheduler, disposed: () => disposed };
}

test('object navigation uses SDK binding and ordering while the camera stays fixed', async t => {
  const d = await demo(t), h = d.client.handlers;
  const facts = d.query(['object.bounds', 'pick.cursor.selection', 'pick.viewport_center.selection']).result.values;
  assert.ok(facts['object.bounds']);
  assert.equal(facts['pick.cursor.selection'], undefined);
  assert.equal(facts['pick.viewport_center.selection'], undefined);
  const pose = (seq, x, gesture_id = 1) => ({ type: 'object_pose', gesture_id, seq, t: [x, 0, 0], r: [0, .3, 0] });
  h.onMotionStart(1);
  h.onObjectPose(pose(0, 9));
  assert.equal(d.run('group.position.x'), 0, 'no output before a scoped query');
  d.query(['camera.pose', 'object.pose'], undefined, 1);
  h.onObjectPose(pose(1, 2));
  assert.equal(d.run('group.position.x'), 2);
  h.onObjectPose(pose(0, 9)); h.onObjectPose(pose(2, 9, 99));
  assert.equal(d.run('group.position.x'), 2);
  h.onMotionEnd(1);
  h.onObjectPose(pose(3, 9));
  assert.equal(d.run('group.position.x'), 2);
  h.onMotionStart(2);
  d.query(['camera.pose', 'object.pose'], undefined, 2);
  h.onCameraPose({ type: 'camera_pose', gesture_id: 2, seq: 0, t: [8, 8, 8], r: [0, 0, 0], fov: 1 });
  assert.deepEqual(Array.from(d.run('camera.position.toArray()')), [0, 0, 3]);
});

test('blur and pause invalidate output; reconnect restores metadata', async t => {
  const d = await demo(t), h = d.client.handlers;
  h.onMotionStart(1); d.query(['object.pose', 'object.bounds'], undefined, 1);
  d.run('animate()');
  d.dispatchWindow('blur');
  h.onObjectPose({ gesture_id: 1, seq: 0, t: [9, 0, 0], r: [0, 0, 0] });
  assert.equal(d.run('group.position.x'), 0);
  d.dispatchWindow('keydown', { key: 'Escape' }); await d.settled();
  assert.equal(d.run('fm.isPaused()'), true);
  d.dispatch('click', {}); await d.settled();
  assert.equal(d.run('fm.lifecycle.state'), 'ready');
  assert.deepEqual(d.client.tags, ['interaction.object.transform']);
  assert.equal(d.client.messages.filter(m => m.type === 'focus').at(-1).focused, true);
});

test('page cache suspension is resumable and final shutdown releases renderer and session', async t => {
  const d = await demo(t);
  d.dispatchWindow('pagehide', { persisted: true }); await d.settled();
  assert.equal(d.disposed(), false);
  d.dispatchWindow('pageshow'); await d.settled();
  assert.equal(d.run('fm.lifecycle.state'), 'ready');
  d.client.handlers.onMotionStart(2); d.query(['object.pose'], undefined, 2);
  d.client.handlers.onObjectPose({ gesture_id: 2, seq: 0, t: [1, 0, 0], r: [0, 0, 0] });
  assert.equal(d.run('group.position.x'), 1);
  await d.run('shutdown()');
  assert.equal(d.disposed(), true);
  assert.equal(d.client.navigation, undefined);
  assert.equal(d.client.state, 'disconnected');
});
