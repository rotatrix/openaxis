import unittest

from openaxis.types import (
    PROTO_VERSION,
    CameraDelta,
    CameraNavigationState,
    CameraPose,
    Hello,
    MotionStart,
    NavigationState,
    ObjectNavigationState,
    Request,
    Response,
    RpcError,
    Target,
    ViewportSettled,
    unpack_msg,
)


class ProtocolTypesTest(unittest.TestCase):
    def test_protocol_version(self):
        self.assertEqual(PROTO_VERSION, "openaxis/1.0")

    def test_hello_target_is_optional_and_round_trips(self):
        legacy = Hello(client_name="CAD")
        self.assertNotIn("target", legacy.pack())
        self.assertEqual(unpack_msg(legacy.pack()), legacy)

        hello = Hello(client_name="CAD", target=Target(pid="18432", app="Inventor"))
        self.assertEqual(hello.pack()["target"], {"pid": "18432", "app": "Inventor"})
        self.assertEqual(unpack_msg(hello.pack()), hello)

        for target in (Target(), Target(pid=0), Target(app=" "), Target(pid=True)):
            with self.subTest(target=target), self.assertRaises(ValueError):
                target.pack()

    def test_camera_pose_is_absolute_and_gesture_scoped(self):
        pose = CameraPose(
            gesture_id=7,
            seq=11,
            t=(1.0, 2.0, 3.0),
            r=(0.1, 0.2, 0.3),
            ortho_extent=4.0,
            applied_delta_id=5,
        )
        packed = pose.pack()
        self.assertEqual(packed["gesture_id"], 7)
        self.assertNotIn("mode", packed)
        self.assertEqual(
            pose.value(),
            {
                "t": (1.0, 2.0, 3.0),
                "r": (0.1, 0.2, 0.3),
                "ortho_extent": 4.0,
            },
        )

    def test_camera_pose_requires_one_projection_value(self):
        with self.assertRaises(ValueError):
            CameraPose().value()
        with self.assertRaises(ValueError):
            CameraPose(fov=1.0, ortho_extent=2.0).value()

    def test_delta_round_trip(self):
        packed = CameraDelta(
            gesture_id=9,
            t=(1, 2, 3),
            r=(4, 5, 6),
            ortho_extent_scale=0.8,
            delta_id=12,
        ).pack()
        self.assertEqual(unpack_msg(packed), CameraDelta.unpack(packed))

    def test_navigation_state_round_trip(self):
        state = NavigationState(
            gesture_id=4,
            camera=CameraNavigationState(
                mode="free_camera",
                lock_roll=True,
                lock_translation_plane=False,
                translation_scale=5.0,
            ),
            object=ObjectNavigationState(
                allow_translation=False,
                allow_rotation=True,
            ),
        )
        self.assertEqual(unpack_msg(state.pack()), state)

    def test_navigation_state_rejects_legacy_camera_modes(self):
        with self.assertRaises(ValueError):
            CameraNavigationState(mode="fly").pack()

    def test_orbit_state_rejects_free_camera_fields(self):
        with self.assertRaises(ValueError):
            CameraNavigationState(mode="orbit", lock_roll=True).pack()

    def test_rpc_success_and_failure_shapes(self):
        request = Request(id=3, method="navigation.query", params={"gesture_id": 2})
        self.assertEqual(unpack_msg(request.pack()), request)
        success = Response(id=3, result={"values": {}})
        failure = Response(id=4, error=RpcError("unsupported"))
        self.assertEqual(unpack_msg(success.pack()), success)
        self.assertEqual(unpack_msg(failure.pack()), failure)
        with self.assertRaises(ValueError):
            Response(id=5).pack()

    def test_gesture_and_unknown_message_handling(self):
        self.assertEqual(
            unpack_msg({"type": "motion_start", "gesture_id": 41}),
            MotionStart(gesture_id=41),
        )
        self.assertEqual(
            unpack_msg({"type": "viewport.settled"}),
            ViewportSettled(),
        )
        self.assertIsNone(unpack_msg({"type": "future.message", "value": 1}))


if __name__ == "__main__":
    unittest.main()
