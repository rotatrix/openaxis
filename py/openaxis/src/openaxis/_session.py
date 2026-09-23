"""Private Navigation session prototype. No transport or host calls.

The future session coordinator serializes access to this state, including write
authorization. Adapters will not call these methods directly. Inputs are already
validated protocol values; observations are detached camera or rigid object poses.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable

from .geometry import Quat
from .types import CameraPose, ObjectPose, MAX_INTEGER


@dataclass(frozen=True)
class Token:
    epoch: int
    generation: int


@dataclass(frozen=True)
class Difference:
    t: tuple[float, float, float]
    r: tuple[float, float, float]
    scale: float | None
    changed: bool
    discontinuity: bool


def compare(first: CameraPose, second: CameraPose, *, absolute=1e-7,
            relative=1e-9, angular=1e-7, projection=1e-7) -> Difference:
    """Default physical comparison; host equivalence can replace this function."""
    t = tuple(b - a for a, b in zip(first.t, second.t, strict=True))
    rotation = Quat.from_rotvec(*second.r) * Quat.from_rotvec(*first.r).inverse()
    r = rotation.normalize().to_rotvec()
    discontinuity = (first.fov is None) != (second.fov is None)
    if first.fov is not None and second.fov is not None:
        discontinuity |= abs(first.fov - second.fov) > projection
    scale = None
    if first.ortho_extent is not None and second.ortho_extent is not None:
        ratio = second.ortho_extent / first.ortho_extent
        if abs(ratio - 1) > projection:
            scale = ratio
    epsilon = max(absolute, relative * max(1, math.hypot(*first.t), math.hypot(*second.t)))
    changed = math.hypot(*t) > epsilon or math.hypot(*r) > angular or scale is not None
    return Difference(t, r, scale, changed, discontinuity)


def compare_object(first: ObjectPose, second: ObjectPose, *, absolute=1e-7,
                   relative=1e-9, angular=1e-7) -> Difference:
    """Compare rigid object poses; applications may supply their own tolerance."""
    return compare(CameraPose(t=first.t, r=first.r, ortho_extent=1),
                   CameraPose(t=second.t, r=second.r, ortho_extent=1),
                   absolute=absolute, relative=relative, angular=angular)


Pose = CameraPose | ObjectPose


@dataclass(frozen=True)
class AcceptedPose:
    token: Token
    pose: Pose


@dataclass(frozen=True)
class Write:
    accepted: AcceptedPose


@dataclass(frozen=True)
class Effect:
    kind: str
    token: Token | None = None
    gesture_id: int | None = None
    delta_id: int | None = None
    difference: Difference | None = None
    write: Write | None = None
    reason: str | None = None
    pose: Pose | None = None


class SessionState:
    """Single-owner state. Effects are instructions for the SDK coordinator."""

    def __init__(self, *, comparison: Callable = compare, timeout: float = 1.0, stream: str = "camera"):
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be positive and finite")
        self.stream = stream
        self._compare = comparison
        self._timeout = timeout
        self.epoch = 0
        self.generation = 0
        self.gesture_id: int | None = None
        self.last_received = -1
        self.last_applied = -1
        self._last_consumed = -1
        self.next_delta_id = 0
        self.baseline: Pose | None = None
        self._expected: Pose | None = None
        self.pending_id: int | None = None
        self.deadline: float | None = None
        self.ready = False
        self.ending = False
        self._write: Write | None = None

    @property
    def token(self) -> Token:
        return Token(self.epoch, self.generation)

    def current(self, token: Token) -> bool:
        return token == self.token and self.gesture_id is not None

    def _retire(self) -> None:
        self.generation += 1
        self.gesture_id = None
        self.ready = False
        self.ending = False
        self.baseline = None
        self._expected = None
        self.pending_id = None
        self.deadline = None
        # An authorized host write cannot be unsent. Retain it until completion.

    def connection(self) -> None:
        self._retire()
        self.epoch += 1
        self.last_received = self.last_applied = -1
        self._last_consumed = -1
        self.next_delta_id = 0

    def start(self, gesture_id: int) -> Token:
        self._retire()
        self.gesture_id = gesture_id
        return self.token

    def end(self, token: Token) -> bool:
        if not self.current(token):
            return False
        self.ending = True
        return True

    def finish(self, token: Token) -> bool:
        if not self.current(token):
            return False
        self._retire()
        return True

    def camera_query(self, token: Token, observation: Pose | None,
                     *, scoped: bool = True, supplied: bool = True, allow_ending: bool = False) -> bool:
        if (not scoped or not supplied or not self.current(token) or (self.ending and not allow_ending)
                or self._write is not None):
            return False
        if not self.ready:
            self.ready = True
            self.baseline = observation
        return True

    def receive(self, epoch: int, pose: Pose) -> AcceptedPose | None:
        if (epoch != self.epoch or self.gesture_id is None or self.ending
                or pose.gesture_id != self.gesture_id
                or pose.seq is None or pose.seq <= self.last_received):
            return None
        self.last_received = pose.seq
        return AcceptedPose(self.token, pose)

    def cancel(self, token: Token, reason: str) -> Effect:
        if not self.current(token):
            return Effect("reject")
        gesture_id = self.gesture_id
        self._retire()
        return Effect("cancel", token, gesture_id, reason=reason)

    def send_failed(self, token: Token, delta_id: int) -> Effect:
        if not self.current(token) or delta_id != self.pending_id:
            return Effect("reject")
        return self.cancel(token, f"{self.stream}_delta_send_failed")

    def expire(self, token: Token, delta_id: int, now: float) -> Effect:
        if (not self.current(token) or delta_id != self.pending_id
                or self.deadline is None or now < self.deadline):
            return Effect("reject")
        return self.cancel(token, f"{self.stream}_delta_timeout")

    def _delta(self, actual: Pose, difference: Difference, now: float) -> Effect:
        if self.next_delta_id > MAX_INTEGER:
            return self.cancel(self.token, f"{self.stream}_delta_id_exhausted")
        delta_id = self.next_delta_id
        self.next_delta_id += 1
        self.pending_id = delta_id
        self.deadline = now + self._timeout
        self.baseline = actual
        self._expected = None
        return Effect("delta", self.token, self.gesture_id, delta_id, difference)

    def _rebase(self, actual: Pose, now: float) -> Effect:
        if self.ending:
            return Effect("hold")
        # Supersede any pending correction. The coordinator sends the absolute
        # state followed by this identified identity delta on the same socket.
        barrier = self._delta(actual, Difference((0, 0, 0), (0, 0, 0), None, False, False), now)
        if barrier.kind == "cancel":
            return barrier
        return Effect("rebase", self.token, self.gesture_id, barrier.delta_id,
                      barrier.difference, pose=actual)

    def observe(self, token: Token, actual: Pose | None, now: float) -> Effect:
        if not self.current(token) or not self.ready:
            return Effect("reject")
        if self._write is not None:
            return Effect("hold")
        if actual is None:
            return Effect("skip")  # Retry next frame; baseline is still usable.
        reference = self.baseline if self.baseline is not None else self._expected
        if reference is None:
            self.baseline = actual
            return Effect("skip")
        difference = self._compare(reference, actual)
        if difference.discontinuity:
            return self._rebase(actual, now)
        if not difference.changed:
            if self.baseline is None:
                self.baseline = actual
                self._expected = None
            return Effect("skip")
        if self.pending_id is not None or self.ending:
            return Effect("hold")
        return self._delta(actual, difference, now)

    def process(self, accepted: AcceptedPose, actual: Pose | None,
                now: float) -> Effect:
        pose = accepted.pose
        if (not self.current(accepted.token) or not self.ready
                or pose.seq != self.last_received or pose.seq <= self._last_consumed):
            return Effect("reject")
        if self._write is not None:
            return Effect("hold")
        acknowledged = (self.pending_id is not None and pose.applied_delta_id is not None
                        and pose.applied_delta_id >= self.pending_id)
        if acknowledged:
            self.pending_id = None
            self.deadline = None
        observation = self.observe(accepted.token, actual, now)
        if observation.kind != "skip":
            return observation
        if self.pending_id is not None:
            return Effect("hold")
        # Reconcile native motion and pending acknowledgements before testing
        # equivalence. A fresh observation also permits ordinary idle frames to
        # be consumed without an expensive host camera commit.
        # Suppress a repeat of the last known result even if this read failed.
        # The unobserved command reference is never used as a realized pose.
        realized = actual if actual is not None else self.baseline
        if realized is not None:
            difference = self._compare(realized, pose)
            if not difference.changed and not difference.discontinuity:
                self._last_consumed = pose.seq
                return Effect("skip")
        self._write = Write(accepted)
        return Effect("apply", self.token, self.gesture_id, write=self._write)

    def complete_write(self, write: Write, actual: Pose | None,
                       now: float, *, success: bool = True) -> Effect:
        if write is not self._write:
            return Effect("reject")
        self._write = None
        if not self.current(write.accepted.token):
            return Effect("reject")
        if not success:
            return self.cancel(write.accepted.token, f"{self.stream}_write_failed")
        self.last_applied = write.accepted.pose.seq
        self._last_consumed = write.accepted.pose.seq
        self.baseline = actual  # An unobserved SDK write invalidates old baseline.
        # A command reference is not a host observation. Retain it separately
        # so delayed readback can recover its residual before another write.
        self._expected = write.accepted.pose if actual is None else None
        if actual is not None and not self.ending:
            difference = self._compare(write.accepted.pose, actual)
            if difference.discontinuity:
                return self._rebase(actual, now)
            if difference.changed:
                return self._delta(actual, difference, now)
        return Effect("skip")
