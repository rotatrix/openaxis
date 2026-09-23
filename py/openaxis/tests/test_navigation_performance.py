from openaxis._navigation_performance import PerformanceStream


def test_turnaround_uses_promoted_pose_arrival():
    stream = PerformanceStream()
    stream.receive(1, 0)
    stream.process(1, .002)
    # An awaited observation spans two newer arrivals. Only the newest is written.
    stream.receive(2, .050)
    stream.receive(3, .060)
    received_at = stream.process(3, .065)
    stream.applied(.065, .070, True, received_at)
    assert stream.turnaround.count == 1
    assert abs(stream.turnaround.total - 10) < 1e-9


def test_failed_or_unmeasured_write_is_not_zero_turnaround():
    stream = PerformanceStream()
    stream.receive(1, 10)
    received_at = stream.process(1, 10.001)
    stream.applied(10.001, 10.002, False, received_at)
    assert stream.turnaround.count == 0
    assert 'no updates applied' in stream.text('camera')
    assert 'writes 0 ok/1 failed' in stream.text('camera')


def test_zero_arrival_is_a_valid_timestamp():
    stream = PerformanceStream()
    stream.receive(1, 0)
    received_at = stream.process(1, .001)
    stream.applied(.001, .002, True, received_at)
    assert stream.turnaround.total == 2
