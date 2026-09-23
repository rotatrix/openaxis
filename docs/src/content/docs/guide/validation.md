---
title: Integration checklist
description: Essential implementation and native validation checks.
---


Use this checklist after migrating your application to the OpenAxis SDK to
validate its geometry, input and lifecycle behavior.

## Implementation

- **Thread:** all native calls run on the permitted application thread. Scheduler callbacks are deferred, never inline.
- **Target:** queries and writes use the same captured viewport or object. Closing or replacing it invalidates the context.
- **Pose:** convert units, axes, projection and viewport aspect consistently. See [coordinates](/concepts/coordinates/).
- **Result:** return the actual pose after writing. Distinguish a failed write from a successful write with unknown readback.
- **Events:** notify the `NavigationSession` of native camera/object changes and invalidated contexts. See [application binding](/reference/navigation-hosts/#application-events).
- **Lifecycle:** announce capabilities, tags and focus after connecting. Close the `NavigationSession` and finish cleanup before destroying native resources. See [connection lifecycle](/reference/connection-lifecycle/).

## Test in the application

| Test | Pass condition |
| --- | --- |
| Orbit, pan and zoom in perspective and orthographic views | Correct direction and scale; no drift or flicker |
| Landscape, portrait, resized and split views | Aspect, picks and overlays agree with the drawable viewport |
| Native mouse/controller input during a gesture, including release | Movement stays continuous; no final jump |
| Close/replace target, disconnect, reload and unload | No stale writes, leftover graphics or duplicate handlers |
| Picking, if supported | Cursor outside viewport misses; center and selected-geometry picks work independently |
| Object manipulation, if supported | Stable target; native accept/cancel and undo behave correctly |
| Diagnostics on versus off | Same navigation; no effect on selection, extents, snapping or saved content |

Automated commands and coverage live in the demo READMEs:
[Python](/examples/python_demo_3d_app/README.md),
[C#](/examples/csharp_demo_3d_app/README.md),
[TypeScript](/examples/typescript_demo_3d_app/README.md), and
[C++](/examples/cpp_demo_3d_app/README.md). Native viewport behavior and
physical-device input still require the application checks above.

For a failure, retain application/SDK versions, projection, viewport size and the failing
step, plus the actual pick or requested/realized pose from [diagnostics](/guide/diagnostics-logging/).
