"""Lightweight geometry primitives for OpenAxis clients.

Pure Python, zero dependencies. Provides Vec3 and Quat, plus helpers for
converting between eye/target/up camera representations and the OpenAxis
wire format (position + rotation vector).

The semantic camera frame is right-handed: +Z is backward (away from the
target), +Y is up, and +X is right. In a left-handed client world the wire
rotation stores the proper factor of that frame; ``world.orientation`` carries
the reflection separately. The eye/target/up helpers produce that factor using
ordinary numeric cross products and therefore do not need a handedness input.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

__all__ = [
    "CameraPoseValue",
    "Vec3",
    "Quat",
    "pose_from_look_at",
    "look_at_from_pose",
]


@dataclass(frozen=True, slots=True)
class CameraPoseValue:
    """Protocol-neutral camera geometry in the caller's world coordinates.

    ``t`` is position and ``r`` is a rotation vector in radians. Projection
    may be omitted for geometry-only work, but cannot specify both kinds.
    Convert explicitly to a protocol CameraPose at the integration boundary.
    """

    t: tuple[float, float, float]
    r: tuple[float, float, float]
    fov: float | None = None
    ortho_extent: float | None = None

    def __post_init__(self) -> None:
        for name in ("t", "r"):
            value = tuple(getattr(self, name))
            if len(value) != 3 or not all(math.isfinite(component) for component in value):
                raise ValueError(f"{name} must contain three finite components")
            object.__setattr__(self, name, value)
        if self.fov is not None and self.ortho_extent is not None:
            raise ValueError("A camera pose cannot contain both projections")
        for name in ("fov", "ortho_extent"):
            value = getattr(self, name)
            if value is not None and (not math.isfinite(value) or value <= 0):
                raise ValueError(f"{name} must be positive and finite")


@dataclass(slots=True)
class Vec3:
    x: float
    y: float
    z: float

    def __add__(self, o: Vec3) -> Vec3:
        return Vec3(self.x + o.x, self.y + o.y, self.z + o.z)

    def __sub__(self, o: Vec3) -> Vec3:
        return Vec3(self.x - o.x, self.y - o.y, self.z - o.z)

    def __mul__(self, s: float) -> Vec3:
        return Vec3(self.x * s, self.y * s, self.z * s)

    def __rmul__(self, s: float) -> Vec3:
        return self.__mul__(s)

    def __neg__(self) -> Vec3:
        return Vec3(-self.x, -self.y, -self.z)

    def dot(self, o: Vec3) -> float:
        return self.x * o.x + self.y * o.y + self.z * o.z

    def cross(self, o: Vec3) -> Vec3:
        return Vec3(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )

    def length(self) -> float:
        return math.sqrt(self.dot(self))

    def normalized(self) -> Vec3:
        n = self.length()
        return Vec3(self.x / n, self.y / n, self.z / n) if n > 1e-12 else Vec3(0, 0, 0)


@dataclass(slots=True)
class Quat:
    """Unit quaternion (w, x, y, z) representing a rotation."""

    w: float
    x: float
    y: float
    z: float

    def __mul__(self, o: Quat) -> Quat:
        """Hamilton product."""
        return Quat(
            self.w * o.w - self.x * o.x - self.y * o.y - self.z * o.z,
            self.w * o.x + self.x * o.w + self.y * o.z - self.z * o.y,
            self.w * o.y - self.x * o.z + self.y * o.w + self.z * o.x,
            self.w * o.z + self.x * o.y - self.y * o.x + self.z * o.w,
        )

    def normalize(self) -> Quat:
        n = math.sqrt(self.w**2 + self.x**2 + self.y**2 + self.z**2)
        if n < 1e-12:
            return Quat(1, 0, 0, 0)
        return Quat(self.w / n, self.x / n, self.y / n, self.z / n)

    def inverse(self) -> Quat:
        """Return the inverse of a unit quaternion."""
        q = self.normalize()
        return Quat(q.w, -q.x, -q.y, -q.z)

    def rotate(self, v: Vec3) -> Vec3:
        """Sandwich product q v q*."""
        # Optimized: t = 2 * (q_xyz × v), result = v + w*t + q_xyz × t
        qv = Vec3(self.x, self.y, self.z)
        t = 2.0 * qv.cross(v)
        return v + self.w * t + qv.cross(t)

    @staticmethod
    def from_rotvec(wx: float, wy: float, wz: float) -> Quat:
        """SO(3) exponential map: rotation vector → unit quaternion."""
        theta = math.sqrt(wx * wx + wy * wy + wz * wz)
        if theta < 1e-10:
            # First-order Taylor: sin(θ/2)/θ ≈ 0.5
            return Quat(1.0, wx * 0.5, wy * 0.5, wz * 0.5).normalize()
        half = theta * 0.5
        s = math.sin(half) / theta
        return Quat(math.cos(half), wx * s, wy * s, wz * s)

    @staticmethod
    def from_axes(right: Vec3, up: Vec3, backward: Vec3) -> Quat:
        """Rotation matrix columns → quaternion (Shepperd's method).

        The matrix is [right | up | backward] where each is a column,
        i.e. R = [[rx, ux, bx], [ry, uy, by], [rz, uz, bz]].
        """
        # Trace = m00 + m11 + m22
        m00, m11, m22 = right.x, up.y, backward.z
        m01, m02 = up.x, backward.x
        m10, m12 = right.y, backward.y
        m20, m21 = right.z, up.z
        tr = m00 + m11 + m22
        if tr > 0:
            s = 0.5 / math.sqrt(tr + 1.0)
            return Quat(0.25 / s, (m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s)
        elif m00 > m11 and m00 > m22:
            s = 2.0 * math.sqrt(1.0 + m00 - m11 - m22)
            return Quat((m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s)
        elif m11 > m22:
            s = 2.0 * math.sqrt(1.0 + m11 - m00 - m22)
            return Quat((m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s)
        else:
            s = 2.0 * math.sqrt(1.0 + m22 - m00 - m11)
            return Quat((m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s)

    def to_rotvec(self) -> tuple[float, float, float]:
        """SO(3) logarithmic map: unit quaternion → rotation vector."""
        # Ensure positive hemisphere for unique rotation vector
        q = self if self.w >= 0 else Quat(-self.w, -self.x, -self.y, -self.z)
        v_len = math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z)
        if v_len < 1e-10:
            return (0.0, 0.0, 0.0)
        angle = 2.0 * math.atan2(v_len, q.w)
        s = angle / v_len
        return (q.x * s, q.y * s, q.z * s)

    def slerp(self, other: Quat, t: float) -> Quat:
        """Spherical linear interpolation."""
        dot = self.w * other.w + self.x * other.x + self.y * other.y + self.z * other.z
        # Shortest path
        if dot < 0:
            other = Quat(-other.w, -other.x, -other.y, -other.z)
            dot = -dot
        if dot > 0.9995:
            # Near-identical: lerp + normalize
            return Quat(
                self.w + t * (other.w - self.w),
                self.x + t * (other.x - self.x),
                self.y + t * (other.y - self.y),
                self.z + t * (other.z - self.z),
            ).normalize()
        theta = math.acos(min(dot, 1.0))
        sin_theta = math.sin(theta)
        a = math.sin((1.0 - t) * theta) / sin_theta
        b = math.sin(t * theta) / sin_theta
        return Quat(
            a * self.w + b * other.w,
            a * self.x + b * other.x,
            a * self.y + b * other.y,
            a * self.z + b * other.z,
        )

    @staticmethod
    def identity() -> Quat:
        return Quat(1, 0, 0, 0)


# ---------------------------------------------------------------------------
# Pose conversion helpers for the OpenAxis wire format
# ---------------------------------------------------------------------------
# These bridge between app-native camera representations (eye/target/up)
# and the OpenAxis wire representation (position + rotation vector).


def pose_from_look_at(
    eye: Vec3,
    target: Vec3,
    up: Vec3,
    *,
    fov: float | None = None,
    ortho_extent: float | None = None,
) -> CameraPoseValue:
    """Convert eye/target/up camera to a protocol-neutral ``CameraPoseValue``.

    Returns a ``CameraPoseValue`` with:
      - ``t`` = eye position
      - ``r`` = rotation vector (SO(3) log map of the camera orientation)
    OpenAxis's semantic camera convention is +Z backward (away from target),
    +Y up, and +X right. The returned rotation is the proper factor described
    by the protocol and works in either client handedness when paired with the
    corresponding ``world.orientation``.
    """
    if not all(math.isfinite(component) for vector in (eye, target, up)
               for component in (vector.x, vector.y, vector.z)):
        raise ValueError("Eye, target and up must be finite")
    backward = (eye - target).normalized()
    distance = (eye - target).length()
    if distance < 1e-12:
        return CameraPoseValue(
            t=(eye.x, eye.y, eye.z),
            r=(0.0, 0.0, 0.0),
            fov=fov,
            ortho_extent=ortho_extent,
        )

    right = up.cross(backward).normalized()
    if right.length() < 1e-6:
        fallback = Vec3(1, 0, 0) if abs(up.y) > 0.9 else Vec3(0, 1, 0)
        right = fallback.cross(backward).normalized()
    up_ortho = backward.cross(right).normalized()

    q = Quat.from_axes(right, up_ortho, backward).normalize()
    rv = q.to_rotvec()

    return CameraPoseValue(
        t=(eye.x, eye.y, eye.z),
        r=rv,
        fov=fov,
        ortho_extent=ortho_extent,
    )


def look_at_from_pose(
    pose: CameraPoseValue,
    default_distance: float = 10.0,
    pivot: tuple[float, float, float] | None = None,
) -> tuple[Vec3, Vec3, Vec3]:
    """Convert a ``CameraPoseValue`` to eye/target/up vectors.

    If *pivot* is given, computes target distance along the backward axis
    from ``(eye - pivot) . backward``. Otherwise falls back to
    *default_distance* along the backward axis.

    Returns ``(eye, target, up)`` as ``Vec3`` triples.
    """
    q = Quat.from_rotvec(*pose.r)
    eye = Vec3(pose.t[0], pose.t[1], pose.t[2])
    up = q.rotate(Vec3(0, 1, 0))
    backward = q.rotate(Vec3(0, 0, 1))

    if pivot is not None:
        pivot_vec = Vec3(pivot[0], pivot[1], pivot[2])
        depth = (eye - pivot_vec).dot(backward)
        distance = max(depth, 0.01)
    else:
        distance = default_distance

    target = eye - backward * distance
    return eye, target, up
