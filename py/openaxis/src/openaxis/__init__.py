"""OpenAxis 1.0 Python client SDK.

Import from the submodule that matches the tier you need — each one declares
its public surface in ``__all__``:

- ``openaxis.types``    wire-format messages and value objects (no third-party deps)
- ``openaxis.process_identity`` native process identity helpers for foreground routing
- ``openaxis.geometry`` pure-Python Vec3/Quat and pose conversion helpers
- ``openaxis.diagnostics`` dependency-free diagnostic event formatting
- ``openaxis.logging`` optional rotating session files and console/UI mirrors
- ``openaxis.navigation`` synchronous Navigation query evaluation helpers
- ``openaxis.navigation_session`` synchronous host camera/object coordination
- ``openaxis.async_navigation_session`` asynchronous host camera coordination
- ``openaxis.client``   the async WebSocket client (requires websockets + msgpack)
- ``openaxis.connection_manager`` opt-in reconnect, metadata replay, and shutdown

Nothing is re-exported at the package root, so importing the geometry or wire
types never pulls in the websockets/msgpack transport stack.
"""
