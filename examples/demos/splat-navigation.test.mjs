import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { NavigationSession, NavigationQuery, UNAVAILABLE } from '../../ts/sdk/dist/index.js';
import { createSplatAdapter, moveCamera } from './lib/splat-navigation.js';

function fixture(t) {
  const camera = new THREE.PerspectiveCamera(75, 2);
  let available = true, listener, id = 0;
  const sent = [], queue = [];
  const client = { state: 'connected', attachNavigation(l) { listener = l; return () => { listener = undefined; }; },
    captureNavigationSender: () => m => sent.push(m) };
  const adapter = createSplatAdapter(camera, UNAVAILABLE, () => ({ speed: 3 }), () => available);
  const session = new NavigationSession(client, adapter, { observation: adapter.observation,
    clock: () => 0, scheduler: { post: fn => queue.push(fn), postAt() {} } });
  const flush = () => { while (queue.length) queue.shift()(); };
  const emit = (name, ...args) => { listener[name](...args); flush(); };
  function query(values = ['camera.pose'], gesture = 1) {
    let result;
    emit('onNavigationQuery', new NavigationQuery({ type: 'request', id: ++id, method: 'navigation.query',
      params: { values, gesture_id: gesture } }, r => { result = r; }, () => {}));
    return result;
  }
  const pose = (seq, t = [0,0,0], r = [0,0,0], ack) => emit('onCameraPose', {
    type: 'camera.pose', gesture_id: 1, seq, t, r, fov: camera.fov * Math.PI / 180,
    ...(ack === undefined ? {} : { applied_delta_id: ack }) });
  t.after(() => { session.close(); session.drain(); });
  flush(); emit('onMotionStart', 1); query();
  return { camera, session, sent, emit, pose, query, flush, retire() { available = false; session.contextChanged(); flush(); } };
}

test('SDK applies absolute splat poses and rejects stale and retired gestures', t => {
  const f = fixture(t);
  f.pose(1, [1,2,3], [0,.4,0]); f.pose(0, [9,9,9]);
  assert.deepEqual(f.camera.position.toArray(), [1,2,3]);
  const facts = f.query(['navigation.translation_scale', 'navigation.preferences', 'pick.cursor']).values;
  assert.equal(facts['navigation.translation_scale'], 3);
  assert.deepEqual(facts['navigation.preferences'], { lock_roll: true, lock_translation_plane: true });
  assert.equal(facts['pick.cursor'], undefined);
  f.retire(); f.pose(2, [9,9,9]);
  assert.deepEqual(f.camera.position.toArray(), [1,2,3]);
});

test('native mouse look is retained until the host acknowledges its correction', t => {
  const f = fixture(t);
  f.pose(0, [0,0,-1]);
  f.camera.rotation.y = Math.PI / 2;
  f.session.nativeCameraChanged(); f.flush();
  const delta = f.sent.find(m => m.type === 'camera.delta');
  assert.ok(delta); assert.ok(Math.abs(delta.r[1] - Math.PI / 2) < 1e-9);
  f.pose(1, [0,0,-2]);
  assert.deepEqual(f.camera.position.toArray(), [0,0,-1]);
  assert.ok(Math.abs(f.camera.rotation.y - Math.PI / 2) < 1e-9);
  f.pose(2, [-1,0,-1], [0,Math.PI/2,0], delta.delta_id);
  assert.ok(f.camera.position.distanceTo(new THREE.Vector3(-1,0,-1)) < 1e-9);
});

test('keyboard movement during a pending correction is preserved and reconciled', t => {
  const f = fixture(t);
  moveCamera(f.camera, [0,0,-1], 3); f.session.nativeCameraChanged(); f.flush();
  const first = f.sent.find(m => m.type === 'camera.delta');
  assert.deepEqual(first.t, [0,0,-3]);
  moveCamera(f.camera, [0,0,-1], 2); f.session.nativeCameraChanged(); f.flush();
  f.pose(0, [0,0,0], [0,.4,0]);
  assert.deepEqual(f.camera.position.toArray(), [0,0,-5]);
  f.pose(1, [0,0,-3], [0,0,0], first.delta_id);
  const next = f.sent.filter(m => m.type === 'camera.delta').at(-1);
  assert.notEqual(next.delta_id, first.delta_id);
  assert.deepEqual(next.t, [0,0,-2]);
  f.pose(2, [0,0,-5], [0,0,0], next.delta_id);
  assert.deepEqual(f.camera.position.toArray(), [0,0,-5]);
  assert.equal(f.sent.some(m => m.type === 'motion_cancel'), false);
});

test('manual movement follows camera orientation and normalizes diagonal speed', () => {
  const camera = new THREE.PerspectiveCamera();
  camera.rotation.y = Math.PI / 2;
  moveCamera(camera, [0, 0, -1], 2);
  assert.ok(camera.position.distanceTo(new THREE.Vector3(-2, 0, 0)) < 1e-9);
  camera.position.set(0, 0, 0);
  moveCamera(camera, [1, 1, -1], 2);
  assert.ok(Math.abs(camera.position.length() - 2) < 1e-9);
});

test('pitched views keep keyboard travel horizontal and height movement vertical', () => {
  for (const pitch of [-Math.PI / 2, -.8, .8, Math.PI / 2]) {
    const camera = new THREE.PerspectiveCamera();
    camera.rotation.set(pitch, .7, 0, 'YXZ');
    moveCamera(camera, [0, 0, -1], 2);
    assert.ok(Math.abs(camera.position.y) < 1e-9);
    assert.ok(Math.abs(camera.position.length() - 2) < 1e-9);
    const before = camera.position.clone();
    moveCamera(camera, [0, 1, 0], 3);
    assert.ok(camera.position.clone().sub(before).distanceTo(new THREE.Vector3(0, 3, 0)) < 1e-9);
  }
});
