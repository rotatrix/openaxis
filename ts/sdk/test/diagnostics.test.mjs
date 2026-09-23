import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NavigationDiagnostics, DIAGNOSTIC_COLORS, UNAVAILABLE, comparePoses } from "../dist/index.js";
import { formatEvent, formatLogLine } from "../dist/diagnostics.js";

const fixture = name => JSON.parse(readFileSync(new URL(`../../../fixtures/openaxis-1.0/${name}.json`, import.meta.url)));
const query = () => ({ requestId: 4, gestureId: 2, values: ["model.bounds"], first: ["pick.cursor.selection","pick.cursor","pick.viewport_center"] });
const pose = x => ({ t: [x,0,10], r: [0,0,0], fov: 1 });
const fact = (d,q,name,value) => d.observe("fact", { query: q, name, value, durationMs: 0 });

test("diagnostic formatting matches Python/C# prose and local timestamp", () => {
  assert.equal(formatEvent("navigation.fact", { fact: "model.bounds", result: "ok", value: {
    min: [-1.6649999618,-.6940374374,-.007499963], max: [1.4941880703,.595210433,1.239323497] }, duration_ms: 1.082, gesture: 3, request: 3 }),
    "  model.bounds — found (-1.665, -0.694, -0.007) … (1.494, 0.595, 1.239) · 1.082 ms");
  assert.equal(formatEvent("navigation.pivot", { source: "query:pick.cursor", result: "selected", point: [.8999999762,.0005832684,.6752421856], client: "Blender", request: 38, gesture: 43 }),
    "  pick.cursor — selected at (0.900, 0.001, 0.675) · Blender, gesture 43, request 38");
  assert.equal(formatEvent("navigation.query.complete", { missing: ["selection.bounds"], first: "pick.cursor", duration_ms: 2, gesture: 3, request: 3 }),
    "query complete — missing selection.bounds; first: pick.cursor · 2.000 ms · request 3");
  const now = new Date(2026,8,4,11,56,59,321);
  assert.equal(formatLogLine("motion started · gesture 3","info",now),"2026-09-04 11:56:59.321  motion started · gesture 3");
  assert.equal(formatLogLine("motion canceled","warning",now),"2026-09-04 11:56:59.321  WARN motion canceled");
  assert.equal(formatEvent("navigation.pivot.order", { candidates: ["selection.viewport-clipped-center","viewport.center:selection-depth","world.origin"] }),
    "pivot order: selection center → viewport center (selection depth) → origin");
});

test("shared diagnostic presentation: rows, world geometry, markers and colors", () => {
  const f = fixture("diagnostic-presentation"), d = new NavigationDiagnostics({ enabled: true });
  const q = { requestId: 9, gestureId: 7, values: Object.keys(f.facts), first: [] };
  d.observe("query_started", { query: q }); d.setContext("view");
  for (const [name,value] of Object.entries(f.facts)) fact(d,q,name,value);
  d.pick(9,"pick.cursor", { screen: [20,30], ray: [[0,0,5],[1,1,1]] });
  d.pick(9,"pick.cursor.selection", { screen: [20,30] });
  d.observe("query_completed", { query: q, result: {}, durationMs: 0 });
  const frame = d.presentation();
  assert.deepEqual(frame.lines,f.rows); assert.deepEqual(frame.markers,f.markers);
  assert.deepEqual(DIAGNOSTIC_COLORS,f.colors);
  assert.equal(frame.segments.length,f.segments.length);
  frame.segments.forEach((s,i) => {
    const expected = f.segments[i];
    assert.equal(s.tone,expected.tone); assert.equal(s.width,expected.width); assert.equal(s.opacity,expected.opacity);
    for (const key of ["start","end"]) s[key].forEach((v,j) => assert.ok(Math.abs(v - expected[key][j]) < 1e-12));
  });
});

test("shared diagnostic correction and gesture fixtures", () => {
  const f = fixture("diagnostics"); let now = 0;
  const d = new NavigationDiagnostics({ enabled: true, clock: () => now });
  for (const step of f.corrections) {
    now = step.time;
    d.observe(`${step.stream === "object" ? "object_" : ""}correction_${step.state}`, { deltaId: step.id });
    assert.equal(d.presentation().lines.length,step.visible);
  }
  now = f.expire_at; assert.equal(d.presentation().lines.length,0);
  const logs = [], snapshots = [];
  const lifecycle = new NavigationDiagnostics({ enabled: true, log: (...v) => logs.push(v) });
  lifecycle.onChanged = () => snapshots.push(lifecycle.presentation());
  for (const step of f.lifecycle) {
    lifecycle.observe(step.event,{ ...(step.event === "output_rejected" ? { kind: "camera.pose" } : {}), gestureId: step.id, ...(step.reason ? { reason: step.reason } : {}) });
    assert.deepEqual(logs.at(-1),[step.level,step.message]);
    assert.equal(snapshots.at(-1).lines.at(-1).text,step.status);
  }
  assert.equal(snapshots.length,f.lifecycle.length);
});

test("evidence is detached, first candidates are ordered, stale context hides geometry", () => {
  const d = new NavigationDiagnostics({ enabled: true }), q = query();
  const bounds = { min: [0,0,0], max: [2,2,2] };
  d.observe("query_started",{ query: q }); d.setContext("A");
  fact(d,q,"model.bounds",bounds); fact(d,q,"pick.cursor.selection",UNAVAILABLE);
  fact(d,q,"pick.cursor",{ point: [1,1,1], bounds });
  d.pick(99,"wrong",{ screen: [1,2] });
  d.pick(q.requestId,"pick.cursor",{ screen: [20,30], ray: [[0,0,5],[1,1,1]] });
  d.observe("query_completed",{ query: q, result: { first: { name: "pick.cursor" } }, durationMs: 3 });
  bounds.max[0] = 500; q.values.push("mutated");
  const frame = d.presentation();
  assert.equal(frame.segments.length,27); assert.equal(frame.markers.length,1);
  assert.ok(frame.lines.some(l => l.text.includes("skipped")));
  assert.ok(frame.segments.every(s => !s.end.includes(500)));
  frame.segments[0].end[0] = 600; frame.markers[0].point[0] = 600; frame.lines[0].text = "mutated";
  assert.ok(!JSON.stringify(d.presentation()).includes("600"));
  d.setContext("B"); assert.equal(d.presentation().segments.length,0);
});

test("writes respect comparison policy, distinguish unknown readback, and avoid log spam", () => {
  const logs = [], calls = [];
  const d = new NavigationDiagnostics({ enabled: true, log: (...v) => logs.push(v) });
  d.bind((a,b) => { calls.push([a,b]); return comparePoses(a,b,{ absolute: 10 }) });
  const write = (realized,success = true) => d.observe("camera_write",{ context: {}, desired: pose(0), realized, success });
  for (let i=0;i<5;i++) write(pose(1));
  assert.equal(calls.length,5); assert.equal(logs.length,0);
  assert.ok(d.presentation().lines[0].text.includes("equivalent"));
  for (let i=0;i<5;i++) write(undefined);
  assert.equal(logs.length,1); assert.ok(logs[0][1].includes("unknown readback"));
  write(pose(0)); assert.ok(logs.at(-1)[1].includes("recovered"));
  write(undefined,false); assert.equal(d.presentation().lines[0].tone,"missing");
  d.setEnabled(false);
  for (let i=0;i<5;i++) d.observe("correction_waiting",{ deltaId: 1 });
  assert.equal(logs.filter(l => l[1].includes("waiting")).length,0);
  assert.deepEqual(d.presentation().lines,[]);
});

test("bounded history, expiry deadlines, disabled capture and failing sinks", () => {
  let now = 10, mapped = 0, redraws = 0;
  const d = new NavigationDiagnostics({ clock: () => now, retention: 2.5, historyLimit: 2,
    contextKey: c => { mapped++; return c.viewport }, log() { throw Error("logger") },
    onChanged() { redraws++; throw Error("UI") } });
  d.observe("query_context",{ query: query(), context: { viewport: "A" } }); assert.equal(mapped,0);
  d.setEnabled(true); d.observe("query_started",{ query: query() });
  d.observe("query_context",{ query: query(), context: { viewport: "A" } });
  assert.equal(d.presentation().context,"A"); assert.equal(mapped,1);
  d.clear();
  for (let i=0;i<5;i++) d.observe("correction_sent",{ deltaId: i });
  assert.equal(d.history.length,2);
  const history = d.history; history[0].message = "mutated";
  assert.notEqual(d.history[0].message,"mutated");
  d.observe("correction_applied",{ deltaId: 4 });
  assert.equal(d.presentation().expiresAt,12.5);
  const count = redraws; now = 12.5;
  assert.equal(d.presentation().expiresAt,undefined); assert.equal(d.presentation().lines.length,0);
  assert.equal(redraws,count);
  for (const options of [{ retention: NaN },{ retention: -1 },{ historyLimit: 0 },{ historyLimit: 1.5 }]) assert.throws(() => new NavigationDiagnostics(options));
});
