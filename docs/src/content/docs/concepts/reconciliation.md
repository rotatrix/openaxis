---
title: Reconciling navigation
description: How observations, realized poses, corrections, acknowledgements, and queued output keep navigation synchronized.
---

The server sends absolute target poses. The application may realize a different
pose because of native input, snapping, limits, collisions, or numerical
normalization. Reconciliation keeps the server's model aligned with that result.

`NavigationSession` compares requested poses with observations from the application.
When a meaningful difference appears, it sends a correction to the server and
waits for acknowledgement before applying output that depends on that correction.
This prevents the next navigation update from undoing native input or constraints.

## Requested, observed, and realized poses

These values have different meanings:

- **Requested pose:** what the server asked the application to apply.
- **Observation:** a pose actually read from the application.
- **Realized pose:** an observation after a successful native write.

`NavigationSession`'s comparison policy decides which differences matter. A native
camera representation can change without changing the visible view. The
integration should express that equivalence in its comparison or conversion,
rather than sending endless corrections for an invisible difference.

## A normal correction

Suppose the server requests object position `8`, but the application's constraint
limits it to `5`:

1. The application applies the request and reports the actual position `5`.
2. `NavigationSession` sends `object.delta` with translation `-3` and a correction ID.
3. The object stream waits for output whose `applied_delta_id` acknowledges that ID.
4. The acknowledged pose is evaluated against the current observation before
   any further native write.

The same correction mechanism handles independent native movement and a constrained
write. Camera and object correction barriers are independent: an object barrier
does not block camera output, and a camera acknowledgement cannot clear it.

## Correction barriers

The SDK uses at most one identified correction in flight per target and gesture.
This is its coordination strategy, not a protocol limit on how many delta IDs an
independent client may send. A successful WebSocket send is not acknowledgement:
the SDK waits for a server pose whose `applied_delta_id` includes the pending ID.

While waiting, retain the observation associated with that correction and
coalesce subsequent native movement against it. Once acknowledged, send at most
one follow-up correction for accumulated movement. The watermark persists in
later server poses; it is not a new acknowledgement after the pending barrier
has cleared. Hold or discard older output rather than applying it over newer
native input, retaining at most the newest pending pose.

Clear pending correction state on gesture end, cancellation, disconnection,
or a matching send failure. When a final pose and gesture end are coalesced,
preserve a newer application observation or an unacknowledged correction.

## Native observations and equivalence

For a custom coordinator, retain the most recently observed or realized pose.
Before applying newer output, or after native input, read the actual pose and
compute translation as observed minus retained position and rotation as observed
orientation multiplied by the inverse retained orientation. Send these increments
as deltas and advance the baseline so the same movement is not reported twice.
For orthographic scale changes, the increment is observed extent divided by
retained extent. Use absolute rebases for discontinuities, not repeated rebases
for ordinary concurrent input.

Treat native change notifications as dirty signals and read on the application's
required thread instead of polling every output frame when notifications are
available. Suppress synchronous notifications from your own setter; compare
later notifications against retained readback. Retain the pose actually realized
after a write, not just its requested value. If an acknowledging pose is already
equivalent to that observation, no additional native write is needed.

Apply suitable comparison tolerances and correction rate limits to prevent
native quantization from feeding back indefinitely. An orthographic host may
normalize eye/target depth without changing the image: its comparison/conversion
policy can ignore that axial normalization while retaining view-plane movement.
This does not change the protocol's translation semantics. Applications without
reliable readback or change notifications need not implement concurrent-input
correction. See [concurrent input](/guide/concurrent-input/) for SDK wiring.

## Unknown readback

A successful setter can be followed by an unavailable read. The adapter reports
success with an unknown realized pose, preserving the distinction between a
completed write and knowledge of its result.

`NavigationSession` clears its observed baseline and separately retains the last
successful request. When observation becomes available again:

- If it matches the request, it becomes the observed baseline.
- If it differs significantly, the `NavigationSession` sends the usual correction.
- If the camera projection changed, it uses the rebase mechanism below.

For example, request `20`, successful write, unknown readback, then observation
`22` produces a correction of `+2`. A second successful unknown write to `25`
replaces the recovery reference: an eventual observation of `27` still produces
`+2`, not `+7`. Gesture/connection retirement clears that reference.

An unavailable read before any successful write simply provides no observation.
The next frame can try again. No special concurrent-correction mode is required.

This recovery path requires an actual observation to become available. Without
a camera observation callback, the coordinator cannot detect native camera
movement; see the [adapter contract](/reference/navigation-hosts/#writes-and-observations).

## Projection changes

A change between perspective and orthographic projection, or another projection
discontinuity detected by the comparison policy, cannot be described by a rigid
camera delta alone. `NavigationSession` sends:

1. An absolute `camera.pose` containing the observed camera and projection.
2. An identity `camera.delta` with an ID, establishing an acknowledgement barrier.

The existing `applied_delta_id` releases that barrier. A matching pose alone is
not proof that the server has consumed the rebase.

## Skipping and retaining work

When input arrives faster than the application can apply it, retaining the newest
pose avoids replaying a backlog of outdated movement. Other work, such as queries
and pivot changes, keeps its place in the ordering.

Observation and acknowledgement processing happen before duplicate suppression.
An unchanged request can skip the native setter when it matches the current or
last known realized pose. The separately retained request after unknown readback
is never eligible as a known realization.

Each stream keeps its newest pending pose. `max_work` / `maxWork` bounds non-pose
work; up to one camera pose and one object pose occupy additional slots. A
replacement is appended at its new arrival position, so it cannot overtake an
intervening query or pivot. An older pose released from a pivot wait cannot
replace a newer pending pose.

Gesture end drains eligible final work, then cleans up. Cancellation or a new
gesture invalidates old work. Neither path authorizes a write to a replacement
viewport or target.

## Failure boundaries

A failed native write, failed correction send, acknowledgement timeout, or
invalid bound context cancels the gesture. Diagnostic and pivot-rendering
failures are passive: they must not turn a committed write into a failure.

Async camera coordination preserves the same checks around awaited operations,
but cannot retract a native write already issued remotely. Application-level operation
timeouts remain the integration's responsibility.

See [adapter contracts](/reference/navigation-hosts/) for the observation
and write-result APIs, including when each stream enables reconciliation.
