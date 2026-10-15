---
title: Settings and controls
description: Choose the smallest control surface that fits your host and the navigation modes you support.
---


Integration controls let users see whether OpenAxis is working and reach the few
choices the application owns. Navigation behavior itself belongs to the user's
Rotatrix profile: mappings, speeds and pivot policy are configured once in
Rotatrix, not in each application.

These are recommendations for an application-owned UI, not protocol requirements.
Size the control surface to the host and to the modes your integration supports.
An orbit-only integration may need a single diagnostics toggle.

| Control | Applies to | When to provide it |
| --- | --- | --- |
| Connect/disconnect and status | Both interfaces | Plugins and add-ons; otherwise show status in diagnostics |
| OpenAxis diagnostics | Navigation | Every Navigation integration |
| Orbit/free-camera preference | Navigation | Integrations that support [free camera](/guide/free-camera/) |
| Translation scale, lock roll, lock ground plane | Navigation | Free-camera integrations that need them |

## Connection and diagnostics

The integration connects automatically when the application starts. Use the
host's own mechanism, such as its add-on manager, to install or remove the
integration entirely.

In a plugin or add-on, provide **Connect** and **Disconnect** in its panel or
menu, together with connection status. Disconnect stops the connection manager
for the current session, so retries cannot reconnect behind the user; the next
application start connects again. Await stopping before connecting again; see
[connection manager](/reference/connection-lifecycle/#metadata-is-desired-state).
In an integration without a panel or menu of its own, show connection status in
the diagnostic presentation and [session logs](/guide/session-logs/). The connection manager reports
`connecting`, `ready`, `retrying` and `stopped`; see
[connection recovery](/guide/connection-shutdown/#connection-state). While
Rotatrix is not running, the manager retries in the background without
affecting the application. Expose the endpoint only when users need to configure it.

For Navigation, provide **OpenAxis diagnostics** as a visibility toggle in the
host's usual place for view options, such as a View-menu item, a panel checkbox
or a bindable command. Draw diagnostic text and graphics directly in the
viewport; use a small companion panel only for information the host cannot draw
there. The [diagnostic rendering contract](/reference/diagnostic-rendering/)
describes the presentation. Visibility does not change logging, and normal
[pivot markers](/recommendations/pivot-appearance/) remain independent of it.

## Navigation preferences

Integrations that support free camera report the user's preferred camera mode
with the `navigation.hint.orbit` or `navigation.hint.free_camera` tag. The tag is
a hint: server policy may honor or override it, and `navigation.state` reports the
effective mode. Place the preference toggle beside the host's own
navigation-mode controls, such as a walk or fly mode. Refresh metadata when it
changes; see [application context and focus](/guide/dynamic-tags/).

Free-camera integrations may also need translation scale, roll lock and
translation-plane lock. See [translation distance](/guide/free-camera/#translation-distance)
for translation scale. Label a plane constraint "ground plane" when that
describes its behavior in the application.

Use action names and application terminology so controls remain meaningful when
users customize their Rotatrix bindings. Respect server-owned navigation and pivot
policy, and keep diagnostic visibility separate from normal camera preferences.

If a setting changes query facts or tags, refresh or invalidate the affected
context so a gesture does not mix old and new assumptions.

For example, after changing `navigation.preferences.lock_roll` or
`lock_translation_plane`, cancel the active gesture if the new preference should
take effect immediately. The next gesture obtains a fresh query snapshot. Keep
this lifecycle wiring in the integration; the preference values remain advisory
and explicit server policy can override them.
