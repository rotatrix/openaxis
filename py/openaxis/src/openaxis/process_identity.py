"""Process identities for local foreground routing (no transport dependencies)."""
import os
import re
import sys
from pathlib import Path

__all__ = ["current_process_id", "process_id"]

def process_id(pid: int) -> str:
    """Identify a PID visible to this process; raises if identity is unavailable.

    Linux reads the target's innermost namespace and PID from this procfs view.
    """
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        raise ValueError("PID must be positive")
    if sys.platform == "linux":
        target = Path("/proc") / str(pid)
        namespace = os.readlink(target / "ns/pid")
        match = re.fullmatch(r"pid:\[([1-9][0-9]*)\]", namespace)
        if not match:
            raise RuntimeError("PID namespace unavailable")
        for line in (target / "status").read_text().splitlines():
            if line.startswith("NSpid:"):
                local = line.split()[-1]
                if re.fullmatch(r"[1-9][0-9]*", local):
                    return f"{match[1]}:{local}"
        raise RuntimeError("Namespace-local PID unavailable")
    if sys.platform in {"win32", "darwin"}:
        return str(pid)
    raise RuntimeError("Unsupported process identity platform")

def current_process_id() -> str:
    """Return the current process's canonical target.pid string."""
    if sys.platform == "linux":
        namespace = os.readlink("/proc/self/ns/pid")
        match = re.fullmatch(r"pid:\[([1-9][0-9]*)\]", namespace)
        if not match:
            raise RuntimeError("PID namespace unavailable")
        return f"{match[1]}:{os.getpid()}"
    return process_id(os.getpid())
