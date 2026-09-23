"""Runnable single-thread adapter example. Use --selftest or --url ws://localhost:6607.

This application owns the event loop, camera and scheduler. OpenAxis owns query
completion and navigation sequencing. A CAD add-in must dispatch to its CAD UI
thread instead of using this example's asyncio loop as its application thread.
"""
import argparse
import asyncio
import time

import msgpack
from websockets.asyncio.server import serve

from openaxis.client import OpenAxisClient
from openaxis.navigation import UNAVAILABLE
from openaxis.navigation_session import NavigationSession, WriteResult
from openaxis.types import CameraPose


class ApplicationScheduler:
    def __init__(self, loop):
        self.loop = loop

    def post(self, callback):
        self.loop.call_soon_threadsafe(callback)  # Always deferred, never inline.

    def post_at(self, deadline, callback):
        self.loop.call_soon_threadsafe(
            lambda: self.loop.call_later(max(0, deadline - time.monotonic()), callback))


class MemoryViewport:
    def __init__(self):
        self.camera = CameraPose(t=(0, 0, 10), fov=1.0)
        self.pivot = None


class CameraAdapter:
    def __init__(self):
        self.viewport = MemoryViewport()
        self.applied = asyncio.Event()

    def capture_context(self):
        return self.viewport

    def is_current(self, context):
        return context is self.viewport

    def read(self, context):
        return context.camera

    def begin_query(self, context):
        initial = self.read(context)

        class Capture:
            def resolve(self, name):
                return {
                    "world.orientation": {"forward": (0, 0, -1), "up": (0, 1, 0), "handedness": "right"},
                    "camera.pose": initial.value(),
                    "viewport.aspect": 16 / 9,
                }.get(name, UNAVAILABLE)

            def initial_camera_observation(self):
                return initial
        return Capture()

    def apply_camera(self, context, desired, navigation, pivot):
        context.camera = desired
        self.applied.set()
        return WriteResult(True, self.read(context))

    def show_pivot(self, context, point):
        context.pivot = point


async def run_client(url, adapter, finished=None):
    client = OpenAxisClient(client_name="memory-camera", url=url)
    scheduler = ApplicationScheduler(asyncio.get_running_loop())
    session = NavigationSession(client, adapter, scheduler, observation=adapter.read)
    try:
        await client.connect()
        await client.send_tags(["app.memory-camera"])
        await client.send_capabilities(["navigation"])
        await client.send_focus(True)
        await (finished if finished is not None else asyncio.Future())
    finally:
        session.close()
        await asyncio.sleep(0)  # Let the application's deferred cleanup run.
        await client.disconnect()


async def selftest():
    adapter = CameraAdapter()
    finished = asyncio.get_running_loop().create_future()

    async def server(socket):
        async def send(value):
            await socket.send(msgpack.packb(value, use_bin_type=True))
        try:
            hello = msgpack.unpackb(await socket.recv(), raw=False)
            assert hello["type"] == "hello"
            await send({"type": "hello_ack", "proto": "openaxis/1.0", "server_name": "sample-selftest"})
            await send({"type": "motion_start", "gesture_id": 1})
            await send({"type": "request", "id": 1, "method": "navigation.query",
                        "params": {"gesture_id": 1, "values": ["camera.pose"]}})
            while True:
                reply = msgpack.unpackb(await socket.recv(), raw=False)
                if reply["type"] == "response":
                    assert reply["result"]["values"]["camera.pose"]["t"] == [0, 0, 10]
                    break
            await send({"type": "camera.pose", "gesture_id": 1, "seq": 1,
                        "t": [3, 0, 10], "r": [0, 0, 0], "fov": 1.0})
            await asyncio.wait_for(adapter.applied.wait(), 2)
            assert adapter.viewport.camera.t == (3, 0, 10)
            await send({"type": "motion_end", "gesture_id": 1})
            finished.set_result(None)
            await socket.wait_closed()
        except Exception as error:
            if not finished.done():
                finished.set_exception(error)

    async with serve(server, "127.0.0.1", 0) as server_instance:
        port = server_instance.sockets[0].getsockname()[1]
        await asyncio.wait_for(run_client(f"ws://127.0.0.1:{port}", adapter, finished), 5)
    print("PASS: real handshake, scoped query, camera write, and shutdown")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--url", default="ws://127.0.0.1:6607")
    args = parser.parse_args()
    try:
        asyncio.run(selftest() if args.selftest else run_client(args.url, CameraAdapter()))
    except KeyboardInterrupt:
        pass
