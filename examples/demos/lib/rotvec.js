// Three.js boundary conversions; rotation math belongs to the SDK.
import { Quaternion } from 'three';
import { Quat } from '../../../ts/sdk/dist/geometry.js';
export const threeQuatToRotvec = q => new Quat(q.w, q.x, q.y, q.z).toRotvec();
export function rotvecToThreeQuat(r) {
  const q = Quat.fromRotvec(...r);
  return new Quaternion(q.x, q.y, q.z, q.w);
}
