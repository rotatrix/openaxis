---
title: SDK logging contract
description: Shared logging behavior and conformance requirements across SDK languages.
---

# SDK diagnostic logging contract

This contract describes configured logging in Python, C++, C#, and TypeScript.
Language-specific API spelling and host logging adapters are not wire protocol.
Logging does not send messages over the OpenAxis connection.

## Common behavior

- Client names match ASCII `[a-z0-9][a-z0-9_-]*`; invalid names are rejected.
- Configure caches one logger per client within the loaded SDK. Calling configure
  again selects that logger as the default SDK destination. Construction options
  apply on its first configuration. Closing it allows a subsequent configuration
  to create a new session. Direct construction creates independent loggers.
- Explicit diagnostic callbacks remain overrides. Additional logger sinks mirror
  accepted messages, receiving normalized severity and the original message.
  One failing sink does not prevent delivery to other sinks.
- Severity is case-insensitive: debug, info, warning, error; warn maps to warning,
  critical maps to error, and unknown values map to info. Debug is off by default.
- Canonical records use local date/time with milliseconds, a separate numeric UTC
  offset, one space, uppercase severity,
  one space, message, and a final LF. CRLF and CR within messages become LF with four-space continuation indentation.
  ANSI styling is stripped from records:
  `2026-09-19 10:25:30.123 -04:00 INFO hello\n`.
- Close/dispose is idempotent and suppresses subsequent writes and sink calls.
  Configuration and sink mutation should happen on the host's setup thread;
  an already-running sink callback may finish during a concurrent close.

The portable message domain is valid Unicode (UTF-8 strings in C++). Runtime
handling of malformed strings and OS error text is not standardized. Configure
logging explicitly: unconfigured SDKs retain their language's host diagnostics
fallback. Existing UI formatting helpers are separate from canonical file records.

## Native filesystem profile: Python, C++, C#

| OS | Default directory | Fallback when the environment value is empty |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%/Rotatrix/logs` | `~/AppData/Local/Rotatrix/logs` |
| macOS | `~/Library/Application Support/Rotatrix/logs` | Same directory |
| Linux | `$XDG_DATA_HOME/Rotatrix/logs` | `~/.local/share/Rotatrix/logs` |

A nonempty `ROTATRIX_LOG_DIR`, or an explicit directory option, overrides this.
Relative paths resolve against the working directory; overrides are literal paths,
without shell expansion. Sandboxed hosts may have private user-data directories.

Session files are `<client>-YYYYMMDDTHHMMSSZ.log`, using UTC start time to seconds.
Exclusive creation resolves collisions with `-2`, `-3`, etc., before `.log`.
There is no PID, metadata manifest, or lock companion. Exclusive log-file creation
prevents simultaneous instances from claiming the same filename. Collision suffixes
advance past existing names rather than reusing gaps left by cleanup.

Records are UTF-8 without BOM, with LF on every platform. Writes are synchronous
and flushed to the runtime/OS before returning, without a durable disk sync.
The default size limit is 5,242,880 bytes with one `.log.1` backup. Rotate before
a write only when the existing file is nonempty and the combined byte count would
exceed the limit. An exact fit stays in place; an oversized record remains intact.
Every file starts with an INFO SDK version/language/client/client-version header.
The header is repeated after rotation with its original session timestamp, and its
bytes count toward the limit. A header-only file accepts one message even if their
combined size exceeds the limit, avoiding rotation of an empty session. Host client
version is optional and defaults to `unknown`. Native headers are written directly
to the file; browser headers go to configured sinks once at construction.

Startup cleanup retains ten sessions of the same client, including the newly
created session. Older sessions are ordered by filename timestamp and numeric
collision suffix; each deleted session loses its backup too. There is no active
writer protection: an older running instance can lose its log, after which file
writes report an error and mirrors continue. The session being created is always
kept, even if the system clock moved backwards. A custom `keep` of zero or one
keeps only that session. Symlink session files are skipped. Cleanup is not periodic.

Filesystem failures are best effort: expose an error, continue delivering mirrors,
and do not interrupt navigation. A successful subsequent file write clears the
error. Failure to create a session leaves the file path absent/empty. Invalid
configuration is a programming error and may throw. No background network upload
or central collector is involved.

## Browser profile: TypeScript

The common severity, formatting, filtering, sink isolation, configuration, and
close behavior applies. Default output is the browser console; explicit sinks
can route to UI. No native directory, file retention, rotation, or cross-process
locking is offered, including when this browser SDK is imported in Node.

## Navigation performance summaries

Navigation sessions collect performance statistics by default and emit one INFO
`navigation.performance` record after each gesture retires. Configure the SDK
logger to receive these records; no diagnostic collector or observer is required.
This applies to synchronous sessions in all four languages and to the implemented
async sessions. Camera and object statistics are separate within the same record.

The first line identifies the gesture, retirement reason and duration. Duration runs from the session's
acceptance of motion start to retirement. Reasons include `motion_end`,
`superseded`, `connection_changed`, `closed`, or the session's cancellation reason.
An already issued host operation is counted in its original gesture, even if it
returns after retirement; summary delivery waits for that operation to settle.
Closing or draining again does not repeat the summary. Empty gestures produce
zero counts. Timings are rounded to one decimal place; unused streams say
`no activity`. The entire multiline summary is one log record:

```text
navigation.performance gesture=7 reason=motion_end duration=750.0 ms
camera responsiveness: turnaround avg 312.5 ms, max 312.5 ms [1 applied]; pending poses replaced 66.7%
camera: poses 3, coalesced 2, writes 1 ok/0 failed
  timings avg/max ms [samples]: input gap 125.0/125.0 [2]; queue wait 125.0/125.0 [1]; observation 62.5/62.5 [1]; apply 125.0/125.0 [1]; apply gap 0.0/0.0 [0]
object: no activity
```

### Read the overall result

Start with **turnaround**: elapsed time from that pose's acceptance by the SDK
to completion of its successful host write. Lower values mean fresher poses reach
the host API sooner. This includes queueing and processing, but not server/device
latency or time until the rendered frame appears. Idle time before the pose arrives
is excluded. Unchanged poses that produce no write and failed writes are excluded;
their counts remain visible in the breakdown. With no successful writes, the
headline says `no updates applied`.

**Pending poses replaced** means coalescing: replacing an older pending pose with
the newest one while the host is busy. It prevents replaying a backlog. The
percentage is replacements divided by accepted poses, including idle arrivals;
it is not a failure rate or an active-motion frame-loss percentage. Read it beside
turnaround: low latency can coexist with many skipped intermediate poses.

Use queue wait, observation and apply below the headline to locate delays.
Their averages need not sum to turnaround because they cover different samples
and omit some SDK processing. Async promotion uses the replacement pose's own
arrival timestamp; a write already in progress keeps its original timestamp.
Sampling adds no clock reads and still emits only the final gesture summary.

### Find the source of delays

Each stream contains the following fields:

| Field | Measurement |
| --- | --- |
| `poses` | Poses accepted by the session; excludes stale or inactive output. |
| `coalesced` | Poses replaced by newer output in a pending slot, including pivot-deferred poses and async latest-pose promotion. Retirement discards are excluded. |
| `writes N ok/M failed` | Completed adapter write calls, including exceptions as failures. |
| `input gap` | Intervals between accepted poses at the SDK callback boundary. |
| `queue wait` | Time from acceptance to starting host processing for a pose. Includes waiting for a required pivot. An async pose promoted after observation is sampled when promoted. |
| `observation` | Time inside the configured camera/object observation callback, including failed or unavailable reads. Query reads are covered by existing fact/query logs. |
| `apply` | Time inside the adapter write call, including any readback performed by that adapter. |
| `apply gap` | Intervals between adapter write-call starts. |

Each breakdown timing shows average/maximum milliseconds followed by its sample count in
brackets. A zero count means no
samples; its average and maximum are also zero. A pose can reach processing yet
produce no write because reconciliation holds it or the pose is unchanged.
Async promotion can replace a pose after its observation began, so queue-wait
counts need not equal write counts.

Times use a local monotonic clock. Async call durations include time awaiting
completion. They measure host API elapsed time, not CPU utilization, rendered
frame rate, network latency, or end-to-end device latency. The server can continue sending unchanged poses while idle. Input gap measures
arrival cadence; apply gap grows when unchanged poses skip writes, so neither
is an overall responsiveness score.

Collection uses fixed-size counters and timestamps per gesture, without extra
host reads, polling, or per-frame performance records. Serialization and log
output happen only on retirement. Debug logging does not enable per-frame write
records; write failures and readback-status changes remain diagnostic events.


## Conformance

All four suites consume `fixtures/openaxis-1.0/logging.json` for canonical records,
aliases, filtering, invalid names, and configuration lifecycle. Native suites also
exercise shared byte-boundary rotation and numeric retention-order cases.
Coordinator suites also consume `fixtures/openaxis-1.0/performance.json` to check
summary timing, coalescing, stream separation and retirement through real sessions.

Run Python pytest, TypeScript `pnpm test`, C# `dotnet run --project
cs/OpenAxis.ConformanceTests`, and C++ CTest in a Debug build (assertions enabled).
After building native test executables, run `tools/logging_interop.py --cpp
<logging-test-executable> --csharp <conformance-dll>` with Python and dotnet on PATH.
It checks all nine owner/cleaner combinations, reclaiming older sessions even while their writers remain running, without
creating lock files. Run this matrix on each supported OS.
