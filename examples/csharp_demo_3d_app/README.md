# C# demo 3D app

A minimal cross-platform raylib-cs viewer for Windows, Linux, and macOS.
Requires the .NET 8 SDK or newer. The demo permits major runtime roll-forward,
so the repository's mise-managed .NET 9 works without installing .NET 8 separately.
NuGet restores raylib-cs 7.0.2 and its native
runtime libraries; Linux also needs a desktop display and GLFW/OpenGL system
dependencies. See [raylib-cs](https://github.com/raylib-cs/raylib-cs/tree/v7.0.2)
for supported runtime architectures and native setup.

UI and diagnostic text use installed fonts, with no font files bundled:
Windows tries Segoe UI, Tahoma, then Arial; macOS tries Arial, Verdana, then Tahoma.
Linux uses Fontconfig's configured sans-serif family, then common Noto Sans,
DejaVu Sans, and Liberation Sans locations. If none is usable, raylib's built-in
bitmap font is the last resort, and the demo prints a notice.
Text sizing uses the selected font's metrics and honors high-DPI scaling.

From the OpenAxis checkout root:

```sh
dotnet run --project examples/csharp_demo_3d_app/OpenAxisDemo.csproj
```

Start Rotatrix and focus the viewer. Add `-- --debug` for per-frame write logs,
or `-- --url ws://127.0.0.1:6607` to choose a server.

See [shared scene and native controls](../demo_3d_scene/README.md),
[Navigation walkthrough](https://openaxis.rotatrix.com/guide/navigation-quickstart/)
and [manual demo checks](../ACCEPTANCE.md). Device controls shown in demo help
describe Rotatrix’s customizable default profiles; the SDK and demo do not own
those bindings. Check Rotatrix for your active mappings.

## Tests

Run the in-process geometry/adapter checks (no Rotatrix required):

```sh
dotnet run --project examples/csharp_demo_3d_app/OpenAxisDemo.csproj -- --test
```

These check both projections and multiple aspect ratios, pick-through selection,
ground bounds, transformed geometry, all drag/Shift combinations, click acceptance
and cancellation, double-click editing, reset/undo, fractional wheel values,
contextual help, status, diagnostic geometry, stable operation identity,
readback, deferred dispatch and context invalidation. These checks are headless.
Use `-- --screenshot` for a brief native rendering smoke test; it saves
`csharp-raylib-preview.png` in the current directory and closes automatically.

The legacy loopback test covers query/pick diagnostics, camera and object writes,
native corrections, edit metadata and shutdown. Its mock server currently lacks
the SDK verification handshake, so it cannot complete against the current SDK:


```sh
python -m pip install -r examples/python_demo_3d_app/requirements.txt
dotnet build examples/csharp_demo_3d_app/OpenAxisDemo.csproj
python examples/csharp_demo_3d_app/test_integration.py
```

## Native integration details

`MyApplication.cs` owns the native scene API; `RaylibWindow.cs` owns rendering,
input and deferred dispatch. `MyOpenAxisIntegration.cs` owns SDK adaptation.
`Program.cs` pumps queued UI work while awaiting shutdown.
Networking reads immutable metadata snapshots instead of thread-bound scene objects.
The adapter converts protocol vertical FOV in radians to raylib degrees.
