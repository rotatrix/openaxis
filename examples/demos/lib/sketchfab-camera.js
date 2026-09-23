import { Vector3, Quaternion, Matrix4 } from 'three';

const Z = new Vector3(0, 0, 1);
const AXES = { right: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0), back: Z };

/** Independent rigid camera. Sketchfab coordinates are Z-up. Pivot is app-owned. */
export class SketchfabCamera {
  constructor(position, target) {
    if (![...position, ...target].every(Number.isFinite) || position.length !== 3 || target.length !== 3) throw Error('Invalid camera coordinates');
    this.eye = new Vector3(...position);
    this.pivot = new Vector3(...target);
    this.distance = this.eye.distanceTo(this.pivot);
    if (this.distance < 1e-9) throw Error('Camera eye and target coincide');
    this.orientation = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(this.eye, this.pivot, Z));
  }
  move(axis, amount) {
    const delta = AXES[axis].clone().applyQuaternion(this.orientation).multiplyScalar(amount);
    this.eye.add(delta); this.pivot.add(delta);
  }
  turn(axis, angle, orbit) {
    const worldAxis = AXES[axis].clone().applyQuaternion(this.orientation);
    const rotation = new Quaternion().setFromAxisAngle(worldAxis, angle);
    if (orbit) this.eye.sub(this.pivot).applyQuaternion(rotation).add(this.pivot);
    this.orientation.premultiply(rotation).normalize();
  }
  command() {
    const back = Z.clone().applyQuaternion(this.orientation);
    const right = AXES.right.clone().applyQuaternion(this.orientation);
    const baseRight = Z.clone().cross(back);
    // A Z-up look-at is singular at either pole. Do not silently corrupt orientation.
    if (baseRight.length() < 1e-6) throw Error('Z-up camera pole reached. Rotate away from the pole or reset.');
    baseRight.normalize();
    // Sketchfab's FPS manipulator rolls about FORWARD, the negative camera Z axis.
    // Its orbit manipulator uses a position-dependent axis and cannot be used here.
    const roll = -Math.atan2(back.dot(baseRight.clone().cross(right)), baseRight.dot(right));
    return {
      position: this.eye.toArray(),
      target: this.eye.clone().addScaledVector(back, -this.distance).toArray(),
      roll,
    };
  }
}

export function callApi(api, method, ...args) {
  return new Promise((resolve, reject) => {
    if (typeof api?.[method] !== 'function') return reject(Error(`Viewer does not expose ${method}`));
    const timer = setTimeout(() => reject(Error(`${method} timed out`)), 8000);
    try {
      api[method](...args, (error, value) => {
        clearTimeout(timer);
        if (error) reject(Error(`${method}: ${typeof error === 'string' ? error : JSON.stringify(error)}`));
        else resolve(value);
      });
    } catch (error) { clearTimeout(timer); reject(error); }
  });
}

