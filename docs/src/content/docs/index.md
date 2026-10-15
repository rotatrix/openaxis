---
title: OpenAxis SDK
description: Add Rotatrix control to an application with the OpenAxis SDK.
---

OpenAxis lets you add **Rotatrix control to your application**. Rotatrix is a
trackball controller with a desktop app that interprets its input. For a CAD or 3D
application, it provides camera and object navigation that follows the user's
Rotatrix controls. For other uses, it supplies input rates that your application
can interpret.

<video controls muted playsinline preload="none" width="960" height="420" style="width: 100%; height: auto;" poster="/videos/navigation-demo-poster.jpg" aria-label="Rotatrix navigation demo with diagnostics">
  <source src="/videos/navigation-demo.webm" type="video/webm" />
  <a href="/videos/navigation-demo.webm">Watch the navigation demo</a>.
</video>

Rotatrix controls the demo application's camera; diagnostics near the end show
information about the scene used to calculate the movement.

<span id="how-the-sdk-helps"></span>

The Rotatrix device sends input to the **Rotatrix desktop app**, which runs the
OpenAxis server. Your application connects to that server over a local WebSocket
using the OpenAxis SDK (software development kit), a library for building
integrations. The SDK handles the connection and navigation requests; your
integration connects it to the application's camera and scene APIs, either as a
plugin or directly in the application's code.
Adding support requires access to those APIs; configuring a Rotatrix control
profile (control configuration) alone does not provide that access.

![Rotatrix device sends input to the desktop app. A local WebSocket connects the desktop app directly to the OpenAxis SDK and integration inside your application, above its native APIs.](/diagrams/openaxis-overview.svg)

## Choose an interface

Use **Navigation** for camera and object control. A camera is the viewpoint from
which the application displays a scene; the viewport is the area showing it.
Your integration reports camera and scene information, and Rotatrix computes
new positions and orientations, called poses. Your application applies them.
Rotatrix also chooses the pivot: the point around which orbit movement rotates.

Use **Axis Streaming** when your application needs to interpret input rates
itself, such as changing a non-navigation parameter. It is an alternative to the
Navigation path below; an application can also use both interfaces.

<span id="try-it-then-build"></span>
<span id="after-the-quickstart"></span>

## Next steps

- [Quickstart](/getting-started/quickstart/): try the demo with Rotatrix or a mouse.
- [Integration walkthrough](/getting-started/walkthrough/): understand how the demo connects the SDK to the application.
- [Planning a new integration](/getting-started/planning/): choose features, assess native APIs, and plan testing for your application.

For applications that interpret input rates themselves, follow the
[Axis Streaming quickstart](/getting-started/axis-streaming/).

## Licensing

OpenAxis is dual-licensed under ELv2 or GPLv3. Integrations for proprietary
applications must use the SDK under ELv2. See [legal notices](/legal/) for details.
