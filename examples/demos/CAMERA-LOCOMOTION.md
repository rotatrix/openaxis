# Camera Locomotion

A camera explores a seeded, z-up 3D scene. The public `NavigationSession`
adapter answers camera queries and applies perspective poses, including FOV.
The demo publishes `navigation.hint.free_camera` and declares the navigation
capability, using the user's shared navigation profile. It requests level walking
through `navigation.preferences` (`lock_roll` and `lock_translation_plane`); the
host can override these preferences. The adapter itself applies poses unchanged.

With default Rotatrix controls, hold Win (Windows), Cmd (Mac), Super (Linux), or
button 4 to walk. Add Shift/button 2 to look, Ctrl/button 1 for height, or Alt for
rate motion. Releasing activation stops motion. Other shared presets can change
these device controls without changing the demo.

The translation scale remains 10 world units per quarter turn before profile
gains and rate-mode processing. There is no picking, competing writer, or
diagnostic overlay. Escape pauses and clicking resumes. Final shutdown releases
the session and rendering resources; page-cache suspension preserves the scene.

The existing `se2-3d.html` URL is retained for bookmarks. Run `pnpm dev` and open
`/demos/se2-3d.html` with Rotatrix running. The gallery and window title
use Camera Locomotion. `camera-locomotion.test.mjs` verifies the real SDK session,
unconstrained pose application, lifecycle, and cleanup using a simulated transport.
