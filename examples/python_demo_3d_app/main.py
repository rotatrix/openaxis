"""Run with: python examples/python_demo_3d_app/main.py"""
import argparse
import asyncio
import logging
from application import MyApplication
from integration import MyOpenAxisIntegration

async def main(url):
    app = MyApplication()
    integration = MyOpenAxisIntegration(app, url)
    # The application starts its event loop before loading the integration.
    # Without OpenAxis, this is simply: await app.run()
    await app.run(on_started=integration.start, on_stopping=integration.stop)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='OpenAxis Python demo 3D app')
    parser.add_argument('--url', default='ws://127.0.0.1:6607')
    parser.add_argument('--debug',action='store_true',help='Log per-query diagnostic evidence')
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.debug else logging.INFO)
    asyncio.run(main(args.url))
