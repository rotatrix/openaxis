import logging
import asyncio
import json
from pathlib import Path
import threading
import unittest
from collections import deque

import msgpack

from openaxis._navigation_session import NavigationSession, WriteResult
from openaxis.client import OpenAxisClient, OpenAxisListener
from openaxis.navigation import UNAVAILABLE
from openaxis.types import CameraPose, ConnectionState, MotionStart, MotionEnd, Request, ObjectPose, CameraPivot, NavigationState, CameraNavigationState


def pose(x, seq=None, gesture=7, ack=None):
    return CameraPose(t=(x, 0, 0), fov=1, seq=seq, gesture_id=gesture, applied_delta_id=ack)


class Scheduler:
    def __init__(self):
        self.queue, self.timers = deque(), []

    def post(self, callback):
        self.queue.append(callback)

    def post_at(self, deadline, callback):
        self.timers.append((deadline, callback))

    def run(self):
        for _ in range(100):
            if not self.queue:
                return
            self.queue.popleft()()
        raise AssertionError("drain busy loop")


class Socket:
    def __init__(self):
        self.messages = []
        self.fail_response = False

    async def send(self, data):
        message = msgpack.unpackb(data, raw=False)
        if self.fail_response and message["type"] == "response":
            raise RuntimeError("reply send failed")
        self.messages.append(message)


class Adapter:
    def __init__(self):
        self.context = object()
        self.camera = pose(10)
        self.writes, self.facts, self.pivots = [], [], []
        self.on_fact = self.on_write = None
        self.read_fail = False
        self.ui_thread = threading.get_ident()

    def check(self):
        assert threading.get_ident() == self.ui_thread
        assert not self.session._lock.locked(), "adapter called under session lock"

    def capture_context(self):
        self.check()
        return self.context

    def is_current(self, context):
        self.check()
        return context is self.context

    def begin_query(self, context):
        self.check()
        adapter = self

        class Capture:
            def resolve(self, name):
                adapter.check()
                adapter.facts.append(name)
                if adapter.on_fact:
                    callback, adapter.on_fact = adapter.on_fact, None
                    callback()
                if name == "camera.pose":
                    return adapter.camera.value()
                if name == "pick.cursor":
                    return (1, 2, 3)
                return UNAVAILABLE

            def initial_camera_observation(self):
                return adapter.camera
        return Capture()

    def read(self, context):
        self.check()
        callback = getattr(self, 'on_read', None)
        self.on_read = None
        if callback: callback()
        if self.read_fail:
            raise RuntimeError("read unavailable")
        return self.camera

    def apply_camera(self, context, desired, state, pivot):
        self.check()
        self.writes.append(desired.t[0])
        self.camera = desired
        if self.on_write:
            callback, self.on_write = self.on_write, None
            callback()
        return WriteResult(True, None if self.read_fail else self.camera)

    def show_pivot(self, context, value):
        self.check()
        self.pivots.append(value)


class CoordinatorTests(unittest.IsolatedAsyncioTestCase):
    async def test_shared_coordinator_traces(self):
        fixture = json.loads((Path(__file__).resolve().parents[3] / "fixtures/openaxis-1.0/coordinator.json").read_text(encoding="utf-8"))
        fixture['scenarios'] += json.loads((Path(__file__).resolve().parents[3] / 'fixtures/openaxis-1.0/performance.json').read_text())['scenarios']
        def subset(actual, expected):
            if isinstance(actual, str) and isinstance(expected, list):
                for part in expected: self.assertIn(part, actual)
            elif isinstance(expected, list):
                self.assertEqual(len(actual), len(expected))
                for a, e in zip(actual, expected): subset(a, e)
            elif isinstance(expected, dict):
                for k, v in expected.items(): subset(actual[k], v)
            elif isinstance(expected, (int, float)): self.assertAlmostEqual(actual, expected)
            else: self.assertEqual(actual, expected)
        self.assertEqual(fixture["version"], 1)
        for scenario in fixture["scenarios"]:
            with self.subTest(scenario=scenario["name"]):
                class Objects:
                    def __init__(self): self.pose = ObjectPose(t=(0,0,0))
                    def capture_context(self): return self
                    def is_current(self, context): return context is self
                    def begin_query(self, context): return self
                    def resolve(self, name): return self.pose.value() if name == 'object.pose' else UNAVAILABLE
                    def initial_object_observation(self): return self.pose
                    def read(self, context): return self.pose
                    def apply_object(self, context, desired, state, pivot):
                        self.pose = desired
                        return WriteResult(True, desired)
                objects = Objects()
                self.setup_session(object_adapter=objects, object_observation=objects.read)
                reports = []
                class Capture(logging.Handler):
                    def emit(self, record):
                        message = record.getMessage()
                        if message.startswith('navigation.performance '): reports.append(message)
                logger = logging.getLogger('openaxis')
                handler = Capture(); previous_level = logger.level
                logger.addHandler(handler); logger.setLevel(logging.INFO)

                def dispatch(event):
                    op = event["op"]
                    if op == "orbit":
                        self.client._dispatch_message(NavigationState(gesture_id=event.get('gesture',7), camera=CameraNavigationState(mode='orbit')))
                    elif op == "pivot":
                        self.client._dispatch_message(CameraPivot(gesture_id=event.get('gesture',7), point=(0,0,0)))
                    elif op == "write_error":
                        raise RuntimeError("host write failed")
                    elif op == "end":
                        self.client._dispatch_message(MotionEnd(gesture_id=event.get('gesture', 7)))
                    elif op == "start":
                        self.client._dispatch_message(MotionStart(gesture_id=event["gesture"]))
                    elif op == "query":
                        self.query(request=event.get("gesture", 7), gesture=event.get("gesture", 7), values=event.get("values"))
                    elif op == "object_pose":
                        self.client._dispatch_message(ObjectPose(t=(event['x'],0,0), seq=event['seq'], gesture_id=event.get('gesture',7)))
                    elif op == "on_read":
                        self.adapter.on_read = lambda: [dispatch(item) for item in event['events']]
                    elif op == "pose":
                        self.client._dispatch_message(pose(event["x"], event["seq"], event.get("gesture", 7)))
                    elif op == "context_changed":
                        self.adapter.context = object()
                        self.session.context_changed()
                    elif op == "close":
                        self.session.close()
                    elif op == "native_camera":
                        self.adapter.camera = pose(event["x"])
                        self.session.native_camera_changed()
                    elif op == "advance":
                        self.assertGreaterEqual(event["time"], self.now)
                        self.now = event["time"]
                        due = [item for item in self.scheduler.timers if item[0] <= self.now]
                        self.scheduler.timers = [item for item in self.scheduler.timers if item[0] > self.now]
                        for _, callback in due:
                            callback()
                    elif op == "on_write":
                        self.adapter.on_write = lambda: [dispatch(item) for item in event["events"]]
                    else:
                        raise AssertionError(f"Unknown operation: {op}")

                try:
                    for index, event in enumerate(scenario["events"]):
                        with self.subTest(step=index, op=event["op"]):
                            if event["op"] == "drain":
                                await self.flush()
                            elif event["op"] == "expect":
                                for key, expected in event.items():
                                    if key == "op":
                                        continue
                                    actual = {
                                        "performance": reports, "summaries": len(reports),
                                        "writes": self.adapter.writes,
                                        "pending": len(self.scheduler.queue),
                                        "cancels": sum(m["type"] == "motion_cancel" for m in self.socket.messages),
                                        "deltas": sum(m["type"] == "camera.delta" for m in self.socket.messages),
                                    }
                                    self.assertIn(key, actual)
                                    subset(actual[key], expected) if key == "performance" else self.assertEqual(actual[key], expected)
                            else:
                                dispatch(event)
                finally:
                    self.session.close()
                    await self.flush()
                    logger.removeHandler(handler); logger.setLevel(previous_level)

    def setup_session(self, **options):
        self.client = OpenAxisClient(client_name="test")
        self.socket = Socket()
        self.client._ws = self.socket
        self.adapter, self.scheduler = Adapter(), Scheduler()
        self.now = 0
        self.session = NavigationSession(self.client, self.adapter, self.scheduler,
            observation=self.adapter.read, clock=lambda: self.now, **options)
        self.adapter.session = self.session
        self.client._set_state(ConnectionState.CONNECTED)

    def query(self, request=1, gesture=7, values=None, first=None):
        params = {"values": values if values is not None else ["camera.pose"]}
        if gesture is not None:
            params["gesture_id"] = gesture
        if first is not None:
            params["first"] = first
        self.client._dispatch_message(Request(id=request, method="navigation.query", params=params))

    async def flush(self):
        self.scheduler.run()
        for _ in range(8):
            await asyncio.sleep(0)
        self.scheduler.run()

    async def test_turnaround_excludes_idle_and_keeps_inflight_arrival(self):
        await self.ready()
        with self.assertLogs('openaxis', level='INFO') as logs:
            self.now = 10  # A long idle period before this update is not latency.
            self.client._dispatch_message(pose(11, 1))
            self.now += .002
            self.adapter.on_read = lambda: setattr(self, 'now', self.now + .001)
            def write():
                self.now += .004
                # New arrival must not overwrite the timestamp of this write.
                self.client._dispatch_message(pose(12, 2))
                self.now += .001
            self.adapter.on_write = write
            await self.flush()
            perf = self.session._performance.active.camera
            self.assertEqual(perf.turnaround.count, 2)
            self.assertAlmostEqual(perf.turnaround.maximum, 8)
            self.assertAlmostEqual(perf.turnaround.total, 9)
            self.now = 20
            self.client._dispatch_message(pose(12, 3))  # Unchanged idle output.
            await self.flush()
            self.assertEqual(perf.turnaround.count, 2)
            self.client._dispatch_message(MotionEnd(gesture_id=7))
            await self.flush()
        message = next(r.getMessage() for r in logs.records if r.getMessage().startswith('navigation.performance '))
        self.assertIn('turnaround avg 4.5 ms, max 8.0 ms [2 applied]', message)

    async def ready(self, **options):
        self.setup_session(**options)
        self.client._dispatch_message(MotionStart(gesture_id=7))
        self.query()
        await self.flush()

    async def test_diagnostic_failure_is_passive(self):
        class BrokenDiagnostics:
            def bind(self, *args):
                pass
            def observe(self, *args, **kwargs):
                raise RuntimeError("broken renderer")
        await self.ready(diagnostics=BrokenDiagnostics())
        self.client._dispatch_message(pose(11,seq=1))
        await self.flush()
        self.assertEqual(len(self.adapter.writes),1)

    async def test_idle_frames_do_not_commit_or_schedule_corrections(self):
        await self.ready()
        for seq in range(1, 61):
            self.client._dispatch_message(pose(10, seq))
            await self.flush()
        self.assertEqual(self.adapter.writes, [])
        self.assertFalse(self.scheduler.queue)
        self.assertFalse(self.scheduler.timers)
        self.client._dispatch_message(pose(11, 61))
        await self.flush()
        self.client._dispatch_message(pose(11, 62))
        await self.flush()
        self.assertEqual(self.adapter.writes, [11])

    async def test_callbacks_only_enqueue_and_wake_is_coalesced(self):
        self.setup_session()
        self.client._dispatch_message(MotionStart(gesture_id=7))
        self.query(first=["missing", "pick.cursor", "never"])
        for seq in range(1, 20):
            self.client._dispatch_message(pose(10 + seq, seq))
        self.assertEqual(self.adapter.facts, [])
        self.assertEqual(self.adapter.writes, [])
        self.assertEqual(len(self.scheduler.queue), 1)
        await self.flush()
        self.assertEqual(self.adapter.writes, [29])
        self.assertEqual(self.adapter.facts, ["camera.pose", "missing", "pick.cursor"])
        self.assertEqual(self.socket.messages[0]["result"]["first"]["name"], "pick.cursor")

    async def test_transport_thread_never_calls_host(self):
        await self.ready()
        await asyncio.to_thread(self.client._dispatch_message, pose(11, 1))
        self.assertEqual(self.adapter.writes, [])
        await self.flush()
        self.assertEqual(self.adapter.writes, [11])

    async def test_final_pose_after_query_in_same_drain(self):
        self.setup_session()
        self.client._dispatch_message(MotionStart(gesture_id=7))
        self.query()
        self.client._dispatch_message(pose(11, 1))
        self.client._dispatch_message(MotionEnd(gesture_id=7))
        await self.flush()
        self.assertEqual(self.adapter.writes, [11])
        self.assertIsNone(self.session._state.gesture_id)

    async def test_unscoped_query_cannot_authorize_pose(self):
        self.setup_session()
        self.client._dispatch_message(MotionStart(gesture_id=7))
        self.query(gesture=None)
        self.client._dispatch_message(pose(11, 1))
        await self.flush()
        self.assertEqual(self.adapter.writes, [])
        self.assertFalse(self.session._state.ready)

    async def test_context_changes_during_query_cancel_and_reply_once(self):
        self.setup_session()
        self.client._dispatch_message(MotionStart(gesture_id=7))
        self.adapter.on_fact = lambda: setattr(self.adapter, "context", object())
        self.query()
        await self.flush()
        responses = [m for m in self.socket.messages if m["type"] == "response"]
        self.assertEqual(len(responses), 1)
        self.assertIn("error", responses[0])
        self.assertTrue(any(m["type"] == "motion_cancel" for m in self.socket.messages))
        self.assertFalse(self.session._state.ready)

    async def test_replacement_during_query_retires_exactly_once(self):
        self.setup_session()
        self.client._dispatch_message(MotionStart(gesture_id=7))
        self.adapter.on_fact = lambda: self.client._dispatch_message(MotionStart(gesture_id=8))
        self.query()
        await self.flush()
        self.assertEqual(len([m for m in self.socket.messages if m["type"] == "response"]), 1)
        self.assertFalse(self.session._state.ready)

    async def test_read_failure_retries_on_next_pose(self):
        await self.ready()
        self.adapter.read_fail = True
        self.client._dispatch_message(pose(20, 1))
        await self.flush()
        self.assertIsNone(self.session._state.baseline)
        self.adapter.read_fail = False
        self.client._dispatch_message(pose(21, 2))
        await self.flush()
        self.assertEqual(self.adapter.writes, [20, 21])
        self.assertFalse(any(m["type"] == "camera.delta" for m in self.socket.messages))

    async def test_native_motion_uses_barrier_and_later_query_does_not_reset(self):
        await self.ready()
        self.adapter.camera = pose(12)
        self.session.native_camera_changed()
        await self.flush()
        self.adapter.camera = pose(15)
        self.query(2)
        self.client._dispatch_message(pose(12, 1, ack=0))
        await self.flush()
        deltas = [m for m in self.socket.messages if m["type"] == "camera.delta"]
        self.assertEqual([m["t"][0] for m in deltas], [2, 3])
        self.assertEqual(self.adapter.writes, [])

    async def test_timeout_without_new_messages_cancels(self):
        await self.ready()
        self.adapter.camera = pose(12)
        self.session.native_camera_changed()
        await self.flush()
        self.scheduler.timers.pop(0)[1]()
        self.assertEqual(len(self.scheduler.timers), 1)
        self.assertIsNotNone(self.session._state.gesture_id)
        self.now = 2
        self.scheduler.timers[0][1]()
        await self.flush()
        self.assertIsNone(self.session._state.gesture_id)
        self.assertTrue(any(m["type"] == "motion_cancel" for m in self.socket.messages))

    async def test_reply_send_failure_invalidates_ready_state(self):
        self.setup_session()
        self.socket.fail_response = True
        self.client._dispatch_message(MotionStart(gesture_id=7))
        self.query()
        await self.flush()
        self.assertFalse(self.session._state.ready)
        self.assertEqual([m["type"] for m in self.socket.messages], ["motion_cancel"])

    async def test_reconnect_does_not_send_queued_reply_to_new_socket(self):
        self.setup_session()
        self.client._dispatch_message(MotionStart(gesture_id=7))
        self.query()
        self.scheduler.run()  # reply is claimed, network callback not executed yet
        self.client._set_state(ConnectionState.DISCONNECTED)
        replacement = Socket()
        self.client._ws = replacement
        self.client._set_state(ConnectionState.CONNECTED)
        await self.flush()
        self.assertEqual(replacement.messages, [])

    async def test_query_overflow_is_explicit_and_drain_budget_continues(self):
        self.setup_session(max_queries=2, drain_budget=1)
        self.client._dispatch_message(MotionStart(gesture_id=7))
        for i in range(5):
            self.query(i)
        self.assertLessEqual(len(self.session._queries), 2)
        await self.flush()
        responses = [m for m in self.socket.messages if m["type"] == "response"]
        self.assertEqual(len(responses), 5)
        self.assertEqual(sum("error" in m for m in responses), 3)

    async def test_full_nonpose_queue_retains_latest_pose_after_query(self):
        await self.ready(max_work=1)
        self.client._dispatch_message(pose(11, 1))
        self.query(2)
        self.client._dispatch_message(pose(12, 2))
        self.query(3)  # Non-pose capacity remains bounded and explicitly fails.
        self.client._dispatch_message(pose(13, 3))
        self.assertEqual([w[0] for w in self.session._queue], ["query", "pose"])
        await self.flush()
        self.assertEqual(self.adapter.writes, [13])
        responses = {m["id"]: m for m in self.socket.messages if m["type"] == "response"}
        self.assertEqual(responses[2]["result"]["values"]["camera.pose"]["t"][0], 10)
        self.assertIn("error", responses[3])

    async def test_deferred_old_pose_cannot_evict_newer_queued_pose(self):
        await self.ready(max_work=1)
        self.client._dispatch_message(pose(11, 1))
        deferred = self.session._queue.pop()
        self.query(2)
        self.client._dispatch_message(pose(12, 2))
        with self.session._lock:
            self.session._enqueue(*deferred)
        await self.flush()
        self.assertEqual(self.adapter.writes, [12])

    async def test_reentrant_drain_and_replacement_write(self):
        await self.ready(drain_budget=1)
        def during_write():
            self.client._dispatch_message(MotionStart(gesture_id=8))
            self.query(2, gesture=8)
            self.session.drain()  # must not recursively call adapter
        self.adapter.on_write = during_write
        self.client._dispatch_message(pose(11, 1))
        await self.flush()
        self.assertEqual(self.adapter.writes, [11])
        self.assertEqual(self.session._state.gesture_id, 8)
        self.assertTrue(self.session._state.ready)

    async def test_attach_exclusive_and_close_retires_queued_work(self):
        self.setup_session()
        with self.assertRaises(RuntimeError):
            NavigationSession(self.client, self.adapter, self.scheduler)
        self.client._dispatch_message(MotionStart(gesture_id=7))
        self.query()
        self.session.close()
        await self.flush()
        self.assertFalse(self.session._queries)
        self.assertEqual(self.adapter.facts, [])
        self.assertIsNone(self.client._navigation_listener)

    async def test_context_changed_inside_write_is_not_retained(self):
        await self.ready()
        self.adapter.on_write = lambda: setattr(self.adapter, "context", object())
        self.client._dispatch_message(pose(11, 1))
        await self.flush()
        self.assertIsNone(self.session._state.gesture_id)
        self.assertIsNone(self.session._state.baseline)
        self.assertIsNone(self.session._state._write)

    async def test_cancellation_retires_pending_pose_and_hides_pivot(self):
        await self.ready()
        self.client._dispatch_message(CameraPivot(gesture_id=7, point=(1, 2, 3)))
        await self.flush()
        self.client._dispatch_message(pose(11, 1))
        self.session.context_changed()
        await self.flush()
        self.assertEqual(self.adapter.writes, [])
        self.assertIsNone(self.adapter.pivots[-1])

    async def test_failed_delayed_reply_cannot_cancel_replacement(self):
        await self.ready()
        gate = asyncio.Event()
        async def delayed_send(message):
            await gate.wait()
            raise RuntimeError("old reply failed")
        self.session._send = delayed_send
        self.query(2)
        await self.flush()
        self.client._set_state(ConnectionState.DISCONNECTED)
        self.client._ws = Socket()
        self.client._set_state(ConnectionState.CONNECTED)
        self.client._dispatch_message(MotionStart(gesture_id=7))
        self.query(3)
        await self.flush()
        gate.set()
        await self.flush()
        self.assertTrue(self.session._state.ready)
        self.assertEqual(self.session._state.gesture_id, 7)

    async def test_connection_sender_is_bound_even_after_send_lock_wait(self):
        self.setup_session()
        sender = self.client._capture_navigation_sender()
        await self.client._send_lock.acquire()
        task = asyncio.create_task(sender(MotionEnd(gesture_id=7)))
        await asyncio.sleep(0)
        replacement = Socket()
        self.client._ws = replacement
        self.client._send_lock.release()
        with self.assertRaises(RuntimeError):
            await task
        self.assertEqual(replacement.messages, [])

    async def test_camera_only_session_does_not_accept_object_output(self):
        await self.ready()
        self.query(2, values=["object.pose"])
        await self.flush()
        response = next(m for m in self.socket.messages if m.get("id") == 2)
        self.assertEqual(response["result"]["values"], {})
        self.client._dispatch_message(ObjectPose(gesture_id=7, seq=1))
        await self.flush()
        self.assertIsNone(self.session._state.gesture_id)

    async def test_messages_arriving_during_last_budget_item_get_another_wake(self):
        await self.ready(drain_budget=1)
        self.adapter.on_write = lambda: self.client._dispatch_message(pose(12, 2))
        self.client._dispatch_message(pose(11, 1))
        await self.flush()
        self.assertEqual(self.adapter.writes, [11, 12])

    async def test_failed_connected_attachment_releases_listener(self):
        self.client = OpenAxisClient(client_name="test")
        self.client._ws = Socket()
        self.client._set_state(ConnectionState.CONNECTED)
        # Connected attachment needs the client's running asyncio loop, not an
        # arbitrary adapter thread. Failure must not leave an unusable attachment.
        with self.assertRaises(RuntimeError):
            await asyncio.to_thread(NavigationSession, self.client, Adapter(), Scheduler())
        self.assertIsNone(self.client._navigation_listener)

    async def test_non_navigation_callbacks_stay_with_original_listener(self):
        class Listener(OpenAxisListener):
            def __init__(self):
                self.extensions = []
            def on_extension(self, name, value):
                self.extensions.append(name)
        await self.ready()
        listener = Listener()
        self.client._listener = listener
        self.client._dispatch_message({"type": "vendor.test"})
        self.assertEqual(listener.extensions, ["vendor.test"])

    async def test_rebase_sends_absolute_then_identity_delta_and_waits_for_id(self):
        await self.ready()
        actual = CameraPose(t=(10, 0, 0), ortho_extent=20)
        self.adapter.camera = actual
        self.session.native_camera_changed()
        await self.flush()
        absolute, marker = self.socket.messages[-2:]
        self.assertEqual(absolute["type"], "camera.pose")
        self.assertNotIn("seq", absolute)
        self.assertEqual(marker["type"], "camera.delta")
        self.assertEqual(marker["t"], [0, 0, 0])
        self.assertEqual(marker["r"], [0, 0, 0])
        self.client._dispatch_message(CameraPose(t=actual.t, ortho_extent=20, gesture_id=7, seq=1))
        await self.flush()
        self.assertEqual(self.session._state.pending_id, marker["delta_id"])
        self.client._dispatch_message(CameraPose(t=actual.t, ortho_extent=20, gesture_id=7, seq=2,
                                                 applied_delta_id=marker["delta_id"]))
        await self.flush()
        self.assertIsNone(self.session._state.pending_id)
        self.assertEqual(self.adapter.writes, [])

    async def test_rebase_failure_does_not_send_marker_and_cancels(self):
        await self.ready()
        original = self.socket.send
        async def failing(data):
            if msgpack.unpackb(data, raw=False)["type"] == "camera.pose":
                raise RuntimeError("rebase send failed")
            await original(data)
        self.socket.send = failing
        self.adapter.camera = CameraPose(t=(10, 0, 0), ortho_extent=20)
        self.session.native_camera_changed()
        await self.flush()
        self.assertFalse(any(m["type"] == "camera.delta" for m in self.socket.messages))
        self.assertTrue(any(m["type"] == "motion_cancel" for m in self.socket.messages))

    async def test_orbit_pose_waits_for_pivot_without_spinning(self):
        await self.ready()
        self.client._dispatch_message(NavigationState(gesture_id=7, camera=CameraNavigationState(mode="orbit")))
        self.client._dispatch_message(pose(11, 1))
        await self.flush()
        self.assertEqual(self.adapter.writes, [])
        self.assertEqual(len(self.scheduler.queue), 0)
        self.client._dispatch_message(CameraPivot(gesture_id=7, point=(1, 0, 0)))
        await self.flush()
        self.assertEqual(self.adapter.writes, [11])

    async def test_observers_run_on_host_thread_outside_lock_and_cannot_fail_writes(self):
        events = []
        def observer(event, **values):
            self.adapter.check()
            events.append(event)
            raise RuntimeError("diagnostic renderer failed")
        await self.ready(observer=observer)
        await asyncio.to_thread(self.client._dispatch_message, pose(11, 1))
        await self.flush()
        self.assertEqual(self.adapter.writes, [11])
        self.assertEqual(self.session._state.baseline.t[0], 11)
        self.assertIn("query_started", events)
        self.assertIn("fact", events)
        self.assertIn("query_completed", events)
        self.assertIn("camera_applied", events)

    async def test_context_poll_checks_identity_without_camera_read(self):
        await self.ready()
        self.adapter.read = lambda _: self.fail("identity check read a camera")
        self.session.observation = self.adapter.read
        self.session.check_context()
        self.assertIsNotNone(self.session._state.gesture_id)
        self.adapter.context = object()
        self.session.check_context()
        await self.flush()
        self.assertIsNone(self.session._state.gesture_id)
        self.assertTrue(any(m["type"] == "motion_cancel" for m in self.socket.messages))

    async def test_rejection_diagnostics_are_coalesced_and_deferred(self):
        events = []
        def observer(event, **values):
            self.adapter.check()
            events.append((event, values))
        await self.ready(observer=observer)
        events.clear()
        for seq in range(100):
            await asyncio.to_thread(self.client._dispatch_message, pose(11, seq, gesture=8))
        self.assertEqual(events, [])
        self.assertEqual(len(self.scheduler.queue), 1)
        await self.flush()
        self.assertEqual([e[0] for e in events], ["output_rejected"])
        self.client._dispatch_message(MotionEnd(gesture_id=7))
        await self.flush()
        finished = [v for e, v in events if e == "gesture_finished"]
        self.assertEqual(finished[0]["reason"], "motion_end")
