using System;
using System.Collections.Generic;
using System.Globalization;
using OpenAxis.Diagnostics;

namespace OpenAxis.Navigation
{
    // Receive/lifecycle calls use the session lock; completed operation timings
    // and report delivery belong to its serialized drain. No host calls here.
    internal sealed class PerformanceTiming
    {
        internal long Count;
        internal double Total, Max;
        internal void Add(double seconds) { var ms = Math.Max(0, seconds * 1000); Count++; Total += ms; Max = Math.Max(Max, ms); }
        internal string Text() => (Count == 0 ? 0 : Total / Count).ToString("F1", CultureInfo.InvariantCulture) + "/" + Max.ToString("F1", CultureInfo.InvariantCulture) + " [" + Count + "]";
    }
    internal sealed class PerformanceStream
    {
        internal long Received, Coalesced, Succeeded, Failed;
        internal readonly PerformanceTiming IncomingGap = new(), QueueWait = new(), Observation = new(), Apply = new(), ApplyStartGap = new(), Turnaround = new();
        private double? _lastReceived, _lastApply;
        private long? _pending;
        private double _queuedAt;
        internal bool IsPending(long sequence) => _pending == sequence;
        internal void Receive(long sequence, double now)
        {
            Received++;
            if (_lastReceived.HasValue) IncomingGap.Add(now - _lastReceived.Value);
            _lastReceived = _queuedAt = now; _pending = sequence;
        }
        internal double? Process(long sequence, double now)
        {
            if (_pending != sequence) return null;
            QueueWait.Add(now - _queuedAt); _pending = null;
            return _queuedAt;
        }
        internal void Applied(double start, double end, bool success, double? receivedAt = null)
        {
            if (_lastApply.HasValue) ApplyStartGap.Add(start - _lastApply.Value);
            _lastApply = start; Apply.Add(end - start);
            if (success) { Succeeded++; if (receivedAt.HasValue) Turnaround.Add(end - receivedAt.Value); } else Failed++;
        }
        internal string Text(string name)
        {
            if (Received == 0 && Observation.Count == 0 && Apply.Count == 0) return name + ": no activity";
            var overall = Turnaround.Count == 0 ? "no updates applied" :
                "turnaround avg " + (Turnaround.Total / Turnaround.Count).ToString("F1", CultureInfo.InvariantCulture)
                + " ms, max " + Turnaround.Max.ToString("F1", CultureInfo.InvariantCulture) + $" ms [{Turnaround.Count} applied]";
            var replaced = Received == 0 ? 0 : 100.0 * Coalesced / Received;
            return $"{name} responsiveness: {overall}; pending poses replaced " + replaced.ToString("F1", CultureInfo.InvariantCulture) + "%\n"
                + $"{name}: poses {Received}, coalesced {Coalesced}, writes {Succeeded} ok/{Failed} failed\n"
                + $"  timings avg/max ms [samples]: input gap {IncomingGap.Text()}; queue wait {QueueWait.Text()}; observation {Observation.Text()}; apply {Apply.Text()}; apply gap {ApplyStartGap.Text()}";
        }
    }
    internal sealed class PerformanceGesture
    {
        internal long Id;
        internal SessionToken Token;
        internal double Started, Ended;
        internal string Reason = "";
        internal readonly PerformanceStream Camera = new(), Object = new();
        internal string Text() => $"navigation.performance gesture={Id} reason={Reason} duration="
            + Math.Max(0, (Ended - Started) * 1000).ToString("F1", CultureInfo.InvariantCulture)
            + " ms\n" + Camera.Text("camera") + "\n" + Object.Text("object");
    }
    internal sealed class NavigationPerformance
    {
        private PerformanceGesture? _active;
        private List<PerformanceGesture> _retired = new();
        internal void Begin(long id, SessionToken token, double now)
        {
            Finish("superseded", now); _active = new PerformanceGesture { Id = id, Token = token, Started = now };
        }
        internal PerformanceStream? Stream(SessionToken token, bool objects = false) =>
            _active != null && _active.Token.Equals(token) ? (objects ? _active.Object : _active.Camera) : null;
        internal void Finish(string reason, double now, SessionToken? token = null)
        {
            if (_active == null || (token.HasValue && !_active.Token.Equals(token.Value))) return;
            var g = _active; _active = null; g.Reason = reason; g.Ended = now; _retired.Add(g);
        }
        internal List<PerformanceGesture>? Take() { if (_retired.Count == 0) return null; var retired = _retired; _retired = new(); return retired; }
        internal static void Flush(List<PerformanceGesture>? retired)
        {
            if (retired == null) return;
            foreach (var g in retired) try { DiagnosticLog.Emit("info", g.Text()); } catch { }
        }
    }
}
