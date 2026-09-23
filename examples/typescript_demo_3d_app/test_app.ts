import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as THREE from "three";
import { NavigationQuery, OpenAxisClient, UNAVAILABLE } from "@openaxis/sdk";
import { MyApplication, wheelSteps, type SceneData } from "./application.js";
import {
  MyOpenAxisIntegration,
  MyQueryCapture,
  MyObjectAdapter,
} from "./integration.js";
import boxes from "../demo_3d_scene/test-boxes.json";
import scene from "../demo_3d_scene/scene.json";
import probes from "../demo_3d_scene/probes.json";
import { CanvasView, CanvasNavigationAdapter } from '../demos/lib/viewspace-2d.js';

test('2D canvas zoom preserves cursor anchor, fractional input and reverses at limits', () => {
  const a = new CanvasView(), b = new CanvasView();
  for (const view of [a, b]) { view.width = 900; view.height = 600; view.pan(40, -25); }
  const anchor = a.world(720, 150);
  for (let i = 0; i < 8; i++) a.zoom(720, 150, -12.5);
  b.zoom(720, 150, -100);
  a.world(720, 150).forEach((v, i) => near(v, anchor[i]));
  near(a.pose.ortho_extent!, b.pose.ortho_extent!);
  a.zoom(720, 150, -1e5);
  near(a.pose.ortho_extent!, CanvasView.minExtent);
  a.zoom(720, 150, 10);
  assert.ok(a.pose.ortho_extent! > CanvasView.minExtent);
  a.world(720, 150).forEach((v, i) => near(v, anchor[i]));
});

test('2D server zoom overshoot preserves off-center anchor at both limits and reverses immediately', () => {
  for (const limit of [CanvasView.minExtent, CanvasView.maxExtent]) {
    const view = new CanvasView(); view.width = 900; view.height = 600;
    view.pose = { t: [10, 20, 10], r: [0, 0, 0], ortho_extent: limit };
    const adapter = new CanvasNavigationAdapter(view);
    const anchor = [...view.world(720, 150), 10] as [number, number, number];
    const initial = view.read();
    const overshoot = limit === CanvasView.minExtent ? .8 : 1.2;
    for (let i = 0; i < 20; i++) {
      const current = view.read();
      const desired = { ...current, t: [anchor[0] + (current.t[0] - anchor[0]) * overshoot,
        anchor[1] + (current.t[1] - anchor[1]) * overshoot, 10] as [number, number, number],
        ortho_extent: current.ortho_extent! * overshoot };
      const result = adapter.applyPose(view, desired, undefined, anchor);
      assert.ok(result.success);
      near(result.realizedPose!.ortho_extent!, limit);
      view.pose.t.forEach((v, j) => near(v, initial.t[j]));
    }
    const reverse = 1 / overshoot;
    adapter.applyPose(view, { ...view.read(), t: [anchor[0] + (view.pose.t[0] - anchor[0]) * reverse,
      anchor[1] + (view.pose.t[1] - anchor[1]) * reverse, 10], ortho_extent: limit * reverse }, undefined, anchor);
    assert.notEqual(view.pose.ortho_extent, limit);
    view.world(720, 150).forEach((v, j) => near(v, anchor[j]));
  }
});

test('2D adapter snapshots projection and cursor, reports realized constraints, retires context', () => {
  const view = new CanvasView(); view.width = 900; view.height = 600;
  view.cursor = { x: .5, y: -.25 };
  const adapter = new CanvasNavigationAdapter(view), capture = adapter.beginQuery();
  view.pan(100, 0); view.width = 600; view.cursor.x = -.5;
  assert.equal(capture.resolve('viewport.aspect'), 1.5);
  assert.deepEqual(capture.resolve('viewport.cursor'), { x: .5, y: -.25 });
  assert.deepEqual((capture.resolve('camera.pose') as any).t, [0, 0, 10]);
  assert.equal(capture.resolve('pick.cursor'), UNAVAILABLE);
  const result = adapter.applyPose(view, { t: [20, 30, 10], r: [.1, 0, .2], ortho_extent: 90000 });
  assert.equal(result.success, true);
  assert.deepEqual(result.realizedPose, { t: [20, 30, 10], r: [0, 0, 0], ortho_extent: CanvasView.maxExtent });
  view.cursor = undefined;
  assert.equal(adapter.beginQuery().resolve('viewport.cursor'), UNAVAILABLE);
  view.alive = false;
  assert.equal(adapter.captureContext(), undefined);
  assert.equal(adapter.applyPose(view, view.read()).success, false);
});

const near = (a: number, b: number, tolerance = 1e-8) =>
  assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const point = (x = 450, y = 300) => new THREE.Vector2(x, y);
function appForTest(data: SceneData = boxes) {
  const app = new MyApplication(data);
  app.resize(900, 600);
  return app;
}

test("seeded scene has identical geometry, transforms, colors and reset state", () => {
  const app = appForTest(scene);
  assert.equal(app.objects.length, 30);
  assert.equal(scene.seed, 123);
  assert.equal(new Set(app.objects.map((o) => o.name.split(" ")[0])).size, 5);
  app.objects.forEach((object, i) => {
    assert.deepEqual(object.position.toArray(), scene.objects[i].position);
    assert.deepEqual(
      Array.from(object.geometry.index!.array),
      scene.objects[i].indices,
    );
  });
  const original = app.readCamera();
  app.select(app.objects[7]);
  app.beginEdit();
  const pose = app.readObject(app.edit!);
  app.mouseEditObject(30, 10, true);
  app.finishEdit(true);
  app.wheel(2);
  app.resetScene();
  assert.deepEqual(app.readCamera(), original);
  app.select(app.objects[7]);
  app.beginEdit();
  assert.deepEqual(app.readObject(app.edit!), pose);
  app.finishEdit(true);
  assert.equal(app.selected, undefined);
});

test("shared triangle probes and orthographic picks include holes and geometry behind the eye", () => {
  const app = appForTest(scene);
  for (const probe of probes) {
    app.writeCamera(probe.camera as import("@openaxis/sdk").CameraPoseValue);
    app.select(app.objects[probe.index]);
    const hit = app.pick([450, 300], true).hit;
    if (probe.hit === null) assert.equal(hit, undefined);
    else {
      assert.ok(hit);
      hit.point.forEach((value, i) => near(value, probe.hit![i], 1e-6));
    }
  }
  const fixture = appForTest();
  fixture.writeCamera({ t: [0, 0, 0], r: [0, 0, 0], ortho_extent: 8 });
  fixture.select(fixture.objects[0]);
  const hit = fixture.pick([450, 300], true).hit;
  assert.ok(hit);
  near(hit.point[2], 1);
  fixture.setDiagnosticPoints([
    [0, 0, 500],
    [0, 0, -700],
  ]);
  assert.ok(fixture.camera.near < -500 && fixture.camera.far > 700);
});

test("single click selects, double-click enters edit, modifiers do not affect release actions", () => {
  const app = appForTest();
  const p = point();
  app.pointerDown(0, p, 0);
  app.pointerUp(0, p);
  assert.equal(app.selected, app.objects[0]);
  assert.equal(app.edit, undefined);
  app.pointerDown(0, p, 0.2);
  app.pointerUp(0, p);
  assert.ok(app.edit);
  app.mouseEditObject(20, 0, true);
  const accepted = app.readObject(app.edit!);
  app.pointerDown(0, p, 0.8);
  app.pointerUp(0, p);
  assert.equal(app.edit, undefined);
  assert.equal(app.selected, undefined);
  assert.deepEqual(app.objects[0].position.toArray(), accepted.t);
  app.undoEdit();
  assert.deepEqual(app.objects[0].position.toArray(), [0, 0, 0]);
  app.select(app.objects[0]);
  app.beginEdit();
  app.mouseEditObject(20, 10, true);
  app.pointerDown(2, p);
  app.pointerUp(2, p);
  assert.equal(app.edit, undefined);
  assert.equal(app.selected, undefined);
  assert.deepEqual(app.objects[0].position.toArray(), [0, 0, 0]);
});

test("all mouse drag buttons and Shift swap match native controls; drag release keeps edit active", () => {
  for (const edit of [false, true])
    for (const button of [0, 1, 2])
      for (const shift of [false, true]) {
        const app = appForTest();
        if (edit) {
          app.select(app.objects[0]);
          app.beginEdit();
        }
        const initial = edit ? app.readObject(app.edit!) : app.readCamera();
        app.pointerDown(button, point());
        app.pointerMove(point(470, 310), shift);
        app.pointerUp(button, point(470, 310));
        const actual = edit ? app.readObject(app.edit!) : app.readCamera();
        const translate = (button === 0) !== shift;
        if (translate) {
          assert.deepEqual(actual.r, initial.r);
          assert.notDeepEqual(actual.t, initial.t);
        } else assert.notDeepEqual(actual.r, initial.r);
        if (edit) assert.ok(app.edit);
      }
});

test("fractional wheel uses magnitude and deltaMode; latest native pose is incremented", () => {
  near(wheelSteps(12.5, 0, 600), -0.125);
  near(wheelSteps(1, 1, 600), -0.16);
  near(wheelSteps(1, 2, 600), -6);
  for (const ortho of [false, true]) {
    const a = appForTest(),
      b = appForTest();
    if (ortho) {
      a.toggleProjection();
      b.toggleProjection();
    }
    for (let i = 0; i < 8; i++) a.wheel(0.125);
    b.wheel(1);
    a.readCamera().t.forEach((value, i) => near(value, b.readCamera().t[i]));
    if (ortho) near(a.readCamera().ortho_extent!, b.readCamera().ortho_extent!);
  }
  const app = appForTest();
  app.writeCamera({ t: [5, 2, 12], r: [0, 0.2, 0], fov: 1 });
  const before = app.readCamera();
  app.mouseNavigate(0, 0, new THREE.Vector3(), true);
  assert.deepEqual(app.readCamera(), before);
});

test("selection picks through the finite ground; selected-only candidates are filtered first", () => {
  const app = appForTest();
  app.objects[0].position.y = -3;
  app.writeCamera({ t: [0, 3, 10], r: [-0.5, 0, 0], fov: 1 });
  app.camera.updateMatrixWorld(true);
  const ndc = new THREE.Vector3(0, -3, 0).project(app.camera);
  const pixel: [number, number] = [(ndc.x + 1) * 450, (1 - ndc.y) * 300];
  assert.equal(app.pick(pixel).target, app.ground);
  assert.equal(app.pick(pixel, false, true).target, app.objects[0]);
  app.select(app.objects[0]);
  assert.equal(app.pick(pixel, true).target, app.objects[0]);
  assert.ok(app.bounds(false)!.max[0] < 40);
  app.writeCamera({ t: [50, 3, 10], r: [-0.3, 0, 0], fov: 1 });
  assert.equal(app.pick([450, 300]).hit, undefined);
});

// Real SDK session + lifecycle, real app scene. Only browser events and transport
// are fakes; no source extraction or simulated navigation implementation.
class Browser extends EventTarget {
  hidden = false;
  hasFocus() {
    return true;
  }
}
class Transport {
  state = "disconnected";
  url = "ws://test";
  generation = 0;
  listeners = new Set<any>();
  navigation: any;
  messages: any[] = [];
  async connect() {
    this.generation++;
    this.setState("connected");
  }
  async disconnect() {
    this.setState("disconnected");
  }
  setState(state: string) {
    this.state = state;
    this.navigation?.onStateChange(state);
    for (const l of this.listeners) l.onStateChange?.(state);
  }
  addListener(listener: any) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  attachNavigation(listener: any) {
    assert.equal(this.navigation, undefined);
    this.navigation = listener;
    return () => {
      this.navigation = undefined;
    };
  }
  captureNavigationSender() {
    const generation = this.generation;
    return (message: any) => {
      assert.equal(this.state, "connected");
      assert.equal(this.generation, generation);
      this.messages.push(structuredClone(message));
    };
  }
}
async function demo(t: TestContext) {
  const browser = new Browser();
  const oldDocument = globalThis.document,
    oldWindow = globalThis.window;
  Object.assign(globalThis, { document: browser, window: browser });
  // Headless host: no HUD DOM, but all application behavior is real.
  (browser as any).getElementById = () => null;
  const app = appForTest(),
    client = new Transport();
  const integration = new MyOpenAxisIntegration(
    app,
    false,
    "ws://test",
    client as unknown as OpenAxisClient,
  );
  const flush = () => integration.session.drain();
  const settled = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    flush();
  };
  integration.start();
  for (let n = 0; String(integration.connection.state) !== "ready"; n++) {
    assert.ok(n < 100);
    await settled();
  }
  t.after(async () => {
    app.finishEdit(false);
    app.alive = false;
    await integration.stop();
    app.dispose();
    Object.assign(globalThis, { document: oldDocument, window: oldWindow });
  });
  let id = 0;
  function query(values: string[], gestureId?: number, first?: string[]) {
    let result: any, error: any;
    const params: any = { values };
    if (gestureId !== undefined) params.gesture_id = gestureId;
    if (first) params.first = first;
    client.navigation.onNavigationQuery(
      new NavigationQuery(
        { type: "request", id: ++id, method: "navigation.query", params },
        (value) => {
          result = value;
        },
        (code) => {
          error = code;
        },
      ),
    );
    flush();
    return { result, error };
  }
  const send = (name: string, value: any) => {
    client.navigation[name](value);
    flush();
  };
  return { app, client, integration, query, send, flush, settled, browser };
}

test("SDK queries preserve camera snapshots, unavailable cursor and pixel diagnostic evidence", async (t) => {
  const d = await demo(t),
    { app, integration } = d;
  const capture = new MyQueryCapture(app);
  app.camera.position.x = 2;
  assert.equal((capture.resolve("camera.pose") as any).t[0], 0);
  app.camera.position.x = 0;
  app.select(app.objects[0]);
  app.pointerMove(point());
  integration.diagnostics.setEnabled(true);
  const values = d.query([
    "viewport.cursor",
    "pick.cursor",
    "pick.cursor.selection",
    "model.bounds",
    "navigation.translation_scale",
  ]).result.values;
  assert.deepEqual(values["viewport.cursor"], [0, 0]);
  assert.deepEqual(values["pick.cursor"].point, [0, 0, 1]);
  assert.equal(values["navigation.translation_scale"], 4);
  const frame = integration.diagnostics.presentation();
  assert.deepEqual(frame.markers[0].point, [450, 300]);
  assert.equal(frame.markers.length, 1);
  assert.equal(frame.markers[0].label, "pick.cursor\npick.cursor.selection");
  assert.equal(frame.segments.filter((s) => s.tone === "ray").length, 0);
  assert.ok(frame.segments.some((s) => s.tone === "model"));
  app.resize(900, 600);
  assert.equal(
    d.query(["pick.cursor"]).result.values["pick.cursor"],
    undefined,
  );
  assert.equal(
    new MyQueryCapture(app).resolve(
      "unknown",
    ),
    UNAVAILABLE,
  );
});

test("selection tags stay camera-only; edits and independent SDK pose streams own fresh contexts", async (t) => {
  const d = await demo(t),
    { app, client, integration } = d;
  app.select(app.objects[0]);
  assert.deepEqual(integration.metadata().tags, ["demo-3d-services"]);
  app.beginEdit();
  await d.settled();
  assert.ok(integration.metadata().tags!.includes("interaction.object.rotate"));
  const old = app.edit!,
    adapter = new MyObjectAdapter(app);
  d.send("onMotionStart", 7);
  d.query(["camera.pose", "object.pose"], 7);
  d.send("onCameraPose", {
    gesture_id: 7,
    seq: 10,
    t: [0, 0, 10],
    r: [0, 0, 0],
    fov: 1,
  });
  d.send("onObjectPose", {
    gesture_id: 7,
    seq: 1,
    t: [1, 2, 3],
    r: [0, 0.5, 0],
  });
  assert.deepEqual(app.readObject(app.edit!).t, [1, 2, 3]);
  d.send("onCameraPivot", { gesture_id: 7, point: [0, 0, 0] });
  d.send("onObjectPivot", { gesture_id: 7, point: [1, 2, 3] });
  const pivots = (app as any).pivots;
  assert.ok(pivots.every((p: any) => p.visible));
  app.render();
  const size = pivots[0].scale.x;
  pivots[0].position.z = -10;
  app.render();
  near(pivots[0].scale.x, size * 2);
  app.finishEdit(false);
  app.select(app.objects[0]);
  app.beginEdit();
  d.flush();
  assert.equal(adapter.isCurrent(old), false);
  assert.ok(
    client.messages.some(
      (m) => m.type === "motion_cancel" && m.gesture_id === 7,
    ),
  );
  d.send("onObjectPose", {
    gesture_id: 7,
    seq: 2,
    t: [99, 99, 99],
    r: [0, 0, 0],
  });
  assert.deepEqual(app.readObject(app.edit!).t, [0, 0, 0]);
  assert.ok(pivots.every((p: any) => !p.visible));
});

test("native changes preserve independent SDK acknowledgement barriers and projection rebasing", async (t) => {
  const d = await demo(t),
    { app, client } = d;
  app.select(app.objects[0]);
  app.beginEdit();
  d.send("onMotionStart", 10);
  d.query(["camera.pose", "object.pose"], 10);
  app.mouseNavigate(20, 0, new THREE.Vector3(), true);
  app.mouseEditObject(30, 0, true);
  d.flush();
  const cameraDelta = client.messages.find((m) => m.type === "camera.delta"),
    objectDelta = client.messages.find((m) => m.type === "object.delta");
  assert.ok(cameraDelta);
  assert.ok(objectDelta);
  const before = app.readCamera(),
    objectBefore = app.readObject(app.edit!);
  d.send("onCameraPose", {
    gesture_id: 10,
    seq: 1,
    t: [5, 6, 7],
    r: [0, 0, 0],
    fov: 1,
  });
  d.send("onObjectPose", {
    gesture_id: 10,
    seq: 1,
    t: [8, 9, 10],
    r: [0, 0, 0],
  });
  assert.deepEqual(app.readCamera(), before);
  assert.deepEqual(app.readObject(app.edit!), objectBefore);
  d.send("onCameraPose", {
    gesture_id: 10,
    seq: 2,
    applied_delta_id: cameraDelta.delta_id,
    t: [5, 6, 7],
    r: [0, 0, 0],
    fov: 1,
  });
  d.send("onObjectPose", {
    gesture_id: 10,
    seq: 2,
    applied_delta_id: objectDelta.delta_id,
    t: [8, 9, 10],
    r: [0, 0, 0],
  });
  assert.deepEqual(app.readCamera().t, [5, 6, 7]);
  assert.deepEqual(app.readObject(app.edit!).t, [8, 9, 10]);
  app.toggleProjection();
  d.flush();
  assert.ok(
    client.messages.some((m) => m.type === "camera.pose" && m.ortho_extent),
  );
});

test("unscoped queries cannot bind output, final queued poses drain without accepting edits", async (t) => {
  const d = await demo(t),
    { app, client } = d;
  d.query(["camera.pose"]);
  d.send("onMotionStart", 1);
  d.send("onCameraPose", {
    gesture_id: 1,
    seq: 1,
    t: [99, 99, 99],
    r: [0, 0, 0],
    fov: 1,
  });
  assert.deepEqual(app.readCamera().t, [0, 0, 10]);
  app.select(app.objects[0]);
  app.beginEdit();
  d.send("onMotionStart", 2);
  d.query(["object.pose"], 2);
  client.navigation.onObjectPose({
    gesture_id: 2,
    seq: 1,
    t: [2, 3, 4],
    r: [0, 0, 0],
  });
  client.navigation.onMotionEnd(2);
  d.flush();
  assert.deepEqual(app.readObject(app.edit!).t, [2, 3, 4]);
  assert.ok(app.edit);
  assert.equal(d.integration.session.isActive, false);
});

test("diagnostics record rejection and misses, clear on disconnect without altering picking", async (t) => {
  const d = await demo(t),
    { integration } = d;
  integration.diagnostics.setEnabled(true);
  d.query(["pick.cursor", "pick.viewport_center.selection"]);
  assert.equal(integration.diagnostics.presentation().markers.length, 0);
  // Selection tests that run and miss still retain their sample marker.
  d.app.select(d.app.objects[0]);
  d.app.objects[0].position.x = 100;
  d.query(["pick.viewport_center.selection", "pick.viewport_center"]);
  assert.equal(integration.diagnostics.presentation().markers.length, 1);
  assert.equal(integration.diagnostics.presentation().markers[0].label,
    "pick.viewport_center.selection\npick.viewport_center");
  d.send("onMotionStart", 5);
  d.query(["camera.pose"], 5);
  const pose = { gesture_id: 5, seq: 1, t: [0, 0, 10], r: [0, 0, 0], fov: 1 };
  d.send("onCameraPose", pose);
  d.send("onCameraPose", pose);
  assert.match(
    integration.diagnostics.history.map((row) => row.message).join(" "),
    /output_rejected/,
  );
  d.client.setState("disconnected");
  await d.settled();
  assert.equal(integration.diagnostics.presentation().segments.length, 0);
});

test("offline edits replay metadata; BFCache reconnect and final shutdown drain cleanup", async (t) => {
  const d = await demo(t),
    { app, client, integration, browser } = d;
  browser.dispatchEvent(new Event("pagehide"));
  await d.settled();
  assert.equal(integration.connection.state, "stopped");
  const count = client.messages.length;
  app.select(app.objects[0]);
  app.beginEdit();
  await d.settled();
  assert.equal(client.messages.length, count);
  browser.dispatchEvent(new Event("pageshow"));
  for (let n = 0; String(integration.connection.state) !== "ready"; n++) {
    assert.ok(n < 100);
    await d.settled();
  }
  assert.ok(
    client.messages
      .filter((m) => m.type === "tags")
      .at(-1)
      .tags.includes("interaction.object.translate"),
  );
  app.mouseEditObject(20, 0, true);
  app.finishEdit(false);
  app.alive = false;
  await integration.stop();
  assert.deepEqual(app.objects[0].position.toArray(), [0, 0, 0]);
  assert.equal(client.navigation, undefined);
  assert.equal(integration.connection.state, "stopped");
});

test("F toggles the navigation profile while preserving object interaction tags", async (t) => {
  const { app, integration } = await demo(t);
  assert.deepEqual(integration.metadata().tags, ["demo-3d-services"]);
  app.select(app.objects[0]);
  app.beginEdit();
  app.key("f");
  assert.equal(app.freeCamera, true);
  assert.deepEqual(integration.metadata().tags, [
    "demo-3d-services",
    "navigation.hint.free_camera",
    "interaction.object.rotate",
    "interaction.object.translate",
  ]);
  app.key("F");
  assert.equal(app.freeCamera, false);
  assert.deepEqual(integration.metadata().tags, [
    "demo-3d-services",
    "interaction.object.rotate",
    "interaction.object.translate",
  ]);
});
