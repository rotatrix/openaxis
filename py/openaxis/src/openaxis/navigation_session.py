"""Adapter-thread navigation coordination for camera and optional object streams.

The adapter supplies capture_context(), is_current(context), begin_query(context),
apply_camera(context, pose, navigation_state, pivot), and optional show_pivot().
An optional object_adapter supplies the same capture/validation/query methods and
apply_object(context, pose, navigation_state, pivot). Its context must bind the
original object or native operation, not follow changing selection. Object facts
are resolved through this binding; camera and pick facts use the camera adapter.

Query captures resolve(name); initial_camera_observation() / initial_object_observation()
seed observation only once per gesture. Optional observation callbacks read each
stream before writes and when native_camera_changed()/native_object_changed() is
called. A successful WriteResult may always report a realized object pose even
without an observation callback: significant residuals use object.delta.
Without object_observation, supplied object.pose facts seed the initial reference
and known realized writes update it; unchanged output is skipped against that
reference without reading native motion. Unknown readback is None and clears
the reference after a write. A failed write cancels the entire gesture.

Schedulers post callbacks deferred to the adapter thread and post_at monotonic
clock deadlines. Adapter methods are synchronous, invoked outside session locks.
Connection and gesture retirement never commit or roll back native transactions.
max_work bounds queued non-pose work. Each active camera/object stream has one
additional latest-pose slot; replacement preserves the new pose's arrival order
relative to queries rather than retaining the superseded pose's queue position.
"""
from ._navigation_session import NavigationSession, WriteResult
from ._session import Difference, compare, compare_object

__all__ = ["NavigationSession", "WriteResult", "Difference", "compare", "compare_object"]
