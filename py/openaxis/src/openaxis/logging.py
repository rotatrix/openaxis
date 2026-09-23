"""Optional local diagnostic logging, shared by SDK events and host messages.

Call configure_logging once per integration. No networking is involved. Files
use UTC session names and retain ten sessions per client.
"""
from __future__ import annotations

from ._version import __version__

import atexit
import datetime as dt
import logging
import os
from pathlib import Path
import re
import sys
import threading

def normalize_level(level: str) -> str:
    level = level.lower()
    return {"warn": "warning", "critical": "error"}.get(level, level) if level in (
        "debug", "info", "warn", "warning", "error", "critical") else "info"


def format_record(level: str, message: str, now=None) -> str:
    now = now or dt.datetime.now().astimezone()
    if now.tzinfo is None:
        now = now.astimezone()
    offset = now.strftime("%z")
    stamp = now.strftime("%Y-%m-%d %H:%M:%S") + f".{now.microsecond // 1000:03d} {offset[:3]}:{offset[3:]}"
    message = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", message)
    message = message.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\n    ")
    return f"{stamp} {normalize_level(level).upper()} {message}\n"


__all__ = ["DiagnosticLog", "configure_logging", "default_log_directory", "normalize_level", "format_record"]


def default_log_directory() -> Path:
    if override := os.environ.get("ROTATRIX_LOG_DIR"):
        return Path(override)
    if sys.platform == "win32":
        root = Path(os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData/Local"))
    elif sys.platform == "darwin":
        root = Path.home() / "Library/Application Support"
    else:
        root = Path(os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local/share"))
    return root / "Rotatrix/logs"


_gate = threading.RLock()


class DiagnosticLog:
    """Best-effort rotating file sink; additional sinks receive (level, message).

    Ten sessions are retained per client, including the current session.
    Filesystem failures never escape write().
    """
    def __init__(self, client: str, *, directory=None, max_bytes=5 * 1024 * 1024,
                 keep=10, sinks=(), level="info", client_version=None):
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", client):
            raise ValueError("client must be a lowercase filename-safe identifier")
        if max_bytes <= 0 or keep < 0:
            raise ValueError("max_bytes must be positive and keep nonnegative")
        self.session_header = f"OpenAxis SDK {__version__} (Python); client={client}; client_version={client_version or 'unknown'}"
        self._header = format_record("info", self.session_header).encode("utf-8")
        self.path = None
        self.error = None
        self._closed = False
        self._gate = threading.RLock()
        self.max_bytes, self.sinks, self.level = max_bytes, list(sinks), level
        directory = (Path(directory) if directory is not None else default_log_directory()).absolute()
        try:
            directory.mkdir(parents=True, exist_ok=True)
            stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            base = f"{client}-{stamp}"
            with _gate:
                existing = [p for p in directory.glob(base + "*.log") if re.fullmatch(re.escape(base) + r"(?:-[0-9]+)?\.log", p.name)]
                first = max([int(p.stem[len(base)+1:] or 1) if p.stem != base else 1 for p in existing], default=0) + 1
                for index in range(first, first + 10000):
                    path = directory / f"{base}{'' if index == 1 else '-' + str(index)}.log"
                    try:
                        with path.open("xb") as file:
                            file.write(self._header)
                    except FileExistsError:
                        continue
                    self.path = path
                    break
                else:
                    raise OSError("No available log filename")
                self._cleanup(directory, client, keep, self.path)
        except OSError as error:
            self.error = str(error)
        atexit.register(self.close)

    @staticmethod
    def _cleanup(directory, client, keep, current):
        pattern = re.compile(re.escape(client) + r"-[0-9]{8}T[0-9]{6}Z(?:-[2-9][0-9]*|-[1-9][0-9]+)?\.log")
        def order(path):
            match = re.search(r"([0-9]{8}T[0-9]{6}Z)(?:-([0-9]+))?\.log$", path.name)
            return (match[1], int(match[2] or 1)) if match else ("", 0)
        retained = 1  # Always keep the session being created, even if the clock moved back.
        for path in sorted(directory.glob(f"{client}-*.log"), key=order, reverse=True):
            if not pattern.fullmatch(path.name) or path.is_symlink() or path == current:
                continue
            retained += 1
            if retained > max(1, keep):
                try:
                    path.unlink(missing_ok=True)
                    Path(str(path) + ".1").unlink(missing_ok=True)
                except OSError:
                    pass

    def write(self, level: str, message: str):
        level = normalize_level(level)
        if level == "debug" and self.level != "debug":
            return
        with self._gate:
            if self._closed:
                return
            if self.path is not None:
                try:
                    data = format_record(level, message).encode("utf-8", errors="replace")
                    # One oversized record is kept intact; the next write rotates it.
                    size = self.path.stat().st_size
                    if size > len(self._header) and size + len(data) > self.max_bytes:
                        self.path.replace(str(self.path) + ".1")
                        size = 0
                    with self.path.open("ab") as file:
                        if not size:
                            file.write(self._header)
                        file.write(data)
                    self.error = None
                except OSError as error:
                    self.error = str(error)
        for sink in tuple(self.sinks):
            try:
                sink(level, message)
            except Exception:
                pass

    def info(self, message): self.write("info", message)
    def warning(self, message): self.write("warning", message)
    def error_message(self, message): self.write("error", message)

    def close(self):
        with self._gate:
            self._closed = True


class _Handler(logging.Handler):
    def __init__(self, sink):
        super().__init__(logging.INFO)
        self.sink = sink

    def emit(self, record):
        self.sink.write(record.levelname, self.format(record))


_configured: dict[str, DiagnosticLog] = {}


def configure_logging(client: str, **options) -> DiagnosticLog:
    """Configure SDK logging once; return the same logger on repeated calls.

    SDK lifecycle and navigation diagnostics flow here automatically. Existing
    explicit callbacks remain overrides; use sinks= to mirror the file output.
    """
    with _gate:
        if client not in _configured or _configured[client]._closed:
            sink = DiagnosticLog(client, **options)
            _configured[client] = sink
        sink = _configured[client]
        logger = logging.getLogger("openaxis")
        for handler in tuple(logger.handlers):
            if isinstance(handler, _Handler):
                logger.removeHandler(handler)
        handler = _Handler(sink)
        handler.setLevel(logging.DEBUG if sink.level == "debug" else logging.INFO)
        logger.addHandler(handler)
        logger.setLevel(handler.level)
        logger.propagate = False
        return sink
