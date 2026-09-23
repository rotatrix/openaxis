"""Typed OpenAxis 1.0 wire messages."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field, fields
from enum import Enum
from typing import ClassVar, Literal, Self

__all__ = [
    "PROTO_VERSION",
    "MAX_INTEGER",
    "DEFAULT_URL",
    "Handedness",
    "NavigationMode",
    "ConnectionState",
    "WorldOrientation",
    "Target",
    "SdkInfo",
    "Msg",
    "MSG_TYPES",
    "unpack_msg",
    "Hello",
    "HelloAck",
    "Heartbeat",
    "Error",
    "RpcError",
    "Request",
    "Response",
    "Tags",
    "Focus",
    "Capabilities",
    "Subscribe",
    "Axes",
    "MotionStart",
    "MotionEnd",
    "MotionCancel",
    "ViewportSettled",
    "Buttons",
    "Frame",
    "CameraNavigationState",
    "ObjectNavigationState",
    "NavigationState",
    "CameraPose",
    "CameraDelta",
    "CameraPivot",
    "ObjectPose",
    "ObjectDelta",
    "ObjectPivot",
]

PROTO_VERSION = "openaxis/1.0"
MAX_INTEGER = 2**53 - 1
DEFAULT_URL = "ws://localhost:6607"

Handedness = Literal["right", "left"]
NavigationMode = Literal["orbit", "free_camera"]


class ConnectionState(Enum):
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    DISCONNECTING = "disconnecting"


def _req(value: dict, key: str, type_name: str):
    if not isinstance(value, dict):
        raise ValueError(f"{type_name} must be a map")
    if key not in value:
        raise ValueError(f"{type_name} missing required '{key}'")
    return value[key]


def _integer(value: object, field_name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= MAX_INTEGER:
        raise ValueError(f"{field_name} must be an integer from 0 through {MAX_INTEGER}")
    return value


def _diagnostic_string(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} must be a non-empty string")
    return value


def _string(value: object, name: str, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        raise ValueError(f"{name} must be a string" if allow_empty else f"{name} must be a non-empty string")
    return value


def _strings(value: object, name: str) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        raise ValueError(f"{name} must be an array")
    return tuple(_string(item, name) for item in value)


def _numbers(value: object, name: str) -> tuple[float, ...]:
    if not isinstance(value, (list, tuple)) or any(
        isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item)
        for item in value
    ):
        raise ValueError(f"{name} must be an array of finite numbers")
    return tuple(float(item) for item in value)


def _object_fields(value: dict) -> None:
    if any(key in value for key in ("fov", "ortho_extent", "ortho_extent_scale")):
        raise ValueError("object messages cannot contain projection fields")


def _vec3(value: object, field_name: str) -> tuple[float, float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError(f"{field_name} must have exactly 3 elements")
    if any(isinstance(component, bool) or not isinstance(component, (int, float)) for component in value):
        raise ValueError(f"{field_name} must contain finite numbers")
    result = tuple(float(component) for component in value)
    if not all(math.isfinite(component) for component in result):
        raise ValueError(f"{field_name} must contain finite numbers")
    return result  # type: ignore[return-value]


def _positive(value: object, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field_name} must be positive and finite")
    result = float(value)
    if not math.isfinite(result) or result <= 0:
        raise ValueError(f"{field_name} must be positive and finite")
    return result


def _boolean(value: object, field_name: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{field_name} must be a boolean")
    return value


def _projection(value: dict, type_name: str) -> tuple[float | None, float | None]:
    fov = value.get("fov")
    ortho_extent = value.get("ortho_extent")
    if ("fov" in value) == ("ortho_extent" in value):
        raise ValueError(f"{type_name} requires exactly one of fov or ortho_extent")
    selected = _positive(fov if fov is not None else ortho_extent, f"{type_name} projection")
    return (selected, None) if fov is not None else (None, selected)


@dataclass(frozen=True)
class WorldOrientation:
    """Nested ``world.orientation`` Navigation fact."""

    forward: tuple[float, float, float]
    up: tuple[float, float, float]
    handedness: Handedness = "right"

    def pack(self) -> dict:
        return {"forward": self.forward, "up": self.up, "handedness": self.handedness}

    @classmethod
    def unpack(cls, value: dict) -> Self:
        handedness = value.get("handedness", "right")
        if handedness not in ("right", "left"):
            raise ValueError("world.orientation handedness must be right or left")
        return cls(
            forward=_vec3(_req(value, "forward", "world.orientation"), "world.orientation.forward"),
            up=_vec3(_req(value, "up", "world.orientation"), "world.orientation.up"),
            handedness=handedness,
        )


@dataclass(frozen=True)
class Msg:
    TYPE: ClassVar[str]

    def pack(self) -> dict:
        result: dict = {"type": self.TYPE}
        if hasattr(self, "gesture_id"):
            _integer(self.gesture_id, f"{self.TYPE}.gesture_id")
        if self.TYPE == "frame":
            _integer(self.seq, "frame.seq")
            _integer(self.t_us, "frame.t_us")
        if self.TYPE == "error":
            _string(self.message, "error.message", True)
        for item in fields(self):
            field_value = getattr(self, item.name)
            if field_value is not None:
                if item.name in {"id", "gesture_id", "seq", "t_us", "delta_id", "applied_delta_id"}:
                    _integer(field_value, f"{self.TYPE}.{item.name}")
                result[item.name] = field_value
        for key in ("proto", "client_name", "server_name", "method", "code"):
            if hasattr(self, key):
                _string(getattr(self, key), f"{self.TYPE}.{key}")
        for key in ("message", "reason"):
            if key in result:
                _string(result[key], f"{self.TYPE}.{key}", True)
        for key in ("tags", "capabilities", "axes"):
            if hasattr(self, key):
                result[key] = _strings(getattr(self, key), f"{self.TYPE}.{key}")
        if self.TYPE == "frame":
            result["values"] = _numbers(self.values, "frame.values")
        if self.TYPE == "buttons":
            _integer(self.buttons, "buttons.buttons")
        return result

    @classmethod
    def unpack(cls, value: dict) -> Self:
        raise NotImplementedError


@dataclass(frozen=True)
class Target:
    """Application receiving control from this connection."""

    pid: str | None = None
    app: str | None = None
    app_version: str | None = None

    def pack(self) -> dict:
        if self.pid is None and self.app is None:
            raise ValueError("hello.target requires pid or app")
        result: dict = {}
        if self.pid is not None:
            if not isinstance(self.pid, str) or not re.fullmatch(r"[1-9][0-9]*(?::[1-9][0-9]*)?", self.pid):
                raise ValueError("hello.target.pid must be a canonical positive PID string")
            result["pid"] = self.pid
        if self.app is not None:
            if not isinstance(self.app, str) or not self.app.strip():
                raise ValueError("hello.target.app must be a non-empty string")
            result["app"] = self.app
        if self.app_version is not None:
            result["app_version"] = _diagnostic_string(self.app_version, "hello.target.app_version")
        return result

    @classmethod
    def unpack(cls, value: dict) -> Self:
        if not isinstance(value, dict):
            raise ValueError("hello.target must be a map")
        if "pid" in value and value["pid"] is None:
            raise ValueError("hello.target.pid must be a canonical positive PID string")
        if "app" in value and value["app"] is None:
            raise ValueError("hello.target.app must be a non-empty string")
        target = cls(pid=value.get("pid"), app=value.get("app"),
                     app_version=_diagnostic_string(value["app_version"], "hello.target.app_version") if "app_version" in value else None)
        target.pack()
        return target


@dataclass(frozen=True)
class SdkInfo:
    """Self-reported diagnostic SDK identity, not a capability declaration."""

    name: str
    version: str

    def pack(self) -> dict:
        return {"name": _diagnostic_string(self.name, "hello.sdk.name"),
                "version": _diagnostic_string(self.version, "hello.sdk.version")}

    @classmethod
    def unpack(cls, value: dict) -> Self:
        if not isinstance(value, dict):
            raise ValueError("hello.sdk must be a map")
        sdk = cls(_req(value, "name", "hello.sdk"), _req(value, "version", "hello.sdk"))
        sdk.pack()
        return sdk


@dataclass(frozen=True)
class Hello(Msg):
    TYPE: ClassVar[str] = "hello"
    proto: str = PROTO_VERSION
    client_name: str = ""
    target: Target | None = None
    client_version: str | None = None
    sdk: SdkInfo | None = None

    def pack(self) -> dict:
        result = {"type": self.TYPE, "proto": _string(self.proto, "hello.proto"), "client_name": _string(self.client_name, "hello.client_name")}
        if self.target is not None:
            result["target"] = self.target.pack()
        if self.client_version is not None:
            result["client_version"] = _diagnostic_string(self.client_version, "hello.client_version")
        if self.sdk is not None:
            result["sdk"] = self.sdk.pack()
        return result

    @classmethod
    def unpack(cls, value: dict) -> Self:
        target = Target.unpack(value["target"]) if "target" in value else None
        return cls(proto=_req(value, "proto", "hello"), client_name=_req(value, "client_name", "hello"), target=target,
                   client_version=_diagnostic_string(value["client_version"], "hello.client_version") if "client_version" in value else None,
                   sdk=SdkInfo.unpack(value["sdk"]) if "sdk" in value else None)


@dataclass(frozen=True)
class HelloAck(Msg):
    TYPE: ClassVar[str] = "hello_ack"
    proto: str = PROTO_VERSION
    server_name: str = ""

    @classmethod
    def unpack(cls, value: dict) -> Self:
        return cls(proto=_req(value, "proto", "hello_ack"), server_name=_req(value, "server_name", "hello_ack"))


@dataclass(frozen=True)
class Heartbeat(Msg):
    TYPE: ClassVar[str] = "heartbeat"

    @classmethod
    def unpack(cls, value: dict) -> Self:
        return cls()


@dataclass(frozen=True)
class Error(Msg):
    TYPE: ClassVar[str] = "error"
    code: str = ""
    message: str = ""

    @classmethod
    def unpack(cls, value: dict) -> Self:
        return cls(code=_string(_req(value, "code", "error"), "error.code"), message=_string(_req(value, "message", "error"), "error.message", True))


@dataclass(frozen=True)
class RpcError:
    code: str
    message: str | None = None

    def pack(self) -> dict:
        result = {"code": _string(self.code, "response.error.code")}
        if self.message is not None:
            result["message"] = _string(self.message, "response.error.message", True)
        return result

    @classmethod
    def unpack(cls, value: dict) -> Self:
        return cls(code=_string(_req(value, "code", "response.error"), "response.error.code"),
                   message=_string(value["message"], "response.error.message", True) if "message" in value else None)


@dataclass(frozen=True)
class Request(Msg):
    TYPE: ClassVar[str] = "request"
    id: int = 0
    method: str = ""
    params: dict = field(default_factory=dict)

    def pack(self) -> dict:
        _integer(self.id, "request.id")
        if not isinstance(self.params, dict):
            raise ValueError("request.params must be a map")
        return super().pack()

    @classmethod
    def unpack(cls, value: dict) -> Self:
        params = value.get("params", {})
        if not isinstance(params, dict):
            raise ValueError("request.params must be a map")
        return cls(
            id=_integer(_req(value, "id", "request"), "request.id"),
            method=_string(_req(value, "method", "request"), "request.method"),
            params=params,
        )


@dataclass(frozen=True)
class Response(Msg):
    TYPE: ClassVar[str] = "response"
    id: int = 0
    result: dict | None = None
    error: RpcError | None = None

    def pack(self) -> dict:
        _integer(self.id, "response.id")
        if (self.result is None) == (self.error is None):
            raise ValueError("response requires exactly one of result or error")
        result: dict = {"type": self.TYPE, "id": self.id}
        if self.result is not None:
            if not isinstance(self.result, dict):
                raise ValueError("response.result must be a map")
            result["result"] = self.result
        else:
            result["error"] = self.error.pack()  # type: ignore[union-attr]
        return result

    @classmethod
    def unpack(cls, value: dict) -> Self:
        has_result = "result" in value
        has_error = "error" in value
        if has_result == has_error:
            raise ValueError("response requires exactly one of result or error")
        result = value.get("result")
        error = value.get("error")
        if has_result and not isinstance(result, dict):
            raise ValueError("response.result must be a map")
        if has_error and not isinstance(error, dict):
            raise ValueError("response.error must be a map")
        return cls(
            id=_integer(_req(value, "id", "response"), "response.id"),
            result=result if has_result else None,
            error=RpcError.unpack(error) if has_error else None,
        )


@dataclass(frozen=True)
class Focus(Msg):
    TYPE: ClassVar[str] = "focus"
    focused: bool = False

    def pack(self) -> dict:
        _boolean(self.focused, "focus.focused")
        return super().pack()

    @classmethod
    def unpack(cls, value: dict) -> Self:
        return cls(focused=_boolean(_req(value, "focused", "focus"), "focus.focused"))


@dataclass(frozen=True)
class Tags(Msg):
    TYPE: ClassVar[str] = "tags"
    tags: tuple[str, ...] = ()

    @classmethod
    def unpack(cls, value: dict) -> Self:
        return cls(tags=_strings(_req(value, "tags", "tags"), "tags.tags"))


@dataclass(frozen=True)
class Capabilities(Msg):
    TYPE: ClassVar[str] = "capabilities"
    capabilities: tuple[str, ...] = ()

    @classmethod
    def unpack(cls, value: dict) -> Self:
        return cls(capabilities=_strings(_req(value, "capabilities", "capabilities"), "capabilities.capabilities"))


@dataclass(frozen=True)
class Subscribe(Msg):
    TYPE: ClassVar[str] = "subscribe"
    axes: tuple[str, ...] = ()

    @classmethod
    def unpack(cls, value: dict) -> Self:
        return cls(axes=_strings(_req(value, "axes", "subscribe"), "subscribe.axes"))


@dataclass(frozen=True)
class Axes(Msg):
    TYPE: ClassVar[str] = "axes"
    axes: tuple[str, ...] = ()

    @classmethod
    def unpack(cls, value: dict) -> Self:
        return cls(axes=_strings(_req(value, "axes", "axes"), "axes.axes"))


@dataclass(frozen=True)
class MotionStart(Msg):
    TYPE: ClassVar[str] = "motion_start"
    gesture_id: int = 0

    def pack(self) -> dict:
        _integer(self.gesture_id, "motion_start.gesture_id")
        return super().pack()

    @classmethod
    def unpack(cls, value: dict) -> Self:
        return cls(gesture_id=_integer(_req(value, "gesture_id", "motion_start"), "motion_start.gesture_id"))


@dataclass(frozen=True)
class MotionEnd(Msg):
    TYPE: ClassVar[str] = "motion_end"
    gesture_id: int = 0

    @classmethod
    def unpack(cls, value: dict) -> Self:
        return cls(gesture_id=_integer(_req(value, "gesture_id", "motion_end"), "motion_end.gesture_id"))


@dataclass(frozen=True)
class MotionCancel(Msg):
    TYPE: ClassVar[str] = "motion_cancel"
    gesture_id: int = 0
    reason: str | None = None

    @classmethod
    def unpack(cls, value: dict) -> Self:
        return cls(
            gesture_id=_integer(_req(value, "gesture_id", "motion_cancel"), "motion_cancel.gesture_id"),
            reason=_string(value["reason"], "motion_cancel.reason", True) if "reason" in value else None,
        )


@dataclass(frozen=True)
class ViewportSettled(Msg):
    TYPE: ClassVar[str] = "viewport.settled"

    @classmethod
    def unpack(cls, value: dict) -> Self:
        return cls()


@dataclass(frozen=True)
class Buttons(Msg):
    TYPE: ClassVar[str] = "buttons"
    buttons: int = 0

    @classmethod
    def unpack(cls, value: dict) -> Self:
        return cls(buttons=_integer(_req(value, "buttons", "buttons"), "buttons.buttons"))


@dataclass(frozen=True)
class Frame(Msg):
    TYPE: ClassVar[str] = "frame"
    seq: int = 0
    t_us: int = 0
    values: tuple[float, ...] = ()

    @classmethod
    def unpack(cls, value: dict) -> Self:
        return cls(
            seq=_integer(_req(value, "seq", "frame"), "frame.seq"),
            t_us=_integer(_req(value, "t_us", "frame"), "frame.t_us"),
            values=_numbers(_req(value, "values", "frame"), "frame.values"),
        )


@dataclass(frozen=True)
class CameraNavigationState:
    """Effective camera behavior nested in ``navigation.state``."""

    mode: NavigationMode
    lock_roll: bool | None = None
    lock_translation_plane: bool | None = None
    translation_scale: float | None = None

    def pack(self) -> dict:
        if self.mode not in ("orbit", "free_camera"):
            raise ValueError("navigation.state.camera.mode must be orbit or free_camera")
        if self.mode == "orbit" and any(
            value is not None
            for value in (
                self.lock_roll,
                self.lock_translation_plane,
                self.translation_scale,
            )
        ):
            raise ValueError("orbit navigation state cannot contain free-camera fields")
        result: dict = {"mode": self.mode}
        if self.mode == "free_camera":
            _boolean(self.lock_roll, "navigation.state.camera.lock_roll")
            _boolean(self.lock_translation_plane, "navigation.state.camera.lock_translation_plane")
        if self.lock_roll is not None:
            result["lock_roll"] = _boolean(self.lock_roll, "navigation.state.camera.lock_roll")
        if self.lock_translation_plane is not None:
            result["lock_translation_plane"] = _boolean(
                self.lock_translation_plane,
                "navigation.state.camera.lock_translation_plane",
            )
        if self.translation_scale is not None:
            result["translation_scale"] = _positive(
                self.translation_scale,
                "navigation.state.camera.translation_scale",
            )
        return result

    @classmethod
    def unpack(cls, value: dict) -> Self:
        mode = _req(value, "mode", "navigation.state.camera")
        if mode == "free_camera":
            _boolean(_req(value, "lock_roll", "navigation.state.camera"), "lock_roll")
            _boolean(_req(value, "lock_translation_plane", "navigation.state.camera"), "lock_translation_plane")
        if mode not in ("orbit", "free_camera"):
            raise ValueError("navigation.state.camera.mode must be orbit or free_camera")
        if mode == "orbit" and any(
            name in value
            for name in (
                "lock_roll",
                "lock_translation_plane",
                "translation_scale",
            )
        ):
            raise ValueError("orbit navigation state cannot contain free-camera fields")
        return cls(
            mode=mode,
            lock_roll=(
                _boolean(value["lock_roll"], "navigation.state.camera.lock_roll")
                if "lock_roll" in value
                else None
            ),
            lock_translation_plane=(
                _boolean(
                    value["lock_translation_plane"],
                    "navigation.state.camera.lock_translation_plane",
                )
                if "lock_translation_plane" in value
                else None
            ),
            translation_scale=(
                _positive(value["translation_scale"], "navigation.state.camera.translation_scale")
                if "translation_scale" in value
                else None
            ),
        )


@dataclass(frozen=True)
class ObjectNavigationState:
    """Effective object component constraints nested in ``navigation.state``."""

    allow_translation: bool
    allow_rotation: bool

    def pack(self) -> dict:
        return {
            "allow_translation": _boolean(
                self.allow_translation,
                "navigation.state.object.allow_translation",
            ),
            "allow_rotation": _boolean(
                self.allow_rotation,
                "navigation.state.object.allow_rotation",
            ),
        }

    @classmethod
    def unpack(cls, value: dict) -> Self:
        return cls(
            allow_translation=_boolean(
                _req(value, "allow_translation", "navigation.state.object"),
                "navigation.state.object.allow_translation",
            ),
            allow_rotation=_boolean(
                _req(value, "allow_rotation", "navigation.state.object"),
                "navigation.state.object.allow_rotation",
            ),
        )


@dataclass(frozen=True)
class NavigationState(Msg):
    TYPE: ClassVar[str] = "navigation.state"
    gesture_id: int = 0
    camera: CameraNavigationState | None = None
    object: ObjectNavigationState | None = None

    def pack(self) -> dict:
        _integer(self.gesture_id, "navigation.state.gesture_id")
        if self.camera is None and self.object is None:
            raise ValueError("navigation.state requires an active camera or object")
        result: dict = {"type": self.TYPE, "gesture_id": self.gesture_id}
        if self.camera is not None:
            result["camera"] = self.camera.pack()
        if self.object is not None:
            result["object"] = self.object.pack()
        return result

    @classmethod
    def unpack(cls, value: dict) -> Self:
        camera = value.get("camera")
        object_state = value.get("object")
        if "camera" in value and not isinstance(camera, dict):
            raise ValueError("navigation.state.camera must be a map")
        if "object" in value and not isinstance(object_state, dict):
            raise ValueError("navigation.state.object must be a map")
        if camera is None and object_state is None:
            raise ValueError("navigation.state requires an active camera or object")
        return cls(
            gesture_id=_integer(
                _req(value, "gesture_id", "navigation.state"),
                "navigation.state.gesture_id",
            ),
            camera=CameraNavigationState.unpack(camera) if camera is not None else None,
            object=ObjectNavigationState.unpack(object_state) if object_state is not None else None,
        )


@dataclass(frozen=True)
class CameraPose(Msg):
    TYPE: ClassVar[str] = "camera.pose"
    gesture_id: int | None = None
    t: tuple[float, float, float] = (0.0, 0.0, 0.0)
    r: tuple[float, float, float] = (0.0, 0.0, 0.0)
    fov: float | None = None
    ortho_extent: float | None = None
    seq: int | None = None
    applied_delta_id: int | None = None

    def value(self) -> dict:
        fov, ortho_extent = _projection({key: value for key, value in self.__dict__.items() if value is not None}, "camera.pose")
        result: dict = {
            "t": _vec3(self.t, "camera.pose.t"),
            "r": _vec3(self.r, "camera.pose.r"),
        }
        result["fov" if fov is not None else "ortho_extent"] = fov if fov is not None else ortho_extent
        return result

    def pack(self) -> dict:
        if self.gesture_id is None:
            raise ValueError("camera.pose requires gesture_id as a top-level message")
        _integer(self.gesture_id, "camera.pose.gesture_id")
        self.value()
        return super().pack()

    @classmethod
    def from_value(cls, value: dict) -> Self:
        fov, ortho_extent = _projection(value, "camera.pose")
        return cls(
            t=_vec3(_req(value, "t", "camera.pose"), "camera.pose.t"),
            r=_vec3(_req(value, "r", "camera.pose"), "camera.pose.r"),
            fov=fov,
            ortho_extent=ortho_extent,
        )

    @classmethod
    def unpack(cls, value: dict) -> Self:
        nested = cls.from_value(value)
        return cls(
            gesture_id=_integer(_req(value, "gesture_id", "camera.pose"), "camera.pose.gesture_id"),
            t=nested.t,
            r=nested.r,
            fov=nested.fov,
            ortho_extent=nested.ortho_extent,
            seq=_integer(value["seq"], "camera.pose.seq") if "seq" in value else None,
            applied_delta_id=(
                _integer(value["applied_delta_id"], "camera.pose.applied_delta_id")
                if "applied_delta_id" in value
                else None
            ),
        )


@dataclass(frozen=True)
class CameraDelta(Msg):
    TYPE: ClassVar[str] = "camera.delta"
    gesture_id: int = 0
    t: tuple[float, float, float] = (0.0, 0.0, 0.0)
    r: tuple[float, float, float] = (0.0, 0.0, 0.0)
    ortho_extent_scale: float | None = None
    delta_id: int | None = None

    def pack(self) -> dict:
        _integer(self.gesture_id, "camera.delta.gesture_id")
        _vec3(self.t, "camera.delta.t")
        _vec3(self.r, "camera.delta.r")
        if self.ortho_extent_scale is not None:
            _positive(self.ortho_extent_scale, "camera.delta.ortho_extent_scale")
        if self.delta_id is not None:
            _integer(self.delta_id, "camera.delta.delta_id")
        return super().pack()

    @classmethod
    def unpack(cls, value: dict) -> Self:
        scale = value.get("ortho_extent_scale")
        if scale is not None:
            scale = _positive(scale, "camera.delta.ortho_extent_scale")
        return cls(
            gesture_id=_integer(_req(value, "gesture_id", "camera.delta"), "camera.delta.gesture_id"),
            t=_vec3(_req(value, "t", "camera.delta"), "camera.delta.t"),
            r=_vec3(_req(value, "r", "camera.delta"), "camera.delta.r"),
            ortho_extent_scale=scale,
            delta_id=_integer(value["delta_id"], "camera.delta.delta_id") if "delta_id" in value else None,
        )


@dataclass(frozen=True)
class CameraPivot(Msg):
    TYPE: ClassVar[str] = "camera.pivot"
    gesture_id: int = 0
    point: tuple[float, float, float] = (0.0, 0.0, 0.0)

    def pack(self) -> dict:
        _integer(self.gesture_id, "camera.pivot.gesture_id")
        _vec3(self.point, "camera.pivot.point")
        return super().pack()

    @classmethod
    def unpack(cls, value: dict) -> Self:
        return cls(
            gesture_id=_integer(_req(value, "gesture_id", "camera.pivot"), "camera.pivot.gesture_id"),
            point=_vec3(_req(value, "point", "camera.pivot"), "camera.pivot.point"),
        )


@dataclass(frozen=True)
class ObjectPose(Msg):
    TYPE: ClassVar[str] = "object.pose"
    gesture_id: int | None = None
    t: tuple[float, float, float] = (0.0, 0.0, 0.0)
    r: tuple[float, float, float] = (0.0, 0.0, 0.0)
    seq: int | None = None
    applied_delta_id: int | None = None

    def value(self) -> dict:
        return {
            "t": _vec3(self.t, "object.pose.t"),
            "r": _vec3(self.r, "object.pose.r"),
        }

    def pack(self) -> dict:
        if self.gesture_id is None:
            raise ValueError("object.pose requires gesture_id as a top-level message")
        _integer(self.gesture_id, "object.pose.gesture_id")
        self.value()
        return super().pack()

    @classmethod
    def from_value(cls, value: dict) -> Self:
        _object_fields(value)
        return cls(
            t=_vec3(_req(value, "t", "object.pose"), "object.pose.t"),
            r=_vec3(_req(value, "r", "object.pose"), "object.pose.r"),
        )

    @classmethod
    def unpack(cls, value: dict) -> Self:
        nested = cls.from_value(value)
        return cls(
            gesture_id=_integer(_req(value, "gesture_id", "object.pose"), "object.pose.gesture_id"),
            t=nested.t,
            r=nested.r,
            seq=_integer(value["seq"], "object.pose.seq") if "seq" in value else None,
            applied_delta_id=(
                _integer(value["applied_delta_id"], "object.pose.applied_delta_id")
                if "applied_delta_id" in value
                else None
            ),
        )


@dataclass(frozen=True)
class ObjectDelta(Msg):
    TYPE: ClassVar[str] = "object.delta"
    gesture_id: int = 0
    t: tuple[float, float, float] = (0.0, 0.0, 0.0)
    r: tuple[float, float, float] = (0.0, 0.0, 0.0)
    delta_id: int | None = None

    def pack(self) -> dict:
        _integer(self.gesture_id, "object.delta.gesture_id")
        _vec3(self.t, "object.delta.t")
        _vec3(self.r, "object.delta.r")
        if self.delta_id is not None:
            _integer(self.delta_id, "object.delta.delta_id")
        return super().pack()

    @classmethod
    def unpack(cls, value: dict) -> Self:
        _object_fields(value)
        return cls(
            gesture_id=_integer(_req(value, "gesture_id", "object.delta"), "object.delta.gesture_id"),
            t=_vec3(_req(value, "t", "object.delta"), "object.delta.t"),
            r=_vec3(_req(value, "r", "object.delta"), "object.delta.r"),
            delta_id=_integer(value["delta_id"], "object.delta.delta_id") if "delta_id" in value else None,
        )


@dataclass(frozen=True)
class ObjectPivot(Msg):
    TYPE: ClassVar[str] = "object.pivot"
    gesture_id: int = 0
    point: tuple[float, float, float] = (0.0, 0.0, 0.0)

    def pack(self) -> dict:
        _integer(self.gesture_id, "object.pivot.gesture_id")
        _vec3(self.point, "object.pivot.point")
        return super().pack()

    @classmethod
    def unpack(cls, value: dict) -> Self:
        return cls(
            gesture_id=_integer(_req(value, "gesture_id", "object.pivot"), "object.pivot.gesture_id"),
            point=_vec3(_req(value, "point", "object.pivot"), "object.pivot.point"),
        )


MSG_TYPES: dict[str, type[Msg]] = {
    item.TYPE: item
    for item in (
        Hello,
        HelloAck,
        Heartbeat,
        Error,
        Request,
        Response,
        Tags,
        Focus,
        Capabilities,
        Subscribe,
        Axes,
        MotionStart,
        MotionEnd,
        MotionCancel,
        ViewportSettled,
        Buttons,
        Frame,
        NavigationState,
        CameraPose,
        CameraDelta,
        CameraPivot,
        ObjectPose,
        ObjectDelta,
        ObjectPivot,
    )
}


def unpack_msg(value: dict) -> Msg | None:
    """Parse a known message and ignore an unknown top-level type."""
    message_type = _string(_req(value, "type", "message"), "message.type")
    message_class = MSG_TYPES.get(message_type)
    if message_class is None:
        return None
    message = message_class.unpack(value)
    message.pack()
    return message
