import asyncio
import unittest
from unittest.mock import Mock

import msgpack

from openaxis.async_navigation_session import AsyncNavigationSession
from openaxis.navigation_session import WriteResult
from openaxis.client import OpenAxisClient
from openaxis.navigation import NavigationQuery, UNAVAILABLE
from openaxis.types import CameraPivot, CameraPose, ConnectionState, Request


def pose(x, seq=None, gesture=7, ack=None):
    return CameraPose(t=(x, 0, 0), fov=1, seq=seq, gesture_id=gesture, applied_delta_id=ack)


class Socket:
    def __init__(self):
        self.messages = []

    async def send(self, data):
        self.messages.append(msgpack.unpackb(data, raw=False))


class Adapter:
    def __init__(self):
        self.context = object()
        self.camera = pose(0)
        self.writes = []
        self.write_started = asyncio.Event()
        self.write_release = asyncio.Event()
        self.write_release.set()
        self.read_started = asyncio.Event()
        self.read_release = asyncio.Event()
        self.read_release.set()
        self.unknown = False
        self.clamp = None

    async def capture_context(self):
        return self.context

    async def is_current(self, context):
        return self.context is context

    async def begin_query(self, context):
        return self

    async def resolve(self, name):
        if name == "camera.pose":
            return self.camera.value()
        return UNAVAILABLE

    async def initial_camera_observation(self):
        return self.camera

    async def read(self, context):
        self.read_started.set()
        await self.read_release.wait()
        return None if self.unknown else self.camera

    async def apply_camera(self, context, desired, navigation, pivot):
        self.writes.append(desired.t[0])
        self.write_started.set()
        await self.write_release.wait()
        self.camera = pose(self.clamp) if self.clamp is not None else desired
        return WriteResult(True, None if self.unknown else self.camera)


class AsyncSessionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = OpenAxisClient(client_name="test")
        self.socket = Socket()
        self.client._ws = self.socket
        self.adapter = Adapter()
        self.session = AsyncNavigationSession(self.client, self.adapter, observation=self.adapter.read)
        self.client._set_state(ConnectionState.CONNECTED)
        self.session.on_motion_start(7)
        self.query(7)
        await self.idle()

    async def asyncTearDown(self):
        self.adapter.write_release.set()
        self.adapter.read_release.set()
        await self.session.close()

    def query(self, gesture):
        query = NavigationQuery.from_request(Request(id=gesture, method="navigation.query",
            params={"gesture_id": gesture, "values": ["camera.pose"]}))
        self.session.on_navigation_query(query)
        return query

    async def idle(self):
        while self.session._worker is not None:
            await self.session._worker
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    async def test_performance_summary_waits_for_final_inflight_write(self):
        with self.assertLogs('openaxis', level='INFO') as captured:
            self.adapter.write_release.clear()
            self.session.on_camera_pose(pose(1, 1))
            await self.adapter.write_started.wait()
            self.session.on_camera_pose(pose(2, 2))
            self.session.on_camera_pose(pose(3, 3))
            self.assertFalse([r for r in captured.records if r.getMessage().startswith('navigation.performance ')])
            self.session.on_motion_end(7)
            self.adapter.write_release.set()
            await self.idle()
            await self.session.close()
        reports = [r.getMessage() for r in captured.records if r.getMessage().startswith('navigation.performance ')]
        self.assertEqual(len(reports), 1)
        report = reports[0]
        self.assertIn('reason=motion_end ', report)
        self.assertRegex(report, r'turnaround avg [0-9]+\.[0-9] ms, max [0-9]+\.[0-9] ms \[2 applied\]')
        self.assertIn('camera: poses 3, coalesced 1, writes 2 ok/0 failed', report)
        self.assertRegex(report, r'apply [0-9]+\.[0-9]/[0-9]+\.[0-9] \[2\]')
        self.assertRegex(report, r'observation [0-9]+\.[0-9]/[0-9]+\.[0-9] \[2\]')
        self.assertIn('object: no activity', report)

    async def test_performance_awaited_observation_promotes_latest_pose(self):
        with self.assertLogs('openaxis', level='INFO') as captured:
            self.adapter.read_release.clear()
            self.session.on_camera_pose(pose(1, 1))
            await self.adapter.read_started.wait()
            self.session.on_camera_pose(pose(2, 2))
            self.session.on_camera_pose(pose(3, 3))
            self.adapter.read_release.set()
            await self.idle()
            self.session.on_motion_end(7)
            await self.idle()
        report = next(r.getMessage() for r in captured.records if r.getMessage().startswith('navigation.performance '))
        self.assertIn('camera: poses 3, coalesced 2, writes 1 ok/0 failed', report)
        self.assertRegex(report, r'turnaround avg [0-9]+\.[0-9] ms, max [0-9]+\.[0-9] ms \[1 applied\]')
        self.assertRegex(report, r'observation [0-9]+\.[0-9]/[0-9]+\.[0-9] \[1\]')
        self.assertRegex(report, r'queue wait [0-9]+\.[0-9]/[0-9]+\.[0-9] \[2\]')

    async def test_one_inflight_latest_final_flush(self):
        self.adapter.write_release.clear()
        self.session.on_camera_pose(pose(1, 1))
        await self.adapter.write_started.wait()
        self.session.on_camera_pose(pose(2, 2))
        self.session.on_camera_pose(pose(3, 3))
        self.session.on_motion_end(7)
        self.assertEqual(self.adapter.writes, [1])
        self.adapter.write_release.set()
        await self.idle()
        self.assertEqual(self.adapter.writes, [1, 3])
        self.assertIsNone(self.session._state.gesture_id)

    async def test_full_queue_retains_newest_after_intervening_query(self):
        self.session._max_work = 1
        self.adapter.write_release.clear()
        self.session.on_camera_pose(pose(1, 1))
        await self.adapter.write_started.wait()
        self.session.on_camera_pose(pose(2, 2))
        self.query(7)
        for seq in range(3, 20):
            self.session.on_camera_pose(pose(seq, seq))
        self.assertEqual([w[0] for w in self.session._queue], ["query", "pose"])
        self.session.on_motion_end(7)
        self.adapter.write_release.set()
        await self.idle()
        self.assertEqual(self.adapter.writes, [1, 19])
        response = [m for m in self.socket.messages if m["type"] == "response"][-1]
        self.assertEqual(response["result"]["values"]["camera.pose"]["t"][0], 1)

    async def test_deferred_old_pose_does_not_replace_latest_async_output(self):
        self.session.on_camera_pose(pose(1, 1))
        deferred = self.session._queue.pop()
        self.query(7)
        self.session.on_camera_pose(pose(2, 2))
        self.session._enqueue(*deferred)
        await self.idle()
        self.assertEqual(self.adapter.writes, [2])

    async def test_superseded_write_cannot_seed_new_gesture(self):
        self.adapter.write_release.clear()
        self.session.on_camera_pose(pose(1, 1))
        await self.adapter.write_started.wait()
        self.session.on_camera_pose(pose(2, 2))
        self.session.on_motion_start(8)
        self.adapter.write_release.set()
        await self.idle()
        self.assertEqual(self.adapter.writes, [1])
        self.assertFalse(self.session._state.ready)
        self.assertIsNone(self.session._state.baseline)
        self.query(8)
        await self.idle()
        self.assertEqual(self.session._state.baseline.t[0], 1)

    async def test_context_change_during_read_prevents_write(self):
        self.adapter.read_release.clear()
        self.session.on_camera_pose(pose(1, 1))
        await self.adapter.read_started.wait()
        self.adapter.context = object()
        self.adapter.read_release.set()
        await self.idle()
        self.assertEqual(self.adapter.writes, [])
        self.assertTrue(any(m.get("reason") == "context_changed" for m in self.socket.messages))

    async def test_unknown_readback_retries_observation_without_delta(self):
        self.adapter.unknown = True
        self.session.on_camera_pose(pose(1, 1))
        await self.idle()
        self.assertIsNone(self.session._state.baseline)
        self.adapter.unknown = False
        self.session.on_camera_pose(pose(2, 2))
        await self.idle()
        self.assertEqual(self.adapter.writes, [1, 2])
        self.assertFalse(any(m.get("type") == "camera.delta" for m in self.socket.messages))

    async def test_native_correction_waits_for_ack(self):
        self.adapter.camera = pose(5)
        self.session.on_camera_pose(pose(1, 1))
        await self.idle()
        delta = self.session._state.pending_id
        self.assertIsNotNone(delta)
        self.session.on_camera_pose(pose(2, 2))
        await self.idle()
        self.assertEqual(self.adapter.writes, [])
        self.session.on_camera_pose(pose(6, 3, ack=delta))
        await self.idle()
        self.assertEqual(self.adapter.writes, [6])

    async def test_realized_constraint_sends_existing_delta(self):
        self.adapter.clamp = 2
        self.session.on_camera_pose(pose(10, 1))
        await self.idle()
        deltas = [m for m in self.socket.messages if m.get("type") == "camera.delta"]
        self.assertEqual(deltas[-1]["t"], [-8, 0, 0])

    async def test_timeout_cancels_instead_of_failing_open(self):
        self.adapter.camera = pose(5)
        self.session.on_camera_pose(pose(1, 1))
        await self.idle()
        state = self.session._state
        self.session._effect(state.expire(state.token, state.pending_id, state.deadline))
        self.session.on_camera_pose(pose(2, 2))
        await self.idle()
        self.assertEqual(self.adapter.writes, [])
        self.assertTrue(any(m.get("reason") == "camera_delta_timeout" for m in self.socket.messages))

    async def test_early_timeout_is_rearmed(self):
        self.adapter.camera = pose(5)
        self.session.on_camera_pose(pose(1, 1))
        await self.idle()
        state = self.session._state
        for handle in self.session._timers:
            handle.cancel()
        self.session._timers.clear()
        loop = self.session._loop
        fake = Mock(wraps=loop)
        callbacks = []
        fake.time.return_value = state.deadline - .001
        fake.call_at.side_effect = lambda deadline, callback: (callbacks.append(callback), Mock())[1]
        self.session._loop = fake
        try:
            self.session._arm_timeout(state.token, state.pending_id)
            callbacks.pop(0)()
            self.assertEqual(len(callbacks), 1)
            self.assertIsNotNone(state.gesture_id)
            fake.time.return_value = state.deadline
            callbacks.pop(0)()
            self.assertIsNone(state.gesture_id)
            self.assertFalse(callbacks)
        finally:
            self.session._loop = loop

    async def test_delayed_query_superseded(self):
        entered, release = asyncio.Event(), asyncio.Event()
        original = self.adapter.resolve
        async def delayed(name):
            entered.set()
            await release.wait()
            return await original(name)
        self.adapter.resolve = delayed
        self.query(7)
        await entered.wait()
        self.session.on_motion_start(8)
        release.set()
        await self.idle()
        self.assertFalse(self.session._state.ready)

    async def test_read_write_race_is_accepted(self):
        self.adapter.write_release.clear()
        self.session.on_camera_pose(pose(1, 1))
        await self.adapter.write_started.wait()
        self.adapter.camera = pose(100)  # Native input after observation is unobservable.
        self.adapter.write_release.set()
        await self.idle()
        self.assertEqual(self.adapter.camera.t[0], 1)

    async def test_close_waits_for_real_completion(self):
        self.adapter.write_release.clear()
        self.session.on_camera_pose(pose(1, 1))
        await self.adapter.write_started.wait()
        closing = asyncio.create_task(self.session.close())
        await asyncio.sleep(0)
        self.assertFalse(closing.done())
        self.adapter.write_release.set()
        await closing
        self.assertIsNone(self.session._state.baseline)

    async def test_failed_delta_send_cancels_without_camera_write(self):
        original = self.socket.send
        async def fail_delta(data):
            if msgpack.unpackb(data, raw=False)["type"] == "camera.delta":
                raise RuntimeError("connection send failed")
            await original(data)
        self.socket.send = fail_delta
        self.adapter.camera = pose(5)
        self.session.on_camera_pose(pose(1, 1))
        await self.idle()
        await self.idle()
        self.assertEqual(self.adapter.writes, [])
        self.assertIsNone(self.session._state.gesture_id)
        self.assertTrue(any(m.get("reason") == "camera_delta_send_failed" for m in self.socket.messages))

    async def test_newest_pose_arriving_during_read_replaces_old_output(self):
        self.adapter.read_release.clear()
        self.session.on_camera_pose(pose(1, 1))
        await self.adapter.read_started.wait()
        self.session.on_camera_pose(pose(2, 2))
        self.adapter.read_release.set()
        await self.idle()
        self.assertEqual(self.adapter.writes, [2])

    async def test_continuous_arrivals_during_reads_do_not_starve_writes(self):
        reads = []
        async def read(context):
            reads.append(len(self.adapter.writes))
            if len(reads) <= 5:
                self.session.on_camera_pose(pose(2*len(reads), 2*len(reads)))
            await asyncio.sleep(0)
            return self.adapter.camera
        self.session.observation = read
        for seq in (1, 3, 5):
            self.session.on_camera_pose(pose(seq, seq))
            await self.idle()
        self.assertEqual(self.adapter.writes, [2, 4, 6])
        self.assertEqual(reads, [0, 1, 2])

    async def test_read_promotion_does_not_cross_query(self):
        order = []
        original_read = self.adapter.read
        async def read(context):
            order.append('read')
            return await original_read(context)
        self.session.observation = read
        original_query = self.adapter.begin_query
        async def query(context):
            order.append('query')
            return await original_query(context)
        self.adapter.begin_query = query
        self.adapter.read_release.clear()
        self.session.on_camera_pose(pose(1, 1))
        await self.adapter.read_started.wait()
        self.query(7)
        self.session.on_camera_pose(pose(2, 2))
        self.adapter.read_release.set()
        await self.idle()
        self.assertEqual(order, ['read', 'query', 'read'])
        self.assertEqual(self.adapter.writes, [2])

    async def test_old_pivot_cleanup_failure_does_not_cancel_replacement(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def failing_cleanup(context, point):
            entered.set()
            await release.wait()
            raise RuntimeError("old viewport destroyed")
        self.adapter.show_pivot = failing_cleanup
        self.session.on_motion_start(8)
        await entered.wait()
        self.session.on_motion_start(9)
        self.query(9)
        release.set()
        await self.idle()
        self.assertEqual(self.session._state.gesture_id, 9)
        self.assertTrue(self.session._state.ready)
        self.assertFalse(any(m["type"] == "motion_cancel" for m in self.socket.messages))

    async def test_pivot_render_failure_does_not_prevent_navigation(self):
        async def failing_renderer(context, point):
            raise RuntimeError("overlay unavailable")
        self.adapter.show_pivot = failing_renderer
        self.session.on_camera_pivot(CameraPivot(gesture_id=7, point=(0, 0, 0)))
        self.session.on_camera_pose(pose(1, 1))
        await self.idle()
        self.assertEqual(self.adapter.writes, [1])
        self.assertEqual(self.session._state.gesture_id, 7)

    async def test_rebase_supersession_is_not_reported_as_acknowledgement(self):
        events = []
        self.session._observer = lambda event, **values: events.append(event)
        self.adapter.camera = pose(5)
        self.session.native_camera_changed()
        await self.idle()
        self.adapter.camera = CameraPose(t=(5, 0, 0), ortho_extent=20)
        self.session.native_camera_changed()
        await self.idle()
        self.assertNotIn("correction_applied", events)
        self.assertEqual(self.session._state.pending_id, 1)

    async def test_observer_invalidation_prevents_authorized_write(self):
        self.adapter.camera = pose(5)
        self.session.native_camera_changed()
        await self.idle()
        def observe(event, **values):
            if event == "correction_applied":
                self.session.context_changed()
        self.session._observer = observe
        self.session.on_camera_pose(pose(6, 1, ack=0))
        await self.idle()
        self.assertEqual(self.adapter.writes, [])
        self.assertIsNone(self.session._state._write)


    async def test_repeated_pivot_frames_during_read_do_not_starve_writes(self):
        pivot = CameraPivot(gesture_id=7, point=(0, 0, 0))
        shown = []
        async def show(context, point):
            shown.append(point)
        self.adapter.show_pivot = show
        self.session.on_camera_pivot(pivot)
        await self.idle()
        reads = []
        async def read(context):
            reads.append(len(self.adapter.writes))
            if len(reads) <= 5:
                # OrbitMode emits a pose followed by its pivot every frame.
                self.session.on_camera_pose(pose(2 * len(reads), 2 * len(reads)))
                self.session.on_camera_pivot(pivot)
            await asyncio.sleep(0)
            return self.adapter.camera
        self.session.observation = read
        for seq in (1, 3, 5):
            self.session.on_camera_pose(pose(seq, seq))
            self.session.on_camera_pivot(pivot)
            await self.idle()
        self.assertEqual(self.adapter.writes, [2, 4, 6])
        self.assertEqual(reads, [0, 1, 2])
        self.assertEqual(shown, [(0, 0, 0)])

    async def test_same_pivot_is_not_dropped_after_gesture_replacement(self):
        shown = []
        async def show(context, point):
            shown.append(point)
        self.adapter.show_pivot = show
        self.session.on_camera_pivot(CameraPivot(gesture_id=7, point=(0, 0, 0)))
        await self.idle()
        self.session.on_motion_start(8)
        self.query(8)
        self.session.on_camera_pivot(CameraPivot(gesture_id=8, point=(0, 0, 0)))
        await self.idle()
        self.assertEqual(shown, [(0, 0, 0), None, (0, 0, 0)])

    async def test_changed_pivot_remains_an_ordering_boundary(self):
        self.session.on_camera_pivot(CameraPivot(gesture_id=7, point=(0, 0, 0)))
        await self.idle()
        self.adapter.read_release.clear()
        self.session.on_camera_pose(pose(1, 1))
        await self.adapter.read_started.wait()
        self.session.on_camera_pivot(CameraPivot(gesture_id=7, point=(1, 0, 0)))
        self.session.on_camera_pose(pose(2, 2))
        self.adapter.read_release.set()
        await self.idle()
        self.assertEqual(self.adapter.writes, [2])
        self.assertEqual(self.session._pivot, (1, 0, 0))
