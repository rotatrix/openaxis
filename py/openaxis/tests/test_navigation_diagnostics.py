from types import SimpleNamespace
import pytest
from openaxis.navigation_diagnostics import NavigationDiagnostics
from openaxis.navigation import UNAVAILABLE
from openaxis.navigation_session import compare
from openaxis.types import CameraPose


def query():
    return SimpleNamespace(request_id=4,gesture_id=2,values=('model.bounds',),
        first=('pick.cursor.selection','pick.cursor','pick.viewport_center'))


def test_query_evidence_is_detached_and_ordered():
    d = NavigationDiagnostics(enabled=True)
    q = query()
    d.observe('query_started',query=q)
    d.set_context('view A')
    bounds = {'min':[0,0,0],'max':[2,2,2]}
    for name,value in [('model.bounds',bounds),('pick.cursor.selection',UNAVAILABLE),('pick.cursor',{'point':[1,1,1],'bounds':bounds})]:
        d.observe('fact',query=q,name=name,value=value,error=None,duration_ms=1)
    d.pick(99,'wrong',screen=(1,2))
    d.pick(4,'pick.cursor',screen=(20,30),ray=((0,0,5),(1,1,1)))
    d.observe('query_completed',query=q,result={'first':{'name':'pick.cursor'}},duration_ms=3)
    bounds['max'][0] = 500
    frame = d.presentation()
    assert frame.context == 'view A'
    assert len(frame.segments) == 27  # Two boxes and hit cross; ray evidence is never drawn.
    assert all(s.opacity == .35 and s.width == 1 for s in frame.segments)
    assert any("returned candidate" in row.text for row in frame.lines)
    assert frame.markers[0].point == (20,30)
    assert len(frame.markers) == 1
    assert any('skipped' in line.text for line in frame.lines)
    assert all(500 not in segment.end for segment in frame.segments)
    d.set_context('view B')
    assert not d.presentation().segments


def test_coincident_pick_markers_preserve_names_without_duplicate_crosshairs():
    d = NavigationDiagnostics(enabled=True)
    d.observe('query_started',query=query())
    d.pick(4,'pick.cursor.selection',screen=(20,30))
    d.pick(4,'pick.cursor',screen=(20,30))
    d.pick(4,'pick.viewport_center',screen=(100,100))
    frame = d.presentation()
    assert len(frame.markers) == 2
    assert frame.markers[0].label == 'pick.cursor.selection\npick.cursor'
    assert frame.markers[0].point == (20,30)
    d.pick(4,'pick.cursor',screen=(21,30))
    assert len(d.presentation().markers) == 3


def test_write_uses_session_policy_and_unknown_is_not_failure():
    d = NavigationDiagnostics(enabled=True)
    calls = []
    def policy(a,b):
        calls.append((a,b))
        return compare(a,b,absolute=10)
    d.bind(policy)
    pose = CameraPose(t=(0,0,10),r=(0,0,0),fov=1)
    actual = CameraPose(t=(1,0,10),r=(0,0,0),fov=1)
    d.observe('camera_write',desired=pose,realized=actual,success=True)
    assert 'equivalent' in d.writes['camera'].text
    assert len(calls) == 1
    d.observe('camera_write',desired=pose,realized=None,success=True)
    assert 'unknown readback' in d.writes['camera'].text
    d.observe('camera_write',desired=pose,realized=None,success=False)
    assert 'failed' in d.writes['camera'].text
    assert len(calls) == 1


def test_retention_disabled_capture_and_failing_logger():
    now = [0.]
    d = NavigationDiagnostics(enabled=True,clock=lambda:now[0],history_limit=2,
        log=lambda *_: (_ for _ in ()).throw(RuntimeError('sink failed')))
    d.observe('correction_sent',delta_id=5)
    d.observe('correction_waiting',delta_id=5)
    d.observe('correction_applied',delta_id=5)
    assert d.presentation().expires_at == 1
    now[0] = 2
    assert not d.presentation().lines
    for i in range(20):
        d.observe('output_rejected',reason='stale',gesture_id=i)
    assert len(d.history) == 2
    d.set_enabled(False)
    d.observe('query_started',query=query())
    assert d.query is None
    assert not d.presentation().lines


def test_camera_and_object_correction_ids_are_independent():
    d = NavigationDiagnostics(enabled=True)
    d.observe('correction_sent',delta_id=1)
    d.observe('object_correction_sent',delta_id=1)
    d.observe('object_correction_applied',delta_id=1)
    assert d.corrections['camera'][1] == 'sent'
    assert d.corrections['object'][1] == 'acknowledged'


def test_shared_correction_fixture():
    import json
    from pathlib import Path
    fixture = json.loads((Path(__file__).parents[3]/'fixtures/openaxis-1.0/diagnostics.json').read_text())
    now = [0.]
    d = NavigationDiagnostics(enabled=True,clock=lambda:now[0])
    for step in fixture['corrections']:
        now[0] = step['time']
        prefix = 'object_' if step['stream'] == 'object' else ''
        d.observe(prefix+'correction_'+step['state'],delta_id=step['id'])
        assert len(d.presentation().lines) == step['visible']
    now[0] = fixture['expire_at']
    assert not d.presentation().lines


def test_camera_fact_does_not_draw_axes_at_the_perspective_eye():
    d = NavigationDiagnostics(enabled=True)
    q = query()
    q.values = ('camera.pose',)
    q.first = ()
    d.observe('query_started',query=q)
    d.set_context('view')
    d.observe('fact',query=q,name='camera.pose',value={'t':(0,0,10),'r':(0,0,0),'fov':1},error=None,duration_ms=0)
    assert d.presentation().lines
    assert not d.presentation().segments


def test_normal_logs_without_overlay_are_informative_and_bounded():
    records = []
    d = NavigationDiagnostics(log=lambda level,message:records.append((level,message)))
    q = query()
    d.observe('fact',query=q,name='pick.cursor',value={'point':(1,2,3),'bounds':{'min':(0,0,0),'max':(2,2,3)}},duration_ms=2,error=None)
    assert records[-1][0] == 'info' and 'bounds' in records[-1][1]
    pose = CameraPose(t=(0,0,1),r=(0,0,0),fov=1)
    records.clear()
    for _ in range(5): d.observe('camera_write',desired=pose,realized=pose,success=True)
    assert records == []
    for _ in range(5): d.observe('camera_write',desired=pose,realized=None,success=True)
    assert len(records) == 1 and 'unknown readback' in records[0][1]
    d.observe('camera_write',desired=pose,realized=pose,success=True)
    assert 'recovered' in records[-1][1]
    records.clear()
    for _ in range(5): d.observe('correction_waiting',delta_id=1)
    assert records == []
    d.log_level = 'debug'
    d.observe('correction_applied',delta_id=1)
    assert 'acknowledged' in records[-1][1]
    assert d.query is None and not d.presentation().lines


def test_changed_observes_completed_mutations_and_isolates_failure():
    seen = []
    d = NavigationDiagnostics(enabled=True)
    d.on_changed = lambda: seen.append(d.presentation())
    d.observe('gesture_started', gesture_id=17)
    assert len(seen) == 1
    assert any('17' in row.text for row in seen[-1].lines)
    d.observe('query_started', query=query())
    d.set_context('view')
    d.pick(4, 'pick.cursor', screen=(1, 2))
    assert seen[-1].markers[0].point == (1, 2)
    d.set_enabled(False)
    assert not seen[-1].lines
    count = len(seen)
    d.observe('gesture_started', gesture_id=18)
    assert len(seen) == count  # Logging-only events do not request a redraw.
    def fail(): raise RuntimeError('UI stopped')
    d.on_changed = fail
    d.set_enabled(True)
    d.clear()
    d.observe('gesture_started', gesture_id=19)
    assert '19' in d.status


def test_context_key_uses_navigation_capture_and_disabled_does_not_map():
    captured = SimpleNamespace(token=('document', 'view'))
    mapped = []
    d = NavigationDiagnostics(context_key=lambda c: mapped.append(c) or c.token)
    d.observe('query_context', context=captured)
    assert not mapped
    d.set_enabled(True)
    d.observe('query_started', query=query())
    d.observe('query_context', context=captured)
    assert mapped == [captured]
    assert d.presentation().context == captured.token
    assert d.query.context == captured.token


def test_object_and_sketch_visuals_use_production_facts():
    d = NavigationDiagnostics(enabled=True)
    q = SimpleNamespace(request_id=1, gesture_id=1,
        values=('object.pose','object.bounds','sketch.plane','scene.cursor'), first=())
    d.observe('query_started', query=q)
    d.set_context('view')
    facts = {'object.pose': {'t':(2,3,4),'r':(0,0,0)},
        'object.bounds': {'min':(0,0,0),'max':(10,10,10)},
        'sketch.plane': {'origin':(0,0,0),'normal':(0,0,1),'x_axis':(1,0,0)},
        'scene.cursor': (4,5,6)}
    for name,value in facts.items():
        d.observe('fact',query=q,name=name,value=value,duration_ms=1,error=None)
    frame = d.presentation()
    assert len([s for s in frame.segments if s.tone == 'object']) == 12
    assert len([s for s in frame.segments if s.start == (2,3,4)]) == 3
    assert len([s for s in frame.segments if s.tone == 'sketch']) == 10
    assert any(s.start[1:] == (5,6) and s.start[0] < 4 < s.end[0] for s in frame.segments)


def test_shared_presentation_fixture():
    import json
    from pathlib import Path
    from dataclasses import asdict
    from openaxis.navigation_diagnostics import COLORS
    fixture = json.loads((Path(__file__).parents[3]/'fixtures/openaxis-1.0/diagnostic-presentation.json').read_text())
    d = NavigationDiagnostics(enabled=True)
    q = SimpleNamespace(request_id=9,gesture_id=7,values=tuple(fixture['facts']),first=())
    d.observe('query_started',query=q)
    d.set_context('view')
    for name,value in fixture['facts'].items():
        d.observe('fact',query=q,name=name,value=value,error=None,duration_ms=0)
    d.pick(9,'pick.cursor',screen=(20,30),ray=((0,0,5),(1,1,1)))
    d.pick(9,'pick.cursor.selection',screen=(20,30))
    d.observe('query_completed',query=q,result={},duration_ms=0)
    frame = d.presentation()
    for key,values in [('rows',frame.lines),('segments',frame.segments),('markers',frame.markers)]:
        actual = json.loads(json.dumps([asdict(x) for x in values]))
        expected = fixture[key]
        assert len(actual) == len(expected)
        for actual_item, expected_item in zip(actual, expected):
            expected_item = expected_item.copy()
            # Rotation math can differ by a few ULPs across runtimes/platforms.
            # Only coordinates get a tolerance; presentation metadata stays exact.
            for coordinate in {'segments': ('start', 'end'), 'markers': ('point',)}.get(key, ()):
                assert actual_item.pop(coordinate) == pytest.approx(
                    expected_item.pop(coordinate), rel=0, abs=1e-12,
                )
            assert actual_item == expected_item
    assert json.loads(json.dumps(COLORS)) == fixture['colors']


def test_custom_retention_history_and_expiry():
    now = [10.]
    d = NavigationDiagnostics(enabled=True,clock=lambda:now[0],retention=2.5,history_limit=2)
    for i in range(3): d.observe('correction_sent',delta_id=i)
    assert len(d.history) == 2
    d.observe('correction_applied',delta_id=2)
    assert d.presentation().expires_at == 12.5
    now[0] = 12.5
    assert d.presentation().expires_at is None
    assert not d.presentation().lines


def test_shared_lifecycle_fixture_and_completed_notification():
    import json
    from pathlib import Path
    fixture = json.loads((Path(__file__).parents[3]/'fixtures/openaxis-1.0/diagnostics.json').read_text())
    logs, snapshots = [], []
    d = NavigationDiagnostics(enabled=True,log=lambda level,text:logs.append((level,text)))
    d.on_changed = lambda: snapshots.append(d.presentation())
    for step in fixture['lifecycle']:
        values = {'gesture_id':step['id']}
        if step['event'] == 'output_rejected':
            values = {'kind':'camera.pose',**values}
        if step['reason']: values['reason'] = step['reason']
        before = len(snapshots)
        d.observe(step['event'],**values)
        assert logs[-1] == (step['level'],step['message'])
        assert len(snapshots) == before+1
        assert snapshots[-1].lines[-1].text == step['status']
