---
title: Settings and controls
description: Recommended boundaries for a small integration settings surface.
---


Integration settings help users connect the application and diagnose problems.
Navigation behavior also depends on the user's Rotatrix profile, so the
application's settings should make those responsibilities clear.

These are recommendations for an application-owned UI:

- Show connection status and an enable/disable control.
- Expose the endpoint only if users need to configure it.
- Keep diagnostics separate from normal navigation preferences.
- Respect native camera preferences and server-owned navigation/pivot policy.
- Use action names and application terminology, not profile-dependent buttons or modifiers.
- Keep correction IDs, queue sizes and comparison tolerances out of ordinary settings.

If a setting changes query facts or tags, refresh or invalidate the affected
context so a gesture does not mix old and new assumptions.

For example, after changing `navigation.preferences.lock_roll` or
`lock_translation_plane`, cancel the active gesture if the new preference should
take effect immediately. The next gesture obtains a fresh query snapshot. Keep
this lifecycle wiring in the integration; the preference values remain advisory
and explicit server policy can override them.
