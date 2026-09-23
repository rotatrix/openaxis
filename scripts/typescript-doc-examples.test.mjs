import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { NavigationDiagnostics, UNAVAILABLE } from '../ts/sdk/dist/index.js';

// Execute the same TypeScript module imported by the documentation pages.
const source = readFileSync(new URL('../examples/typescript_demo_3d_app/integration.ts', import.meta.url), 'utf8');
const sdk = new URL('../ts/sdk/dist/index.js', import.meta.url).href;
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace('"@openaxis/sdk"', JSON.stringify(sdk)).replace('"../demos/lib/navigation-diagnostic-overlay.js"', JSON.stringify(new URL('../examples/demos/lib/navigation-diagnostic-overlay.js', import.meta.url).href));
const { MyQueryCapture, MyNavigationAdapter, MyObjectAdapter } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

function host() {
  return {
    alive: true,
    camera: { t: [0, 0, 5], r: [0, 0, 0], fov: 1 },
    readCamera() { return this.camera; },
    writeCamera(pose) { this.camera = { ...pose, t: [pose.t[0], Math.max(0, pose.t[1]), pose.t[2]] }; return true; },
    viewport: () => ({ width: 800, height: 400, cursor: [-1, 40] }),
    bounds: selected => selected ? undefined : { min: [-1, -1, -1], max: [1, 1, 1] },
    picks: [],
    pick(pixel, selected) { this.picks.push({ pixel, selected }); return { hit: selected ? undefined : {point:[0,0,0],bounds:this.bounds(false)}, ray:[[0,0,5],[0,0,0]] }; },
    showPivot(point) { this.pivot = point; },
    edit: { target: {}, initialPose: { t: [0, 0, 0], r: [0, 0, 0] } },
    readObject(edit) { return edit.initialPose; },
    objectBounds() { return this.bounds(false); },
    writeObject(edit, pose) { edit.initialPose = structuredClone(pose); return true; },
  };
}

test('cursor misses preserve independent center picks and selection filtering', () => {
  const app = host();
  const query = new MyQueryCapture(app, new NavigationDiagnostics(), undefined);
  assert.equal(query.resolve('viewport.cursor'), UNAVAILABLE);
  assert.equal(query.resolve('pick.cursor'), UNAVAILABLE);
  assert.equal(app.picks.length, 0);
  assert.deepEqual(query.resolve('pick.viewport_center'), { point: [0, 0, 0], bounds: app.bounds(false) });
  assert.equal(query.resolve('pick.viewport_center.selection'), UNAVAILABLE);
  assert.deepEqual(app.picks, [
    { pixel: [400, 200], selected: false }, { pixel: [400, 200], selected: true },
  ]);
  assert.equal(query.resolve('selection.bounds'), UNAVAILABLE);
  assert.equal(query.resolve('unsupported'), UNAVAILABLE);
});

test('query camera snapshots are detached and zero-sized viewports are unavailable', () => {
  const app = host();
  const query = new MyQueryCapture(app, new NavigationDiagnostics(), undefined);
  app.camera.t[0] = 10;
  const pose = query.resolve('camera.pose');
  assert.equal(pose.t[0], 0);
  pose.t[0] = 20;
  assert.equal(query.initialObservation().t[0], 0);
  app.viewport = () => ({ width: 0, height: 0 });
  const empty = new MyQueryCapture(app, new NavigationDiagnostics(), undefined);
  assert.equal(empty.resolve('viewport.aspect'), UNAVAILABLE);
  assert.equal(empty.resolve('pick.viewport_center'), UNAVAILABLE);
});

test('camera readback reports native constraints and marker cleanup', () => {
  const app = host();
  const adapter = new MyNavigationAdapter(app, new NavigationDiagnostics(), () => undefined);
  const result = adapter.applyPose(app, { t: [2, -3, 4], r: [0, 0, 0], fov: 1 });
  assert.equal(result.success, true);
  assert.deepEqual(result.realizedPose.t, [2, 0, 4]);
  adapter.showPivot(app, [1, 2, 3]);
  adapter.showPivot(app, undefined);
  assert.equal(app.pivot, undefined);
  app.alive = false;
  assert.equal(adapter.isCurrent(app), false);
  assert.equal(adapter.captureContext(), undefined);
});

test('a second edit of the same target invalidates the original binding', () => {
  const app = host();
  const adapter = new MyObjectAdapter(app);
  const old = adapter.captureContext();
  assert.equal(adapter.isCurrent(old), true);
  const query = adapter.beginQuery(old);
  app.edit = { ...old };
  assert.equal(adapter.isCurrent(old), false);
  assert.equal(adapter.isCurrent(app.edit), true);
  old.initialPose.t[0] = 9;
  assert.equal(query.initialObservation().t[0], 0);
  assert.equal(query.resolve('camera.pose'), UNAVAILABLE);
});
