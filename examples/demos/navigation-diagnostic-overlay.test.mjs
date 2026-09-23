import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { DIAGNOSTIC_COLORS } from '../../ts/sdk/dist/index.js';
import { NavigationDiagnosticOverlay, projectSegment } from './lib/navigation-diagnostic-overlay.js';

function setup() {
  const calls = [];
  const ctx = new Proxy({}, { get: (target, key) => target[key] ?? ((...args) => calls.push([key, ...args])),
    set(target, key, value) { target[key] = value; calls.push([key, value]); return true; } });
  const document = { body: { appendChild() {} }, createElement: () => ({ style: {}, setAttribute() {},
    getContext: () => ctx, remove() { this.removed = true; } }) };
  const rect = { left: 10, top: 20, width: 800, height: 400 };
  const output = { replaceChildren(...rows) { this.rows = rows; } };
  const overlay = new NavigationDiagnosticOverlay({ getBoundingClientRect: () => rect }, output, DIAGNOSTIC_COLORS, document);
  const camera = new THREE.PerspectiveCamera(60, 2, .1, 100);
  camera.position.z = 10;
  const context = {};
  const frame = { context, revision: 1, lines: [{ text: 'Unavailable is not skipped', tone: 'missing' }],
    segments: [{ start: [-1, 0, 0], end: [1, 0, 0], tone: 'model', width: 3, opacity: .35 }],
    markers: [{ point: [0, 0], tone: 'cursor', label: 'pick.cursor\npick.cursor.selection' }] };
  let reads = 0;
  const diagnostics = { enabled: true, revision: 1, presentation() { reads++; return { ...frame }; } };
  const draw = (dpr = 1, now = 0) => overlay.draw(diagnostics, camera, value => value === context, dpr, now);
  return { overlay, camera, context, frame, diagnostics, draw, calls, output, rect, reads: () => reads };
}

test('renders SDK tones, exact widths and coincident multiline marker labels in logical pixels', () => {
  const s = setup(); s.draw(2);
  assert.equal(s.overlay.canvas.width, 1600); assert.equal(s.overlay.canvas.height, 800);
  assert.equal(s.overlay.canvas.style.left, '10px');
  assert.equal(s.overlay.canvas.style.pointerEvents, 'none');
  assert.equal(s.output.rows[0].textContent, s.frame.lines[0].text);
  assert.equal(s.output.rows[0].style.color, `rgb(${DIAGNOSTIC_COLORS.missing})`);
  assert.ok(s.calls.some(c => c[0] === 'strokeStyle' && c[1] === `rgb(${DIAGNOSTIC_COLORS.model})`));
  assert.ok(s.calls.some(c => c[0] === 'lineWidth' && c[1] === 3));
  assert.deepEqual(s.calls.filter(c => c[0] === 'globalAlpha'), [
    ['globalAlpha', .35], ['globalAlpha', .65], ['globalAlpha', 1],
  ]);
  assert.ok(s.calls.some(c => JSON.stringify(c) === JSON.stringify(['moveTo', 391, 200])));
  assert.deepEqual(s.calls.filter(c => c[0] === 'fillText'), [
    ['fillText', 'pick.cursor', 412, 192], ['fillText', 'pick.cursor.selection', 412, 207],
  ]);
  s.draw(1); assert.equal(s.overlay.canvas.width, 800);
  assert.equal(s.reads(), 1, 'DPI changes do not collect more evidence');
});

test('reprojects retained world evidence during native camera motion and resize without new queries', () => {
  const s = setup(); s.draw();
  const before = s.calls.find(c => c[0] === 'moveTo'); s.calls.length = 0;
  s.camera.position.x = 2; s.draw();
  assert.notDeepEqual(s.calls.find(c => c[0] === 'moveTo'), before);
  s.calls.length = 0; s.rect.width = 400; s.rect.height = 800;
  s.camera.aspect = .5; s.camera.updateProjectionMatrix(); s.draw(1.5);
  assert.equal(s.overlay.canvas.width, 600); assert.equal(s.overlay.canvas.height, 1200);
  assert.ok(s.calls.some(c => JSON.stringify(c) === JSON.stringify(['moveTo', 191, 400])));
  assert.equal(s.reads(), 1);
});

test('reference-app diagnostic pixels are not converted from NDC or scaled twice', () => {
  const s = setup(); s.overlay.screenCoordinates = 'pixels';
  s.frame.markers[0].point = [120, 90]; s.draw(2);
  assert.ok(s.calls.some(c => JSON.stringify(c) === JSON.stringify(['moveTo', 111, 90])));
  s.calls.length = 0; s.rect.width = 400; s.rect.height = 800; s.draw(1);
  assert.ok(s.calls.some(c => JSON.stringify(c) === JSON.stringify(['moveTo', 111, 90])));
});

test('clips segments at all frustum planes in perspective and orthographic cameras', () => {
  for (const camera of [new THREE.PerspectiveCamera(60, 2, .1, 100), new THREE.OrthographicCamera(-2, 2, 1, -1, .1, 100)]) {
    camera.updateMatrixWorld(true);
    const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    assert.equal(projectSegment([0, 0, 1], [1, 0, 2], matrix, 800, 400), undefined);
    assert.equal(projectSegment([0, 0, -101], [0, 1, -102], matrix, 800, 400), undefined);
    for (const ends of [[[0, 0, 1], [1, 0, -5]], [[-100, 0, -5], [100, 0, -5]]]) {
      const points = projectSegment(...ends, matrix, 800, 400);
      assert.ok(points); assert.ok(points.flat().every(Number.isFinite));
      for (const [x, y] of points) { assert.ok(x >= -1e-8 && x <= 800 + 1e-8); assert.ok(y >= -1e-8 && y <= 400 + 1e-8); }
    }
  }
});

test('expiry refreshes text independently of revision; invalidation, disable and disposal clear graphics', () => {
  const s = setup(); s.frame.expiresAt = 1; s.draw();
  s.frame.lines = []; s.frame.expiresAt = undefined; s.draw(1, 2);
  assert.equal(s.reads(), 2); assert.match(s.output.rows[0].textContent, /Start a navigation gesture/);
  s.overlay.draw(s.diagnostics, s.camera, () => false);
  assert.equal(s.overlay.canvas.hidden, true); assert.deepEqual(s.output.rows, []);
  s.draw(); assert.equal(s.overlay.canvas.hidden, false);
  s.diagnostics.enabled = false; s.draw();
  assert.equal(s.overlay.canvas.hidden, true); assert.deepEqual(s.output.rows, []);
  s.overlay.dispose(); assert.equal(s.overlay.canvas.removed, true);
});

test('explicit display state hides stale canvas pixels despite host canvas display rules', () => {
  const s = setup();
  assert.equal(s.overlay.canvas.style.display, 'none');
  s.draw();
  assert.equal(s.overlay.canvas.style.display, 'block');
  assert.ok(s.calls.some(call => call[0] === 'stroke'));
  s.diagnostics.enabled = false;
  s.draw();
  assert.equal(s.overlay.canvas.style.display, 'none');
  assert.deepEqual(s.output.rows, []);
  s.diagnostics.enabled = true;
  s.draw();
  assert.equal(s.overlay.canvas.style.display, 'block');
  s.rect.width = 0;
  s.draw();
  assert.equal(s.overlay.canvas.style.display, 'none');
});
