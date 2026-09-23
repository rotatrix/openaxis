"""Passive navigation evidence and renderer-independent presentation.

No application calls, timers, graphics dependencies or protocol messages. Call on
the session thread; render the returned detached presentation on the UI thread.
"""
from collections import deque
from copy import deepcopy
from dataclasses import dataclass, field
from itertools import product
import math
import time

from .navigation import UNAVAILABLE, _wire_fact_value
from .geometry import Quat, Vec3
from .diagnostics import format_event
from ._session import compare, compare_object


COLORS = {
    'text': (245,245,245), 'missing': (255,130,130), 'skipped': (165,165,165),
    'pass': (80,255,110), 'selection': (255,150,40), 'model': (40,210,255),
    'target': (255,70,220), 'cursor': (255,235,40), 'center': (100,170,255),
    'object': (255,70,220), 'sketch': (190,120,255), 'axis_x': (255,60,60), 'axis_y': (60,255,60), 'axis_z': (60,130,255),
    'ray': (175,175,175), 'correction': (255,210,40),
}


@dataclass(frozen=True)
class DiagnosticLine:
    text: str
    tone: str = 'text'


@dataclass(frozen=True)
class DiagnosticSegment:
    start: tuple
    end: tuple
    tone: str
    width: float = 1
    opacity: float = 1  # Candidate evidence is subdued; this does not imply server use.


@dataclass(frozen=True)
class DiagnosticMarker:
    label: str
    point: tuple  # Application-defined local renderer coordinates.
    tone: str


@dataclass(frozen=True)
class DiagnosticPresentation:
    context: object
    lines: tuple = ()
    segments: tuple = ()  # Application world coordinates, projected at draw time.
    markers: tuple = ()
    revision: int = 0
    expires_at: float | None = None


@dataclass
class QueryEvidence:
    request_id: int
    gesture_id: int | None
    values: tuple
    first: tuple
    context: object = None
    facts: dict = field(default_factory=dict)
    picks: dict = field(default_factory=dict)
    selected: str | None = None
    duration_ms: float = 0
    error: str | None = None
    complete: bool = False


def _tone(name):
    if name.startswith('pick.'):
        return 'cursor' if 'cursor' in name else 'center'
    return {'selection.bounds': 'selection', 'model.bounds': 'model',
            'object.bounds': 'object', 'object.pose': 'object', 'scene.cursor': 'target',
            'sketch.plane': 'sketch', 'camera.view_target': 'target'}.get(name, 'text')


def _point(value):
    if isinstance(value, (list, tuple)) and len(value) == 3:
        try:
            result = tuple(float(x) for x in value)
            return result if all(math.isfinite(x) for x in result) else None
        except (TypeError, ValueError):
            pass
    return None


def _bounds(value):
    if isinstance(value, dict):
        low, high = _point(value.get('min')), _point(value.get('max'))
        if low and high and all(a <= b for a,b in zip(low,high)):
            return low,high
    return None


def _box(bounds, tone):
    corners = list(product(*zip(*bounds)))
    for i, start in enumerate(corners):
        for bit in (1,2,4):
            if not i & bit:
                yield DiagnosticSegment(start,corners[i | bit],tone,1,.35)


def _cross(point, radius, tone):
    for axis in range(3):
        a,b = list(point),list(point)
        a[axis] -= radius
        b[axis] += radius
        yield DiagnosticSegment(tuple(a),tuple(b),tone,1,.35)


class NavigationDiagnostics:
    """Optional session consumer. Logging remains independent of overlay capture.

    ``log`` accepts (level, message). It must be fast; use your logger's queue
    handler for slow destinations. ``context`` is an application-owned identity,
    never dereferenced by this module. No native objects are copied into history.

    ``on_changed()`` runs after mutations on the caller's thread; enqueue a
    coalesced UI redraw, never perform native rendering in the callback.
    ``context_key(context)`` maps the navigation capture to an opaque viewport
    identity. It must use that capture, not the newly active view. The default
    preserves the capture itself. Callback failures are isolated by ``observe``.
    Expiry alone emits no notification: schedule a refresh at ``expires_at``.
    """
    def __init__(self, *, enabled=False, log=None, clock=time.monotonic,
                 history_limit=30, retention=1.0, log_level="info",
                 on_changed=None, context_key=None):
        if history_limit < 1 or not math.isfinite(retention) or retention < 0:
            raise ValueError('Invalid diagnostic limits')
        import logging
        self.enabled, self.log, self.clock = enabled, log or (lambda level, message: getattr(logging.getLogger("openaxis"), level)(message)), clock
        self.retention = retention
        self.log_level = log_level
        self._logged_corrections = {}
        self._unknown_readback = {}
        self.history = deque(maxlen=history_limit)
        self.revision = 0
        self._comparison, self._object_comparison = compare, compare_object
        self.on_changed = None
        self.context_key = context_key or (lambda context: context)
        self.clear()
        self.on_changed = on_changed

    def _touch(self):
        self.revision += 1
        try:
            if self.on_changed is not None:
                self.on_changed()
        except Exception:
            pass  # Diagnostic redraw failures must not interrupt navigation.

    def bind(self, comparison, object_comparison=None):
        self._comparison, self._object_comparison = comparison, object_comparison or compare_object

    def clear(self):
        self._reset()
        self._touch()

    def _reset(self):
        self.query = None
        self.context = None
        self.writes = {}
        self.poses = {}
        self.corrections = {}
        self.status = None
        self.history.clear()

    def set_enabled(self, enabled):
        if self.enabled != enabled:
            self.enabled = enabled
            self.clear()

    def set_context(self, context):
        """Bind evidence to the viewport actually used by the query."""
        if self.enabled:
            self._set_context(context)
            self._touch()

    def _set_context(self, context):
        if self.enabled:
            if self.context != context:
                self.writes.clear()
                self.poses.clear()
                self.corrections.clear()
            self.context = context
            if self.query is not None and not self.query.complete:
                self.query.context = context

    def pick(self, request_id, name, *, screen=None, ray=None):
        """Attach actual pick evidence. Ray is (world start, world end)."""
        q = self.query
        if self.enabled and q and not q.complete and q.request_id == request_id:
            q.picks[name] = deepcopy((screen,ray))
            self._touch()

    def observe(self, event, **v):
        # Keep logger/observer errors from entering application navigation paths.
        try:
            self._observe(event, v)
        except Exception:
            # Diagnostics are best-effort. Native/session errors have their own
            # evidence; a broken diagnostic sink must not become one of them.
            pass

    def _observe(self, event, v):
        query = v.get('query')
        message = None
        level = 'info'
        if event == 'gesture_started':
            self._logged_corrections.clear()
            self._unknown_readback.clear()
        if event == 'fact':
            raw_value = v.get('value')
            value = _wire_fact_value(v['name'], raw_value)
            available = value is not None and value is not UNAVAILABLE
            message = format_event('navigation.fact',fact=v['name'],
                result='error' if v.get('error') else 'ok' if available else 'missing',
                value=value if available else None,error=v.get('error'),duration_ms=v['duration_ms'])
        elif event == 'query_completed':
            message = format_event('navigation.query.complete',request=query.request_id,
                first=(v['result'].get('first') or {}).get('name'),duration_ms=v['duration_ms'])
        elif event in ('gesture_started','gesture_finished','cancelled','output_rejected','query_failed'):
            level = 'warning' if event in ('output_rejected','query_failed') else 'info'
            message = f"{event}: " + ', '.join(f'{k}={x}' for k,x in v.items() if k != 'query')
        elif event in ('camera_write','object_write'):
            unknown = v['success'] and v.get('realized') is None
            was_unknown = self._unknown_readback.get(event, False)
            self._unknown_readback[event] = unknown
            level = 'warning' if not v['success'] else 'info' if unknown != was_unknown else 'debug'
            state = 'failed' if not v['success'] else 'unknown readback' if unknown else 'readback recovered' if was_unknown else 'succeeded'
            if not v['success'] or unknown != was_unknown:
                message = event.replace('_',' ') + ': ' + state
        elif 'correction_' in event:
            level = 'debug'
            stream = 'object' if event.startswith('object_') else 'camera'
            state = event.rsplit('_',1)[-1]
            key = (state,v['delta_id'])
            if self._logged_corrections.get(stream) != key:
                message = f"{stream} correction {v['delta_id']}: {'acknowledged' if state == 'applied' else state}"
                difference = v.get('difference')
                if difference is not None:
                    message += f' | translation {difference.t} | rotation {difference.r} rad | scale {difference.scale}'
                self._logged_corrections[stream] = key
        if message and self.log and (level != "debug" or self.log_level == "debug"):
            try:
                self.log(level,message)
            except Exception:
                pass
        if not self.enabled:
            return
        if message and event not in ('fact','camera_write','object_write'):
            self.history.append((self.clock(),level,message))
        if event == 'gesture_started':
            self._reset()
            self.status = f"gesture {v['gesture_id']} started"
        elif event in ('gesture_finished','cancelled'):
            self.status = f"gesture finished: {v.get('reason','motion_end')}"
            self.corrections = {k:(i,'ended',self.clock()+self.retention) for k,(i,_,_) in self.corrections.items()}
        elif event == 'query_started':
            self.query = QueryEvidence(query.request_id,query.gesture_id,tuple(query.values),tuple(query.first))
        elif event == 'query_context':
            self._set_context(self.context_key(v['context']))
        elif event == 'fact' and self.query and query.request_id == self.query.request_id:
            if v['name'].startswith('pick.') and isinstance(raw_value, dict):
                marker = raw_value.get('markerPosition')
                if isinstance(marker, (list, tuple)) and len(marker) == 2 and all(isinstance(x, (int, float)) and math.isfinite(x) for x in marker):
                    self.pick(query.request_id, v['name'], screen=tuple(marker))
            self.query.facts[v['name']] = (deepcopy(value) if available else None,v['duration_ms'],v.get('error'))
        elif event in ('query_completed','query_failed') and self.query:
            if query is not None and query.request_id != self.query.request_id:
                return
            self.query.complete = True
            self.query.duration_ms = v['duration_ms']
            self.query.error = v.get('error')
            self.query.selected = (v.get('result',{}).get('first') or {}).get('name')
        elif event in ('camera_write','object_write'):
            kind = event.split('_')[0]
            actual = v.get('realized')
            self.poses[kind] = deepcopy((v['desired'],actual))
            state = 'failed' if not v['success'] else 'unknown readback' if actual is None else 'comparison unavailable'
            comparison = self._comparison if kind == 'camera' else self._object_comparison
            detail = ''
            if v['success'] and actual is not None and comparison:
                difference = comparison(v['desired'],actual)
                state = 'differs' if difference.changed or difference.discontinuity else 'equivalent'
                detail = f' | translation {math.hypot(*difference.t):.3g} application units | rotation {math.degrees(math.hypot(*difference.r)):.3g} deg'
            self.writes[kind] = DiagnosticLine(f'{kind} write: {state}{detail}', 'missing' if state == 'failed' else 'pass' if state == 'equivalent' else 'correction')
        elif 'correction_' in event:
            level = 'debug'
            kind = 'object' if event.startswith('object_') else 'camera'
            state = event.rsplit('_',1)[-1]
            until = self.clock()+self.retention if state == 'applied' else None
            self.corrections[kind] = (v['delta_id'],'acknowledged' if state == 'applied' else state,until)
        elif event == 'output_rejected':
            self.status = message
        self._touch()

    def presentation(self):
        if not self.enabled:
            return DiagnosticPresentation(None,revision=self.revision)
        lines,segments,markers = [],[],[]
        q = self.query
        if q and q.context == self.context:
            lines.append(DiagnosticLine(f'Navigation diagnostics | gesture {q.gesture_id} | query {q.request_id} | {q.duration_ms:.1f} ms'))
            if q.error:
                lines.append(DiagnosticLine(q.error,'missing'))
            for name in dict.fromkeys(q.values+q.first):
                fact = q.facts.get(name)
                if fact is None:
                    state = 'skipped' if q.complete and q.selected and name in q.first and q.first.index(name)>q.first.index(q.selected) else 'not evaluated'
                    lines.append(DiagnosticLine(f'{name}: {state}','skipped'))
                else:
                    value,duration,error = fact
                    text = format_event('navigation.fact',fact=name,result='error' if error else 'ok' if value is not None else 'missing',value=value,error=error,duration_ms=duration)
                    lines.append(DiagnosticLine(text+(' < returned candidate' if name == q.selected else ''),'missing' if error or value is None else _tone(name)))
            scale = 1.
            for name in ('selection.bounds','model.bounds','object.bounds'):
                bounds = _bounds(q.facts.get(name,(None,))[0])
                if bounds:
                    scale = max(.0001,math.dist(*bounds)*.1)
                    break
            for name,(value,_,_) in q.facts.items():
                tone = _tone(name)
                if name == 'world.orientation' and isinstance(value,dict):
                    forward,up = _point(value.get('forward')),_point(value.get('up'))
                    if forward and up:
                        right = (forward[1]*up[2]-forward[2]*up[1],forward[2]*up[0]-forward[0]*up[2],forward[0]*up[1]-forward[1]*up[0])
                        sign = -1 if value.get('handedness') == 'left' else 1
                        for direction,axis_tone in ((tuple(sign*x for x in right),'axis_x'),(up,'axis_y'),(forward,'axis_z')):
                            segments.append(DiagnosticSegment((0,0,0),tuple(scale*x for x in direction),axis_tone,2))
                if name == 'object.pose' and isinstance(value,dict):
                    origin,rotation = _point(value.get('t')),_point(value.get('r'))
                    if origin and rotation:
                        qrot = Quat.from_rotvec(*rotation)
                        for axis,axis_tone in (((1,0,0),'axis_x'),((0,1,0),'axis_y'),((0,0,1),'axis_z')):
                            direction = qrot.rotate(Vec3(*axis))
                            end = tuple(a+scale*b for a,b in zip(origin,(direction.x,direction.y,direction.z)))
                            segments.append(DiagnosticSegment(origin,end,axis_tone,2))
                if name == 'sketch.plane' and isinstance(value,dict):
                    origin,normal,axis = (_point(value.get(k)) for k in ('origin','normal','x_axis'))
                    if origin and normal and axis and math.hypot(*normal)>0 and math.hypot(*axis)>0:
                        normal = tuple(v/math.hypot(*normal) for v in normal)
                        axis = tuple(v/math.hypot(*axis) for v in axis)
                        y = (normal[1]*axis[2]-normal[2]*axis[1],normal[2]*axis[0]-normal[0]*axis[2],normal[0]*axis[1]-normal[1]*axis[0])
                        if math.hypot(*y)>0:
                            y = tuple(v/math.hypot(*y) for v in y)
                            for step in (-1,-.5,0,.5,1):
                                for along,across in ((axis,y),(y,axis)):
                                    start = tuple(o+scale*(step*a-b) for o,a,b in zip(origin,along,across))
                                    end = tuple(o+scale*(step*a+b) for o,a,b in zip(origin,along,across))
                                    segments.append(DiagnosticSegment(start,end,'sketch',1))
                            segments.append(DiagnosticSegment(origin,tuple(o+scale*n for o,n in zip(origin,normal)),'target',2))
                bounds = _bounds(value)
                if bounds:
                    segments.extend(_box(bounds,tone))
                point = _point(value) if name in ('camera.view_target','scene.cursor') else _point(value.get('point')) if isinstance(value,dict) else None
                if point:
                    segments.extend(_cross(point,scale*.08,tone))
                if isinstance(value,dict) and (bounds := _bounds(value.get('bounds'))):
                    segments.extend(_box(bounds,tone))
            for name,(screen,ray) in q.picks.items():
                if screen is not None:
                    markers.append(DiagnosticMarker(name,tuple(screen),_tone(name)))
        if self.status:
            lines.append(DiagnosticLine(self.status))
        lines.extend(self.writes.values())
        expiries = []
        for kind,(identifier,state,until) in self.corrections.items():
            if until is None or self.clock() < until:
                lines.append(DiagnosticLine(f'{kind} correction {identifier}: {state}','correction'))
                if until is not None:
                    expiries.append(until)
        # Several queries can sample the same pixel. Preserve every query name
        # without drawing their crosshairs and labels on top of one another.
        grouped = {}
        for marker in markers:
            grouped.setdefault((marker.point,marker.tone),[]).append(marker.label)
        markers = [DiagnosticMarker('\n'.join(labels),point,tone)
                   for (point,tone),labels in grouped.items()]
        return DiagnosticPresentation(self.context,tuple(lines),tuple(segments),tuple(markers),self.revision,min(expiries) if expiries else None)
