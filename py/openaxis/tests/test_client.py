import asyncio
import threading
import unittest

import msgpack
from openaxis.client import OpenAxisClient, OpenAxisListener, RpcRequestError
from openaxis.navigation import NavigationQuery
from openaxis.types import (
    CameraNavigationState,
    MotionEnd,
    MotionStart,
    NavigationState,
    Request,
    Response,
    RpcError,
)


class _Socket:
    def __init__(self):
        self.messages: list[bytes] = []

    async def send(self, message: bytes):
        self.messages.append(message)


class _RequestListener(OpenAxisListener):
    def __init__(self, handled: bool):
        self.handled = handled
        self.requests: list[Request] = []

    def on_request(self, request: Request) -> bool:
        self.requests.append(request)
        return self.handled


class _StateListener(OpenAxisListener):
    def __init__(self):
        self.states: list[NavigationState] = []

    def on_navigation_state(self, state: NavigationState) -> None:
        self.states.append(state)


class _MotionListener(OpenAxisListener):
    def __init__(self):
        self.events: list[tuple[str, int]] = []

    def on_motion_start(self, gesture_id: int) -> None:
        self.events.append(("start", gesture_id))

    def on_motion_end(self, gesture_id: int) -> None:
        self.events.append(("end", gesture_id))


class _NavigationQueryListener(OpenAxisListener):
    def __init__(self):
        self.queries: list[NavigationQuery] = []

    def on_navigation_query(self, query: NavigationQuery) -> bool:
        self.queries.append(query)
        return True


class _ExtensionListener(OpenAxisListener):
    def __init__(self):
        self.messages: list[tuple[str, dict]] = []

    def on_extension(self, message_type: str, message: dict) -> None:
        self.messages.append((message_type, message))


class ClientRpcTest(unittest.IsolatedAsyncioTestCase):
    async def test_hello_versions_and_sdk_identity(self):
        from unittest.mock import AsyncMock, patch
        from openaxis._version import __version__
        from openaxis.types import Target, MAX_INTEGER

        socket = AsyncMock()
        socket.recv.return_value = msgpack.packb({"type": "hello_ack", "proto": "openaxis/1.0", "server_name": "test"})
        client = OpenAxisClient(client_name="Plugin", client_version="2.3.4",
                                target=Target(app="CAD", app_version="2027.1"))
        with patch("openaxis.client.websockets.connect", AsyncMock(return_value=socket)), \
             patch.object(client, "_verify_connection", AsyncMock()):
            await client.connect()
            hello = msgpack.unpackb(socket.send.call_args_list[0].args[0], raw=False)
            assert hello["client_version"] == "2.3.4"
            assert hello["target"]["app_version"] == "2027.1"
            assert hello["sdk"] == {"name": "openaxis-python", "version": __version__}
            await client.disconnect()
        client._next_request_id = MAX_INTEGER
        assert client._allocate_request_id() == MAX_INTEGER
        with self.assertRaises(OverflowError):
            client._allocate_request_id()

    async def _wait_for_message(self, socket: _Socket) -> None:
        for _ in range(5):
            if socket.messages:
                return
            await asyncio.sleep(0)
        self.fail("OpenAxis response was not sent")

    async def test_namespaced_extension_is_available_to_specialized_listener(self):
        listener = _ExtensionListener()
        client = OpenAxisClient(client_name="test", listener=listener)
        wire = msgpack.packb(
            {"type": "com.rotatrix.mfg.telemetry", "seq": 4},
            use_bin_type=True,
        )
        client._handle_message(wire)
        self.assertEqual(
            listener.messages,
            [
                (
                    "com.rotatrix.mfg.telemetry",
                    {"type": "com.rotatrix.mfg.telemetry", "seq": 4},
                )
            ],
        )

    async def test_navigation_state_dispatch(self):
        listener = _StateListener()
        client = OpenAxisClient(client_name="test", listener=listener)
        state = NavigationState(
            gesture_id=8,
            camera=CameraNavigationState(mode="orbit"),
        )
        client._dispatch_message(state)
        self.assertEqual(listener.states, [state])

    async def test_motion_start_can_atomically_supersede_active_gesture(self):
        listener = _MotionListener()
        client = OpenAxisClient(client_name="test", listener=listener)

        client._dispatch_message(MotionStart(gesture_id=4))
        client._dispatch_message(MotionStart(gesture_id=5))
        client._dispatch_message(MotionEnd(gesture_id=5))

        self.assertEqual(
            listener.events,
            [("start", 4), ("start", 5), ("end", 5)],
        )

    async def test_request_is_correlated_with_interleaved_response(self):
        client = OpenAxisClient(client_name="test")
        socket = _Socket()
        client._ws = socket

        pending = asyncio.create_task(
            client.request(
                "command.execute",
                {"name": "navigation.pivot.clear"},
                timeout=1,
            )
        )
        await asyncio.sleep(0)
        wire_request = msgpack.unpackb(socket.messages[0], raw=False)
        self.assertEqual(wire_request["method"], "command.execute")

        client._dispatch_message(
            Response(
                id=wire_request["id"],
                result={"accepted": True},
            )
        )
        self.assertEqual(await pending, {"accepted": True})

    async def test_request_error_raises_typed_exception(self):
        client = OpenAxisClient(client_name="test")
        socket = _Socket()
        client._ws = socket
        pending = asyncio.create_task(client.request("future.method", timeout=1))
        await asyncio.sleep(0)
        request = msgpack.unpackb(socket.messages[0], raw=False)
        client._dispatch_message(
            Response(
                id=request["id"],
                error=RpcError("unsupported"),
            )
        )
        with self.assertRaises(RpcRequestError) as caught:
            await pending
        self.assertEqual(caught.exception.code, "unsupported")

    async def test_send_viewport_settled(self):
        client = OpenAxisClient(client_name="test")
        socket = _Socket()
        client._ws = socket
        await client.send_viewport_settled()
        self.assertEqual(
            msgpack.unpackb(socket.messages[0], raw=False),
            {"type": "viewport.settled"},
        )

    async def test_unhandled_incoming_request_gets_correlated_error(self):
        listener = _RequestListener(handled=False)
        client = OpenAxisClient(client_name="test", listener=listener)
        socket = _Socket()
        client._ws = socket
        client._dispatch_message(Request(id=9, method="future.method"))
        await asyncio.sleep(0)

        response = msgpack.unpackb(socket.messages[0], raw=False)
        self.assertEqual(response["id"], 9)
        self.assertEqual(response["error"]["code"], "unsupported")

    async def test_navigation_query_can_complete_from_application_thread(self):
        listener = _NavigationQueryListener()
        client = OpenAxisClient(client_name="test", listener=listener)
        socket = _Socket()
        client._ws = socket
        client._dispatch_message(
            Request(
                id=10,
                method="navigation.query",
                params={"gesture_id": 3, "values": ["camera.pose"]},
            )
        )
        self.assertEqual(len(listener.queries), 1)
        query = listener.queries[0]

        thread = threading.Thread(
            target=query.complete,
            args=({"values": {"camera.pose": {"t": [0, 0, 0]}}},),
        )
        thread.start()
        thread.join()
        await self._wait_for_message(socket)

        response = msgpack.unpackb(socket.messages[0], raw=False)
        self.assertEqual(response["id"], 10)
        self.assertEqual(response["result"]["values"]["camera.pose"]["t"], [0, 0, 0])

    async def test_invalid_navigation_query_gets_bad_request(self):
        listener = _NavigationQueryListener()
        client = OpenAxisClient(client_name="test", listener=listener)
        socket = _Socket()
        client._ws = socket
        client._dispatch_message(
            Request(
                id=11,
                method="navigation.query",
                params={"values": "camera.pose"},
            )
        )
        await self._wait_for_message(socket)

        self.assertEqual(listener.queries, [])
        response = msgpack.unpackb(socket.messages[0], raw=False)
        self.assertEqual(response["id"], 11)
        self.assertEqual(response["error"]["code"], "bad_request")


if __name__ == "__main__":
    unittest.main()
