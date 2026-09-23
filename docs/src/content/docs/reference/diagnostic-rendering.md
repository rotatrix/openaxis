---
title: Diagnostic rendering contract
description: Requirements for presenting SDK diagnostic evidence consistently across applications.
---

The shared presentation model described here is available in Python, C#, TypeScript and C++. Shared fixtures verify rows, colors, world geometry and coincident screen markers.

Diagnostic renderers must preserve the evidence supplied by the SDK so developers
can verify the same integration behavior in different applications. The SDK
supplies presentation data; the application renderer maps it to native graphics.
See the [diagnostics recipe](/guide/diagnostics-logging/) for runnable wiring.

## Required behavior

| SDK evidence | Renderer responsibility |
| --- | --- |
| Text rows | Show the supplied text and semantic tone. Preserve distinctions such as unavailable, skipped, unknown readback and differs. |
| Screen markers | Draw a crosshair at each supplied position and show its supplied label beside it. Python, TypeScript and C++ use `label`; C# uses `Name`. Do not invent labels from colors or fact names. |
| Semantic tones | Use Python's `COLORS`, C#'s `DiagnosticPalette`, TypeScript's `DIAGNOSTIC_COLORS`, or C++ `diagnostic_colors()`. Text and markers must retain their assigned meaning. |
| World segments | Draw their supplied endpoints, tone, width and opacity using the current application camera. Reproject during native navigation too. |
| Captured context | Draw only in the document/view that produced the evidence. Hide or clear evidence when that context becomes invalid. |
| Expiry and visibility | Refresh expired status and remove overlays when disabled or unloaded. Logging remains independent of visibility. |

Use the [Diagnostics API refresh contract](/reference/diagnostics/#threading-and-refresh)
to schedule expiry and redraws.

The renderer must not query the application again to fill missing evidence.
Graphics must remain transient and excluded from picking, selection, undo and saved
content. Where native graphics affect bounds, remove them before collecting bounds.

## Appearance and coordinates

Do not draw pick rays or camera-pose coordinate axes, including in custom native
overlays. Ray evidence may still be captured for inspection. World orientation,
object axes and sketch-plane diagnostics remain available.

Candidate bounds and point crosses use a 1-pixel stroke and 0.35 opacity, retaining
their semantic colors. Honor `opacity` (`Opacity` in C#) on each world segment;
it defaults to 1 for other geometry. Inventor's RGB-only line color sets use
attenuated RGB as a fallback. Screen samples use 0.65 opacity; text rows stay
fully readable. The separate authoritative pivot keeps its normal appearance.

“Returned candidate” identifies the client's first available query result. It
does not claim the server used that candidate. Dim all candidate evidence equally:
pivot messages carry a point without source attribution, and coincident points
do not establish provenance.

Use a small, approximately constant screen-size crosshair: about a **9 logical
pixel radius**, **2-pixel stroke**, with its label about **12 pixels to the right
and 8 pixels above** the sample. These are visual guidelines; no new SDK style API
is required. Fonts, font metrics and panel placement may follow the application.
Keep labels readable against both light and dark backgrounds.

The SDK combines samples at the same position with the same tone into one marker
with newline-separated query names. Render those names on separate lines, 15
logical pixels apart, beside
the single crosshair. For example, `pick.cursor.selection` and `pick.cursor`
share a screen sample, while their query results remain separate in the text rows.
The [pick evidence contract](/reference/diagnostics/#pick-evidence) distinguishes
tested misses from skipped tests and defines local marker coordinates.
Do not offset the crosshair to separate labels: its position is evidence.

Convert the integration's marker coordinates to native display coordinates.
Screen-marker dimensions are logical display pixels; account for DPI separately
and do not scale a position twice.

If an application cannot render part of the presentation, document that limitation
and retain the evidence in its diagnostic panel. For example, Onshape shows text
and 2D markers because its integration has no transient 3D overlay. A limitation
must not silently turn a missing visual into an unavailable fact.

## Acceptance check

Using a known scene, compare cursor and viewport-center samples, hit bounds and
labels across integrations. Check perspective and orthographic views, wide and
tall viewports, DPI scaling and native camera movement. Then switch views and
turn diagnostics off: no stale graphics should remain. These native visual checks
complement the SDK tests of presentation data.

The normal camera/object pivot is a separate visual from diagnostic crosshairs.
Follow [pivot marker appearance](/experience/pivots-diagnostics/#pivot-marker-appearance).
