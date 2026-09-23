import { emitDiagnosticLog } from "./logging.js";
import type { OpenAxisInteger } from "./protocol/types.js";
import type { Token } from "./session-state.js";

// Fixed-size accumulators; serialization and logging happen only at retirement.
class Timing {
  count = 0; total = 0; max = 0;
  add(seconds: number): void { const ms = Math.max(0, seconds * 1000); this.count++; this.total += ms; this.max = Math.max(this.max, ms) }
  text(): string { return `${(this.count ? this.total / this.count : 0).toFixed(1)}/${this.max.toFixed(1)} [${this.count}]` }
}
export class PerformanceStream {
  received = 0; coalesced = 0; succeeded = 0; failed = 0;
  incomingGap = new Timing(); queueWait = new Timing(); observation = new Timing(); apply = new Timing(); applyGap = new Timing();
  turnaround = new Timing();
  private lastReceived?: number; private lastApply?: number;
  private pending?: OpenAxisInteger; private queuedAt = 0;
  receive(sequence: OpenAxisInteger, now: number): void {
    this.received++;
    if (this.lastReceived !== undefined) this.incomingGap.add(now - this.lastReceived);
    this.lastReceived = now; this.pending = sequence; this.queuedAt = now;
  }
  process(sequence: OpenAxisInteger, now: number): number | undefined {
    if (this.pending !== sequence) return;
    this.queueWait.add(now - this.queuedAt); this.pending = undefined;
    return this.queuedAt;
  }
  applied(start: number, end: number, success: boolean, receivedAt?: number): void {
    if (this.lastApply !== undefined) this.applyGap.add(start - this.lastApply);
    this.lastApply = start; this.apply.add(end - start);
    if (success) { this.succeeded++; if (receivedAt !== undefined) this.turnaround.add(end - receivedAt) } else this.failed++;
  }
  text(name: string): string {
    if (!this.received && !this.observation.count && !this.apply.count) return `${name}: no activity`;
    const overall = this.turnaround.count
      ? `turnaround avg ${(this.turnaround.total / this.turnaround.count).toFixed(1)} ms, max ${this.turnaround.max.toFixed(1)} ms [${this.turnaround.count} applied]`
      : "no updates applied";
    const replaced = this.received ? 100 * this.coalesced / this.received : 0;
    return `${name} responsiveness: ${overall}; pending poses replaced ${replaced.toFixed(1)}%\n`
      + `${name}: poses ${this.received}, coalesced ${this.coalesced}, writes ${this.succeeded} ok/${this.failed} failed\n`
      + `  timings avg/max ms [samples]: input gap ${this.incomingGap.text()}; queue wait ${this.queueWait.text()}; observation ${this.observation.text()}; apply ${this.apply.text()}; apply gap ${this.applyGap.text()}`;
  }
}
class Gesture {
  camera = new PerformanceStream(); object = new PerformanceStream(); reason = ""; ended = 0;
  constructor(readonly id: OpenAxisInteger, readonly token: Token, readonly started: number) {}
}
export class NavigationPerformance {
  private active?: Gesture; private retired: Gesture[] = [];
  begin(id: OpenAxisInteger, token: Token, now: number): void {
    this.finish("superseded", now); this.active = new Gesture(id, token, now);
  }
  stream(token: Token, objects = false): PerformanceStream | undefined {
    const g = this.active;
    return g && g.token.epoch === token.epoch && g.token.generation === token.generation ? (objects ? g.object : g.camera) : undefined;
  }
  finish(reason: string, now: number, token?: Token): void {
    if (!this.active || (token && !this.stream(token))) return;
    const g = this.active; this.active = undefined; g.reason = reason; g.ended = now; this.retired.push(g);
  }
  flush(): void {
    if (!this.retired.length) return;
    const retired = this.retired; this.retired = [];
    for (const g of retired) try {
      emitDiagnosticLog("info", `navigation.performance gesture=${g.id} reason=${g.reason} duration=${Math.max(0, (g.ended - g.started) * 1000).toFixed(1)} ms\n${g.camera.text("camera")}\n${g.object.text("object")}`);
    } catch { /* Diagnostics must not affect navigation. */ }
  }
}
