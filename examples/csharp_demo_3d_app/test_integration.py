"""Exercise the built C# viewer over a real local OpenAxis connection.

Uses the Python demo's msgpack/websockets test dependencies. Build C# first.
"""
import asyncio
import json
from pathlib import Path

import msgpack
from websockets.asyncio.server import serve


async def main():
    scene = json.loads((Path(__file__).parent.parent/'demo_3d_scene/scene.json').read_text())
    done = asyncio.get_running_loop().create_future()

    async def server(socket):
        async def send(**message):
            await socket.send(msgpack.packb(message, use_bin_type=True))

        async def receive(kind, predicate=lambda _: True):
            while True:
                message = msgpack.unpackb(await socket.recv(), raw=False)
                if message['type'] == kind and predicate(message):
                    return message

        try:
            hello = await receive('hello')
            assert hello['target']['app'] == 'csharp-demo-3d-app'
            await send(type='hello_ack', proto='openaxis/1.0', server_name='csharp-loopback')
            metadata = {}
            while len(metadata) < 3:
                message = msgpack.unpackb(await socket.recv(), raw=False)
                if message['type'] in ('tags', 'capabilities', 'focus'):
                    metadata[message['type']] = message
            assert metadata['tags']['tags'] == ['demo-3d-services']
            assert metadata['capabilities']['capabilities'] == ['navigation']
            await send(type='motion_start', gesture_id=1)
            await send(type='request', id=1, method='navigation.query', params=dict(
                gesture_id=1, values=['camera.pose', 'model.bounds'], first=['pick.viewport_center']))
            reply = await receive('response', lambda m: m['id'] == 1)
            assert reply['result']['first']['name'] == 'pick.viewport_center'
            assert all(abs(value) < 1e-6 for value in reply['result']['first']['value']['point'])
            assert reply['result']['values']['camera.pose']['fov'] == scene['camera']['fov']
            await send(type='camera.pivot', gesture_id=1, point=[0, 0, 1])
            await send(type='camera.pose', gesture_id=1, seq=1, t=[1, 0, 10], r=[0, 0, 0], fov=1)
            correction = await receive('camera.delta')
            assert abs(correction['t'][0]) > .01
            # Correction translation is relative to the last authoritative pose.
            await send(type='camera.pose', gesture_id=1, seq=2,
                       t=[1 + correction['t'][0], correction['t'][1], 10 + correction['t'][2]],
                       r=[0, 0, 0], fov=1, applied_delta_id=correction['delta_id'])
            await send(type='motion_end', gesture_id=1)
            await receive('tags', lambda m: 'interaction.object.translate' in m['tags'])
            await send(type='motion_start', gesture_id=2)
            await send(type='request', id=2, method='navigation.query', params=dict(
                gesture_id=2, values=['object.pose', 'object.bounds']))
            reply = await receive('response', lambda m: m['id'] == 2)
            assert reply['result']['values']['object.pose']['t'] == scene['objects'][0]['position']
            await send(type='object.pivot', gesture_id=2, point=[0, 0, 0])
            await send(type='object.pose', gesture_id=2, seq=1, t=[2, 0, 0], r=[0, 0, 0])
            correction = await receive('object.delta')
            assert correction['t'][0] > .01
            await send(type='object.pose', gesture_id=2, seq=2, t=[3, 0, 0], r=[0, 0, 0],
                       applied_delta_id=correction['delta_id'])
            await send(type='motion_end', gesture_id=2)
            await socket.wait_closed()
            done.set_result(None)
        except Exception as error:
            if not done.done():
                done.set_exception(error)

    dll = Path(__file__).parent / 'bin/Debug/net8.0/OpenAxisDemo.dll'
    async with serve(server, '127.0.0.1', 0) as endpoint:
        port = endpoint.sockets[0].getsockname()[1]
        process = await asyncio.create_subprocess_exec('dotnet', str(dll), '--test-integration', f'ws://127.0.0.1:{port}')
        try:
            await asyncio.wait_for(done, 20)
            assert await asyncio.wait_for(process.wait(), 5) == 0
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
    print('PASS: C# live OpenAxis loopback')


if __name__ == '__main__':
    asyncio.run(main())
