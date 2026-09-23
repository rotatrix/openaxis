import type { NavigationQuery } from "./navigation.js";
import type { CameraPoseValue, ObjectPoseValue, NavigationStateMessage, OpenAxisInteger, WireMap } from "./protocol/types.js";
import type { PoseDifference } from "./session-state.js";

export interface NavigationWriteEvent<P extends ObjectPoseValue = CameraPoseValue> {
  context: unknown;
  desired: P;
  realized?: P;
  success: boolean;
}
export interface NavigationCorrectionEvent { deltaId: OpenAxisInteger; difference?: PoseDifference }
export interface NavigationEventMap {
  gesture_started: { gestureId: OpenAxisInteger };
  gesture_finished: { gestureId: OpenAxisInteger; reason: string };
  cancelled: { gestureId: OpenAxisInteger; reason: string };
  output_rejected: { kind: string; gestureId: OpenAxisInteger; reason: string };
  query_started: { query: NavigationQuery };
  query_context: { query: NavigationQuery; context: unknown };
  fact: { query: NavigationQuery; name: string; value: unknown; durationMs: number; error?: string };
  query_completed: { query: NavigationQuery; result: WireMap; durationMs: number };
  query_failed: { query: NavigationQuery; durationMs: number; error: string };
  camera_write: NavigationWriteEvent;
  object_write: NavigationWriteEvent<ObjectPoseValue>;
  /** Compatibility events; camera_write/object_write also include failed writes. */
  camera_applied: { desired: CameraPoseValue; realized?: CameraPoseValue };
  object_applied: { desired: ObjectPoseValue; realized?: ObjectPoseValue };
  correction_sent: NavigationCorrectionEvent;
  correction_waiting: NavigationCorrectionEvent;
  correction_applied: NavigationCorrectionEvent;
  object_correction_sent: NavigationCorrectionEvent;
  object_correction_waiting: NavigationCorrectionEvent;
  object_correction_applied: NavigationCorrectionEvent;
  navigation_state: { state: NavigationStateMessage };
}
export type NavigationEvent = {
  [K in keyof NavigationEventMap]: { event: K; values: NavigationEventMap[K] }
}[keyof NavigationEventMap];
export type NavigationObserver = (event: NavigationEvent) => void;

export type NavigationEventHandlers = {
  [K in keyof NavigationEventMap]?: (values: NavigationEventMap[K]) => void;
};
/** Register only the events needed by an integration; unhandled events use the fallback. */
export function createNavigationObserver(
  handlers: NavigationEventHandlers,
  fallback: (event: { event: string; values: unknown }) => void = () => {},
): NavigationObserver {
  return event => {
    if (Object.hasOwn(handlers, event.event)) {
      const handler = handlers[event.event] as ((values: unknown) => void) | undefined;
      if (handler) { handler(event.values); return }
    }
    fallback(event);
  };
}
