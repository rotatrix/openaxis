# Python demo 3D app

Panda3D reference viewer. Requires Python 3.11+ and the SDK dependencies.
From the OpenAxis checkout root:

```sh
python -m pip install -e py/openaxis -r examples/python_demo_3d_app/requirements.txt
python examples/python_demo_3d_app/main.py
```

Start Rotatrix and focus the viewer. Add `--debug` for per-frame write logs or
`--url ws://127.0.0.1:6607` to choose a server.

See [shared scene and native controls](../demo_3d_scene/README.md),
[Navigation walkthrough](https://openaxis.rotatrix.com/guide/navigation-quickstart/)
and [manual demo checks](../ACCEPTANCE.md). Device controls shown in demo help
describe Rotatrix’s customizable default profiles; the SDK and demo do not own
those bindings. Check Rotatrix for your active mappings.

## Tests

```sh
python examples/python_demo_3d_app/test_app.py
python examples/python_demo_3d_app/test_app.py --gui
```

The first checks geometry, picking, adapter readback, context invalidation,
metadata replay and shutdown against a loopback server. The GUI mode opens a
window and checks input bindings, camera/object exchanges and pivot cleanup.
Physical device behavior still needs the manual checks linked above.

## Native integration details

The GUI and asyncio share the main thread. `application.py` owns the native API;
`integration.py` adapts it; `main.py` starts and stops the integration.
Panda3D uses float32 transforms, so the adapter supplies comparison tolerances
appropriate to measured native precision. See the
[concurrent-input recipe](https://openaxis.rotatrix.com/guide/concurrent-input/#comparison-precision).

Windows uses native wheel deltas to preserve fractional detents. Other platforms
use Panda3D wheel events.
