import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  NavigationQuery,
  PROTO_VERSION,
  UNAVAILABLE,
  packMessage,
  parseMessage,
} from "../dist/index.js";
import { Quat, Vec3, lookAtFromPose, poseFromLookAt } from "../dist/geometry.js";

const fixtureUrl = name => new URL(`../../../fixtures/openaxis-1.0/${name}`, import.meta.url);
const readFixture = async name => JSON.parse(await readFile(fileURLToPath(fixtureUrl(name)), "utf8"), (_key, value) => {
  if (value?.$number === "nan") return Number.NaN;
  if (value?.$number === "positive_infinity") return Number.POSITIVE_INFINITY;
  if (value?.$number === "negative_infinity") return Number.NEGATIVE_INFINITY;
  return value;
});

function close(actual, expected, tolerance, context = "value") {
  if (typeof expected === "number") {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${context}: ${actual} != ${expected}`);
    return;
  }
  if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, `${context} length`);
    expected.forEach((item, index) => close(actual[index], item, tolerance, `${context}[${index}]`));
    return;
  }
  for (const [key, value] of Object.entries(expected)) close(actual[key], value, tolerance, `${context}.${key}`);
}

test("shared OpenAxis 1.0 message fixtures", async () => {
  const fixture = await readFixture("messages.json");
  assert.equal(PROTO_VERSION, fixture.protocol);
  for (const entry of fixture.valid_messages) assert.deepEqual(packMessage(parseMessage(entry.message)), entry.message, entry.name);
  for (const entry of fixture.invalid_messages) assert.throws(() => parseMessage(entry.message), undefined, entry.name);
  for (const entry of fixture.unknown_messages) assert.deepEqual(parseMessage(entry.message), entry.message, entry.name);
});

test("shared geometry fixtures", async () => {
  const fixture = await readFixture("geometry.json");
  const tolerance = fixture.tolerance;
  for (const entry of fixture.quaternion_inverse) {
    const [w, x, y, z] = entry.quaternion;
    const product = new Quat(w, x, y, z).multiply(new Quat(w, x, y, z).inverse());
    close([product.w, product.x, product.y, product.z], entry.expected_product, tolerance, entry.name);
  }
  for (const entry of fixture.camera_basis_from_rotvec) {
    const q = Quat.fromRotvec(...entry.r);
    const sign = entry.handedness === "left" ? -1 : 1;
    const right = q.rotate(new Vec3(sign, 0, 0));
    const up = q.rotate(new Vec3(0, 1, 0));
    const backward = q.rotate(new Vec3(0, 0, 1));
    close({ right: right.toArray(), up: up.toArray(), backward: backward.toArray() }, entry.expected, tolerance, entry.name);
  }
  for (const entry of fixture.pose_from_look_at) {
    const projection = entry.projection.fov === undefined
      ? { orthoExtent: entry.projection.ortho_extent }
      : { fov: entry.projection.fov };
    const pose = poseFromLookAt(Vec3.fromArray(entry.eye), Vec3.fromArray(entry.target), Vec3.fromArray(entry.up), projection);
    const value = { t: pose.position.toArray(), r: pose.rotationVector.toArray() };
    if (pose.fov !== undefined) value.fov = pose.fov;
    if (pose.orthoExtent !== undefined) value.ortho_extent = pose.orthoExtent;
    close(value, entry.expected, tolerance, entry.name);
  }
  for (const entry of fixture.look_at_from_pose) {
    const pose = {
      position: Vec3.fromArray(entry.pose.t),
      rotationVector: Vec3.fromArray(entry.pose.r),
      fov: entry.pose.fov,
      orthoExtent: entry.pose.ortho_extent,
    };
    const result = lookAtFromPose(pose, entry.default_distance, entry.pivot ? Vec3.fromArray(entry.pivot) : undefined);
    close({ eye: result.eye.toArray(), target: result.target.toArray(), up: result.up.toArray() }, entry.expected, tolerance, entry.name);
  }
});

test("NavigationQuery memoizes, short-circuits, and completes exactly once", () => {
  let completed;
  const query = new NavigationQuery({
    type: "request",
    id: 41,
    method: "navigation.query",
    params: { gesture_id: 73, values: ["shared", "missing", "shared"], first: ["missing", "chosen", "unreached"] },
  }, result => { completed = result }, () => assert.fail("query should not fail"));
  const calls = new Map();
  const result = query.evaluate(name => {
    calls.set(name, (calls.get(name) ?? 0) + 1);
    if (name === "shared") return "cached";
    if (name === "missing") return UNAVAILABLE;
    if (name === "chosen") return { point: [1, 2, 3] };
    assert.fail(`unexpected resolution: ${name}`);
  });
  assert.deepEqual(result, { values: { shared: "cached" }, first: { name: "chosen", value: { point: [1, 2, 3] } } });
  assert.equal(calls.get("shared"), 1);
  assert.equal(calls.get("missing"), 1);
  assert.equal(calls.has("unreached"), false);
  query.complete(result);
  assert.equal(completed, result);
  assert.throws(() => query.complete(result), /already been completed/);
});
