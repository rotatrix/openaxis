import asyncio
import json
from pathlib import Path

import msgpack
import pytest

from openaxis.client import OpenAxisClient, OpenAxisListener
from openaxis.navigation import NavigationQuery, UNAVAILABLE
from openaxis.types import Request, ConnectionState, unpack_msg

FIXTURES = Path(__file__).resolve().parents[3] / 'fixtures/openaxis-1.0'


def fixture(name):
    return json.loads((FIXTURES / f'{name}.json').read_text())


@pytest.mark.parametrize('case', fixture('wire')['cases'], ids=lambda c: c['name'])
def test_wire(case):
    def parse():
        message = OpenAxisClient._unpack_bytes(bytes.fromhex(case['hex']))
        if isinstance(message, Request) and message.method == 'navigation.query':
            NavigationQuery.from_request(message)
    if case['valid']:
        parse()
    else:
        with pytest.raises((ValueError, TypeError, msgpack.UnpackException)):
            parse()


@pytest.mark.parametrize('case', fixture('queries')['cases'], ids=lambda c: c['name'])
@pytest.mark.parametrize('asynchronous', [False, True])
def test_query_resolution(case, asynchronous):
    q = NavigationQuery.from_request(Request(id=1, method='navigation.query', params=case['params']))
    calls = []
    def resolve(name):
        calls.append(name)
        return case['facts'].get(name, UNAVAILABLE)
    async def resolve_async(name):
        return resolve(name)
    result = asyncio.run(q.evaluate_async(resolve_async)) if asynchronous else q.evaluate(resolve)
    assert result == case['result']
    assert calls == case['calls']


class Socket:
    def __init__(self):
        self.messages = []
        self.closed = False
    async def send(self, message):
        self.messages.append(msgpack.unpackb(message, raw=False))
    async def close(self):
        self.closed = True


def test_client_contract():
    async def run():
        class Listener(OpenAxisListener):
            def __init__(self):
                self.events = []
                self.query = None
                self.complete_inline = False
            def on_motion_start(self, gesture): self.events.append(('start', gesture))
            def on_motion_end(self, gesture): self.events.append(('end', gesture))
            def on_navigation_query(self, query):
                self.query = query
                if self.complete_inline:
                    query.complete({'values': {}})
                    return False
                return True
            def on_state_change(self, state): raise RuntimeError('passive failure')
        ordinary, navigation = Listener(), Listener()
        c = OpenAxisClient(client_name='contract', listener=ordinary)
        c._state = ConnectionState.CONNECTED
        old = c._ws = Socket()
        detach = c._attach_navigation(navigation)
        for message in fixture('client')['lifecycle']:
            c._dispatch_message(unpack_msg(message))
        assert ordinary.events == navigation.events == [('start', 7), ('end', 7)]
        for message in fixture('client')['malformed_requests']:
            c._handle_message(msgpack.packb(message))
        await asyncio.sleep(0)
        assert [(m['id'], m['error']['code']) for m in old.messages] == [(m['id'], 'bad_request') for m in fixture('client')['malformed_requests']]
        c._dispatch_message(Request(id=90, method='navigation.query'))
        retained = navigation.query
        replacement = c._ws = Socket()
        retained.complete({'values': {'document.id': 'old'}})
        await asyncio.sleep(0)
        assert retained.completed and replacement.messages == []
        with pytest.raises(RuntimeError): retained.fail('unavailable')
        navigation.complete_inline = True
        c._dispatch_message(Request(id=91, method='navigation.query'))
        await asyncio.sleep(0)
        assert len(replacement.messages) == 1 and replacement.messages[0]['id'] == 91
        await c.disconnect()
        assert replacement.closed and c.state == ConnectionState.DISCONNECTED
        detach()
    asyncio.run(run())


def test_query_validation_precedes_terminal_claim():
    q = NavigationQuery.from_request(Request(id=1, method='navigation.query'), complete_callback=lambda _: (_ for _ in ()).throw(RuntimeError('send failed')))
    with pytest.raises(TypeError): q.complete([])
    assert not q.completed
    with pytest.raises(RuntimeError, match='send failed'): q.complete({})
    assert q.completed
