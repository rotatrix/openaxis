"""Equivalent observer evidence for synchronous and awaitable camera hosts."""
import unittest

import test_navigation_session as sync
import test_async_navigation_session as asynchronous
import test_object_navigation_session as objects
from openaxis.types import NavigationState, CameraNavigationState, MotionStart, MotionEnd, ConnectionState


class SyncObserverTests(unittest.IsolatedAsyncioTestCase):
    setup_session = sync.CoordinatorTests.setup_session
    query = sync.CoordinatorTests.query
    flush = sync.CoordinatorTests.flush

    async def test_query_identity_state_and_retirement(self):
        events = []
        self.setup_session(observer=lambda event, **values: events.append((event, values)))
        self.client._dispatch_message(MotionStart(gesture_id=7))
        self.query()
        await self.flush()
        query = next(v['query'] for e, v in events if e == 'query_started')
        self.assertIs(next(v['query'] for e, v in events if e == 'query_context'), query)
        state = NavigationState(gesture_id=7, camera=CameraNavigationState(mode='free_camera'))
        self.client._dispatch_message(state)
        await self.flush()
        self.assertEqual(next(v['state'] for e, v in events if e == 'navigation_state'), state)
        self.session.context_changed()
        await self.flush()
        for event in ('cancelled', 'gesture_finished'):
            self.assertIn((event, {'gesture_id': 7, 'reason': 'context_changed'}), events)
        self.session.close()
        await self.flush()

    async def test_failed_query_keeps_identity(self):
        events = []
        self.setup_session(observer=lambda event, **values: events.append((event, values)))
        self.adapter.on_fact = lambda: setattr(self.adapter, 'context', object())
        self.query(gesture=None)
        await self.flush()
        started = next(v['query'] for e, v in events if e == 'query_started')
        failed = next(v for e, v in events if e == 'query_failed')
        self.assertIs(failed['query'], started)
        self.assertGreaterEqual(failed['duration_ms'], 0)
        self.session.close()
        await self.flush()


class AsyncObserverTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = asynchronous.AsyncSessionTests.asyncSetUp
    asyncTearDown = asynchronous.AsyncSessionTests.asyncTearDown
    query = asynchronous.AsyncSessionTests.query
    idle = asynchronous.AsyncSessionTests.idle
    async def test_observer_payloads_and_finish_reasons(self):
        events = []
        self.session._observer = lambda event, **values: events.append((event, values))
        query = self.query(7)
        await self.idle()
        for event in ('query_started', 'query_context', 'query_completed'):
            self.assertIs(next(v['query'] for e, v in events if e == event), query)
        state = NavigationState(gesture_id=7, camera=CameraNavigationState(mode='free_camera'))
        self.session.on_navigation_state(state)
        await self.idle()
        self.assertEqual(next(v['state'] for e, v in events if e == 'navigation_state'), state)
        for reason in ('motion_end', 'superseded', 'connection_changed', 'context_changed', 'closed'):
            events.clear()
            if reason == 'motion_end': self.session.on_motion_end(7)
            elif reason == 'superseded': self.session.on_motion_start(8)
            elif reason == 'connection_changed': self.session.on_state_change(ConnectionState.DISCONNECTED)
            elif reason == 'context_changed': self.session.context_changed()
            else: await self.session.close()
            await self.idle()
            self.assertIn(('gesture_finished', {'gesture_id': 7, 'reason': reason}), events)
            if reason != 'closed':
                self.session.on_state_change(ConnectionState.CONNECTED)
                self.session.on_motion_start(7)
                self.query(7)
                await self.idle()

    async def test_failed_query_keeps_identity(self):
        events = []
        self.session._observer = lambda event, **values: events.append((event, values))
        async def fail(context): raise RuntimeError('capture failed')
        self.adapter.begin_query = fail
        query = self.query(7)
        await self.idle()
        self.assertIs(next(v['query'] for e, v in events if e == 'query_started'), query)
        self.assertIs(next(v['query'] for e, v in events if e == 'query_failed'), query)


class ObjectObserverTests(unittest.IsolatedAsyncioTestCase):
    setup_session = objects.ObjectTests.setup_session
    query = objects.ObjectTests.query
    flush = objects.ObjectTests.flush
    objects_ready = objects.ObjectTests.objects_ready
    async def test_waiting_notification(self):
        events = []
        await self.objects_ready(observer=lambda event, **values: events.append((event, values)))
        self.objects.limit = 10
        self.client._dispatch_message(objects.obj(12, 1))
        await self.flush()
        delta = next(v['delta_id'] for e, v in events if e == 'object_correction_sent')
        self.assertFalse(any(e == 'object_correction_waiting' for e, _ in events))
        self.client._dispatch_message(objects.obj(13, 2))
        await self.flush()
        self.assertIn(('object_correction_waiting', {'delta_id': delta}), events)
        self.client._dispatch_message(objects.obj(10, 3, delta))
        await self.flush()
        self.assertIn(('object_correction_applied', {'delta_id': delta}), events)
        self.session.close()
        await self.flush()
