"""Helpers for answering OpenAxis Navigation queries."""

from __future__ import annotations

import threading
from collections.abc import Awaitable, Callable

from .types import Request, _integer

__all__ = [
    "UNAVAILABLE",
    "NavigationQuery",
]


class _Unavailable:
    def __repr__(self) -> str:
        return "UNAVAILABLE"


UNAVAILABLE = _Unavailable()
"""Sentinel returned by a fact resolver when a value is unavailable."""

FactResolver = Callable[[str], object]
AsyncFactResolver = Callable[[str], Awaitable[object]]
CompleteCallback = Callable[[dict], None]
FailCallback = Callable[[str, str | None], None]


def _wire_fact_value(name: str, value: object) -> object:
    """Remove local pick marker metadata before availability checks and encoding."""
    if name in {"pick.cursor", "pick.viewport_center", "pick.cursor.selection", "pick.viewport_center.selection"} and isinstance(value, dict):
        return {k: v for k, v in value.items() if k != "markerPosition"} if value.get("point") is not None else UNAVAILABLE
    return value


class NavigationQuery:
    """A parsed ``navigation.query`` request.

    Applications should move the whole query to their application thread once,
    then call :meth:`evaluate` there. Fact resolution is synchronous so all
    requested application state and ordered candidates are collected within
    that single dispatch.
    """

    __slots__ = (
        "request_id",
        "gesture_id",
        "values",
        "first",
        "_has_gesture_id",
        "_has_first",
        "_complete_callback",
        "_fail_callback",
        "_completion_lock",
        "_completed",
    )

    def __init__(
        self,
        *,
        request_id: int,
        gesture_id: int | None,
        values: tuple[str, ...],
        first: tuple[str, ...],
        has_gesture_id: bool,
        has_first: bool,
        complete_callback: CompleteCallback | None = None,
        fail_callback: FailCallback | None = None,
    ) -> None:
        self.request_id = request_id
        self.gesture_id = gesture_id
        self.values = values
        self.first = first
        self._has_gesture_id = has_gesture_id
        self._has_first = has_first
        self._complete_callback = complete_callback
        self._fail_callback = fail_callback
        self._completion_lock = threading.Lock()
        self._completed = False

    @classmethod
    def from_request(
        cls,
        request: Request,
        *,
        complete_callback: CompleteCallback | None = None,
        fail_callback: FailCallback | None = None,
    ) -> NavigationQuery:
        """Parse and validate a ``navigation.query`` request."""
        if request.method != "navigation.query":
            raise ValueError("request method must be navigation.query")

        params = request.params
        has_gesture_id = "gesture_id" in params
        gesture_id = params.get("gesture_id")
        if has_gesture_id:
            _integer(gesture_id, "navigation.query.gesture_id")

        values = cls._names(params.get("values", ()), "values")
        has_first = "first" in params
        first = cls._names(params.get("first", ()), "first")
        return cls(
            request_id=request.id,
            gesture_id=gesture_id,
            values=values,
            first=first,
            has_gesture_id=has_gesture_id,
            has_first=has_first,
            complete_callback=complete_callback,
            fail_callback=fail_callback,
        )

    @staticmethod
    def _names(value: object, field_name: str) -> tuple[str, ...]:
        if not isinstance(value, (list, tuple)):
            raise ValueError(f"navigation.query.{field_name} must be an array")
        if not all(isinstance(name, str) and name for name in value):
            raise ValueError(f"navigation.query.{field_name} must contain non-empty strings")
        return tuple(value)

    @property
    def scoped(self) -> bool:
        """Whether the server bound this query to a motion gesture."""
        return self._has_gesture_id

    @property
    def completed(self) -> bool:
        """Whether this query has been completed, failed, or retired."""
        with self._completion_lock:
            return self._completed

    def evaluate(self, resolve_fact: FactResolver) -> dict:
        """Evaluate this query synchronously with request-local memoization."""
        cache: dict[str, object] = {}

        def resolve(name: str) -> object:
            if name not in cache:
                cache[name] = _wire_fact_value(name, resolve_fact(name))
            return cache[name]

        values: dict[str, object] = {}
        for name in self.values:
            value = resolve(name)
            if value is not None and value is not UNAVAILABLE:
                values[name] = value

        result: dict = {"values": values}
        if self._has_first:
            selected = None
            for name in self.first:
                value = resolve(name)
                if value is not None and value is not UNAVAILABLE:
                    selected = {"name": name, "value": value}
                    break
            result["first"] = selected
        return result

    async def evaluate_async(self, resolve_fact: AsyncFactResolver) -> dict:
        """Evaluate this query asynchronously with request-local memoization.

        Facts in ``values`` are awaited in request order. Candidates in
        ``first`` are then awaited in order and stop at the first available
        value. This deliberately preserves the synchronous evaluator's
        ordering and short-circuit behavior for integrations whose application
        state is exposed through an asynchronous API.
        """
        cache: dict[str, object] = {}

        async def resolve(name: str) -> object:
            if name not in cache:
                cache[name] = _wire_fact_value(name, await resolve_fact(name))
            return cache[name]

        values: dict[str, object] = {}
        for name in self.values:
            value = await resolve(name)
            if value is not None and value is not UNAVAILABLE:
                values[name] = value

        result: dict = {"values": values}
        if self._has_first:
            selected = None
            for name in self.first:
                value = await resolve(name)
                if value is not None and value is not UNAVAILABLE:
                    selected = {"name": name, "value": value}
                    break
            result["first"] = selected
        return result

    def complete(self, result: dict) -> None:
        """Complete the correlated request from any thread."""
        if not isinstance(result, dict):
            raise TypeError("navigation.query result must be a map")
        callback = self._complete_callback
        if callback is None:
            raise RuntimeError("NavigationQuery is not bound to an OpenAxis client")
        self._claim_completion()
        callback(result)

    def fail(self, code: str, message: str | None = None) -> None:
        """Fail the correlated request from any thread."""
        if not isinstance(code, str) or not code.strip():
            raise ValueError("navigation.query error code must be a non-empty string")
        if message is not None and not isinstance(message, str):
            raise ValueError("navigation.query error message must be a string")
        callback = self._fail_callback
        if callback is None:
            raise RuntimeError("NavigationQuery is not bound to an OpenAxis client")
        self._claim_completion()
        callback(code, message)

    def _claim_completion(self) -> None:
        with self._completion_lock:
            if self._completed:
                raise RuntimeError("NavigationQuery has already been completed")
            self._completed = True
