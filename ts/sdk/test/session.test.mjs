import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { NavigationSession, OpenAxisClient } from "../dist/index.js";

const scenarios = JSON.parse(readFileSync(new URL("../../../fixtures/openaxis-1.0/session.json", import.meta.url))).scenarios;
function pose(value) {
  if (value == null) return undefined;
  if (typeof value === "number") value = { x: value };
  return { t: value.t ?? [value.x ?? 0, 0, 0], r: value.r ?? [0, 0, 0],
    ...("extent" in value ? { ortho_extent: value.extent } : { fov: value.fov ?? 1 }) };
}
function equal(actual, expected, label) {
  if (Array.isArray(expected)) expected.forEach((value, i) => equal(actual[i], value, label));
  else if (typeof expected === "number") assert.ok(Math.abs(actual - expected) <= 1e-8, `${label}: ${actual} != ${expected}`);
  else assert.equal(actual ?? null, expected, label);
}
for (const scenario of scenarios) test(`session trace: ${scenario.name}`, () => {
  const client = new OpenAxisClient({ clientName: "trace" });
  const session = new NavigationSession(client, {}, { scheduler: { post() {}, postAt() {} } });
  // Exercise the actual production state through the coordinator; no public
  // state-machine export is necessary for integration authors.
  const state = session.camera.state;
  const tokens = {}, tickets = {}, writes = {};
  for (const [index, event] of scenario.events.entries()) {
    const token = event.token ? tokens[event.token] : state.token;
    const actual = pose(event.actual), now = event.now ?? 0;
    let effect, kind = "ok";
    switch (event.op) {
      case "connection": state.connection(); break;
      case "start": tokens[event.as ?? "last"] = state.start(event.gesture); break;
      case "query": kind = state.query(token, actual, event.scoped ?? true, event.supplied ?? true) ? "ok" : "reject"; break;
      case "receive": {
        const value = { type: "camera.pose", ...pose(event.pose), gesture_id: event.gesture ?? state.gestureId, seq: event.seq, applied_delta_id: event.ack };
        const ticket = state.receive(event.epoch ?? state.epoch, value);
        kind = ticket ? "accepted" : "reject";
        if (ticket) tickets[event.as ?? "last"] = ticket;
        break;
      }
      case "process": effect = state.process(tickets[event.ticket ?? "last"], actual, now); break;
      case "observe": effect = state.observe(token, actual, now); break;
      case "complete": effect = state.complete(writes[event.write ?? "last"], actual, now, event.success ?? true); break;
      case "end": kind = state.end(token) ? "ok" : "reject"; break;
      case "finish": kind = state.finish(token) ? "ok" : "reject"; break;
      case "cancel": effect = state.cancel(token, event.reason); break;
      case "timeout": effect = state.expire(token, event.delta, now); break;
      case "send_failed": effect = state.sendFailed(token, event.delta); break;
      default: throw Error(event.op);
    }
    const result = { kind: effect?.kind ?? kind, baseline: state.baseline?.t[0], ready: state.ready,
      pending: state.pendingId, active: state.gestureId, received: state.lastReceived, applied: state.lastApplied,
      delta_id: effect?.deltaId, gesture_id: effect?.gestureId, reason: effect?.reason,
      t: effect?.difference?.t, r: effect?.difference?.r, scale: effect?.difference?.scale };
    if (effect?.write) writes[event.as ?? "last"] = effect.write;
    for (const [key, expected] of Object.entries(event.expect)) equal(result[key], expected, `event ${index} ${event.op} ${key}`);
  }
  session.close();
});
