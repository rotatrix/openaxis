"""Shared event traces for the private Navigation session prototype."""
import json
from pathlib import Path

import pytest

from openaxis._session import SessionState
from openaxis.types import CameraPose


FIXTURE = Path(__file__).resolve().parents[3] / "fixtures/openaxis-1.0/session.json"
SCENARIOS = json.loads(FIXTURE.read_text(encoding="utf-8"))["scenarios"]


def pose(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        value = {"x": value}
    return CameraPose(t=tuple(value.get("t", [value.get("x", 0), 0, 0])),
                      r=tuple(value.get("r", [0, 0, 0])),
                      fov=None if "extent" in value else value.get("fov", 1),
                      ortho_extent=value.get("extent"))


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda case: case["name"])
def test_shared_session_trace(scenario):
    state = SessionState()
    tokens, tickets, writes = {}, {}, {}
    for index, event in enumerate(scenario["events"]):
        op = event["op"]
        token = tokens[event["token"]] if "token" in event else state.token
        actual = pose(event.get("actual"))
        now = event.get("now", 0)
        effect = None
        kind = "ok"
        if op == "connection":
            state.connection()
        elif op == "start":
            tokens[event.get("as", "last")] = state.start(event["gesture"])
        elif op == "query":
            ok = state.camera_query(token, actual, scoped=event.get("scoped", True),
                                    supplied=event.get("supplied", True))
            kind = "ok" if ok else "reject"
        elif op == "receive":
            value = pose(event["pose"])
            value = CameraPose(**{**value.__dict__, "gesture_id": event.get("gesture", state.gesture_id),
                                  "seq": event["seq"], "applied_delta_id": event.get("ack")})
            ticket = state.receive(event.get("epoch", state.epoch), value)
            kind = "accepted" if ticket is not None else "reject"
            if ticket is not None:
                tickets[event.get("as", "last")] = ticket
        elif op == "process":
            effect = state.process(tickets[event.get("ticket", "last")], actual, now)
        elif op == "observe":
            effect = state.observe(token, actual, now)
        elif op == "complete":
            effect = state.complete_write(writes[event.get("write", "last")], actual, now,
                                          success=event.get("success", True))
        elif op == "end":
            kind = "ok" if state.end(token) else "reject"
        elif op == "finish":
            kind = "ok" if state.finish(token) else "reject"
        elif op == "cancel":
            effect = state.cancel(token, event["reason"])
        elif op == "timeout":
            effect = state.expire(token, event["delta"], now)
        elif op == "send_failed":
            effect = state.send_failed(token, event["delta"])
        else:
            raise AssertionError(f"Unknown trace operation: {op}")

        result = dict(kind=effect.kind if effect else kind,
                      baseline=state.baseline.t[0] if state.baseline else None,
                      ready=state.ready, pending=state.pending_id, active=state.gesture_id,
                      received=state.last_received, applied=state.last_applied)
        if effect:
            result.update(delta_id=effect.delta_id, gesture_id=effect.gesture_id, reason=effect.reason)
            if effect.difference:
                result.update(t=list(effect.difference.t), r=list(effect.difference.r), scale=effect.difference.scale)
            if effect.write:
                writes[event.get("as", "last")] = effect.write
        for key, expected in event["expect"].items():
            observed = result[key]
            label = f"event {index}: {op}, field {key}"
            if isinstance(expected, (float, list)):
                assert observed == pytest.approx(expected, abs=1e-8), label
            else:
                assert observed == expected, label


def test_private_session_not_exported_at_package_root():
    import openaxis
    assert not hasattr(openaxis, "SessionState")
