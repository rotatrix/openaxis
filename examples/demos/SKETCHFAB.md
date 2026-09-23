# Sketchfab Viewer

Run `pnpm dev` from this directory, then open `/demos/sketchfab.html`. The viewer is linked from the playground index and included in the production build. It replaces the former model-transform demo.

The page loads Sketchfab's official 1.12.1 Viewer API wrapper and uses its cross-origin messaging interface. It connects to the local OpenAxis bridge through `OpenAxisClient`, `AsyncNavigationSession`, and the managed connection lifecycle. It does not inject code into the iframe or patch Sketchfab.

The page declares the navigation capability and uses the user's shared navigation profile. With Rotatrix defaults, hold Win (Windows), Ctrl (Mac), or Super (Linux) to orbit; button 4 pans; Shift swaps orbit/pan. Button 1 snaps the view and button 2 enables turntable lock. No object-editing tags are advertised.

1. Start the Rotatrix/OpenAxis bridge and choose a model from the dropdown, or expand the custom URL/UID form. Camera setup and connection start automatically when the viewer is ready. Setup disables native camera constraints and establishes zero roll once per model because the API has no roll getter. Reconnecting or pausing does not reset the pose.
2. Navigate with the device. Each pose sends `setCameraLookAt(position, target, 0)` and `setCameraRoll(radians)` back-to-back, without waiting for the first callback before sending roll.
3. Point at a surface before starting a device orbit gesture. As in 3D Services, the adapter answers `pick.cursor` first and `pick.viewport_center` on a miss, following the server's lazy query order. A yellow marker shows the authoritative pivot during the gesture. **Lock last pivot** locks the server's last selected pivot; **Unlock pivot** resumes automatic selection. Both use the SDK's standard `navigation.pivot.lock` / `navigation.pivot.clear` commands. A miss returns unavailable so the server can apply its normal fallback policy.
4. OpenAxis diagnostics are open by default. The SDK supplies query, pivot, and write evidence; the shared 3D Services overlay projects visual guides over the iframe. Collapse the panel to disable diagnostics.
5. Expand **Viewer API details** and use **Check camera readback** after a command completes. This compares the reported eye and target against the last acknowledged command. It cannot measure rendered roll, so check that visually.
6. **Reset pose** restores the initial camera pose with zero roll. **Pause device** or **Escape** toggles device input while preserving the camera. Native Sketchfab input stays disabled to avoid camera conflicts. Reloading the model restores its authored configuration before automatic setup.

The asynchronous SDK session coalesces device poses, rejects stale sequences and gestures, and serializes remote writes. Resetting the pose invalidates the current gesture before using the same write lane. Model switching invalidates old callbacks and creates a fresh iframe. Focus loss makes the navigation context unavailable; reconnection is managed by the SDK. While controlled, `setUserInteraction(false)` disables native input and a transparent overlay blocks mouse input to the embedded viewer. Native input stays disabled while the page owns the camera. This does not disable every possible automatic camera transition.

The adapter publishes a Z-up, right-handed world, the acknowledged logical camera pose, the viewer's actual field of view, viewport aspect and cursor, document identity, and camera target. It accepts absolute perspective camera poses and server-selected pivots. Unsupported facts (including selected-object picks, selection bounds, and model bounds) return `UNAVAILABLE`; no fake surface hits are supplied. Object manipulation and orthographic camera poses are not supported by this camera integration. FOV writes convert SDK radians to Sketchfab degrees. The camera pose includes the last acknowledged roll because Sketchfab has no roll getter; this is not independent measurement of the rendered orientation.

Picking uses `pickFromScene(start, end)` against Sketchfab's actual scene geometry. The ray is constructed from a single captured camera pose, FOV, viewport aspect, and normalized cursor position, so iframe pixel scaling and device-pixel ratio do not affect it. The segment extends 1,000 times the captured eye-to-target distance (at least one model unit). Each pick has a 650ms timeout to leave room for center fallback within the server's two-second query budget. Missing or invalid hits, timeouts, and retired contexts are unavailable. The optional hit bounds are omitted because the API does not provide them. There is no selected-object scope in this integration, so it does not claim the selection-only behavior available in 3D Services.

## Known limits and verification

Look-at and roll share one write slot: both callbacks must settle before another pose can start, including when one fails. This avoids an extra iframe round trip displaying the new viewing direction with the previous roll on slower models. The viewer exposes separate calls, so this cannot guarantee an atomic render update. The asynchronous SDK session retains only the latest queued device pose while a write is outstanding. Delayed-callback tests exercise this with an 8-degree FOV, matching the reported car model `fb30feb22cf04b91be3be0872d10ba17`; the user has since confirmed smooth navigation on that model.

The embed now starts with `navigation: 'fps'` and `camera: 0`. OpenAxis still performs orbit navigation around its selected pivot; FPS here selects only Sketchfab's internal camera implementation. The shipped orbit renderer computes its roll axis using the eye offset minus the world target, making roll depend on position. That can rotate the rendered frame during pure depth translation. The FPS renderer instead rolls around the forward direction; the adapter negates camera-back-axis roll to match that convention. A full page reload is required when upgrading from the orbit-renderer version.

The shipped API registers `setCameraRoll` and consumes radians, but this remains undocumented behavior. Exact Z-up poles are explicitly rejected. Projection remains perspective; model transforms are unchanged. Native Sketchfab navigation stays disabled; pause only affects OpenAxis device input.

The demo uses `AsyncNavigationSession` for callback-based host writes, `OpenAxisConnectionManager` through the shared focus helper, and `NavigationDiagnostics` plus the same `NavigationDiagnosticOverlay` used by 3D Services. Expand OpenAxis diagnostics to see query outcomes, subdued pick samples and hits, and write evidence. Diagnostics are disabled while collapsed. Page-cache suspension retains the camera; final shutdown awaits session cleanup.

Automated tests validate pose decomposition, independent pivots, surface queries, stale output rejection, profile metadata, and lifecycle behavior:

```sh
pnpm test
pnpm build
```

The user verified the embedded prototype works, roll appears centered on the screen, and the paired-write change makes the car model smooth. Automated integration tests additionally exercise the real asynchronous SDK session against a callback-based Sketchfab test double: absolute poses, stale sequence rejection, model retirement during an outstanding write, FOV conversion, and unavailable focus. The in-app browser still shows a blank embedded frame during agent verification, so physical-device behavior has not been independently verified here. No mock renderer was substituted for the live page.

Implementation references inspected for this experiment:

- [Viewer API wrapper](https://static.sketchfab.com/api/sketchfab-viewer-1.12.1.js)
- [API method registrations and implementation](https://static.sketchfab.com/static/builds/web/dist/4978f6604289fd7e686bd9ca66fc3153-v2.js)
- [Renderer and orbit manipulator](https://static.sketchfab.com/static/builds/web/dist/2b5a2346934cf652f5aad6dca09f4f35-v2.js)

## Model presets and overlay limits

The preset list includes Shiba, the user-tested Porsche 996, and curated Staff Picks, including: [Littlest Tokyo by glenatron](https://sketchfab.com/models/94b24a60dc1b48248de50bf087c0f042), [1975 Porsche 911 Turbo by Lionsharp Studios](https://sketchfab.com/models/8568d9d14a994b9cae59499f0dbed21e), and [Study by Miki Bencz](https://sketchfab.com/models/9b3f278bacc54f219addd98215008ceb). Staff Pick status and creator names were checked against the public Sketchfab API on 2026-09-17. This is a fixed selection, not a live feed. Models stay hosted in the official viewer; the page links to each original model and creator.

The visual overlay needs no iframe access: it projects SDK evidence using the acknowledged camera position, orientation, FOV, and viewport size. It cannot use Sketchfab?s depth buffer, so model surfaces cannot occlude these guides. Callback acknowledgment is not render synchronization; guides can briefly lead a slow viewer. Fullscreening only the embedded viewer also excludes the parent-page overlay.

The environment group also includes Sangenjaya at night, Abandoned Warehouse, After the rain, Postwar City, Medieval City Pack Demo, The Great Drawing Room, Cathedral, and Sea Keep ?Lonely Watcher?. These were selected from the public architecture Staff Picks catalog, with an emphasis on detailed interiors and larger city scenes. Creator credits are included in the dropdown and the selected-model link leads to the original Sketchfab page.

## Orbit and free camera

The Navigation selector adds or removes `navigation.hint.free_camera` while retaining the navigation capability and other context tags. The shared profile handles both modes. Mode changes drain an issued camera write, discard the old gesture, refresh managed SDK metadata, and retain the camera pose. Pivot locking is available only in Orbit.

Default free-camera controls: hold Win on Windows, Cmd on Mac, Super on Linux, or button 4 to walk; add Shift/button 2 to look, Ctrl/button 1 for height, and Alt for continuous rate motion. Releasing activation clears all six rates. Other navigation-capable demos opt in with `navigation.hint.free_camera`; no demo-specific profile import is needed.

## Free-camera translation scale

At 1? and unit gain, a 90-degree ball movement translates by the model framing sphere's radius: half its diameter. This uses the enclosing sphere chosen by Sketchfab, not the longest side of an AABB. During initialization the visible viewer calls recenterCamera, reads the framed eye and target, then restores the authored camera. From Sketchfab's home-framing implementation, radius = framed distance ? sin(atan(tan(vertical FOV / 2) ? min(aspect, 1))). This accounts for narrow FOV and portrait viewports.

The base scale is measured once for each model and stays fixed during navigation. The user's 0.25? / 1? / 4? / 16? multiplier is preserved across model loads. Changing the multiplier ends the gesture so the next query captures the new scale. Rotation and orbit scaling are unaffected. Profile/device gains still multiply this nominal relationship.

If framing is unavailable or fails, the adapter explicitly labels its fallback as an initial-view estimate, using half the initial visible height at the authored target. Failure to restore the camera stops initialization. No model bounds are fabricated or published. The scale source and world-unit distance appear beneath the speed selector. The derivation relies on the inspected viewer implementation and needs live validation when Sketchfab changes that implementation.

The iframe stays visible throughout loading and camera initialization: hiding it until viewerready can defer rendering and deadlock readiness. Framing may briefly appear before the authored camera is restored. In active Free camera mode, the page prevents the default Alt keydown/keyup menu behavior so releasing the rate modifier does not move focus to browser chrome. It does not cancel the SDK gesture. The held Walk binding remains active and resumes position output; normal focus-loss and idle policies still apply.
