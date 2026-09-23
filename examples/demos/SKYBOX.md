# Skybox

Skybox demonstrates a single rotation-only camera inside a procedural sky.
Its public `NavigationSession` adapter answers camera queries and applies
rotations; the SDK owns gesture binding, sequence ordering and query replies.
SDK `Quat` handles rotation conversion. Position stays at the origin and the
perspective field of view stays at 70 degrees, matching the original demo.
Pose writes report the actual camera pose, including those fixed values.

There is no picking, object manipulation, competing native writer, or diagnostic
overlay. The shared browser focus helper wraps the SDK connection manager;
Escape pauses and clicking resumes. Blur cancels the gesture. Page-cache
suspension preserves the scene, while final shutdown releases rendering resources.

Run `pnpm dev` and open `/demos/skybox.html` with Rotatrix running.
The `demo-skybox` tag is unchanged. `pnpm test` covers real SDK session behavior
with a simulated transport. Manually check rotation, pause/resume, and return
navigation; the camera must remain at the sphere's center.
