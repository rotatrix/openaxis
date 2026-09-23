import { asMap, integerValue } from "./protocol/parse.js";
import type { OpenAxisInteger, RequestMessage, WireMap } from "./protocol/types.js";

/** Return this sentinel when a requested Navigation fact is unavailable. */
export const UNAVAILABLE: unique symbol = Symbol("OpenAxis.NavigationQuery.unavailable");
export type Unavailable = typeof UNAVAILABLE;
export type FactResolver = (name: string) => unknown | Unavailable;
export type AsyncFactResolver = (name: string) => Promise<unknown> | unknown;

/** Local pick result: omit point for a tested miss; return UNAVAILABLE for a skipped test. */
export interface PickResult {
  point?: readonly [number, number, number];
  bounds?: { min: readonly [number, number, number]; max: readonly [number, number, number] };
  /** Application-defined renderer coordinates, not protocol cursor coordinates. Never sent. */
  markerPosition?: readonly [number, number];
}

/** @internal Strip local metadata before testing availability or encoding a response. */
export function wireFactValue(name: string, value: unknown): unknown {
  if (["pick.cursor", "pick.viewport_center", "pick.cursor.selection", "pick.viewport_center.selection"].includes(name) && value !== null && typeof value === "object") {
    const { markerPosition: _, ...hit } = value as Record<string, unknown>;
    return hit.point == null ? UNAVAILABLE : hit;
  }
  return value;
}

export class NavigationQuery {
  readonly requestId: OpenAxisInteger;
  readonly gestureId?: OpenAxisInteger;
  readonly values: readonly string[];
  readonly first: readonly string[];
  readonly scoped: boolean;
  readonly hasFirst: boolean;

  private terminal = false;
  get completed(): boolean { return this.terminal }

  constructor(
    request: RequestMessage,
    private readonly completeCallback: (result: WireMap) => void,
    private readonly failCallback: (code: string, message?: string) => void,
  ) {
    if (request.method !== "navigation.query") throw new TypeError("NavigationQuery requires a navigation.query request");
    const params = request.params;
    this.requestId = request.id;
    this.scoped = "gesture_id" in params;
    if (this.scoped) this.gestureId = integerValue(params.gesture_id, "navigation.query.gesture_id");
    this.values = this.parseNames("values" in params ? params.values : [], "values");
    this.hasFirst = "first" in params;
    this.first = this.parseNames(this.hasFirst ? params.first : [], "first");
  }

  evaluate(resolveFact: FactResolver): WireMap {
    const cache = new Map<string, unknown | Unavailable>();
    const resolve = (name: string) => {
      if (!cache.has(name)) cache.set(name, wireFactValue(name, resolveFact(name)));
      return cache.get(name);
    };
    const values: WireMap = {};
    for (const name of this.values) {
      const value = resolve(name);
      if (value !== undefined && value !== null && value !== UNAVAILABLE) values[name] = value;
    }
    const result: WireMap = { values };
    if (this.hasFirst) {
      result.first = null;
      for (const name of this.first) {
        const value = resolve(name);
        if (value === undefined || value === null || value === UNAVAILABLE) continue;
        result.first = { name, value };
        break;
      }
    }
    return result;
  }

  /** Sequential, lazy resolution for hosts whose reads complete asynchronously. */
  async evaluateAsync(resolveFact: AsyncFactResolver): Promise<WireMap> {
    const cache = new Map<string, unknown>();
    const resolve = async (name: string) => {
      if (!cache.has(name)) cache.set(name, wireFactValue(name, await resolveFact(name)));
      return cache.get(name);
    };
    const values: WireMap = {};
    for (const name of this.values) {
      const value = await resolve(name);
      if (value !== undefined && value !== null && value !== UNAVAILABLE) values[name] = value;
    }
    const result: WireMap = { values };
    if (this.hasFirst) {
      result.first = null;
      for (const name of this.first) {
        const value = await resolve(name);
        if (value === undefined || value === null || value === UNAVAILABLE) continue;
        result.first = { name, value }; break;
      }
    }
    return result;
  }

  complete(result: WireMap): void {
    asMap(result, "navigation.query result");
    this.claim();
    this.completeCallback(asMap(result, "navigation.query result"));
  }

  fail(code: string, message?: string): void {
    if (typeof code !== "string" || code.trim().length === 0) throw new TypeError("Error code is required");
    if (message !== undefined && typeof message !== "string") throw new TypeError("Error message must be a string");
    this.claim();
    this.failCallback(code, message);
  }

  private parseNames(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || !value.every(name => typeof name === "string" && name.length > 0)) {
      throw new TypeError(`navigation.query.${field} must contain non-empty strings`);
    }
    return [...value];
  }

  /** SDK coordinators retire a query without sending on an obsolete connection. */
  claim(): void {
    if (this.terminal) throw new Error("NavigationQuery has already been completed");
    this.terminal = true;
  }
}
