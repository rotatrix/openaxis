"""Geometry/adapter tests, plus an optional real-window loopback protocol test.

python examples/python_demo_3d_app/test_app.py
python examples/python_demo_3d_app/test_app.py --gui
"""
import math
from openaxis.process_identity import current_process_id
import os
import asyncio
import sys
import unittest

import msgpack
from websockets.asyncio.server import serve
from openaxis.navigation import UNAVAILABLE
from application import MyApplication, MyCamera as Camera, MyScene, rotate
from pathlib import Path
import json

# Keep the analytical box tests while the shipped app uses the varied scene.
FIXTURE = json.loads((Path(__file__).parent.parent / "demo_3d_scene/test-boxes.json").read_text())
def MyCamera(**kwargs):
    return Camera(**({"position":(0,0,10),"rotation":(0,0,0),"vertical_fov":1.0} | kwargs))
from integration import MyNavigationAdapter, MyOpenAxisIntegration, MyObjectAdapter


class TestSharedScene(unittest.TestCase):
    def test_seeded_meshes_and_triangle_picks(self):
        from application import SCENE
        app = MyScene()
        self.assertEqual(len(app.object_nodes),30)
        self.assertEqual(SCENE['seed'],123)
        probes = json.loads((Path(__file__).parent.parent/'demo_3d_scene/probes.json').read_text())
        for probe in probes:
            app.selected = probe['index']
            pose = probe['camera']
            app.set_camera(Camera(tuple(pose['t']),tuple(pose['r']),pose['fov']))
            hit = app.pick((450,300),selection_only=True)
            if probe['hit'] is None:
                self.assertIsNone(hit, SCENE['objects'][app.selected]['name'])
            else:
                self.assertIsNotNone(hit, SCENE['objects'][app.selected]['name'])
                for actual,expected in zip(hit[1],probe['hit']):
                    self.assertAlmostEqual(actual,expected,delta=2e-4)
        for index,initial in enumerate(app.initial_poses):
            pose=app.get_object_pose(index)
            for actual,expected in zip(pose.position,initial.position):
                self.assertAlmostEqual(actual,expected,delta=2e-6)


class TestDiagnosticRendering(unittest.TestCase):
    def test_native_line_widths_and_visible_multiline_labels(self):
        from types import SimpleNamespace
        from direct.showbase.ShowBase import ShowBase
        from panda3d.core import PNMImage, RenderModeAttrib
        from openaxis.navigation_diagnostics import (
            COLORS, DiagnosticMarker, DiagnosticPresentation, DiagnosticSegment,
        )
        base = ShowBase(windowType='offscreen')
        try:
            base.set_background_color(0,0,0)
            size = (base.win.get_x_size(),base.win.get_y_size())
            frame = DiagnosticPresentation(None,
                segments=(DiagnosticSegment((-1,0,0),(1,0,0),'cursor',1,.35),
                          DiagnosticSegment((0,0,0),(0,1,0),'axis_y',3)),
                markers=(DiagnosticMarker('pick.cursor\npick.cursor.selection',(100,120),'cursor'),))
            app = SimpleNamespace(base=base,scene=base.render,size=size,
                diagnostic_frame=lambda:frame,diagnostic_colors=COLORS,
                _diagnostic_nodes=[],_diagnostic_key=None)
            MyApplication._draw_diagnostics(app)
            world = [node for node in app._diagnostic_nodes if node.get_parent() == base.render]
            widths = [node.node().get_geom_state(0).get_attrib(RenderModeAttrib).get_thickness()
                      for node in world]
            self.assertEqual(widths,[1,3])
            for _ in range(2):
                base.graphics_engine.render_frame()
            pixels = PNMImage()
            self.assertTrue(base.win.get_screenshot(pixels))
            # Both label lines must render to the right of the sample, away from
            # the crosshair itself. This catches Panda's incompatible pixel2d transform.
            for top,bottom in ((99,115),(115,131)):
                self.assertTrue(any(
                    (color := pixels.get_xel(x,y))[0] > .2 and color[1] > .2 and color[2] < .15
                    for x in range(112,270) for y in range(top,bottom)),
                    'diagnostic label line is missing')
        finally:
            base.destroy()


class TestDemoApp(unittest.TestCase):
    def setUp(self):
        self.app = MyScene(FIXTURE)
        self.app.get_cursor_position = lambda: None
        self.adapter = MyNavigationAdapter(self.app)

    def test_pick_markers_only_record_tests_and_keep_selection_misses(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        from integration import MyQueryCapture
        from openaxis.navigation_diagnostics import NavigationDiagnostics
        diagnostics = NavigationDiagnostics(enabled=True)
        query = SimpleNamespace(request_id=1,gesture_id=1,values=(),first=())
        diagnostics.observe('query_started',query=query)
        self.app.get_cursor_position = lambda: (450,300)
        self.app.pick = Mock(return_value=None)
        capture = MyQueryCapture(self.app,self.app.get_camera())
        self.assertIs(capture.resolve('pick.cursor.selection'),UNAVAILABLE)
        self.app.pick.assert_not_called()
        self.assertFalse(diagnostics.presentation().markers)
        self.app.selected = 0
        for name in ('pick.cursor.selection', 'pick.cursor'):
            value = capture.resolve(name)
            self.assertEqual(value, {'markerPosition': (450,300)})
            diagnostics.observe('fact', query=query, name=name, value=value, duration_ms=0)
        self.assertEqual(self.app.pick.call_count,2)
        markers = diagnostics.presentation().markers
        self.assertEqual(len(markers),1)
        self.assertEqual(markers[0].label,'pick.cursor.selection\npick.cursor')

    def test_projection_pick_roundtrip_for_both_projections_and_aspects(self):
        for size in ((900,600), (400,800)):
            for camera in (MyCamera(), MyCamera(vertical_fov=None, vertical_span=8)):
                self.app.size, self.app.camera = size, camera
                pixel = self.app.project((0.4, 0.3, 1))
                hit = self.app.pick(pixel[:2])
                self.assertEqual(hit[0], 0)
                for actual, expected in zip(hit[1], (0.4,0.3,1)):
                    self.assertAlmostEqual(actual, expected, delta=1e-5)
                self.assertIsNone(self.app.pick((-1,size[1]/2)))

    def test_orthographic_clipping_includes_geometry_behind_eye(self):
        self.app.set_camera(MyCamera(position=(0,0,0),vertical_fov=None,vertical_span=8))
        lens = self.app.camera_node.node().get_lens()
        self.assertLess(lens.get_near(), -1)
        self.assertGreater(lens.get_far(), 2)
        self.assertIsNotNone(self.app.project((0,0,1)))

    def test_orthographic_clipping_encloses_transformed_scene_corners(self):
        from itertools import product
        from panda3d.core import Point3
        from application import MyObjectPose
        for depth in (-200., 200.):
            self.app.set_object_pose(0,MyObjectPose((2,3,depth),(.3,.7,.2)))
            for rotation in ((0,0,0),(.4,.8,.1)):
                self.app.set_camera(MyCamera(position=(0,0,10),rotation=rotation,
                                             vertical_fov=None,vertical_span=8))
                lens = self.app.camera_node.node().get_lens()
                for index in range(len(self.app.shapes)):
                    for corner in product(*zip(*self.app.object_bounds(index))):
                        depth_in_view = -self.app.camera_node.get_relative_point(
                            self.app.scene,Point3(*corner)).z
                        self.assertLess(lens.get_near(),depth_in_view)
                        self.assertGreater(lens.get_far(),depth_in_view)

    def test_orthographic_clipping_includes_diagnostics_and_contracts_when_removed(self):
        from panda3d.core import Point3
        self.app.set_camera(MyCamera(vertical_fov=None,vertical_span=8))
        lens = self.app.camera_node.node().get_lens()
        original_range = lens.get_far()-lens.get_near()
        self.app._diagnostic_world_points = ((0,0,500),(0,0,-700))
        for rotation in ((0,0,0),(.4,.8,.1)):
            self.app.set_camera(MyCamera(rotation=rotation,vertical_fov=None,vertical_span=8))
            lens = self.app.camera_node.node().get_lens()
            for point in self.app._diagnostic_world_points:
                depth = -self.app.camera_node.get_relative_point(self.app.scene,Point3(*point)).z
                self.assertLess(lens.get_near(),depth)
                self.assertGreater(lens.get_far(),depth)
        self.app._diagnostic_world_points = ()
        self.app.set_camera(MyCamera(vertical_fov=None,vertical_span=8))
        lens = self.app.camera_node.node().get_lens()
        self.assertAlmostEqual(lens.get_far()-lens.get_near(),original_range)

    def test_ground_pick_is_finite_and_not_selectable(self):
        for camera in (MyCamera(position=(0,3,10),rotation=(-.3,0,0)),
                       MyCamera(position=(0,3,10),rotation=(-.3,0,0),vertical_fov=None,vertical_span=8)):
            self.app.set_camera(camera)
            pixel = self.app.project((4,0.0,0))[:2]
            hit = self.app.pick(pixel)
            self.assertIsNotNone(hit)
            self.assertIsNone(hit[0])
            self.assertAlmostEqual(hit[1][1],0.0,places=5)
            self.assertEqual(hit[2].minimum,(-40.,0.0,-40.))
            self.assertEqual(hit[2].maximum,(40.,0.0,40.))
            self.assertIsNone(self.app.pick(pixel,selection_only=True))
        self.app.set_camera(MyCamera(position=(50,3,10),vertical_fov=None,vertical_span=8))
        self.assertIsNone(self.app.pick(self.app.project((50,0.0,0))[:2]))

    def test_object_selection_picks_through_ground(self):
        from application import MyObjectPose
        self.app.set_object_pose(0,MyObjectPose((0,-3,0)))
        self.app.set_camera(MyCamera(position=(0,3,10),rotation=(-.5,0,0)))
        pixel = self.app.project((0,-3,0))[:2]
        self.assertIsNone(self.app.pick(pixel)[0])  # Ground is nearer.
        self.assertEqual(self.app.pick(pixel,objects_only=True)[0],0)

    def test_wheel_zoom_both_projections(self):
        for camera in (MyCamera(),MyCamera(vertical_fov=None,vertical_span=8)):
            self.app.set_camera(camera)
            before = self.app.project((1,0,0))[0]-450
            self.app.mouse_zoom(1)
            self.assertGreater(self.app.project((1,0,0))[0]-450,before)
            self.app.mouse_zoom(-1)
            self.assertAlmostEqual(self.app.project((1,0,0))[0]-450,before,delta=.001)
            self.assertEqual(self.app.camera.rotation,camera.rotation)

    def test_rotated_camera_roundtrip(self):
        rotation = (0.2, 0.4, 0)
        self.app.camera = MyCamera(position=rotate((0,0,10),rotation), rotation=rotation)
        hit = self.app.pick((450,300))
        self.assertIsNotNone(hit)
        projected = self.app.project(hit[1])
        self.assertAlmostEqual(projected[0],450, delta=.001)
        self.assertAlmostEqual(projected[1],300, delta=.001)

    def test_selection_center_independent_of_outside_cursor(self):
        self.app.selected = 0
        capture = self.adapter.begin_query(self.app)
        self.assertIs(capture.resolve('pick.cursor.selection'), UNAVAILABLE)
        self.assertEqual(capture.resolve('pick.viewport_center.selection')['point'], (0,0,1))
        self.assertEqual(capture.resolve('viewport.aspect'), 1.5)
        self.assertIs(capture.resolve('future.fact'), UNAVAILABLE)

    def test_write_readback_pivot_and_context(self):
        from openaxis.types import CameraPose
        desired = CameraPose(t=(2,3,12), r=(0,.2,0), ortho_extent=8)
        result = self.adapter.apply_camera(self.app, desired, None, None)
        self.assertTrue(result.success)
        actual = self.adapter.read(self.app)
        for key in ("t", "r"):
            for a, b in zip(actual.value()[key], desired.value()[key]):
                self.assertAlmostEqual(a, b, delta=1e-5)
        self.assertEqual(actual.ortho_extent, desired.ortho_extent)
        self.adapter.show_pivot(self.app, (1,2,3))
        self.assertEqual(self.app.pivot, (1,2,3))
        self.adapter.show_pivot(self.app, None)
        self.assertIsNone(self.app.pivot)
        self.app.alive = False
        self.assertFalse(self.adapter.is_current(self.app))

    def test_mouse_orbit_preserves_center_and_distance(self):
        for camera in (MyCamera(), MyCamera(vertical_fov=None,vertical_span=8)):
            self.app.camera = camera
            for _ in range(100):
                self.app.mouse_navigate(7,3,(0,0,0))
            self.assertAlmostEqual(sum(x*x for x in self.app.camera.position),100, delta=.002)
            x,y,_ = self.app.project((0,0,0))
            self.assertAlmostEqual(x,450, delta=.001)
            self.assertAlmostEqual(y,300, delta=.001)

    def test_mouse_pan_matches_pixels_and_uses_latest_camera(self):
        for camera in (MyCamera(), MyCamera(vertical_fov=None,vertical_span=8)):
            self.app.camera = camera
            center = self.app.mouse_navigate(30,20,(0,0,0),pan=True)
            x,y,_ = self.app.project((0,0,0))
            self.assertAlmostEqual(x,480, delta=.001)
            self.assertAlmostEqual(y,320, delta=.001)
            from dataclasses import replace
            latest = replace(self.app.camera, position=(5,2,12))
            self.app.set_camera(latest)  # Simulate an intervening SDK write.
            self.app.mouse_navigate(0,0,center,pan=True)
            self.assertEqual(self.app.camera, latest)


    def test_object_operation_accept_cancel_undo_and_stale_context(self):
        adapter = MyObjectAdapter(self.app)
        self.app.begin_object_edit(0)
        context = adapter.capture_context()
        initial = adapter.read(context)
        self.app.mouse_edit_object(dx=.2*self.app.size[1]/(20*math.tan(.5)),pan=True)
        self.assertAlmostEqual(adapter.read(context).t[0],.2,places=5)
        self.app.finish_object_edit(False)
        self.assertIsNone(self.app.selected)
        self.assertFalse(adapter.is_current(context))
        self.assertEqual(self.app.get_object_pose(0).position,initial.t)
        self.app.begin_object_edit(0)
        self.assertIsNot(adapter.capture_context(),context)
        self.app.mouse_edit_object(dx=.2*self.app.size[1]/(20*math.tan(.5)),pan=True)
        self.app.finish_object_edit()
        self.assertIsNone(self.app.selected)
        self.assertAlmostEqual(self.app.get_object_pose(0).position[0],.2,places=5)
        self.app.undo_object_edit()
        self.assertEqual(self.app.get_object_pose(0).position,initial.t)

    def test_object_transforms_update_pick_bounds_and_query(self):
        from application import MyObjectPose
        self.app.set_object_pose(0,MyObjectPose((4,0,0),(0,.5,0)))
        self.app.begin_object_edit(0)
        adapter = MyObjectAdapter(self.app)
        capture = adapter.begin_query(adapter.capture_context())
        self.assertEqual(capture.resolve('object.pose')['t'],(4,0,0))
        bounds = capture.resolve('object.bounds')
        self.assertGreater(bounds['min'][0],2)
        self.assertIsNone(self.app.pick((450,300)))
        projected = self.app.project((4,0,0))
        hit = self.app.pick(projected[:2])
        self.assertEqual(hit[0],0)
        self.assertEqual(hit[2].minimum,bounds['min'])


    def test_float32_readback_is_equivalent_but_native_motion_is_detected(self):
        import random
        from openaxis.types import CameraPose, ObjectPose
        from integration import compare_camera_pose, compare_object_pose
        rng = random.Random(4)
        self.app.begin_object_edit(0)
        adapter = MyObjectAdapter(self.app)
        for _ in range(300):
            magnitude = 10**rng.uniform(-8,.4)
            rotation = tuple(rng.uniform(-1,1)*magnitude for _ in range(3))
            position = tuple(rng.uniform(-100,100) for _ in range(3))
            camera = CameraPose(t=position,r=rotation,fov=1.)
            self.adapter.apply_camera(self.app,camera,None,None)
            self.assertFalse(compare_camera_pose(camera,self.adapter.read(self.app)).changed)
            obj = ObjectPose(t=position,r=rotation)
            adapter.apply_object(self.app.operation,obj,None,None)
            self.assertFalse(compare_object_pose(obj,adapter.read(self.app.operation)).changed)
        self.assertTrue(compare_object_pose(ObjectPose(),ObjectPose(t=(.001,0,0))).changed)
        self.assertTrue(compare_camera_pose(CameraPose(fov=1.),CameraPose(r=(0,.001,0),fov=1.)).changed)

    def test_object_mouse_controls_preserve_camera_and_notify(self):
        self.app.begin_object_edit(0)
        camera = self.app.get_camera()
        changes = []
        self.app.on_object_changed = lambda: changes.append(True)
        self.app.mouse_edit_object(dx=20)
        self.assertNotEqual(self.app.get_object_pose(0).rotation,(0,0,0))
        self.app.mouse_edit_object(dx=20,dy=10,pan=True)
        position = self.app.get_object_pose(0).position
        self.assertGreater(position[0],0)
        self.assertLess(position[1],0)
        self.app.mouse_edit_object(wheel=1)
        self.assertLess(self.app.get_object_pose(0).position[2],position[2])
        self.assertEqual(self.app.get_camera(),camera)
        self.assertEqual(len(changes),3)
        from integration import MyOpenAxisIntegration
        self.assertIn('interaction.object.translate',MyOpenAxisIntegration(self.app)._tags())


class TestViewerConnection(unittest.IsolatedAsyncioTestCase):
    def test_window_events_notify_only_focus_changes(self):
        from types import SimpleNamespace
        changes = []
        window = object()
        focused = False
        app = SimpleNamespace(base=SimpleNamespace(win=window), _focused=False,
                              has_focus=lambda: focused,
                              on_focus_changed=lambda: changes.append(focused))
        MyApplication._window_changed(app, window)
        focused = True
        MyApplication._window_changed(app, object())
        self.assertEqual(changes, [])
        MyApplication._window_changed(app, window)
        MyApplication._window_changed(app, window)
        focused = False
        MyApplication._window_changed(app, window)
        self.assertEqual(changes, [True, False])

    def make_app(self):
        app = MyScene(FIXTURE)
        app.set_status = lambda text: None
        app.has_focus = lambda: True
        return app

    async def test_reconnect_replays_current_context_and_shutdown_closes_socket(self):
        app = self.make_app()
        complete = asyncio.get_running_loop().create_future()
        attempts = []

        async def server(socket):
            try:
                hello = msgpack.unpackb(await socket.recv(), raw=False)
                self.assertEqual(hello['type'], 'hello')
                self.assertEqual(hello['target'], {'pid': current_process_id(), 'app': 'python-demo-3d-app'})
                await socket.send(msgpack.packb(dict(type='hello_ack', proto='openaxis/1.0',
                                                    server_name='quickstart-test'), use_bin_type=True))
                metadata = {}
                while 'focus' not in metadata:
                    message = msgpack.unpackb(await socket.recv(), raw=False)
                    metadata[message['type']] = message
                attempts.append(metadata)
                if len(attempts) == 1:
                    app.begin_object_edit(0)
                    app.has_focus = lambda: False
                    await socket.close()
                else:
                    complete.set_result(None)
                    await socket.wait_closed()
            except Exception as error:
                if not complete.done():
                    complete.set_exception(error)

        async with serve(server, '127.0.0.1', 0) as endpoint:
            port = endpoint.sockets[0].getsockname()[1]
            integration = MyOpenAxisIntegration(app, f'ws://127.0.0.1:{port}')
            await integration.start()
            try:
                await asyncio.wait_for(complete, 6)
                self.assertEqual(attempts[0]['tags']['tags'], ['demo-3d-services'])
                self.assertTrue(attempts[0]['focus']['focused'])
                self.assertIn('interaction.object.translate', attempts[1]['tags']['tags'])
                self.assertEqual(attempts[1]['capabilities']['capabilities'], ['navigation'])
                self.assertFalse(attempts[1]['focus']['focused'])
            finally:
                await integration.stop()
            self.assertTrue(integration.networking.done())
            self.assertFalse(integration._metadata_tasks)
            self.assertEqual(integration.client.state.value, 'disconnected')
            self.assertIsNone(app.operation)

    async def test_shutdown_before_networking_starts(self):
        integration = MyOpenAxisIntegration(self.make_app())
        await integration.start()
        await integration.stop()
        self.assertTrue(integration.networking.cancelled())
        self.assertFalse(integration._metadata_tasks)

    async def test_metadata_events_schedule_nothing_offline(self):
        app = self.make_app()
        integration = MyOpenAxisIntegration(app)
        await integration.start()
        try:
            app.on_focus_changed()
            app.begin_object_edit(0)
            app.finish_object_edit()
            self.assertFalse(integration._metadata_tasks)
        finally:
            await integration.stop()

    async def test_connected_metadata_is_event_driven(self):
        from unittest.mock import AsyncMock
        from openaxis.connection_manager import ConnectionManagerState
        app = self.make_app()
        integration = MyOpenAxisIntegration(app)
        await integration.start()
        integration.networking.cancel()
        await asyncio.gather(integration.networking, return_exceptions=True)
        integration.connection.state = ConnectionManagerState.READY
        refresh = integration.connection.refresh_metadata = AsyncMock()
        try:
            await asyncio.sleep(.05)
            refresh.assert_not_called()
            app.on_focus_changed()
            await asyncio.sleep(0)
            self.assertEqual(refresh.await_count, 1)
            app.begin_object_edit(0)
            await asyncio.sleep(0)
            self.assertEqual(refresh.await_count, 2)
            app.free_camera = True
            app.on_navigation_changed()
            await asyncio.sleep(0)
            self.assertEqual(refresh.await_count, 3)
            self.assertEqual(integration._tags(), ['demo-3d-services', 'navigation.hint.free_camera',
                'interaction.object.rotate', 'interaction.object.translate'])
            app.free_camera = False
            app.on_navigation_changed()
            await asyncio.sleep(0)
            self.assertEqual(refresh.await_count, 4)
            self.assertIn('demo-3d-services', integration._tags())
            self.assertNotIn('navigation.hint.free_camera', integration._tags())
            app.finish_object_edit()
            await asyncio.sleep(0)
            self.assertEqual(refresh.await_count, 5)
        finally:
            await integration.stop()
        app.on_focus_changed()
        self.assertFalse(integration._metadata_tasks)


async def gui_test():
    app = MyApplication(FIXTURE)
    if sys.platform == 'win32':
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.WinDLL('user32')
        user32.SendMessageW.argtypes = [wintypes.HWND,wintypes.UINT,wintypes.WPARAM,wintypes.LPARAM]
        user32.SendMessageW.restype = ctypes.c_ssize_t

        def wheel(delta):
            user32.SendMessageW(app._native_wheel.hwnd,0x020A,(delta & 0xffff) << 16,0)
            app.pump_events()

        # Real window messages: fractions, signs and multi-notch magnitude must
        # survive Panda's input pipeline without duplicate button-based zoom.
        for camera in (MyCamera(),MyCamera(vertical_fov=None,vertical_span=8)):
            app.set_camera(camera)
            wheel(15)
            fractional = app.get_camera()
            app.set_camera(camera)
            app.mouse_zoom(.125)
            assert app.get_camera() == fractional
            app.set_camera(camera)
            for _ in range(8):
                wheel(15)
            split = app.get_camera()
            app.set_camera(camera)
            wheel(120)
            whole = app.get_camera()
            assert all(abs(a-b) < 1e-5 for a,b in zip(split.position,whole.position))
            if whole.vertical_span is not None:
                assert abs(split.vertical_span-whole.vertical_span) < 1e-6
            for delta in (-15,-240,240,0):
                app.set_camera(camera)
                wheel(delta)
                actual = app.get_camera()
                app.set_camera(camera)
                app.mouse_zoom(delta/120)
                assert app.get_camera() == actual
        app.set_camera(MyCamera())
        app.begin_object_edit(0)
        wheel(15)
        actual = app.get_object_pose(0)
        app.finish_object_edit(False)
        app.begin_object_edit(0)
        app.mouse_edit_object(wheel=.125)
        assert app.get_object_pose(0) == actual
        app.finish_object_edit(False)
    # Exercise the actual modified event bindings without desktop input injection.
    original_cursor = app.get_cursor_position
    app.get_cursor_position = lambda: (450,300)
    prefixes = ('','shift-','control-','alt-','meta-','shift-meta-',
                'shift-control-alt-meta-')
    for prefix in prefixes:
        for button in ('mouse2','mouse3'):
            app.base.messenger.send(prefix+button)
            assert app._drag is not None, prefix+button+' did not start drag'
            # A modifier can be released or pressed before the mouse button.
            for release_prefix in prefixes:
                app.base.messenger.send(prefix+button)
                app.base.messenger.send(release_prefix+button+'-up')
                assert app._drag is None, release_prefix+button+' did not end drag'
        camera = app.get_camera()
        app.base.messenger.send(prefix+'wheel_up')
        assert app.get_camera() != camera, prefix+'wheel did not zoom'
        app.set_camera(camera)
    app.base.messenger.send('mouse1')
    assert app.selected == 0 and app.operation is None, 'single click must only select'
    app.base.messenger.send('enter')
    assert app.operation is not None, 'Enter must start editing selection'
    assert tuple(app.models[0].get_color()) != (1,.85,.3,1)
    assert not app.edit_label.is_hidden()
    for prefix in prefixes:
        app.base.messenger.send(prefix+'mouse2')
        assert app._drag is not None
        app.base.messenger.send(prefix+'mouse2-up')
        assert app._drag is None
        app.mouse_edit_object(dx=20,pan=True)
        app.base.messenger.send(prefix+'mouse3')
        assert app.operation is not None
        app.base.messenger.send(prefix+'mouse3-up')
        assert app.operation is None and app.get_object_pose(0).position == (0,0,0)
        assert app.edit_label.is_hidden()
        app.begin_object_edit(0)
        app.mouse_edit_object(dx=20,pan=True)
        accepted = app.get_object_pose(0)
        app.base.messenger.send(prefix+'mouse1')
        assert app.operation is not None
        app.base.messenger.send(prefix+'mouse1-up')
        assert app.operation is None and app.get_object_pose(0) == accepted
        assert app.edit_label.is_hidden()
        app.undo_object_edit()
        app.begin_object_edit(0)
    app.mouse_edit_object(dx=20,pan=True)
    assert app.get_object_pose(0).position[0] > 0
    app.base.messenger.send('escape')
    assert app.operation is None and app.get_object_pose(0).position == (0,0,0)
    app._last_click = None
    from types import SimpleNamespace
    original_watcher,original_focus = app.base.mouseWatcherNode,app.has_focus
    app.has_focus = lambda: True
    for button in ('mouse1','mouse2','mouse3'):
        for shift in (False,True):
            app.begin_object_edit(0)
            app.get_cursor_position = lambda: (450,300)
            app.base.mouseWatcherNode = SimpleNamespace(is_button_down=lambda key: shift)
            app.base.messenger.send(button)
            app.get_cursor_position = lambda: (470,310)
            app._update_frame(SimpleNamespace(cont=None))
            pose = app.get_object_pose(0)
            translates = (button == 'mouse1') != shift
            assert (pose.position != (0,0,0)) == translates
            assert (pose.rotation != (0,0,0)) != translates
            app.base.messenger.send(button+'-up')
            assert app.operation is not None, 'drag release must not accept or cancel'
            app.finish_object_edit(False)
    app.base.mouseWatcherNode,app.has_focus = original_watcher,original_focus
    app.get_cursor_position = lambda: (450,300)
    app.base.messenger.send('mouse1')
    app.base.messenger.send('mouse1')
    assert app.operation is not None, 'double click must start editing selection'
    app.base.messenger.send('enter')
    assert app.operation is None, 'Enter must accept active edit'
    app.get_cursor_position = original_cursor
    done = asyncio.get_running_loop().create_future()

    async def server(socket):
        async def send(message):
            await socket.send(msgpack.packb(message, use_bin_type=True))
        try:
            app.toggle_diagnostics()
            hello = msgpack.unpackb(await socket.recv(), raw=False)
            assert hello['type'] == 'hello'
            assert hello['target'] == {'pid': current_process_id(), 'app': 'python-demo-3d-app'}
            await send(dict(type='hello_ack', proto='openaxis/1.0', server_name='viewer-test'))
            await send(dict(type='motion_start', gesture_id=1))
            await send(dict(type='request', id=1, method='navigation.query',
                params=dict(gesture_id=1, values=['camera.pose','viewport.aspect'], first=['pick.viewport_center'])))
            while True:
                reply = msgpack.unpackb(await socket.recv(), raw=False)
                if reply['type'] == 'response':
                    assert reply['result']['first']['name'] == 'pick.viewport_center'
                    break
            await send(dict(type='camera.pivot', gesture_id=1, point=[0,0,1]))
            await send(dict(type='camera.pose', gesture_id=1, seq=1, t=[1,0,10], r=[0,0,0], fov=1.0))
            for _ in range(120):
                await asyncio.sleep(1/60)
                if app.camera.position == (1,0,10) and not app.marker.is_hidden():
                    break
            assert app.camera.position == (1,0,10), app.camera
            assert not app.marker.is_hidden(), 'marker was not drawn'
            assert len(app.models) == 3
            assert app.diagnostic_frame().lines, "SDK diagnostic presentation is empty"
            assert app._diagnostic_nodes, "diagnostic renderer did not run"
            from pathlib import Path
            from panda3d.core import Filename
            output = Path(__file__).resolve().parents[2] / '.astro' / 'viewer-preview.png'
            output.parent.mkdir(exist_ok=True)
            app.base.graphics_engine.render_frame()
            assert app.base.win.save_screenshot(Filename.from_os_specific(str(output)))
            # Orthographic projection must still render the blue fixture object.
            from panda3d.core import PNMImage
            saved_camera = app.get_camera()
            app.toggle_projection()
            app.pump_events()
            x,y = app.project((.4,.3,1))[:2]
            app.base.graphics_engine.render_frame()
            pixels = PNMImage()
            assert app.base.win.get_screenshot(pixels)
            color = pixels.get_xel(int(x),int(y))
            assert color[2] > .5 and color[1] > .3, ('orthographic object missing', color)
            app.set_camera(saved_camera)
            # The same world-space overlay must cover both background and objects.
            from types import SimpleNamespace
            from panda3d.core import PNMImage
            original_frame, original_colors = app.diagnostic_frame, app.diagnostic_colors
            try:
                app.diagnostic_colors = dict(original_colors, overlay_test=(255, 0, 255))
                app.diagnostic_frame = lambda: SimpleNamespace(
                    revision=-1, expires_at=None, context=app, lines=[], markers=[],
                    segments=[SimpleNamespace(start=(-5,0,-2), end=(7,0,-2),
                                              tone='overlay_test', width=5, opacity=1)])
                app._draw_diagnostics()
                app.base.graphics_engine.render_frame()
                pixels = PNMImage()
                assert app.base.win.get_screenshot(pixels)
                for point in ((-4,0,-2), (0,0,-2)):
                    x,y = app.project(point)[:2]
                    colors = [pixels.get_xel(int(x)+dx,int(y)+dy)
                              for dx in range(-2,3) for dy in range(-2,3)]
                    assert any(c[0] > .9 and c[1] < .1 and c[2] > .9 for c in colors), (
                        'world diagnostic overlay hidden by background or geometry', point)
            finally:
                app.diagnostic_frame, app.diagnostic_colors = original_frame, original_colors
                app._draw_diagnostics()
            # Native camera motion during the gesture must survive acknowledgement.
            app.mouse_navigate(15,0,(0,0,0),pan=True)
            native_camera = app.get_camera()
            app.on_camera_changed()
            while True:
                reply = msgpack.unpackb(await socket.recv(),raw=False)
                if reply['type'] == 'camera.delta':
                    assert abs(reply['t'][0]) > .01
                    camera_delta = reply['delta_id']
                    break
            await send(dict(type='camera.pose',gesture_id=1,seq=2,
                t=list(native_camera.position),r=list(native_camera.rotation),fov=1.,applied_delta_id=camera_delta))
            await asyncio.sleep(.05)
            assert app.get_camera().position == native_camera.position
            await send(dict(type='motion_end', gesture_id=1))
            for _ in range(120):
                await asyncio.sleep(1/60)
                if app.pivot is None:
                    break
            assert app.pivot is None, 'gesture cleanup did not hide marker'
            # Object stream uses the actual SDK adapter and application transaction.
            app.begin_object_edit(0)
            await send(dict(type='motion_start',gesture_id=2))
            await send(dict(type='request',id=2,method='navigation.query',
                params=dict(gesture_id=2,values=['object.pose','object.bounds'])))
            while True:
                reply = msgpack.unpackb(await socket.recv(),raw=False)
                if reply['type'] == 'response' and reply['id'] == 2:
                    assert reply['result']['values']['object.pose']['t'] == [0,0,0]
                    break
            await send(dict(type='object.pose',gesture_id=2,seq=1,t=[2,0,0],r=[0,0,0]))
            for _ in range(120):
                await asyncio.sleep(1/60)
                if app.get_object_pose(0).position == (2,0,0):
                    break
            assert app.get_object_pose(0).position == (2,0,0)
            app.mouse_edit_object(dx=20,pan=True)
            expected_delta = app.get_object_pose(0).position[0]-2
            while True:
                reply = msgpack.unpackb(await socket.recv(),raw=False)
                if reply['type'] == 'object.delta':
                    assert abs(reply['t'][0]-expected_delta) < 1e-5
                    delta_id = reply['delta_id']
                    break
            await send(dict(type='object.pose',gesture_id=2,seq=2,t=[3,0,0],r=[0,0,0],applied_delta_id=delta_id))
            for _ in range(120):
                await asyncio.sleep(1/60)
                if app.get_object_pose(0).position == (3,0,0):
                    break
            assert app.get_object_pose(0).position == (3,0,0)
            await send(dict(type='motion_end',gesture_id=2))
            await asyncio.sleep(.05)
            assert app.operation is not None, 'gesture end must leave native operation active'
            app.finish_object_edit(False)
            assert app.get_object_pose(0).position == (0,0,0)
            app.request_close()
            done.set_result(None)
            await socket.wait_closed()
        except Exception as error:
            app.request_close()
            if not done.done():
                done.set_exception(error)

    async with serve(server,'127.0.0.1',0) as endpoint:
        port = endpoint.sockets[0].getsockname()[1]
        integration = MyOpenAxisIntegration(app, f'ws://127.0.0.1:{port}')
        await asyncio.wait_for(app.run(on_started=integration.start, on_stopping=integration.stop),10)
        await done
    print('PASS: native selection/edit controls, camera and object protocol, object correction acknowledgement, diagnostics and cleanup')


if __name__ == '__main__':
    if '--gui' in sys.argv:
        asyncio.run(gui_test())
    else:
        unittest.main()
