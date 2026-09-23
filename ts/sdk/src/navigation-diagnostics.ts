import { emitDiagnosticLog } from "./logging.js";
import { formatEvent, type DiagnosticLevel } from "./diagnostics.js";
import { Quat } from "./geometry/quat.js";
import { Vec3 } from "./geometry/vec3.js";
import { UNAVAILABLE, wireFactValue } from "./navigation.js";
import type { NavigationEvent, NavigationEventMap } from "./navigation-observer.js";
import { comparePoses, compareObjectPoses, type PoseComparison, type ObjectPoseComparison } from "./session-state.js";
import type { OpenAxisInteger, Vec3 as Point } from "./protocol/types.js";

export const DIAGNOSTIC_COLORS = Object.freeze({
  text: [245,245,245], missing: [255,130,130], skipped: [165,165,165], pass: [80,255,110],
  selection: [255,150,40], model: [40,210,255], target: [255,70,220], cursor: [255,235,40],
  center: [100,170,255], object: [255,70,220], sketch: [190,120,255], axis_x: [255,60,60],
  axis_y: [60,255,60], axis_z: [60,130,255], ray: [175,175,175], correction: [255,210,40],
} satisfies Record<string, readonly [number,number,number]>);
for (const color of Object.values(DIAGNOSTIC_COLORS)) Object.freeze(color);
export type DiagnosticTone = keyof typeof DIAGNOSTIC_COLORS;
export interface DiagnosticLine { text: string; tone: DiagnosticTone }
export interface DiagnosticSegment { start: Point; end: Point; tone: DiagnosticTone; width: number; opacity: number }
export interface DiagnosticMarker { label: string; point: [number,number]; tone: DiagnosticTone }
export interface DiagnosticPresentation {
  /** Opaque application identity; never dereferenced or cloned. */
  context: unknown;
  lines: DiagnosticLine[];
  segments: DiagnosticSegment[];
  markers: DiagnosticMarker[];
  revision: number;
  /** Monotonic seconds. Expiry alone does not emit onChanged. */
  expiresAt?: number;
}
export interface DiagnosticHistoryEntry { time: number; level: DiagnosticLevel; message: string }
export interface NavigationDiagnosticsOptions {
  enabled?: boolean;
  log?: (level: DiagnosticLevel, message: string) => void;
  clock?: () => number;
  historyLimit?: number;
  retention?: number;
  logLevel?: "info" | "debug";
  onChanged?: () => void;
  contextKey?: (context: unknown) => unknown;
}
interface Fact { value: unknown; durationMs: number; error?: string }
interface Pick { screen?: [number,number]; ray?: [Point,Point] }
interface QueryEvidence {
  requestId: OpenAxisInteger; gestureId?: OpenAxisInteger; values: string[]; first: string[];
  context?: unknown; facts: Map<string,Fact>; picks: Map<string,Pick>;
  selected?: string; durationMs: number; error?: string; complete: boolean;
}
type Stream = "camera" | "object";
const record = (v: unknown): Record<string,unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string,unknown> : {};
const point = (v: unknown): Point | undefined => Array.isArray(v) && v.length === 3 && v.every(x => typeof x === "number" && Number.isFinite(x)) ? [...v] as Point : undefined;
function bounds(v: unknown): [Point,Point] | undefined {
  const b = record(v), low = point(b.min), high = point(b.max);
  return low && high && low.every((x,i) => x <= high[i]!) ? [low,high] : undefined;
}
function tone(name: string): DiagnosticTone {
  if (name.startsWith("pick.")) return name.includes("cursor") ? "cursor" : "center";
  return ({ "selection.bounds": "selection", "model.bounds": "model", "object.bounds": "object", "object.pose": "object",
    "scene.cursor": "target", "sketch.plane": "sketch", "camera.view_target": "target" } as Record<string,DiagnosticTone>)[name] ?? "text";
}
const short = (n: number) => Number(n.toPrecision(3)).toString();

/** Passive, renderer-independent evidence. All operations belong to the session thread. */
export class NavigationDiagnostics {
  private active: boolean;
  private version = 0;
  private readonly clock: () => number;
  private readonly limit: number;
  private readonly retention: number;
  private entries: DiagnosticHistoryEntry[] = [];
  private query?: QueryEvidence;
  private context?: unknown;
  private status?: string;
  private writes = new Map<Stream,DiagnosticLine>();
  private corrections = new Map<Stream,{ id: OpenAxisInteger; state: string; until?: number }>();
  private loggedCorrections = new Map<Stream,string>();
  private unknownReadback = new Map<Stream,boolean>();
  private comparison: PoseComparison = comparePoses;
  private objectComparison: ObjectPoseComparison = compareObjectPoses;
  onChanged?: () => void;

  constructor(private readonly options: NavigationDiagnosticsOptions = {}) {
    this.active = options.enabled ?? false;
    this.clock = options.clock ?? (() => performance.now() / 1000);
    this.limit = options.historyLimit ?? 30;
    this.retention = options.retention ?? 1;
    if (!Number.isInteger(this.limit) || this.limit < 1 || !Number.isFinite(this.retention) || this.retention < 0) throw new TypeError("Invalid diagnostic limits");
    this.clear();
    this.onChanged = options.onChanged;
  }
  get enabled(): boolean { return this.active }
  get revision(): number { return this.version }
  get history(): DiagnosticHistoryEntry[] { return this.entries.map(x => ({ ...x })) }
  bind(comparison: PoseComparison = comparePoses, objectComparison: ObjectPoseComparison = compareObjectPoses): void {
    this.comparison = comparison; this.objectComparison = objectComparison;
  }
  private touch(): void { this.version++; try { this.onChanged?.() } catch { /* passive */ } }
  private reset(): void {
    this.query = undefined; this.context = undefined; this.status = undefined;
    this.writes.clear(); this.corrections.clear(); this.entries = [];
  }
  clear(): void { this.reset(); this.touch() }
  setEnabled(value: boolean): void { if (this.active !== value) { this.active = value; this.clear() } }
  private assignContext(context: unknown): void {
    if (this.context !== context) { this.writes.clear(); this.corrections.clear() }
    this.context = context;
    if (this.query && !this.query.complete) this.query.context = context;
  }
  setContext(context: unknown): void { if (this.active) { this.assignContext(context); this.touch() } }
  pick(requestId: OpenAxisInteger, name: string, evidence: Pick): void {
    if (this.active && this.query && !this.query.complete && this.query.requestId === requestId) {
      this.query.picks.set(name, structuredClone(evidence)); this.touch();
    }
  }
  observe<K extends keyof NavigationEventMap>(event: K, values: NavigationEventMap[K]): void {
    try { this.consume({ event, values } as NavigationEvent) } catch { /* A diagnostic failure cannot fail navigation. */ }
  }
  private log(level: DiagnosticLevel, message: string, retain = true): void {
    if (level !== "debug" || this.options.logLevel === "debug") {
      try { (this.options.log ?? emitDiagnosticLog)(level, message) } catch { /* passive */ }
    }
    if (this.active && retain) {
      this.entries.push({ time: this.clock(), level, message });
      if (this.entries.length > this.limit) this.entries.shift();
    }
  }
  private consume(e: NavigationEvent): void {
    switch (e.event) {
      case "gesture_started":
        this.loggedCorrections.clear(); this.unknownReadback.clear();
        this.log("info", `gesture_started: gesture_id=${e.values.gestureId}`, false);
        if (this.active) { this.reset(); this.status = `gesture ${e.values.gestureId} started` }
        break;
      case "gesture_finished": case "cancelled": {
        const { gestureId, reason } = e.values;
        this.log("info", `${e.event}: gesture_id=${gestureId}, reason=${reason}`);
        if (this.active) {
          this.status = `gesture finished: ${reason}`;
          for (const c of this.corrections.values()) { c.state = "ended"; c.until = this.clock() + this.retention }
        }
        break;
      }
      case "output_rejected": {
        const v = e.values, message = `output_rejected: kind=${v.kind}, gesture_id=${v.gestureId}, reason=${v.reason}`;
        this.log("warning", message); if (this.active) this.status = message;
        break;
      }
      case "query_started": {
        const q = e.values.query;
        if (this.active) this.query = { requestId: q.requestId, gestureId: q.gestureId, values: [...q.values], first: [...q.first],
          facts: new Map(), picks: new Map(), durationMs: 0, complete: false };
        break;
      }
      case "query_context":
        if (this.active) this.assignContext(this.options.contextKey ? this.options.contextKey(e.values.context) : e.values.context);
        break;
      case "fact": {
        const v = e.values, value = wireFactValue(v.name, v.value), available = value != null && value !== UNAVAILABLE;
        const marker = record(v.value).markerPosition;
        if (v.name.startsWith("pick.") && Array.isArray(marker) && marker.length === 2 && marker.every(x => typeof x === "number" && Number.isFinite(x)))
          this.pick(v.query.requestId, v.name, { screen: [marker[0], marker[1]] });
        this.log("info", formatEvent("navigation.fact", { fact: v.name, result: v.error ? "error" : available ? "ok" : "missing",
          value: available ? value : undefined, error: v.error, duration_ms: v.durationMs }), false);
        if (this.active && this.query?.requestId === v.query.requestId) this.query.facts.set(v.name,
          { value: available ? structuredClone(value) : undefined, durationMs: v.durationMs, error: v.error });
        break;
      }
      case "query_completed": case "query_failed": {
        const v = e.values, selected = e.event === "query_completed" ? record(e.values.result.first).name as string | undefined : undefined;
        const error = e.event === "query_failed" ? e.values.error : undefined;
        this.log(error ? "warning" : "info", error ? `query_failed: error=${error}, duration_ms=${v.durationMs}`
          : formatEvent("navigation.query.complete", { request: v.query.requestId, first: selected, duration_ms: v.durationMs }));
        if (this.active && this.query?.requestId === v.query.requestId) {
          Object.assign(this.query, { complete: true, durationMs: v.durationMs, selected, error });
        }
        break;
      }
      case "camera_write": case "object_write": {
        const stream = e.event === "camera_write" ? "camera" : "object", v = e.values;
        const unknown = v.success && !v.realized, previous = this.unknownReadback.get(stream) ?? false;
        this.unknownReadback.set(stream, unknown);
        const level = !v.success ? "warning" : unknown !== previous ? "info" : "debug";
        if (!v.success || unknown !== previous) this.log(level, `${stream} write: ${!v.success ? "failed" : unknown ? "unknown readback" : previous ? "readback recovered" : "succeeded"}`, false);
        if (this.active) {
          let state = !v.success ? "failed" : !v.realized ? "unknown readback" : "comparison unavailable", detail = "";
          if (v.success && v.realized) {
            const d = (stream === "camera" ? this.comparison : this.objectComparison)(v.desired, v.realized);
            state = d.changed || d.discontinuity ? "differs" : "equivalent";
            detail = ` | translation ${short(Math.hypot(...d.t))} application units | rotation ${short(Math.hypot(...d.r) * 180 / Math.PI)} deg`;
          }
          this.writes.set(stream, { text: `${stream} write: ${state}${detail}`, tone: state === "failed" ? "missing" : state === "equivalent" ? "pass" : "correction" });
        }
        break;
      }
      case "correction_sent": case "correction_waiting": case "correction_applied":
      case "object_correction_sent": case "object_correction_waiting": case "object_correction_applied": {
        const stream = e.event.startsWith("object_") ? "object" : "camera", v = e.values;
        const state = e.event.endsWith("applied") ? "acknowledged" : e.event.endsWith("waiting") ? "waiting" : "sent";
        const key = `${state}:${v.deltaId}`;
        if (this.loggedCorrections.get(stream) !== key) {
          const d = v.difference;
          this.log("debug", `${stream} correction ${v.deltaId}: ${state}` + (d ? ` | translation ${JSON.stringify(d.t)} | rotation ${JSON.stringify(d.r)} rad | scale ${d.scale}` : ""));
          this.loggedCorrections.set(stream, key);
        }
        if (this.active) this.corrections.set(stream, { id: v.deltaId, state, until: state === "acknowledged" ? this.clock() + this.retention : undefined });
        break;
      }
      default: return;
    }
    if (this.active) this.touch();
  }

  presentation(): DiagnosticPresentation {
    const frame: DiagnosticPresentation = { context: this.active ? this.context : undefined, lines: [], segments: [], markers: [], revision: this.version };
    if (!this.active) return frame;
    const { lines, segments, markers } = frame, q = this.query;
    const line = (text: string, tone: DiagnosticTone = "text") => lines.push({ text, tone });
    const segment = (start: Point, end: Point, tone: DiagnosticTone, width = 2, opacity = 1) => segments.push({ start: [...start], end: [...end], tone, width, opacity });
    if (q && q.context === this.context) {
      line(`Navigation diagnostics | gesture ${q.gestureId ?? "None"} | query ${q.requestId} | ${q.durationMs.toFixed(1)} ms`);
      if (q.error) line(q.error, "missing");
      for (const name of new Set([...q.values,...q.first])) {
        const f = q.facts.get(name);
        if (!f) line(`${name}: ${q.complete && q.selected && q.first.indexOf(name) > q.first.indexOf(q.selected) ? "skipped" : "not evaluated"}`, "skipped");
        else line(formatEvent("navigation.fact", { fact: name, result: f.error ? "error" : f.value == null ? "missing" : "ok",
          value: f.value, error: f.error, duration_ms: f.durationMs }) + (name === q.selected ? " < returned candidate" : ""), f.error || f.value == null ? "missing" : tone(name));
      }
      let scale = 1;
      for (const name of ["selection.bounds","model.bounds","object.bounds"]) {
        const b = bounds(q.facts.get(name)?.value);
        if (b) { scale = Math.max(.0001, Vec3.fromArray(b[1]).sub(Vec3.fromArray(b[0])).length() * .1); break }
      }
      const box = (b: [Point,Point], color: DiagnosticTone) => {
        const corners: Point[] = [];
        for (const x of [b[0][0],b[1][0]]) for (const y of [b[0][1],b[1][1]]) for (const z of [b[0][2],b[1][2]]) corners.push([x,y,z]);
        corners.forEach((start,i) => { for (const bit of [1,2,4]) if (!(i & bit)) segment(start,corners[i | bit]!,color,1,.35) });
      };
      for (const [name,f] of q.facts) {
        const v = record(f.value), color = tone(name);
        if (name === "world.orientation") {
          const forward = point(v.forward), up = point(v.up);
          if (forward && up) {
            const right = Vec3.fromArray(forward).cross(Vec3.fromArray(up)).mul(v.handedness === "left" ? -1 : 1).toArray();
            for (const [direction,color] of [[right,"axis_x"],[up,"axis_y"],[forward,"axis_z"]] as const) segment([0,0,0],Vec3.fromArray(direction).mul(scale).toArray(),color);
          }
        }
        if (name === "object.pose") {
          const origin = point(v.t), rotation = point(v.r);
          if (origin && rotation) {
            const quat = Quat.fromRotvec(...rotation);
            for (const [axis,color] of [[[1,0,0],"axis_x"],[[0,1,0],"axis_y"],[[0,0,1],"axis_z"]] as const)
              segment(origin,Vec3.fromArray(origin).add(quat.rotate(Vec3.fromArray(axis)).mul(scale)).toArray(),color);
          }
        }
        if (name === "sketch.plane") {
          const origin = point(v.origin), normal = point(v.normal), axis = point(v.x_axis);
          if (origin && normal && axis && Math.hypot(...normal) > 0 && Math.hypot(...axis) > 0) {
            const o = Vec3.fromArray(origin), n = Vec3.fromArray(normal).normalized(), x = Vec3.fromArray(axis).normalized(), y = n.cross(x).normalized();
            if (y.length() > 0) {
              for (const step of [-1,-.5,0,.5,1]) for (const [along,across] of [[x,y],[y,x]] as const)
                segment(o.add(along.mul(step * scale)).sub(across.mul(scale)).toArray(),o.add(along.mul(step * scale)).add(across.mul(scale)).toArray(),"sketch",1);
              segment(origin,o.add(n.mul(scale)).toArray(),"target");
            }
          }
        }
        const b = bounds(f.value); if (b) box(b,color);
        const p = name === "camera.view_target" || name === "scene.cursor" ? point(f.value) : point(v.point);
        if (p) for (let axis = 0; axis < 3; axis++) {
          const a: Point = [...p], b: Point = [...p]; a[axis]! -= scale * .08; b[axis]! += scale * .08; segment(a,b,color,1,.35);
        }
        const nested = bounds(v.bounds); if (nested) box(nested,color);
      }
      for (const [name,pick] of q.picks) {
        if (pick.screen) {
          const p = pick.screen, color = tone(name);
          const match = markers.find(m => m.tone === color && m.point[0] === p[0] && m.point[1] === p[1]);
          if (match) match.label += `\n${name}`; else markers.push({ label: name, point: [...p], tone: color });
        }
      }
    }
    if (this.status) line(this.status);
    for (const write of this.writes.values()) lines.push({ ...write });
    const now = this.clock();
    for (const [kind,c] of this.corrections) if (c.until === undefined || now < c.until) {
      line(`${kind} correction ${c.id}: ${c.state}`,"correction");
      if (c.until !== undefined) frame.expiresAt = Math.min(frame.expiresAt ?? Infinity,c.until);
    }
    return frame;
  }
}
