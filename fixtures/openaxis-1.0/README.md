# OpenAxis 1.0 language-neutral fixtures

The message and geometry JSON files define protocol behavior shared by every OpenAxis SDK. They
contain semantic values rather than encoded MessagePack bytes: map ordering and
the integer or floating-point width chosen by a serializer are not part of the
wire contract.

## Message fixtures

`messages.json` has three groups:

- `valid_messages` must parse as a known 1.0 message and repack to a
  semantically equivalent value.
- `invalid_messages` must be rejected by the known-message parser.
- `unknown_messages` must not acquire standard SDK behavior. An SDK may ignore
  one or deliver it through its generic extension callback.

JSON cannot represent non-finite numbers. The fixture-only form
`{"$number":"nan"}` (also `positive_infinity` and `negative_infinity`) is
expanded by each test adapter before validation.

## Release boundary fixtures

`wire.json` contains literal MessagePack bytes as hex, with an expected acceptance
result. It distinguishes integer and floating-point encodings, binary and map
values, non-finite geometry, trailing data and truncated payloads. All four SDKs
consume these bytes through their decoder/validator paths. Navigation query
parameters are also validated when the decoded request uses that method.

`queries.json` defines request parameters, resolver facts, expected resolver call
order and response values. Every SDK consumes it, including the Python and
TypeScript asynchronous evaluators. It covers memoization, unavailable facts,
ordered fallback and pick misses with and without local marker metadata.

`client.json` defines malformed requests requiring correlated `bad_request`
responses and motion lifecycle events shared by axis listeners and navigation
owners. Client tests also exercise retained queries across reconnects, completion
followed by a false handler return, and passive lifecycle callback failures.

## Geometry fixtures

`geometry.json` exercises operations whose conventions must agree across
languages. It includes the handedness-aware camera basis defined by OpenAxis
1.0. Expected values are compared using the fixture's absolute `tolerance`;
implementations need not produce bit-identical floating-point results.

Changes to message fixtures or spec-owned geometry cases are protocol-contract
changes. Add a named case when adding a message shape, validation rule, or
shared geometry convention, then run every migrated SDK's fixture consumer.

## Session traces

`session.json` describes shared Python/C#/TypeScript/C++ camera-session behavior.
These are SDK orchestration rules, not new wire messages or requirements on
other OpenAxis clients.

Each named scenario starts with fresh state and contains ordered `events`:

- `connection` retires the old connection epoch; `start` records a gesture.
- `query` represents successful context validation and completion of a camera
  fact query. `scoped: false` or `supplied: false` cannot authorize camera output.
- `receive` admits an absolute server pose with `seq` and optional `ack`.
  `process` consumes that accepted pose and the latest `actual` host observation.
- `observe` reports a detached host observation without server output.
- `complete` delivers readback (or `success: false`) for an authorized write.
- `end`, `finish`, `cancel`, `send_failed`, and `timeout` exercise lifecycle and
  recovery. `now` is injected monotonic time in seconds; the test timeout is 1s.

Pose numbers abbreviate perspective-camera X position with FOV 1 radian. Objects
can specify `t`, `r`, `x`, `fov`, or full orthographic `extent`. `actual: null`
means unavailable observation, not position zero. `as` names tokens, received
poses or writes; `token`, `ticket` and `write` refer to saved values so scenarios
can exercise late callbacks. Unnamed tickets/writes use the most recent value.

`expect` asserts selected effect/state fields. `baseline` is its X coordinate
or null; `pending` is a delta ID or null. `received` and `applied` are distinct
sequence watermarks. Vector assertions use absolute tolerance 1e-8.

## Coordinator traces

`coordinator.json` runs through the actual navigation coordinator in all four
SDKs, using a fake host, captured transport output, a manual scheduler and a
monotonic clock. Every scenario starts connected with a fresh coordinator,
camera X=10, zero rotation, FOV=1, time=0 and a one-second correction timeout.
These are SDK behavior contracts, not new protocol requirements.

Operations have identical meanings in each runner:

- `start` delivers a motion start with the specified `gesture`.
- `query` delivers a scoped `navigation.query` for `camera.pose`; its request
  ID equals the gesture ID. Gesture defaults to 7.
- `pose` delivers an absolute camera pose with X=`x`, `seq`, and optional
  `gesture`. Sequence numbers remain monotonic across gesture changes.
- `drain` runs immediate scheduled work to quiescence, including reply-send
  completion. It does not advance time. Runners bound their drain loops.
- `native_camera` changes the host camera and notifies the coordinator.
- `advance` sets monotonic `time` in seconds and invokes due timer callbacks.
  It does not itself drain immediate work; even obsolete timers are delivered
  so the SDK must reject stale callbacks.
- `context_changed` replaces the host context and notifies the coordinator.
- `close` closes/disposes the coordinator while host resources still exist.
- `on_write` installs a one-shot hook: after the host accepts the next write,
  but before readback returns, deliver its nested `events`. This defines a
  reproducible reentrant interleaving without depending on thread timing.
- `expect` checks cumulative `writes` (camera X values), outgoing `cancels`
  and `deltas` counts, or `pending` immediate scheduler callbacks.

All runners reject unknown operations and assertion fields, check version 1,
and identify the failing scenario/step. They consume every scenario without
language-specific exclusions. Add shared cases here instead of duplicating
scenario logic in four test suites.

The initial nine cases cover deferred/coalesced work, stale sequences, context
invalidation, close, gesture replacement, reentrant writes, unchanged frames,
correction timeout without traffic, and obsolete timers. This is not exhaustive
concurrency verification: suspended async host operations remain in the
Python/TypeScript async tests; actual thread safety and OS locking remain in
native thread/process tests. Connection-manager and filesystem lifecycle
scenarios are outside this fixture.

Run with the standard suites:

```text
python -m pytest py/openaxis/tests
cd ts/sdk && pnpm test
dotnet run --project cs/OpenAxis.ConformanceTests
cmake --build cpp/build --config Debug
ctest --test-dir cpp/build -C Debug --output-on-failure
```

## Diagnostic presentation

Python and C# consume `diagnostics.json` for correction retention and lifecycle
logs/status. `diagnostic-presentation.json` fixes expected rows, palette colors,
world segments (including widths) and grouped screen markers for the same facts.
Its request ID is 9, gesture ID is 7 and query duration is zero. Two cursor picks
share `(20, 30)`; the cursor ray runs from `(0, 0, 5)` to `(1, 1, 1)`.

Segment order is stable; cross-language coordinates allow absolute error 1e-12.
Update both consumers when changing the presentation contract. These fixtures
do not replace native tests of projection, DPI scaling or graphics cleanup.

Both test runners consume this file directly. Host scheduling, context collectors,
RPC completion, and transport sends are outside this first state-only increment.
