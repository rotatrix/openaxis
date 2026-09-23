import datetime as dt
import logging
from pathlib import Path
import subprocess
import sys

import pytest

from openaxis.logging import DiagnosticLog, configure_logging


def test_session_header_identifies_sdk_client_and_survives_rotation(tmp_path):
    from openaxis._version import __version__
    log = DiagnosticLog('header-test', directory=tmp_path, client_version='2.3.4', max_bytes=1)
    header = log.path.read_text()
    assert f'OpenAxis SDK {__version__} (Python); client=header-test; client_version=2.3.4' in header
    log.info('first')
    log.info('second')
    assert log.path.read_text().startswith(header)
    assert Path(str(log.path) + '.1').read_text().startswith(header)
    assert log.path.read_text().endswith('INFO second\n')
    log.close()


def test_collision_rotation_and_mirror(tmp_path, monkeypatch):
    from openaxis import logging as module
    class Frozen(dt.datetime):
        @classmethod
        def now(cls, tz=None): return cls(2026, 9, 19, 14, 25, 30, tzinfo=tz)
    monkeypatch.setattr(module.dt, "datetime", Frozen)
    seen = []
    a = DiagnosticLog("fusion", directory=tmp_path, max_bytes=80, sinks=[lambda *v: seen.append(v)])
    b = DiagnosticLog("fusion", directory=tmp_path)
    try:
        assert a.path.name == "fusion-20260919T142530Z.log"
        assert b.path.name == "fusion-20260919T142530Z-2.log"
        a.info("first " + "x" * 40)
        a.info("second " + "y" * 40)
        assert "first" in Path(str(a.path) + ".1").read_text()
        assert "second" in a.path.read_text()
        assert "OpenAxis SDK" in b.path.read_text()
        assert len(seen) == 2
    finally:
        a.close(); b.close()


def test_cleanup_keeps_ten_sessions_without_active_protection(tmp_path):
    active = DiagnosticLog("fusion", directory=tmp_path)
    active.info("still running")
    created = {active.path}
    for _ in range(12):
        log = DiagnosticLog("fusion", directory=tmp_path)
        assert log.path not in created
        created.add(log.path)
        log.close()
    try:
        assert not active.path.exists()
        assert len(list(tmp_path.glob("*.log"))) == 10
        assert not list(tmp_path.glob("*.lock"))
        mirrored = []
        active.sinks.append(lambda *record: mirrored.append(record))
        active.info("after cleanup")
        assert active.error and mirrored == [("info", "after cleanup")]
        assert not active.path.exists()
    finally:
        active.close()


def test_other_process_can_clean_old_session(tmp_path):
    active = DiagnosticLog("fusion", directory=tmp_path)
    try:
        subprocess.run([sys.executable, "-c",
            "from openaxis.logging import DiagnosticLog; import sys; "
            "s=DiagnosticLog('fusion',directory=sys.argv[1],keep=0); s.close()", str(tmp_path)], check=True)
        assert not active.path.exists()
    finally:
        active.close()
    cleanup = DiagnosticLog("fusion", directory=tmp_path, keep=0)
    try:
        assert not active.path.exists()
    finally:
        cleanup.close()


def test_sdk_events_route_automatically(tmp_path):
    sink = configure_logging("test-app", directory=tmp_path)
    from openaxis.navigation_diagnostics import NavigationDiagnostics
    logging.getLogger("openaxis").warning("transport error")
    NavigationDiagnostics().observe("gesture_started", gesture_id=1)
    text = sink.path.read_text()
    assert "transport error" in text and "gesture_started" in text
    sink.close()


def test_disk_failure_still_mirrors(tmp_path):
    path = tmp_path / "not-a-directory"
    path.write_text("existing data")
    seen = []
    sink = DiagnosticLog("test", directory=path, sinks=[lambda *v: seen.append(v)])
    sink.info("message")
    assert sink.error and seen == [("info", "message")]
    sink.close()


@pytest.mark.parametrize("name", ["../escape", "UPPER", "", "a/b"])
def test_invalid_client(name, tmp_path):
    with pytest.raises(ValueError): DiagnosticLog(name, directory=tmp_path)


def test_shared_logging_contract(tmp_path):
    import json, re
    from openaxis.logging import format_record, normalize_level
    fixture = json.loads((Path(__file__).parents[3] / "fixtures/openaxis-1.0/logging.json").read_text())
    now = dt.datetime.fromtimestamp(fixture["epoch_ms"] / 1000, dt.timezone(dt.timedelta(minutes=fixture["offset_minutes"])))
    records = []
    sink = DiagnosticLog("conformance", directory=tmp_path, sinks=[lambda *v: records.append(v)])
    expected = ""
    try:
        for record in fixture["records"]:
            assert normalize_level(record["level"]) == record["normalized"]
            assert format_record(record["level"], record["message"], now) == record["line"]
            sink.write(record["level"], record["message"])
            if record["normalized"] in fixture["debug_off"]: expected += record["line"]
        complete = sink.path.read_bytes().decode("utf-8")
        actual = complete.split("\n", 1)[1]
        assert re.sub(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} [+-]\d\d:\d\d", fixture["stamp"], actual) == expected
        before = len(records)
        sink.close(); sink.write("info", "after close")
        assert len(records) == before
        assert sink.path.read_bytes().decode("utf-8") == complete
        for name in fixture["invalid_clients"]:
            with pytest.raises(ValueError): DiagnosticLog(name, directory=tmp_path)
        configured = [configure_logging(name, directory=tmp_path) for name in fixture["configuration"]]
        assert configured[0] is configured[2] and configured[0] is not configured[1]
        logging.getLogger("openaxis").info("reactivated")
        assert "reactivated" in configured[0].path.read_text()
        assert "reactivated" not in configured[1].path.read_text()
        configured[0].close()
        fresh = configure_logging(fixture["configuration"][0], directory=tmp_path)
        assert fresh is not configured[0]
        fresh.close(); configured[1].close()
    finally:
        sink.close()


def test_shared_native_retention_and_boundary(tmp_path):
    import json
    f = json.loads((Path(__file__).parents[3] / "fixtures/openaxis-1.0/logging.json").read_text())
    for i in range(1, 13):
        name = "retention-20200101T000000Z" + ("" if i == 1 else f"-{i}") + ".log"
        (tmp_path / name).write_bytes(b"")
    log = DiagnosticLog("retention", directory=tmp_path)
    assert log.max_bytes == f["defaults"]["max_bytes"]
    expected = {f"retention-20200101T000000Z-{i}.log" for i in f["retained_suffixes"]}
    assert {p.name for p in tmp_path.glob("retention-2020*.log")} == expected
    log.close()
    r = f["rotation"]
    log = DiagnosticLog("boundary", directory=tmp_path, max_bytes=r["max_bytes"])
    header_bytes = log.path.stat().st_size
    log.max_bytes += header_bytes
    for _ in range(r["writes_before_rotation"]): log.info(r["message"])
    assert log.path.stat().st_size == r["max_bytes"] + header_bytes
    assert not Path(str(log.path) + ".1").exists()
    log.info(r["message"])
    assert Path(str(log.path) + ".1").stat().st_size == r["max_bytes"] + header_bytes
    log.close()
