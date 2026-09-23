---
title: Migrating from 0.2 to 1.0
description: Breaking protocol changes and integration migration steps.
---

OpenAxis 1.0 keeps the transport and high-rate streams recognizable, but
replaces Navigation's implicit initial-state handshake with server-directed,
correlated queries. Draft 0.2 and 1.0 are not wire-compatible: a client must
send the new protocol identifier and use the 1.0 Navigation handshake. A server
may implement both versions as separate sessions, but 1.0 does not require it.

| Area | Draft 0.2 | OpenAxis 1.0 |
|---|---|---|
| Protocol identifier | `openaxis/0.2` | `openaxis/1.0` |
| Navigation opt-in | `capabilities: ["3d"]` | `capabilities: ["navigation"]`; optional `commands` capability added. |
| Resolved policy | Server sent `profile` with one `mode` and an `active` list. | `profile` is removed. The server reports effective per-gesture camera, object, constraint, and scale state through `navigation.state`. |
| Initial state | `motion_start.need` named individual messages the client then pushed. | `motion_start` carries only `gesture_id`. The server obtains facts through correlated `navigation.query`, sends `navigation.state`, then begins Navigation pose output. |
| Gesture context | Motion and absolute Navigation poses had no shared identity. | `gesture_id` binds queries and output to the client's local document/viewport/target context; `motion_cancel` rejects a gesture after that context changes. |
| Request mechanism | Initial pose and pivot messages were associated with the current gesture implicitly. | Generic bidirectional `request` / `response` envelopes correlate work by ID and can support additional server functions without new envelope types. |
| Scene facts and preferences | Client proactively sent `world_orientation`, `translation_scale`, and `navigation_preferences`. | The server queries values such as `world.orientation`, camera/object poses, viewport aspect, bounds, `navigation.translation_scale`, and `navigation.preferences`. Client values inform translation and constraint policy; the server remains authoritative. |
| Pivot selection | Client implemented the priority chain and sent one authoritative `camera.pivot` or `object.pivot`. | Server owns priority, fallbacks, last-used state, and locks. It requests ordered client-computed candidates with short-circuiting `first`; pivot messages are authoritative Server → Client output. |
| Viewport state | No viewport-settled notification. | A client may report settled viewport changes with `viewport.settled`. |
| Document scoping | No defined document signal; integrations cleared local pivot state themselves. | Optional `document.id` scopes server-owned last-used and locked camera pivots. It is not a document epoch or context revision. |
| Navigation targets | A singular resolved mode implied camera or object operation. | Camera and object streams are independent and may run simultaneously under server-controlled mappings. |
| Concurrent controllers | Client corrections used relative `camera.pose` and `object.pose` messages without correlation, so a mouse and OpenAxis could overwrite one another. | Relative modes are replaced by `camera.delta` and `object.delta`. Deltas may carry `delta_id`; subsequent server poses identify the greatest applied delta so clients can avoid applying stale output. |
| Application actions | Numeric virtual `buttons` required an out-of-band meaning. | Correlated, named `command.execute` is added. `buttons` remains as a legacy state interface. |
| Axis names | `vx`, `vy`, `vz`, `wx`, `wy`, `wz` | **Breaking:** use `tx`, `ty`, `tz`, `rx`, `ry`, `rz` in subscriptions and axis-name lookups. The server does not alias the old names. |
| Axis units | Values were rates, but `v*` could be read as scene-linear velocity. | The six standard Axis Streaming values are explicitly gain-mapped ball angular rates in radians per second; `t*` is a logical translation control, not metres per second. |
| Extension policy | Open-ended axis names and tags existed, without a general compatibility rule. | Unknown fields/messages are ignored, unknown RPC methods return `unsupported`, and optional names may be added throughout 1.x without changing existing semantics. |

The following remain substantially unchanged: msgpack over WebSocket, the
default localhost ports, `hello` / `hello_ack`, heartbeat behavior, full-set
context tags, active-client selection, `subscribe` / `axes` / `frame`, gesture
boundaries, and SE(3) pose representation.


## Application actions

For new application actions, prefer named `command.execute` requests over
numeric virtual buttons. Names avoid an out-of-band agreement about what each
button means. Keep the `buttons` interface where the application actually needs
button state; this recommendation does not remove its protocol support.

## Axis Streaming migration

Change subscriptions and name-based lookups to the six new names. Frame values
still follow the server-confirmed `axes` order. Rate conversion and units are
unchanged by the rename. Unknown names remain in the confirmed order and produce
zero; an old name therefore does not automatically select its replacement.

Earlier unpublished 1.0 drafts also used the old names and require this update.
See the [Axis Streaming quickstart](/guide/axis-streaming/).

The C++ SDK begins with `openaxis/1.0`; there is no earlier C++ SDK API to migrate.
Use the [C++ quickstart](/guide/navigation-quickstart/#cpp) for a new native integration.

For integrations based on earlier 1.0 checkouts, rename `Client` / `ClientOptions`
to `OpenAxisClient` / `OpenAxisClientOptions`. Move retry configuration, status
observation and managed startup/shutdown to `OpenAxisConnectionManager`. Supply
current metadata through its callback instead of relying on client setters to
retain offline values. See [connection management](/reference/connection-lifecycle/).

Rename the client option `name` to `client_name`. Direct, unmanaged connections
use `connect()` / `disconnect()`; the manager uses `start()` / `stop()`.
Supply a `Scheduler` in both `OpenAxisClientOptions` and `NavigationOptions`.
Client and manager `poll()` and session `update()` have been removed. Hosts that
service work from an update loop can queue callbacks in their own scheduler and
drain them there; see [host scheduling](/reference/navigation-hosts/#c-host-contract).
The client's `send_tags()`, `send_capabilities()` and `send_focus()` publish on
the current connection and return whether sending succeeded.

Implement `OpenAxisListener` for typed input callbacks and pass a shared listener
to the client constructor, or register it with `add_listener()`. Construct
`NavigationSession` with the client to attach its navigation listener automatically;
remove manual forwarding from `on_message` and `on_connection`. The client and
host must outlive the session. The explicit sender constructor remains available
for standalone coordinator tests.

Replace `NavigationHost` implementations with `NavigationAdapter`: capture and
validate a native context, return a `NavigationCapture` from `begin_query()`,
and return `WriteResult` from `apply_pose()`. Supply object navigation through
`options.object_adapter` and ongoing reads through the observation callbacks.
The [adapter contract](/reference/navigation-hosts/#c-host-contract) gives the
complete signatures. The geometry helper `look_at()` is now `pose_from_look_at()`.

## Observer and numeric validation updates

Earlier 1.0 checkouts accepted numeric strings in Python/C# geometry and booleans
in some Python paths. Supply actual numeric vector components and projection
values; these coercions are now rejected.

Python `query_context` and synchronous `query_failed` now include `query`.
Async `gesture_finished` now includes `reason`; its extra `pose_received` event
has been removed. Both Python sessions emit `cancelled` and `navigation_state`;
the synchronous object stream also emits `object_correction_waiting`. Update
observers with explicit keyword signatures accordingly.

C# `NavigationObserver.QueryFailed` now takes `NavigationQuery query` before
`error` and `durationMs`. Override `NavigationStateChanged` to observe navigation
feedback. See the [event reference](/reference/diagnostic-events/) for signatures.
