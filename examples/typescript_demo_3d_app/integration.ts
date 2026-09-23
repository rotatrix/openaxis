// Runnable browser integration; the host API keeps Three.js out of the adapters.
import {
  NavigationDiagnostics,
  NavigationSession,
  OpenAxisClient,
  OpenAxisConnectionManager,
  UNAVAILABLE,
  configureLogging,
  DIAGNOSTIC_COLORS,
  type CameraPoseValue,
  type ObjectPoseValue,
  type Vec3,
  type NavigationAdapter,
  type NavigationObjectAdapter,
  type ConnectionMetadata,
} from "@openaxis/sdk";
import { NavigationDiagnosticOverlay } from "../demos/lib/navigation-diagnostic-overlay.js";
import type { Camera } from "three";

// #region host
export interface Bounds {
  min: Vec3;
  max: Vec3;
}
export interface PickSample {
  hit?: { point: Vec3; bounds: Bounds };
  target?: object;
  // Absent when no test ran (for example, no selection or invalid viewport pixel).
  ray?: [Vec3, Vec3];
}
export type AppEvent =
  | "camera"
  | "object"
  | "operation"
  | "invalidate"
  | "diagnostics"
  | "navigation";
export interface MyEdit {
  readonly target: object;
  readonly initialPose: ObjectPoseValue;
}
export interface MyApplication {
  alive: boolean;
  freeCamera: boolean;
  edit?: MyEdit;
  readCamera(): CameraPoseValue;
  writeCamera(pose: CameraPoseValue): boolean;
  viewport(): { width: number; height: number; cursor?: [number, number] };
  bounds(selectionOnly: boolean): Bounds | undefined;
  // Pixels relative to the viewport, Y down; exclude overlays from picks/bounds.
  pick(pixel: [number, number], selectionOnly: boolean): PickSample;
  showPivot(point: Vec3 | undefined, object?: boolean): void;
  readObject(edit: MyEdit): ObjectPoseValue;
  writeObject(edit: MyEdit, pose: ObjectPoseValue): boolean;
  objectBounds(edit: MyEdit): Bounds;
  setStatus(text: string): void;
  setDiagnostics(enabled: boolean): void;
  on(event: AppEvent, callback: () => void): () => void;
}
// #endregion host

// #region camera
export class MyNavigationAdapter implements NavigationAdapter<MyApplication> {
  constructor(
    private app: MyApplication,
  ) {}

  captureContext() {
    return this.app.alive ? this.app : undefined;
  }
  isCurrent(context: MyApplication) {
    return context === this.app && context.alive;
  }
  beginQuery(context: MyApplication) {
    return new MyQueryCapture(context);
  }
  applyPose(context: MyApplication, desired: CameraPoseValue) {
    const success = context.writeCamera(desired);
    return {
      success,
      realizedPose: success ? structuredClone(context.readCamera()) : undefined,
    };
  }
  showPivot(context: MyApplication, point: Vec3 | undefined) {
    context.showPivot(point);
  }
}
// #endregion camera

// #region query
export class MyQueryCapture {
  private camera: CameraPoseValue;
  private width: number;
  private height: number;
  private cursor?: [number, number];

  constructor(
    private app: MyApplication,
  ) {
    this.camera = structuredClone(app.readCamera());
    const { width, height, cursor } = structuredClone(app.viewport());
    this.width = width;
    this.height = height;
    this.cursor =
      cursor &&
      cursor[0] >= 0 &&
      cursor[0] <= width &&
      cursor[1] >= 0 &&
      cursor[1] <= height
        ? cursor
        : undefined;
  }
  initialObservation() {
    return structuredClone(this.camera);
  }
  resolve(name: string): unknown {
    if (name === "document.id") return "demo-3d-services";
    if (name === "camera.pose") return structuredClone(this.camera);
    if (name === "world.orientation")
      return { forward: [0, 0, -1], up: [0, 1, 0], handedness: "right" };
    if (name === "model.bounds") return this.app.bounds(false) ?? UNAVAILABLE;
    if (name === "selection.bounds")
      return this.app.bounds(true) ?? UNAVAILABLE;
    if (this.width <= 0 || this.height <= 0) return UNAVAILABLE;
    // World units per quarter ball turn in Rotatrix at unit gain.
    if (name === "navigation.translation_scale") return 4.0;
    if (name === "viewport.aspect") return this.width / this.height;
    if (name === "viewport.cursor")
      return this.cursor
        ? [
            (2 * this.cursor[0]) / this.width - 1,
            1 - (2 * this.cursor[1]) / this.height,
          ]
        : UNAVAILABLE;
    if (
      ![
        "pick.cursor",
        "pick.cursor.selection",
        "pick.viewport_center",
        "pick.viewport_center.selection",
      ].includes(name)
    )
      return UNAVAILABLE;
    const pixel: [number, number] | undefined = name.startsWith("pick.cursor")
      ? this.cursor
      : [this.width / 2, this.height / 2];
    if (!pixel) return UNAVAILABLE;
    const sample = this.app.pick(pixel, name.endsWith(".selection"));
    return sample.ray ? { ...sample.hit, markerPosition: pixel } : UNAVAILABLE;
  }
}
// #endregion query

// #region object
export class MyObjectAdapter implements NavigationObjectAdapter<MyEdit> {
  constructor(private app: MyApplication) {}
  captureContext() {
    return this.app.alive ? this.app.edit : undefined;
  }
  isCurrent(edit: MyEdit) {
    return this.app.alive && this.app.edit === edit;
  }
  read(edit: MyEdit) {
    return structuredClone(this.app.readObject(edit));
  }
  beginQuery(edit: MyEdit) {
    return new MyObjectCapture(
      this.read(edit),
      structuredClone(this.app.objectBounds(edit)),
    );
  }
  applyPose(edit: MyEdit, desired: ObjectPoseValue) {
    const success = this.app.writeObject(edit, desired);
    return { success, realizedPose: success ? this.read(edit) : undefined };
  }
  showPivot(_edit: MyEdit, point: Vec3 | undefined) {
    this.app.showPivot(point, true);
  }
}

export class MyObjectCapture {
  constructor(
    private pose: ObjectPoseValue,
    private bounds: Bounds,
  ) {}
  initialObservation() {
    return structuredClone(this.pose);
  }
  resolve(name: string) {
    return name === "object.pose"
      ? structuredClone(this.pose)
      : name === "object.bounds"
        ? structuredClone(this.bounds)
        : UNAVAILABLE;
  }
}
// #endregion object

export class MyOpenAxisIntegration {
  readonly client: OpenAxisClient;
  readonly diagnostics: NavigationDiagnostics;
  readonly session: NavigationSession<MyApplication, MyEdit>;
  readonly connection: OpenAxisConnectionManager;
  private running?: Promise<void>;
  private updates = new Set<Promise<void>>();
  private detach: (() => void)[] = [];
  private stopped = false;
  private started = false;
  private hidden = false;
  private transition: Promise<void> = Promise.resolve();
  private stopping?: Promise<void>;

  constructor(
    private app: MyApplication,
    debug = false,
    url = "ws://127.0.0.1:6607",
    client?: OpenAxisClient,
  ) {
    this.client =
      client ??
      new OpenAxisClient({ clientName: "typescript-demo-3d-app", url });
    // #region setup
    configureLogging("typescript-demo");
    this.diagnostics = new NavigationDiagnostics({
      enabled: false,
      logLevel: debug ? "debug" : "info",
      // Object contexts and camera contexts belong to this one viewport.
      contextKey: () => app,
    });
    const objects = new MyObjectAdapter(app);
    this.session = new NavigationSession(
      this.client,
      new MyNavigationAdapter(app),
      {
        observation: (context) => structuredClone(context.readCamera()),
        objectAdapter: objects,
        objectObservation: (edit) => objects.read(edit),
        diagnostics: this.diagnostics,
      },
    );
    this.connection = new OpenAxisConnectionManager(this.client, {
      metadata: () => this.metadata(),
      onState: (state, error, delay) => {
        app.setStatus(
          state === "retrying"
            ? `Reconnecting in ${((delay ?? 0) / 1000).toFixed(1)}s${error ? `: ${String(error)}` : ""}`
            : state,
        );
        if (state !== "ready") this.diagnostics.clear();
      },
    });
    // #endregion setup
  }

  // #region metadata
  metadata(): ConnectionMetadata {
    return {
      capabilities: ["navigation"],
      tags: [
        "demo-3d-services",
        ...(this.app.freeCamera ? ["navigation.hint.free_camera"] : []),
        ...(this.app.edit
          ? ["interaction.object.rotate", "interaction.object.translate"]
          : []),
      ],
      focused: !this.hidden && !document.hidden && document.hasFocus(),
    };
  }

  refresh = (): void => {
    if (this.stopped || this.connection.state !== "ready") return;
    const update = this.connection.refreshMetadata().catch((error) => {
      if (!this.stopped) console.debug("Metadata refresh interrupted", error);
    });
    this.updates.add(update);
    void update.then(() => this.updates.delete(update));
  };
  // #endregion metadata

  // #region events
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.detach.push(
      this.app.on("navigation", this.refresh),
      this.app.on("camera", () => this.session.nativeCameraChanged()),
      this.app.on("object", () => this.session.nativeObjectChanged()),
      this.app.on("operation", () => {
        this.session.contextChanged();
        this.diagnostics.clear();
        this.refresh();
      }),
      this.app.on("invalidate", () => {
        this.session.contextChanged();
        this.diagnostics.clear();
      }),
      this.app.on("diagnostics", () => {
        this.diagnostics.setEnabled(!this.diagnostics.enabled);
        this.app.setDiagnostics(this.diagnostics.enabled);
      }),
    );
    const focus = () => {
      this.refresh();
      this.resume();
    };
    const hide = () => {
      this.hidden = true;
      this.session.contextChanged();
      this.diagnostics.clear();
      this.transition = this.transition.then(() => this.connection.stop());
    };
    const show = () => {
      this.hidden = false;
      focus();
    };
    const visibility = () => {
      this.refresh();
      if (!document.hidden) this.resume();
    };
    window.addEventListener("focus", focus);
    window.addEventListener("blur", this.refresh);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    document.addEventListener("visibilitychange", visibility);
    this.detach.push(() => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", this.refresh);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      document.removeEventListener("visibilitychange", visibility);
    });
    this.resume();
  }
  private resume() {
    this.transition = this.transition.then(() => {
      if (
        this.stopped ||
        this.hidden ||
        document.hidden ||
        !document.hasFocus()
      )
        return;
      this.running = this.connection
        .start()
        .catch((error) => console.error("Connection supervisor failed", error));
    });
  }
  // #endregion events

  // #region stop
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    for (const detach of this.detach.splice(0)) detach();
    return (this.stopping = this.shutdown());
  }
  private async shutdown(): Promise<void> {
    try {
      await this.transition;
      await this.connection.stop();
      await this.running;
      await Promise.allSettled(this.updates);
    } finally {
      this.session.close();
      // The default scheduler drains marker cleanup in a microtask.
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      this.app.showPivot(undefined);
      this.app.showPivot(undefined, true);
      this.diagnostics.clear();
    }
  }
  // #endregion stop
}

// #region display
export function showDiagnostics(
  integration: MyOpenAxisIntegration,
  output: HTMLElement,
  viewport: HTMLCanvasElement,
  camera: () => Camera,
  isCurrent: (context: unknown) => boolean,
): () => void {
  const overlay = new NavigationDiagnosticOverlay(
    viewport,
    output,
    DIAGNOSTIC_COLORS,
  );
  overlay.screenCoordinates = "pixels";
  let frame: number;
  const draw = () => {
    overlay.draw(integration.diagnostics, camera(), isCurrent);
    frame = requestAnimationFrame(draw);
  };
  draw();
  return () => {
    cancelAnimationFrame(frame);
    overlay.dispose();
  };
}
// #endregion display
