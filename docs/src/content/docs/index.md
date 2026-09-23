---
title: OpenAxis SDK
description: Choose Navigation or Axis Streaming, then connect Rotatrix through the SDK.
---

OpenAxis connects **Rotatrix input to your application**. The protocol offers
two ways to consume motion:

| Interface | What your application receives | What you implement |
| --- | --- | --- |
| **Navigation** | Camera and object poses computed by the Rotatrix server | Report camera/scene information and apply the resulting poses through native APIs |
| **Axis Streaming** | Logical axis rates for your application to interpret | Decide how input affects your application |

**I strongly recommend Navigation for 3D applications.** The Rotatrix server
provides standardized 3D navigation behavior, including camera movement and
pivot selection under the user's input profile. Your integration supplies its
camera pose, viewport aspect, selection bounds and geometry under the cursor,
as available. You do not need to recreate that navigation behavior in each application.

Axis Streaming gives your application control over how input is interpreted,
for example when adjusting a non-navigation parameter. Your integration defines
the behavior that turns those input rates into changes in the application.

An integration can use either interface or both through the same connection.

## Start building

OpenAxis 1.0 and later require **Rotatrix 1.6.0 or newer**. See
[compatibility and language support](/reference/language-support/#rotatrix-compatibility)
for protocol support.

Choose a quickstart and run its example. Each includes the setup needed to see
input working, followed by an explanation of the components and code.

- [Navigation quickstart](/guide/navigation-quickstart/): run a 3D demo, move its
  camera with Rotatrix, then follow scene queries and pose application.
- [Axis Streaming quickstart](/guide/axis-streaming/): receive named input rates,
  then follow subscriptions and callbacks that interpret them.

Language tabs retain your choice between pages. Use [SDK installation](/guide/sdk-installation/)
when you need package, source-embedding or runtime setup details.

## After the quickstart

**Shared integration tasks** apply to Navigation, Axis Streaming and applications
using both. Add [connection recovery and shutdown](/guide/connection-shutdown/),
publish [application context and focus](/guide/dynamic-tags/), or configure
[session logs](/guide/session-logs/) as you adapt the example to your host.

**Navigation features** cover camera and object integration: picking, concurrent
input, editing and diagnostic overlays. Use the [integration checklist](/guide/validation/)
to validate the adapted host. The [coordinates](/concepts/coordinates/) and
[reconciliation](/concepts/reconciliation/) concepts explain those topics in depth
when you need them; they are not prerequisites for running a quickstart.

For Axis Streaming, adapt the frame callback to your application's behavior and
use the quickstart's [stream checks](/guide/axis-streaming/#verify-the-stream).
Navigation adapters, pivots and the navigation diagnostic collector are not
required for consuming axis rates. Local session logging works with either interface.

[Compatibility and language support](/reference/language-support/) ·
[Protocol specification](/spec/) · [Interactive demos](/demos/) ·
[Source on GitHub](https://github.com/rotatrix/openaxis)

## Licensing

OpenAxis is dual-licensed under ELv2 or GPLv3. Integrations for proprietary
applications must use the SDK under ELv2. See [legal notices](/legal/) for details.
