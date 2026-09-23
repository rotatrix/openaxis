import asyncio

import pytest

from openaxis.navigation import NavigationQuery, UNAVAILABLE
from openaxis.navigation_diagnostics import NavigationDiagnostics
from openaxis.types import Request


@pytest.mark.parametrize('asynchronous', [False, True])
def test_pick_metadata_is_local_and_misses_do_not_select(asynchronous):
    names = ['pick.cursor.selection', 'pick.cursor', 'pick.viewport_center', 'pick.viewport_center.selection']
    query = NavigationQuery.from_request(Request(id=7, method='navigation.query', params={
        'values': names[:2], 'first': names}))
    diagnostics = NavigationDiagnostics(enabled=True)
    diagnostics.observe('query_started', query=query)
    samples = {names[0]: UNAVAILABLE, names[1]: {'markerPosition': [-.5, .25]},
               names[2]: {'point': [1, 2, 3], 'markerPosition': [0, 0]}}
    calls = []

    def resolve(name):
        calls.append(name)
        value = samples[name]
        diagnostics.observe('fact', query=query, name=name, value=value, duration_ms=0)
        return value

    async def resolve_async(name):
        return resolve(name)

    result = asyncio.run(query.evaluate_async(resolve_async)) if asynchronous else query.evaluate(resolve)
    assert result == {'values': {}, 'first': {'name': names[2], 'value': {'point': [1, 2, 3]}}}
    assert calls == names[:3]  # Memoize misses and skip later candidates.
    assert samples[names[2]]['markerPosition'] == [0, 0]
    frame = diagnostics.presentation()
    assert [(m.label, m.point) for m in frame.markers] == [(names[1], (-.5, .25)), (names[2], (0, 0))]
    assert len(frame.segments) == 3  # Only the actual hit.
