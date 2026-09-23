"""Synchronous-adapter navigation coordinator implementation.

The scheduler posts callbacks (never inline) on the adapter thread. Client callbacks
only touch locked state; all adapter calls occur in drain, outside that lock.
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
from collections import deque
from dataclasses import dataclass

from ._navigation_performance import NavigationPerformance
from ._session import SessionState, compare, compare_object
from .client import OpenAxisListener
from .navigation import UNAVAILABLE
from .types import CameraDelta, CameraPose, ObjectDelta, ObjectPose, ConnectionState, MotionCancel, Response, RpcError

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class WriteResult:
    success: bool
    realized_pose: object = None


@dataclass(eq=False)
class _Query:
    query: object
    token: object
    epoch: int
    send: object
    loop: object


class NavigationSession(OpenAxisListener):
    def __init__(self, client, adapter, scheduler, *, observation=None,
                 clock=time.monotonic, timeout=1.0, max_queries=32, max_work=64,
                 drain_budget=32, comparison=compare, observer=None, diagnostics=None,
                 object_adapter=None, object_observation=None, object_comparison=compare_object):
        if min(max_queries, max_work, drain_budget) < 1:
            raise ValueError("queue limits must be positive")
        self.client, self.adapter, self.scheduler = client, adapter, scheduler
        self.observation, self.clock = observation, clock
        self._state = SessionState(timeout=timeout, comparison=comparison)
        self.object_adapter, self.object_observation = object_adapter, object_observation
        self._object_state = SessionState(timeout=timeout, comparison=object_comparison, stream="object")
        self._object_context = None
        self._object_pivot = None
        self._observer = observer
        self.diagnostics = diagnostics
        if diagnostics is not None:
            diagnostics.bind(comparison, object_comparison)
        self._performance = NavigationPerformance()
        self._ui_gesture = None
        self._diagnostic = None
        self._cleanup_reason = "connection_changed"
        self._lock = threading.Lock()
        self._queue = deque()
        self._queries = set()
        self._max_queries, self._max_work, self._budget = max_queries, max_work, drain_budget
        self._scheduled = self._draining = self._closed = False
        self._cleanup = False
        self._context = None
        self._navigation = self._pivot = None
        self._deferred_pose = None
        self._send = self._loop = None
        self._detach = client._attach_navigation(self)
        if client.state == ConnectionState.CONNECTED:
            try:
                self.on_state_change(client.state)
            except Exception:
                self._detach()
                raise

    def _notify(self, event, **values):
        """Passive diagnostics, on the adapter thread, outside the state lock."""
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
        with self._lock:
            if self._scheduled or self._draining or not (self._queue or self._cleanup or self._state.ending or self._diagnostic):
                return
            self._scheduled = True
        try:
            self.scheduler.post(self.drain)
        except Exception:
            with self._lock:
                self._scheduled = False
            raise

    def _enqueue(self, kind, token, value=None):
        # Caller holds the lock. Each pose stream has one reserved latest slot
        # beyond the non-pose budget. Replacing moves it to its arrival position
        # so a newer pose never overtakes an intervening query.
        work = (kind, token, value)
        pose_kinds = ("pose", "object_pose")
        if kind in pose_kinds:
            if any(w[:2] == work[:2] and w[2].pose.seq > value.pose.seq for w in self._queue):
                return True  # An older deferred pose must not replace newer output.
            previous = len(self._queue)
            self._queue = deque(w for w in self._queue if w[:2] != work[:2])
            perf = self._performance.stream(token, kind == "object_pose")
            if perf is not None:
                perf.coalesced += previous - len(self._queue)
            self._queue.append(work)
        elif self._queue and kind != "query" and self._queue[-1][:2] == work[:2]:
            self._queue[-1] = work
        elif sum(w[0] not in pose_kinds for w in self._queue) < self._max_work:
            self._queue.append(work)
        else:
            return False
        return True

    def on_state_change(self, state):
        with self._lock:
            if self._closed:
                return
            self._performance.finish("connection_changed", self.clock())
            self._state.connection()
            self._object_state.connection()
            retired = list(self._queries)
            self._queue.clear()
            self._cleanup = True
            self._cleanup_reason = "connection_changed"
            if state == ConnectionState.CONNECTED:
                self._send = self.client._capture_navigation_sender()
                self._loop = asyncio.get_running_loop()
            else:
                self._send = self._loop = None
        for work in retired:
            self._reply(work, None, wire=False)
        self._wake()

    def on_motion_start(self, gesture_id):
        with self._lock:
            if self._closed or self._send is None:
                return
            self._state.start(gesture_id)
            self._object_state.start(gesture_id)
            self._performance.begin(gesture_id, self._state.token, self.clock())
            retired = [q for q in self._queries if q.token is not None]
            self._queue = deque(w for w in self._queue if w[0] == "query" and w[2].token is None)
            self._cleanup = True
            self._cleanup_reason = "superseded"
        for work in retired:
            self._reply(work, None)
        self._wake()

    def on_motion_end(self, gesture_id):
        with self._lock:
            if self._closed or gesture_id != self._state.gesture_id:
                return
            self._state.end(self._state.token)
            self._object_state.end(self._object_state.token)
        self._wake()

    def on_navigation_query(self, query):
        with self._lock:
            work = _Query(query, self._state.token if query.scoped else None,
                          self._state.epoch, self._send, self._loop)
            self._queries.add(work)
            valid = (not self._closed and self._send is not None
                     and (not query.scoped or (query.gesture_id == self._state.gesture_id and not self._state.ending))
                     and len(self._queries) <= self._max_queries)
            accepted = valid and self._enqueue("query", work.token, work)
        if not accepted:
            self._reply(work, None)
        self._wake()
        return True

    def on_camera_pose(self, pose):
        with self._lock:
            if self._closed:
                return
            accepted = self._state.receive(self._state.epoch, pose)
            if accepted is not None:
                perf = self._performance.stream(accepted.token, False)
                if perf is not None:
                    deferred = self._deferred_pose
                    if deferred is not None and deferred[1] == accepted.token and perf.is_pending(deferred[2].pose.seq):
                        perf.coalesced += 1
                    perf.receive(pose.seq, self.clock())
                self._enqueue("pose", accepted.token, accepted)
            elif self._observer is not None:
                self._diagnostic = dict(kind="camera.pose", gesture_id=pose.gesture_id,
                                        reason="inactive_or_stale_output")
        self._wake()

    def on_navigation_state(self, state):
        self._feedback("navigation", state.gesture_id, state)

    def on_camera_pivot(self, pivot):
        self._feedback("pivot", pivot.gesture_id, pivot.point)

    def on_object_pose(self, pose):
        with self._lock:
            if self._closed:
                return
            if self.object_adapter is None:
                effect = (self._state.cancel(self._state.token, "object_navigation_unsupported")
                          if pose.gesture_id == self._state.gesture_id else None)
            else:
                effect = None
                accepted = self._object_state.receive(self._state.epoch, pose)
                if accepted is not None:
                    perf = self._performance.stream(accepted.token, True)
                    if perf is not None:
                        perf.receive(pose.seq, self.clock())
                    self._enqueue("object_pose", accepted.token, accepted)
        if effect:
            self._effect(effect)
        self._wake()

    def on_object_pivot(self, pivot):
        self._feedback("object_pivot", pivot.gesture_id, pivot.point)

    def native_object_changed(self):
        with self._lock:
            if not self._closed and self._object_state.ready:
                self._enqueue("object_observe", self._object_state.token)
        self._wake()

    def _feedback(self, kind, gesture_id, value):
        with self._lock:
            if not self._closed and gesture_id == self._state.gesture_id and not self._state.ending:
                self._enqueue(kind, self._state.token, value)
            elif self._observer is not None:
                self._diagnostic = dict(kind=kind, gesture_id=gesture_id,
                                        reason="inactive_or_superseded_gesture")
        self._wake()

    def native_camera_changed(self):
        with self._lock:
            if not self._closed and self._state.ready:
                self._enqueue("observe", self._state.token)
        self._wake()

    def context_changed(self):
        with self._lock:
            effect = self._state.cancel(self._state.token, "context_changed")
        self._effect(effect)

    def check_context(self):
        """Adapter-thread identity check for hosts without viewport-change events.

        Does not read a camera or bind an uninitialized gesture.
        """
        with self._lock:
            bound = self._context
            object_bound = self._object_context
        if bound is not None or object_bound is not None:
            self._valid(bound[0] if bound is not None else object_bound[0],
                        bound[1] if bound is not None else None)

    def _valid(self, token, context):
        # Adapter validation is always outside the lock, and followed by a token check.
        try:
            adapter_valid = context is None or self.adapter.is_current(context)
            if adapter_valid and self._object_context is not None:
                adapter_valid = self.object_adapter.is_current(self._object_context[1])
        except Exception:
            adapter_valid = False
        with self._lock:
            current = not self._closed and self._state.current(token)
            effect = self._state.cancel(token, "context_changed") if current and not adapter_valid else None
        if effect:
            self._effect(effect)
        return current and adapter_valid

    def _reply(self, work, result, *, wire=True):
        with self._lock:
            if work not in self._queries:
                return
            self._queries.remove(work)
            # Claim exactly once, without invoking a callback under the lock.
            work.query._claim_completion()
            valid_connection = work.epoch == self._state.epoch and not self._closed
        if wire and valid_connection and work.send is not None:
            message = (Response(id=work.query.request_id, result=result) if result is not None
                       else Response(id=work.query.request_id, error=RpcError("unavailable", "Navigation context unavailable")))
            self._submit(message, work.epoch, work.send, work.loop, work.token)

    def _query(self, work):
        with self._lock:
            if work not in self._queries:
                return
            bound = self._context if work.token is not None else None
        started = self.clock()
        self._notify("query_started", query=work.query)
        try:
            context = bound[1] if bound and bound[0] == work.token else None
            capture = None
            object_bound = self._object_context if work.token is not None else None
            object_context = object_bound[1] if object_bound and object_bound[0] == work.token else None
            object_capture = None
            def resolve(name):
                nonlocal object_context, object_capture, context, capture
                fact_started = self.clock()
                error = None
                try:
                    if name.startswith("object."):
                        if self.object_adapter is None:
                            value = UNAVAILABLE
                        else:
                            if object_context is None:
                                object_context = self.object_adapter.capture_context()
                            if object_context is None or object_context is UNAVAILABLE or not self.object_adapter.is_current(object_context):
                                value = UNAVAILABLE
                            else:
                                if object_capture is None:
                                    object_capture = self.object_adapter.begin_query(object_context)
                                value = object_capture.resolve(name)
                    else:
                        if context is None:
                            context = self.adapter.capture_context()
                        if context is None or context is UNAVAILABLE or not self.adapter.is_current(context):
                            value = UNAVAILABLE
                        else:
                            if capture is None:
                                self._notify("query_context", query=work.query, context=context)
                                capture = self.adapter.begin_query(context)
                            value = capture.resolve(name)
                except Exception as exc:
                    value = UNAVAILABLE
                    error = repr(exc)
                    log.debug("Navigation fact %s failed", name, exc_info=True)
                self._notify("fact", query=work.query, name=name, value=value, error=error,
                             duration_ms=(self.clock() - fact_started) * 1000)
                if name == "camera.pose" and value is not None and value is not UNAVAILABLE:
                    CameraPose.from_value(value)  # reject malformed facts before readiness
                if name == "object.pose" and value is not None and value is not UNAVAILABLE:
                    ObjectPose.from_value(value)
                return value
            result = work.query.evaluate(resolve)
            # A query may yield reentrantly inside a adapter call.
            adapter_valid = True
            if capture is not None or bound is not None:
                adapter_valid = context is not None and context is not UNAVAILABLE and self.adapter.is_current(context)
            if object_capture is not None or object_bound is not None:
                adapter_valid = (adapter_valid and object_context is not None and object_context is not UNAVAILABLE
                              and self.object_adapter.is_current(object_context))
            try:
                object_initial = (object_capture.initial_object_observation()
                                  if object_capture is not None and self.object_observation is not None else None)
            except Exception:
                object_initial = None
            try:
                observation = capture.initial_camera_observation() if self.observation is not None else None
            except Exception:
                observation = None
            with self._lock:
                valid = (work in self._queries and work.epoch == self._state.epoch
                         and not self._closed and adapter_valid
                         and (work.token is None or self._state.current(work.token)))
                if valid and work.token is not None:
                    if capture is not None:
                        self._context = (work.token, context)
                    supplied = "camera.pose" in result.get("values", {}) or (
                        isinstance(result.get("first"), dict) and result["first"]["name"] == "camera.pose")
                    if supplied:
                        valid = self._state.camera_query(work.token, observation, allow_ending=True)
                    object_supplied = "object.pose" in result.get("values", {}) or (
                        isinstance(result.get("first"), dict) and result["first"]["name"] == "object.pose")
                    if object_capture is not None:
                        self._object_context = (work.token, object_context)
                    if object_supplied:
                        if self.object_observation is None:
                            fact = result.get("values", {}).get("object.pose")
                            if fact is None:
                                fact = result["first"]["value"]
                            object_initial = ObjectPose.from_value(fact)
                        valid = valid and self._object_state.camera_query(work.token, object_initial, allow_ending=True)
            if not valid and work.token is not None:
                with self._lock:
                    effect = self._state.cancel(work.token, "context_changed")
                self._effect(effect)
            self._reply(work, result if valid else None)
            if valid:
                self._notify("query_completed", query=work.query, result=result, duration_ms=(self.clock() - started) * 1000)
            else:
                self._notify("query_failed", query=work.query, error="Navigation context changed", duration_ms=(self.clock() - started) * 1000)
        except Exception:
            log.debug("Navigation fact collection failed", exc_info=True)
            self._reply(work, None)
            self._notify("query_failed", query=work.query, error="Navigation fact collection failed", duration_ms=(self.clock() - started) * 1000)

    def _read(self, context):
        if self.observation is None:
            return None
        try:
            return self.observation(context)
        except Exception:
            return None

    def _process(self, kind, token, value):
        with self._lock:
            bound = self._context
            current = not self._closed and self._state.current(token)
        if not current or not self._valid(token, bound[1] if bound else None):
            return
        if kind.startswith("object_"):
            self._process_object(kind, token, value)
            return
        if kind == "navigation":
            self._navigation = value
            self._notify("navigation_state", state=value)
            self._release_deferred()
            return
        if not bound or bound[0] != token:
            return
        context = bound[1]
        if kind == "pivot":
            self._pivot = value
            if hasattr(self.adapter, "show_pivot"):
                try:
                    self.adapter.show_pivot(context, value)
                except Exception:
                    log.debug("Navigation pivot display failed", exc_info=True)
            self._release_deferred()
            return
        if kind == "pose" and self._needs_pivot():
            self._deferred_pose = (kind, token, value)
            return
        received_at = None
        with self._lock:
            perf = self._performance.stream(token)
            if perf is not None and kind == "pose":
                received_at = perf.process(value.pose.seq, self.clock())
        started = self.clock() if self.observation is not None else 0
        actual = self._read(context)
        if perf is not None and self.observation is not None:
            perf.observation.add(self.clock() - started)
        if not self._valid(token, context):
            return
        with self._lock:
            pending_before = self._state.pending_id
            effect = (self._state.process(value, actual, self.clock()) if kind == "pose"
                      else self._state.observe(token, actual, self.clock()))
            pending_after = self._state.pending_id
        if (kind == "pose" and pending_before is not None and pending_before != pending_after
                and value.pose.applied_delta_id is not None
                and value.pose.applied_delta_id >= pending_before):
            self._notify("correction_applied", delta_id=pending_before)
        if pending_after is not None and effect.kind not in ("delta", "rebase"):
            self._notify("correction_waiting", delta_id=pending_after)
        if effect.kind == "apply":
            if not self._valid(token, context):
                with self._lock:
                    self._state.complete_write(effect.write, None, self.clock(), success=False)
                return
            apply_started = self.clock()
            try:
                result = self.adapter.apply_camera(context, value.pose, self._navigation, self._pivot)
            except Exception:
                result = WriteResult(False)
            if perf is not None:
                perf.applied(apply_started, self.clock(), result.success, received_at)
            self._valid(token, context)  # Still release the write if invalidated.
            with self._lock:
                effect = self._state.complete_write(effect.write, result.realized_pose if self.observation is not None else None,
                                                    self.clock(), success=result.success)
            self._notify("camera_write", desired=value.pose, realized=result.realized_pose, success=result.success)
            if result.success:
                self._notify("camera_applied", desired=value.pose, realized=result.realized_pose)
        if effect.kind in ("delta", "rebase"):
            self._notify("correction_sent", delta_id=effect.delta_id, difference=effect.difference)
        self._effect(effect)

    def _process_object(self, kind, token, value):
        bound = self._object_context
        if not bound or bound[0] != token:
            return
        context = bound[1]
        if kind == "object_pivot":
            self._object_pivot = value
            if hasattr(self.object_adapter, "show_pivot"):
                try:
                    self.object_adapter.show_pivot(context, value)
                except Exception:
                    log.debug("Object pivot display failed", exc_info=True)
            return
        received_at = None
        with self._lock:
            perf = self._performance.stream(token, True)
            if perf is not None and kind == "object_pose":
                received_at = perf.process(value.pose.seq, self.clock())
        started = self.clock() if self.object_observation is not None else 0
        try:
            actual = self.object_observation(context) if self.object_observation is not None else None
        except Exception:
            actual = None
        if perf is not None and self.object_observation is not None:
            perf.observation.add(self.clock() - started)
        if not self._valid(token, self._context[1] if self._context else None):
            return
        state = self._object_state
        with self._lock:
            pending_before = state.pending_id
            effect = (state.process(value, actual, self.clock()) if kind == "object_pose"
                      else state.observe(token, actual, self.clock()))
            pending_after = state.pending_id
        if (kind == "object_pose" and pending_before is not None and pending_before != pending_after
                and value.pose.applied_delta_id is not None and value.pose.applied_delta_id >= pending_before):
            self._notify("object_correction_applied", delta_id=pending_before)
        if pending_after is not None and effect.kind != "delta":
            self._notify("object_correction_waiting", delta_id=pending_after)
        if effect.kind == "apply":
            if not self._valid(token, self._context[1] if self._context else None):
                with self._lock:
                    state.complete_write(effect.write, None, self.clock(), success=False)
                return
            apply_started = self.clock()
            try:
                result = self.object_adapter.apply_object(context, value.pose, self._navigation, self._object_pivot)
            except Exception:
                result = WriteResult(False)
            if perf is not None:
                perf.applied(apply_started, self.clock(), result.success, received_at)
            self._valid(token, self._context[1] if self._context else None)
            with self._lock:
                effect = state.complete_write(effect.write, result.realized_pose, self.clock(), success=result.success)
            self._notify("object_write", desired=value.pose, realized=result.realized_pose, success=result.success)
            if result.success:
                self._notify("object_applied", desired=value.pose, realized=result.realized_pose)
        if effect.kind == "delta":
            self._notify("object_correction_sent", delta_id=effect.delta_id, difference=effect.difference)
        self._effect(effect, state=state)

    def _needs_pivot(self):
        return (self._navigation is not None and self._navigation.camera is not None
                and self._navigation.camera.mode == "orbit" and self._pivot is None)

    def _release_deferred(self):
        if self._deferred_pose is not None and not self._needs_pivot():
            work, self._deferred_pose = self._deferred_pose, None
            with self._lock:
                self._enqueue(*work)

    def _submit(self, message, epoch, send, loop, token=None, delta_id=None, *, state=None):
        state = self._state if state is None else state
        if send is None or loop is None:
            return

        async def deliver():
            with self._lock:
                valid = epoch == self._state.epoch and not self._closed
                if delta_id is not None:
                    valid = valid and state.current(token) and state.pending_id == delta_id
            if not valid:
                return
            try:
                # A rebase and its identity delta are one ordered SDK send job.
                for outgoing in message if isinstance(message, tuple) else (message,):
                    with self._lock:
                        if epoch != self._state.epoch or self._closed:
                            return
                        if delta_id is not None and (not state.current(token) or state.pending_id != delta_id):
                            return
                    await send(outgoing)
            except Exception:
                with self._lock:
                    effect = (state.send_failed(token, delta_id) if delta_id is not None
                              else state.cancel(token, "navigation_reply_send_failed") if token is not None
                              else None)
                if effect:
                    self._effect(effect, state=state)

        try:
            loop.call_soon_threadsafe(lambda: asyncio.create_task(deliver()))
        except RuntimeError:
            if token is not None:
                with self._lock:
                    effect = state.cancel(token, "navigation_send_unavailable")
                self._effect(effect, state=state)

    def _effect(self, effect, *, state=None):
        state = self._state if state is None else state
        if effect.kind not in ("delta", "rebase", "cancel"):
            return
        with self._lock:
            send, loop, epoch = self._send, self._loop, effect.token.epoch
            deadline = state.deadline
            retired = []
            if effect.kind == "cancel":
                self._performance.finish(effect.reason, self.clock(), effect.token)
                other = self._object_state if state is self._state else self._state
                other.cancel(effect.token, effect.reason)
                if epoch == self._state.epoch and self._state.generation == effect.token.generation + 1:
                    self._cleanup = True
                    self._cleanup_reason = effect.reason
                self._queue = deque(w for w in self._queue if w[1] != effect.token)
                retired = [q for q in self._queries if q.token == effect.token]
        for work in retired:
            self._reply(work, None)
        if effect.kind in ("delta", "rebase"):
            d = effect.difference
            message = (ObjectDelta(gesture_id=effect.gesture_id, t=d.t, r=d.r, delta_id=effect.delta_id)
                       if state is self._object_state else
                       CameraDelta(gesture_id=effect.gesture_id, t=d.t, r=d.r,
                                   ortho_extent_scale=d.scale, delta_id=effect.delta_id))
            if effect.kind == "rebase":
                p = effect.pose
                message = (CameraPose(gesture_id=effect.gesture_id, t=p.t, r=p.r,
                                      fov=p.fov, ortho_extent=p.ortho_extent), message)
            self._submit(message, epoch, send, loop, effect.token, effect.delta_id, state=state)
            if deadline is not None:
                self.scheduler.post_at(deadline, lambda: self._timeout(effect.token, effect.delta_id, state=state))
        else:
            self.scheduler.post(lambda: self._notify("cancelled", gesture_id=effect.gesture_id, reason=effect.reason))
            self._submit(MotionCancel(gesture_id=effect.gesture_id, reason=effect.reason), epoch, send, loop)
        self._wake()

    def _timeout(self, token, delta_id, *, state=None):
        state = self._state if state is None else state
        with self._lock:
            if not state.current(token) or state.pending_id != delta_id or state.deadline is None:
                return
            now = self.clock()
            deadline = state.deadline if now < state.deadline else None
            effect = state.expire(token, delta_id, now)
        if deadline is not None:
            self.scheduler.post_at(deadline, lambda: self._timeout(token, delta_id, state=state))
            return
        self._effect(effect, state=state)

    def drain(self):
        with self._lock:
            self._scheduled = False
            if self._draining:
                return
            self._draining = True
        try:
            for _ in range(self._budget):
                with self._lock:
                    cleanup = self._cleanup
                    reason = self._cleanup_reason
                    self._cleanup = False
                    diagnostic, self._diagnostic = self._diagnostic, None
                if diagnostic is not None:
                    self._notify("output_rejected", **diagnostic)
                if cleanup:
                    if self._context and hasattr(self.adapter, "show_pivot"):
                        try:
                            self.adapter.show_pivot(self._context[1], None)
                        except Exception:
                            log.debug("Navigation pivot cleanup failed", exc_info=True)
                    if self._object_context and hasattr(self.object_adapter, "show_pivot"):
                        try:
                            self.object_adapter.show_pivot(self._object_context[1], None)
                        except Exception:
                            log.debug("Object pivot cleanup failed", exc_info=True)
                    self._object_context = None
                    self._object_pivot = None
                    self._context = None
                    self._navigation = self._pivot = None
                    self._deferred_pose = None
                    if self._ui_gesture is not None:
                        self._notify("gesture_finished", gesture_id=self._ui_gesture[1], reason=reason)
                        self._ui_gesture = None
                with self._lock:
                    active = (self._state.token, self._state.gesture_id) if self._state.gesture_id is not None and not self._closed else None
                if active is not None and self._ui_gesture != active:
                    self._ui_gesture = active
                    self._notify("gesture_started", gesture_id=active[1])
                with self._lock:
                    work = self._queue.popleft() if self._queue else None
                    if work is None and self._state.ending:
                        self._performance.finish("motion_end", self.clock())
                        self._state.finish(self._state.token)
                        self._object_state.finish(self._object_state.token)
                        self._cleanup = True
                        self._cleanup_reason = "motion_end"
                if work is None:
                    break
                kind, token, value = work
                if kind == "query":
                    self._query(value)
                else:
                    self._process(kind, token, value)
        finally:
            with self._lock:
                reports = self._performance.take()
            self._performance.flush(reports)
            with self._lock:
                self._draining = False
            self._wake()

    def close(self):
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._performance.finish("closed", self.clock())
            self._state.connection()
            self._object_state.connection()
            retired = list(self._queries)
            self._queue.clear()
            self._cleanup = True
            self._cleanup_reason = "closed"
        for work in retired:
            self._reply(work, None, wire=False)
        self._detach()
        self._wake()
