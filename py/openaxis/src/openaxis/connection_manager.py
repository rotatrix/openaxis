"""Opt-in connection supervision; call from the application's asyncio loop."""

from __future__ import annotations

import asyncio
import inspect
import logging
import math
import random
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import Enum

from .types import Capabilities, ConnectionState, Focus, Subscribe, Tags, PROTO_VERSION
from .diagnostics import format_event

__all__ = ["OpenAxisConnectionManager", "ConnectionMetadata", "ConnectionManagerState", "RetryPolicy"]
_log = logging.getLogger("openaxis")


class ConnectionManagerState(str, Enum):
    STOPPED = "stopped"
    CONNECTING = "connecting"
    READY = "ready"
    RETRYING = "retrying"
    STOPPING = "stopping"


@dataclass(frozen=True)
class ConnectionMetadata:
    """Complete desired announcements; None omits an optional announcement."""

    tags: tuple[str, ...] = ()
    capabilities: tuple[str, ...] = ()
    axes: tuple[str, ...] | None = None
    focused: bool | None = None


@dataclass(frozen=True)
class RetryPolicy:
    initial_delay: float = 2.0
    max_delay: float = 4.0
    multiplier: float = 2.0
    jitter: float = 0.2

    def __post_init__(self):
        values = (self.initial_delay, self.max_delay, self.multiplier, self.jitter)
        if (not all(math.isfinite(v) for v in values) or self.initial_delay <= 0
                or self.max_delay < self.initial_delay or self.multiplier < 1
                or not 0 <= self.jitter <= 1):
            raise ValueError("Invalid retry policy")


class OpenAxisConnectionManager:
    """Own connect/retry/disconnect for one reusable client and attached session.

    ``client`` may be a wrapper whose connect() includes additional startup work.
    ``metadata`` runs on the networking loop, so read a cached snapshot or marshal
    through the application's scheduler. ``on_state`` is a passive observer with
    arguments (state, error, retry_delay); observer failures cannot break cleanup.
    All methods belong to the same asyncio loop. Cancel run() or await stop().
    """

    def __init__(self, client, *,
                 metadata: Callable[[], ConnectionMetadata | Awaitable[ConnectionMetadata]],
                 retry: RetryPolicy = RetryPolicy(), startup_timeout: float = 5.0,
                 log: Callable[[str, str], None] | None = None,
                 on_state: Callable[[ConnectionManagerState, Exception | None, float | None], None] | None = None):
        if not math.isfinite(startup_timeout) or startup_timeout <= 0:
            raise ValueError("startup_timeout must be positive and finite")
        self.client = client
        self._metadata = metadata
        self._retry = retry
        self._startup_timeout = startup_timeout
        self._on_state = on_state
        self._log_sink = log or (lambda level, message: getattr(_log, level)(message))
        self._task: asyncio.Task | None = None
        self._metadata_lock = asyncio.Lock()
        self.state = ConnectionManagerState.STOPPED
        self._outage_logged = False

    def _notify(self, state, error=None, delay=None):
        suppress = self._outage_logged and state in (
            ConnectionManagerState.CONNECTING, ConnectionManagerState.RETRYING)
        if state is ConnectionManagerState.RETRYING:
            self._outage_logged = True
        elif state in (ConnectionManagerState.READY, ConnectionManagerState.STOPPED):
            self._outage_logged = False
        self.state = state
        if state is ConnectionManagerState.CONNECTING and not suppress:
            self._emit("info", "connection.start", url=self.client.url)
        elif state is ConnectionManagerState.READY:
            self._emit("info", "connection.open", url=self.client.url, protocol=PROTO_VERSION)
        elif state is ConnectionManagerState.RETRYING and not suppress:
            self._emit("warning", "connection.retry_failed",
                       error=(str(error) or type(error).__name__) if error else "connection lost", retry_delay_s=delay)
        elif state is ConnectionManagerState.STOPPED:
            self._emit("info", "connection.stop")
        if self._on_state:
            try:
                self._on_state(state, error, delay)
            except Exception:
                _log.exception("OpenAxis lifecycle observer failed")

    def _emit(self, level, event, **fields):
        try:
            self._log_sink(level, format_event(event, **fields))
        except Exception:
            _log.exception("OpenAxis lifecycle log sink failed")

    async def _announce(self):
        send = self.client._capture_navigation_sender()
        async with self._metadata_lock:
            value = self._metadata()
            if inspect.isawaitable(value):
                value = await value
            await send(Tags(tags=tuple(value.tags)))
            await send(Capabilities(capabilities=tuple(value.capabilities)))
            if value.axes is not None:
                await send(Subscribe(axes=tuple(value.axes)))
            if value.focused is not None:
                await send(Focus(focused=value.focused))

    async def refresh_metadata(self):
        """Send the latest full snapshot when ready; reconnect always reads anew."""
        if self.state is ConnectionManagerState.READY:
            await self._announce()

    async def run(self):
        """Run until cancelled. A second concurrent run is an error."""
        if self._task is not None or self.client.state != ConnectionState.DISCONNECTED:
            raise RuntimeError("Connection lifecycle already running or client in use")
        self._task = asyncio.current_task()
        delay = self._retry.initial_delay
        try:
            while True:
                error = None
                self._notify(ConnectionManagerState.CONNECTING)
                try:
                    async with asyncio.timeout(self._startup_timeout):
                        await self.client.connect()
                        await self._announce()
                    if self.client.state != ConnectionState.CONNECTED:
                        raise ConnectionError("Connection lost during startup")
                    self._notify(ConnectionManagerState.READY)
                    delay = self._retry.initial_delay
                    await self.client.wait_disconnected()
                except Exception as exc:
                    error = exc
                finally:
                    # Also cleans up cancellation during handshake or wrapper setup.
                    await self.client.disconnect()
                actual_delay = min(self._retry.max_delay, delay * random.uniform(
                    1 - self._retry.jitter, 1 + self._retry.jitter))
                self._notify(ConnectionManagerState.RETRYING, error, actual_delay)
                await asyncio.sleep(actual_delay)
                delay = min(self._retry.max_delay, delay * self._retry.multiplier)
        finally:
            self._task = None
            self._notify(ConnectionManagerState.STOPPED)

    async def stop(self):
        """Cancel startup, retry, or the connected wait and await socket cleanup."""
        task = self._task
        if task is None:
            return
        if task is asyncio.current_task():
            raise RuntimeError("Schedule stop() outside the lifecycle observer")
        if self.state is not ConnectionManagerState.STOPPING:
            self._notify(ConnectionManagerState.STOPPING)
            task.cancel()
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            if not task.done():
                raise
