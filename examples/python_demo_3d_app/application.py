"""Panda3D stand-in application for the OpenAxis walkthrough.

Panda owns rendering, projection, scene transforms and collision picking.
The adapter sees only the small application API below. Y up, camera forward -Z.
"""
from dataclasses import dataclass, replace
from itertools import product
from time import monotonic
from math import atan2, hypot, atan, cos, degrees, pi, sin, tan
import sys
import json
from pathlib import Path

SCENE = json.loads((Path(__file__).resolve().parent.parent / "demo_3d_scene/scene.json").read_text())
from panda3d.core import (
    AmbientLight, DirectionalLight, BitMask32, Camera as PandaCamera, CollisionHandlerQueue,
    CollisionNode, CollisionPolygon, CollisionRay, CollisionTraverser, KeyboardButton, LineSegs, Geom, GeomNode, GeomTriangles, GeomVertexData, GeomVertexFormat, GeomVertexWriter,
    ModifierButtons, NodePath, OrthographicLens, PerspectiveLens, Point2, Point3, Quat, Vec3,
    WindowProperties, loadPrcFileData, DepthTestAttrib, RenderAttrib, TransparencyAttrib,
)

loadPrcFileData('', 'coordinate-system y-up-right\naudio-library-name null\nsync-video false')


def quaternion(rotation):
    vector = Vec3(*rotation)
    result = Quat.ident_quat()
    if vector.length() > 1e-10:
        result = Quat()
        result.set_from_axis_angle_rad(vector.length(), vector.normalized())
    return result


def rotation_vector(q):
    # atan2 preserves small rotations that acos(q.w) loses with float32 quaternions.
    vector = (float(q.get_i()),float(q.get_j()),float(q.get_k()))
    scalar = float(q.get_r())
    if scalar < 0:
        vector,scalar = tuple(-x for x in vector),-scalar
    length = hypot(*vector)
    return tuple(x*(2*atan2(length,scalar)/length) for x in vector) if length else (0.,0.,0.)


def rotate(vector, rotation):
    return tuple(quaternion(rotation).xform(Vec3(*vector)))


@dataclass(frozen=True)
class MyCamera:
    position: tuple = tuple(SCENE["camera"]["t"])
    rotation: tuple = tuple(SCENE["camera"]["r"])
    vertical_fov: float | None = SCENE["camera"]["fov"]
    vertical_span: float | None = None


@dataclass(frozen=True)
class MyShape:
    minimum: tuple
    maximum: tuple
    color: tuple


@dataclass(frozen=True)
class MyObjectPose:
    position: tuple
    rotation: tuple = (0., 0., 0.)


@dataclass(eq=False)
class MyObjectOperation:
    index: int
    initial: MyObjectPose


class MyScene:
    """Application API. Panda's scene/collision graph also works without a window."""
    def __init__(self, scene_data=None):
        self.scene_data = scene_data or SCENE
        ground = self.scene_data['ground']
        extent = ground['size']/2
        self.ground_corners = tuple((x,ground['y'],z) for x,z in
                                    ((-extent,-extent),(extent,-extent),(extent,extent),(-extent,extent)))
        self.scene = NodePath('example-scene')
        self.camera_node = self.scene.attach_new_node(PandaCamera('example-camera'))
        self.size = (900,600)
        self.pivot = self.selected = None
        self.object_pivot = None
        self.alive = True
        self._diagnostic_world_points = ()
        self.shapes = tuple(MyShape(tuple(item['min']),tuple(item['max']),
                                  tuple(((item['color'] >> shift) & 255)/255 for shift in (16,8,0))+(1,))
                           for item in self.scene_data['objects'])
        self.initial_poses = tuple(MyObjectPose(tuple(item['position']),tuple(item['rotation']))
                                   for item in self.scene_data['objects'])
        self.operation = None
        self.undo_stack = []
        self.on_operation_changed = lambda: None
        self.free_camera = False
        self.on_navigation_changed = lambda: None
        self.on_focus_changed = lambda: None
        self.on_object_changed = lambda: None
        self.object_nodes = []
        for index, box in enumerate(self.shapes):
            item = self.scene_data['objects'][index]
            target = self.scene.attach_new_node('object-'+str(index))
            target.set_pos(*item['position'])
            target.set_quat(quaternion(item['rotation']))
            self.object_nodes.append(target)
            node = CollisionNode(str(index))
            points = [Point3(*item['vertices'][i:i+3]) for i in range(0,len(item['vertices']),3)]
            for i in range(0,len(item['indices']),3):
                a,b,c = (points[j] for j in item['indices'][i:i+3])
                if (b-a).cross(c-a).length_squared() > 1e-16:
                    node.add_solid(CollisionPolygon(a,b,c))
            node.set_into_collide_mask(BitMask32.bit(1))
            node.set_from_collide_mask(BitMask32.all_off())
            target.attach_new_node(node).set_python_tag('index',index)
        ground = CollisionNode('ground-pick')
        for corners in (self.ground_corners,self.ground_corners[::-1]):
            ground.add_solid(CollisionPolygon(*[Point3(*p) for p in corners]))
        ground.set_into_collide_mask(BitMask32.bit(1))
        ground.set_from_collide_mask(BitMask32.all_off())
        self.scene.attach_new_node(ground).set_python_tag('index',None)
        self.ray = CollisionRay()
        picker = CollisionNode('picker')
        picker.add_solid(self.ray)
        picker.set_from_collide_mask(BitMask32.bit(1))
        picker.set_into_collide_mask(BitMask32.all_off())
        self.picker = self.camera_node.attach_new_node(picker)
        self.hits = CollisionHandlerQueue()
        self.traverser = CollisionTraverser()
        self.traverser.add_collider(self.picker,self.hits)
        self.set_camera(MyCamera(tuple(self.scene_data["camera"]["t"]),tuple(self.scene_data["camera"]["r"]),self.scene_data["camera"]["fov"]))

    @property
    def camera(self):
        return self.get_camera()

    @camera.setter
    def camera(self, value):
        self.set_camera(value)

    def get_camera(self):
        q = self.camera_node.get_quat()
        rotation = rotation_vector(q)
        return MyCamera(tuple(self.camera_node.get_pos()),tuple(rotation),
                      self._camera.vertical_fov,self._camera.vertical_span)

    def set_camera(self, camera):
        self._camera = camera
        self.camera_node.set_pos(*camera.position)
        self.camera_node.set_quat(quaternion(camera.rotation))
        self._update_lens()

    def _update_lens(self):
        camera, aspect = self._camera,self.size[0]/self.size[1]
        if camera.vertical_span is not None:
            lens = OrthographicLens()
            lens.set_film_size(camera.vertical_span*aspect,camera.vertical_span)
        else:
            lens = PerspectiveLens()
            lens.set_fov(degrees(2*atan(tan(camera.vertical_fov/2)*aspect)),degrees(camera.vertical_fov))
        if camera.vertical_span is not None:
            # Orthographic eyes can pass through the model without changing its
            # apparent scale. Include model and diagnostic depth on both sides.
            depths = [-self.camera_node.get_relative_point(self.scene,Point3(*corner)).z
                      for index in range(len(self.shapes))
                      for corner in product(*zip(*self.object_bounds(index)))]
            depths.extend(-self.camera_node.get_relative_point(self.scene,Point3(*point)).z
                          for point in self._diagnostic_world_points)
            depths.extend(-self.camera_node.get_relative_point(self.scene,Point3(*point)).z
                          for point in self.ground_corners)
            margin = max(1., (max(depths)-min(depths))*.1)
            lens.set_near_far(min(depths)-margin,max(depths)+margin)
        else:
            lens.set_near_far(.01,10000)
        self.camera_node.node().set_lens(lens)

    def get_viewport_size(self):
        return self.size

    def pick_ray(self, pixel, hit=None):
        """The same viewport ray used for picking, in world coordinates."""
        self.ray.set_from_lens(self.camera_node.node(),2*pixel[0]/self.size[0]-1,1-2*pixel[1]/self.size[1])
        origin = self.scene.get_relative_point(self.camera_node,self.ray.get_origin())
        direction = self.scene.get_relative_vector(self.camera_node,self.ray.get_direction()).normalized()
        end = Point3(*hit) if hit is not None else origin+direction*self.camera_node.node().get_lens().get_far()
        return tuple(origin),tuple(end)

    def set_pivot_marker(self, point, object_marker=False):
        if object_marker:
            self.object_pivot = point
        else:
            self.pivot = point

    def get_object_pose(self, index):
        node = self.object_nodes[index]
        q = node.get_quat()
        rotation = rotation_vector(q)
        return MyObjectPose(tuple(node.get_pos()),tuple(rotation))

    def set_object_pose(self, index, pose):
        self.object_nodes[index].set_pos(*pose.position)
        self.object_nodes[index].set_quat(quaternion(pose.rotation))

    def object_bounds(self, index):
        box = self.shapes[index]
        corners = [self.scene.get_relative_point(self.object_nodes[index],Point3(*p))
                   for p in product(*zip(box.minimum,box.maximum))]
        return (tuple(min(p[i] for p in corners) for i in range(3)),
                tuple(max(p[i] for p in corners) for i in range(3)))

    def get_bounds(self, selection_only=False):
        indices = range(len(self.shapes)) if not selection_only else (() if self.selected is None else (self.selected,))
        bounds = [self.object_bounds(index) for index in indices]
        return None if not bounds else (
            tuple(min(b[0][i] for b in bounds) for i in range(3)),
            tuple(max(b[1][i] for b in bounds) for i in range(3)))

    def begin_object_edit(self, index):
        if self.operation is not None:
            self.finish_object_edit(False)
        self.selected = index
        self.operation = MyObjectOperation(index,self.get_object_pose(index))
        self.on_operation_changed()

    def mouse_edit_object(self, dx=0, dy=0, pan=False, wheel=0):
        if self.operation is None:
            return
        node = self.object_nodes[self.operation.index]
        camera = self.get_camera()
        camera_rotation = self.camera_node.get_quat()
        depth = -self.camera_node.get_relative_point(self.scene,node.get_pos()).z
        span = camera.vertical_span or 2*max(.01,depth)*tan(camera.vertical_fov/2)
        if pan or wheel:
            offset = Vec3(dx*span/self.size[1],-dy*span/self.size[1],-wheel*span*.08)
            node.set_pos(node.get_pos()+camera_rotation.xform(offset))
        else:
            delta = quaternion(tuple(camera_rotation.xform(Vec3(dy*.006,dx*.006,0))))
            orientation = node.get_quat()*delta
            orientation.normalize()
            node.set_quat(orientation)
        self.on_object_changed()

    def finish_object_edit(self, accept=True):
        operation = self.operation
        if operation is None:
            return
        self._drag = None
        self.operation = None  # Retire the target before notifying the integration.
        if accept:
            self.undo_stack.append((operation.index,operation.initial))
        else:
            self.set_object_pose(operation.index,operation.initial)
        self.selected = None
        self.on_operation_changed()

    def undo_object_edit(self):
        if self.operation is not None:
            self.finish_object_edit(False)
        elif self.undo_stack:
            index,pose = self.undo_stack.pop()
            self.set_object_pose(index,pose)

    def project(self, point):
        self._update_lens()
        local = self.camera_node.get_relative_point(self.scene,Point3(*point))
        result = Point2()
        if not self.camera_node.node().get_lens().project(local,result):
            return None
        return ((result.x+1)*self.size[0]/2,(1-result.y)*self.size[1]/2,-local.z)

    def pick(self, pixel, selection_only=False, objects_only=False):
        if pixel is None or not (0 <= pixel[0] < self.size[0] and 0 <= pixel[1] < self.size[1]):
            return None
        self._update_lens()
        self.ray.set_from_lens(self.camera_node.node(),2*pixel[0]/self.size[0]-1,1-2*pixel[1]/self.size[1])
        self.hits.clear_entries()
        self.traverser.traverse(self.scene)
        self.hits.sort_entries()
        for hit in self.hits.entries:
            index = hit.get_into_node_path().get_python_tag('index')
            if index is None:
                if selection_only or objects_only:
                    continue
                bounds = tuple(tuple(fn(p[i] for p in self.ground_corners) for i in range(3))
                               for fn in (min,max))
                return None,tuple(hit.get_surface_point(self.scene)),MyShape(*bounds,(.14,.18,.23,1))
            if not selection_only or index == self.selected:
                bounds = self.object_bounds(index)
                return index,tuple(hit.get_surface_point(self.scene)),MyShape(*bounds,self.shapes[index].color)
        return None

    def mouse_zoom(self, steps):
        camera = self.get_camera()
        factor = 0.85 ** steps  # Positive wheel steps zoom in.
        if camera.vertical_span is not None:
            self.set_camera(replace(camera,vertical_span=max(.01,min(10000.,camera.vertical_span*factor))))
        else:
            bounds = self.get_bounds(True) or self.get_bounds()
            center = Point3(*[(a+b)/2 for a,b in zip(*bounds)])
            depth = -self.camera_node.get_relative_point(self.scene,center).z
            distance = max(.02,depth)
            offset = self.camera_node.get_quat().xform(Vec3(0,0,distance*(factor-1)))
            self.set_camera(replace(camera,position=tuple(self.camera_node.get_pos()+offset)))

    def mouse_navigate(self, dx, dy, center, pan=False):
        # Increment the latest camera, including intervening SDK writes.
        camera, center = self.get_camera(),Vec3(*center)
        q = self.camera_node.get_quat()
        if pan:
            depth = -self.camera_node.get_relative_point(self.scene,Point3(center)).z
            span = camera.vertical_span or 2*max(.01,depth)*tan(camera.vertical_fov/2)
            offset = q.xform(Vec3(-dx,dy,0)*span/self.size[1])
            self.camera_node.set_pos(self.camera_node.get_pos()+offset)
            return tuple(center+offset)
        delta = quaternion(tuple(q.xform(Vec3(-dy*.006,-dx*.006,0))))
        self.camera_node.set_pos(center+delta.xform(self.camera_node.get_pos()-center))
        # Panda quaternion products apply the left rotation first.
        orientation = q*delta
        orientation.normalize()
        self.camera_node.set_quat(orientation)
        return tuple(center)


class MyApplication(MyScene):
    def __init__(self, scene_data=None):
        from direct.showbase.ShowBase import ShowBase
        from direct.showbase.DirectObject import DirectObject
        from direct.gui.OnscreenText import OnscreenText
        super().__init__(scene_data)
        self.base = ShowBase()
        self.base.disable_mouse()
        self.base.set_background_color(20/255,31/255,46/255)
        props = WindowProperties()
        props.set_title('OpenAxis Python demo 3D app - stand-in 3D application')
        props.set_size(960,720)
        self.base.win.request_properties(props)
        self.scene.reparent_to(self.base.render)
        self.base.cam.node().set_active(False)
        self.base.cam.node().get_display_region(0).set_camera(self.camera_node)
        ambient = AmbientLight('ambient')
        ambient.set_color((.45,.45,.45,1))
        self.scene.set_light(self.scene.attach_new_node(ambient))
        sun = DirectionalLight('sun')
        sun.set_color((.7,.7,.7,1))
        sun_node = self.scene.attach_new_node(sun)
        sun_node.set_hpr(-30,-45,0)
        self.scene.set_light(sun_node)
        self._create_ground()
        self.models = []
        for index,box in enumerate(self.shapes):
            item = self.scene_data['objects'][index]
            vertices = GeomVertexData(item['name'],GeomVertexFormat.get_v3n3(),Geom.UH_static)
            position,normal = GeomVertexWriter(vertices,'vertex'),GeomVertexWriter(vertices,'normal')
            for i in range(0,len(item['vertices']),3):
                position.add_data3(*item['vertices'][i:i+3])
                normal.add_data3(*item['normals'][i:i+3])
            triangles = GeomTriangles(Geom.UH_static)
            for i in range(0,len(item['indices']),3):
                triangles.add_vertices(*item['indices'][i:i+3]); triangles.close_primitive()
            geometry = Geom(vertices); geometry.add_primitive(triangles)
            node = GeomNode(item['name']); node.add_geom(geometry)
            model = self.object_nodes[index].attach_new_node(node)
            model.set_color(*box.color)
            model.set_collide_mask(BitMask32.all_off())
            self.models.append(model)
        # Camera-facing world geometry: opaque in front, faint behind the scene.
        vertices = GeomVertexData('pivot',GeomVertexFormat.get_v3(),Geom.UH_static)
        writer = GeomVertexWriter(vertices,'vertex')
        writer.add_data3(0,0,0)
        for i in range(33):
            writer.add_data3(cos(i*pi/16),sin(i*pi/16),0)
        triangles = GeomTriangles(Geom.UH_static)
        for i in range(1,33):
            triangles.add_vertices(0,i,i+1)
            triangles.close_primitive()
        geometry = Geom(vertices)
        geometry.add_primitive(triangles)
        node = GeomNode('pivot')
        node.add_geom(geometry)
        ring_data = GeomVertexData('pivot-rim',GeomVertexFormat.get_v3(),Geom.UH_static)
        ring_writer = GeomVertexWriter(ring_data,'vertex')
        ring_triangles = GeomTriangles(Geom.UH_static)
        for i in range(33):
            for radius in (1., 5.5/4):
                ring_writer.add_data3(radius*cos(i*pi/16),radius*sin(i*pi/16),0)
        for i in range(32):
            j = 2*i
            ring_triangles.add_vertices(j,j+1,j+3)
            ring_triangles.add_vertices(j,j+3,j+2)
        ring_geom = Geom(ring_data)
        ring_geom.add_primitive(ring_triangles)
        ring_node = GeomNode('pivot-rim')
        ring_node.add_geom(ring_geom)
        self.marker = self.scene.attach_new_node('pivot')
        self.marker.set_collide_mask(BitMask32.all_off())
        self.marker.set_light_off(1)
        self.marker.set_two_sided(True)
        self.marker.set_depth_write(False)
        for hidden in (False, True):
            layer = self.marker.attach_new_node('occluded' if hidden else 'visible')
            layer.set_attrib(DepthTestAttrib.make(RenderAttrib.M_greater if hidden else RenderAttrib.M_less_equal))
            layer.set_transparency(TransparencyAttrib.M_alpha)
            layer.set_bin('fixed',101 if hidden else 100)
            alpha = .2 if hidden else 1.
            layer.attach_new_node(node.make_copy()).set_color(0,1,0,alpha)
            layer.attach_new_node(ring_node.make_copy()).set_color(0,0,0,alpha)
        self.marker.set_collide_mask(BitMask32.all_off())
        self.marker.hide()
        self.object_marker = self.marker.copy_to(self.scene)
        self.label = OnscreenText(text='',pos=(-1.25,-.94),scale=.04,fg=(1,1,1,1),align=0,mayChange=True)
        self._connection_status = 'Connecting...'
        self.edit_label = OnscreenText(text='EDITING OBJECT',
                     pos=(-1.25,.91),scale=.05,fg=(1,.35,.85,1),align=0)
        self.mouse_help = OnscreenText(text='',
                     pos=(-.95,.82),scale=.044,fg=(1,1,1,1),align=0,mayChange=True,wordwrap=48)
        self.keyboard_help = OnscreenText(text='',
                     pos=(-.95,.68),scale=.044,fg=(1,1,1,1),align=0,mayChange=True,wordwrap=48)
        self.help_headings = [OnscreenText(text=title,pos=(-1.25,y),scale=.048,
                             fg=(.4,.8,1,1),align=0)
                              for title,y in (('MOUSE',.82),('KEYBOARD',.68),('ROTATRIX:',.57))]
        activation_key = 'Ctrl' if sys.platform == 'darwin' else 'Win' if sys.platform == 'win32' else 'Super'
        self.rotatrix_help = OnscreenText(
                     text=f'{activation_key} activates camera control (if not remapped)',
                     pos=(-.95,.57),scale=.044,fg=(1,1,1,1),align=0,mayChange=True)
        controls_font = self.mouse_help.textNode.get_font().make_copy()
        controls_font.set_line_height(1.35)
        for text in (self.mouse_help, self.keyboard_help, self.rotatrix_help):
            text.textNode.set_font(controls_font)
        self._update_object_appearance()
        self.on_camera_changed = lambda: None
        self.toggle_diagnostics = lambda: None
        self.diagnostic_frame = lambda: None
        self.diagnostics_enabled = lambda: False
        self.diagnostic_colors = {}
        self._diagnostic_key = None
        self._diagnostic_nodes = []
        self._drag = None
        self._edit_click = None
        self._last_click = None
        self._native_wheel = None
        if sys.platform == 'win32':
            from native_wheel import NativeWheel
            self._native_wheel = NativeWheel(self.base.win)
        # Panda prefixes mouse events with held modifiers, including Rotatrix's
        # activation key. Use its configured order to cover every combination.
        modifiers = ModifierButtons(self.base.buttonThrowers[0].node().get_modifier_buttons())
        for held in product((False,True),repeat=modifiers.get_num_buttons()):
            modifiers.all_buttons_up()
            for index,down in enumerate(held):
                if down:
                    modifiers.button_down(modifiers.get_button(index))
            prefix = modifiers.get_prefix()
            for button,handler in (('mouse1',self._select),('mouse2',self._begin_drag),('mouse3',self._right_click)):
                self.base.accept(prefix+button,handler)
                self.base.accept(prefix+button+'-up',self._release_drag,[button])
            self.base.accept(prefix+'wheel_up',self._zoom,[1])
            self.base.accept(prefix+'wheel_down',self._zoom,[-1])
        self.base.accept('d',lambda: self.toggle_diagnostics())
        self.base.accept('enter',self._edit_or_accept)
        self.base.accept('escape',self.finish_object_edit,[False])
        self.base.accept('u',self.undo_object_edit)
        self.base.accept('r',self.reset_scene)
        self.base.accept('o',self.toggle_projection)
        self.base.accept('f',self.toggle_navigation)
        self.base.userExit = self.request_close
        # Listen independently so ShowBase keeps its own window-event handler.
        self._focused = self.has_focus()
        self._window_events = DirectObject()
        self._window_events.accept('window-event', self._window_changed)
        # After input events, before Panda's render task (sort 50).
        self.base.task_mgr.add(self._update_frame,'viewer-update',sort=45)

    def _create_ground(self):
        # Fixed world-space reference in the XZ plane (Y is up).
        self.ground = self.scene.attach_new_node('ground-grid')
        self.ground.set_light_off(1)
        self.ground.set_collide_mask(BitMask32.all_off())
        grid = LineSegs('ground-grid')
        grid.set_thickness(1)
        ground = self.scene_data['ground']
        extent,height = int(ground['size']/2),ground['y']
        for coordinate in range(-extent,extent+1,int(ground['step'])):
            grid.set_color(*((.42,.48,.56,1) if coordinate in (-extent,0,extent) else (.24,.30,.37,1)))
            grid.move_to(coordinate,height,-extent)
            grid.draw_to(coordinate,height,extent)
            grid.move_to(-extent,height,coordinate)
            grid.draw_to(extent,height,coordinate)
        self.ground.attach_new_node(grid.create())

    def set_status(self,text):
        self._connection_status = text
        self._update_status()

    def toggle_navigation(self):
        self.free_camera = not self.free_camera
        self.on_navigation_changed()
        self._update_status()

    def _update_status(self):
        projection = 'Orthographic' if self._camera.vertical_span is not None else 'Perspective'
        diagnostics = 'On' if self.diagnostics_enabled() else 'Off'
        key = ('Cmd' if self.free_camera else 'Ctrl') if sys.platform == 'darwin' else 'Win' if sys.platform == 'win32' else 'Super'
        self.rotatrix_help.setText(
            f"{self._connection_status}\n{key} activates camera control (if not remapped)\n"
            f"F: Nav mode ({'Free Camera' if self.free_camera else 'Orbit'})    D: Diagnostics ({diagnostics})")
        controls = 'Enter: Accept    Esc: Cancel    R: Reset scene' if self.operation else 'Enter: Edit selection    U: Undo    R: Reset scene'
        self.keyboard_help.setText(f'{controls}    O: Projection ({projection})')

    def _update_object_appearance(self):
        for index,model in enumerate(self.models):
            editing = self.operation is not None and self.operation.index == index
            model.set_color(*((1,.25,.75,1) if editing else
                              (1,.85,.3,1) if index == self.selected else self.shapes[index].color))
        if self.operation is not None:
            self.edit_label.show()
            self.mouse_help.setText('Left-click: Accept    Right-click: Cancel\n'
                                    'Left-drag: Translate    Middle/Right-drag: Rotate (Shift to swap)    Wheel: Depth')
        else:
            self.edit_label.hide()
            self.mouse_help.setText('Click: Select    Double-click: Edit\n'
                                    'Left-drag: Pan    Middle/Right-drag: Rotate (Shift to swap)    Wheel: Zoom')

    def begin_object_edit(self, index):
        super().begin_object_edit(index)
        self._update_object_appearance()

    def finish_object_edit(self, accept=True):
        self._end_drag()
        super().finish_object_edit(accept)
        self._last_click = None
        self._update_object_appearance()

    def _right_click(self):
        if self.operation is not None:
            self._begin_edit_drag('mouse3')
        else:
            self._begin_drag()

    def get_cursor_position(self):
        pointer = self.base.win.get_pointer(0)
        pixel = (pointer.get_x(),pointer.get_y())
        return pixel if pointer.get_in_window() and 0 <= pixel[0] < self.size[0] and 0 <= pixel[1] < self.size[1] else None

    def has_focus(self):
        return self.base.win.get_properties().get_foreground()

    def _window_changed(self, window):
        if window != self.base.win:
            return
        focused = self.has_focus()
        if focused != self._focused:
            self._focused = focused
            self.on_focus_changed()

    def _edit_or_accept(self):
        self._last_click = None
        self._end_drag()
        if self.operation is not None:
            self.finish_object_edit()
        elif self.selected is not None:
            self.begin_object_edit(self.selected)

    def _select(self):
        if self.operation is not None:
            self._begin_edit_drag('mouse1')
            return
        pixel = self.get_cursor_position()
        hit = self.pick(pixel,objects_only=True)
        selected = hit[0] if hit else None
        now = monotonic()
        previous = self._last_click
        double_click = (selected is not None and previous is not None
                        and previous[0] == selected and now-previous[1] <= .4
                        and sum((a-b)**2 for a,b in zip(pixel,previous[2])) <= 25)
        self.selected = selected
        self._last_click = (selected,now,pixel) if selected is not None else None
        self._update_object_appearance()
        if double_click:
            self._edit_or_accept()
        else:
            self._begin_drag(translate_object=True)

    def _begin_drag(self, translate_object=False):
        self._edit_click = None
        pixel = self.get_cursor_position()
        if pixel is not None:
            hit = self.pick(pixel)
            bounds = self.get_bounds(True) or self.get_bounds()
            center = hit[1] if hit else tuple((a+b)/2 for a,b in zip(*bounds))
            self._drag = (pixel,center,translate_object)

    def _end_drag(self):
        self._drag = None
        self._edit_click = None

    def _begin_edit_drag(self, button):
        self._begin_drag(translate_object=button == 'mouse1')
        if self._drag is not None:
            self._edit_click = (button,self._drag[0],self.operation)

    def _release_drag(self, button):
        click = self._edit_click
        pixel = self.get_cursor_position()
        self._end_drag()
        if (click is not None and click[0] == button and click[2] is self.operation
                and self.operation is not None and pixel is not None
                and sum((a-b)**2 for a,b in zip(pixel,click[1])) < 16):
            self.finish_object_edit(button == 'mouse1')

    def _zoom(self, steps):
        if self.operation is not None:
            self.mouse_edit_object(wheel=steps)
        else:
            self.mouse_zoom(steps)
            self.on_camera_changed()

    def reset_scene(self):
        self._end_drag()
        self.finish_object_edit(False)
        for index,pose in enumerate(self.initial_poses):
            self.set_object_pose(index,pose)
        self.undo_stack.clear()
        self.selected = None
        self._update_object_appearance()
        self.set_camera(MyCamera(tuple(self.scene_data["camera"]["t"]),tuple(self.scene_data["camera"]["r"]),self.scene_data["camera"]["fov"]))
        self.on_camera_changed()

    def toggle_projection(self):
        camera = self.get_camera()
        self.set_camera(replace(camera,vertical_fov=None,vertical_span=self.scene_data["orthoExtent"]) if camera.vertical_span is None
                        else replace(camera,vertical_fov=self.scene_data["camera"]["fov"],vertical_span=None))
        self.on_camera_changed()

    def request_close(self):
        self.alive = False

    def pump_events(self):
        self.base.task_mgr.step()

    def _update_frame(self, task):
        if not self.alive or self.base.win is None:
            return task.cont
        size = (max(1,self.base.win.get_x_size()),max(1,self.base.win.get_y_size()))
        if size != self.size:
            self.size = size
            self._update_lens()
        if not self.has_focus():
            self._end_drag()
        pixel = self.get_cursor_position()
        if self._drag is not None and pixel is not None:
            previous,center,translate_object = self._drag
            dx,dy = pixel[0]-previous[0],pixel[1]-previous[1]
            if self._edit_click is not None:
                if sum((a-b)**2 for a,b in zip(pixel,self._edit_click[1])) < 16:
                    dx = dy = 0
                else:
                    self._edit_click = None
            if dx or dy:
                self._last_click = None
                pan = self.base.mouseWatcherNode.is_button_down(KeyboardButton.shift())
                if self.operation is not None:
                    self.mouse_edit_object(dx,dy,pan=pan != translate_object)
                else:
                    center = self.mouse_navigate(dx,dy,center,pan != translate_object)
                    self.on_camera_changed()
                self._drag = (pixel,center,translate_object)
        if self._native_wheel is not None:
            for steps in self._native_wheel.drain():
                self._zoom(steps)
        for marker,point in ((self.marker,self.pivot),(self.object_marker,self.object_pivot)):
            marker.hide()
            if point is not None and (projected := self.project(point)) is not None:
                marker.set_pos(*point)
                marker.set_quat(self.camera_node.get_quat(self.scene))
                depth = -self.camera_node.get_relative_point(self.scene,Point3(*point)).z
                camera = self.get_camera()
                span = camera.vertical_span if camera.vertical_span is not None else 2*depth*tan(camera.vertical_fov/2)
                marker.set_scale(4*span/self.size[1])
                marker.show()
        self._update_status()
        self._draw_diagnostics()
        self._update_lens()
        return task.cont

    def _draw_diagnostics(self):
        # Only the renderer is application code; content/styles come from SDK.
        frame = self.diagnostic_frame()
        if frame is None:
            for node in self._diagnostic_nodes:
                node.remove_node()
            self._diagnostic_nodes.clear()
            self._diagnostic_world_points = ()
            self._diagnostic_key = None
            return
        key = (frame.revision,frame.expires_at,self.size)
        if key == self._diagnostic_key:
            return
        self._diagnostic_key = key
        for node in self._diagnostic_nodes:
            node.remove_node()
        self._diagnostic_nodes.clear()
        self._diagnostic_world_points = ()
        if frame.context is not None and frame.context is not self:
            return
        self._diagnostic_world_points = tuple(
            point for segment in frame.segments for point in (segment.start,segment.end))
        from direct.gui.OnscreenText import OnscreenText
        for index,line in enumerate(frame.lines):
            color = tuple(x/255 for x in self.diagnostic_colors[line.tone])+(1,)
            text = OnscreenText(text=line.text.replace('\u00b7','|'),pos=(-1.25,.32-index*.047),scale=.032,fg=color,align=0)
            self._diagnostic_nodes.append(text)
        # Panda applies thickness to a whole LineSegs batch, not each segment.
        batches = {}
        for segment in frame.segments:
            if segment.width not in batches:
                batches[segment.width] = LineSegs()
                batches[segment.width].set_thickness(segment.width)
            lines = batches[segment.width]
            lines.set_color(*(x/255 for x in self.diagnostic_colors[segment.tone]),segment.opacity)
            lines.move_to(*segment.start)
            lines.draw_to(*segment.end)
        for lines in batches.values():
            node = self.scene.attach_new_node(lines.create())
            node.set_light_off(1)
            node.set_transparency(TransparencyAttrib.M_alpha)
            # Draw after scene geometry, independently of depth.
            node.set_bin("fixed", 90)
            node.set_depth_test(False)
            node.set_depth_write(False)
            node.set_collide_mask(BitMask32.all_off())
            self._diagnostic_nodes.append(node)
        screen = LineSegs()
        screen.set_thickness(2)
        for marker in frame.markers:
            x,y = marker.point
            screen.set_color(*(c/255 for c in self.diagnostic_colors[marker.tone]),.65)
            # pixel2d has a Z-up transform even in this Y-up application.
            # Use render2d with explicit pixel-to-screen position and scale.
            for index, name in enumerate(marker.label.splitlines()):
                label = OnscreenText(text=name,
                    parent=self.base.render2d,
                    pos=(2*(x+12)/self.size[0]-1,1-2*(y-8+15*index)/self.size[1]),
                    scale=(24/self.size[0],24/self.size[1]),
                    fg=tuple(c/255 for c in self.diagnostic_colors[marker.tone])+(.65,),
                    align=0, shadow=(0,0,0,1))
                self._diagnostic_nodes.append(label)
            for a,b in (((x-9,y),(x+9,y)),((x,y-9),(x,y+9))):
                screen.move_to(2*a[0]/self.size[0]-1,1-2*a[1]/self.size[1],0)
                screen.draw_to(2*b[0]/self.size[0]-1,1-2*b[1]/self.size[1],0)
        screen_node = self.base.render2d.attach_new_node(screen.create())
        screen_node.set_transparency(TransparencyAttrib.M_alpha)
        self._diagnostic_nodes.append(screen_node)

    async def run(self, on_started=None, on_stopping=None):
        """Run independently; optional callbacks represent plugin load/unload."""
        import asyncio
        try:
            self.pump_events()
            await asyncio.sleep(0)
            if on_started is not None:
                await on_started()
            while self.alive:
                self.pump_events()
                await asyncio.sleep(1/60)
        finally:
            try:
                if on_stopping is not None:
                    await on_stopping()
            finally:
                self.close()

    def close(self):
        if self._native_wheel is not None:
            self._native_wheel.close()
        self._window_events.ignoreAll()
        self.base.destroy()
