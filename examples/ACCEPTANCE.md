# Manual demo checks

Run `pnpm demo` from your working checkout. The menu incrementally builds each
selected viewer before launching it. Multiple viewers can stay open for focus
checks. Quit stops native viewers and the browser server; close browser tabs yourself.

For an already-built candidate, use `pnpm demo --no-build` in its export directory
to exercise the existing outputs. This also avoids rebuilding Linux container
outputs with a different host toolchain. The release log prints that directory.
Python uses the checkout's venv (a separate `.venv-host` for Linux container exports).

Start installed Rotatrix and connect a device. The default endpoint is
`ws://127.0.0.1:6607`; override it with `pnpm demo --url ws://host:port`.

For each browser, Python, C++, and C# viewer:

1. Focus the viewer; orbit, pan, zoom, and release the controls.
2. Alternate mouse and device navigation; check for stale-pose jumps.
3. Resize, switch projection, and reset; check navigation and pivots.
4. Edit an object: rotate, translate, accept, cancel, and undo.
5. Launch a second viewer; switch focus between both and another application.
6. Restart Rotatrix with viewers open; check recovery.
7. Close and reopen the viewer; check shutdown and reconnection.
8. In the browser, switch tabs and navigate away and back.

Record the candidate revision, OS, installed Rotatrix version, and findings in
your release notes. Automated test success does not establish manual acceptance.
Linux viewers need a graphical desktop and host OpenGL drivers.
