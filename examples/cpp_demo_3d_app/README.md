# C++ demo 3D app

GLFW/OpenGL reference viewer with ImGui. Requires CMake 3.24+, C++17 and desktop
OpenGL. From the OpenAxis checkout root:

```sh
cmake -S cpp -B cpp/build -DOPENAXIS_BUILD_TESTS=ON -DOPENAXIS_BUILD_DEMO=ON
cmake --build cpp/build --config Release
ctest --test-dir cpp/build -C Release --output-on-failure --no-tests=error
```

Run `cpp/build/demo/Release/openaxis_demo.exe` on Windows; a single-configuration
generator places it at `cpp/build/demo/openaxis_demo`. The build copies
`scene.json` beside the executable. An optional positional argument chooses
another scene file. Add `--debug` for per-frame write logs.

See [shared scene and native controls](../demo_3d_scene/README.md),
[Navigation walkthrough](https://openaxis.rotatrix.com/guide/navigation-quickstart/)
and [manual demo checks](../ACCEPTANCE.md). Device controls shown in demo help
describe Rotatrix’s customizable default profiles; the SDK and demo do not own
those bindings. Check Rotatrix for your active mappings.

## Rendering checks

Run the executable with `--smoke output.bmp` to create a hidden OpenGL context,
render three frames, save the framebuffer and exit.
`--smoke-diagnostics output.bmp` and `--smoke-diagnostics-ortho output.bmp`
render offline production evidence and pivots in both projections.
These checks require graphics support but no device connection.

CTest covers SDK coordination, loopback transport and shared-scene behavior.
Live-device behavior needs the manual checks above. Consult
[compatibility](https://openaxis.rotatrix.com/reference/language-support/)
for validated platform coverage.

## Native integration details

`application.hpp/.cpp` owns the native scene API; `integration.hpp` provides the
OpenAxis adapters and lifecycle, and `main.cpp` owns startup and input.
`glfw_scheduler.hpp` uses a thread-safe queue and `glfwPostEmptyEvent`
for deferred work. The main loop waits for native events or actual deadlines.
`diagnostic_view.cpp` renders the SDK presentation. The build copies ImGui's
Roboto font and credits; Windows console output uses UTF-8.
