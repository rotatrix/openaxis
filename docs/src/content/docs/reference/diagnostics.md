---
title: Diagnostics API
description: Collector options, pick evidence and presentation fields across all four SDKs.
---

The collector/presentation contract is implemented in Python, C#, TypeScript and C++. The [C++ API](#c-api) below uses the same defaults, palette and shared presentation fixtures.

`NavigationDiagnostics` collects the facts and writes used by a navigation
session so you can verify the integration independently of server navigation
policy. It supplies logs and presentation data; your application draws the data.
For runnable wiring, use the [diagnostics recipe](/guide/diagnostics-logging/).

Import `NavigationDiagnostics` and `COLORS` from Python's
`openaxis.navigation_diagnostics`, or use C#'s `OpenAxis.Diagnostics` namespace.
Pass the collector as `diagnostics` when constructing the `NavigationSession`. `NavigationSession`
feeds evidence and binds its comparison policies automatically; do not forward
the same events through an observer as well. Python's async session accepts the
same collector. TypeScript exports `NavigationDiagnostics` and `DIAGNOSTIC_COLORS`
from `@openaxis/sdk`; both session variants accept `diagnostics`.

Use `formatEvent` / `formatLogLine` from `@openaxis/sdk/diagnostics` for standalone
formatting without importing the client runtime.

## Configuration

| Purpose | Python | C# | TypeScript | Default |
| --- | --- | --- | --- | --- |
| Capture overlay evidence | `enabled` | `enabled` | `enabled` | `False` / `false` |
| Log sink | `log(level, message)` | `Action<string, string> log` | `log(level, message)` | None |
| Include correction details | `log_level="debug"` | `DebugLogging = true` | `logLevel: "debug"` | Info/warning only |
| Completed correction retention | `retention` | `retention` | `retention` | 1 second |
| Recent lifecycle/correction history | `history_limit` | `historyLimit` | `historyLimit` | 30 entries |
| Map captured context to view identity | `context_key(context)` | `contextKey` | `contextKey` | Preserve supplied context |
| Mutation notification | `on_changed()` | `Changed` | `onChanged` | None |
| Monotonic clock, in seconds | `clock` | `clock` | `clock` | Language defaults below |

Default clocks are Python's `time.monotonic`, C#'s
`Stopwatch.GetTimestamp() / Stopwatch.Frequency`, and TypeScript's
`performance.now() / 1000`.

History limits must be positive; retention must be finite and nonnegative.
Logging stays active when overlay capture is disabled. Repeated correction states
and unknown-readback transitions are suppressed; normal fact/query logs remain on.
The log sink receives `info`, `warning` or `debug` and should return quickly.

Use `set_enabled(value)` / `SetEnabled(value)` / `setEnabled(value)` to change capture.
A change clears retained evidence. `clear()` / `Clear()` clears evidence without changing capture
or logging. `history` contains `(time, level, message)` tuples in Python;
`History` returns recent message strings in C#. History excludes per-fact and
per-write traffic and resets at gesture start. TypeScript's `history` returns
detached `{ time, level, message }` entries.

## Pick evidence

Return `markerPosition: [x, y]` alongside a pick's existing `point` and optional
`bounds`. If the test ran and missed, return only `markerPosition`. If the test
was skipped (for example, there is no selection), return the SDK's unavailable
value. The session collects the marker from the actual resolver result; no
diagnostic callback or request-ID tracking is needed.

`markerPosition` uses application-defined renderer coordinates: viewport pixels,
logical UI coordinates, or NDC are all valid. It is distinct from protocol cursor
coordinates and must identify where the actual test sampled. The SDK preserves
the pair for local rendering and removes it before availability checks and wire
serialization. A marker-only miss therefore does not stop ordered `first`
evaluation. Identical positions with the same tone share a crosshair and
newline-separated labels. Existing hit results without metadata remain supported.

Legacy `pick` / `Pick` methods remain for compatibility; new integrations should return `markerPosition`.

## Presentation

Call `presentation()` / `Presentation()` on the collector's owning thread. It
returns detached display data and does not read the application or perform picks.

| Python field | C# property | Meaning |
| --- | --- | --- |
| `context` | `Context` | Opaque identity of the view that produced the evidence |
| `lines`: `text`, `tone` | `Lines`: `Text`, `Tone` | Formatted query, write and correction results |
| `segments`: `start`, `end`, `tone`, `width` | `Segments`: `Start`, `End`, `Tone`, `Width` | World-space drawing primitives |
| `markers`: `label`, `point`, `tone` | `Markers`: `Name`, `X`, `Y`, `Tone` | Screen-space crosshairs and labels |
| `revision` | `Revision` | Mutation counter for redraw coalescing |
| `expires_at` | `ExpiresAt` | Next monotonic expiry deadline, or `None` / `null` |

TypeScript uses `context`, `lines`, `segments`, `markers`, `revision` and
`expiresAt`. Its row, segment and marker fields match the Python names. The
context remains an opaque application identity; it is not cloned.

Resolve tones with `COLORS[tone]` / `DiagnosticPalette.Color(tone)`, which supply
RGB channels from 0 to 255. TypeScript uses `DIAGNOSTIC_COLORS[tone]`.
Follow the [rendering contract](/reference/diagnostic-rendering/)
for projection, marker placement, visual consistency and cleanup.

## Threading and refresh

The collector has no worker thread or timer. Session mutations, presentation
reads and UI controls must be serialized on its owning thread: the application
scheduler for synchronous integrations, or the owning event loop for
`AsyncNavigationSession` in Python and TypeScript.
If drawing happens on another thread, transfer a presentation snapshot to it.

`on_changed` / `Changed` / `onChanged` runs after mutation; enqueue a coalesced refresh instead
of querying or rendering the application inside that callback. Derive context
identity from the supplied navigation capture, never a fresh active-view lookup.

After each refresh, replace your expiry timer using `expires_at` / `ExpiresAt` / `expiresAt`
and the same clock. At that deadline, obtain a new presentation and schedule its
next deadline, if any. Expiry changes visible data without incrementing revision
or firing a notification. Native camera movement must also reproject world
segments even when the revision is unchanged.

For custom consumers, see [observer events](/reference/diagnostic-events/).
Application-specific profiling can remain separate from the shared collector.

## C++ API

Include `<openaxis/diagnostics.hpp>`. Construct `NavigationDiagnostics` before its
session and pass its address as the third `NavigationSession` constructor argument.
The collector must outlive the session; all methods belong to the application thread.
The session feeds actual query and write results automatically and shares its
`compare_poses` policy with the collector. Diagnostics never perform native reads or picks.

| API | Contract |
| --- | --- |
| `DiagnosticOptions::enabled` | Initially false |
| `history_limit` / `retention` | 30 retained entries / 1 second for acknowledged or ended corrections |
| `clock` | Optional monotonic seconds provider; defaults to `diagnostic_time()` |
| `log(level, message)` / `debug` | Optional log sink; debug includes correction details. Routine successful writes do not produce log records |
| `set_enabled(bool)` / `clear()` | Toggle collection or clear retained evidence; disabling clears presentation |
| `on_changed` | Optional passive change callback; expiry alone does not call it |
| `set_context(string)` | Bound native view/edit identity; replaced contexts hide old query geometry |
| `pick(request_id, name, PickEvidence)` | Legacy manual evidence API; prefer resolver `markerPosition` |
| `pick(name, PickEvidence)` | Legacy overload using the currently resolving synchronous query |
| `presentation()` | Detached `DiagnosticPresentation`: context, lines, segments, markers, revision, optional `expires_at` |
| `history()` | Detached bounded history with monotonic time, level and message |
| `diagnostic_colors()` | Shared semantic RGB palette |

`DiagnosticLine` contains `text` and `tone`. `DiagnosticSegment` contains world
`start`, `end`, `tone` and logical-pixel `width`. `DiagnosticMarker` contains
`label`, a two-component screen `point`, and `tone`. Coincident samples with the
same tone share one marker and newline-separated labels.

Collector, logger and legacy session-observer exceptions are isolated from
navigation. Unknown readback is represented without cancelling the gesture.
Host context replacement during a native callback invalidates stale completion.
