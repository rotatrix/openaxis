import type {
  CameraNavigationState,
  CameraPoseValue,
  OpenAxisInteger,
  OpenAxisMessage,
  RpcError,
  StandardMessage,
  Vec3,
  WireMap,
  WorldOrientation,
  Target,
  SdkInfo,
} from "./types.js";

const STANDARD_TYPES = new Set([
  "hello", "hello_ack", "heartbeat", "error", "request", "response",
  "tags", "focus", "capabilities", "subscribe", "axes", "motion_start", "motion_end",
  "motion_cancel", "viewport.settled", "buttons", "frame", "navigation.state",
  "camera.pose", "camera.delta", "camera.pivot", "object.pose", "object.delta",
  "object.pivot",
]);

export class ProtocolValidationError extends Error {
  requestId?: OpenAxisInteger;
  constructor(message: string) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}

function fail(message: string): never { throw new ProtocolValidationError(message) }

export function asMap(value: unknown, name = "value"): WireMap {
  if (value === null || typeof value !== "object") fail(`${name} must be a map`);
  const prototype = Object.getPrototypeOf(value);
  // Plain objects from another realm have a different Object.prototype identity.
  if (prototype !== null && (Object.getPrototypeOf(prototype) !== null ||
      !Object.prototype.hasOwnProperty.call(prototype, "constructor") ||
      typeof prototype.constructor !== "function" ||
      Function.prototype.toString.call(prototype.constructor) !== Function.prototype.toString.call(Object))) {
    fail(`${name} must be a map`);
  }
  return value as WireMap;
}

function required(map: WireMap, key: string, owner: string): unknown {
  if (!(key in map)) fail(`${owner} missing required '${key}'`);
  return map[key];
}

function stringValue(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    fail(`${name} must be a${allowEmpty ? "" : " non-empty"} string`);
  }
  return value;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") fail(`${name} must be a boolean`);
  return value;
}

export function integerValue(value: unknown, name: string): OpenAxisInteger {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function finiteValue(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${name} must be finite`);
  return value;
}

function positiveValue(value: unknown, name: string): number {
  const result = finiteValue(value, name);
  if (result <= 0) fail(`${name} must be positive and finite`);
  return result;
}

export function vec3Value(value: unknown, name: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) fail(`${name} must have exactly 3 elements`);
  return [
    finiteValue(value[0], `${name}[0]`),
    finiteValue(value[1], `${name}[1]`),
    finiteValue(value[2], `${name}[2]`),
  ];
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  return value.map((item, index) => stringValue(item, `${name}[${index}]`));
}

function numberArray(value: unknown, name: string): number[] {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  return value.map((item, index) => finiteValue(item, `${name}[${index}]`));
}

export function parseWorldOrientation(value: unknown): WorldOrientation {
  const map = asMap(value, "world.orientation");
  const handedness = "handedness" in map
    ? stringValue(map.handedness, "world.orientation.handedness")
    : "right";
  if (handedness !== "right" && handedness !== "left") fail("world.orientation.handedness must be right or left");
  return {
    forward: vec3Value(required(map, "forward", "world.orientation"), "world.orientation.forward"),
    up: vec3Value(required(map, "up", "world.orientation"), "world.orientation.up"),
    handedness,
  };
}

export function parseCameraPoseValue(value: unknown): CameraPoseValue {
  const map = asMap(value, "camera.pose");
  const hasFov = "fov" in map;
  const hasOrtho = "ortho_extent" in map;
  if (hasFov === hasOrtho) fail("camera.pose requires exactly one projection");
  const result: CameraPoseValue = {
    t: vec3Value(required(map, "t", "camera.pose"), "camera.pose.t"),
    r: vec3Value(required(map, "r", "camera.pose"), "camera.pose.r"),
  };
  if (hasFov) result.fov = positiveValue(map.fov, "camera.pose.fov");
  else result.ortho_extent = positiveValue(map.ortho_extent, "camera.pose.ortho_extent");
  return result;
}

function parseCameraState(value: unknown): CameraNavigationState {
  const map = asMap(value, "navigation.state.camera");
  const mode = stringValue(required(map, "mode", "navigation.state.camera"), "navigation.state.camera.mode");
  if (mode === "orbit") {
    if ("lock_roll" in map || "lock_translation_plane" in map || "translation_scale" in map) {
      fail("orbit navigation state cannot contain free-camera fields");
    }
    return { mode };
  }
  if (mode !== "free_camera") fail("navigation.state.camera.mode must be orbit or free_camera");
  const state: CameraNavigationState = { mode,
    lock_roll: booleanValue(required(map, "lock_roll", "navigation.state.camera"), "navigation.state.camera.lock_roll"),
    lock_translation_plane: booleanValue(required(map, "lock_translation_plane", "navigation.state.camera"), "navigation.state.camera.lock_translation_plane") };
  if ("translation_scale" in map) state.translation_scale = positiveValue(map.translation_scale, "navigation.state.camera.translation_scale");
  return state;
}

function parseRpcError(value: unknown): RpcError {
  const map = asMap(value, "response.error");
  const result: RpcError = { code: stringValue(required(map, "code", "response.error"), "response.error.code") };
  if ("message" in map) result.message = stringValue(map.message, "response.error.message", true);
  return result;
}

export function parseTarget(value: unknown): Target {
  const map = asMap(value, "hello.target");
  if (!("pid" in map) && !("app" in map)) fail("hello.target requires pid or app");
  const target: Target = {};
  if ("pid" in map) {
    const pid = map.pid;
    if (typeof pid !== "string" || /^[1-9][0-9]*(?::[1-9][0-9]*)?$/.exec(pid)?.[0] !== pid) fail("hello.target.pid must be a canonical positive PID string");
    target.pid = pid;
  }
  if ("app" in map) target.app = stringValue(map.app, "hello.target.app");
  if ("app_version" in map) target.app_version = stringValue(map.app_version, "hello.target.app_version");
  return target;
}

function parseSdk(value: unknown): SdkInfo {
  const map = asMap(value, "hello.sdk");
  return { name: stringValue(required(map, "name", "hello.sdk"), "hello.sdk.name"),
    version: stringValue(required(map, "version", "hello.sdk"), "hello.sdk.version") };
}

/** Validate a decoded MessagePack value and normalize every standard message. */
export function parseMessage(value: unknown): OpenAxisMessage {
  const map = asMap(value, "OpenAxis message");
  const type = stringValue(required(map, "type", "OpenAxis message"), "message.type");
  if (!STANDARD_TYPES.has(type)) return { ...map, type };

  switch (type) {
    case "hello": return { type, proto: stringValue(required(map, "proto", type), "hello.proto"), client_name: stringValue(required(map, "client_name", type), "hello.client_name"), ...("target" in map ? { target: parseTarget(map.target) } : {}), ...("client_version" in map ? { client_version: stringValue(map.client_version, "hello.client_version") } : {}), ...("sdk" in map ? { sdk: parseSdk(map.sdk) } : {}) };
    case "hello_ack": return { type, proto: stringValue(required(map, "proto", type), "hello_ack.proto"), server_name: stringValue(required(map, "server_name", type), "hello_ack.server_name") };
    case "heartbeat": return { type };
    case "focus": return { type, focused: booleanValue(required(map, "focused", type), "focus.focused") };
    case "error": return { type, code: stringValue(required(map, "code", type), "error.code"), message: stringValue(required(map, "message", type), "error.message", true) };
    case "request": return {
      type,
      id: integerValue(required(map, "id", type), "request.id"),
      method: stringValue(required(map, "method", type), "request.method"),
      params: "params" in map ? asMap(map.params, "request.params") : {},
    };
    case "response": {
      const hasResult = "result" in map;
      const hasError = "error" in map;
      if (hasResult === hasError) fail("response requires exactly one of result or error");
      return hasResult
        ? { type, id: integerValue(required(map, "id", type), "response.id"), result: asMap(map.result, "response.result") }
        : { type, id: integerValue(required(map, "id", type), "response.id"), error: parseRpcError(map.error) };
    }
    case "tags": return { type, tags: stringArray(required(map, "tags", type), "tags.tags") };
    case "capabilities": return { type, capabilities: stringArray(required(map, "capabilities", type), "capabilities.capabilities") };
    case "subscribe": return { type, axes: stringArray(required(map, "axes", type), "subscribe.axes") };
    case "axes": return { type, axes: stringArray(required(map, "axes", type), "axes.axes") };
    case "motion_start": return { type, gesture_id: integerValue(required(map, "gesture_id", type), "motion_start.gesture_id") };
    case "motion_end": return { type, gesture_id: integerValue(required(map, "gesture_id", type), "motion_end.gesture_id") };
    case "motion_cancel": {
      const result: StandardMessage = { type, gesture_id: integerValue(required(map, "gesture_id", type), "motion_cancel.gesture_id") };
      if ("reason" in map) result.reason = stringValue(map.reason, "motion_cancel.reason", true);
      return result;
    }
    case "viewport.settled": return { type };
    case "buttons": return { type, buttons: integerValue(required(map, "buttons", type), "buttons.buttons") };
    case "frame": return {
      type,
      seq: integerValue(required(map, "seq", type), "frame.seq"),
      t_us: integerValue(required(map, "t_us", type), "frame.t_us"),
      values: numberArray(required(map, "values", type), "frame.values"),
    };
    case "navigation.state": {
      if (!("camera" in map) && !("object" in map)) fail("navigation.state requires an active camera or object");
      const result: StandardMessage = { type, gesture_id: integerValue(required(map, "gesture_id", type), "navigation.state.gesture_id") };
      if ("camera" in map) result.camera = parseCameraState(map.camera);
      if ("object" in map) {
        const object = asMap(map.object, "navigation.state.object");
        result.object = {
          allow_translation: booleanValue(required(object, "allow_translation", "navigation.state.object"), "navigation.state.object.allow_translation"),
          allow_rotation: booleanValue(required(object, "allow_rotation", "navigation.state.object"), "navigation.state.object.allow_rotation"),
        };
      }
      return result;
    }
    case "camera.pose": {
      const pose = parseCameraPoseValue(map);
      const result: StandardMessage = { type, gesture_id: integerValue(required(map, "gesture_id", type), "camera.pose.gesture_id"), ...pose };
      if ("seq" in map) result.seq = integerValue(map.seq, "camera.pose.seq");
      if ("applied_delta_id" in map) result.applied_delta_id = integerValue(map.applied_delta_id, "camera.pose.applied_delta_id");
      return result;
    }
    case "camera.delta": {
      const result: StandardMessage = {
        type,
        gesture_id: integerValue(required(map, "gesture_id", type), "camera.delta.gesture_id"),
        t: vec3Value(required(map, "t", type), "camera.delta.t"),
        r: vec3Value(required(map, "r", type), "camera.delta.r"),
      };
      if ("ortho_extent_scale" in map) result.ortho_extent_scale = positiveValue(map.ortho_extent_scale, "camera.delta.ortho_extent_scale");
      if ("delta_id" in map) result.delta_id = integerValue(map.delta_id, "camera.delta.delta_id");
      return result;
    }
    case "camera.pivot": return { type, gesture_id: integerValue(required(map, "gesture_id", type), "camera.pivot.gesture_id"), point: vec3Value(required(map, "point", type), "camera.pivot.point") };
    case "object.pose": {
      rejectObjectProjection(map);
      const result: StandardMessage = {
        type,
        gesture_id: integerValue(required(map, "gesture_id", type), "object.pose.gesture_id"),
        t: vec3Value(required(map, "t", type), "object.pose.t"),
        r: vec3Value(required(map, "r", type), "object.pose.r"),
      };
      if ("seq" in map) result.seq = integerValue(map.seq, "object.pose.seq");
      if ("applied_delta_id" in map) result.applied_delta_id = integerValue(map.applied_delta_id, "object.pose.applied_delta_id");
      return result;
    }
    case "object.delta": {
      rejectObjectProjection(map);
      const result: StandardMessage = {
        type,
        gesture_id: integerValue(required(map, "gesture_id", type), "object.delta.gesture_id"),
        t: vec3Value(required(map, "t", type), "object.delta.t"),
        r: vec3Value(required(map, "r", type), "object.delta.r"),
      };
      if ("delta_id" in map) result.delta_id = integerValue(map.delta_id, "object.delta.delta_id");
      return result;
    }
    case "object.pivot": return { type, gesture_id: integerValue(required(map, "gesture_id", type), "object.pivot.gesture_id"), point: vec3Value(required(map, "point", type), "object.pivot.point") };
  }
  return fail(`Unsupported standard message type: ${type}`);
}

function rejectObjectProjection(map: WireMap): void {
  if (["fov", "ortho_extent", "ortho_extent_scale"].some(key => key in map)) fail("object messages cannot contain projection fields");
}

/** Validate a typed outbound message and return its plain MessagePack-ready map. */
export function packMessage(message: StandardMessage): WireMap {
  return parseMessage(message) as WireMap;
}
