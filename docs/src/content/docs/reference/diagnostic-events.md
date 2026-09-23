---
title: Diagnostic observer events
description: Current Python, C#, TypeScript and C++ observer surfaces and their differences.
---

Observers expose navigation activity to custom logging or diagnostic consumers.
They report events such as query completion, applied poses and corrections.
For the shared collector and presentation model, see
[Diagnostics API](/reference/diagnostics/). The optional
`diagnostics` parameter operates independently of application observers.

These are local SDK callbacks, not wire messages or a cross-language event
schema. All observers are optional; exceptions are isolated. Synchronous Python
and C# observers run on the application scheduler thread, outside session locks.
Python async observers run on the owning asyncio loop. TypeScript callbacks run
on the coordinator's event-loop/scheduler execution path.

## Compatibility within 1.x

SDK minor releases may add event names and optional payload fields. Existing
event names, required fields, meanings and delivery semantics remain stable.
Observers must ignore unfamiliar events and fields. Python callbacks must accept
`**values`, including when they name individual fields explicitly. TypeScript
consumers can use `createNavigationObserver` to register typed handlers with a
fallback for unhandled events; exhaustive switches should include a default.
C++ observers should use a default branch for unknown event strings. C#'s virtual
observer methods default to no-ops; new events use new optional virtual methods
instead of changing existing method signatures.

## Python synchronous session

Attach `observer(event, **values)` to `NavigationSession`.

| Event | Fields |
| --- | --- |
| `gesture_started` | `gesture_id` |
| `gesture_finished`, `cancelled` | `gesture_id`, `reason` |
| `query_started` | `query` |
| `query_context` | `query`, `context` (application binding) |
| `fact` | `query`, `name`, `value`, `error`, `duration_ms` |
| `query_completed` | `query`, `result`, `duration_ms` |
| `query_failed` | `query`, `error`, `duration_ms` |
| `navigation_state` | `state` |
| `camera_write`, `object_write` | `desired`, `realized`, `success`; includes failed writes |
| `camera_applied`, `object_applied` | `desired`, `realized` (possibly `None`) |
| `correction_sent`, `object_correction_sent` | `delta_id`, `difference` |
| `correction_applied`, `object_correction_applied` | `delta_id` |
| `correction_waiting`, `object_correction_waiting` | `delta_id` |
| `output_rejected` | `kind`, `gesture_id`, `reason` |

`output_rejected` is a bounded diagnostic notification, not a complete audit of
every dropped or coalesced output.

## Python asynchronous session

`AsyncNavigationSession` uses the same callback shape and fields for the camera
events above, including navigation state, query identity and finish reasons.
It supports only cameras, so it does not emit object events.

`gesture_finished.reason` identifies `motion_end`, `superseded`,
`connection_changed`, `closed`, or a cancellation reason such as
`context_changed`. `cancelled` reports cancellation; ordinary motion end does
not emit it. Observers should ignore unfamiliar event names and accept unused
keyword fields with `**values` when they do not consume the whole payload.

## C#

Subclass `OpenAxis.Navigation.NavigationObserver`:

| Method | Arguments |
| --- | --- |
| `WriteCompleted` | `object context, string stream, CameraPoseValue desired, CameraPoseValue? actual, bool success` |
| `GestureStarted` | `long gestureId` |
| `GestureFinished` | `long gestureId, string reason` |
| `NavigationStateChanged` | `NavigationState state` |
| `OutputRejected` | `string kind, long gestureId, string reason` |
| `Cancelled` | `long gestureId, string reason` |
| `QueryStarted` | `object context, NavigationQuery query` |
| `FactFailed` | `string name, string error, double durationMs` (followed by unavailable `Fact`) |
| `Fact` | `string name, object? value, double durationMs` |
| `QueryCompleted` | `NavigationQuery query, Dictionary<string, object> result, double durationMs` |
| `QueryFailed` | `NavigationQuery query, string error, double durationMs` |
| `Correction` | `object context, string kind, long deltaId, PoseDifference? difference` |
| `ObjectCorrection` | Same arguments, for the object stream |

Camera correction kinds are `delta`, `rebase`, `waiting`, and `applied`; rigid
object corrections use `delta`, `waiting`, and `applied`. Difference is
absent for waiting/applied notifications. A query-start context comes from the
adapter capture used for that query; it is not a universal document descriptor.

`WriteCompleted` supplies requested/realized evidence for both streams, including
failed writes. `OutputRejected` reports inactive or stale camera/object output;
`Cancelled` reports the cancellation reason. `NavigationStateChanged` reports
accepted navigation feedback on the application scheduler thread.

## TypeScript

Both session variants accept typed `onEvent({ event, values })`; `NavigationEvent`
is a discriminated union exported from `@openaxis/sdk`. The legacy
`observer(event, values)` callback remains supported. Fields use camelCase:

| Event | Fields |
| --- | --- |
| `gesture_started` | `gestureId` |
| `gesture_finished` | `gestureId`, `reason` |
| `cancelled` | `gestureId`, `reason` |
| `output_rejected` | `kind`, `gestureId`, `reason` |
| `query_started` | `query` |
| `query_context` | `query`, `context` |
| `fact` | `query`, `name`, `value`, `durationMs`, optional `error` |
| `query_completed` | `query`, `result`, `durationMs` |
| `query_failed` | `query`, `durationMs`, `error` |
| `navigation_state` | `state` |
| `camera_applied`, `object_applied` | `desired`, `realized` (possibly `undefined`) |
| `camera_write`, `object_write` | `context`, `desired`, `realized`, `success`; includes failures |
| `correction_sent`, `object_correction_sent` | `deltaId`, `difference` |
| `correction_applied`, `object_correction_applied` | `deltaId` |
| `correction_waiting`, `object_correction_waiting` | `deltaId` |

Fact failures resolve as unavailable while preserving an error for diagnostics.
Rejected-output events describe inactive/stale arrivals, not every coalesced pose.
The shared collector receives these events automatically when supplied through
`diagnostics`; do not also forward them from `onEvent` or `observer`.

## Interpretation and formatting

An application event means the application reported a successful write; missing
`realized` is still unknown. An applied correction refers to the server's
`applied_delta_id` acknowledgement. A sent correction event occurs around the
decision/send path and is not transport delivery confirmation. No observer
should change application poses or send additional corrections to "complete" these
notifications.

The Python/C#/TypeScript prose formatter vocabulary is separate: for example,
`gesture_started` maps to formatter name `gesture.start`, and a `fact` maps to
`navigation.fact`. Formatter names are not automatically emitted observer
events. See [diagnostics and logging](/guide/diagnostics-logging/) for a
concrete mapping and the unified C# assembly location.

## C++ events

Supply `NavigationOptions::on_event`, a `NavigationObserver` taking
`const NavigationEvent&`. Its `event` names follow the Python/TypeScript vocabulary;
`values` is a detached `Value` map with snake_case fields:

| Event | Fields |
| --- | --- |
| `gesture_started` | `gesture_id` |
| `gesture_finished`, `cancelled` | `gesture_id`, `reason` |
| `output_rejected` | `kind`, `gesture_id`, `reason` |
| `query_started` | `request_id`, query parameters including optional `gesture_id`, `values`, `first` |
| `query_context` | `request_id`, `context` |
| `fact` | `request_id`, `name`, `value` or `error`, `duration_ms` |
| `query_completed` | `request_id`, `result`, `duration_ms`, optional `selected` |
| `query_failed` | `request_id`, `error` |
| `camera_write`, `object_write` | `context`, `desired`, `realized`, `success` |
| `camera_applied`, `object_applied` | Same evidence as the successful write |
| `correction_sent`, `object_correction_sent` | `delta_id`, `difference`, `stream`, `state` |
| `correction_waiting`, `object_correction_waiting`, `correction_applied`, `object_correction_applied` | `delta_id`, `stream`, `state` |
| `navigation_state` | `state` |

Query evidence contains copied request data rather than a live query object;
observers cannot complete a query through these snapshots. The collector and
observer run independently, and observer exceptions do not affect navigation.

For `query_context`, write and applied events, `NavigationEvent::context` retains
the native `NavigationContext` (`std::any`). Use `std::any_cast` with the adapter's
context type. The `values["context"]` field is only a printable string when the
context itself is a string; opaque native values are not serialized into logs.

The legacy `NavigationSession::diagnostics` callback takes `const Diagnostic&`.
The value contains `event`, `target`, `detail` and optional `gesture`. Current
event names are `connection`, `start`, `end`, `cancel`, `query`, `write`, `delta`,
`acknowledged` and `error`. `target` identifies camera/object when relevant;
`detail` is diagnostic text, not a stable structured presentation schema.

Callbacks run synchronously on the application thread and exceptions are isolated.
Do not reenter the session. For structured evidence, pass `NavigationDiagnostics`
to the session; do not reconstruct its presentation from these legacy strings.
Transport errors use the separate
`OpenAxisClient::on_error(const std::string&)` callback.
