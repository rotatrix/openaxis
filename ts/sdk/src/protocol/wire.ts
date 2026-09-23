import { decode } from "@msgpack/msgpack";
import { asMap, integerValue, parseMessage, ProtocolValidationError } from "./parse.js";

// MessagePack decoding erases the distinction between integer and float tags.
// Retain field offsets so the protocol's integer fields can enforce wire types.
function fieldOffsets(bytes: Uint8Array): Map<string, number> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fields = new Map<string, number>();
  let pos = 0;
  const uint = (size: number): number => {
    const n = size === 1 ? view.getUint8(pos) : size === 2 ? view.getUint16(pos) : view.getUint32(pos);
    pos += size; return n;
  };
  const walk = (depth: number, path?: string): void => {
    if (depth > 128) throw new ProtocolValidationError("MessagePack nesting exceeds 128");
    const tag = uint(1);
    let array = -1, map = -1;
    if (tag <= 0x7f || tag >= 0xe0 || tag === 0xc0 || tag === 0xc2 || tag === 0xc3) return;
    if ((tag & 0xe0) === 0xa0) { pos += tag & 31; return }
    if ((tag & 0xf0) === 0x90) array = tag & 15;
    else if ((tag & 0xf0) === 0x80) map = tag & 15;
    else if (tag === 0xdc || tag === 0xdd) array = uint(tag === 0xdc ? 2 : 4);
    else if (tag === 0xde || tag === 0xdf) map = uint(tag === 0xde ? 2 : 4);
    else if (tag >= 0xcc && tag <= 0xcf) { pos += 2 ** (tag - 0xcc); return }
    else if (tag >= 0xd0 && tag <= 0xd3) { pos += 2 ** (tag - 0xd0); return }
    else if (tag === 0xca || tag === 0xcb) { pos += tag === 0xca ? 4 : 8; return }
    else if (tag >= 0xd4 && tag <= 0xd8) { pos += 1 + 2 ** (tag - 0xd4); return }
    else if ((tag >= 0xc4 && tag <= 0xc9) || (tag >= 0xd9 && tag <= 0xdb)) {
      const size = tag >= 0xd9 ? 2 ** (tag - 0xd9) : 2 ** ((tag - 0xc4) % 3);
      const length = uint(size);
      pos += length + (tag >= 0xc7 && tag <= 0xc9 ? 1 : 0); return;
    } else throw new ProtocolValidationError("Invalid MessagePack tag");
    for (let i = 0; i < array; i++) walk(depth + 1);
    for (let i = 0; i < map; i++) {
      const start = pos; walk(depth + 1);
      const key = path === undefined ? undefined : decode(bytes.subarray(start, pos));
      const child = typeof key === "string" ? `${path}${key}` : undefined;
      // Only record protocol integer fields. An unrelated root key literally
      // named "params.gesture_id" must not shadow the nested query field.
      if (child !== undefined && (path === "params." ? key === "gesture_id" :
          ["id", "gesture_id", "seq", "t_us", "delta_id", "applied_delta_id", "buttons"].includes(String(key)))) fields.set(child, pos);
      walk(depth + 1, child === "params" ? "params." : undefined);
    }
  };
  walk(0, "");
  if (pos !== bytes.length) throw new ProtocolValidationError("Expected exactly one MessagePack value");
  return fields;
}

const integerFields: Record<string, readonly string[]> = {
  request: ["id"], response: ["id"], buttons: ["buttons"], frame: ["seq", "t_us"],
  motion_start: ["gesture_id"], motion_end: ["gesture_id"], motion_cancel: ["gesture_id"],
  "navigation.state": ["gesture_id"], "camera.pivot": ["gesture_id"], "object.pivot": ["gesture_id"],
  "camera.pose": ["gesture_id", "seq", "applied_delta_id"], "object.pose": ["gesture_id", "seq", "applied_delta_id"],
  "camera.delta": ["gesture_id", "delta_id"], "object.delta": ["gesture_id", "delta_id"],
};

/** Decode one binary message, preserving the wire distinction for integer fields. */
export function decodeMessage(bytes: Uint8Array): ReturnType<typeof parseMessage> {
  if (bytes.length > 1024 * 1024) throw new ProtocolValidationError("Message exceeds 1 MiB");
  const offsets = fieldOffsets(bytes);
  const raw = asMap(decode(bytes), "message");
  const encodedInteger = (field: string): boolean => {
    const offset = offsets.get(field);
    if (offset === undefined) return false;
    const tag = bytes[offset]!;
    return tag <= 0x7f || tag >= 0xe0 || (tag >= 0xcc && tag <= 0xd3);
  };
  try {
    const type = String(raw.type);
    const fields = [...(Object.hasOwn(integerFields, type) ? integerFields[type]! : [])];
    if (raw.type === "request" && raw.method === "navigation.query") fields.push("params.gesture_id");
    for (const field of fields) {
      if (offsets.has(field) && !encodedInteger(field)) throw new ProtocolValidationError(`${field} must use a MessagePack integer`);
    }
    return parseMessage(raw);
  } catch (error) {
    if (error instanceof ProtocolValidationError && raw.type === "request" && encodedInteger("id")) {
      try { error.requestId = integerValue(raw.id, "request.id") } catch { /* unusable correlation */ }
    }
    throw error;
  }
}
