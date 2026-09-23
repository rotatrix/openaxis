import math
import subprocess
import sys
import unittest
from dataclasses import FrozenInstanceError

from openaxis.geometry import CameraPoseValue, Vec3, pose_from_look_at


class CameraPoseValueTest(unittest.TestCase):
    def test_geometry_import_does_not_load_protocol(self):
        subprocess.run([sys.executable, "-c",
                        "import openaxis.geometry, sys; assert 'openaxis.types' not in sys.modules"],
                       check=True)

    def test_value_is_detached_and_has_no_wire_metadata(self):
        position = [1, 2, 3]
        pose = CameraPoseValue(position, (0, 0, 0))
        position[0] = 99
        self.assertEqual(pose.t, (1, 2, 3))
        self.assertFalse(hasattr(pose, "gesture_id"))
        self.assertFalse(hasattr(pose, "pack"))
        with self.assertRaises(FrozenInstanceError):
            pose.fov = 1

    def test_projection_validation(self):
        for options in ({"fov": 1, "ortho_extent": 2},
                        *({key: value} for key in ("fov", "ortho_extent")
                          for value in (0, -1, math.nan, math.inf, -math.inf))):
            with self.subTest(options=options), self.assertRaises(ValueError):
                CameraPoseValue((0, 0, 0), (0, 0, 0), **options)

    def test_coordinate_validation(self):
        for field in ("t", "r"):
            for value in ((0, 0), (0, 0, 0, 0), (math.nan, 0, 0), (0, math.inf, 0)):
                kwargs = {"t": (0, 0, 0), "r": (0, 0, 0), field: value}
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    CameraPoseValue(**kwargs)

    def test_conversion_validates_even_with_coincident_eye_and_target(self):
        for target in (Vec3(0, 0, 0), Vec3(0, 0, -1)):
            with self.assertRaises(ValueError):
                pose_from_look_at(Vec3(0, 0, 0), target, Vec3(0, 1, 0), fov=-1)
        for index in range(3):
            vectors = [Vec3(0, 0, 1), Vec3(0, 0, 0), Vec3(0, 1, 0)]
            vectors[index] = Vec3(math.nan, 0, 0)
            with self.assertRaises(ValueError):
                pose_from_look_at(*vectors)
        self.assertIsInstance(pose_from_look_at(Vec3(0, 0, 1), Vec3(0, 0, 0), Vec3(0, 1, 0)), CameraPoseValue)
