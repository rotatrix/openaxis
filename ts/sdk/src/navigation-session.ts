import { NavigationPerformance } from "./navigation-performance.js";
import { ConnectionState, type OpenAxisClient, type OpenAxisListener } from "./client.js";
import { NavigationQuery, UNAVAILABLE } from "./navigation.js";
import { parseCameraPoseValue, vec3Value, asMap } from "./protocol/parse.js";
import { SessionState, comparePoses, type PoseComparison, type Token, type Effect, type AcceptedPose } from "./session-state.js";
import type { CameraPoseValue, CameraPoseMessage, ObjectPoseMessage, CameraPivotMessage, ObjectPivotMessage, NavigationStateMessage, OpenAxisInteger, StandardMessage, Vec3, WireMap } from "./protocol/types.js";
import type { NavigationDiagnostics } from "./navigation-diagnostics.js";
import type { NavigationEvent, NavigationEventMap, NavigationObserver } from "./navigation-observer.js";
import type { ObjectPoseValue } from "./protocol/types.js";
import type { ObjectPoseComparison } from "./session-state.js";

export { comparePoses, compareObjectPoses } from "./session-state.js";
export type { PoseComparison, PoseDifference, ComparisonOptions, ObjectPoseComparison, ObjectComparisonOptions } from "./session-state.js";
export interface WriteResult<P extends CameraPoseValue = CameraPoseValue> { success: boolean; realizedPose?: P }
export interface NavigationCapture<P extends CameraPoseValue = CameraPoseValue> {
  resolve(name: string): unknown;
  initialObservation?(): P | undefined;
}
/** Captured context binds the original viewport/object/native operation. */
export interface NavigationAdapter<C = unknown, P extends CameraPoseMessage | ObjectPoseMessage = CameraPoseMessage> {
  captureContext(): C | undefined;
  isCurrent(context: C): boolean;
  beginQuery(context: C): NavigationCapture<Omit<P, "type" | "gesture_id" | "seq" | "applied_delta_id">>;
  applyPose(context: C, pose: P, navigation: NavigationStateMessage | undefined, pivot: Vec3 | undefined): WriteResult<Omit<P, "type" | "gesture_id" | "seq" | "applied_delta_id">>;
  showPivot?(context: C, point: Vec3 | undefined): void;
}
export type NavigationObjectAdapter<C = unknown> = NavigationAdapter<C, ObjectPoseMessage>;
export type ObjectNavigationCapture = NavigationCapture<ObjectPoseValue>;
export type ObjectWriteResult = WriteResult<ObjectPoseValue>;
export interface NavigationScheduler {
  /** Must defer; never call a callback inline. All adapter calls use this thread. */
  post(callback: () => void): void;
  /** Absolute monotonic seconds, matching the supplied clock. */
  postAt(deadline: number, callback: () => void): void;
}
export interface NavigationSessionOptions<C, O> {
  observation?: (context: C) => CameraPoseValue | undefined;
  comparison?: PoseComparison;
  objectAdapter?: NavigationObjectAdapter<O>;
  objectObservation?: (context: O) => ObjectPoseValue | undefined;
  objectComparison?: ObjectPoseComparison;
  scheduler?: NavigationScheduler;
  clock?: () => number;
  timeout?: number;
  maxQueries?: number;
  maxWork?: number;
  drainBudget?: number;
  observer?: (event: string, values: Record<string, unknown>) => void;
  /** Typed passive event callback. Legacy observer remains supported. */
  onEvent?: NavigationObserver;
  diagnostics?: NavigationDiagnostics;
}
interface Stream<C = any> { state: SessionState; adapter?: NavigationAdapter<C, CameraPoseMessage | ObjectPoseMessage>; observation?: (context: C) => CameraPoseValue | undefined; bound?: { token: Token; context: C }; pivot?: Vec3 }
interface QueryWork { query: NavigationQuery; token?: Token; epoch: number }
interface Work { kind: string; token?: Token; value?: any; stream?: Stream }
const monotonic = () => performance.now() / 1000;
const defaultScheduler: NavigationScheduler = {
  post: callback => queueMicrotask(callback),
  postAt: (deadline, callback) => { setTimeout(callback, Math.max(0, (deadline - monotonic()) * 1000)) },
};

/** One exclusive navigation owner, with independent camera and object streams. */
export class NavigationSession<C = unknown, O = unknown> implements OpenAxisListener {
  private readonly camera: Stream<C>;
  private readonly object: Stream<O>;
  private readonly scheduler: NavigationScheduler;
  private readonly clock: () => number;
  private readonly maxQueries: number;
  private readonly maxWork: number;
  private readonly budget: number;
  private readonly detach: () => void;
  private readonly performance = new NavigationPerformance();
  private queue: Work[] = [];
  private queries = new Set<QueryWork>();
  private send?: (message: StandardMessage) => void;
  private scheduled = false; private draining = false; private closed = false;
  private cleanup?: string;
  private uiGesture?: OpenAxisInteger;
  private navigation?: NavigationStateMessage;
  private deferred?: Work;

  constructor(private client: OpenAxisClient, adapter: NavigationAdapter<C>, private options: NavigationSessionOptions<C, O> = {}) {
    this.clock = options.clock ?? monotonic;
    this.scheduler = options.scheduler ?? defaultScheduler;
    if (options.clock && !options.scheduler) throw new TypeError("A custom clock requires a matching scheduler");
    this.maxQueries = options.maxQueries ?? 32; this.maxWork = options.maxWork ?? 64; this.budget = options.drainBudget ?? 32;
    for (const limit of [this.maxQueries, this.maxWork, this.budget]) if (!Number.isInteger(limit) || limit < 1) throw new TypeError("Queue limits must be positive integers");
    this.camera = { state: new SessionState(options.comparison, options.timeout), adapter, observation: options.observation };
    this.object = { state: new SessionState(options.objectComparison, options.timeout, "object"), adapter: options.objectAdapter, observation: options.objectObservation };
    options.diagnostics?.bind(options.comparison, options.objectComparison);
    this.detach = client.attachNavigation(this);
    try { if (client.state === ConnectionState.Connected) this.onStateChange(client.state) }
    catch (error) { this.detach(); throw error }
  }
  get isActive(): boolean { return !this.closed && this.camera.state.gestureId !== undefined && !this.camera.state.ending }
  private notify<K extends keyof NavigationEventMap>(event: K, values: NavigationEventMap[K]): void {
    try { this.options.diagnostics?.observe(event, values) } catch { /* passive */ }
    try { this.options.onEvent?.({ event, values } as NavigationEvent) } catch { /* passive */ }
    try { this.options.observer?.(event, values as unknown as Record<string,unknown>) } catch { /* passive */ }
  }
  private wake(): void {
    if (this.scheduled || this.draining || (!this.queue.length && !this.cleanup && !this.camera.state.ending)) return;
    this.scheduled = true;
    try { this.scheduler.post(() => this.drain()) } catch (error) { this.scheduled = false; throw error }
  }
  private enqueue(work: Work): boolean {
    if (work.kind === "pose") {
      // A released pivot-deferred pose may have been superseded while waiting.
      if (work.value.pose.seq !== work.stream!.state.lastReceived) return true;
      const sameSlot = (queued: Work) => queued.kind === "pose" && queued.stream === work.stream
        && queued.token?.epoch === work.token?.epoch && queued.token?.generation === work.token?.generation;
      const perf = this.performance.stream(work.token!, work.stream === this.object);
      const previous = this.queue.length;
      this.queue = this.queue.filter(queued => !sameSlot(queued));
      if (perf) perf.coalesced += previous - this.queue.length;
      if (this.deferred && sameSlot(this.deferred)) { if (perf) perf.coalesced++; this.deferred = undefined }
      // Pose slots are reserved independently of the bounded non-pose queue.
      // Append at arrival position so intervening queries retain their order.
      this.queue.push(work);
      return true;
    }
    const last = this.queue.at(-1);
    if (work.kind !== "query" && last?.kind === work.kind && last.stream === work.stream
      && last.token?.epoch === work.token?.epoch && last.token?.generation === work.token?.generation) this.queue[this.queue.length - 1] = work;
    else if (this.queue.filter(queued => queued.kind !== "pose").length < this.maxWork) this.queue.push(work);
    else return false;
    return true;
  }
  onStateChange(state: ConnectionState): void {
    if (this.closed) return;
    this.performance.finish("connection_changed", this.clock());
    this.camera.state.connection(); this.object.state.connection();
    for (const query of this.queries) this.reply(query);
    this.queue = []; this.cleanup = "connection_changed";
    this.send = state === ConnectionState.Connected ? this.client.captureNavigationSender() : undefined;
    this.wake();
  }
  onMotionStart(gestureId: OpenAxisInteger): void {
    if (this.closed || !this.send) return;
    this.camera.state.start(gestureId); this.object.state.start(gestureId);
    this.performance.begin(gestureId, this.camera.state.token, this.clock());
    for (const work of this.queries) if (work.token) this.reply(work);
    this.queue = this.queue.filter(work => work.kind === "query" && !work.token);
    this.cleanup = "superseded"; this.wake();
  }
  onMotionEnd(gestureId: OpenAxisInteger): void {
    if (this.closed || gestureId !== this.camera.state.gestureId) return;
    this.camera.state.end(this.camera.state.token); this.object.state.end(this.object.state.token); this.wake();
  }
  onNavigationQuery(query: NavigationQuery): boolean {
    const state = this.camera.state;
    const work = { query, epoch: state.epoch, token: query.scoped ? state.token : undefined };
    this.queries.add(work);
    if (this.closed || !this.send || this.queries.size > this.maxQueries || (query.scoped && (query.gestureId !== state.gestureId || state.ending))
      || !this.enqueue({ kind: "query", token: work.token, value: work })) this.reply(work);
    this.wake(); return true;
  }
  onCameraPose(pose: CameraPoseMessage): void { this.receive(this.camera, pose) }
  onObjectPose(pose: ObjectPoseMessage): void {
    if (!this.object.adapter) {
      if (pose.gesture_id === this.camera.state.gestureId) this.effect(this.camera, this.camera.state.cancel(this.camera.state.token, "object_navigation_unsupported"));
    } else this.receive(this.object, pose);
  }
  private receive(stream: Stream, pose: CameraPoseMessage | ObjectPoseMessage): void {
    if (this.closed) return;
    const accepted = stream.state.receive(stream.state.epoch, pose);
    if (accepted) {
      this.performance.stream(accepted.token, stream === this.object)?.receive(pose.seq!, this.clock());
      this.enqueue({ kind: "pose", token: accepted.token, value: accepted, stream });
    }
    else this.notify("output_rejected", { kind: pose.type, gestureId: pose.gesture_id, reason: "inactive_or_stale_output" });
    this.wake();
  }
  onNavigationState(value: NavigationStateMessage): void { this.feedback("navigation", value.gesture_id, value) }
  onCameraPivot(value: CameraPivotMessage): void { this.feedback("pivot", value.gesture_id, value.point, this.camera) }
  onObjectPivot(value: ObjectPivotMessage): void { this.feedback("pivot", value.gesture_id, value.point, this.object) }
  private feedback(kind: string, gestureId: OpenAxisInteger, value: unknown, stream?: Stream): void {
    if (!this.closed && gestureId === this.camera.state.gestureId && !this.camera.state.ending) this.enqueue({ kind, value, token: this.camera.state.token, stream });
    this.wake();
  }
  nativeCameraChanged(): void { this.changed(this.camera) }
  nativeObjectChanged(): void { this.changed(this.object) }
  private changed(stream: Stream): void {
    if (!this.closed && stream.state.ready) this.enqueue({ kind: "observe", token: stream.state.token, stream });
    this.wake();
  }
  contextChanged(): void { this.effect(this.camera, this.camera.state.cancel(this.camera.state.token, "context_changed")) }
  checkContext(): void {
    const bound = this.camera.bound ?? this.object.bound;
    if (bound) this.valid(bound.token);
  }
  private valid(token: Token): boolean {
    let valid = true;
    for (const stream of [this.camera, this.object] as Stream[]) if (stream.bound) {
      try { valid = stream.adapter!.isCurrent(stream.bound.context) && valid } catch { valid = false }
    }
    const current = !this.closed && this.camera.state.current(token);
    if (current && !valid) this.effect(this.camera, this.camera.state.cancel(token, "context_changed"));
    return current && valid;
  }
  private reply(work: QueryWork, result?: WireMap): void {
    if (!this.queries.delete(work)) return;
    try {
      if (this.closed || work.epoch !== this.camera.state.epoch) work.query.claim();
      else if (result) work.query.complete(result);
      else work.query.fail("unavailable", "Navigation context unavailable");
    } catch {
      if (work.token) this.effect(this.camera, this.camera.state.cancel(work.token, "navigation_reply_send_failed"));
    }
  }
  private query(work: QueryWork): void {
    if (!this.queries.has(work)) return;
    const started = this.clock();
    this.notify("query_started", { query: work.query });
    const captures = new Map<Stream, { context: any; capture: NavigationCapture }>();
    try {
      const result = work.query.evaluate(name => {
        const stream: Stream = name.startsWith("object.") ? this.object : this.camera;
        let value: unknown = UNAVAILABLE;
        let error: string | undefined;
        const factStarted = this.clock();
        try {
          if (stream.adapter) {
            let item = captures.get(stream);
            if (!item) {
              const context = work.token && stream.bound ? stream.bound.context : stream.adapter.captureContext();
              if (context !== undefined && stream.adapter.isCurrent(context)) {
                item = { context, capture: stream.adapter.beginQuery(context) }; captures.set(stream, item);
                if (stream === this.camera || !captures.has(this.camera)) this.notify("query_context", { query: work.query, context });
              }
            }
            value = item?.capture.resolve(name) ?? UNAVAILABLE;
            if (value !== UNAVAILABLE && name === "camera.pose") parseCameraPoseValue(value);
            if (value !== UNAVAILABLE && name === "object.pose") { const p = asMap(value); vec3Value(p.t, "object.pose.t"); vec3Value(p.r, "object.pose.r") }
          }
        } catch (caught) { value = UNAVAILABLE; error = String(caught) }
        this.notify("fact", { query: work.query, name, value, error, durationMs: (this.clock() - factStarted) * 1000 });
        return value;
      });
      let valid = !this.closed && this.queries.has(work) && work.epoch === this.camera.state.epoch && (!work.token || this.valid(work.token));
      const observations = new Map<Stream, CameraPoseValue | undefined>();
      for (const [stream, item] of captures) {
        valid = stream.adapter!.isCurrent(item.context) && valid;
        try { observations.set(stream, stream.observation ? item.capture.initialObservation?.() : undefined) } catch { /* unknown */ }
      }
      // Observation and validation can reenter the session.
      valid = valid && !this.closed && this.queries.has(work) && work.epoch === this.camera.state.epoch && (!work.token || this.valid(work.token));
      if (valid && work.token) for (const [stream, item] of captures) {
        stream.bound = { token: work.token, context: item.context };
        const name = stream === this.camera ? "camera.pose" : "object.pose";
        const first = result.first as { name: string; value: CameraPoseValue } | null | undefined;
        const supplied = (result.values as WireMap)[name] ?? (first?.name === name ? first.value : undefined);
        if (supplied !== undefined) {
          const observation = stream === this.object && !stream.observation ? supplied as CameraPoseValue : observations.get(stream);
          valid = stream.state.query(work.token, observation, true, true, true) && valid;
        }
      }
      if (!valid && work.token) this.effect(this.camera, this.camera.state.cancel(work.token, "context_changed"));
      this.reply(work, valid ? result : undefined);
      if (valid) this.notify("query_completed", { query: work.query, result, durationMs: (this.clock() - started) * 1000 });
      else this.notify("query_failed", { query: work.query, error: "Navigation context unavailable", durationMs: (this.clock() - started) * 1000 });
    } catch (error) { this.reply(work); this.notify("query_failed", { query: work.query, error: String(error), durationMs: (this.clock() - started) * 1000 }) }
  }
  private needsPivot(): boolean { return this.navigation?.camera?.mode === "orbit" && !this.camera.pivot }
  private process(work: Work): void {
    const token = work.token!;
    if (!this.valid(token)) return;
    if (work.kind === "navigation") { this.navigation = work.value; this.notify("navigation_state", { state: work.value }) }
    else {
      const stream = work.stream!;
      if (!stream.bound) return;
      if (work.kind === "pivot") {
        stream.pivot = work.value;
        try { stream.adapter?.showPivot?.(stream.bound.context, stream.pivot) } catch { /* optional */ }
      } else {
        if (stream === this.camera && work.kind === "pose" && this.needsPivot()) { this.deferred = work; return }
        let actual: CameraPoseValue | undefined;
        const perf = this.performance.stream(token, stream === this.object);
        let receivedAt = work.kind === "pose" ? perf?.process(work.value.pose.seq, this.clock()) : undefined;
        if (stream.observation) {
          const started = this.clock();
          try { actual = stream.observation(stream.bound.context) } catch { /* unknown */ }
          perf?.observation.add(this.clock() - started);
        }
        if (!this.valid(token)) return;
        const accepted = work.value as AcceptedPose;
        const before = stream.state.pendingId;
        let effect = work.kind === "pose" ? stream.state.process(accepted, actual, this.clock()) : stream.state.observe(token, actual, this.clock());
        if (work.kind === "pose" && before !== undefined && before !== stream.state.pendingId && (accepted.pose.applied_delta_id ?? -1) >= before) this.notify(stream === this.object ? "object_correction_applied" : "correction_applied", { deltaId: before });
        if (effect.kind === "apply") {
          if (!this.valid(token)) { stream.state.complete(effect.write!, undefined, this.clock(), false); return }
          let result: WriteResult;
          const context = stream.bound.context;
          const applyStarted = this.clock();
          try { result = stream.adapter!.applyPose(stream.bound.context, accepted.pose, this.navigation, stream.pivot) } catch { result = { success: false } }
          perf?.applied(applyStarted, this.clock(), result.success, receivedAt);
          this.valid(token);
          effect = stream.state.complete(effect.write!, stream === this.object || stream.observation ? result.realizedPose : undefined, this.clock(), result.success);
          // Do not attach late diagnostic evidence to a replacement gesture.
          if (this.camera.state.current(token) || effect.kind === "cancel") this.notify(stream === this.object ? "object_write" : "camera_write",
            { context, desired: accepted.pose, realized: result.realizedPose, success: result.success });
          if (result.success) this.notify(stream === this.object ? "object_applied" : "camera_applied", { desired: accepted.pose, realized: result.realizedPose });
        }
        if (effect.kind === "hold" && stream.state.pendingId !== undefined) this.notify(stream === this.object ? "object_correction_waiting" : "correction_waiting", { deltaId: stream.state.pendingId });
        if (effect.kind === "delta" || effect.kind === "rebase") this.notify(stream === this.object ? "object_correction_sent" : "correction_sent", { deltaId: effect.deltaId!, difference: effect.difference });
        this.effect(stream, effect);
      }
    }
    if (this.deferred && !this.needsPivot()) { const deferred = this.deferred; this.deferred = undefined; this.enqueue(deferred) }
  }
  private effect(stream: Stream, effect: Effect): void {
    if (!["cancel", "delta", "rebase"].includes(effect.kind)) return;
    const token = effect.token!;
    if (effect.kind === "cancel") {
      this.performance.finish(effect.reason!, this.clock(), token);
      const other = stream === this.camera ? this.object : this.camera;
      other.state.cancel(token, effect.reason!);
      if (token.epoch === this.camera.state.epoch && this.camera.state.generation === token.generation + 1) this.cleanup = effect.reason;
      this.queue = this.queue.filter(work => work.token?.generation !== token.generation || work.token?.epoch !== token.epoch);
      for (const work of this.queries) if (work.token?.generation === token.generation && work.epoch === token.epoch) this.reply(work);
      this.notify("cancelled", { gestureId: effect.gestureId!, reason: effect.reason! });
      if (!this.closed && token.epoch === this.camera.state.epoch) try { this.send?.({ type: "motion_cancel", gesture_id: effect.gestureId!, reason: effect.reason }) } catch { /* already retired */ }
    } else {
      if (!stream.state.current(token) || stream.state.pendingId !== effect.deltaId) return;
      const d = effect.difference!;
      try {
        if (effect.kind === "rebase") {
          const pose = effect.pose!;
          this.send?.({ type: "camera.pose", gesture_id: effect.gestureId!, t: pose.t, r: pose.r,
            ...(pose.fov === undefined ? { ortho_extent: pose.ortho_extent } : { fov: pose.fov }) });
        }
        if (!stream.state.current(token) || stream.state.pendingId !== effect.deltaId) return;
        this.send?.(stream === this.object
          ? { type: "object.delta", gesture_id: effect.gestureId!, delta_id: effect.deltaId, t: d.t, r: d.r }
          : { type: "camera.delta", gesture_id: effect.gestureId!, delta_id: effect.deltaId, t: d.t, r: d.r, ...(d.scale === undefined ? {} : { ortho_extent_scale: d.scale }) });
        if (stream.state.deadline !== undefined) this.scheduler.postAt(stream.state.deadline, () => this.effect(stream, stream.state.expire(token, effect.deltaId!, this.clock())));
      } catch { this.effect(stream, stream.state.sendFailed(token, effect.deltaId!)) }
    }
    this.wake();
  }
  drain(): void {
    this.scheduled = false;
    if (this.draining) return;
    this.draining = true;
    try {
      for (let count = 0; count < this.budget; count++) {
        if (this.cleanup) {
          const reason = this.cleanup; this.cleanup = undefined;
          for (const stream of [this.camera, this.object] as Stream[]) {
            if (stream.bound) try { stream.adapter?.showPivot?.(stream.bound.context, undefined) } catch { /* optional */ }
            stream.bound = undefined; stream.pivot = undefined;
          }
          this.navigation = undefined; this.deferred = undefined;
          if (this.uiGesture !== undefined) { const gestureId = this.uiGesture; this.uiGesture = undefined; this.notify("gesture_finished", { gestureId, reason }) }
        }
        const gestureId = this.closed ? undefined : this.camera.state.gestureId;
        if (gestureId !== undefined && this.uiGesture !== gestureId) { this.uiGesture = gestureId; this.notify("gesture_started", { gestureId }) }
        const work = this.queue.shift();
        if (!work) {
          if (this.camera.state.ending) { this.performance.finish("motion_end", this.clock()); this.camera.state.finish(this.camera.state.token); this.object.state.finish(this.object.state.token); this.cleanup = "motion_end" }
          break;
        }
        if (work.kind === "query") this.query(work.value); else this.process(work);
      }
    } finally { this.performance.flush(); this.draining = false; this.wake() }
  }
  close(): void {
    if (this.closed) return;
    this.performance.finish("closed", this.clock());
    this.closed = true; this.camera.state.connection(); this.object.state.connection();
    for (const query of this.queries) this.reply(query);
    this.queue = []; this.cleanup = "closed"; this.detach(); this.wake();
  }
}


