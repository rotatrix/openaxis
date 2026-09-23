# Reference 3D scene and behavior

Python, C#, TypeScript and C++ load `scene.json`: the original 3D Services scene generated with seed 123, including 30 boxes, cones, cylinders, spheres and tori. Geometry, normals, initial transforms, colors, camera and ground dimensions are shared. Regenerate from the OpenAxis checkout with `node examples/demos/generate-reference-scene.mjs`; runtime does not use random numbers.

Rendering remains platform-specific. Scene queries include only object geometry; navigation picking additionally includes the finite 80 × 80 ground at Y=0. The ground is a grid with transparent gaps and two-unit spacing, never an object-selection target. Helpers and diagnostics are excluded from bounds and picking. World coordinates are right-handed, Y up, camera forward -Z. Diagnostic screen samples are viewport pixels, Y down.

| State | Trigger | Action |
| --- | --- | --- |
| Viewing | Click / double-click | Select / begin edit |
| Viewing | Left drag / middle or right drag | Pan / rotate camera; Shift swaps |
| Editing | Left drag / middle or right drag | Translate / rotate object; Shift swaps |
| Editing | Left click or Enter | Accept, retire operation, deselect |
| Editing | Right click or Escape | Restore starting transform, retire operation, deselect |
| Either | Wheel | Zoom camera / translate edited object in depth; preserve fractional deltas |
| Viewing | Enter / U | Edit selection / undo accepted edit |
| Either | R / O / D | Reset whole scene / switch projection / toggle diagnostics |
| Either | F | Toggle the free-camera preference tag |

Edit clicks use a four-pixel drag threshold and accept held modifiers. A drag release does not accept or cancel. Double-click requires the same object within 400 ms and five pixels. Every edit gets a new identity, even when editing the same object again; gesture completion does not complete an edit. Native changes increment the current pose, including intervening SDK writes. Reset restores all seeded transforms and the original perspective camera and clears selection, edit and undo history. Diagnostics start off. HUD control text is contextual and uses distinct Mouse/Keyboard headings; status labels connection as `Rotatrix:` and includes projection and diagnostics state.

## Rotatrix device controls

The navigation capability lets Rotatrix select the user's navigation profile.
The `demo-3d-services` tag identifies the example. Demos publish context and
preference tags; Rotatrix owns the mapping from device input to navigation.
Textual device-control guidance describes Rotatrix's default profiles, which
users can customize. Check Rotatrix's active profile and overlay for current
bindings. The SDK and demos do not prescribe or inspect those mappings.

The [free-camera recipe](https://openaxis.rotatrix.com/guide/free-camera/)
explains how the preference and translation-distance fact affect navigation.

## Visual feedback

Camera and object pivots follow the shared
[pivot appearance guidance](https://openaxis.rotatrix.com/experience/pivots-diagnostics/).
Diagnostic overlays follow the
[rendering contract](https://openaxis.rotatrix.com/reference/diagnostic-rendering/).
Keep dimensions, depth behavior and palette specifications in those pages.
