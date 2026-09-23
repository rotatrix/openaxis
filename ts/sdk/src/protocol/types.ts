export const PROTO_VERSION = "openaxis/1.0" as const;
export const MAX_INTEGER = 9007199254740991;
export const DEFAULT_URL = "ws://localhost:6607" as const;

/** OpenAxis integers are represented as non-negative safe JavaScript numbers. */
export type OpenAxisInteger = number;
export type Vec3 = [number, number, number];
export type Handedness = "right" | "left";
export type CameraMode = "orbit" | "free_camera";
export type WireMap = Record<string, unknown>;

export interface WorldOrientation {
  forward: Vec3;
  up: Vec3;
  handedness: Handedness;
}

export interface CameraPoseValue {
  t: Vec3;
  r: Vec3;
  fov?: number;
  ortho_extent?: number;
}

export interface ObjectPoseValue {
  t: Vec3;
  r: Vec3;
}

export interface Target { pid?: string; app?: string; app_version?: string }
export interface SdkInfo { name: string; version: string }
export interface HelloMessage { type: "hello"; proto: string; client_name: string; target?: Target; client_version?: string; sdk?: SdkInfo }
export interface HelloAckMessage { type: "hello_ack"; proto: string; server_name: string }
export interface HeartbeatMessage { type: "heartbeat" }
export interface ErrorMessage { type: "error"; code: string; message: string }
export interface RpcError { code: string; message?: string }
export interface RequestMessage { type: "request"; id: OpenAxisInteger; method: string; params: WireMap }
export interface ResponseMessage { type: "response"; id: OpenAxisInteger; result?: WireMap; error?: RpcError }
export interface TagsMessage { type: "tags"; tags: string[] }
export interface FocusMessage { type: "focus"; focused: boolean }
export interface CapabilitiesMessage { type: "capabilities"; capabilities: string[] }
export interface SubscribeMessage { type: "subscribe"; axes: string[] }
export interface AxesMessage { type: "axes"; axes: string[] }
export interface MotionStartMessage { type: "motion_start"; gesture_id: OpenAxisInteger }
export interface MotionEndMessage { type: "motion_end"; gesture_id: OpenAxisInteger }
export interface MotionCancelMessage { type: "motion_cancel"; gesture_id: OpenAxisInteger; reason?: string }
export interface ViewportSettledMessage { type: "viewport.settled" }
export interface ButtonsMessage { type: "buttons"; buttons: OpenAxisInteger }
export interface FrameMessage {
  type: "frame";
  seq: OpenAxisInteger;
  t_us: OpenAxisInteger;
  values: number[];
}

export interface OrbitCameraState { mode: "orbit" }
export interface FreeCameraState {
  mode: "free_camera";
  lock_roll: boolean;
  lock_translation_plane: boolean;
  translation_scale?: number;
}
export type CameraNavigationState = OrbitCameraState | FreeCameraState;
export interface ObjectNavigationState { allow_translation: boolean; allow_rotation: boolean }
export interface NavigationStateMessage {
  type: "navigation.state";
  gesture_id: OpenAxisInteger;
  camera?: CameraNavigationState;
  object?: ObjectNavigationState;
}

export interface CameraPoseMessage extends CameraPoseValue {
  type: "camera.pose";
  gesture_id: OpenAxisInteger;
  seq?: OpenAxisInteger;
  applied_delta_id?: OpenAxisInteger;
}
export interface CameraDeltaMessage {
  type: "camera.delta";
  gesture_id: OpenAxisInteger;
  t: Vec3;
  r: Vec3;
  ortho_extent_scale?: number;
  delta_id?: OpenAxisInteger;
}
export interface CameraPivotMessage { type: "camera.pivot"; gesture_id: OpenAxisInteger; point: Vec3 }
export interface ObjectPoseMessage extends ObjectPoseValue {
  type: "object.pose";
  gesture_id: OpenAxisInteger;
  seq?: OpenAxisInteger;
  applied_delta_id?: OpenAxisInteger;
}
export interface ObjectDeltaMessage {
  type: "object.delta";
  gesture_id: OpenAxisInteger;
  t: Vec3;
  r: Vec3;
  delta_id?: OpenAxisInteger;
}
export interface ObjectPivotMessage { type: "object.pivot"; gesture_id: OpenAxisInteger; point: Vec3 }

export type StandardMessage =
  | HelloMessage | HelloAckMessage | HeartbeatMessage | ErrorMessage
  | RequestMessage | ResponseMessage | TagsMessage | FocusMessage | CapabilitiesMessage
  | SubscribeMessage | AxesMessage | MotionStartMessage | MotionEndMessage
  | MotionCancelMessage | ViewportSettledMessage | ButtonsMessage | FrameMessage
  | NavigationStateMessage | CameraPoseMessage | CameraDeltaMessage
  | CameraPivotMessage | ObjectPoseMessage | ObjectDeltaMessage | ObjectPivotMessage;

export interface UnknownMessage {
  type: string;
  [field: string]: unknown;
}

export type OpenAxisMessage = StandardMessage | UnknownMessage;
