# SE2 2D

This canvas playground moves and rotates one arrow in an 8-by-8 world-frame
grid. It keeps translation in the XY plane and rotation around Z. The fixed
orthographic camera describes the canvas scale to OpenAxis.

The public `NavigationSession` answers queries through camera and object
adapters and owns gesture binding, ordering and correction acknowledgements.
The application clamps the arrow to the grid and returns its actual pose.
The SDK sends an `object.delta` correction and holds unacknowledged output;
once acknowledged, reversing at an edge moves back without accumulated
overshoot. There is no custom sequence tracking or manual rebase sender.

The only writer is device input. There are no observation callbacks, picking
or diagnostic overlays. Escape pauses, a canvas click resumes, and blur cancels
the gesture. Page-cache return preserves the arrow; final shutdown closes the
session and stops drawing.

Run `pnpm dev` and open `/demos/se2-2d.html` with Rotatrix running.
The existing `demo-se2` tag is unchanged. `se2-2d.test.mjs` exercises the real SDK
with a simulated transport, including grid corrections and acknowledgements.
For a device check, push the arrow against each edge, reverse direction, rotate,
and pause/resume. The arrow should remain planar and respond promptly on reversal.
