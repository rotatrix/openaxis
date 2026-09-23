import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from openaxis.client import OpenAxisClient
from openaxis.connection_manager import (
    OpenAxisConnectionManager, ConnectionMetadata, ConnectionManagerState, RetryPolicy,
)
from openaxis.types import ConnectionState


class Client(OpenAxisClient):
    def __init__(self):
        super().__init__(client_name="lifecycle-test")
        self.attempts = 0
        self.failures = 0
        self.messages = []
        self.block = None
        self.cleanup = 0

    async def connect(self):
        self.attempts += 1
        self._set_state(ConnectionState.CONNECTING)
        if self.block:
            await self.block.wait()
        if self.attempts <= self.failures:
            raise ConnectionError("offline")
        self._set_state(ConnectionState.CONNECTED)

    async def disconnect(self):
        self.cleanup += 1
        self._set_state(ConnectionState.DISCONNECTED)

    def _capture_navigation_sender(self):
        generation = self.attempts

        async def send(message):
            if generation != self.attempts or self.state != ConnectionState.CONNECTED:
                raise ConnectionError("retired")
            self.messages.append((generation, message.pack()))
        return send


async def until(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(0.001)


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    def test_outage_logs_once_and_resets_after_recovery(self):
        records, states = [], []
        manager = OpenAxisConnectionManager(Client(), metadata=ConnectionMetadata,
            log=lambda *args: records.append(args),
            on_state=lambda *args: states.append(args))
        for _ in range(10):
            manager._notify(ConnectionManagerState.CONNECTING)
            manager._notify(ConnectionManagerState.RETRYING, ConnectionError("offline"), 2)
        self.assertEqual(len(records), 2)
        self.assertEqual(len(states), 20)
        manager._notify(ConnectionManagerState.READY)
        manager._notify(ConnectionManagerState.RETRYING)
        self.assertEqual(len(records), 4)

    async def test_sdk_logs_lifecycle_without_a_state_observer(self):
        client = Client()
        client.failures = 1
        messages = []
        lifecycle = self.make(client, log=lambda level, message: messages.append((level, message)))
        run = asyncio.create_task(lifecycle.run())
        await until(lambda: lifecycle.state == ConnectionManagerState.READY)
        await lifecycle.stop()
        self.assertTrue(run.done())
        self.assertEqual([level for level, _ in messages], ["info", "warning", "info", "info"])
        self.assertIn("offline", messages[1][1])
        self.assertIn("retrying in", messages[1][1])
        self.assertIn("openaxis/1.0", messages[-2][1])
        self.assertEqual(messages[-1][1], "connection stopped")

    async def test_broken_log_sink_cannot_break_connection_or_cleanup(self):
        def log(*_):
            raise RuntimeError("sink failed")
        client = Client()
        lifecycle = self.make(client, log=log)
        with self.assertLogs("openaxis", level="ERROR"):
            run = asyncio.create_task(lifecycle.run())
            await until(lambda: lifecycle.state == ConnectionManagerState.READY)
            await lifecycle.stop()
        self.assertTrue(run.done())
        self.assertEqual(client.state, ConnectionState.DISCONNECTED)

    def make(self, client, **options):
        options.setdefault("metadata", lambda: ConnectionMetadata(tags=("test",), capabilities=("navigation",)))
        options.setdefault("retry", RetryPolicy(.005, .02, jitter=0))
        return OpenAxisConnectionManager(client, **options)

    async def test_retry_metadata_replay_and_restart(self):
        client = Client()
        client.failures = 2
        tags = ("first",)
        states = []
        lifecycle = self.make(client, metadata=lambda: ConnectionMetadata(tags=tags, axes=(), focused=False),
                              on_state=lambda *values: states.append(values))
        run = asyncio.create_task(lifecycle.run())
        await until(lambda: lifecycle.state == ConnectionManagerState.READY)
        self.assertEqual(client.attempts, 3)
        self.assertEqual([e[2] for e in states if e[0] == ConnectionManagerState.RETRYING], [.005, .01])
        self.assertEqual([m[1]["type"] for m in client.messages], ["tags", "capabilities", "subscribe", "focus"])
        tags = ("second",)
        await lifecycle.refresh_metadata()
        await client.disconnect()
        await until(lambda: client.attempts == 4 and lifecycle.state == ConnectionManagerState.READY)
        self.assertEqual(client.messages[-4][1]["tags"], ("second",))
        await lifecycle.stop()
        self.assertTrue(run.cancelled())
        self.assertEqual(lifecycle.state, ConnectionManagerState.STOPPED)
        run = asyncio.create_task(lifecycle.run())
        await until(lambda: lifecycle.state == ConnectionManagerState.READY)
        await asyncio.gather(lifecycle.stop(), lifecycle.stop())
        self.assertTrue(run.done())

    async def test_stop_during_startup_and_retry(self):
        for blocked in (True, False):
            client = Client()
            client.block = asyncio.Event() if blocked else None
            client.failures = 100
            lifecycle = self.make(client, retry=RetryPolicy(60, 60))
            run = asyncio.create_task(lifecycle.run())
            await until(lambda: client.attempts > 0 if blocked else lifecycle.state == ConnectionManagerState.RETRYING)
            await asyncio.wait_for(lifecycle.stop(), .5)
            self.assertEqual(client.state, ConnectionState.DISCONNECTED)
            self.assertTrue(run.done())
            self.assertEqual(client.attempts, 1)

    async def test_timeout_cleans_up_and_retries(self):
        client = Client()
        client.block = asyncio.Event()
        errors = []
        lifecycle = self.make(client, startup_timeout=.01, on_state=lambda s, e, d: errors.append(e))
        asyncio.create_task(lifecycle.run())
        await until(lambda: client.attempts >= 2)
        await lifecycle.stop()
        self.assertTrue(any(isinstance(e, TimeoutError) for e in errors))
        self.assertGreaterEqual(client.cleanup, 2)

    async def test_setup_failure_and_early_disconnect_never_ready(self):
        for lose_connection in (True, False):
            client = Client()

            def metadata():
                if lose_connection:
                    client._set_state(ConnectionState.DISCONNECTED)
                    return ConnectionMetadata()
                raise ValueError("snapshot failed")

            lifecycle = self.make(client, metadata=metadata, retry=RetryPolicy(60, 60))
            asyncio.create_task(lifecycle.run())
            await until(lambda: lifecycle.state == ConnectionManagerState.RETRYING)
            await lifecycle.stop()
            self.assertEqual(client.messages, [])

    async def test_duplicate_run_and_observer_failure(self):
        client = Client()

        def observer(*args):
            raise ValueError("observer")

        lifecycle = self.make(client, on_state=observer)
        with self.assertLogs("openaxis", level="ERROR"):
            asyncio.create_task(lifecycle.run())
            await until(lambda: lifecycle.state == ConnectionManagerState.READY)
            with self.assertRaises(RuntimeError):
                await lifecycle.run()
            await lifecycle.stop()

    async def test_wait_disconnected_retains_early_close(self):
        client = Client()
        await client.connect()
        await client.disconnect()
        await asyncio.wait_for(client.wait_disconnected(), .1)

    async def test_real_client_waits_for_receive_cleanup_before_reconnect(self):
        release = asyncio.Event()

        class Socket:
            def __aiter__(self):
                return self

            async def __anext__(self):
                raise StopAsyncIteration

            async def close(self):
                await release.wait()

        client = OpenAxisClient(client_name="cleanup-order")
        client._ws = Socket()
        client._set_state(ConnectionState.CONNECTING)
        client._set_state(ConnectionState.CONNECTED)
        receive = asyncio.create_task(client._receive_loop())
        await until(lambda: client.state == ConnectionState.DISCONNECTING)
        waiting = asyncio.create_task(client.wait_disconnected())
        stopping = asyncio.create_task(client.disconnect())
        await asyncio.sleep(0)
        self.assertFalse(waiting.done())
        self.assertFalse(stopping.done())
        release.set()
        await asyncio.gather(receive, waiting, stopping)
        self.assertIsNone(client._ws)
        self.assertEqual(client.state, ConnectionState.DISCONNECTED)

    async def test_cancelled_handshake_closes_socket(self):
        socket = AsyncMock()
        entered = asyncio.Event()

        async def recv():
            entered.set()
            await asyncio.Event().wait()

        socket.recv.side_effect = recv
        client = OpenAxisClient(client_name="cancel-handshake")
        with patch("openaxis.client.websockets.connect", AsyncMock(return_value=socket)):
            connecting = asyncio.create_task(client.connect())
            await entered.wait()
            connecting.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await connecting
        socket.close.assert_awaited_once()
        self.assertEqual(client.state, ConnectionState.DISCONNECTED)
        self.assertIsNone(client._ws)

    async def test_delayed_metadata_cannot_send_to_replacement(self):
        client = Client()
        entered, release = asyncio.Event(), asyncio.Event()
        slow = False

        async def metadata():
            if slow:
                entered.set()
                await release.wait()
            return ConnectionMetadata(tags=("fresh",))

        lifecycle = self.make(client, metadata=metadata)
        asyncio.create_task(lifecycle.run())
        await until(lambda: lifecycle.state == ConnectionManagerState.READY)
        slow = True
        updating = asyncio.create_task(lifecycle.refresh_metadata())
        await entered.wait()
        await client.disconnect()
        await until(lambda: client.attempts == 2)
        release.set()
        with self.assertRaises(ConnectionError):
            await updating
        await until(lambda: lifecycle.state == ConnectionManagerState.READY)
        self.assertEqual([generation for generation, _ in client.messages], [1, 1, 2, 2])
        await lifecycle.stop()

    async def test_invalid_options(self):
        for values in ({"initial_delay": 0}, {"jitter": float("nan")}, {"multiplier": .5}):
            with self.assertRaises(ValueError):
                RetryPolicy(**values)
        with self.assertRaises(ValueError):
            self.make(Client(), startup_timeout=0)
