# Examples

- [`cpp_demo_3d_app/`](cpp_demo_3d_app/README.md) — C++17 GLFW/OpenGL reference viewer
  with the shared scene, camera/object navigation, picking, edit/undo and event logs.

- [`csharp_demo_3d_app/`](csharp_demo_3d_app/) — cross-platform raylib C# viewer with mouse
  controls, camera/object navigation, picking, reconnect and diagnostics.

- [`python_demo_3d_app/`](python_demo_3d_app/) — Python demo 3D app built with Panda3D,
  with mouse controls and OpenAxis camera and object navigation.
- `demos/` — web demo suite (Vite + Three.js). See the [repo README](../README.md)
  for build/run instructions.

## Looking for full integration examples?

For the runnable TypeScript reference application's SDK architecture and checks, see
[TypeScript demo 3D app](typescript_demo_3d_app/README.md). For camera navigation in a hosted viewer,
see [Sketchfab](demos/SKETCHFAB.md).

The FreeCAD and Blender integrations are open source and ship with the
Rotatrix host software download: open the **Integrations** tab and click
**"Reveal"** on an integration to view its source code. They are complete,
real-world OpenAxis client implementations (viewport navigation, profile
tags, 3D services) and make good references for building your own.
