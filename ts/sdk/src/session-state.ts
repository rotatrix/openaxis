/** Pure stream state, shared behavior with Python/C# conformance traces. */
import { Quat } from "./geometry/quat.js";
import type { CameraPoseValue, ObjectPoseValue, CameraPoseMessage, ObjectPoseMessage, OpenAxisInteger, Vec3 } from "./protocol/types.js";

export interface PoseDifference { t: Vec3; r: Vec3; scale?: number; changed: boolean; discontinuity: boolean }
export interface ComparisonOptions { absolute?: number; relative?: number; angular?: number; projection?: number }
export function comparePoses(a: CameraPoseValue, b: CameraPoseValue, options: ComparisonOptions = {}): PoseDifference {
  const t = b.t.map((v, i) => v - a.t[i]!) as Vec3;
  const r = Quat.fromRotvec(...b.r).multiply(Quat.fromRotvec(...a.r).inverse()).normalize().toRotvec();
  const projection = options.projection ?? 1e-7;
  const discontinuity = (a.fov === undefined) !== (b.fov === undefined)
    || (a.fov !== undefined && b.fov !== undefined && Math.abs(a.fov - b.fov) > projection);
  const ratio = a.ortho_extent !== undefined && b.ortho_extent !== undefined ? b.ortho_extent / a.ortho_extent : 1;
  const scale = Math.abs(ratio - 1) > projection ? ratio : undefined;
  const epsilon = Math.max(options.absolute ?? 1e-7, (options.relative ?? 1e-9) * Math.max(1, Math.hypot(...a.t), Math.hypot(...b.t)));
  return { t, r, scale, discontinuity, changed: Math.hypot(...t) > epsilon || Math.hypot(...r) > (options.angular ?? 1e-7) || scale !== undefined };
}
export type PoseComparison = (a: CameraPoseValue, b: CameraPoseValue) => PoseDifference;
export type ObjectComparisonOptions = Omit<ComparisonOptions, "projection">;
export type ObjectPoseComparison = (a: ObjectPoseValue, b: ObjectPoseValue) => PoseDifference;
/** Rigid object motion has no camera projection or zoom discontinuity. */
export function compareObjectPoses(a: ObjectPoseValue, b: ObjectPoseValue, options: ObjectComparisonOptions = {}): PoseDifference {
  return comparePoses({ t: a.t, r: a.r }, { t: b.t, r: b.r }, options);
}
export interface Token { epoch: number; generation: number }
type Pose = CameraPoseMessage | ObjectPoseMessage;
export interface AcceptedPose { token: Token; pose: Pose }
export interface Write { accepted: AcceptedPose }
export interface Effect { kind: string; token?: Token; gestureId?: OpenAxisInteger; deltaId?: OpenAxisInteger; difference?: PoseDifference; write?: Write; reason?: string; pose?: CameraPoseValue }
export const sameInteger = (a: OpenAxisInteger | undefined, b: OpenAxisInteger | undefined): boolean =>
  a === b;

export class SessionState {
  epoch = 0; generation = 0; gestureId?: OpenAxisInteger;
  lastReceived: OpenAxisInteger = -1; lastApplied: OpenAxisInteger = -1;
  private lastConsumed: OpenAxisInteger = -1;
  nextDeltaId: OpenAxisInteger = 0;
  baseline?: CameraPoseValue; pendingId?: OpenAxisInteger; deadline?: number;
  /** Requested reference for an unobserved successful write, never an actual baseline. */
  private requestedReference?: CameraPoseValue;
  ready = false; ending = false;
  private write?: Write;
  private comparison: PoseComparison;
  constructor(comparison: PoseComparison | undefined = undefined, private timeout = 1, readonly stream = "camera") {
    this.comparison = comparison ?? (stream === "object" ? compareObjectPoses : comparePoses);
    if (!Number.isFinite(timeout) || timeout <= 0) throw new TypeError("timeout must be positive and finite");
  }
  get token(): Token { return { epoch: this.epoch, generation: this.generation } }
  current(token: Token): boolean { return token.epoch === this.epoch && token.generation === this.generation && this.gestureId !== undefined }
  private retire(): void {
    this.generation++; this.gestureId = undefined; this.ready = this.ending = false;
    this.baseline = undefined; this.requestedReference = undefined; this.pendingId = undefined; this.deadline = undefined;
  }
  connection(): void { this.retire(); this.epoch++; this.lastReceived = this.lastApplied = this.lastConsumed = -1; this.nextDeltaId = 0 }
  start(gestureId: OpenAxisInteger): Token { this.retire(); this.gestureId = gestureId; return this.token }
  end(token: Token): boolean { if (!this.current(token)) return false; this.ending = true; return true }
  finish(token: Token): boolean { if (!this.current(token)) return false; this.retire(); return true }
  query(token: Token, actual?: CameraPoseValue, scoped = true, supplied = true, allowEnding = false): boolean {
    if (!scoped || !supplied || !this.current(token) || (this.ending && !allowEnding) || this.write) return false;
    if (!this.ready) { this.ready = true; this.baseline = actual }
    return true;
  }
  receive(epoch: number, pose: Pose): AcceptedPose | undefined {
    if (epoch !== this.epoch || this.gestureId === undefined || this.ending || !sameInteger(pose.gesture_id, this.gestureId)
      || pose.seq === undefined || pose.seq <= this.lastReceived) return;
    this.lastReceived = pose.seq;
    return { token: this.token, pose };
  }
  cancel(token: Token, reason: string): Effect {
    if (!this.current(token)) return { kind: "reject" };
    const gestureId = this.gestureId; this.retire();
    return { kind: "cancel", token, gestureId, reason };
  }
  sendFailed(token: Token, deltaId: OpenAxisInteger): Effect {
    return this.current(token) && sameInteger(deltaId, this.pendingId) ? this.cancel(token, `${this.stream}_delta_send_failed`) : { kind: "reject" };
  }
  expire(token: Token, deltaId: OpenAxisInteger, now: number): Effect {
    return this.current(token) && sameInteger(deltaId, this.pendingId) && this.deadline !== undefined && now >= this.deadline
      ? this.cancel(token, `${this.stream}_delta_timeout`) : { kind: "reject" };
  }
  private delta(actual: CameraPoseValue, difference: PoseDifference, now: number): Effect {
    if (this.nextDeltaId > Number.MAX_SAFE_INTEGER) return this.cancel(this.token, `${this.stream}_delta_id_exhausted`);
    const deltaId = this.nextDeltaId;
    this.nextDeltaId++;
    this.pendingId = deltaId; this.deadline = now + this.timeout; this.baseline = actual;
    this.requestedReference = undefined;
    return { kind: "delta", token: this.token, gestureId: this.gestureId, deltaId, difference };
  }
  private rebase(actual: CameraPoseValue, now: number): Effect {
    if (this.ending) return { kind: "hold" };
    const barrier = this.delta(actual, { t: [0,0,0], r: [0,0,0], changed: false, discontinuity: false }, now);
    return barrier.kind === "cancel" ? barrier : { ...barrier, kind: "rebase", pose: actual };
  }
  observe(token: Token, actual: CameraPoseValue | undefined, now: number): Effect {
    if (!this.current(token) || !this.ready) return { kind: "reject" };
    if (this.write) return { kind: "hold" };
    if (!actual) return { kind: "skip" };
    const reference = this.baseline ?? this.requestedReference;
    if (!reference) { this.baseline = actual; return { kind: "skip" } }
    const difference = this.comparison(reference, actual);
    if (difference.discontinuity) return this.rebase(actual, now);
    if (!difference.changed) {
      if (!this.baseline) { this.baseline = actual; this.requestedReference = undefined }
      return { kind: "skip" };
    }
    if (this.pendingId !== undefined || this.ending) return { kind: "hold" };
    return this.delta(actual, difference, now);
  }
  process(accepted: AcceptedPose, actual: CameraPoseValue | undefined, now: number): Effect {
    const pose = accepted.pose;
    if (!this.current(accepted.token) || !this.ready || !sameInteger(pose.seq, this.lastReceived) || pose.seq! <= this.lastConsumed) return { kind: "reject" };
    if (this.write) return { kind: "hold" };
    const acknowledged = this.pendingId !== undefined && pose.applied_delta_id !== undefined && pose.applied_delta_id >= this.pendingId;
    if (acknowledged) { this.pendingId = undefined; this.deadline = undefined }
    const observation = this.observe(accepted.token, actual, now);
    if (observation.kind !== "skip") return observation;
    if (this.pendingId !== undefined) return { kind: "hold" };
    // A last known actual pose can suppress an unchanged command even when
    // observation is temporarily unavailable. Never use requestedReference.
    const realized = actual ?? this.baseline;
    if (realized) {
      const difference = this.comparison(realized, pose);
      if (!difference.changed && !difference.discontinuity) { this.lastConsumed = pose.seq!; return { kind: "skip" } }
    }
    this.write = { accepted };
    return { kind: "apply", token: this.token, gestureId: this.gestureId, write: this.write };
  }
  complete(write: Write, actual: CameraPoseValue | undefined, now: number, success = true): Effect {
    if (this.write !== write) return { kind: "reject" };
    this.write = undefined;
    if (!this.current(write.accepted.token)) return { kind: "reject" };
    if (!success) return this.cancel(write.accepted.token, `${this.stream}_write_failed`);
    this.lastApplied = this.lastConsumed = write.accepted.pose.seq!;
    this.baseline = actual;
    this.requestedReference = actual ? undefined : write.accepted.pose;
    if (actual && !this.ending) {
      const difference = this.comparison(write.accepted.pose, actual);
      if (difference.discontinuity) return this.rebase(actual, now);
      if (difference.changed) return this.delta(actual, difference, now);
    }
    return { kind: "skip" };
  }
}
