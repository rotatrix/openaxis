"""Object stream integration tests using the actual client and deferred scheduler."""
import unittest
import test_navigation_session as helpers
from test_navigation_session import Adapter
from openaxis.navigation_session import WriteResult
from openaxis.types import ObjectPose, ObjectPivot, MotionEnd, MotionStart


def obj(x, seq=None, ack=None):
    return ObjectPose(t=(x, 0, 0), seq=seq, gesture_id=7, applied_delta_id=ack)


class ObjectAdapter(Adapter):
    def __init__(self):
        super().__init__()
        self.camera = obj(10)
        self.limit = None

    def begin_query(self, context):
        adapter = self
        class Capture:
            def resolve(self, name):
                adapter.check()
                adapter.facts.append(name)
                return adapter.camera.value() if name == "object.pose" else None
            def initial_object_observation(self):
                return adapter.camera
        return Capture()

    def apply_object(self, context, desired, navigation, pivot):
        self.check()
        self.writes.append(desired.t[0])
        self.camera = obj(min(desired.t[0], self.limit) if self.limit is not None else desired.t[0])
        if self.on_write:
            self.on_write()
        return WriteResult(True, None if self.read_fail else self.camera)


class ObjectTests(unittest.IsolatedAsyncioTestCase):
    setup_session = helpers.CoordinatorTests.setup_session
    query = helpers.CoordinatorTests.query
    flush = helpers.CoordinatorTests.flush
    async def objects_ready(self, *, observation=True, camera=True, **options):
        self.objects = ObjectAdapter()
        self.setup_session(object_adapter=self.objects,
                           object_observation=self.objects.read if observation else None, **options)
        self.objects.session = self.session
        if not camera:
            self.adapter.context = None
        self.client._dispatch_message(MotionStart(gesture_id=7))
        self.query(values=["camera.pose", "object.pose"] if camera else ["object.pose"])
        await self.flush()

    async def test_object_only_without_camera_view(self):
        await self.objects_ready(camera=False)
        self.client._dispatch_message(obj(11, 1))
        await self.flush()
        self.assertEqual(self.objects.writes, [11])
        self.assertEqual(self.adapter.facts, [])

    async def test_full_queue_retains_each_stream_latest_in_arrival_order(self):
        from test_navigation_session import pose
        await self.objects_ready(max_work=1)
        self.client._dispatch_message(obj(11, 1))
        self.client._dispatch_message(pose(11, 1))
        self.query(2, values=["camera.pose", "object.pose"])
        for seq in range(2, 20):
            self.client._dispatch_message(obj(10 + seq, seq))
            self.client._dispatch_message(pose(20 + seq, seq))
        self.assertEqual([w[0] for w in self.session._queue], ["query", "object_pose", "pose"])
        self.client._dispatch_message(MotionEnd(gesture_id=7))
        await self.flush()
        self.assertEqual(self.objects.writes, [29])
        self.assertEqual(self.adapter.writes, [39])
        response = next(m for m in self.socket.messages if m["type"] == "response" and m["id"] == 2)
        self.assertEqual(response["result"]["values"]["object.pose"]["t"][0], 10)
        self.assertEqual(response["result"]["values"]["camera.pose"]["t"][0], 10)

    async def test_constraint_uses_existing_delta_and_ack(self):
        await self.objects_ready()
        self.objects.limit = 10
        self.client._dispatch_message(obj(12, 1))
        await self.flush()
        delta = [m for m in self.socket.messages if m["type"] == "object.delta"][-1]
        self.assertEqual(delta["t"], [-2, 0, 0])
        self.client._dispatch_message(obj(13, 2))
        await self.flush()
        self.assertEqual(self.objects.writes, [12])
        self.client._dispatch_message(obj(10, 3, delta["delta_id"]))
        await self.flush()
        self.assertEqual(self.objects.writes, [12])
        self.client._dispatch_message(obj(9, 4, delta["delta_id"]))
        await self.flush()
        self.assertEqual(self.objects.writes, [12, 9])

    async def test_camera_and_object_ack_sequences_independent(self):
        from test_navigation_session import pose
        await self.objects_ready()
        self.objects.limit = 10
        self.client._dispatch_message(obj(12, 1))
        self.client._dispatch_message(pose(11, 1))
        await self.flush()
        self.assertEqual(self.adapter.writes, [11])
        self.assertEqual(self.objects.writes, [12])
        self.adapter.camera = pose(12)
        self.session.native_camera_changed()
        await self.flush()
        self.client._dispatch_message(obj(10, 2, 0))
        await self.flush()
        self.assertIsNone(self.session._object_state.pending_id)
        self.assertEqual(self.session._state.pending_id, 0)

    async def test_write_residual_without_external_observation(self):
        await self.objects_ready(observation=False)
        self.objects.limit = 10
        self.client._dispatch_message(obj(10, 1))
        await self.flush()
        self.assertEqual(self.objects.writes, [])
        self.client._dispatch_message(obj(12, 2))
        await self.flush()
        self.assertTrue(any(m["type"] == "object.delta" for m in self.socket.messages))

    async def test_invalid_object_binding_cancels_camera_too(self):
        from test_navigation_session import pose
        await self.objects_ready()
        self.objects.context = object()
        self.client._dispatch_message(pose(11, 1))
        await self.flush()
        self.assertEqual(self.adapter.writes, [])
        self.assertIsNone(self.session._state.gesture_id)
        self.assertIsNone(self.session._object_state.gesture_id)
        self.assertEqual(len([m for m in self.socket.messages if m["type"] == "motion_cancel"]), 1)

    async def test_object_failure_cancels_whole_gesture(self):
        await self.objects_ready()
        self.objects.apply_object = lambda *args: WriteResult(False)
        self.client._dispatch_message(obj(11, 1))
        await self.flush()
        self.assertIsNone(self.session._state.gesture_id)
        self.assertIsNone(self.session._object_state.gesture_id)
        self.assertEqual([m for m in self.socket.messages if m["type"] == "motion_cancel"][-1]["reason"], "object_write_failed")

    async def test_unknown_write_readback_recovers_residual_before_another_write(self):
        await self.objects_ready()
        self.objects.read_fail = True
        self.client._dispatch_message(obj(11, 1))
        await self.flush()
        self.assertIsNone(self.session._object_state.baseline)
        self.objects.read_fail = False
        self.objects.camera = obj(15)
        self.session.native_object_changed()
        await self.flush()
        self.assertEqual(self.session._object_state.baseline.t[0], 15)
        delta = next(m for m in self.socket.messages if m["type"] == "object.delta")
        self.assertEqual(delta["t"], [4, 0, 0])
        self.client._dispatch_message(obj(12, 2))
        await self.flush()
        self.assertEqual(self.objects.writes, [11])
        self.client._dispatch_message(obj(15, 3, delta["delta_id"]))
        await self.flush()
        self.assertIsNone(self.session._object_state.pending_id)

    async def test_no_observer_does_not_turn_expected_command_into_actual(self):
        await self.objects_ready(observation=False)
        self.objects.read_fail = True
        self.client._dispatch_message(obj(11, 1))
        await self.flush()
        self.session.native_object_changed()
        await self.flush()
        self.assertIsNone(self.session._object_state.baseline)
        self.client._dispatch_message(obj(11, 2))
        await self.flush()
        self.assertEqual(self.objects.writes, [11, 11])
        self.assertFalse(any(m["type"] == "object.delta" for m in self.socket.messages))

    async def test_pivot_cleanup_and_new_gesture_baseline(self):
        await self.objects_ready()
        self.client._dispatch_message(ObjectPivot(gesture_id=7, point=(1, 2, 3)))
        await self.flush()
        self.assertEqual(self.objects.pivots[-1], (1, 2, 3))
        self.client._dispatch_message(MotionEnd(gesture_id=7))
        await self.flush()
        self.assertIsNone(self.objects.pivots[-1])
        self.assertIsNone(self.session._object_state.gesture_id)
        self.assertIsNone(self.session._state.gesture_id)

    async def test_timeout_cancels_both_streams(self):
        await self.objects_ready()
        self.objects.limit = 10
        self.client._dispatch_message(obj(12, 1))
        await self.flush()
        self.now = 2
        for _, callback in self.scheduler.timers:
            callback()
        await self.flush()
        self.assertIsNone(self.session._state.gesture_id)
        self.assertIsNone(self.session._object_state.gesture_id)


    async def test_binding_retained_across_queries_and_stale_write_completion(self):
        await self.objects_ready()
        original = self.objects.context
        self.query(request=2, values=["object.pose"])
        await self.flush()
        self.assertIs(self.session._object_context[1], original)
        def replace_gesture():
            self.client._dispatch_message(MotionStart(gesture_id=8))
        self.objects.on_write = replace_gesture
        self.objects.limit = 10
        self.client._dispatch_message(obj(12, 1))
        await self.flush()
        self.assertEqual(self.session._state.gesture_id, 8)
        self.assertEqual(self.session._object_state.gesture_id, 8)
        self.assertFalse(any(m["type"] == "object.delta" for m in self.socket.messages))

    async def test_failed_object_delta_send_cancels_both(self):
        await self.objects_ready()
        self.objects.limit = 10
        async def fail(data):
            raise RuntimeError("socket failed")
        self.socket.send = fail
        self.client._dispatch_message(obj(12, 1))
        await self.flush()
        self.assertIsNone(self.session._state.gesture_id)
        self.assertIsNone(self.session._object_state.gesture_id)

    async def test_first_object_fact_seeds_once(self):
        await self.objects_ready(observation=False)
        self.objects.camera = obj(99)
        self.query(request=2, values=[], first=["object.pose"])
        await self.flush()
        self.assertEqual(self.session._object_state.baseline.t[0], 10)
        self.client._dispatch_message(obj(10, 1))
        await self.flush()
        self.assertEqual(self.objects.writes, [])

    async def test_observer_reentry_cannot_write_superseded_target(self):
        await self.objects_ready()
        self.objects.limit = 10
        self.client._dispatch_message(obj(12, 1))
        await self.flush()
        def observer(event, **values):
            if event == "object_correction_applied":
                self.session.on_motion_start(8)
        self.session._observer = observer
        self.objects.limit = None
        self.client._dispatch_message(obj(11, 2, 0))
        await self.flush()
        self.assertEqual(self.objects.writes, [12])
        self.query(request=2, gesture=8, values=["object.pose"])
        await self.flush()
        self.assertTrue(self.session._object_state.ready)

    async def test_optional_pivot_renderer_failure_does_not_block_object_write(self):
        await self.objects_ready()
        def fail(*args):
            raise RuntimeError("overlay unavailable")
        self.objects.show_pivot = fail
        self.client._dispatch_message(ObjectPivot(gesture_id=7, point=(1, 2, 3)))
        self.client._dispatch_message(obj(11, 1))
        await self.flush()
        self.assertEqual(self.objects.writes, [11])
