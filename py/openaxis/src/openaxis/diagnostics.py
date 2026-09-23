"""Small, dependency-free helpers for human-readable OpenAxis diagnostics."""

from __future__ import annotations

import datetime
import math

__all__ = ["format_event", "format_log_line"]

_PIVOT_LABELS = {
    "locked": "locked pivot",
    "selection.viewport-clipped-center": "selection center",
    "last-used": "last pivot",
    "model.viewport-clipped-center": "model center",
    "model.bounds": "model bounds",
    "world.origin": "origin",
    "query": "queried pick",
}


def _words(value: object) -> str:
    return str(value).replace("_", " ").replace("-", " ")


def _number(value: object) -> str:
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, (int, float)):
        number = float(value)
        return f"{number:.3f}" if math.isfinite(number) else str(number)
    return str(value)


def _point(value: object) -> str | None:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        return None
    if not all(isinstance(component, (int, float)) for component in value):
        return None
    return "(" + ", ".join(_number(component) for component in value) + ")"


def _bounds(value: object) -> str | None:
    if not isinstance(value, dict):
        return None
    minimum = _point(value.get("min"))
    maximum = _point(value.get("max"))
    return f"{minimum} … {maximum}" if minimum and maximum else None


def _value(value: object) -> str:
    point = _point(value)
    if point:
        return point
    bounds = _bounds(value)
    if bounds:
        return bounds
    if value is None:
        return "missing"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, (int, float)):
        return _number(value)
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        return ", ".join(_value(item) for item in value)
    if isinstance(value, dict):
        return "; ".join(
            f"{_words(key)}: {_value(item)}"
            for key, item in value.items()
            if item is not None
        )
    return str(value)


def _label(value: object) -> str:
    return str(value)


def _pivot_label(value: object) -> str:
    source = str(value)
    if source.startswith("query:"):
        return _label(source.removeprefix("query:"))
    if source.startswith("viewport.center:"):
        depth = source.removeprefix("viewport.center:").removesuffix("-depth")
        return f"viewport center ({_words(depth)} depth)"
    return _PIVOT_LABELS.get(source, _words(source.replace(".", " ")))


def _duration(fields: dict[str, object]) -> str:
    value = fields.get("duration_ms")
    return f" · {_number(value)} ms" if value is not None else ""


def _context(
    fields: dict[str, object],
    *,
    client: bool = True,
    gesture: bool = True,
    request: bool = True,
) -> str:
    parts: list[str] = []
    if client and fields.get("client") is not None:
        parts.append(str(fields["client"]))
    if gesture and fields.get("gesture") is not None:
        parts.append(f"gesture {fields['gesture']}")
    if request and fields.get("request") is not None:
        parts.append(f"request {fields['request']}")
    return f" · {', '.join(parts)}" if parts else ""


def _fact_result(fields: dict[str, object]) -> str:
    result = fields.get("result")
    value = fields.get("value")
    fact = str(fields.get("fact", ""))
    if result == "error":
        return f"error: {fields.get('error', 'unknown failure')}"
    if result != "ok":
        return "miss" if fact.startswith("pick.") else "missing"
    if isinstance(value, dict) and _point(value.get("point")):
        bounds = _bounds(value.get("bounds"))
        return f"hit at {_point(value['point'])}" + (f" | bounds {bounds}" if bounds else "")
    return f"found {_value(value)}" if value is not None else "found"


def _format_fact(fields: dict[str, object]) -> str:
    # Facts from one query are contiguous in client logs, so repeating request and
    # gesture identifiers on every line obscures the result more than it helps.
    return (
        f"  {_label(fields.get('fact', 'fact'))} — {_fact_result(fields)}"
        f"{_duration(fields)}"
    )


def _format_query_complete(fields: dict[str, object]) -> str:
    details: list[str] = []
    missing = fields.get("missing")
    if isinstance(missing, (list, tuple)) and missing:
        details.append("missing " + ", ".join(_label(item) for item in missing))
    first = fields.get("first")
    if first is not None:
        details.append(f"first: {_label(first)}")
    result = "query complete"
    if details:
        result += " — " + "; ".join(details)
    return result + _duration(fields) + _context(
        fields, client=False, gesture=False, request=True
    )


def _format_navigation_pivot(fields: dict[str, object]) -> str:
    source = _pivot_label(fields.get("source", "pivot"))
    result = _words(fields.get("result", "considered"))
    reason = fields.get("reason")
    point = _point(fields.get("point"))
    detail = f" — {_words(reason)}" if reason else ""
    if point:
        detail += f" at {point}"
    return f"  {source} — {result}{detail}" + _context(fields)


def _format_pivot_selection_item(fields: dict[str, object]) -> str:
    item = fields.get("item")
    entity_type = fields.get("type") or fields.get("entity_type") or "entity"
    entity_id = fields.get("id")
    result = fields.get("result")
    identity = str(entity_type)
    if entity_id is not None:
        identity += f" #{entity_id}"
    if fields.get("name"):
        identity += f" {fields['name']}"
    text = f"  selection {item}: {identity} — "
    if result == "ok":
        text += "bounds " + (_bounds(fields.get("bounds")) or "found")
    elif result == "missing_bounds":
        text += "missing bounds"
    elif result == "error":
        text += f"error: {fields.get('error', 'unknown failure')}"
    else:
        text += _words(result or "inspected")
    extras: list[str] = []
    if fields.get("occurrence"):
        extras.append(str(fields["occurrence"]))
    if fields.get("source"):
        extras.append(_words(fields["source"]))
    if fields.get("geometry_type"):
        extras.append(f"geometry {_words(fields['geometry_type'])}")
    if fields.get("native_type") or fields.get("native_id") is not None:
        native = str(fields.get("native_type") or entity_type)
        if fields.get("native_id") is not None:
            native += f" #{fields['native_id']}"
        extras.append(f"native {native}")
    if fields.get("reported_bounds") is not None:
        extras.append(
            "reported bounds "
            + (_bounds(fields["reported_bounds"]) or _value(fields["reported_bounds"]))
        )
    if fields.get("native_bounds") is not None:
        extras.append(
            "native bounds "
            + (_bounds(fields["native_bounds"]) or _value(fields["native_bounds"]))
        )
    if fields.get("transform") is not None:
        extras.append(f"transform {_value(fields['transform'])}")
    return text + (f" · {', '.join(extras)}" if extras else "")


def _format_pivot_pick(fields: dict[str, object]) -> str:
    kind = _words(fields.get("kind", "pick"))
    result = fields.get("result")
    if result == "hit":
        outcome = "hit"
    elif result == "outside_selection":
        outcome = "hit outside selection"
    elif result == "miss":
        outcome = "miss"
    elif result == "unavailable":
        outcome = "unavailable"
    else:
        outcome = _words(result or "complete")
    point = _point(fields.get("point"))
    if point:
        outcome += f" at {point}"
    if fields.get("reason"):
        outcome += f" — {_words(fields['reason'])}"
    owner = fields.get("type") or fields.get("entity_type")
    if owner:
        identity = str(owner)
        if fields.get("id") is not None:
            identity += f" #{fields['id']}"
        if fields.get("occurrence"):
            identity += f" in {fields['occurrence']}"
        outcome += f" · {identity}"
    bounds = _bounds(fields.get("bounds"))
    if bounds:
        outcome += f" · bounds {bounds}"
    return f"  {kind} pick — {outcome}"


def format_event(name: str, /, **fields: object) -> str:
    """Render one diagnostic event as concise prose intended for people."""
    if name == "gesture.start":
        return "motion started" + _context(fields, client=False, request=False)
    if name == "gesture.end":
        return "motion ended" + _context(fields, client=False, request=False)
    if name == "gesture.cancel":
        return (
            f"motion canceled — {_words(fields.get('reason', 'unknown reason'))}"
            + _context(fields, client=False, request=False)
        )
    if name == "navigation.fact":
        return _format_fact(fields)
    if name == "navigation.fact.error":
        return (
            f"  {_label(fields.get('fact', 'fact'))} — error: {fields.get('error')}"
            + _context(fields, client=False, gesture=False)
        )
    if name == "navigation.query.complete":
        return _format_query_complete(fields)
    if name == "navigation.query.rejected":
        return (
            f"query rejected — {_words(fields.get('reason', 'unknown reason'))}"
            + _context(fields)
        )
    if name == "navigation.query.error":
        return (
            f"query failed — {fields.get('error', 'unknown failure')}"
            + _duration(fields)
            + _context(fields)
        )
    if name == "navigation.pivot.order":
        candidates = fields.get("candidates") or ()
        order = " → ".join(_pivot_label(item) for item in candidates)
        return f"pivot order: {order}" + _context(fields)
    if name == "navigation.pivot":
        return _format_navigation_pivot(fields)
    if name == "navigation.policy":
        target = _words(fields.get("target", "camera"))
        mode = fields.get("camera_mode")
        policy = f"{_words(mode)} camera" if target == "camera" and mode else target
        return f"navigation: {policy}" + _context(fields, request=False)
    if name == "navigation.object.selected":
        actions = [
            action
            for action, enabled in (
                ("translation", fields.get("translation")),
                ("rotation", fields.get("rotation")),
            )
            if enabled
        ]
        pivot = _point(fields.get("pivot"))
        result = "object control: " + " + ".join(actions or ["disabled"])
        if pivot:
            result += f" around {pivot}"
        return result + _context(fields)
    if name == "interaction.object.detected":
        actions = " + ".join(_words(item) for item in fields.get("actions") or ())
        target = fields.get("target")
        entity_type = fields.get("type")
        result = "object interaction: " + (actions or "detected")
        if target:
            result += f" · {target}"
        if entity_type:
            result += f" ({entity_type})"
        unresolved = fields.get("unresolved")
        if unresolved:
            result += f" — target unavailable: {_value(unresolved)}"
        operations = fields.get("operations")
        if operations:
            result += " · " + _value(operations)
        return result
    if name == "interaction.object.ended":
        return "object interaction ended"
    if name == "camera.external.delta":
        changes = " + ".join(_words(item) for item in fields.get("changes") or ())
        details: list[str] = []
        if fields.get("translation") is not None:
            details.append(f"translation {_point(fields['translation'])}")
        if fields.get("rotation") is not None:
            details.append(f"rotation {_point(fields['rotation'])}")
        if fields.get("ortho_extent_scale") is not None:
            details.append(f"ortho scale {_number(fields['ortho_extent_scale'])}")
        return "external camera change: " + (changes or ", ".join(details) or "observed")
    if name == "object.native_override":
        return "native object motion overridden by Rotatrix" + _context(
            fields, client=False, request=False
        )
    if name == "object.native_override.summary":
        return (
            f"native object motion overridden {fields.get('count', 0)} times"
            + _context(fields, client=False, request=False)
        )
    if name == "pivot.selection":
        result = fields.get("result")
        if result == "empty":
            return "selection — empty"
        if result == "inspect":
            return f"selection — inspecting {fields.get('count', 0)} item(s)"
    if name == "pivot.selection.item":
        return _format_pivot_selection_item(fields)
    if name == "pivot.pick":
        return _format_pivot_pick(fields)
    if name == "connection.start":
        return f"connecting to {fields.get('url')}"
    if name == "connection.open":
        return f"connected to {fields.get('url')} · {fields.get('protocol')}"
    if name == "connection.stop":
        return "connection stopped"
    if name == "connection.lost":
        return "connection lost" + (" — retrying" if fields.get("retry") else "")
    if name == "connection.retry_failed":
        return (
            f"connection failed — {fields.get('error', 'unknown failure')}"
            f" · retrying in {_number(fields.get('retry_delay_s', 0))} s"
        )
    if name == "command.rejected":
        return f"command rejected: {fields.get('name')}"
    if name == "command.error":
        return f"command failed: {fields.get('name')} — {fields.get('error')}"

    # Keep uncommon application-specific events readable without imposing a
    # machine-oriented wire format on the support log.
    details = "; ".join(
        f"{_words(key)}: {_value(value)}"
        for key, value in fields.items()
        if key not in {"client", "gesture", "request", "delta_id", "seq"}
        and value is not None
    )
    result = _words(name.replace(".", " "))
    if details:
        result += " — " + details
    return result + _context(fields)


def format_log_line(
    message: str,
    level: str = "INFO",
    *,
    now: datetime.datetime | None = None,
) -> str:
    """Add a compact local timestamp and show only actionable severities."""
    timestamp = (now or datetime.datetime.now()).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    severity = "" if level.upper() == "INFO" else f"{level.upper()} "
    return f"{timestamp}  {severity}{message}"
