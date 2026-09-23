import { proof, trust } from "./authorization-helper.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { encode, decode } from "@msgpack/msgpack";
import { AsyncNavigationSession, NavigationSession, NavigationQuery, OpenAxisClient, NavigationDiagnostics, UNAVAILABLE, configureLogging } from "../dist/index.js";

class Socket {
  static latest;
  readyState = 0; sent = [];
  constructor() { Socket.latest = this }
  send(data) { const m=decode(data); this.sent.push(m); if(m.type==="request"&&m.method==="q")queueMicrotask(()=>this.receive({type:"response",id:m.id,result:proof(m.params.c)})); }
  close() { this.readyState = 3; this.onclose?.() }
  receive(value) { this.onmessage?.({ data: encode(value) }) }
}
globalThis.WebSocket = Socket;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve } };
async function until(predicate) {
  for (let i=0;i<100;i++) { if (predicate()) return; await tick() }
  assert.ok(predicate(),"expected async operation to complete");
}
const pose = (x,object = false) => ({ t: [x,0,0], r: [0,0,0], ...(object ? {} : { fov: 1 }) });
class Adapter {
  context = {}; writes = []; pivots = [];
  constructor(object = false) { this.current = pose(10,object) }
  async captureContext() { return this.context }
  async isCurrent(context) { return context === this.context }
  async beginQuery() { return { resolve: async name => name.endsWith(".pose") ? this.current : UNAVAILABLE, initialObservation: async () => this.current } }
  async applyPose(context,requested) {
    this.writes.push(requested);
    await this.onWrite?.();
    this.current = this.limit === undefined ? requested : { ...requested, t: [Math.min(requested.t[0],this.limit),0,0] };
    return { success: true, realizedPose: this.unknown ? undefined : this.current };
  }
  async showPivot(context,point) { this.pivots.push(point) }
}
async function setup(t, options = {}) {
  const client = trust(new OpenAxisClient({ clientName: "async-test" })), camera = new Adapter(), object = new Adapter(true);
  const session = new AsyncNavigationSession(client,camera,{ observation: async () => camera.current,
    objectAdapter: object, objectObservation: async () => object.current, ...options });
  const connected = client.connect(), socket = Socket.latest;
  socket.readyState = 1; socket.onopen();
  socket.receive({ type: "hello_ack", proto: "openaxis/1.0", server_name: "test" });
  await connected;
  t.after(async () => { await session.close(); await client.disconnect() });
  const query = (id = 1,gesture = 7,values = ["camera.pose","object.pose"]) => socket.receive({ type: "request", id, method: "navigation.query", params: { gesture_id: gesture, values } });
  const output = (kind,x,seq,ack,gesture = 7) => socket.receive({ type: `${kind}.pose`, gesture_id: gesture, seq,
    ...(ack === undefined ? {} : { applied_delta_id: ack }), ...pose(x,kind === "object") });
  socket.receive({ type: "motion_start", gesture_id: 7 }); query();
  await until(() => socket.sent.some(m => m.type === "response" && m.id === 1));
  return { client, session, camera, object, socket, query, output };
}

test("async query resolution is sequential, memoized and short circuits first candidates", async () => {
  const q = new NavigationQuery({ type: "request", id: 1, method: "navigation.query", params: { values: ["a","a"], first: ["b","a","c"] } },()=>{},()=>{});
  const calls = [];
  const result = await q.evaluateAsync(async name => { calls.push(name); await tick(); return name === "b" ? UNAVAILABLE : 3 });
  assert.deepEqual(calls,["a","b"]); assert.deepEqual(result,{ values: { a: 3 }, first: { name: "a", value: 3 } });
});

test("awaited camera and object writes have independent corrections and acknowledgements", async t => {
  const events = [], diagnostics = new NavigationDiagnostics({ enabled: true });
  const { camera, object, socket, output } = await setup(t,{ diagnostics, onEvent: e => events.push(e) });
  object.limit = 10; output("object",12,1); output("camera",11,1);
  await until(() => camera.writes.length === 1 && socket.sent.some(m => m.type === "object.delta"));
  const delta = socket.sent.find(m => m.type === "object.delta"); assert.deepEqual(delta.t,[-2,0,0]);
  output("object",13,2); await tick(); assert.equal(object.writes.length,1);
  output("object",9,3,delta.delta_id);
  await until(() => object.current.t[0] === 9);
  assert.ok(events.some(e => e.event === "object_correction_applied"));
  assert.ok(diagnostics.presentation().lines.some(l => l.text.includes("object write: equivalent")));
});

test("slow writes coalesce newest poses and normal motion end flushes the final pose", async t => {
  const { object, socket, output } = await setup(t);
  const gate = deferred(); object.onWrite = () => gate.promise;
  output("object",11,1); await until(() => object.writes.length === 1);
  output("object",12,2); output("object",13,3);
  socket.receive({ type: "motion_end", gesture_id: 7 }); gate.resolve();
  await until(() => object.current.t[0] === 13);
  assert.deepEqual(object.writes.map(p => p.seq),[1,3]);
});

test("slow observations reuse the newest adjacent pose without starving writes", async t => {
  const { camera, session, output } = await setup(t);
  const gate = deferred(); let reading = false, reads = 0;
  session.camera.observation = async () => { reading = true; reads++; await gate.promise; return camera.current };
  output("camera",11,1); await until(() => reading);
  output("camera",12,2); output("camera",13,3); gate.resolve();
  await until(() => camera.current.t[0] === 13);
  assert.equal(reads,1); assert.deepEqual(camera.writes.map(p => p.seq),[3]);
});

test("slow observation coalescing does not cross an intervening query", async t => {
  const { camera, session, socket, query, output } = await setup(t);
  const gate = deferred(); let reading = false; const order = [];
  session.camera.observation = async () => { reading = true; await gate.promise; return camera.current };
  const begin = camera.beginQuery.bind(camera);
  camera.beginQuery = async () => { order.push("query"); return begin() };
  camera.onWrite = () => order.push("write");
  output("camera",11,1); await until(() => reading);
  query(2); output("camera",12,2); gate.resolve();
  await until(() => camera.current.t[0] === 12);
  assert.deepEqual(order,["query","write"]);
  assert.ok(socket.sent.some(m => m.type === "response" && m.id === 2));
});

test("late query completion cannot authorize a replacement gesture", async t => {
  const { camera, socket, query, output } = await setup(t);
  const gate = deferred(); let reading = false;
  const begin = camera.beginQuery.bind(camera);
  camera.beginQuery = async () => { reading = true; await gate.promise; return begin() };
  query(2); await until(() => reading);
  socket.receive({ type: "motion_start", gesture_id: 8 }); output("camera",99,1,undefined,8); gate.resolve();
  await tick(); await tick();
  assert.equal(camera.writes.length,0);
  const responses = socket.sent.filter(m => m.type === "response" && m.id === 2);
  assert.equal(responses.length,1); assert.equal(responses[0].error.code,"unavailable");
});

test("target change during initial observation cancels before returning a stale query", async t => {
  const { camera, socket, query } = await setup(t);
  camera.beginQuery = async () => ({ resolve: async () => camera.current, initialObservation: async () => { camera.context = {}; return camera.current } });
  query(2);
  await until(() => socket.sent.some(m => m.type === "motion_cancel"));
  assert.equal(socket.sent.find(m => m.type === "response" && m.id === 2).error.code,"unavailable");
});

test("replacement waits for issued write, ignores its stale completion and then binds new target", async t => {
  const { object, socket, query, output } = await setup(t);
  const gate = deferred(); object.onWrite = () => gate.promise;
  output("object",11,1); await until(() => object.writes.length === 1);
  socket.receive({ type: "motion_start", gesture_id: 8 }); object.context = {}; query(2,8);
  output("object",20,2,undefined,8); gate.resolve();
  await until(() => object.current.t[0] === 20);
  assert.equal(socket.sent.filter(m => m.type === "object.delta").length,0);
  assert.deepEqual(object.writes.map(p => p.gesture_id),[7,8]);
});

test("close waits for issued host operations and retains exclusive ownership until settled", async t => {
  const { client, session, object, output } = await setup(t);
  const gate = deferred(); object.onWrite = () => gate.promise;
  output("object",11,1); await until(() => object.writes.length === 1);
  let closed = false; const closing = session.close().then(() => closed = true);
  await tick(); assert.equal(closed,false);
  assert.throws(() => new NavigationSession(client,{}),/already attached/);
  gate.resolve(); await closing;
  const next = new NavigationSession(client,{}); next.close();
});

test("failed async object write cancels both streams, optional pivot failure does not", async t => {
  const { camera, object, socket, output } = await setup(t);
  camera.showPivot = async () => { throw Error("rendering") };
  socket.receive({ type: "camera.pivot", gesture_id: 7, point: [0,0,0] });
  output("camera",11,1); await until(() => camera.current.t[0] === 11);
  object.applyPose = async () => { throw Error("remote failure") };
  output("object",12,1);
  await until(() => socket.sent.some(m => m.type === "motion_cancel"));
  assert.equal(socket.sent.find(m => m.type === "motion_cancel").reason,"object_write_failed");
  output("camera",12,2); await tick(); assert.equal(camera.writes.length,1);
});

test("async correction timeout fires without additional incoming output", { timeout: 2000 }, async t => {
  const cancelled = deferred();
  const { object, socket, output } = await setup(t,{ timeout: .01,
    onEvent: event => { if (event.event === "cancelled") cancelled.resolve() } });
  object.limit = 10; output("object",12,1);
  await until(() => socket.sent.some(m => m.type === "object.delta"));
  // Wait for the event under the test deadline, not a wall-clock scheduling margin.
  await cancelled.promise;
  assert.equal(socket.sent.find(m => m.type === "motion_cancel")?.reason,"object_delta_timeout");
});

for (const kind of ["camera", "object"]) test(`early async ${kind} timeout is rearmed until its deadline`, async t => {
  const result = await setup(t, { timeout: .01 });
  let now = 10;
  const timers = [];
  t.mock.method(performance, "now", () => now * 1000);
  t.mock.method(globalThis, "setTimeout", callback => { timers.push(callback); return callback });
  t.mock.method(globalThis, "clearTimeout", () => {});
  result[kind].limit = 10;
  result.output(kind, 12, 1);
  await until(() => timers.length === 1);
  now = 10.005;
  timers.shift()();
  assert.equal(result.socket.sent.filter(m => m.type === "motion_cancel").length, 0);
  assert.equal(timers.length, 1, "an early callback must schedule another check");
  now = 10.011;
  const deadlineCallback = timers.shift();
  deadlineCallback();
  await tick();
  assert.equal(result.socket.sent.find(m => m.type === "motion_cancel")?.reason, `${kind}_delta_timeout`);
  assert.equal(timers.length, 0);
  deadlineCallback();
  assert.equal(result.socket.sent.filter(m => m.type === "motion_cancel").length, 1);
  assert.equal(timers.length, 0, "retired callback must not rearm");
});

test("async diagnostic reentrancy cannot issue a stale authorized write", async t => {
  let session;
  const result = await setup(t,{ onEvent: e => { if (e.event === "correction_applied") session.onMotionStart(8) } });
  session = result.session;
  const { camera, socket, output } = result;
  camera.current = pose(11); session.nativeCameraChanged();
  await until(() => socket.sent.some(m => m.type === "camera.delta"));
  output("camera",12,1,socket.sent.find(m => m.type === "camera.delta").delta_id);
  await tick(); await tick();
  assert.equal(camera.writes.length,0);
});

test("unknown async readback recovers through ordinary camera projection rebase", async t => {
  const { camera, session, socket, output } = await setup(t);
  camera.unknown = true;
  session.camera.observation = async () => camera.unknown ? undefined : camera.current;
  output("camera",11,1);
  await until(() => camera.current.t[0] === 11); await tick();
  assert.equal(socket.sent.filter(m => m.type === "camera.delta").length,0);
  camera.unknown = false; camera.current = { ...pose(11), fov: 1.2 }; session.nativeCameraChanged();
  await until(() => socket.sent.some(m => m.type === "camera.delta"));
  assert.equal(socket.sent.find(m => m.type === "camera.pose").fov,1.2);
  assert.equal(socket.sent.find(m => m.type === "camera.delta").delta_id,0);
});

test("async object mode without external observation uses actual write residuals", async t => {
  const { object, socket, output } = await setup(t,{ objectObservation: undefined });
  object.limit = 10; output("object",10,1); await tick(); assert.equal(object.writes.length,0);
  output("object",12,2);
  await until(() => socket.sent.some(m => m.type === "object.delta"));
  assert.deepEqual(socket.sent.find(m => m.type === "object.delta").t,[-2,0,0]);
});

test("disconnect during an async fact read sends no response on a new connection", async t => {
  const { client, camera, query, socket } = await setup(t);
  const gate = deferred(); let reading = false;
  camera.beginQuery = async () => ({ resolve: async () => { reading = true; await gate.promise; return camera.current } });
  query(2); await until(() => reading); await client.disconnect();
  const connected = client.connect(), next = Socket.latest;
  next.readyState = 1; next.onopen(); next.receive({ type: "hello_ack", proto: "openaxis/1.0", server_name: "test" });
  await connected; gate.resolve(); await tick(); await tick();
  assert.equal(socket.sent.filter(m => m.type === "response" && m.id === 2).length,0);
  assert.equal(next.sent.filter(m => m.type === "response").length,0);
});

test("bounded control queue retains independent latest pose slots", async t => {
  const { session, camera, object, socket, output } = await setup(t,{ maxWork: 1 });
  const gate = deferred(); camera.onWrite = () => gate.promise;
  output("camera",11,1); await until(() => camera.writes.length === 1);
  session.nativeObjectChanged();
  output("object",12,1); output("camera",12,2); output("object",13,2); output("camera",13,3);
  socket.receive({ type: "motion_end", gesture_id: 7 }); gate.resolve();
  await until(() => camera.current.t[0] === 13 && object.current.t[0] === 13);
  assert.deepEqual(camera.writes.map(p => p.seq),[1,3]); assert.deepEqual(object.writes.map(p => p.seq),[2]);
});

test("async performance summarizes completed camera and object writes without frame logs", async t => {
  const reports = [];
  const logger = configureLogging("async-performance", { debug: true, sinks: [(_, message) => {
    if (message.startsWith("navigation.performance ")) reports.push(message);
  }] });
  t.after(() => logger.close());
  const { camera, session, output, socket } = await setup(t);
  let release;
  const gate = new Promise(resolve => { release = resolve });
  camera.onWrite = () => gate;
  output("camera", 11, 1);
  await until(() => camera.writes.length === 1);
  output("camera", 12, 2); output("camera", 13, 3); output("object", 11, 1);
  assert.equal(reports.length, 0);
  socket.receive({ type: "motion_end", gesture_id: 7 });
  assert.equal(reports.length, 0);
  release();
  await until(() => reports.length === 1);
  await session.close();
  assert.equal(reports.length, 1);
  const r = reports[0];
  assert.ok(r.includes("reason=motion_end "));
  assert.match(r, /camera responsiveness: turnaround avg [0-9]+\.[0-9] ms, max [0-9]+\.[0-9] ms \[2 applied\]/);
  assert.match(r, /object responsiveness: turnaround avg [0-9]+\.[0-9] ms, max [0-9]+\.[0-9] ms \[1 applied\]/);
  assert.ok(r.includes("camera: poses 3, coalesced 1, writes 2 ok/0 failed"));
  assert.ok(r.includes("object: poses 1, coalesced 0, writes 1 ok/0 failed"));
  assert.match(r, /apply [0-9]+\.[0-9]\/[0-9]+\.[0-9] \[2\]/);
  assert.match(r, /observation [0-9]+\.[0-9]\/[0-9]+\.[0-9] \[2\]/);
});

test("async turnaround follows the pose promoted after a slow observation", async t => {
  const reports = [];
  const logger = configureLogging("turnaround-promotion", { sinks: [(_, m) => {
    if (m.startsWith("navigation.performance ")) reports.push(m);
  }] });
  t.after(() => logger.close());
  const entered = deferred(), release = deferred();
  let camera;
  const h = await setup(t, { observation: async () => { entered.resolve(); await release.promise; return camera.current } });
  camera = h.camera;
  // Test-only clock replacement; the public async API continues to use its event loop clock.
  let now = 10; h.session.clock = () => now;
  h.output("camera", 11, 1);
  await entered.promise;
  now = 10.05; h.output("camera", 12, 2);
  now = 10.06; h.output("camera", 13, 3);
  camera.onWrite = () => { now = 10.07 };
  now = 10.065; release.resolve();
  await until(() => camera.current.t[0] === 13);
  h.socket.receive({ type: "motion_end", gesture_id: 7 });
  await until(() => reports.length === 1);
  assert.ok(reports[0].includes("turnaround avg 10.0 ms, max 10.0 ms [1 applied]"));
  assert.ok(reports[0].includes("camera: poses 3, coalesced 2, writes 1 ok/0 failed"));
});
