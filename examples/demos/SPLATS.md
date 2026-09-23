# Splat Explorer

Open `splats.html` from the demo index. The page uses Spark 2.1 and Three.js
0.180, and automatically loads Ludlow (approximately 50 MB). No scan binaries
are bundled with the app. An internet connection is required for the default
scene; local PLY, SPZ, SPLAT, KSPLAT, SOG and RAD files can also be opened.
Remote scan URLs must support CORS. Only Gaussian-splat PLY files are supported,
not ordinary mesh or point-cloud PLY files.

## Navigation

Choose a control scheme in the page. The client advertises `navigation` and
either `demo-splats-left` or `demo-splats-right`, selecting the corresponding
bundled `demo_splats_left` / `demo_splats_right` profile. Both disable roll.
Forward/back and strafe follow the horizontal ground plane, regardless of view
pitch. Q/E moves along world vertical. This does not add
terrain following or collision detection.

- Left Rotatrix + right mouse: precision position travel by default (forward/back,
  strafe, twist to turn left/right); hold btn4 for rate travel. Mouse controls look.
- Right Rotatrix + left keyboard: ball controls position-based pitch/yaw,
  twist is ignored; WASD moves, Q/E changes height, Shift boosts speed.
  Hold btn4 to temporarily use the ball for rate travel and twist-to-turn.
- Releasing btn4 clears travel velocity. While holding it, btn1 switches to
  low-gain position travel for fine adjustments. In the right-hand scheme,
  btn1 also reduces look sensitivity.

The application adapter supplies camera pose, world orientation, viewport and
translation scale. The host profiles own device-navigation constraints. A public
`NavigationSession` applies absolute server poses and handles ordering and
context validity. Mouse look and keyboard travel call `nativeCameraChanged()`;
the SDK sends corrections and holds stale server output until acknowledgements
arrive, including when more native input arrives while a correction is pending.
There is no custom gesture tracker or incremental pose-merging layer.

Reset, speed changes, scan replacement and scheme changes retire the old gesture.
Final shutdown aborts the default scan download, closes the SDK session and frees
Spark/Three resources. A late scan completion cannot reopen the connection.

Click **Start flying** to focus the canvas (and capture the pointer for the
left-hand scheme). If the browser rejects pointer capture, drag on the canvas
to look. In the right-hand scheme, focus the canvas for keyboard controls. Scroll changes speed.
Escape releases the pointer and pauses; click the canvas or Start flying to
resume. Flight has no collision or gravity. Scan coordinates have arbitrary
units, so adjust speed for each scan. The axis-flip option rotates a custom scan
180 degrees about X to accommodate common splat export conventions.

## Default asset attribution

- **Ludlow – Quality Square**, by **ijenko**.
- Source: https://superspl.at/scene/ca36efcc
- License: https://creativecommons.org/licenses/by/4.0/
- Public asset manifest: https://d28zzqy0iyovbz.cloudfront.net/ca36efcc/v1/meta.json
- The original compressed SOG textures are packaged into an uncompressed ZIP
  in browser memory for Spark. Coordinates are rotated 180 degrees about X for
  rendering. The scan's appearance/content is otherwise unedited.
- Initial camera position and target are from the published viewer settings.

The remote asset is owned/hosted by a third party and may become unavailable.
Loading failures leave the previous scene usable and allow retry or local-file
loading. This 4,555,055-splat scene can be demanding on integrated GPUs; render
pixel ratio is capped at 1.5. Spark's worker/WASM decoder accounts for most of
the demo's JavaScript bundle size and is only imported by the splat page.

Run `pnpm test` for navigation checks and `pnpm build` for all demo entrypoints.
