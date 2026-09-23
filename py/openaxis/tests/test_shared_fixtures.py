import json
import math
import unittest
from dataclasses import replace
from pathlib import Path

from openaxis.geometry import CameraPoseValue, Quat, Vec3, look_at_from_pose, pose_from_look_at
from openaxis.types import unpack_msg

FIXTURE_DIR = Path(__file__).resolve().parents[3] / "fixtures" / "openaxis-1.0"


def _load(name):
    with (FIXTURE_DIR / name).open(encoding="utf-8") as fixture_file:
        return _expand(json.load(fixture_file))


def _expand(value):
    if isinstance(value, dict):
        if set(value) == {"$number"}:
            return {
                "nan": math.nan,
                "positive_infinity": math.inf,
                "negative_infinity": -math.inf,
            }[value["$number"]]
        return {key: _expand(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_expand(item) for item in value]
    return value


def _semantic(value):
    if isinstance(value, dict):
        return {key: _semantic(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_semantic(item) for item in value]
    return value


class SharedMessageFixturesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = _load("messages.json")

    def test_fixture_protocol_version(self):
        self.assertEqual(self.fixtures["schema_version"], 1)
        self.assertEqual(self.fixtures["protocol"], "openaxis/1.0")

    def test_valid_messages_round_trip_semantically(self):
        for case in self.fixtures["valid_messages"]:
            with self.subTest(case=case["name"]):
                parsed = unpack_msg(case["message"])
                self.assertIsNotNone(parsed)
                self.assertEqual(_semantic(parsed.pack()), _semantic(case["message"]))

    def test_invalid_messages_are_rejected(self):
        for case in self.fixtures["invalid_messages"]:
            with self.subTest(case=case["name"]), self.assertRaises((TypeError, ValueError)):
                unpack_msg(case["message"])

    def test_outgoing_integer_boundaries(self):
        for case in self.fixtures["valid_messages"]:
            for key, value in case["message"].items():
                if value == 2**53 - 1:
                    with self.subTest(case=case["name"], field=key), self.assertRaises(ValueError):
                        replace(unpack_msg(case["message"]), **{key: 2**53}).pack()

    def test_unknown_messages_have_no_standard_semantics(self):
        for case in self.fixtures["unknown_messages"]:
            with self.subTest(case=case["name"]):
                self.assertIsNone(unpack_msg(case["message"]))


class SharedGeometryFixturesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = _load("geometry.json")
        cls.tolerance = cls.fixtures["tolerance"]

    def test_fixture_schema_version(self):
        self.assertEqual(self.fixtures["schema_version"], 1)

    def assertSemanticClose(self, actual, expected):
        if isinstance(expected, dict):
            self.assertEqual(set(actual), set(expected))
            for key in expected:
                self.assertSemanticClose(actual[key], expected[key])
        elif isinstance(expected, (list, tuple)):
            self.assertEqual(len(actual), len(expected))
            for actual_item, expected_item in zip(actual, expected, strict=True):
                self.assertSemanticClose(actual_item, expected_item)
        elif isinstance(expected, (int, float)) and not isinstance(expected, bool):
            self.assertTrue(
                math.isclose(actual, expected, rel_tol=0.0, abs_tol=self.tolerance),
                f"{actual!r} != {expected!r}",
            )
        else:
            self.assertEqual(actual, expected)

    def test_quaternion_inverse(self):
        for case in self.fixtures["quaternion_inverse"]:
            with self.subTest(case=case["name"]):
                q = Quat(*case["quaternion"])
                product = q * q.inverse()
                self.assertSemanticClose(
                    [product.w, product.x, product.y, product.z],
                    case["expected_product"],
                )

    def test_camera_basis_from_rotvec(self):
        basis_x = Vec3(1.0, 0.0, 0.0)
        basis_y = Vec3(0.0, 1.0, 0.0)
        basis_z = Vec3(0.0, 0.0, 1.0)
        for case in self.fixtures["camera_basis_from_rotvec"]:
            with self.subTest(case=case["name"]):
                q = Quat.from_rotvec(*case["r"])
                right = q.rotate(basis_x)
                if case["handedness"] == "left":
                    right = -right
                up = q.rotate(basis_y)
                backward = q.rotate(basis_z)
                self.assertSemanticClose(
                    {
                        "right": [right.x, right.y, right.z],
                        "up": [up.x, up.y, up.z],
                        "backward": [backward.x, backward.y, backward.z],
                    },
                    case["expected"],
                )

    def test_pose_from_look_at(self):
        for case in self.fixtures["pose_from_look_at"]:
            with self.subTest(case=case["name"]):
                projection = case["projection"]
                pose = pose_from_look_at(
                    Vec3(*case["eye"]),
                    Vec3(*case["target"]),
                    Vec3(*case["up"]),
                    fov=projection.get("fov"),
                    ortho_extent=projection.get("ortho_extent"),
                )
                actual = {"t": pose.t, "r": pose.r}
                if pose.fov is not None:
                    actual["fov"] = pose.fov
                if pose.ortho_extent is not None:
                    actual["ortho_extent"] = pose.ortho_extent
                self.assertSemanticClose(actual, case["expected"])

    def test_look_at_from_pose(self):
        for case in self.fixtures["look_at_from_pose"]:
            with self.subTest(case=case["name"]):
                eye, target, up = look_at_from_pose(
                    CameraPoseValue(**case["pose"]),
                    default_distance=case["default_distance"],
                    pivot=case["pivot"],
                )
                self.assertSemanticClose(
                    {
                        "eye": [eye.x, eye.y, eye.z],
                        "target": [target.x, target.y, target.z],
                        "up": [up.x, up.y, up.z],
                    },
                    case["expected"],
                )


if __name__ == "__main__":
    unittest.main()
