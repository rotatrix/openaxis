import { emitDiagnosticLog } from "./logging.js";
import { ConnectionState, type OpenAxisClient } from "./client.js";
import { formatEvent, type DiagnosticLevel } from "./diagnostics.js";
import { PROTO_VERSION } from "./protocol/types.js";

export type ConnectionManagerState = "stopped" | "connecting" | "ready" | "retrying" | "stopping";
export interface ConnectionMetadata {
  tags?: readonly string[];
  capabilities?: readonly string[];
  axes?: readonly string[];
  focused?: boolean;
}
export interface RetryPolicy {
  initialDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
  jitter?: number;
}
export interface OpenAxisConnectionManagerOptions {
  metadata: () => ConnectionMetadata;
  /** Optional wrapper setup. Must honor abort and settle before cleanup can finish. */
  connect?: (signal: AbortSignal) => Promise<void>;
  retry?: RetryPolicy;
  startupTimeoutMs?: number;
  onState?: (state: ConnectionManagerState, error?: unknown, retryDelayMs?: number) => void;
  /** Receives SDK-formatted lifecycle messages; defaults to the console. */
  log?: (level: DiagnosticLevel, message: string) => void;
}

/** Owns one client's connection operations; keep its NavigationSession attached. */
export class OpenAxisConnectionManager {
  private task?: Promise<void>;
  private outageLogged = false;
  private controller?: AbortController;
  private currentState: ConnectionManagerState = "stopped";
  private readonly retry: Required<RetryPolicy>;
  private readonly timeout: number;
  private announcements: Promise<void> = Promise.resolve();

  constructor(private readonly client: OpenAxisClient, private readonly options: OpenAxisConnectionManagerOptions) {
    this.retry = { initialDelayMs: 2_000, maxDelayMs: 4_000, multiplier: 2, jitter: 0.2, ...options.retry };
    this.timeout = options.startupTimeoutMs ?? 5_000;
    const r = this.retry;
    if (![r.initialDelayMs, r.maxDelayMs, r.multiplier, r.jitter, this.timeout].every(Number.isFinite)
      || r.initialDelayMs <= 0 || r.maxDelayMs < r.initialDelayMs || r.multiplier < 1
      || r.maxDelayMs > 2_147_483_647 || this.timeout > 2_147_483_647
      || r.jitter < 0 || r.jitter > 1 || this.timeout <= 0) throw new TypeError("Invalid lifecycle timing options");
  }

  get state(): ConnectionManagerState { return this.currentState }

  /** Repeated start calls share the running task, including while it is stopping. */
  start(): Promise<void> {
    if (this.task) return this.task;
    if (this.client.state !== ConnectionState.Disconnected) throw new Error("Client already in use");
    const controller = this.controller = new AbortController();
    // Defer callbacks until the ownership task has been stored.
    this.task = Promise.resolve().then(() => this.run(controller.signal)).finally(() => {
      this.task = undefined;
      this.controller = undefined;
      this.notify("stopped");
    });
    return this.task;
  }

  async stop(): Promise<void> {
    if (!this.task) return;
    this.notify("stopping");
    this.controller!.abort();
    await this.task;
  }

  async refreshMetadata(): Promise<void> {
    if (this.state === "ready") await this.announce();
  }

  private announce(): Promise<void> {
    const send = this.client.captureNavigationSender();
    const next = this.announcements.then(async () => {
      const value = this.options.metadata();
      send({ type: "tags", tags: [...(value.tags ?? [])] });
      send({ type: "capabilities", capabilities: [...(value.capabilities ?? [])] });
      if (value.axes !== undefined) send({ type: "subscribe", axes: [...value.axes] });
      if (value.focused !== undefined) send({ type: "focus", focused: value.focused });
    });
    this.announcements = next.catch(() => {});
    return next;
  }

  private notify(state: ConnectionManagerState, error?: unknown, delay?: number): void {
    const suppress = this.outageLogged && (state === "connecting" || state === "retrying");
    if (state === "retrying") this.outageLogged = true;
    else if (state === "ready" || state === "stopped") this.outageLogged = false;
    this.currentState = state;
    try {
      const log = this.options.log ?? emitDiagnosticLog;
      if (state === "connecting" && !suppress) log("info", formatEvent("connection.start", { url: this.client.url }));
      else if (state === "ready") log("info", formatEvent("connection.open", { url: this.client.url, protocol: PROTO_VERSION }));
      else if (state === "retrying" && !suppress) log("warning", formatEvent("connection.retry_failed", {
        error: error instanceof Error ? error.message : error == null ? "connection lost" : String(error), retry_delay_s: (delay ?? 0) / 1000,
      }));
      else if (state === "stopped") log("info", formatEvent("connection.stop"));
    } catch (error) { console.error("OpenAxis lifecycle log sink failed", error) }
    try { this.options.onState?.(state, error, delay) }
    catch (error) { console.error("OpenAxis lifecycle observer failed", error) }
  }

  private async run(signal: AbortSignal): Promise<void> {
    let delay = this.retry.initialDelayMs;
    while (!signal.aborted) {
      let error: unknown;
      this.notify("connecting");
      const startup = new AbortController();
      const cancel = () => startup.abort();
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      const timer = setTimeout(cancel, this.timeout);
      try {
        await this.interruptible(async () => {
          await (this.options.connect?.(startup.signal) ?? this.client.connect());
          if (startup.signal.aborted) throw new Error("Startup cancelled or timed out");
          await this.announce();
        }, startup.signal);
        if (signal.aborted) break;
        if (this.client.state !== ConnectionState.Connected) throw new Error("Connection lost during startup");
        clearTimeout(timer);
        this.notify("ready");
        delay = this.retry.initialDelayMs;
        await this.waitForClose(signal);
      } catch (caught) { error = caught }
      finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        await this.client.disconnect();
      }
      if (signal.aborted) break;
      const actual = Math.min(this.retry.maxDelayMs, delay * (1 + (Math.random() * 2 - 1) * this.retry.jitter));
      this.notify("retrying", error, actual);
      await this.sleep(actual, signal);
      delay = Math.min(this.retry.maxDelayMs, delay * this.retry.multiplier);
    }
  }

  private async interruptible(operation: () => Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("Startup cancelled");
    // Disconnect aborts the built-in handshake. A custom connect hook must also
    // honor the signal. Await its settlement so no old attempt can reconnect.
    const abort = () => { void this.client.disconnect() };
    signal.addEventListener("abort", abort, { once: true });
    try { await operation(); if (signal.aborted) throw new Error("Startup cancelled or timed out") }
    finally { signal.removeEventListener("abort", abort) }
  }

  private waitForClose(signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const done = () => { detach(); signal.removeEventListener("abort", done); resolve() };
      const detach = this.client.addListener({ onStateChange: state => {
        if (state === ConnectionState.Disconnected) done();
      } });
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted || this.client.state === ConnectionState.Disconnected) done();
    });
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve() };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
}
