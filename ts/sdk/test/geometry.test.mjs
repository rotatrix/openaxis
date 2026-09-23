import assert from "node:assert/strict";
import test from "node:test";
import { Quat, Vec3 } from "../dist/geometry.js";

function sameRotation(actual, expected) {
  for (const basis of [new Vec3(1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, 0, 1)]) {
    assert.ok(actual.rotate(basis).sub(expected.rotate(basis)).length() < 1e-10);
  }
}

test("slerp endpoints, midpoint and shortest path", () => {
  const start = Quat.identity;
  const end = Quat.fromRotvec(0, 0, Math.PI / 2);
  sameRotation(start.slerp(end, 0), start);
  sameRotation(start.slerp(end, 1), end);
  sameRotation(start.slerp(end, 0.5), Quat.fromRotvec(0, 0, Math.PI / 4));
  const negated = new Quat(-end.w, -end.x, -end.y, -end.z);
  sameRotation(start.slerp(negated, 0.5), Quat.fromRotvec(0, 0, Math.PI / 4));
});

test("slerp identical, opposite-sign and nearly identical quaternions stays normalized", () => {
  const start = Quat.fromRotvec(0.2, -0.3, 0.4);
  sameRotation(start.slerp(start, 0.5), start);
  sameRotation(start.slerp(new Quat(-start.w, -start.x, -start.y, -start.z), 0.5), start);
  const result = Quat.identity.slerp(Quat.fromRotvec(0, 0, 1e-5), 0.5);
  sameRotation(result, Quat.fromRotvec(0, 0, 5e-6));
  assert.ok(Math.abs(Math.hypot(result.w, result.x, result.y, result.z) - 1) < 1e-12);
});
