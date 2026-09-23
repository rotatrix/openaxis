"""Check every native writer/cleaner pairing, including cleanup of running sessions.

Run after building the C++ logging tests and C# conformance executable:
python tools/logging_interop.py --cpp cpp/build/Debug/openaxis_logging_tests.exe \
    --csharp cs/OpenAxis.ConformanceTests/bin/Debug/net8.0/OpenAxis.ConformanceTests.dll
"""
import argparse
import concurrent.futures
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cpp", required=True)
    parser.add_argument("--csharp", required=True)
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1] / "py/openaxis/src"
    env = dict(os.environ, PYTHONPATH=str(source), PYTHONIOENCODING="utf-8")
    python = [sys.executable, "-u", "-c", "from openaxis.logging import DiagnosticLog; import sys; "
              "s=DiagnosticLog('interop',directory=sys.argv[1],max_bytes=100,keep=0 if sys.argv[2]=='cleanup' else 5); "
              "assert s.path is not None,s.error; s.info('probe'); print(s.path,flush=True); "
              "input() if sys.argv[2]=='hold' else None; s.close()"]
    commands = {"python": python, "cpp": [args.cpp, "--log-probe"],
                "csharp": ["dotnet", args.csharp, "--log-probe"]}
    for owner, start in commands.items():
        for cleaner, clean in commands.items():
            with tempfile.TemporaryDirectory(prefix="openaxis-interop-") as directory:
                process = subprocess.Popen([*start, directory, "hold"], env=env,
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    text=True, encoding="utf-8")
                try:
                    with concurrent.futures.ThreadPoolExecutor() as pool:
                        try:
                            ready = pool.submit(process.stdout.readline).result(timeout=15).strip()
                        except TimeoutError:
                            process.kill()
                            raise
                    if not ready:
                        raise RuntimeError(f"{owner} failed: {process.stderr.read()}")
                    path = Path(ready)
                    assert path.is_file(), ready
                    subprocess.run([*clean, directory, "cleanup"], env=env, check=True,
                                   capture_output=True, timeout=15)
                    assert not path.exists(), f"{cleaner} retained old {owner} log"
                    assert len(list(Path(directory).glob("*.log"))) == 1
                    assert not list(Path(directory).glob("*.lock"))
                    print(f"{owner} -> {cleaner}: old session reclaimed without lock files")
                finally:
                    if process.poll() is None:
                        process.kill(); process.wait(timeout=15)
                    for stream in (process.stdin, process.stdout, process.stderr):
                        stream.close()


if __name__ == "__main__":
    main()
