import { SketchfabCamera, callApi } from './sketchfab-camera.js';
import { threeQuatToRotvec, rotvecToThreeQuat } from './rotvec.js';
import { Vector3 } from 'three';

// Match the camera-only state of 3D Services; never advertise object selection.
export const SKETCHFAB_NAVIGATION_TAGS = ['demo-3d-services', 'viewspace.3d', 'workspace.modeling'];

export function cameraPose(context) {
  return { t: context.camera.eye.toArray(), r: threeQuatToRotvec(context.camera.orientation), fov: context.fov };
}

/** One serial write lane shared by native controls and the asynchronous SDK host. */
export function createSketchfabNavigation({ current, available, aspect, cursor = () => null, translationScale = context => context.translationScale, unavailable, onApplied, onError, onPivot, onPick }) {
  let tail = Promise.resolve();
  const isCurrent = context => current() === context;
  function write(context, next, fov = context.fov, device = false) {
    const valid = () => isCurrent(context) && (!device || available());
    const operation = tail.then(async () => {
      if (!valid()) return { success: false };
      const command = next.command();
      // Send both orientation components in the same turn. Waiting for look-at's
      // iframe round trip exposes the new direction with the previous roll.
      // Drain both callbacks (even on failure) before admitting another pose.
      const results = await Promise.allSettled([
        callApi(context.api, 'setCameraLookAt', command.position, command.target, 0),
        callApi(context.api, 'setCameraRoll', command.roll),
      ]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      if (!valid()) return { success: false };
      if (fov !== context.fov) {
        await callApi(context.api, 'setFov', fov * 180 / Math.PI);
        if (!valid()) return { success: false };
        fov = await callApi(context.api, 'getFov') * Math.PI / 180;
      }
      if (!valid()) return { success: false };
      context.camera = next; context.fov = fov;
      onApplied?.(context, command);
      // This is the acknowledged logical pose. Roll cannot be independently read back.
      return { success: true, realizedPose: cameraPose(context) };
    });
    tail = operation.catch(error => { onError?.(error); });
    return operation;
  }
  const adapter = {
    captureContext: () => available() ? current() : undefined,
    isCurrent: context => available() && isCurrent(context),
    async beginQuery(context) {
      // Snapshot after any outstanding manual write, using one pose for all facts/rays.
      await tail;
      if (!adapter.isCurrent(context)) return { resolve: () => unavailable };
      const capturedCamera = cloneCamera(context.camera);
      const capturedAspect = aspect(), capturedCursor = cursor();
      const pose = cameraPose(context), pivot = context.camera.pivot.toArray();
      const scale = translationScale(context);
      const facts = {
        'navigation.translation_scale': Number.isFinite(scale) && scale > 0 ? scale : unavailable,
        'document.id': context.documentId,
        'world.orientation': { forward: [0,1,0], up: [0,0,1], handedness: 'right' },
        'camera.pose': pose, 'camera.view_target': pivot, 'viewport.aspect': capturedAspect,
        'viewport.cursor': capturedCursor ? { ...capturedCursor } : unavailable,
      };
      return {
        async resolve(name) {
          if (Object.hasOwn(facts,name)) return facts[name];
          // There is no selected-object scope in this viewer. Never mislabel whole-scene hits.
          if (name !== 'pick.cursor' && name !== 'pick.viewport_center') return unavailable;
          const screen = name === 'pick.cursor' ? capturedCursor : { x: 0, y: 0 };
          if (!screen || !adapter.isCurrent(context)) return unavailable;
          const ray = cameraRay(capturedCamera, pose.fov, capturedAspect, screen);
          const point = await pickScene(context.api, ray);
          if (!adapter.isCurrent(context)) return unavailable;
          onPick?.({ name, screen, ray, point });
          return point ? { point, markerPosition: [screen.x, screen.y] } : { markerPosition: [screen.x, screen.y] };
        },
        initialObservation: () => pose,
      };
    },
    async applyPose(context, pose, navigation, pivot) {
      if (!adapter.isCurrent(context)) return { success: false };
      if (pose.fov === undefined || pose.ortho_extent !== undefined) throw Error('Sketchfab integration supports perspective camera navigation only.');
      const next = cloneCamera(context.camera);
      next.eye.fromArray(pose.t); next.orientation.copy(rotvecToThreeQuat(pose.r));
      if (pivot) next.pivot.fromArray(pivot);
      else next.pivot.add(next.eye.clone().sub(context.camera.eye));
      return write(context, next, pose.fov, true);
    },
    showPivot(context, point) { if (isCurrent(context)) onPivot?.(point); },
  };
  return { adapter, write, idle: () => tail };
}

/** Initial visible height at the authored target; stable while flying through the scene. */
export function cameraTranslationScale(camera, fov) {
  const scale = camera.distance * Math.tan(fov / 2);
  if (!Number.isFinite(scale) || scale <= 0) throw Error('Invalid initial camera translation scale.');
  return scale;
}

/** Invert Sketchfab's home-sphere fit: distance = radius / sin(limiting half-FOV). */
export function framedModelRadius(pose, fov, aspect) {
  const distance = Math.hypot(...pose.position.map((v,i) => v - pose.target[i]));
  const radius = distance * Math.sin(Math.atan(Math.tan(fov / 2) * Math.min(aspect, 1)));
  if (!(aspect > 0 && fov > 0 && fov < Math.PI && radius > 0 && Number.isFinite(radius))) throw Error('Invalid model framing.');
  return radius;
}

export async function measureTranslationScale(api, camera, fov, aspect) {
  const original = camera.command();
  let scale = cameraTranslationScale(camera, fov), source = 'initial view estimate';
  if (typeof api.recenterCamera !== 'function') return { scale, source };
  try {
    await callApi(api, 'recenterCamera');
    const framed = await callApi(api, 'getCameraLookAt');
    scale = framedModelRadius(framed, fov, aspect);
    source = 'model framing radius';
  } catch {
    // No fabricated bounds: retain an explicitly labelled view-size fallback.
  } finally {
    // Restoration failures must stop initialization rather than publish a false pose.
    await callApi(api, 'setCameraLookAt', original.position, original.target, 0);
  }
  return { scale, source };
}

/** World-space segment, independent of iframe pixel size, DPR, and native roll. */
export function cameraRay(camera, fov, aspect, screen) {
  const tan = Math.tan(fov / 2);
  const direction = new Vector3(screen.x * aspect * tan, screen.y * tan, -1)
    .normalize().applyQuaternion(camera.orientation);
  const range = Math.max(camera.distance * 1000, 1);
  return [camera.eye.toArray(), camera.eye.clone().addScaledVector(direction, range).toArray()];
}

/** Bounded picks leave time for cursor-miss → center fallback within the server's 2s query timeout. */
export function pickScene(api, [start, end], timeout = 650) {
  return new Promise(resolve => {
    if (typeof api?.pickFromScene !== 'function') return resolve(undefined);
    const timer = setTimeout(() => resolve(undefined), timeout);
    try {
      api.pickFromScene(start, end, (error, hit) => {
        clearTimeout(timer);
        const point = hit?.position3D;
        resolve(!error && point?.length === 3 && Array.from(point).every(Number.isFinite) ? Array.from(point) : undefined);
      });
    } catch { clearTimeout(timer); resolve(undefined); }
  });
}

export function pivotScreen(camera, fov, aspect, point) {
  const local = new Vector3(...point).sub(camera.eye).applyQuaternion(camera.orientation.clone().invert());
  if (local.z >= -1e-9) return undefined;
  const height = -local.z * Math.tan(fov / 2);
  const x = local.x / (height * aspect), y = local.y / height;
  return Math.abs(x) <= 1 && Math.abs(y) <= 1 ? { x, y } : undefined;
}

export function cloneCamera(camera) {
  const command = camera.command();
  const clone = new SketchfabCamera(command.position, command.target);
  clone.orientation.copy(camera.orientation); clone.pivot.copy(camera.pivot);
  return clone;
}
