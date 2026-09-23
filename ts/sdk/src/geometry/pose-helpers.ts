import { Quat } from "./quat.js";
import { Vec3 } from "./vec3.js";

/** Protocol-neutral camera pose value expressed in the caller's world coordinates. */
export interface CameraPoseValue {
  readonly position: Vec3;
  readonly rotationVector: Vec3;
  readonly fov?: number;
  readonly orthoExtent?: number;
}

export interface LookAtValue {
  readonly eye: Vec3;
  readonly target: Vec3;
  readonly up: Vec3;
}

function validatePose(position: Vec3, rotationVector: Vec3, fov?: number, orthoExtent?: number): CameraPoseValue {
  if (fov !== undefined && orthoExtent !== undefined) throw new RangeError("A camera pose cannot contain both projections");
  if (fov !== undefined && (!Number.isFinite(fov) || fov <= 0)) throw new RangeError("FOV must be positive and finite");
  if (orthoExtent !== undefined && (!Number.isFinite(orthoExtent) || orthoExtent <= 0)) throw new RangeError("Orthographic extent must be positive and finite");
  const components = [position.x, position.y, position.z, rotationVector.x, rotationVector.y, rotationVector.z];
  if (!components.every(Number.isFinite)) throw new RangeError("Camera position and rotation vector must be finite");
  return { position, rotationVector, fov, orthoExtent };
}

/** Convert eye/target/up to the OpenAxis camera-local rotation convention. */
export function poseFromLookAt(
  eye: Vec3,
  target: Vec3,
  up: Vec3,
  projection: { fov?: number; orthoExtent?: number } = {},
): CameraPoseValue {
  const offset = eye.sub(target);
  if (offset.length() < 1e-12) {
    return validatePose(eye, new Vec3(0, 0, 0), projection.fov, projection.orthoExtent);
  }
  const backward = offset.normalized();
  let right = up.cross(backward).normalized();
  if (right.length() < 1e-6) {
    const fallback = Math.abs(up.y) > 0.9 ? new Vec3(1, 0, 0) : new Vec3(0, 1, 0);
    right = fallback.cross(backward).normalized();
  }
  const orthogonalUp = backward.cross(right).normalized();
  const rotationVector = Vec3.fromArray(Quat.fromAxes(right, orthogonalUp, backward).normalize().toRotvec());
  return validatePose(eye, rotationVector, projection.fov, projection.orthoExtent);
}

/** Convert an OpenAxis camera pose to eye/target/up values. */
export function lookAtFromPose(
  pose: CameraPoseValue,
  defaultDistance = 10,
  pivot?: Vec3,
): LookAtValue {
  const q = Quat.fromRotvec(pose.rotationVector.x, pose.rotationVector.y, pose.rotationVector.z);
  const up = q.rotate(new Vec3(0, 1, 0));
  const backward = q.rotate(new Vec3(0, 0, 1));
  const distance = pivot === undefined
    ? defaultDistance
    : Math.max(pose.position.sub(pivot).dot(backward), 0.01);
  return { eye: pose.position, target: pose.position.sub(backward.mul(distance)), up };
}
