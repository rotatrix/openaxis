import { SDK_VERSION } from "./version.js";
import { type DiagnosticLevel } from "./diagnostics.js";

export function normalizeLogLevel(level: string): DiagnosticLevel {
  const value = level.toLowerCase();
  if (value === "warn") return "warning";
  if (value === "critical") return "error";
  return ["debug", "info", "warning", "error"].includes(value) ? value as DiagnosticLevel : "info";
}
export function formatLogRecord(level: string, message: string, now = new Date(), offsetMinutes = -now.getTimezoneOffset()): string {
  const local = new Date(now.getTime() + offsetMinutes * 60000).toISOString().slice(0, 23).replace("T", " ");
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = `${offsetMinutes < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  const clean = message.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r\n?/g, "\n").replace(/\n/g, "\n    ");
  return `${local} ${offset} ${normalizeLogLevel(level).toUpperCase()} ${clean}\n`;
}

/** Browser-safe logger. Browsers cannot write the host's Rotatrix log directory. */
export class DiagnosticLog {
  readonly sinks: Array<(level: DiagnosticLevel, message: string) => void>;
  constructor(readonly client: string, options: {
    sinks?: Array<(level: DiagnosticLevel, message: string) => void>;
    debug?: boolean;
    clientVersion?: string;
  } = {}) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(client) || client.includes("\n")) throw new Error("Invalid client identifier");
    this.debug = options.debug ?? false;
    this.sinks = options.sinks ?? [(level, message) => {
      const line = formatLogRecord(level, message).slice(0, -1);
      if (level === "error") console.error(line);
      else if (level === "warning") console.warn(line);
      else console.info(line);
    }];
    this.write("info", `OpenAxis SDK ${SDK_VERSION} (TypeScript); client=${client}; client_version=${options.clientVersion || "unknown"}`);
  }
  debug: boolean;
  closed = false;
  close(): void { this.closed = true; }
  write = (inputLevel: string, message: string): void => {
    if (this.closed) return;
    const level = normalizeLogLevel(inputLevel);
    if (level === "debug" && !this.debug) return;
    for (const sink of [...this.sinks]) {
      try { sink(level, message) } catch { /* Logging must not interrupt navigation. */ }
    }
  };
}

let defaultLog: DiagnosticLog | undefined;
const configured = new Map<string, DiagnosticLog>();
export function configureLogging(client: string, options?: ConstructorParameters<typeof DiagnosticLog>[1]): DiagnosticLog {
  defaultLog = configured.get(client);
  if (!defaultLog || defaultLog.closed) {
    defaultLog = new DiagnosticLog(client, options);
    configured.set(client, defaultLog);
  }
  return defaultLog;
}
export function emitDiagnosticLog(level: DiagnosticLevel, message: string): void {
  (defaultLog ??= new DiagnosticLog("openaxis")).write(level, message);
}
