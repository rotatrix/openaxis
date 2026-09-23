"""Best-effort camera navigation for hosts with asynchronous application APIs.

All callbacks and adapter operations run on one asyncio event loop. A single worker
serializes adapter calls; incoming camera poses are coalesced while it awaits the
adapter. Generation checks prevent stale completions from modifying a newer
gesture, but cannot undo a write already issued to a remote application.
"""
from __future__ import annotations

import asyncio
import logging
from collections import deque

from ._navigation_performance import NavigationPerformance
from ._session import SessionState, compare
from .client import OpenAxisListener
from .navigation import UNAVAILABLE
from .types import CameraDelta, CameraPose, ConnectionState, MotionCancel, Response, RpcError

log = logging.getLogger(__name__)


class AsyncNavigationSession(OpenAxisListener):
    """Camera-only async counterpart of NavigationSession.

    Adapter methods ``capture_context``, ``is_current``, ``begin_query``,
    ``apply_camera`` and optional ``show_pivot`` are awaitable. Query captures
    provide awaitable ``resolve`` and ``initial_camera_observation`` methods.
    ``observation``, when supplied, is an awaitable camera reader. Writes return
    the same WriteResult as the synchronous session, after actual completion.

    Call ``await close()`` before disposing the adapter transport. Shutdown waits
    for an already issued adapter operation; transport-level timeouts remain the
    adapter's responsibility. Session callbacks must use the owning event loop.

    ``max_work`` bounds queued non-pose work. One additional slot retains the
    newest camera pose, positioned after work that arrived before that pose.
    """

    def __init__(self, client, adapter, *, observation=None, comparison=compare,
                 timeout=1.0, max_work=64, observer=None, diagnostics=None):
        if max_work < 1:
            raise ValueError("max_work must be positive")
        self.client, self.adapter, self.observation = client, adapter, observation
        self._loop = asyncio.get_running_loop()
        self._state = SessionState(comparison=comparison, timeout=timeout)
        self._max_work, self._observer = max_work, observer
        self.diagnostics = diagnostics
        if diagnostics is not None:
            diagnostics.bind(comparison)
        self._queue = deque()
        self._context = self._navigation = self._pivot = None
        self._deferred = None
        self._send = self._worker = None
        self._closed = False
        self._performance = NavigationPerformance()
        self._ui_gesture = None
        self._cleanup = False
        self._cleanup_reason = "connection_changed"
        self._queries = {}
        self._timers = set()
        self._detach = client._attach_navigation(self)
        try:
            if client.state == ConnectionState.CONNECTED:
                self.on_state_change(client.state)
        except Exception:
            self._detach()
            raise

    def _notify(self, event, **values):
        if self.diagnostics is not None:
            try:
                self.diagnostics.observe(event, **values)
            except Exception:
                log.debug("Navigation diagnostics failed", exc_info=True)
        if self._observer is not None:
            try:
                self._observer(event, **values)
            except Exception:
                log.debug("Navigation observer failed", exc_info=True)

    def _wake(self):
        if self._worker is None or self._worker.done():
            self._worker = self._loop.create_task(self._drain())

    def _enqueue(self, kind, token, value=None):
        if kind == "pose":
            if any(w[:2] == (kind, token) and w[2].pose.seq > value.pose.seq for w in self._queue):
                return True
            # Keep one latest pose in addition to the bounded non-pose queue.
            # Appending preserves its arrival order relative to queries.
            previous = len(self._queue)
            self._queue = deque(w for w in self._queue if w[:2] != (kind, token))
            perf = self._performance.stream(token, False)
            if perf is not None:
                perf.coalesced += previous - len(self._queue)
            self._queue.append((kind, token, value))
        elif self._queue and kind != "query" and self._queue[-1][:2] == (kind, token):
            self._queue[-1] = (kind, token, value)
        elif sum(w[0] != "pose" for w in self._queue) < self._max_work:
            self._queue.append((kind, token, value))
        else:
            return False
        self._wake()
        return True

    def _retire(self, reason):
        self._performance.finish(reason, self._loop.time())
        self._queue.clear()
        self._cleanup = True
        self._cleanup_reason = reason
        self._deferred = None
        for query in tuple(self._queries):
            self._reply(query, None)
        self._wake()

    def on_state_change(self, state):
        if self._closed:
            return
        self._state.connection()
        self._send = (self.client._capture_navigation_sender()
                      if state == ConnectionState.CONNECTED else None)
        self._retire("connection_changed")

    def on_motion_start(self, gesture_id):
        if not self._closed and self._send is not None:
            self._state.start(gesture_id)
            self._retire("superseded")
            self._performance.begin(gesture_id, self._state.token, self._loop.time())

    def on_motion_end(self, gesture_id):
        if gesture_id == self._state.gesture_id:
            self._state.end(self._state.token)
            self._wake()

    def on_navigation_query(self, query):
        token = self._state.token if query.scoped else None
        self._queries[query] = (self._state.epoch, token, self._send)
        valid = (not self._closed and self._send is not None and
                 (not query.scoped or (query.gesture_id == self._state.gesture_id
                                      and not self._state.ending)))
        if not valid or not self._enqueue("query", token, query):
            self._reply(query, None)
        return True

    def on_camera_pose(self, pose):
        if not self._closed:
            accepted = self._state.receive(self._state.epoch, pose)
            if accepted is not None:
                perf = self._performance.stream(accepted.token)
                if perf is not None:
                    deferred = self._deferred
                    if deferred is not None and deferred[1] == accepted.token and perf.is_pending(deferred[2].pose.seq):
                        perf.coalesced += 1
                    perf.receive(pose.seq, self._loop.time())
                self._enqueue("pose", accepted.token, accepted)
            else:
                self._notify("output_rejected", kind="camera.pose", gesture_id=pose.gesture_id,
                             reason="inactive_or_stale_output")

    def on_navigation_state(self, state):
        self._feedback("navigation", state.gesture_id, state)

    def on_camera_pivot(self, pivot):
        self._feedback("pivot", pivot.gesture_id, pivot.point)

    def _feedback(self, kind, gesture_id, value):
        if not self._closed and gesture_id == self._state.gesture_id and not self._state.ending:
            if kind == "pivot":
                # Orbit streams repeat the pivot after every pose. An unchanged
                # pivot must not block latest-pose promotion after an async read
                # or repeatedly invoke expensive host pivot rendering.
                known = (self._pivot if self._context is not None
                         and self._context[0] == self._state.token and not self._cleanup else None)
                for queued_kind, token, queued_value in self._queue:
                    if queued_kind == "query":
                        known = None  # Preserve query/context ordering barriers.
                    elif queued_kind == "pivot" and token == self._state.token:
                        known = queued_value
                if value == known:
                    return
            self._enqueue(kind, self._state.token, value)

    def on_object_pose(self, pose):
        if pose.gesture_id == self._state.gesture_id:
            self._effect(self._state.cancel(self._state.token, "object_navigation_unsupported"))

    def context_changed(self):
        self._effect(self._state.cancel(self._state.token, "context_changed"))

    def native_camera_changed(self):
        if not self._closed and self._state.ready:
            self._enqueue("observe", self._state.token)

    async def _valid(self, token, context):
        if self._closed or not self._state.current(token):
            return False
        try:
            valid = await self.adapter.is_current(context)
        except Exception:
            valid = False
        current = not self._closed and self._state.current(token)
        if current and not valid:
            self._effect(self._state.cancel(token, "context_changed"))
        return current and valid

    def _submit(self, messages, epoch, send, token=None, delta_id=None):
        async def deliver():
            try:
                for message in messages:
                    if self._closed or epoch != self._state.epoch:
                        return
                    if delta_id is not None and (not self._state.current(token)
                                                or self._state.pending_id != delta_id):
                        return
                    await send(message)
            except Exception:
                if delta_id is not None:
                    self._effect(self._state.send_failed(token, delta_id))
                elif token is not None:
                    self._effect(self._state.cancel(token, "navigation_reply_send_failed"))
        if send is not None:
            self._loop.create_task(deliver())

    def _reply(self, query, result):
        work = self._queries.pop(query, None)
        if work is None:
            return
        query._claim_completion()
        epoch, token, send = work
        message = (Response(id=query.request_id, result=result) if result is not None else
                   Response(id=query.request_id, error=RpcError("unavailable", "Navigation context unavailable")))
        self._submit((message,), epoch, send, token)

    async def _query(self, query, token):
        if query not in self._queries:
            return
        epoch = self._queries[query][0]
        started = self._loop.time()
        self._notify("query_started", query=query)
        def current():
            return (query in self._queries and not self._closed and epoch == self._state.epoch
                    and (token is None or self._state.current(token)))
        try:
            context = (self._context[1] if self._context and self._context[0] == token
                       else await self.adapter.capture_context())
            if not current() or context is None or context is UNAVAILABLE:
                self._reply(query, None)
                self._notify("query_failed", query=query, error="Navigation context unavailable",
                             duration_ms=(self._loop.time() - started) * 1000)
                return
            capture = await self.adapter.begin_query(context)
            self._notify("query_context", query=query, context=context)
            async def resolve(name):
                if not current() or name.startswith("object."):
                    return UNAVAILABLE
                try:
                    fact_started = self._loop.time()
                    value = await capture.resolve(name)
                    if not current():
                        return UNAVAILABLE
                    self._notify("fact", query=query, name=name, value=value, error=None,
                                 duration_ms=(self._loop.time() - fact_started) * 1000)
                    if name == "camera.pose" and value is not None and value is not UNAVAILABLE:
                        CameraPose.from_value(value)
                    return value if current() else UNAVAILABLE
                except Exception as error:
                    if current():
                        self._notify("fact", query=query, name=name, value=UNAVAILABLE,
                                     error=repr(error), duration_ms=(self._loop.time() - fact_started) * 1000)
                    return UNAVAILABLE
            result = await query.evaluate_async(resolve)
            observation = None
            if self.observation is not None and current():
                try:
                    observation = await capture.initial_camera_observation()
                except Exception:
                    pass
            adapter_valid = await self.adapter.is_current(context)
            valid = current() and adapter_valid
            if valid and token is not None:
                self._context = (token, context)
                supplied = "camera.pose" in result.get("values", {}) or (
                    isinstance(result.get("first"), dict) and result["first"]["name"] == "camera.pose")
                if supplied:
                    valid = self._state.camera_query(token, observation, allow_ending=True)
            if current() and not adapter_valid and token is not None:
                self._effect(self._state.cancel(token, "context_changed"))
            self._reply(query, result if valid else None)
            if valid:
                self._notify("query_completed", query=query, result=result,
                             duration_ms=(self._loop.time() - started) * 1000)
            else:
                self._notify("query_failed", query=query, error="Navigation context changed",
                             duration_ms=(self._loop.time() - started) * 1000)
        except Exception:
            log.debug("Async navigation query failed", exc_info=True)
            self._reply(query, None)
            self._notify("query_failed", query=query, error="Navigation fact collection failed",
                         duration_ms=(self._loop.time() - started) * 1000)

    async def _process(self, kind, token, value):
        if not self._context or self._context[0] != token:
            return
        context = self._context[1]
        if not await self._valid(token, context):
            return
        if kind == "navigation":
            self._navigation = value
            self._notify("navigation_state", state=value)
        elif kind == "pivot":
            self._pivot = value
            if hasattr(self.adapter, "show_pivot"):
                try:
                    await self.adapter.show_pivot(context, value)
                except Exception:
                    log.debug("Async navigation pivot rendering failed", exc_info=True)
        else:
            if kind == "pose" and self._needs_pivot():
                self._deferred = (kind, token, value)
                return
            received_at = None
            perf = self._performance.stream(token)
            if perf is not None and kind == "pose":
                received_at = perf.process(value.pose.seq, self._loop.time())
            actual = None
            if self.observation is not None:
                started = self._loop.time()
                try:
                    actual = await self.observation(context)
                except Exception:
                    pass
                if perf is not None:
                    perf.observation.add(self._loop.time() - started)
            if not await self._valid(token, context):
                return
            # A remote read can outlast several server frames. Reuse that fresh
            # observation for the newest queued pose instead of rejecting the
            # old pose and starting another read (which can starve all writes).
            # Never cross a query, pivot or navigation-state ordering boundary.
            if kind == "pose" and self._queue and self._queue[0][:2] == ("pose", token):
                _, _, value = self._queue.popleft()
                if perf is not None:
                    perf.coalesced += 1
                    received_at = perf.process(value.pose.seq, self._loop.time())
            pending = self._state.pending_id
            effect = (self._state.process(value, actual, self._loop.time()) if kind == "pose"
                      else self._state.observe(token, actual, self._loop.time()))
            if (kind == "pose" and pending is not None and self._state.pending_id != pending
                    and value.pose.applied_delta_id is not None
                    and value.pose.applied_delta_id >= pending):
                self._notify("correction_applied", delta_id=pending)
            if self._state.pending_id is not None and effect.kind not in ("delta", "rebase"):
                self._notify("correction_waiting", delta_id=self._state.pending_id)
            if effect.kind == "apply":
                # Observers can reenter application code; check again before
                # issuing the authorized write, and always release its ticket.
                if not await self._valid(token, context):
                    self._state.complete_write(effect.write, None, self._loop.time(), success=False)
                    return
                apply_started = self._loop.time()
                try:
                    result = await self.adapter.apply_camera(context, value.pose, self._navigation, self._pivot)
                    success, realized = result.success, result.realized_pose
                except Exception:
                    success, realized = False, None
                if perf is not None:
                    perf.applied(apply_started, self._loop.time(), success, received_at)
                await self._valid(token, context)
                effect = self._state.complete_write(effect.write,
                    realized if self.observation is not None else None,
                    self._loop.time(), success=success)
                self._notify("camera_write", desired=value.pose, realized=realized, success=success)
                if success and self._state.current(token):
                    self._notify("camera_applied", desired=value.pose, realized=realized)
            self._effect(effect)
        if self._deferred is not None and not self._needs_pivot():
            work, self._deferred = self._deferred, None
            self._enqueue(*work)

    def _needs_pivot(self):
        return (self._navigation is not None and self._navigation.camera is not None
                and self._navigation.camera.mode == "orbit" and self._pivot is None)

    def _effect(self, effect):
        if effect.kind == "cancel":
            self._notify("cancelled", gesture_id=effect.gesture_id, reason=effect.reason)
            self._retire(effect.reason)
            messages = (MotionCancel(gesture_id=effect.gesture_id, reason=effect.reason),)
            self._submit(messages, effect.token.epoch, self._send)
        elif effect.kind in ("delta", "rebase"):
            d = effect.difference
            self._notify("correction_sent", delta_id=effect.delta_id, difference=d)
            delta = CameraDelta(gesture_id=effect.gesture_id, t=d.t, r=d.r,
                                ortho_extent_scale=d.scale, delta_id=effect.delta_id)
            messages = (delta,)
            if effect.kind == "rebase":
                p = effect.pose
                messages = (CameraPose(gesture_id=effect.gesture_id, t=p.t, r=p.r,
                                       fov=p.fov, ortho_extent=p.ortho_extent), delta)
            self._submit(messages, effect.token.epoch, self._send, effect.token, effect.delta_id)
            self._arm_timeout(effect.token, effect.delta_id)

    def _arm_timeout(self, token, delta_id):
        state = self._state
        if not state.current(token) or state.pending_id != delta_id or state.deadline is None:
            return
        def timeout():
            self._timers.discard(handle)
            if not state.current(token) or state.pending_id != delta_id or state.deadline is None:
                return
            now = self._loop.time()
            if now < state.deadline:
                self._arm_timeout(token, delta_id)
            else:
                self._effect(state.expire(token, delta_id, now))
        handle = self._loop.call_at(state.deadline, timeout)
        self._timers.add(handle)

    async def _drain(self):
        try:
            while True:
                if self._cleanup:
                    self._cleanup = False
                    reason = self._cleanup_reason
                    old, self._context = self._context, None
                    self._navigation = self._pivot = None
                    if old and hasattr(self.adapter, "show_pivot"):
                        try:
                            await self.adapter.show_pivot(old[1], None)
                        except Exception:
                            log.debug("Async navigation pivot cleanup failed", exc_info=True)
                    if self._ui_gesture is not None:
                        self._notify("gesture_finished", gesture_id=self._ui_gesture, reason=reason)
                        self._ui_gesture = None
                    # A newer transition may have happened during cleanup.
                    if self._cleanup:
                        continue
                if self._state.gesture_id is not None and self._ui_gesture != self._state.gesture_id:
                    self._ui_gesture = self._state.gesture_id
                    self._notify("gesture_started", gesture_id=self._ui_gesture)
                if not self._queue:
                    if self._state.ending:
                        self._performance.finish("motion_end", self._loop.time())
                        self._state.finish(self._state.token)
                        self._cleanup = True
                        self._cleanup_reason = "motion_end"
                        continue
                    break
                kind, token, value = self._queue.popleft()
                if kind == "query":
                    await self._query(value, token)
                else:
                    await self._process(kind, token, value)
        except Exception:
            log.exception("Async navigation adapter operation failed")
            self._effect(self._state.cancel(self._state.token, "host_operation_failed"))
        finally:
            self._performance.flush(self._performance.take())
            self._worker = None
            if self._queue or self._cleanup:
                self._wake()

    async def close(self):
        if not self._closed:
            self._closed = True
            self._state.connection()
            self._retire("closed")
            self._detach()
            for handle in self._timers:
                handle.cancel()
            self._timers.clear()
        while self._worker is not None:
            await asyncio.shield(self._worker)
