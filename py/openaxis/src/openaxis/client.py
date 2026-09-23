"""Async OpenAxis 1.0 WebSocket client."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import time
from collections.abc import Awaitable, Callable

import msgpack
import websockets
from websockets.asyncio.client import ClientConnection

from .navigation import NavigationQuery
from ._version import __version__
from . import _verify
from .types import (
    DEFAULT_URL,
    PROTO_VERSION,
    MAX_INTEGER,
    SdkInfo,
    _diagnostic_string,
    _integer,
    _strings,
    Axes,
    Buttons,
    CameraDelta,
    CameraPivot,
    CameraPose,
    Capabilities,
    ConnectionState,
    Error,
    Frame,
    Focus,
    Heartbeat,
    Hello,
    HelloAck,
    MotionCancel,
    MotionEnd,
    MotionStart,
    Msg,
    NavigationState,
    ObjectDelta,
    ObjectPivot,
    ObjectPose,
    Request,
    Response,
    RpcError,
    Subscribe,
    Tags,
    Target,
    ViewportSettled,
    unpack_msg,
)

__all__ = [
    "OpenAxisClient",
    "OpenAxisListener",
    "RpcRequestError",
    "NavigationQuery",
    "CallbackHandler",
    "add_log_callback",
]

logger = logging.getLogger("openaxis")


class RpcRequestError(RuntimeError):
    """A correlated OpenAxis request failed."""

    def __init__(self, code: str, message: str | None = None):
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}" if message else code)


class CallbackHandler(logging.Handler):
    """Logging handler that forwards formatted records to a callback."""

    def __init__(self, callback: Callable[[str], None], level: int = logging.DEBUG):
        super().__init__(level)
        self._callback = callback

    def emit(self, record: logging.LogRecord) -> None:
        with contextlib.suppress(Exception):
            self._callback(self.format(record))


def add_log_callback(
    callback: Callable[[str], None],
    level: int = logging.DEBUG,
) -> CallbackHandler:
    """Route the ``openaxis`` logger to a callback."""
    handler = CallbackHandler(callback, level)
    handler.setFormatter(logging.Formatter("%(name)s: %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(min(logger.level or logging.WARNING, level))
    return handler


class OpenAxisListener:
    """Base class for server messages.

    ``on_request`` returns ``True`` when the application has accepted
    responsibility for sending the correlated response. Returning ``False``
    causes the SDK to answer ``unsupported`` automatically.
    """

    def on_frame(self, frame: Frame) -> None:
        pass

    def on_buttons(self, value: int) -> None:
        pass

    def on_motion_start(self, gesture_id: int) -> None:
        """Begin a gesture, atomically superseding any previously active one."""
        pass

    def on_motion_end(self, gesture_id: int) -> None:
        """End the matching active gesture because motion actually stopped."""
        pass

    def on_navigation_state(self, state: NavigationState) -> None:
        pass

    def on_camera_pose(self, pose: CameraPose) -> None:
        pass

    def on_camera_pivot(self, pivot: CameraPivot) -> None:
        pass

    def on_object_pose(self, pose: ObjectPose) -> None:
        pass

    def on_object_pivot(self, pivot: ObjectPivot) -> None:
        pass

    def on_axes(self, axes: list[str]) -> None:
        pass

    def on_request(self, request: Request) -> bool:
        return False

    def on_navigation_query(self, query: NavigationQuery) -> bool:
        """Accept a typed Navigation query for later application-thread evaluation."""
        return False

    def on_response(self, response: Response) -> None:
        pass

    def on_extension(self, message_type: str, message: dict) -> None:
        """Receive a private top-level message understood by this client.

        The default no-op preserves OpenAxis's requirement to ignore unknown
        message types. Specialized clients may opt into namespaced extensions.
        """
        pass

    def on_state_change(self, state: ConnectionState) -> None:
        pass

    def on_error(self, code: str, message: str) -> None:
        pass


class OpenAxisClient:
    """Async WebSocket client for OpenAxis 1.0.

    The SDK owns framing, liveness, request correlation, and typed streaming
    messages. Application APIs may be thread-bound, so incoming requests are
    handed to the listener and may be answered later with ``send_response``.
    """

    def __init__(
        self,
        *,
        url: str = DEFAULT_URL,
        client_name: str,
        listener: OpenAxisListener | None = None,
        target: Target | None = None,
        client_version: str | None = None,
    ):
        self._url = url
        self._client_name = client_name
        if client_version is not None:
            _diagnostic_string(client_version, "client_version")
        self._client_version = client_version
        self._target = target
        self._listener = listener or OpenAxisListener()
        self._navigation_listener: OpenAxisListener | None = None
        self._state = ConnectionState.DISCONNECTED
        self._ws: ClientConnection | None = None
        self._heartbeat_task: asyncio.Task[None] | None = None
        self._receive_task: asyncio.Task[None] | None = None
        self._send_lock = asyncio.Lock()
        self._last_send = 0.0
        self._next_request_id = 0
        self._pending_requests: dict[int, asyncio.Future[Response]] = {}
        self._disconnected = asyncio.Event()
        self._disconnected.set()
        self._last_verification_failure = None
        self._verification_deadline: float | None = None
        self._verification_expiry: float | None = None
        self.verification_status: str | None = None

    @property
    def state(self) -> ConnectionState:
        return self._state

    async def wait_disconnected(self) -> None:
        """Wait for transport cleanup, including a close that already happened."""
        await self._disconnected.wait()

    def _attach_navigation(self, listener: OpenAxisListener) -> Callable[[], None]:
        if self._navigation_listener is not None:
            raise RuntimeError("A Navigation session is already attached")
        self._navigation_listener = listener

        def detach():
            if self._navigation_listener is listener:
                self._navigation_listener = None
        return detach

    def _capture_navigation_sender(self):
        """Capture the socket now; delayed work must never use a replacement."""
        ws = self._ws

        async def send(msg: Msg):
            async with self._send_lock:
                if self._verification_expired() or self._state == ConnectionState.CONNECTING:
                    raise RuntimeError("OpenAxis verification is not ready")
                if ws is None or self._ws is not ws:
                    raise RuntimeError("Navigation connection was retired")
                await ws.send(msgpack.packb(msg.pack(), use_bin_type=True))
                self._last_send = time.monotonic()
        return send

    @property
    def url(self) -> str:
        return self._url

    async def connect(self) -> None:
        """Connect and complete the 1.0 hello handshake."""
        if self._state != ConnectionState.DISCONNECTED:
            raise RuntimeError(f"Cannot connect from state {self._state.value}")
        self._set_state(ConnectionState.CONNECTING)
        try:
            self._ws = await websockets.connect(self._url, ping_interval=None)
            await self._send(Hello(proto=PROTO_VERSION, client_name=self._client_name, target=self._target,
                                   client_version=self._client_version, sdk=SdkInfo("openaxis-python", __version__)).pack())
            raw = await self._ws.recv()
            if not isinstance(raw, bytes):
                raise RuntimeError("Expected binary frame for hello_ack")
            msg = self._unpack_bytes(raw)
            if not isinstance(msg, HelloAck):
                raise RuntimeError(f"Expected hello_ack, got {type(msg).__name__}")
            if msg.proto != PROTO_VERSION:
                raise RuntimeError(f"Server selected unsupported protocol {msg.proto!r}")
            await self._verify_connection()
        except BaseException:
            await self._close_socket()
            self._set_state(ConnectionState.DISCONNECTED)
            raise

        self._set_state(ConnectionState.CONNECTED)
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        self._receive_task = asyncio.create_task(self._receive_loop())

    async def _verify_connection(self) -> None:
        # Receive directly until the private proof response arrives. Early
        # navigation is discarded; q is not a server-side navigation gate.
        challenge = os.urandom(32)
        request_id = self._allocate_request_id()
        await self._send(Request(id=request_id, method="q", params={"v": 1, "c": challenge}).pack())
        async with asyncio.timeout(10):
            while True:
                raw = await self._ws.recv()
                if not isinstance(raw, bytes):
                    continue
                response = self._unpack_bytes(raw)
                if isinstance(response, Error):
                    raise _verify.remote_failure(response.code, self._report_verification_failure)
                if not isinstance(response, Response) or response.id != request_id:
                    continue
                if response.error:
                    raise _verify.remote_failure(response.error.code, self._report_verification_failure)
                if len(raw) > 20 * 1024:
                    raise _verify.VerificationError()
                verified = _verify.verify(response.result, challenge, report=self._report_verification_failure)
                self._last_verification_failure = None
                self.verification_status = verified.kind + "_verified"
                self._verification_expiry = verified.expires_at
                self._verification_deadline = (None if verified.expires_at is None else
                    time.monotonic() + max(0, verified.expires_at - time.time()))
                break

    async def disconnect(self) -> None:
        if self._state == ConnectionState.DISCONNECTING:
            await self.wait_disconnected()
            return
        if self._state not in (ConnectionState.CONNECTED, ConnectionState.CONNECTING):
            return
        self._set_state(ConnectionState.DISCONNECTING)
        await self._cleanup()
        self._set_state(ConnectionState.DISCONNECTED)

    async def send_tags(self, tags: list[str]) -> None:
        await self._send(Tags(tags=_strings(tags, "tags.tags")).pack())

    async def send_focus(self, focused: bool) -> None:
        """Report whether the application controlled by this connection has focus."""
        await self._send(Focus(focused=focused).pack())

    async def send_capabilities(self, capabilities: list[str]) -> None:
        await self._send(Capabilities(capabilities=_strings(capabilities, "capabilities.capabilities")).pack())

    async def subscribe(self, axes: list[str]) -> None:
        await self._send(Subscribe(axes=_strings(axes, "subscribe.axes")).pack())

    async def send_motion_cancel(self, gesture_id: int, reason: str | None = None) -> None:
        await self._send(MotionCancel(gesture_id=gesture_id, reason=reason).pack())

    async def send_viewport_settled(self) -> None:
        await self._send(ViewportSettled().pack())

    async def send_camera_pose(
        self,
        gesture_id: int,
        t: tuple[float, float, float],
        r: tuple[float, float, float],
        *,
        fov: float | None = None,
        ortho_extent: float | None = None,
    ) -> None:
        pose = CameraPose(
            gesture_id=gesture_id,
            t=t,
            r=r,
            fov=fov,
            ortho_extent=ortho_extent,
        )
        pose.value()
        await self._send(pose.pack())

    async def send_camera_delta(
        self,
        gesture_id: int,
        t: tuple[float, float, float],
        r: tuple[float, float, float],
        *,
        ortho_extent_scale: float | None = None,
        delta_id: int | None = None,
    ) -> None:
        await self._send(
            CameraDelta(
                gesture_id=gesture_id,
                t=t,
                r=r,
                ortho_extent_scale=ortho_extent_scale,
                delta_id=delta_id,
            ).pack()
        )

    async def send_object_pose(
        self,
        gesture_id: int,
        t: tuple[float, float, float],
        r: tuple[float, float, float],
    ) -> None:
        await self._send(ObjectPose(gesture_id=gesture_id, t=t, r=r).pack())

    async def send_object_delta(
        self,
        gesture_id: int,
        t: tuple[float, float, float],
        r: tuple[float, float, float],
        *,
        delta_id: int | None = None,
    ) -> None:
        await self._send(
            ObjectDelta(
                gesture_id=gesture_id,
                t=t,
                r=r,
                delta_id=delta_id,
            ).pack()
        )

    def _allocate_request_id(self) -> int:
        if self._next_request_id > MAX_INTEGER:
            raise OverflowError("OpenAxis request IDs exhausted")
        request_id = self._next_request_id
        self._next_request_id += 1
        return request_id

    async def send_response(self, request_id: int, result: dict) -> None:
        await self._send(Response(id=request_id, result=result).pack())

    async def send_response_error(
        self,
        request_id: int,
        code: str,
        message: str | None = None,
    ) -> None:
        await self._send(
            Response(
                id=request_id,
                error=RpcError(code=code, message=message),
            ).pack()
        )

    async def request(
        self,
        method: str,
        params: dict | None = None,
        *,
        timeout: float | None = 5.0,
    ) -> dict:
        """Send a correlated request and return its result."""
        loop = asyncio.get_running_loop()
        request_id = self._allocate_request_id()
        future: asyncio.Future[Response] = loop.create_future()
        self._pending_requests[request_id] = future
        try:
            await self._send(
                Request(
                    id=request_id,
                    method=method,
                    params={} if params is None else params,
                ).pack()
            )
            response = await future if timeout is None else await asyncio.wait_for(future, timeout)
        finally:
            self._pending_requests.pop(request_id, None)
        if response.error is not None:
            raise RpcRequestError(response.error.code, response.error.message)
        return response.result or {}

    async def execute_command(self, name: str, **params: object) -> dict:
        return await self.request("command.execute", {"name": name, **params})

    async def _send(self, msg: dict) -> None:
        if self._verification_expired():
            raise _verify.VerificationError("expired")
        if self._state == ConnectionState.CONNECTING and msg.get("type") != "hello" and not (
            msg.get("type") == "request" and msg.get("method") == "q"
        ):
            raise RuntimeError("OpenAxis verification is pending")
        ws = self._ws
        if ws is None:
            raise RuntimeError("OpenAxis client is not connected")
        async with self._send_lock:
            await ws.send(msgpack.packb(msg, use_bin_type=True))
            self._last_send = time.monotonic()

    async def _heartbeat_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(1.0)
                if self._verification_expired():
                    await self._close_socket()
                    return
                if time.monotonic() - self._last_send >= 1.0:
                    await self._send(Heartbeat().pack())
        except (asyncio.CancelledError, websockets.ConnectionClosed):
            pass

    async def _receive_loop(self) -> None:
        try:
            async for message in self._ws:  # type: ignore[union-attr]
                if isinstance(message, bytes):
                    self._handle_message(message)
        except (websockets.ConnectionClosed, asyncio.CancelledError):
            pass
        finally:
            if self._state == ConnectionState.CONNECTED:
                self._set_state(ConnectionState.DISCONNECTING)
                await self._cleanup(from_receive=True)
                self._set_state(ConnectionState.DISCONNECTED)

    @staticmethod
    def _unpack_bytes(data: bytes) -> Msg | dict:
        value = msgpack.unpackb(data, raw=False)
        if not isinstance(value, dict):
            raise ValueError("OpenAxis message must be a map")
        message_type = value.get("type")
        if not isinstance(message_type, str) or not message_type:
            raise ValueError("OpenAxis message must contain a string type")
        return unpack_msg(value) or value

    def _handle_message(self, data: bytes) -> None:
        try:
            value = msgpack.unpackb(data, raw=False)
            try:
                message = unpack_msg(value) or value
            except (ValueError, TypeError, KeyError) as error:
                if isinstance(value, dict) and value.get("type") == "request":
                    try:
                        request_id = _integer(value.get("id"), "request.id")
                    except ValueError:
                        raise error
                    send = self._capture_navigation_sender()
                    detail = str(error)
                    self._schedule_on_loop(asyncio.get_running_loop(), lambda: send(
                        Response(id=request_id, error=RpcError("bad_request", detail))))
                    return
                raise
            self._dispatch_message(message)
        except Exception:
            logger.exception("Error handling OpenAxis message")

    def _dispatch_message(self, msg: Msg | dict) -> None:
        if self._verification_expired():
            return
        listener = self._listener
        navigation = self._navigation_listener or listener
        if isinstance(msg, dict):
            listener.on_extension(msg["type"], msg)
        elif isinstance(msg, Response):
            future = self._pending_requests.get(msg.id)
            if future is not None and not future.done():
                future.set_result(msg)
            else:
                listener.on_response(msg)
        elif isinstance(msg, Request):
            handled = False
            send = self._capture_navigation_sender()
            response_loop = asyncio.get_running_loop()
            def reply_error(code, message):
                self._schedule_on_loop(response_loop, lambda: send(
                    Response(id=msg.id, error=RpcError(code, message))))
            query = None
            try:
                if msg.method == "navigation.query":
                    query = NavigationQuery.from_request(
                        msg,
                        complete_callback=lambda result: self._schedule_on_loop(
                            response_loop, lambda: send(Response(id=msg.id, result=result))),
                        fail_callback=reply_error,
                    )
                    handled = navigation.on_navigation_query(query) or query.completed
                if not handled:
                    handled = listener.on_request(msg)
                if not handled and (query is None or not query.completed):
                    reply_error("unsupported", f"Unsupported method: {msg.method}")
            except Exception as error:
                if query is None or not query.completed:
                    reply_error("bad_request" if isinstance(error, (ValueError, TypeError)) else "unavailable", str(error))
            return
        elif isinstance(msg, Frame):
            listener.on_frame(msg)
        elif isinstance(msg, Buttons):
            listener.on_buttons(msg.buttons)
        elif isinstance(msg, MotionStart):
            if msg.gesture_id is None:
                raise ValueError("motion_start missing gesture_id")
            self._notify_lifecycle("on_motion_start", msg.gesture_id)
        elif isinstance(msg, MotionEnd):
            if msg.gesture_id is None:
                raise ValueError("motion_end missing gesture_id")
            self._notify_lifecycle("on_motion_end", msg.gesture_id)
        elif isinstance(msg, NavigationState):
            navigation.on_navigation_state(msg)
        elif isinstance(msg, CameraPose):
            navigation.on_camera_pose(msg)
        elif isinstance(msg, CameraPivot):
            navigation.on_camera_pivot(msg)
        elif isinstance(msg, ObjectPose):
            navigation.on_object_pose(msg)
        elif isinstance(msg, ObjectPivot):
            navigation.on_object_pivot(msg)
        elif isinstance(msg, Axes):
            listener.on_axes(list(msg.axes))
        elif isinstance(msg, Error):
            listener.on_error(msg.code, msg.message)

    def _report_verification_failure(self, message):
        if message != self._last_verification_failure:
            self._last_verification_failure = message
            _verify._LOG.warning(message)

    def _verification_expired(self) -> bool:
        return self._verification_expiry is not None and (
            time.time() >= self._verification_expiry or
            time.monotonic() >= self._verification_deadline)

    @staticmethod
    def _schedule_on_loop(
        loop: asyncio.AbstractEventLoop,
        coroutine_factory: Callable[[], Awaitable[None]],
    ) -> None:
        def schedule() -> None:
            task = asyncio.ensure_future(coroutine_factory())

            def report_error(completed: asyncio.Future) -> None:
                with contextlib.suppress(asyncio.CancelledError):
                    error = completed.exception()
                    if error is not None:
                        logger.error(
                            "Failed to send OpenAxis response",
                            exc_info=(type(error), error, error.__traceback__),
                        )

            task.add_done_callback(report_error)

        try:
            running_loop = asyncio.get_running_loop()
        except RuntimeError:
            running_loop = None
        if running_loop is loop:
            schedule()
        elif not loop.is_closed():
            loop.call_soon_threadsafe(schedule)

    def _set_state(self, state: ConnectionState) -> None:
        self._state = state
        if state == ConnectionState.CONNECTING:
            self._disconnected.clear()
        elif state == ConnectionState.DISCONNECTED:
            self.verification_status = None
            self._verification_expiry = None
            self._verification_deadline = None
            self._disconnected.set()
        self._notify_lifecycle("on_state_change", state)

    def _notify_lifecycle(self, method, value):
        listeners = [self._navigation_listener, self._listener]
        for index, listener in enumerate(listeners):
            if listener is None or (index and listener is listeners[0]):
                continue
            try:
                getattr(listener, method)(value)
            except Exception:
                logger.exception("OpenAxis lifecycle listener failed")

    async def _cleanup(self, *, from_receive: bool = False) -> None:
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            self._heartbeat_task = None
        if self._receive_task is not None:
            if not from_receive:
                self._receive_task.cancel()
            self._receive_task = None
        for future in self._pending_requests.values():
            if not future.done():
                future.set_exception(ConnectionError("OpenAxis connection closed"))
        self._pending_requests.clear()
        await self._close_socket()

    async def _close_socket(self) -> None:
        if self._ws is not None:
            await self._ws.close()
            self._ws = None
