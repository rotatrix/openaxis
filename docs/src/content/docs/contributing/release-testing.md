---
title: Release testing
description: SDK tests, documentation checks, and platform coverage for reviewing an OpenAxis release.
---

Run release checks against the exact OpenAxis revision being reviewed. Use a
clean checkout and record its commit with `git rev-parse HEAD`. Run commands below
from the repository root, and stop to investigate any nonzero exit code before
continuing. Dependency installation and CMake configuration may access the network.

## Select package versions

Choose each changed package's version using the
[SDK versioning policy](/reference/language-support/#versioning). Coordinate
shared behavior changes across SDKs and their conformance fixtures; unchanged
packages do not need a release to match another package's version.

Record the released package versions and validated source commit in the release
notes. That commit also identifies the conformance fixtures used for validation.
Use package-specific release tags such as `python/v1.0.1`,
`typescript/v1.1.0`, `csharp/v1.0.1` and `cpp/v1.0.1`; use `protocol/v1.0.0`
for a specification release. Create public tags against the published source
commit. Published tags and package artifacts are immutable.

## Prerequisites

- Node.js 22.12+ and the pnpm version pinned in `package.json`.
- uv for an isolated Python environment; the Python SDK requires Python 3.11+.
- .NET SDK 8 or newer.
- CMake 3.24+ and a C++17 compiler: Visual Studio C++ Build Tools on Windows,
  Xcode command-line tools on macOS, or GCC/Clang on Linux.

## Automated checks

The public repository's **SDK packages** GitHub Actions workflow builds one
selected SDK, tests installation from its package archives, and runs its SDK
tests. Run it on `master` with **publish unchecked** to validate packaging without
uploading anything. With publication selected, a separate protected environment
job uses registry trusted publishing and tags the public commit after success.
Package installation checks supplement the platform and interactive checks below.

### TypeScript and documentation

Install dependencies from the lockfile, run the SDK tests, then build and check
the documentation and browser demos:

```sh
pnpm install --frozen-lockfile
pnpm -C ts/sdk test
pnpm build:site
```

The SDK command checks layer boundaries and API types as well as runtime behavior.
The site command checks documentation links, assets, fragments, source excerpts,
and assembled demo entry points. It does not exercise interactive browser behavior.

### Python

Create an isolated environment and install the SDK from this checkout. On Windows
PowerShell:

```powershell
uv venv .venv --python 3.11 --no-project
uv pip install --python .venv/Scripts/python.exe -e ./py/openaxis pytest
.\.venv\Scripts\python.exe -m pytest -c py/openaxis/pyproject.toml py/openaxis/tests
```

On macOS or Linux:

```sh
uv venv .venv --python 3.11 --no-project
uv pip install --python .venv/bin/python -e ./py/openaxis pytest
.venv/bin/python -m pytest -c py/openaxis/pyproject.toml py/openaxis/tests
```

Reuse an existing environment by skipping its creation. The explicit pytest
configuration prevents a parent repository's settings from affecting the run.
Use Python 3.11 to check the minimum supported version, and repeat with the newer
Python versions included in the release's support claims.

### C#

Run the conformance executable:

```sh
dotnet run --project cs/OpenAxis.ConformanceTests/OpenAxis.ConformanceTests.csproj
```

This project is a console test harness; its checks run through `dotnet run`.

### C++

Configure and build the SDK test targets, then run CTest:

```sh
cmake -S cpp -B cpp/build -DOPENAXIS_BUILD_TESTS=ON -DCMAKE_BUILD_TYPE=Release
cmake --build cpp/build --config Release
ctest --test-dir cpp/build -C Release --output-on-failure --no-tests=error
```

CMake can fetch pinned dependencies when they are unavailable locally. Use a fresh
build directory when switching compiler or architecture. These commands cover
SDK tests; the native reference viewer has separate build and interaction checks.

## Platform coverage

During development, run affected tests on your development platform. Before a
release, validate the same commit on every platform the release claims to support.
A Windows pass does not establish macOS or Linux compatibility.

| Area | Release coverage |
| --- | --- |
| Python, C#, and C++ SDKs | Run on each supported OS; cover supported runtimes and native compiler toolchains. |
| TypeScript SDK | Run Node tests on supported development platforms; exercise browser integrations in supported browsers. |
| Documentation and site assembly | One build platform is sufficient for content checks; smoke-test the resulting site in supported browsers. |
| Native binaries | Build and test each distributed OS/architecture combination, including ARM64 when shipped. |

Platform runs catch differences in sockets, filesystem behavior, asynchronous
scheduling, compilers, and runtimes. Record untested combinations explicitly;
planned platform support is not a passing test result.

## Integration smoke tests

Automated SDK tests establish protocol and state behavior. Use the
[integration validation guide](/guide/validation/) to check application behavior
with a running OpenAxis server and real input:

- Connect, disconnect, reconnect, and shut down without stale callbacks or hangs.
- Exercise camera and object navigation, picking, and concurrent native input.
- Check diagnostics and visible feedback in the browser demos and supported
  native application integrations.
- Test GUI examples on their supported operating systems and browser integrations
  in the browsers covered by the release.

## Record the results

For each release candidate, record the commit, OS and architecture, runtime and
compiler versions, commands run, results, and manual smoke tests performed.
Include failures, skipped checks, and known limitations. Investigate failures
before release; after a fix, rerun affected checks and update the tested revision.
