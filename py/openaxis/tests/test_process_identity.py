import os
import sys
from pathlib import Path
import pytest
from openaxis.process_identity import current_process_id, process_id
from openaxis.types import Target

def test_current_identity():
    value = current_process_id()
    assert Target(pid=value).pack()["pid"] == value
    if sys.platform == "linux":
        namespace = os.readlink("/proc/self/ns/pid")[5:-1]
        assert value == f"{namespace}:{os.getpid()}"
    else:
        assert value == str(os.getpid())

def test_host_pid_maps_to_inner_namespace(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(os, "readlink", lambda path: "pid:[4026533054]")
    monkeypatch.setattr(Path, "read_text", lambda path: "Name: FreeCAD\nNSpid: 54541 17 2\n")
    assert process_id(54541) == "4026533054:2"

def test_missing_namespace_does_not_fall_back(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    def missing(path):
        raise FileNotFoundError(path)
    monkeypatch.setattr(os, "readlink", missing)
    with pytest.raises(OSError):
        current_process_id()
