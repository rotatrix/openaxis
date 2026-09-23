import { NavigationPerformance } from "./navigation-performance.js";
import { ConnectionState, type OpenAxisClient, type OpenAxisListener } from "./client.js";
import { NavigationQuery, UNAVAILABLE } from "./navigation.js";
import { parseCameraPoseValue, vec3Value, asMap } from "./protocol/parse.js";
import { SessionState, type PoseComparison, type Token, type Effect, type AcceptedPose } from "./session-state.js";
import type { CameraPoseValue, CameraPoseMessage, ObjectPoseMessage, CameraPivotMessage, ObjectPivotMessage, NavigationStateMessage, OpenAxisInteger, StandardMessage, Vec3, WireMap } from "./protocol/types.js";
import type { NavigationDiagnostics } from "./navigation-diagnostics.js";
import type { NavigationEvent, NavigationEventMap, NavigationObserver } from "./navigation-observer.js";

import type { WriteResult } from "./navigation-session.js";
export type Awaitable<T> = T | Promise<T>;
export interface AsyncNavigationCapture {
  resolve(name: string): unknown;
  initialObservation?(): Awaitable<CameraPoseValue | undefined>;
}
/** Captured context binds the original viewport/object/native operation. */
export interface AsyncNavigationAdapter<C = unknown> {
  captureContext(): Awaitable<C | undefined>;
  isCurrent(context: C): Awaitable<boolean>;
  beginQuery(context: C): Awaitable<AsyncNavigationCapture>;
  applyPose(context: C, pose: CameraPoseMessage | ObjectPoseMessage, navigation: NavigationStateMessage | undefined, pivot: Vec3 | undefined): Awaitable<WriteResult>;
  showPivot?(context: C, point: Vec3 | undefined): Awaitable<void>;
}

export interface AsyncNavigationSessionOptions<C, O> {
  observation?: (context: C) => Awaitable<CameraPoseValue | undefined>;
  comparison?: PoseComparison;
  objectAdapter?: AsyncNavigationAdapter<O>;
  objectObservation?: (context: O) => Awaitable<CameraPoseValue | undefined>;
  objectComparison?: PoseComparison;
  timeout?: number;
  maxQueries?: number;
  maxWork?: number;
  drainBudget?: number;
  observer?: (event: string, values: Record<string, unknown>) => void;
  /** Typed passive event callback. Legacy observer remains supported. */
  onEvent?: NavigationObserver;
  diagnostics?: NavigationDiagnostics;
}
interface Stream<C = any> { state: SessionState; adapter?: AsyncNavigationAdapter<C>; observation?: (context: C) => Awaitable<CameraPoseValue | undefined>; bound?: { token: Token; context: C }; pivot?: Vec3 }
interface QueryWork { query: NavigationQuery; token?: Token; epoch: number }
interface Work { kind: string; token?: Token; value?: any; stream?: Stream }
const monotonic = () => performance.now() / 1000;


/** Serialized awaitable host operations with independent camera/object reconciliation.
 * Runs on the owning event loop. Hosts must time out their own remote operations.
 * Retirement prevents stale completions from seeding a new gesture; it cannot undo
 * a remote write that was already issued. */
export class AsyncNavigationSession<C = unknown, O = unknown> implements OpenAxisListener {
  private readonly camera: Stream<C>;
  private readonly object: Stream<O>;
  private readonly clock: () => number;
  private readonly maxQueries: number;
  private readonly maxWork: number;
  private readonly budget: number;
  private readonly detach: () => void;
  private readonly performance = new NavigationPerformance();
  private queue: Work[] = [];
  private queries = new Set<QueryWork>();
  private send?: (message: StandardMessage) => void;
  private worker?: Promise<void>;
  private closed = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private cleanup?: string;
  private uiGesture?: OpenAxisInteger;
  private navigation?: NavigationStateMessage;
  private deferred?: Work;

  constructor(private client: OpenAxisClient, adapter: AsyncNavigationAdapter<C>, private options: AsyncNavigationSessionOptions<C, O> = {}) {
    this.clock = monotonic;
    this.maxQueries = options.maxQueries ?? 32; this.maxWork = options.maxWork ?? 64; this.budget = options.drainBudget ?? 32;
    for (const limit of [this.maxQueries, this.maxWork, this.budget]) if (!Number.isInteger(limit) || limit < 1) throw new TypeError("Queue limits must be positive integers");
    this.camera = { state: new SessionState(options.comparison, options.timeout), adapter, observation: options.observation };
    this.object = { state: new SessionState(options.objectComparison, options.timeout, "object"), adapter: options.objectAdapter, observation: options.objectObservation };
    options.diagnostics?.bind(options.comparison, options.objectComparison);
    this.detach = client.attachNavigation(this);
    try { if (client.state === ConnectionState.Connected) this.onStateChange(client.state) }
    catch (error) { this.detach(); throw error }
  }
  private notify<K extends keyof NavigationEventMap>(event: K, values: NavigationEventMap[K]): void {
    try { this.options.diagnostics?.observe(event, values) } catch { /* passive */ }
    try { this.options.onEvent?.({ event, values } as NavigationEvent) } catch { /* passive */ }
    try { this.options.observer?.(event, values as unknown as Record<string,unknown>) } catch { /* passive */ }
  }
  private wake(): void {
    if (this.worker || (!this.queue.length && !this.cleanup && !this.camera.state.ending)) return;
    this.worker = Promise.resolve().then(() => this.drain()).finally(() => {
      this.worker = undefined; this.wake();
    });
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
    if (bound) { this.enqueue({ kind: "validate", token: bound.token }); this.wake() }
  }
  private async valid(token: Token): Promise<boolean> {
    if (this.closed || !this.camera.state.current(token)) return false;
    let valid = true;
    for (const stream of [this.camera, this.object] as Stream[]) if (stream.bound) {
      if (this.closed || !this.camera.state.current(token)) return false;
      try { valid = await stream.adapter!.isCurrent(stream.bound.context) && valid } catch { valid = false }
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
  private async query(work: QueryWork): Promise<void> {
    if (!this.queries.has(work)) return;
    const current = () => !this.closed && this.queries.has(work) && work.epoch === this.camera.state.epoch && (!work.token || this.camera.state.current(work.token));
    const started = this.clock();
    this.notify("query_started", { query: work.query });
    const captures = new Map<Stream, { context: any; capture: AsyncNavigationCapture }>();
    try {
      const result = await work.query.evaluateAsync(async name => {
        if (!current()) return UNAVAILABLE;
        const stream: Stream = name.startsWith("object.") ? this.object : this.camera;
        let value: unknown = UNAVAILABLE;
        let error: string | undefined;
        const factStarted = this.clock();
        try {
          if (stream.adapter) {
            let item = captures.get(stream);
            if (!item) {
              const context = work.token && stream.bound ? stream.bound.context : await stream.adapter.captureContext();
              if (current() && context !== undefined && await stream.adapter.isCurrent(context) && current()) {
                const capture = await stream.adapter.beginQuery(context);
                if (!current()) return UNAVAILABLE;
                item = { context, capture }; captures.set(stream, item);
                if (stream === this.camera || !captures.has(this.camera)) this.notify("query_context", { query: work.query, context });
              }
            }
            if (!current()) return UNAVAILABLE;
            value = (await item?.capture.resolve(name)) ?? UNAVAILABLE;
            if (!current()) return UNAVAILABLE;
            if (value !== UNAVAILABLE && name === "camera.pose") parseCameraPoseValue(value);
            if (value !== UNAVAILABLE && name === "object.pose") { const p = asMap(value); vec3Value(p.t, "object.pose.t"); vec3Value(p.r, "object.pose.r") }
          }
        } catch (caught) { value = UNAVAILABLE; error = String(caught) }
        if (!current()) return UNAVAILABLE;
        this.notify("fact", { query: work.query, name, value, error, durationMs: (this.clock() - factStarted) * 1000 });
        return value;
      });
      let valid = !this.closed && this.queries.has(work) && work.epoch === this.camera.state.epoch && (!work.token || await this.valid(work.token));
      const observations = new Map<Stream, CameraPoseValue | undefined>();
      for (const [stream, item] of captures) {
        if (!current()) { valid = false; break }
        valid = await stream.adapter!.isCurrent(item.context) && valid;
        if (!current()) { valid = false; break }
        try { observations.set(stream, stream.observation ? await item.capture.initialObservation?.() : undefined) } catch { /* unknown */ }
        if (!current()) { valid = false; break }
        valid = await stream.adapter!.isCurrent(item.context) && valid;
      }
      // Observation and validation can reenter the session.
      valid = valid && !this.closed && this.queries.has(work) && work.epoch === this.camera.state.epoch && (!work.token || await this.valid(work.token));
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
  private async process(work: Work): Promise<void> {
    const token = work.token!;
    if (!await this.valid(token)) return;
    if (work.kind === "validate") return;
    if (work.kind === "navigation") { this.navigation = work.value; this.notify("navigation_state", { state: work.value }) }
    else {
      const stream = work.stream!;
      if (!stream.bound) return;
      if (work.kind === "pivot") {
        stream.pivot = work.value;
        try { await stream.adapter?.showPivot?.(stream.bound.context, stream.pivot) } catch { /* optional */ }
      } else {
        if (stream === this.camera && work.kind === "pose" && this.needsPivot()) { this.deferred = work; return }
        let actual: CameraPoseValue | undefined;
        const perf = this.performance.stream(token, stream === this.object);
        let receivedAt = work.kind === "pose" ? perf?.process(work.value.pose.seq, this.clock()) : undefined;
        if (stream.observation) {
          const started = this.clock();
          try { actual = await stream.observation(stream.bound.context) } catch { /* unknown */ }
          perf?.observation.add(this.clock() - started);
        }
        if (!await this.valid(token)) return;
        // Reuse a slow read for the newest adjacent pose without crossing a query/feedback boundary.
        const next = this.queue[0];
        if (work.kind === "pose" && next?.kind === "pose" && next.stream === stream
          && next.token?.epoch === token.epoch && next.token?.generation === token.generation) {
          work = this.queue.shift()!;
          if (perf) { perf.coalesced++; receivedAt = perf.process(work.value.pose.seq, this.clock()) }
        }
        const accepted = work.value as AcceptedPose;
        const before = stream.state.pendingId;
        let effect = work.kind === "pose" ? stream.state.process(accepted, actual, this.clock()) : stream.state.observe(token, actual, this.clock());
        if (work.kind === "pose" && before !== undefined && before !== stream.state.pendingId && (accepted.pose.applied_delta_id ?? -1) >= before) this.notify(stream === this.object ? "object_correction_applied" : "correction_applied", { deltaId: before });
        if (effect.kind === "apply") {
          if (!await this.valid(token)) { stream.state.complete(effect.write!, undefined, this.clock(), false); return }
          let result: WriteResult;
          const context = stream.bound.context;
          const applyStarted = this.clock();
          try { result = await stream.adapter!.applyPose(stream.bound.context, accepted.pose, this.navigation, stream.pivot) } catch { result = { success: false } }
          perf?.applied(applyStarted, this.clock(), result.success, receivedAt);
          await this.valid(token);
          effect = stream.state.complete(effect.write!, stream === this.object || stream.observation ? result.realizedPose : undefined, this.clock(), result.success);
          // Do not attach late diagnostic evidence to a replacement gesture.
          if (this.camera.state.current(token) || effect.kind === "cancel") this.notify(stream === this.object ? "object_write" : "camera_write",
            { context, desired: accepted.pose, realized: result.realizedPose, success: result.success });
          if (result.success && this.camera.state.current(token)) this.notify(stream === this.object ? "object_applied" : "camera_applied", { desired: accepted.pose, realized: result.realizedPose });
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
        if (stream.state.deadline !== undefined) {
          const timer = setTimeout(() => {
            this.timers.delete(timer);
            this.effect(stream, stream.state.expire(token, effect.deltaId!, this.clock()));
          }, Math.max(1, Math.ceil((stream.state.deadline - this.clock()) * 1000)));
          this.timers.add(timer);
        }
      } catch { this.effect(stream, stream.state.sendFailed(token, effect.deltaId!)) }
    }
    this.wake();
  }
  private async drain(): Promise<void> {
    try {
      for (let count = 0; count < this.budget; count++) {
        if (this.cleanup) {
          const reason = this.cleanup; this.cleanup = undefined;
          for (const stream of [this.camera, this.object] as Stream[]) {
            if (stream.bound) try { await stream.adapter?.showPivot?.(stream.bound.context, undefined) } catch { /* optional */ }
            stream.bound = undefined; stream.pivot = undefined;
          }
          this.navigation = undefined; this.deferred = undefined;
          if (this.uiGesture !== undefined) { const gestureId = this.uiGesture; this.uiGesture = undefined; this.notify("gesture_finished", { gestureId, reason }) }
        }
        if (this.cleanup) continue; // Another transition occurred during awaited cleanup.
        const gestureId = this.closed ? undefined : this.camera.state.gestureId;
        if (gestureId !== undefined && this.uiGesture !== gestureId) { this.uiGesture = gestureId; this.notify("gesture_started", { gestureId }) }
        const work = this.queue.shift();
        if (!work) {
          if (this.camera.state.ending) { this.performance.finish("motion_end", this.clock()); this.camera.state.finish(this.camera.state.token); this.object.state.finish(this.object.state.token); this.cleanup = "motion_end" }
          break;
        }
        if (work.kind === "query") await this.query(work.value); else await this.process(work);
      }
    } catch { this.effect(this.camera, this.camera.state.cancel(this.camera.state.token, "host_operation_failed")) }
    finally { this.performance.flush() }
  }
  /** Wait for issued host operations before disposing the host transport. */
  async close(): Promise<void> {
    if (!this.closed) {
      this.performance.finish("closed", this.clock());
    this.closed = true; this.camera.state.connection(); this.object.state.connection();
      for (const query of this.queries) this.reply(query);
      this.queue = []; this.cleanup = "closed";
      for (const timer of this.timers) clearTimeout(timer);
      this.timers.clear(); this.wake();
    }
    // Retain exclusive ownership while an issued remote operation is settling.
    while (this.worker) await this.worker;
    this.detach();
  }
}
