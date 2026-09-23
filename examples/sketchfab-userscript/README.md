# Sketchfab camera userscript experiment

This standalone prototype tests independent camera control inside an existing Sketchfab viewer. It does not connect to Rotatrix or OpenAxis yet. It is an experimental application integration, not a minimal SDK example.

## Install and try

1. Use a userscript manager that supports **page MAIN-world execution**, such as Tampermonkey with raw injection. A userscript manager normally is a browser extension; this avoids writing a dedicated extension, not that installation requirement.
2. Create a script and paste the contents of [`openaxis-sketchfab.user.js`](./openaxis-sketchfab.user.js). Enable it for Sketchfab and allow it to run in matching child frames. Do not add `@noframes`. No third-party host-page access is needed: the script runs in the embedded `sketchfab.com/models/…/embed` frame itself.
3. Reload a model page or a site containing a Sketchfab embed, and start its viewer. A useful public test is [the Shiba viewer](https://sketchfab.com/models/faef9fe5ace445e7b2989d1c1ece361c/embed?autostart=1).
4. When the panel reports a captured camera, choose **Take control**. Test translation and **Roll +** repeatedly. Turn off pivot rotation to rotate at the eye; turn it on and change the world pivot coordinates to test off-center orbits. Setting the pivot alone does not move the camera.
5. **Reset** returns to the captured independent pose. **Release** hands rendering back to the native camera; it may jump, especially if native mouse input changed that camera during takeover. **Remove experiment** restores the patched methods and removes the panel. Reloading also removes all runtime changes.

Translation moves the camera and its pivot together. The model's scene transform is not modified. The current prototype leaves field of view and projection with Sketchfab and does not support XR or multiple viewers within one frame. Matching Sketchfab frames can work on other websites, but sandbox restrictions, userscript-manager settings, and future viewer changes can prevent injection. Native annotations, picking, and camera-dependent effects may disagree with the independent view because their update code can run before the rendering override.

## Mechanism and evidence

The script captures Sketchfab's Webpack runtime, identifies the engine module by its exported renderer behavior, and hooks `osgViewer.Viewer.prototype.frame` to capture the live viewer. It overrides the camera view matrix during `renderingTraversal`, after the native manipulator updates but before culling and drawing, and restores the native matrix in `finally`. This gives the experiment its own rigid camera pose and pivot without accessing model assets or saving anything to Sketchfab.

The private hook is based on inspection of the shipped viewer, not a supported compatibility contract:

- [Renderer bundle inspected September 2026](https://static.sketchfab.com/static/builds/web/dist/2b5a2346934cf652f5aad6dca09f4f35-v2.js): engine export contains `osgViewer.Viewer`; `frame` copies the manipulator's inverse matrix before `renderingTraversal`.
- [API bundle inspected September 2026](https://static.sketchfab.com/static/builds/web/dist/4978f6604289fd7e686bd9ca66fc3153-v2.js): **`setCameraRoll` is registered from API 1.11 onward**, despite being absent from the function list we initially consulted. The earlier inference that roll necessarily requires replacing the renderer was too strong. `setCameraLookAt` with zero duration directly sets eye and target. Those methods offer a separate, potentially less invasive approach when an API client can be attached.

The experiment deliberately probes the rendering hook to avoid requiring the host website to initialize a Viewer API client. It does not assume undocumented roll units or require a specific Webpack module ID. If the module or renderer shape changes, it reports an unsupported hook rather than guessing.

## Validation

```sh
node --test openaxis/examples/sketchfab-userscript/camera.test.cjs
```

Tests cover rigid-pose reconstruction, roll, off-center orbit, translation, overriding a native camera update, release, teardown, and restoration after render errors. These tests establish the prototype's math and hook lifecycle; they do not establish compatibility with every live Sketchfab deployment. A live viewer smoke test must confirm that roll persists, the edited pivot changes orbit, translation works, and release restores native navigation.
