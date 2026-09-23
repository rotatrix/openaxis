import * as THREE from 'three';
import { Quat } from '../../../ts/sdk/dist/geometry.js';

// Heading-only frame: pitch never changes travel height or speed.
function groundRotation(rotation) {
  const up = new THREE.Vector3(0, 1, 0);
  const backward = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation);
  backward.y = 0;
  if (backward.lengthSq() < 1e-12) {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(rotation);
    right.y = 0;
    backward.crossVectors(right.normalize(), up);
  }
  backward.normalize();
  const right = new THREE.Vector3().crossVectors(up, backward);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, backward));
}

// Application camera adapter only; gesture and concurrent-input state live in the SDK.
export function createSplatAdapter(camera, unavailable, preferences, available) {
  const pose = () => ({ t: camera.position.toArray(),
    r: new Quat(camera.quaternion.w, camera.quaternion.x, camera.quaternion.y, camera.quaternion.z).toRotvec(),
    fov: camera.fov * Math.PI / 180 });
  return {
    observation: pose,
    captureContext: () => available() ? camera : undefined,
    isCurrent: context => available() && context === camera,
    beginQuery() {
      const initial = pose();
      return { initialObservation: () => initial, resolve(name) {
        switch (name) {
          case 'document.id': return 'demo-splats';
          case 'world.orientation': return { forward: [0, 0, -1], up: [0, 1, 0], handedness: 'right' };
          case 'camera.pose': return initial;
          case 'viewport.aspect': return camera.aspect;
          case 'navigation.translation_scale': return preferences().speed;
          case 'navigation.preferences': return { lock_roll: true, lock_translation_plane: true };
          default: return unavailable;
        }
      } };
    },
    applyPose(context, value) {
      if (value.fov === undefined) return { success: false };
      const q = Quat.fromRotvec(...value.r);
      camera.position.fromArray(value.t); camera.quaternion.set(q.x, q.y, q.z, q.w);
      camera.fov = value.fov * 180 / Math.PI; camera.updateProjectionMatrix();
      return { success: true, realizedPose: pose() };
    },
  };
}

export function moveCamera(camera, direction, distance) {
  camera.position.add(new THREE.Vector3(...direction).normalize().applyQuaternion(groundRotation(camera.quaternion)).multiplyScalar(distance));
}
