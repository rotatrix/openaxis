---
title: Planning a new integration
description: Choose navigation features, identify native API support, and plan how to test them.
---

Use this page to choose what your application will support and how you will
verify it. The [integration walkthrough](/getting-started/walkthrough/) explains
the SDK wiring for Navigation.

## What should work in your application?

Choose modes around the work users do in each editor:

- **3D orbit** is the main interaction for inspecting most 3D models. Support orbit,
  pan and zoom where users inspect models.
- **[2D pan and zoom](/guide/2d-navigation/)** fits drawing, diagram and canvas
  editors with a fixed orientation.
- **[Free camera](/guide/free-camera/)** fits moving through a scene rather than
  inspecting a model from outside.
- **[Object manipulation](/guide/object-manipulation/)** fits editing object
  positions and orientations when the application supports accept, cancel and undo.

Use existing integrations as implementation references, and assess your own
application with the [integration checklist](/guide/validation/). Include native
input, resizing, document changes and cleanup in the scope.

Consider scene information and visual feedback alongside movement.
[Picking and selection information](/guide/picking-pivots/) help Rotatrix choose
useful pivots; [visible pivots](/recommendations/pivot-appearance/) help users understand the movement.
[Diagnostics](/guide/diagnostics/) let you inspect scene facts and camera updates
during development and troubleshooting.

Keep the control surface small. Every Navigation integration needs a diagnostics
visibility toggle; draw diagnostics directly in the viewport and use SDK session logs for
detailed troubleshooting. Plugins also provide connect/disconnect with connection
status. Add mode controls only for the modes you support,
following the application's conventions and the
[settings recommendations](/recommendations/settings-and-controls/).

## What can its APIs support?

Locate the application's extension or startup hooks and decide whether the
integration belongs in a plugin or the application itself. Identify the language,
application versions and platforms you will support, then choose a compatible
[SDK version](/guide/sdk-installation/).

Inspect the application's source or API documentation for each intended workflow:

- **Camera and viewport:** pose reads and writes, the viewport receiving input,
  drawable dimensions, and [coordinate conventions](/concepts/coordinates/).
- **Scene:** model and selection bounds, and geometry picks at requested positions.
- **Drawing:** transient pivots and diagnostic text and graphics, including overlay limitations.
- **Scheduling and lifetime:** permitted threads and events for native camera
  changes, focus, viewport closure and document replacement.

Check the relevant recipes and [adapter contracts](/reference/navigation-hosts/)
against your SDK version. Resolve uncertain APIs with small native experiments.
When an API cannot support an intended feature, choose a fallback or narrow the
scope and describe the effect on users. Keep unresolved questions visible until
you have enough information to make that choice.

A brief assessment might look like this for a hypothetical model viewer:

| Feature | Native support | Decision and check |
| --- | --- | --- |
| Orbit, pan and zoom | Camera read/write API | Support the model viewport; verify movement direction and scale |
| Pivot and diagnostics | 3D markers supported; no viewport text rendering | Draw markers in the viewport and text in a companion panel; verify they describe the same camera and scene |
| Free camera | Camera API permits it, but the viewer is intended for model inspection | Omit it from this integration |
| Picking and selection | Surface picking available; selection bounds uncertain | Support surface picks; investigate selection bounds and check that picks match visible geometry |

Distinguish deliberate exclusions, native limitations and deferred work. When
contributing to an existing project, discuss these choices and the proposed
controls with its maintainer.

## How will you check that it works?

Choose representative documents and editors, and define an observable result for each
check: a pick matches visible geometry, closing a viewport stops updates, or toggling
diagnostics leaves navigation unchanged. Use local builds and focused automated
checks for quick feedback, then test in the application as you add features.
Use the checklist to cover native input, switching editors and cleanup as well as movement.

Use CI to verify supported platforms and packages, and test the packaged
application. Physical-device testing checks movement and controls that a successful
build cannot establish. Keep brief notes distinguishing implemented features,
passed checks and outstanding application or device testing.
