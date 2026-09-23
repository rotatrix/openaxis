# Browser demos

Run `pnpm dev` here. The gallery is served at
`/demos/`. `pnpm test` builds the SDK and runs the demo tests;
`pnpm build` builds the gallery and all demo entrypoints.

The gallery contains runnable browser demos only and can be bundled independently
of the documentation site. SDK documentation and examples for other languages
live at [OpenAxis, the Rotatrix output protocol](https://openaxis.rotatrix.com/).
Vite resolves SDK geometry imports to source; only the Node tests need the SDK build.

| Demo | Purpose |
| --- | --- |
| Axis Streaming | Axis rates and button state with `OpenAxisClient`; no navigation session needed. |
| [Cube](CUBE.md) | A single object controlled through an SDK session, with a fixed camera. |
| [Skybox](SKYBOX.md) | A rotation-only camera. |
| [SE2 2D](SE2-2D.md) | A planar object with grid-edge constraints and acknowledged corrections. |
| [Camera Locomotion](CAMERA-LOCOMOTION.md) | Camera poses in a 3D scene; declares walking preferences and uses shared navigation controls. |
| [Splats](SPLATS.md) | Camera navigation alongside native mouse/keyboard input and asynchronous scene loading. |
| [TypeScript demo 3D app](../typescript_demo_3d_app/README.md) | Camera/object operations, picking, transactions and visual diagnostics. |
| [Sketchfab](SKETCHFAB.md) | An asynchronous external viewer controlled through `AsyncNavigationSession`. |

The SDK owns navigation state and connection retry logic. Demo helpers provide
browser focus policy, status UI, rendering, or application-specific scene access.
The diagnostic overlay is optional presentation code. Simple demos omit it.
`rotvec.js` remains a small Three.js conversion bridge for Sketchfab; its rotation
math delegates to the SDK. No helper implements a second navigation state machine.

Rotatrix uses shared navigation profiles for Cube, Camera Locomotion, Sketchfab,
and the reference 3D applications. Specialized profiles remain for axis streaming,
rotation-only Skybox, planar SE2, and the two Splat hand-use schemes.
