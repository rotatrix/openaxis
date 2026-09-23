# Cube

Cube is a focused object-navigation playground: one permanently selected cube,
a fixed perspective camera, and immediate object edits. Unlike 3D Services, it
does not demonstrate camera navigation, selectable objects, or accept/cancel
transactions.

The application uses the public `NavigationSession` object adapter for gesture
binding, ordering, and query replies. Camera facts supply
the reference frame; camera writes are rejected. Rotation conversions use the
SDK's `Quat`. The cube is the only editable object and device input is its only
writer, so the example needs no native-edit observation callbacks. It supplies
object and selection bounds; picking facts are unavailable.

The shared focus helper supplies browser focus/pause policy around the SDK's
connection manager. The connection/pause HUD is the only UI overlay.
Escape pauses; clicking the viewport resumes.
Blur/pause cancels the current gesture. Page-cache suspension preserves the
scene; final shutdown closes the session and disposes rendering resources.

Run `pnpm dev` here and open `/demos/cube.html`. Start Rotatrix to use
device input. The navigation capability and `interaction.object.transform` tag
select the user's shared navigation profile. With the default controls, rotate
the ball to rotate the cube, hold Shift to translate, and press button 3 to toggle
world snapping. Camera controls temporarily suspend object input; this demo keeps
its camera fixed. `pnpm test` includes `cube.test.mjs`, which exercises the real scene,
session and connection manager with a simulated transport.

For a manual check, move and rotate the cube, pause/resume, and leave/return
to the page. The camera
must stay fixed and retired gestures must never move the cube.
