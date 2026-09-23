"""Fixed-size navigation counters. Owners serialize access; only flush logs."""
import logging


class Timing:
    def __init__(self):
        self.count = self.total = self.maximum = 0

    def add(self, seconds):
        ms = max(0, seconds * 1000)
        self.count += 1
        self.total += ms
        self.maximum = max(self.maximum, ms)

    def text(self):
        return f'{self.total / self.count if self.count else 0:.1f}/{self.maximum:.1f} [{self.count}]'



class PerformanceStream:
    def __init__(self):
        self.received = self.coalesced = self.succeeded = self.failed = 0
        self.incoming_gap, self.queue_wait = Timing(), Timing()
        self.observation, self.apply, self.apply_start_gap = Timing(), Timing(), Timing()
        self.turnaround = Timing()
        self.last_received = self.last_apply = self.pending = None
        self.queued_at = 0

    def is_pending(self, sequence):
        return self.pending == sequence

    def receive(self, sequence, now):
        self.received += 1
        if self.last_received is not None:
            self.incoming_gap.add(now - self.last_received)
        self.last_received = self.queued_at = now
        self.pending = sequence

    def process(self, sequence, now):
        if self.pending == sequence:
            self.queue_wait.add(now - self.queued_at)
            self.pending = None
            return self.queued_at
        return None

    def applied(self, start, end, success, received_at=None):
        if self.last_apply is not None:
            self.apply_start_gap.add(start - self.last_apply)
        self.last_apply = start
        self.apply.add(end - start)
        if success:
            self.succeeded += 1
            if received_at is not None:
                self.turnaround.add(end - received_at)
        else:
            self.failed += 1

    def text(self, name):
        if not self.received and not self.observation.count and not self.apply.count:
            return f'{name}: no activity'
        overall = (f'turnaround avg {self.turnaround.total / self.turnaround.count:.1f} ms, max {self.turnaround.maximum:.1f} ms [{self.turnaround.count} applied]'
                   if self.turnaround.count else 'no updates applied')
        replaced = 100 * self.coalesced / self.received if self.received else 0
        return (f'{name} responsiveness: {overall}; pending poses replaced {replaced:.1f}%\n'
                f'{name}: poses {self.received}, coalesced {self.coalesced}, writes {self.succeeded} ok/{self.failed} failed\n'
                f'  timings avg/max ms [samples]: input gap {self.incoming_gap.text()}; queue wait {self.queue_wait.text()}; '
                f'observation {self.observation.text()}; apply {self.apply.text()}; apply gap {self.apply_start_gap.text()}')



class Gesture:
    def __init__(self, gesture_id, token, now):
        self.gesture_id, self.token, self.started = gesture_id, token, now
        self.camera, self.object = PerformanceStream(), PerformanceStream()
        self.reason, self.ended = '', now

    def text(self):
        return (f'navigation.performance gesture={self.gesture_id} reason={self.reason} '
                f'duration={max(0, (self.ended - self.started) * 1000):.1f} ms\n'
                f'{self.camera.text("camera")}\n{self.object.text("object")}')



class NavigationPerformance:
    def __init__(self):
        self.active = None
        self.retired = []

    def begin(self, gesture_id, token, now):
        self.finish('superseded', now)
        self.active = Gesture(gesture_id, token, now)

    def stream(self, token, objects=False):
        g = self.active
        return (g.object if objects else g.camera) if g and g.token == token else None

    def finish(self, reason, now, token=None):
        if self.active is None or (token is not None and self.active.token != token):
            return
        g, self.active = self.active, None
        g.reason, g.ended = reason, now
        self.retired.append(g)

    def take(self):
        if not self.retired:
            return ()
        retired, self.retired = self.retired, []
        return retired

    @staticmethod
    def flush(retired):
        for g in retired:
            try:
                logging.getLogger('openaxis').info(g.text())
            except Exception:
                pass  # Host logging handlers must not affect navigation.
