/** Dependency-free human-readable event formatting, shared with Python/C#. */
export type DiagnosticLevel = "debug" | "info" | "warning" | "error";
type Fields = Record<string, unknown>;
const words = (value: unknown) => String(value).replace(/[_-]/g, " ");
const number = (value: unknown): string => typeof value === "number" && Number.isFinite(value)
  ? value.toFixed(3) : typeof value === "boolean" ? value ? "yes" : "no" : String(value);
const map = (value: unknown): Fields => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const items = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
function point(value: unknown): string | undefined {
  return Array.isArray(value) && value.length === 3 && value.every(x => typeof x === "number")
    ? `(${value.map(number).join(", ")})` : undefined;
}
function bounds(value: unknown): string | undefined {
  const v = map(value), low = point(v.min), high = point(v.max);
  return low && high ? `${low} … ${high}` : undefined;
}
function value(v: unknown): string {
  const specialized = point(v) ?? bounds(v);
  if (specialized) return specialized;
  if (v == null) return "missing";
  if (typeof v === "number" || typeof v === "boolean") return number(v);
  if (Array.isArray(v)) return v.map(value).join(", ");
  if (typeof v === "object") return Object.entries(v).filter(([,x]) => x != null).map(([k,x]) => `${words(k)}: ${value(x)}`).join("; ");
  return String(v);
}
function context(f: Fields, client = true, gesture = true, request = true): string {
  const parts = [];
  if (client && f.client != null) parts.push(String(f.client));
  if (gesture && f.gesture != null) parts.push(`gesture ${f.gesture}`);
  if (request && f.request != null) parts.push(`request ${f.request}`);
  return parts.length ? ` · ${parts.join(", ")}` : "";
}
const duration = (f: Fields) => f.duration_ms == null ? "" : ` · ${number(f.duration_ms)} ms`;
function pivotLabel(v: unknown): string {
  const s = String(v);
  if (s.startsWith("query:")) return s.slice(6);
  if (s.startsWith("viewport.center:")) return `viewport center (${words(s.slice(16).replace(/-depth$/, ""))} depth)`;
  return ({ locked: "locked pivot", "selection.viewport-clipped-center": "selection center", "last-used": "last pivot",
    "model.viewport-clipped-center": "model center", "model.bounds": "model bounds", "world.origin": "origin", query: "queried pick" } as Record<string,string>)[s] ?? words(s.replaceAll(".", " "));
}

export function formatEvent(name: string, f: Fields = {}): string {
  switch (name) {
    case "gesture.start": return "motion started" + context(f, false, true, false);
    case "gesture.end": return "motion ended" + context(f, false, true, false);
    case "gesture.cancel": return `motion canceled — ${words(f.reason ?? "unknown reason")}` + context(f, false, true, false);
    case "navigation.fact": {
      const hit = point(map(f.value).point), box = bounds(map(f.value).bounds);
      const result = f.result === "error" ? `error: ${f.error ?? "unknown failure"}`
        : f.result !== "ok" ? String(f.fact ?? "").startsWith("pick.") ? "miss" : "missing"
        : hit ? `hit at ${hit}${box ? ` | bounds ${box}` : ""}` : f.value == null ? "found" : `found ${value(f.value)}`;
      return `  ${f.fact ?? "fact"} — ${result}` + duration(f);
    }
    case "navigation.fact.error": return `  ${f.fact ?? "fact"} — error: ${f.error}` + context(f, false, false);
    case "navigation.query.complete": {
      const details = [], missing = items(f.missing);
      if (missing.length) details.push(`missing ${missing.join(", ")}`);
      if (f.first != null) details.push(`first: ${f.first}`);
      return "query complete" + (details.length ? ` — ${details.join("; ")}` : "") + duration(f) + context(f, false, false);
    }
    case "navigation.query.rejected": return `query rejected — ${words(f.reason ?? "unknown reason")}` + context(f);
    case "navigation.query.error": return `query failed — ${f.error ?? "unknown failure"}` + duration(f) + context(f);
    case "navigation.pivot.order": return `pivot order: ${items(f.candidates).map(pivotLabel).join(" → ")}` + context(f);
    case "navigation.pivot": return `  ${pivotLabel(f.source ?? "pivot")} — ${words(f.result ?? "considered")}`
      + (f.reason ? ` — ${words(f.reason)}` : "") + (point(f.point) ? ` at ${point(f.point)}` : "") + context(f);
    case "navigation.policy": return `navigation: ${f.target == null || f.target === "camera" ? f.camera_mode ? `${words(f.camera_mode)} camera` : "camera" : words(f.target)}` + context(f, true, true, false);
    case "navigation.object.selected": return "object control: " + ([f.translation && "translation", f.rotation && "rotation"].filter(Boolean).join(" + ") || "disabled")
      + (point(f.pivot) ? ` around ${point(f.pivot)}` : "") + context(f);
    case "interaction.object.detected": return "object interaction: " + (items(f.actions).map(words).join(" + ") || "detected")
      + (f.target ? ` · ${f.target}` : "") + (f.type ? ` (${f.type})` : "")
      + (f.unresolved ? ` — target unavailable: ${value(f.unresolved)}` : "") + (f.operations ? ` · ${value(f.operations)}` : "");
    case "interaction.object.ended": return "object interaction ended";
    case "camera.external.delta": {
      const details = [];
      if (point(f.translation)) details.push(`translation ${point(f.translation)}`);
      if (point(f.rotation)) details.push(`rotation ${point(f.rotation)}`);
      if (f.ortho_extent_scale != null) details.push(`ortho scale ${number(f.ortho_extent_scale)}`);
      return "external camera change: " + (items(f.changes).map(words).join(" + ") || details.join(", ") || "observed");
    }
    case "object.native_override": return "native object motion overridden by Rotatrix" + context(f, false, true, false);
    case "object.native_override.summary": return `native object motion overridden ${f.count ?? 0} times` + context(f, false, true, false);
    case "pivot.selection":
      if (f.result === "empty") return "selection — empty";
      if (f.result === "inspect") return `selection — inspecting ${f.count ?? 0} item(s)`;
      break;
    case "pivot.selection.item": {
      const type = f.type ?? f.entity_type ?? "entity";
      const identity = `${type}${f.id != null ? ` #${f.id}` : ""}${f.name ? ` ${f.name}` : ""}`;
      const outcome = f.result === "ok" ? `bounds ${bounds(f.bounds) ?? "found"}` : f.result === "missing_bounds" ? "missing bounds"
        : f.result === "error" ? `error: ${f.error ?? "unknown failure"}` : words(f.result ?? "inspected");
      const extras = [];
      if (f.occurrence) extras.push(String(f.occurrence));
      if (f.source) extras.push(words(f.source));
      if (f.geometry_type) extras.push(`geometry ${words(f.geometry_type)}`);
      if (f.native_type || f.native_id != null) extras.push(`native ${f.native_type ?? type}${f.native_id != null ? ` #${f.native_id}` : ""}`);
      for (const key of ["reported_bounds", "native_bounds", "transform"]) if (f[key] != null) extras.push(`${words(key)} ${value(f[key])}`);
      return `  selection ${f.item}: ${identity} — ${outcome}` + (extras.length ? ` · ${extras.join(", ")}` : "");
    }
    case "pivot.pick": {
      const owner = f.type ?? f.entity_type;
      return `  ${words(f.kind ?? "pick")} pick — ${f.result === "outside_selection" ? "hit outside selection" : words(f.result ?? "complete")}`
        + (point(f.point) ? ` at ${point(f.point)}` : "") + (f.reason ? ` — ${words(f.reason)}` : "")
        + (owner ? ` · ${owner}${f.id != null ? ` #${f.id}` : ""}${f.occurrence ? ` in ${f.occurrence}` : ""}` : "")
        + (bounds(f.bounds) ? ` · bounds ${bounds(f.bounds)}` : "");
    }
    case "connection.start": return `connecting to ${f.url}`;
    case "connection.open": return `connected to ${f.url} · ${f.protocol}`;
    case "connection.stop": return "connection stopped";
    case "connection.lost": return "connection lost" + (f.retry ? " — retrying" : "");
    case "connection.retry_failed": return `connection failed — ${f.error ?? "unknown failure"} · retrying in ${number(f.retry_delay_s ?? 0)} s`;
    case "command.rejected": return `command rejected: ${f.name}`;
    case "command.error": return `command failed: ${f.name} — ${f.error}`;
  }
  const ignored = new Set(["client", "gesture", "request", "delta_id", "seq"]);
  const details = Object.entries(f).filter(([k,v]) => !ignored.has(k) && v != null).map(([k,v]) => `${words(k)}: ${value(v)}`);
  return words(name.replaceAll(".", " ")) + (details.length ? ` — ${details.join("; ")}` : "") + context(f);
}

/** Local timestamp; callers own the destination and scheduling. */
export function formatLogLine(message: string, level: DiagnosticLevel = "info", now = new Date()): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const stamp = `${pad(now.getFullYear(), 4)}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
  return `${stamp}  ${level === "info" ? "" : level === "warning" ? "WARN " : level.toUpperCase() + " "}${message}`;
}
