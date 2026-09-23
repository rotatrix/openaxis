---
title: SDK implementation and parity
description: Source boundaries, shared traces, and review invariants for contributors changing navigation coordination.
---

This page is for SDK contributors. Integration authors should start with the
[navigation quickstart](/guide/navigation-quickstart/) and
[adapter contracts](/reference/navigation-hosts/).

## Source boundaries

The SDK separates state decisions from effect delivery. State machines decide
which work remains valid; coordinators schedule application calls and send the
resulting messages. This separation lets shared traces test behavior independently
of each language's threading model.

| Responsibility | Python | C# | TypeScript | C++ |
| --- | --- | --- | --- | --- |
| Serialized stream state | `py/openaxis/src/openaxis/_session.py` | `cs/OpenAxis/Navigation/SessionState.cs` | `ts/sdk/src/session-state.ts` | `cpp/src/session_state.hpp` |
| Synchronous coordinator | `py/openaxis/src/openaxis/_navigation_session.py` | `cs/OpenAxis/Navigation/NavigationSession.cs` | `ts/sdk/src/navigation-session.ts` | `cpp/src/navigation.cpp` |
| Public session surface | `py/openaxis/src/openaxis/navigation_session.py` | Public types in `OpenAxis.Navigation` | Package-root exports in `ts/sdk/src/index.ts` | `cpp/include/openaxis/navigation.hpp` |
| Awaitable coordinator | `py/openaxis/src/openaxis/async_navigation_session.py` (camera only) | Not implemented | `ts/sdk/src/async-navigation-session.ts` (camera and object) | Not implemented |
| Transport and attachment | `py/openaxis/src/openaxis/client.py` | `cs/OpenAxis/Client/OpenAxisClient.cs` | `ts/sdk/src/client.ts` | `cpp/src/client.cpp` |

Source paths are relative to the OpenAxis repository. The state machines do not invoke application
APIs or send messages. Coordinators own locks or event-loop serialization,
deferred work, captured connection senders, adapter calls and effect delivery.

Camera and object streams reuse state behavior while retaining separate
sequence numbers, correction IDs and acknowledgement barriers. Public adapters
remain application-specific. Do not move native camera normalization, object
transactions or UI graphics into the state machine.

## Review invariants

### Authorization survives reentrancy checks

Capture a connection epoch and gesture generation with work. Validate them and
the bound native context before authorizing a write and after adapter calls.
Observer callbacks can also reenter application code; successful authorization
before an observer is not sufficient authorization afterwards.

Retire old requests once. A stale completion must not seed a new gesture,
clear its correction barrier, or write through a newly selected target. A
failed correction send cancels its current gesture rather than leaving it waiting
forever. Transport test seams must not become public ways to bypass captured
connection delivery.

Establish a successful scoped query's readiness before sending its reply: the
reply can immediately cause reentrant server output. Claim the query exactly once
and send through its captured connection. Never invoke native adapter methods or
scheduler callbacks while holding a session state lock.

### Keep knowledge separate from intent

The observed baseline is actual application state. The recovery reference after a
successful unknown-readback write is the requested pose, stored separately.
Only a real observation can reconcile that reference. Consecutive unknown writes
replace it; retirement clears it. A no-op check may use a known baseline, but
must never promote the recovery reference into a fabricated observation.

### Queue bounds must not discard the newest pose

Bound query/control work independently of each stream's latest-pose slot.
Replace an old pose by removing it and appending the new one at its arrival
position. Replacing in place can move a write ahead of an intervening query.
Deferred pivot waits must not reinsert an old pose over a newer accepted pose.

### Diagnostics stay passive

Observer and pivot-rendering failures must not change navigation outcomes. A
setter that committed is still successful if later diagnostic rendering fails.
Native transaction commit/rollback is not session cleanup.

## Test changes at two levels

Shared traces in `fixtures/openaxis-1.0/session.json` exercise state transitions
without application APIs. Update these for intentional cross-language behavior changes
and run all language consumers. Keep scope, acknowledgements, projection rebases,
unknown-readback recovery and lifecycle retirement consistent.

Coordinator tests exercise what state traces cannot: native-thread dispatch,
reentrant callbacks, invalid targets, two simultaneous streams, query ordering,
queue saturation, attachment ownership and failed transport sends. Add a
coordinator regression when the failure depends on execution order.

Use the commands in [release testing](/contributing/release-testing/) for the
affected SDKs.

Then build or test the affected integration. Passing fake-adapter tests establishes
coordination behavior, not native camera equivalence, viewport geometry, modal
input responsiveness or transaction behavior. Those still need application tests.

## Language idioms and parity gaps

Keep behavior aligned, not implementation structure. C# uses typed interfaces
and passive virtual observer methods; Python uses callback-shaped objects;
TypeScript uses generic context types and an event-loop scheduler for synchronous hosts. Python and TypeScript
async coordinators have a single worker around awaited adapter calls and must check
validity again after each await.

The [language support matrix](/reference/language-support/) records
which surfaces exist. Do not describe C++ async parity or an async
C# adapter coordinator as available merely because the protocol supports
the corresponding messages.

## C++ implementation and coverage

`cpp/src/client.cpp` owns transport, typed listener dispatch and its bounded inbound queue.
`cpp/src/connection_manager.cpp` owns retries and metadata replay.
`cpp/src/navigation.cpp` owns synchronous coordination and `cpp/src/session_state.hpp`
owns the shared effect-tested stream state. `cpp/include/openaxis/navigation.hpp`
defines the host API.

C++ test commands and platform requirements live in
[release testing](/contributing/release-testing/#c), with native viewer checks in
the [demo README](/examples/cpp_demo_3d_app/README.md). Shared fixtures cover
protocol, geometry, session state and diagnostic presentation; coordinator and
loopback tests exercise dispatch and transport integration.

## Outstanding parity and packaging work

Strict feature and behavioral parity is the target across all four SDKs.
Naming, type representation and runtime dispatch may be idiomatic; missing
capabilities are implementation gaps.

The current support matrix belongs in [language support](/reference/language-support/).
Close gaps in implementation and shared conformance coverage before updating
availability claims. Passing synchronous traces does not establish async parity.

C++ currently supports source embedding with CMake, but has no install/export
rules. Package installation/export support is outstanding distribution work.
