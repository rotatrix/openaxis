import { proof, trust } from "./authorization-helper.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { encode, decode } from "@msgpack/msgpack";
import { OpenAxisClient, NavigationSession, ConnectionState, NavigationDiagnostics, compareObjectPoses, comparePoses, configureLogging } from "../dist/index.js";

class Socket {
  static latest;
  readyState = 0; sent = [];
  constructor() { Socket.latest = this }
  send(data) { const m=decode(data); this.sent.push(m); if(m.type==="request"&&m.method==="q")queueMicrotask(()=>this.receive({type:"response",id:m.id,result:proof(m.params.c)})); }
  close() { this.readyState = 3; this.onclose?.() }
  receive(value) { this.onmessage?.({ data: encode(value) }) }
}
globalThis.WebSocket = Socket;
test("object comparison ignores projection and retains rigid-motion tolerances", () => {
  const a = { t: [0,0,0], r: [0,0,0], fov: 1, ortho_extent: 1 };
  const b = { ...a, fov: 2, ortho_extent: 3 };
  assert.equal(comparePoses(a,b).discontinuity,true);
  assert.deepEqual(compareObjectPoses(a,b), { t: [0,0,0], r: [0,0,0], scale: undefined, discontinuity: false, changed: false });
  assert.equal(compareObjectPoses(a,{ ...b, t: [0.01,0,0] }).changed,true);
  assert.equal(compareObjectPoses(a,{ ...b, t: [0.01,0,0] },{ absolute: 0.1 }).changed,false);
  assert.equal(compareObjectPoses(a,{ ...b, r: [0,0,0.2] }).changed,true);
});
const pose = x => ({ t: [x,0,0], r: [0,0,0], fov: 1 });
const objectPose = x => ({ t: [x,0,0], r: [0,0,0] });
class Adapter {
  context = {}; current = pose(10); writes = []; pivots = [];
  captureContext() { return this.context }
  isCurrent(context) { return context === this.context }
  beginQuery() { return { resolve: name => name.endsWith(".pose") ? this.current : undefined, initialObservation: () => this.current } }
  applyPose(context, requested) { this.writes.push(requested); this.current = this.limit === undefined ? requested : { ...requested, t: [Math.min(requested.t[0], this.limit),0,0] }; this.onWrite?.(); return { success: true, realizedPose: this.unknown ? undefined : this.current } }
  showPivot(context, point) { this.pivots.push(point) }
}
class Scheduler {
  callbacks = []; timers = []; now = 0;
  post(callback) { this.callbacks.push(callback) }
  postAt(deadline, callback) { this.timers.push([deadline, callback]) }
  run() { for (let i=0; this.callbacks.length; i++) { assert.ok(i < 100, "busy loop"); this.callbacks.shift()() } }
}
async function setup(t, options = {}, initialize = true) {
  const client = trust(new OpenAxisClient({ clientName: "test" }));
  const camera = new Adapter(), object = new Adapter(), scheduler = new Scheduler();
  object.current = objectPose(10);
  const session = new NavigationSession(client, camera, { scheduler, clock: () => scheduler.now,
    observation: () => { const callback = camera.onRead; camera.onRead = undefined; callback?.(); return camera.unknown ? undefined : camera.current }, objectAdapter: object,
    objectObservation: options.noObjectObservation ? undefined : () => object.unknown ? undefined : object.current,
    ...options });
  const connected = client.connect();
  const socket = Socket.latest;
  socket.readyState = 1; socket.onopen();
  socket.receive({ type: "hello_ack", proto: "openaxis/1.0", server_name: "test" });
  await connected;
  t.after(async () => { session.close(); scheduler.run(); await client.disconnect() });
  if (initialize) {
    socket.receive({ type: "motion_start", gesture_id: 7 });
    socket.receive({ type: "request", id: 1, method: "navigation.query", params: { gesture_id: 7, values: ["camera.pose", "object.pose"] } });
    scheduler.run();
  }
  const output = (kind, x, seq, ack) => { socket.receive({ type: `${kind}.pose`, gesture_id: 7, seq, ...(ack === undefined ? {} : { applied_delta_id: ack }), ...(kind === "camera" ? pose(x) : objectPose(x)) }); scheduler.run() };
  return { client, camera, object, scheduler, session, socket, output };
}

const coordinatorFixture = JSON.parse(readFileSync(new URL("../../../fixtures/openaxis-1.0/coordinator.json", import.meta.url), "utf8"));
coordinatorFixture.scenarios.push(...JSON.parse(readFileSync(new URL("../../../fixtures/openaxis-1.0/performance.json", import.meta.url), "utf8")).scenarios);
function subset(actual, expected) {
  if (typeof actual === "string" && Array.isArray(expected)) { expected.forEach(part => assert.ok(actual.includes(part), `${actual} missing ${part}`)) }
  else if (Array.isArray(expected)) { assert.equal(actual.length, expected.length); expected.forEach((v, i) => subset(actual[i], v)) }
  else if (expected && typeof expected === "object") for (const [k,v] of Object.entries(expected)) subset(actual[k], v);
  else if (typeof expected === "number") assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
  else assert.equal(actual, expected);
}
assert.equal(coordinatorFixture.version, 1);
for (const scenario of coordinatorFixture.scenarios) {
  test(`shared coordinator: ${scenario.name}`, async t => {
    const reports = [];
    const logger = configureLogging("performance-tests", { debug: true, sinks: [(_, m) => { if (m.startsWith("navigation.performance ")) reports.push(m) }] });
    t.after(() => logger.close());
    const { camera, object, scheduler, session, socket } = await setup(t, {}, false);
    const dispatch = event => {
      const gesture_id = event.gesture ?? 7;
      switch (event.op) {
        case "orbit": socket.receive({ type: "navigation.state", gesture_id, camera: { mode: "orbit" } }); break;
        case "pivot": socket.receive({ type: "camera.pivot", gesture_id, point: [0,0,0] }); break;
        case "write_error": throw new Error("host write failed");
        case "end": socket.receive({ type: "motion_end", gesture_id }); break;
        case "start": socket.receive({ type: "motion_start", gesture_id }); break;
        case "query": socket.receive({ type: "request", id: gesture_id, method: "navigation.query", params: { gesture_id, values: event.values ?? ["camera.pose"] } }); break;
        case "object_pose": socket.receive({ type: "object.pose", gesture_id, seq: event.seq, ...objectPose(event.x) }); break;
        case "pose": socket.receive({ type: "camera.pose", gesture_id, seq: event.seq, ...pose(event.x) }); break;
        case "context_changed": camera.context = {}; session.contextChanged(); break;
        case "close": session.close(); break;
        case "native_camera": camera.current = pose(event.x); session.nativeCameraChanged(); break;
        case "advance": {
          assert.ok(event.time >= scheduler.now);
          scheduler.now = event.time;
          const due = scheduler.timers.filter(([deadline]) => deadline <= event.time);
          scheduler.timers = scheduler.timers.filter(([deadline]) => deadline > event.time);
          due.forEach(([, callback]) => callback());
          break;
        }
        case "on_read": camera.onRead = () => event.events.forEach(dispatch); break;
        case "on_write": camera.onWrite = () => { camera.onWrite = undefined; event.events.forEach(dispatch) }; break;
        case "drain": scheduler.run(); break;
        case "expect": {
          const actual = { performance: reports, summaries: reports.length, writes: camera.writes.map(p => p.t[0]), pending: scheduler.callbacks.length,
            cancels: socket.sent.filter(m => m.type === "motion_cancel").length,
            deltas: socket.sent.filter(m => m.type === "camera.delta").length };
          for (const [key, value] of Object.entries(event)) {
            if (key === "op") continue;
            assert.ok(Object.hasOwn(actual, key), `unknown assertion ${key}`);
            if (key === "performance") subset(actual[key], value); else assert.deepEqual(actual[key], value, key);
          }
          break;
        }
        default: throw Error(`Unknown operation ${event.op}`);
      }
    };
    scenario.events.forEach((event, index) => {
      try { dispatch(event) } catch (error) { throw new Error(`step ${index}: ${event.op}`, { cause: error }) }
    });
  });
}

test("active state retires immediately on end, cancellation and close", async t => {
  const { session, scheduler } = await setup(t);
  assert.equal(session.isActive,true);
  session.onMotionEnd(7);
  assert.equal(session.isActive,false);
  scheduler.run();
  session.onMotionStart(8);
  assert.equal(session.isActive,true);
  session.contextChanged();
  assert.equal(session.isActive,false);
  session.onMotionStart(9);
  assert.equal(session.isActive,true);
  session.close();
  assert.equal(session.isActive,false);
});

test("object stream defaults to rigid comparison even when host readback carries projection", async t => {
  const { object, session, scheduler, socket } = await setup(t);
  object.current = { ...object.current, fov: 2 };
  session.nativeObjectChanged();
  scheduler.run();
  assert.equal(socket.sent.filter(m => m.type === "object.delta" || m.type === "object.rebase").length,0);
});

test("session diagnostics reports contexts, failed writes, rejection and cancellation", async t => {
  const events = [];
  const diagnostics = new NavigationDiagnostics({ enabled: true, contextKey: () => "viewport", log() { throw Error("sink") } });
  const { camera, output, socket } = await setup(t, { diagnostics, onEvent: e => events.push(e) });
  assert.equal(diagnostics.presentation().context,"viewport");
  assert.ok(events.some(e => e.event === "fact" && e.values.name === "object.pose"));
  camera.applyPose = () => { throw Error("native write") };
  output("camera",12,1);
  assert.ok(events.some(e => e.event === "camera_write" && !e.values.success));
  assert.ok(events.some(e => e.event === "cancelled" && e.values.reason === "camera_write_failed"));
  assert.ok(diagnostics.presentation().lines.some(l => l.text === "camera write: failed"));
  output("camera",13,2);
  assert.ok(events.some(e => e.event === "output_rejected"));
  assert.equal(socket.sent.filter(m => m.type === "motion_cancel").length,1);
});

test("diagnostic redraw reentrancy cannot authorize a stale write or send correction", async t => {
  const diagnostics = new NavigationDiagnostics({ enabled: true });
  const { camera, session, socket, output } = await setup(t,{ diagnostics });
  camera.current = pose(11);
  diagnostics.onChanged = () => { diagnostics.onChanged = undefined; session.onMotionStart(8) };
  output("camera",12,1);
  assert.equal(camera.writes.length,0);
  assert.equal(socket.sent.filter(m => m.type === "camera.delta").length,0);
});

test("fact exceptions are diagnostic evidence without failing the whole query", async t => {
  const events = [];
  const { camera, socket, scheduler } = await setup(t,{ onEvent: e => events.push(e) });
  camera.beginQuery = () => ({ resolve() { throw Error("cannot read bounds") } });
  socket.receive({ type: "request", id: 2, method: "navigation.query", params: { gesture_id: 7, values: ["model.bounds"] } });
  scheduler.run();
  assert.match(events.find(e => e.event === "fact" && e.values.name === "model.bounds").values.error,/cannot read bounds/);
  assert.deepEqual(socket.sent.find(m => m.type === "response" && m.id === 2).result,{ values: {} });
});

test("camera/object corrections have independent acknowledgements and sequence counters", async t => {
  const { camera, object, output, socket } = await setup(t);
  object.limit = 10;
  output("object", 12, 1);
  output("camera", 11, 1);
  output("object", 13, 2);
  assert.equal(camera.writes.length, 1); assert.equal(object.writes.length, 1);
  assert.deepEqual(socket.sent.find(m => m.type === "object.delta").t, [-2,0,0]);
  output("object", 10, 3, 0);
  output("object", 9, 4, 0);
  assert.equal(object.writes.length, 2);
});
test("object no-observation mode skips initial unchanged output and reports write residual", async t => {
  const { object, output, socket } = await setup(t, { noObjectObservation: true });
  output("object", 10, 1); assert.equal(object.writes.length, 0);
  object.limit = 10; output("object", 12, 2);
  assert.equal(socket.sent.filter(m => m.type === "object.delta").length, 1);
});
test("unknown completed readback retains request reference and later observation corrects residual", async t => {
  const { object, output, session, scheduler, socket } = await setup(t);
  object.unknown = true; output("object", 11, 1);
  object.current = objectPose(99); object.unknown = false;
  session.nativeObjectChanged(); scheduler.run();
  assert.deepEqual(socket.sent.find(m => m.type === "object.delta").t, [88,0,0]);
});

test("no-observer object never substitutes requested reference for actual readback", async t => {
  const { object, output, session, scheduler, socket } = await setup(t, { noObjectObservation: true });
  object.unknown = true; output("object", 11, 1);
  assert.equal(session.object.state.baseline, undefined);
  session.nativeObjectChanged(); scheduler.run();
  assert.equal(session.object.state.baseline, undefined);
  assert.equal(socket.sent.filter(m => m.type === "object.delta").length, 0);
  output("object", 12, 2);
  assert.equal(session.object.state.baseline, undefined);
  assert.equal(object.writes.length, 2);
});

test("camera postwrite unknown recovers projection through normal identified rebase", async t => {
  const { camera, output, session, scheduler, socket } = await setup(t);
  camera.unknown = true; output("camera", 11, 1);
  camera.current = { t: [11,0,0], r: [0,0,0], ortho_extent: 5 }; camera.unknown = false;
  session.nativeCameraChanged(); scheduler.run();
  const corrections = socket.sent.filter(m => m.type === "camera.pose" || m.type === "camera.delta");
  assert.deepEqual(corrections.map(m => m.type), ["camera.pose", "camera.delta"]);
  assert.equal(corrections[0].ortho_extent, 5);
  assert.equal(corrections[1].delta_id, 0);
});
test("invalid object target cancels camera writes and the whole gesture", async t => {
  const { camera, object, output, socket } = await setup(t);
  object.context = {}; output("camera", 11, 1);
  assert.equal(camera.writes.length, 0);
  assert.equal(socket.sent.filter(m => m.type === "motion_cancel").length, 1);
});
test("failed object write cancels both streams", async t => {
  const { object, output, socket } = await setup(t);
  object.applyPose = () => ({ success: false }); output("object", 11, 1);
  output("camera", 11, 1);
  assert.equal(socket.sent.at(-1).reason, "object_write_failed");
});
test("correction timeout needs no further server output", async t => {
  const { object, output, scheduler, socket } = await setup(t);
  object.limit = 10; output("object", 12, 1);
  scheduler.now = 2; scheduler.timers.forEach(([, callback]) => callback()); scheduler.run();
  assert.equal(socket.sent.at(-1).reason, "object_delta_timeout");
});
test("observer reentrancy cannot authorize a stale write", async t => {
  let replace;
  const { object, output, session, socket } = await setup(t, { observer: event => { if (event === "object_correction_applied") replace() } });
  replace = () => session.onMotionStart(8);
  object.limit = 10; output("object", 12, 1);
  output("object", 11, 2, 0);
  assert.equal(object.writes.length, 1);
  assert.equal(socket.sent.filter(m => m.type === "object.delta").length, 1);
});
test("optional pivot display failure does not prevent writes", async t => {
  const { object, socket, output } = await setup(t);
  object.showPivot = () => { throw Error("overlay") };
  socket.receive({ type: "object.pivot", gesture_id: 7, point: [1,2,3] });
  output("object", 11, 1); assert.equal(object.writes.length, 1);
});
test("exclusive ownership leaves buttons available and releases on close", async t => {
  const { client, session, camera, socket } = await setup(t);
  let motion = 0, buttons = 0;
  client.addListener({ onMotionStart() { motion++ }, onButtons() { buttons++ } });
  assert.throws(() => new NavigationSession(client, camera), /already attached/);
  socket.receive({ type: "motion_start", gesture_id: 8 }); socket.receive({ type: "buttons", buttons: 1 });
  assert.equal(motion, 1); assert.equal(buttons, 1);
  session.close(); socket.receive({ type: "motion_start", gesture_id: 9 }); assert.equal(motion, 2);
});
test("query evaluation is deferred and final accepted output flushes on end", async t => {
  const { session, object, socket, scheduler } = await setup(t);
  socket.receive({ type: "object.pose", gesture_id: 7, seq: 1, ...objectPose(11) });
  session.onMotionEnd(7);
  assert.equal(object.writes.length, 0);
  scheduler.run(); assert.equal(object.writes.length, 1);
  assert.equal(session.camera.state.gestureId, undefined);
});
test("captured send cannot use a later connection", async t => {
  const { client } = await setup(t);
  const send = client.captureNavigationSender();
  await client.disconnect();
  const connecting = client.connect();
  const socket = Socket.latest; socket.readyState = 1; socket.onopen();
  socket.receive({ type: "hello_ack", proto: "openaxis/1.0", server_name: "other" }); await connecting;
  assert.throws(() => send({ type: "motion_cancel", gesture_id: 7 }), /retired/);
  assert.equal(socket.sent.filter(m => m.type === "motion_cancel").length, 0);
});
test("query overflow is replied once and unavailable object facts do not block camera", async t => {
  const { socket, scheduler, object, camera, output } = await setup(t, { maxQueries: 1 });
  object.captureContext = () => undefined;
  socket.receive({ type: "motion_start", gesture_id: 7 });
  for (const id of [2,3]) socket.receive({ type: "request", id, method: "navigation.query", params: { gesture_id: 7, values: ["camera.pose", "object.pose"] } });
  scheduler.run(); output("camera", 11, 1);
  assert.equal(camera.writes.length, 1);
  assert.equal(socket.sent.filter(m => m.type === "response" && m.id === 2).length, 1);
  assert.equal(socket.sent.filter(m => m.type === "response" && m.id === 3).length, 1);
});

test("full non-pose queue retains latest camera and object output in reserved slots", async t => {
  const { socket, scheduler, session, camera, object } = await setup(t, { maxWork: 1 });
  socket.receive({ type: "request", id: 2, method: "navigation.query", params: { gesture_id: 7, values: ["camera.pose", "object.pose"] } });
  for (let seq = 1; seq <= 100; seq++) {
    socket.receive({ type: "camera.pose", gesture_id: 7, seq, ...pose(10 + seq) });
    socket.receive({ type: "object.pose", gesture_id: 7, seq, ...objectPose(20 + seq) });
    assert.ok(session.queue.length <= 3, "one non-pose item plus one pose per stream");
  }
  session.onMotionEnd(7);
  scheduler.run();
  assert.deepEqual(camera.writes.map(value => value.t[0]), [110]);
  assert.deepEqual(object.writes.map(value => value.t[0]), [120]);
  assert.equal(socket.sent.filter(value => value.type === "response" && value.id === 2).length, 1);
});

test("superseding pose moves after intervening query rather than replacing in place", async t => {
  const { socket, scheduler, camera } = await setup(t, { maxWork: 1 });
  socket.receive({ type: "camera.pose", gesture_id: 7, seq: 1, ...pose(11) });
  socket.receive({ type: "request", id: 2, method: "navigation.query", params: { gesture_id: 7, values: ["camera.pose"] } });
  socket.receive({ type: "camera.pose", gesture_id: 7, seq: 2, ...pose(12) });
  scheduler.run();
  assert.equal(socket.sent.find(value => value.type === "response" && value.id === 2).result.values["camera.pose"].t[0], 10);
  assert.deepEqual(camera.writes.map(value => value.t[0]), [12]);
});

test("pivot-deferred pose cannot replace a newer pending pose", async t => {
  const { socket, scheduler, camera } = await setup(t);
  socket.receive({ type: "navigation.state", gesture_id: 7, camera: { mode: "orbit" } });
  socket.receive({ type: "camera.pose", gesture_id: 7, seq: 1, ...pose(11) });
  scheduler.run();
  assert.equal(camera.writes.length, 0);
  socket.receive({ type: "camera.pivot", gesture_id: 7, point: [0,0,0] });
  socket.receive({ type: "camera.pose", gesture_id: 7, seq: 2, ...pose(12) });
  scheduler.run();
  assert.deepEqual(camera.writes.map(value => value.t[0]), [12]);
});

test("replacement gesture retires reserved poses even when both slots were full", async t => {
  const { socket, scheduler, camera, object } = await setup(t, { maxWork: 1 });
  socket.receive({ type: "camera.pose", gesture_id: 7, seq: 1, ...pose(11) });
  socket.receive({ type: "object.pose", gesture_id: 7, seq: 1, ...objectPose(11) });
  socket.receive({ type: "motion_start", gesture_id: 8 });
  scheduler.run();
  assert.equal(camera.writes.length, 0);
  assert.equal(object.writes.length, 0);
});
