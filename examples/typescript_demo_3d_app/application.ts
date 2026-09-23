/** Three.js stand-in application. SDK lifecycle and adapters live in integration.ts. */
import * as THREE from "three";
import {
  type CameraPoseValue,
  type ObjectPoseValue,
  type Vec3,
} from "@openaxis/sdk";
import { Quat } from "@openaxis/sdk/geometry";
import sceneData from "../demo_3d_scene/scene.json";
import type {
  MyApplication as Host,
  MyEdit,
  Bounds,
  PickSample,
  AppEvent,
} from "./integration.js";

const vector = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];
const rotation = (q: THREE.Quaternion): Vec3 =>
  new Quat(q.w, q.x, q.y, q.z).toRotvec();
const quaternion = (r: Vec3) => {
  const q = Quat.fromRotvec(...r);
  return new THREE.Quaternion(q.x, q.y, q.z, q.w);
};
const boxValue = (b: THREE.Box3): Bounds => ({
  min: vector(b.min),
  max: vector(b.max),
});
export const initialCamera = sceneData.camera as CameraPoseValue;
export type SceneData = typeof sceneData;

export class MyApplication implements Host {
  alive = true;
  edit?: MyEdit;
  selected?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  readonly scene = new THREE.Scene();
  readonly objects: THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshStandardMaterial
  >[] = [];
  readonly perspective = new THREE.PerspectiveCamera(50, 1, 0.01, 10000);
  readonly orthographic = new THREE.OrthographicCamera(
    -1,
    1,
    1,
    -1,
    -10000,
    10000,
  );
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.perspective;
  readonly ground: THREE.Mesh;
  private span = sceneData.orthoExtent;
  private diagnosticPoints: readonly Vec3[] = [];
  private cursor?: [number, number];
  private width = 960;
  private height = 720;
  freeCamera = false;
  private status = "Connecting...";
  private diagnostics = false;
  private listeners = new Map<AppEvent, Set<() => void>>();
  private undo: MyEdit[] = [];
  private drag?: {
    button: number;
    start: THREE.Vector2;
    previous: THREE.Vector2;
    center: THREE.Vector3;
    edit?: MyEdit;
    moved: boolean;
  };
  private lastClick?: { target: object; time: number; pixel: THREE.Vector2 };
  private detach: (() => void)[] = [];
  private readonly pivots = [this.makePivot(), this.makePivot()];
  renderer?: THREE.WebGLRenderer;

  constructor(readonly data: SceneData = sceneData) {
    const { size, step, y } = data.ground;
    const grid = new THREE.GridHelper(size, size / step, 0x666666, 0x444444);
    grid.position.y = y;
    this.scene.add(grid);
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = y;
    this.scene.add(this.ground);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(5, 10, 5);
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(0x8899bb, 0x444422, 0.3));
    for (const item of data.objects) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(item.vertices, 3),
      );
      geometry.setAttribute(
        "normal",
        new THREE.Float32BufferAttribute(item.normals, 3),
      );
      geometry.setIndex(item.indices);
      const object = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ color: item.color }),
      );
      object.name = item.name;
      object.position.fromArray(item.position);
      object.quaternion.copy(quaternion(item.rotation as Vec3));
      this.objects.push(object);
      this.scene.add(object);
    }
    this.writeCamera(data.camera as CameraPoseValue);
  }

  mount(renderer = new THREE.WebGLRenderer({ antialias: true })) {
    this.renderer = renderer;
    renderer.setPixelRatio(devicePixelRatio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.body.appendChild(renderer.domElement);
    this.scene.background = new THREE.Color("#141f2e");
    const listen = (
      target: EventTarget,
      name: string,
      handler: EventListener,
      options?: AddEventListenerOptions,
    ) => {
      target.addEventListener(name, handler, options);
      this.detach.push(() =>
        target.removeEventListener(name, handler, options),
      );
    };
    const pixel = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      return new THREE.Vector2(e.clientX - r.left, e.clientY - r.top);
    };
    listen(renderer.domElement, "pointerdown", (event) => {
      const e = event as PointerEvent;
      if (e.button > 2) return;
      e.preventDefault();
      this.pointerDown(e.button, pixel(e));
      renderer.domElement.setPointerCapture(e.pointerId);
    });
    listen(renderer.domElement, "pointermove", (event) => {
      const e = event as PointerEvent;
      this.pointerMove(pixel(e), e.shiftKey);
    });
    listen(renderer.domElement, "pointerup", (event) => {
      const e = event as PointerEvent;
      this.pointerUp(e.button, pixel(e));
      if (renderer.domElement.hasPointerCapture(e.pointerId))
        renderer.domElement.releasePointerCapture(e.pointerId);
    });
    for (const event of ["pointercancel", "lostpointercapture"])
      listen(renderer.domElement, event, () => this.endDrag());
    listen(renderer.domElement, "pointerleave", () => {
      this.cursor = undefined;
    });
    listen(renderer.domElement, "contextmenu", (e) => e.preventDefault());
    listen(
      renderer.domElement,
      "wheel",
      (event) => {
        const e = event as WheelEvent;
        e.preventDefault();
        this.wheel(wheelSteps(e.deltaY, e.deltaMode, this.height));
      },
      { passive: false },
    );
    // Alt is a navigation modifier; suppress the browser menu on both edges
    // without stopping delivery to the other input handlers.
    for (const name of ["keydown", "keyup"])
      listen(window, name, (event) => {
        if ((event as KeyboardEvent).key === "Alt") event.preventDefault();
      });
    listen(window, "keydown", (event) => {
      const e = event as KeyboardEvent;
      if (e.target !== document.body && e.target !== renderer.domElement)
        return;
      if (
        ["Enter", "Escape", "u", "r", "o", "d", "f"].includes(
          e.key.length === 1 ? e.key.toLowerCase() : e.key,
        )
      ) {
        e.preventDefault();
        this.key(e.key);
      }
    });
    listen(window, "blur", () => {
      this.endDrag();
      this.cursor = undefined;
      this.emit("invalidate");
    });
    listen(window, "resize", () => this.resize(innerWidth, innerHeight));
    this.resize(innerWidth, innerHeight);
    this.updateHelp();
  }
  on(event: AppEvent, callback: () => void) {
    const list = this.listeners.get(event) ?? new Set();
    list.add(callback);
    this.listeners.set(event, list);
    return () => {
      list.delete(callback);
    };
  }
  private emit(event: AppEvent) {
    this.listeners.get(event)?.forEach((callback) => callback());
  }
  viewport() {
    return { width: this.width, height: this.height, cursor: this.cursor };
  }
  resize(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.cursor = undefined;
    this.endDrag();
    this.renderer?.setSize(width, height);
    this.updateLens();
    this.emit("invalidate");
  }
  readCamera(): CameraPoseValue {
    return {
      t: vector(this.camera.position),
      r: rotation(this.camera.quaternion),
      ...(this.camera === this.perspective
        ? { fov: (this.perspective.fov * Math.PI) / 180 }
        : { ortho_extent: this.span }),
    };
  }
  writeCamera(pose: CameraPoseValue) {
    this.camera = pose.fov !== undefined ? this.perspective : this.orthographic;
    this.camera.position.fromArray(pose.t);
    this.camera.quaternion.copy(quaternion(pose.r));
    if (pose.fov !== undefined)
      this.perspective.fov = (pose.fov * 180) / Math.PI;
    else this.span = pose.ortho_extent!;
    this.updateLens();
    this.updateStatus();
    return true;
  }
  private updateLens() {
    this.perspective.aspect = this.width / this.height;
    this.perspective.updateProjectionMatrix();
    Object.assign(this.orthographic, {
      left: (-this.span * this.width) / this.height / 2,
      right: (this.span * this.width) / this.height / 2,
      top: this.span / 2,
      bottom: -this.span / 2,
    });
    // Orthographic navigation can cross the model: retain geometry on both sides.
    this.scene.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(this.ground);
    for (const object of this.objects) bounds.expandByObject(object);
    const depths: number[] = [];
    for (const x of [bounds.min.x, bounds.max.x])
      for (const y of [bounds.min.y, bounds.max.y])
        for (const z of [bounds.min.z, bounds.max.z])
          depths.push(this.depth(new THREE.Vector3(x, y, z)));
    // Diagnostic evidence contributes to clipping, never model bounds.
    depths.push(
      ...this.diagnosticPoints.map((point) =>
        this.depth(new THREE.Vector3(...point)),
      ),
    );
    const low = Math.min(...depths),
      high = Math.max(...depths),
      margin = Math.max(1, (high - low) * 0.1);
    this.orthographic.near = low - margin;
    this.orthographic.far = high + margin;
    this.orthographic.updateProjectionMatrix();
  }
  bounds(selectionOnly: boolean): Bounds | undefined {
    const objects = selectionOnly
      ? this.selected
        ? [this.selected]
        : []
      : this.objects;
    const bounds = new THREE.Box3();
    for (const object of objects) bounds.expandByObject(object);
    return bounds.isEmpty() ? undefined : boxValue(bounds);
  }
  pick(
    pixel: [number, number],
    selectionOnly = false,
    objectsOnly = false,
  ): PickSample {
    if ((selectionOnly && !this.selected) ||
        !(pixel[0] >= 0 && pixel[0] < this.width && pixel[1] >= 0 && pixel[1] < this.height))
      return {};
    this.scene.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(
      new THREE.Vector2(
        (2 * pixel[0]) / this.width - 1,
        1 - (2 * pixel[1]) / this.height,
      ),
      this.camera,
    );
    if (this.camera === this.orthographic) {
      // Start at the clipping plane so orthographic picks include visible
      // geometry behind the camera's pose, like the native viewers.
      raycaster.ray.origin.addScaledVector(
        raycaster.ray.direction,
        this.camera.near,
      );
    }
    const candidates = selectionOnly
      ? this.selected
        ? [this.selected]
        : []
      : objectsOnly
        ? this.objects
        : [...this.objects, this.ground];
    const hits = raycaster.intersectObjects(candidates, false);
    const hit = hits.find((h) => {
      const depth = this.depth(h.point);
      return depth >= this.camera.near && depth <= this.camera.far;
    });
    return {
      hit: hit
        ? {
            point: vector(hit.point),
            bounds: boxValue(new THREE.Box3().setFromObject(hit.object)),
          }
        : undefined,
      target: hit?.object,
      ray: [
        vector(raycaster.ray.origin),
        vector(
          raycaster.ray.at(
            hit?.distance ?? this.camera.far,
            new THREE.Vector3(),
          ),
        ),
      ],
    };
  }
  readObject(edit: MyEdit): ObjectPoseValue {
    const object = edit.target as THREE.Object3D;
    return { t: vector(object.position), r: rotation(object.quaternion) };
  }
  writeObject(edit: MyEdit, pose: ObjectPoseValue) {
    const object = edit.target as THREE.Object3D;
    object.position.fromArray(pose.t);
    object.quaternion.copy(quaternion(pose.r));
    this.updateLens();
    return true;
  }
  objectBounds(edit: MyEdit) {
    return boxValue(
      new THREE.Box3().setFromObject(edit.target as THREE.Object3D),
    );
  }
  select(target?: object) {
    if (this.edit) return;
    this.selected = this.objects.find((o) => o === target);
    this.updateHelp();
  }
  beginEdit() {
    if (!this.selected || this.edit) return;
    this.endDrag();
    this.lastClick = undefined;
    this.edit = {
      target: this.selected,
      initialPose: {
        t: vector(this.selected.position),
        r: rotation(this.selected.quaternion),
      },
    };
    this.emit("operation");
    this.updateHelp();
  }
  finishEdit(accept: boolean) {
    this.endDrag();
    this.lastClick = undefined;
    const edit = this.edit;
    if (!edit) return;
    this.edit = undefined;
    if (accept) {
      this.undo.push(edit);
    } else this.writeObject(edit, edit.initialPose);
    this.selected = undefined;
    this.emit("operation");
    this.updateHelp();
  }
  undoEdit() {
    if (this.edit) this.finishEdit(false);
    else {
      const edit = this.undo.pop();
      if (edit) this.writeObject(edit, edit.initialPose);
    }
  }
  resetScene() {
    this.finishEdit(false);
    this.undo = [];
    this.selected = undefined;
    this.lastClick = undefined;
    this.objects.forEach((target, i) => {
      const item = this.data.objects[i];
      this.writeObject(
        {
          target,
          initialPose: { t: item.position as Vec3, r: item.rotation as Vec3 },
        },
        { t: item.position as Vec3, r: item.rotation as Vec3 },
      );
    });
    this.writeCamera(this.data.camera as CameraPoseValue);
    this.emit("camera");
    this.updateHelp();
  }
  toggleProjection() {
    const pose = this.readCamera();
    this.writeCamera({
      t: pose.t,
      r: pose.r,
      ...(pose.fov === undefined
        ? { fov: this.data.camera.fov }
        : { ortho_extent: this.data.orthoExtent }),
    });
    this.emit("camera");
  }
  key(key: string) {
    switch (key.toLowerCase()) {
      case "enter":
        this.edit ? this.finishEdit(true) : this.beginEdit();
        break;
      case "escape":
        this.finishEdit(false);
        break;
      case "u":
        this.undoEdit();
        break;
      case "r":
        this.resetScene();
        break;
      case "o":
        this.toggleProjection();
        break;
      case "f":
        this.freeCamera = !this.freeCamera;
        this.emit("navigation");
        this.updateStatus();
        break;
      case "d":
        this.emit("diagnostics");
        break;
    }
  }
  private inside(p: THREE.Vector2) {
    return p.x >= 0 && p.y >= 0 && p.x < this.width && p.y < this.height;
  }
  pointerDown(
    button: number,
    pixel: THREE.Vector2,
    now = performance.now() / 1000,
  ) {
    this.endDrag();
    if (button > 2 || !this.inside(pixel)) return;
    this.cursor = [pixel.x, pixel.y];
    if (button === 0 && !this.edit) {
      const target = this.pick(this.cursor, false, true).target;
      const previous = this.lastClick;
      this.select(target);
      this.lastClick = target
        ? { target, time: now, pixel: pixel.clone() }
        : undefined;
      if (
        target &&
        previous?.target === target &&
        now - previous.time <= 0.4 &&
        pixel.distanceToSquared(previous.pixel) <= 25
      ) {
        this.beginEdit();
        return;
      }
    }
    const hit = this.pick(this.cursor).hit;
    const center = hit ? new THREE.Vector3(...hit.point) : this.center();
    this.drag = {
      button,
      start: pixel.clone(),
      previous: pixel.clone(),
      center,
      edit: this.edit,
      moved: false,
    };
  }
  pointerMove(pixel: THREE.Vector2, shift = false) {
    this.cursor = this.inside(pixel) ? [pixel.x, pixel.y] : undefined;
    const drag = this.drag;
    if (!drag || !this.inside(pixel)) return;
    if (drag.edit && !drag.moved && pixel.distanceToSquared(drag.start) < 16)
      return;
    const delta = pixel.clone().sub(drag.previous);
    if (delta.lengthSq() === 0) return;
    drag.moved = true;
    this.lastClick = undefined;
    const translate = (drag.button === 0) !== shift;
    if (this.edit) this.mouseEditObject(delta.x, delta.y, translate);
    else
      drag.center = this.mouseNavigate(
        delta.x,
        delta.y,
        drag.center,
        translate,
      );
    drag.previous.copy(pixel);
  }
  pointerUp(button: number, pixel: THREE.Vector2) {
    const drag = this.drag;
    this.endDrag();
    if (
      drag?.edit &&
      this.edit === drag.edit &&
      button === drag.button &&
      button !== 1 &&
      !drag.moved &&
      this.inside(pixel) &&
      pixel.distanceToSquared(drag.start) < 16
    )
      this.finishEdit(button === 0);
  }
  endDrag() {
    this.drag = undefined;
  }
  private depth(point: THREE.Vector3) {
    return -point
      .clone()
      .sub(this.camera.position)
      .applyQuaternion(this.camera.quaternion.clone().invert()).z;
  }
  private viewSpan(point: THREE.Vector3) {
    return this.camera === this.orthographic
      ? this.span
      : 2 *
          Math.max(0.01, this.depth(point)) *
          Math.tan((this.perspective.fov * Math.PI) / 360);
  }
  private center() {
    const b = this.bounds(!!this.selected)!;
    return new THREE.Vector3(...b.min)
      .add(new THREE.Vector3(...b.max))
      .multiplyScalar(0.5);
  }
  mouseNavigate(dx: number, dy: number, center: THREE.Vector3, pan: boolean) {
    const q = this.camera.quaternion;
    if (pan) {
      const offset = new THREE.Vector3(-dx, dy, 0)
        .multiplyScalar(this.viewSpan(center) / this.height)
        .applyQuaternion(q);
      this.camera.position.add(offset);
      center = center.clone().add(offset);
    } else {
      const r = vector(
          new THREE.Vector3(-dy * 0.006, -dx * 0.006, 0).applyQuaternion(q),
        ),
        turn = quaternion(r);
      this.camera.position.sub(center).applyQuaternion(turn).add(center);
      q.premultiply(turn).normalize();
    }
    this.updateLens();
    this.emit("camera");
    return center;
  }
  mouseEditObject(dx = 0, dy = 0, pan = false, wheel = 0) {
    if (!this.edit) return;
    const object = this.edit.target as THREE.Object3D,
      q = this.camera.quaternion,
      span = this.viewSpan(object.position);
    if (pan || wheel)
      object.position.add(
        new THREE.Vector3(
          (dx * span) / this.height,
          (-dy * span) / this.height,
          -wheel * span * 0.08,
        ).applyQuaternion(q),
      );
    else
      object.quaternion
        .premultiply(
          quaternion(
            vector(
              new THREE.Vector3(dy * 0.006, dx * 0.006, 0).applyQuaternion(q),
            ),
          ),
        )
        .normalize();
    this.updateLens();
    this.emit("object");
  }
  wheel(steps: number) {
    if (!Number.isFinite(steps) || steps === 0) return;
    if (this.edit) {
      this.mouseEditObject(0, 0, false, steps);
      return;
    }
    const factor = 0.85 ** steps;
    if (this.camera === this.orthographic)
      this.span = Math.max(0.01, Math.min(10000, this.span * factor));
    else
      this.camera.position.add(
        new THREE.Vector3(
          0,
          0,
          Math.max(0.02, this.depth(this.center())) * (factor - 1),
        ).applyQuaternion(this.camera.quaternion),
      );
    this.updateLens();
    this.emit("camera");
  }
  private makePivot() {
    const group = new THREE.Group();
    for (const hidden of [false, true])
    for (const rim of [false, true]) {
      const mesh = new THREE.Mesh(
        rim ? new THREE.RingGeometry(0.36, 0.36 * 5.5 / 4, 64) : new THREE.CircleGeometry(0.36, 64),
        new THREE.MeshBasicMaterial({
          color: rim ? 0x000000 : 0x00ff00,
          depthTest: true,
          depthFunc: hidden ? THREE.GreaterDepth : THREE.LessEqualDepth,
          depthWrite: false,
          transparent: true,
          opacity: hidden ? 0.2 : 1,
          toneMapped: false,
        }),
      );
      mesh.renderOrder = hidden ? 1001 : 1000;
      group.add(mesh);
    }
    group.visible = false;
    this.scene.add(group);
    return group;
  }
  showPivot(point: Vec3 | undefined, object = false) {
    const marker = this.pivots[object ? 1 : 0];
    marker.visible = point !== undefined;
    if (point) marker.position.fromArray(point);
  }
  setStatus(text: string) {
    this.status = text;
    this.updateStatus();
  }
  setDiagnostics(enabled: boolean) {
    this.diagnostics = enabled;
    this.updateStatus();
  }
  setDiagnosticPoints(points: readonly Vec3[]) {
    this.diagnosticPoints = points;
    if (this.camera === this.orthographic) this.updateLens();
  }
  private updateStatus() {
    if (typeof document === "undefined") return;
    const keyboard = document.getElementById("keyboard-help");
    if (keyboard) {
      const controls = this.edit ? "Enter: Accept    Esc: Cancel    R: Reset scene" : "Enter: Edit selection    U: Undo    R: Reset scene";
      keyboard.textContent = `${controls}    O: Projection (${this.camera === this.perspective ? "Perspective" : "Orthographic"})`;
    }
    const rotatrix = document.getElementById("rotatrix-help");
    if (rotatrix) {
      const key = /Mac/i.test(navigator.platform) ? (this.freeCamera ? "Cmd" : "Ctrl") : /Linux/i.test(navigator.platform) ? "Super" : "Win";
      rotatrix.textContent = `${this.status}\n${key} activates camera control (if not remapped)\nF: Nav mode (${this.freeCamera ? "Free Camera" : "Orbit"})    D: Diagnostics (${this.diagnostics ? "On" : "Off"})`;
    }
  }

  private updateHelp() {
    this.objects.forEach((object, i) =>
      object.material.color.setHex(
        this.edit?.target === object
          ? 0xff40bf
          : this.selected === object
            ? 0xffd94d
            : this.data.objects[i].color,
      ),
    );
    if (typeof document === "undefined") return;
    const edit = document.getElementById("edit-label");
    if (edit) edit.style.visibility = this.edit ? "visible" : "hidden";
    const mouse = document.getElementById("mouse-help");
    if (mouse)
      mouse.textContent = this.edit
        ? "Left-click: Accept    Right-click: Cancel\nLeft-drag: Translate    Middle/Right-drag: Rotate (Shift to swap)    Wheel: Depth"
        : "Click: Select    Double-click: Edit\nLeft-drag: Pan    Middle/Right-drag: Rotate (Shift to swap)    Wheel: Zoom";
    this.updateStatus();
  }
  render() {
    for (const marker of this.pivots)
      if (marker.visible) {
        marker.quaternion.copy(this.camera.quaternion);
        marker.scale.setScalar(
          this.depth(marker.position) > 0 || this.camera === this.orthographic
            ? (8 * this.viewSpan(marker.position)) / (0.72 * this.height)
            : 0,
        );
      }
    this.renderer?.render(this.scene, this.camera);
  }
  dispose() {
    this.alive = false;
    this.detach.splice(0).forEach((detach) => detach());
    this.scene.traverse((object) => {
      if (
        object instanceof THREE.Mesh ||
        object instanceof THREE.LineSegments
      ) {
        object.geometry.dispose();
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material]) {
          if ("map" in material)
            (material.map as THREE.Texture | undefined)?.dispose();
          material.dispose();
        }
      }
    });
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    this.listeners.clear();
  }
}

/** DOM wheel deltas may be fractional pixels, lines, or pages. */
export function wheelSteps(deltaY: number, deltaMode: number, height: number) {
  return (
    (-deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? height : 1)) / 100
  );
}
