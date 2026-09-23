"""OpenAxis integration. Replace application.py with your real application's API."""
from functools import partial
import asyncio
import time
import logging
import os

from openaxis.process_identity import current_process_id
from openaxis.navigation_diagnostics import NavigationDiagnostics, COLORS
from openaxis.logging import configure_logging
from openaxis.client import OpenAxisClient
from openaxis.connection_manager import OpenAxisConnectionManager, ConnectionMetadata, ConnectionManagerState
from openaxis.navigation import UNAVAILABLE
from openaxis.navigation_session import NavigationSession, WriteResult, compare, compare_object
from openaxis.types import CameraPose, ObjectPose, Target
from application import MyCamera, MyObjectPose



# Panda3D stores float32 transforms. Allow a few rounding units while retaining
# sub-pixel native motion; the SDK defaults also serve higher-precision applications.
compare_camera_pose = partial(compare, absolute=1e-6, relative=2e-7, angular=1e-6)
compare_object_pose = partial(compare_object, absolute=1e-6, relative=2e-7, angular=1e-6)


class MyApplicationScheduler:
    def __init__(self, loop):
        self.loop = loop

    def post(self, callback):
        self.loop.call_soon_threadsafe(callback)

    def post_at(self, deadline, callback):
        self.loop.call_soon_threadsafe(lambda: self.loop.call_later(
            max(0, deadline - time.monotonic()), callback))


def bounds_value(bounds):
    return UNAVAILABLE if bounds is None else {'min': bounds[0], 'max': bounds[1]}


class MyNavigationAdapter:
    def __init__(self, app):
        self.app = app

    def capture_context(self):
        return self.app if self.app.alive else None

    def is_current(self, context):
        return context is self.app and context.alive

    def read(self, context):
        camera = context.get_camera()
        return CameraPose(t=camera.position, r=camera.rotation,
                          fov=camera.vertical_fov, ortho_extent=camera.vertical_span)

    def begin_query(self, context):
        return MyQueryCapture(context, self.read(context))

    def apply_camera(self, context, desired, navigation, pivot):
        context.set_camera(MyCamera(desired.t, desired.r, desired.fov, desired.ortho_extent))
        return WriteResult(True, self.read(context))

    def show_pivot(self, context, point):
        context.set_pivot_marker(point)


class MyQueryCapture:
    def __init__(self, app, camera):
        self.app, self.camera = app, camera
        self.width, self.height = app.get_viewport_size()
        self.cursor = app.get_cursor_position()

    def initial_camera_observation(self):
        return self.camera

    def resolve(self, name):
        if name == 'world.orientation':
            return {'forward': (0, 0, -1), 'up': (0, 1, 0), 'handedness': 'right'}
        if name == 'camera.pose':
            return self.camera.value()
        if name == 'navigation.translation_scale':
            # World units per quarter ball turn in Rotatrix at unit gain.
            return 4.0
        if name == 'viewport.aspect':
            return self.width / self.height
        if name == 'viewport.cursor':
            return UNAVAILABLE if self.cursor is None else (
                2*self.cursor[0]/self.width - 1, 1 - 2*self.cursor[1]/self.height)
        if name in ('model.bounds', 'selection.bounds'):
            return bounds_value(self.app.get_bounds(name == 'selection.bounds'))
        if name in ('pick.cursor', 'pick.cursor.selection',
                    'pick.viewport_center', 'pick.viewport_center.selection'):
            pixel = self.cursor if name.startswith('pick.cursor') else (self.width/2, self.height/2)
            if (pixel is None or not (0 <= pixel[0] < self.width and 0 <= pixel[1] < self.height)
                    or (name.endswith('.selection') and self.app.selected is None)):
                return UNAVAILABLE
            hit = self.app.pick(pixel, selection_only=name.endswith('.selection'))
            if hit is not None:
                _, point, box = hit
                return {'point': point, 'bounds': bounds_value((box.minimum, box.maximum)), 'markerPosition': pixel}
            return {'markerPosition': pixel}
        return UNAVAILABLE


class MyObjectAdapter:
    def __init__(self, app):
        self.app = app

    def capture_context(self):
        return self.app.operation if self.app.alive else None

    def is_current(self, context):
        return self.app.alive and self.app.operation is context

    def read(self, context):
        pose = self.app.get_object_pose(context.index)
        return ObjectPose(t=pose.position,r=pose.rotation)

    def begin_query(self, context):
        return MyObjectCapture(self.read(context),self.app.object_bounds(context.index))

    def apply_object(self, context, desired, navigation, pivot):
        self.app.set_object_pose(context.index,MyObjectPose(desired.t,desired.r))
        return WriteResult(True,self.read(context))

    def show_pivot(self, context, point):
        self.app.set_pivot_marker(point, object_marker=True)


class MyObjectCapture:
    def __init__(self, pose, bounds):
        self.pose, self.bounds = pose, bounds

    def initial_object_observation(self):
        return self.pose

    def resolve(self, name):
        if name == 'object.pose':
            return self.pose.value()
        if name == 'object.bounds':
            return bounds_value(self.bounds)
        return UNAVAILABLE


class MyConnectionStatus:
    def __init__(self, app):
        self.app = app

    def __call__(self, state, error, delay):
        if state == ConnectionManagerState.RETRYING:
            self.app.set_status(f'Reconnecting in {delay:.1f}s' + (f': {error}' if error else ''))
        else:
            self.app.set_status(state.value)


class MyOpenAxisIntegration:
    """Example integration: attach after startup, detach before window destruction."""
    def __init__(self, app, url="ws://127.0.0.1:6607"):
        self.app, self.url = app, url

    async def start(self):
        app, url = self.app, self.url
        client = OpenAxisClient(client_name='python-demo-3d-app', url=url,
                                target=Target(pid=current_process_id(), app='python-demo-3d-app'))
        adapter = MyNavigationAdapter(app)
        scheduler = MyApplicationScheduler(asyncio.get_running_loop())
        configure_logging("python-demo",
            level="debug" if logging.getLogger().isEnabledFor(logging.DEBUG) else "info",
            sinks=[lambda level, message: getattr(logging.getLogger("demo"), level)(message)])
        diagnostics = NavigationDiagnostics(log_level="debug",
                                            context_key=lambda context: app)
        object_adapter = MyObjectAdapter(app)
        session = NavigationSession(client, adapter, scheduler, observation=adapter.read, diagnostics=diagnostics,
                                    object_adapter=object_adapter, object_observation=object_adapter.read,
                                    comparison=compare_camera_pose, object_comparison=compare_object_pose)
        app.toggle_diagnostics = lambda: diagnostics.set_enabled(not diagnostics.enabled)
        app.diagnostic_frame = lambda: diagnostics.presentation()
        app.diagnostics_enabled = lambda: diagnostics.enabled
        app.diagnostic_colors = COLORS
        app.on_camera_changed = session.native_camera_changed
        app.on_object_changed = session.native_object_changed
    
        self.connection = OpenAxisConnectionManager(
            client, metadata=self._metadata, on_state=MyConnectionStatus(app),
        )
        self.client, self.session = client, session
        self._metadata_tasks = set()
        app.on_navigation_changed = self._metadata_changed
        app.on_focus_changed = self._metadata_changed
        app.on_operation_changed = self._operation_changed
        self.networking = asyncio.create_task(self.connection.run())

    def _tags(self):
        camera_tags = ['navigation.hint.free_camera'] if self.app.free_camera else []
        return ['demo-3d-services'] + camera_tags + (['interaction.object.rotate', 'interaction.object.translate'] if self.app.operation else [])

    def _metadata(self):
        # This viewer runs its GUI and networking on the same asyncio thread.
        return ConnectionMetadata(tags=tuple(self._tags()), capabilities=('navigation',),
                                  focused=self.app.has_focus())

    def _operation_changed(self):
        self.session.context_changed()
        self._metadata_changed()

    def _metadata_changed(self):
        if self.connection.state != ConnectionManagerState.READY:
            return  # Startup/reconnect reads the latest application state itself.
        task = asyncio.create_task(self.connection.refresh_metadata())
        self._metadata_tasks.add(task)
        task.add_done_callback(self._metadata_sent)

    def _metadata_sent(self, task):
        self._metadata_tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            # The connection may close during a send; reconnect replays current facts.
            logging.getLogger('openaxis.viewer').debug('Metadata refresh interrupted: %s', task.exception())

    async def stop(self):
        self.app.on_navigation_changed = lambda: None
        self.app.on_focus_changed = lambda: None
        self.app.on_operation_changed = lambda: None
        self.app.finish_object_edit(False)
        updates = tuple(self._metadata_tasks)
        for task in updates:
            task.cancel()
        # Cancel the owned run task even if shutdown arrives before it starts.
        self.networking.cancel()
        await asyncio.gather(self.networking, *updates, return_exceptions=True)
        self._metadata_tasks.clear()
        self.session.close()
        self.session.drain()
        self.app.on_object_changed = lambda: None
        self.app.on_operation_changed = lambda: None
        self.app.on_camera_changed = lambda: None
        self.app.toggle_diagnostics = lambda: None
        self.app.diagnostic_frame = lambda: None
        self.app.diagnostics_enabled = lambda: False
        self.app.set_status('OpenAxis detached')
