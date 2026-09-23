# TypeScript demo 3D app

Three.js browser reference viewer. `application.ts` owns the native scene API,
`integration.ts` owns SDK adaptation, and `main.ts` wires startup and cleanup.
The documentation imports these sources directly.

From the OpenAxis checkout root:

```sh
pnpm install --frozen-lockfile
pnpm -C ts/sdk build
pnpm -C examples/demos dev
```

Open `http://localhost:5188/demos/typescript-demo-3d-app.html`.
Use `?debug` for SDK debug logging or `?url=ws://127.0.0.1:6607` for another server.

See [shared scene and native controls](../demo_3d_scene/README.md),
[Navigation integration guide](https://openaxis.rotatrix.com/guide/navigation-integration/)
and [manual demo checks](../ACCEPTANCE.md). Device controls shown in demo help
describe Rotatrix’s customizable default profiles; the SDK and demo do not own
those bindings. Check Rotatrix for your active mappings.

## Tests

```sh
pnpm -C examples/typescript_demo_3d_app check
pnpm -C examples/typescript_demo_3d_app test
```

These check TypeScript types, application geometry, adapters and lifecycle.
Use the browser and manual checks above for rendering and device behavior.

## Browser lifecycle

Blur reports focus without disconnecting. Pagehide suspends the connection;
pageshow reconnects after pending shutdown. Back/forward-cache restoration
keeps the scene and edit. Final teardown rolls the edit back and drains SDK
cleanup before disposing rendering resources.
