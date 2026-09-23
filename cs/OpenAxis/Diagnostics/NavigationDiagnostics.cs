using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using OpenAxis.Client;
using OpenAxis.Geometry;
using OpenAxis.Navigation;

namespace OpenAxis.Diagnostics
{
    public sealed class DiagnosticRow
    {
        public string Text { get; }
        public string Tone { get; }
        public DiagnosticRow(string text, string tone = "text") { Text = text; Tone = tone; }
    }
    public sealed class DiagnosticSegment
    {
        public Vec3 Start { get; }
        public Vec3 End { get; }
        public string Tone { get; }
        public double Width { get; }
        public double Opacity { get; }
        public DiagnosticSegment(Vec3 start, Vec3 end, string tone, double width = 2, double opacity = 1)
        { Start = start; End = end; Tone = tone; Width = width; Opacity = opacity; }
    }
    public sealed class DiagnosticMarker
    {
        public string Name { get; }
        public double X { get; }
        public double Y { get; }
        public string Tone { get; }
        public DiagnosticMarker(string name, double x, double y, string tone)
        { Name = name; X = x; Y = y; Tone = tone; }
    }
    public sealed class DiagnosticPresentation
    {
        public object? Context { get; }
        public IReadOnlyList<DiagnosticRow> Lines { get; }
        public IReadOnlyList<DiagnosticSegment> Segments { get; }
        public IReadOnlyList<DiagnosticMarker> Markers { get; }
        public long Revision { get; }
        public double? ExpiresAt { get; }
        public DiagnosticPresentation(object? context, IEnumerable<DiagnosticRow> lines,
            IEnumerable<DiagnosticSegment> segments, IEnumerable<DiagnosticMarker> markers, long revision, double? expiresAt = null)
        { Context = context; Lines = lines.ToArray(); Segments = segments.ToArray(); Markers = markers.ToArray(); Revision = revision; ExpiresAt = expiresAt; }
    }

    /// <summary>Passive, bounded evidence and presentation; no graphics or native queries.</summary>
    public sealed class NavigationDiagnostics : NavigationObserver
    {
        private sealed class FactValue
        {
            internal object? Value;
            internal double Duration;
            internal FactValue(object? value, double duration) { Value = Detach(value); Duration = duration; }
        }
        private readonly Dictionary<string, string> _errors = new Dictionary<string,string>();
        private readonly Dictionary<string, FactValue> _facts = new Dictionary<string, FactValue>();
        private readonly Dictionary<string, DiagnosticRow> _writes = new Dictionary<string, DiagnosticRow>();
        private readonly Dictionary<string, (long Id, string State, double? Until)> _corrections = new Dictionary<string, (long, string, double?)>();
        private readonly Dictionary<string, DiagnosticMarker> _markers = new Dictionary<string, DiagnosticMarker>();
        private readonly Dictionary<string, DiagnosticSegment> _rays = new Dictionary<string, DiagnosticSegment>();
        private readonly Queue<string> _history = new Queue<string>();
        public IReadOnlyList<string> History => _history.ToArray();
        private readonly Dictionary<string, (string Kind,long Id)> _loggedCorrections = new Dictionary<string,(string,long)>();
        private readonly Dictionary<string,bool> _unknownReadback = new Dictionary<string,bool>();
        private NavigationQuery? _query;
        private object? _context;
        private string? _selected, _error, _status;
        private bool _complete;
        private double _duration;
        private Func<CameraPoseValue, CameraPoseValue, PoseDifference> _compare = PoseDifference.Compare;
        private Func<CameraPoseValue, CameraPoseValue, PoseDifference> _objectCompare = PoseDifference.Compare;
        private readonly Func<double> _clock;
        private readonly Func<object, object> _contextKey;
        private readonly Action<string, string>? _log;
        private readonly int _historyLimit;
        private readonly double _retention;
        public bool Enabled { get; private set; }
        public bool DebugLogging { get; set; }
        public long Revision { get; private set; }
        public Action? Changed { get; set; }
        public NavigationDiagnostics(bool enabled = false, Action<string, string>? log = null, Func<double>? clock = null, Func<object, object>? contextKey = null, int historyLimit = 30, double retention = 1)
        { if (historyLimit < 1 || double.IsNaN(retention) || double.IsInfinity(retention) || retention < 0) throw new ArgumentOutOfRangeException(nameof(retention));
          _historyLimit = historyLimit; _retention = retention; Enabled = enabled; _log = log ?? DiagnosticLog.Emit; _clock = clock ?? (() => Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency); _contextKey = contextKey ?? (context => context); }
        internal void Bind(Func<CameraPoseValue, CameraPoseValue, PoseDifference>? comparison,
            Func<ObjectPoseValue, ObjectPoseValue, PoseDifference>? objectComparison)
        {
            _compare = comparison ?? PoseDifference.Compare;
            _objectCompare = objectComparison == null ? PoseDifference.Compare :
                (a,b) => objectComparison(ObjectPoseValue.FromState(a),ObjectPoseValue.FromState(b));
        }
        private void Touch() { Revision++; try { Changed?.Invoke(); } catch { } }
        private void Log(string level, string text, bool retain = true) { if (Enabled && retain) { _history.Enqueue(text); while (_history.Count>_historyLimit) _history.Dequeue(); } if (level == "debug" && !DebugLogging) return; try { _log?.Invoke(level,text); } catch { } }
        public void SetEnabled(bool value) { if (Enabled == value) return; Enabled = value; Clear(); }
        public void Clear() { Reset(); Touch(); }
        private void Reset()
        { _query = null; _context = null; _facts.Clear(); _errors.Clear(); _writes.Clear(); _corrections.Clear(); _markers.Clear(); _rays.Clear(); _status = null; _history.Clear(); }
        public override void GestureStarted(long id) { _loggedCorrections.Clear(); _unknownReadback.Clear(); Reset(); if (Enabled) _status = $"gesture {id} started"; Log("info",$"gesture_started: gesture_id={id}", retain: false); Touch(); }
        public override void OutputRejected(string kind, long gestureId, string reason)
        {
            var message = $"output_rejected: kind={kind}, gesture_id={gestureId}, reason={reason}";
            Log("warning",message);
            if (Enabled) { _status = message; Touch(); }
        }
        public override void Cancelled(long gestureId, string reason)
        {
            Log("info",$"cancelled: gesture_id={gestureId}, reason={reason}");
            if (!Enabled) return;
            _status = $"gesture finished: {reason}";
            foreach (var key in _corrections.Keys.ToArray()) _corrections[key] = (_corrections[key].Id,"ended",_clock()+_retention);
            Touch();
        }
        public override void GestureFinished(long id, string reason)
        {
            Log("info",$"gesture_finished: gesture_id={id}, reason={reason}");
            if (!Enabled) return;
            _status = $"gesture finished: {reason}";
            foreach (var key in _corrections.Keys.ToArray()) _corrections[key] = (_corrections[key].Id,"ended",_clock()+_retention);
            Touch();
        }
        public override void QueryStarted(object context, NavigationQuery query)
        {
            _errors.Clear();
            if (!Enabled) return;
            context = _contextKey(context);
            if (!Equals(context,_context)) { _writes.Clear(); _corrections.Clear(); }
            _context = context; _query = query; _facts.Clear(); _errors.Clear(); _markers.Clear(); _rays.Clear();
            _selected = _error = null; _complete = false; _duration = 0; Touch();
        }
        public override void Fact(string name, object? value, double durationMs)
        {
            if (name.StartsWith("pick.", StringComparison.Ordinal) && value is IDictionary<string, object> pick &&
                pick.TryGetValue("markerPosition", out var marker) && marker is System.Collections.IList coordinates && coordinates.Count == 2 && _query != null)
            {
                try
                {
                    var x = Convert.ToDouble(coordinates[0]); var y = Convert.ToDouble(coordinates[1]);
                    if (!double.IsNaN(x) && !double.IsInfinity(x) && !double.IsNaN(y) && !double.IsInfinity(y))
                        Pick(_query.RequestId, name, x, y);
                }
                catch (Exception) { /* Invalid optional marker metadata must not hide the fact. */ }
            }
            value = NavigationQuery.WireFactValue(name, value);
            var available = value != null && !ReferenceEquals(value,NavigationQuery.Unavailable);
            var failed = _errors.TryGetValue(name,out var error);
            Log("info",DiagnosticFormatter.FormatEvent("navigation.fact",new Dictionary<string,object?>
            { ["fact"] = name, ["value"] = available ? value : null, ["result"] = failed ? "error" : available ? "ok" : "missing", ["error"] = error, ["duration_ms"] = durationMs }), retain: false);
            if (!Enabled || _query == null) return;
            _facts[name] = new FactValue(available ? value : null,durationMs); Touch();
        }
        public override void FactFailed(string name, string error, double durationMs)
        { _errors[name] = error; if (!Enabled) return; _facts[name] = new FactValue(null,durationMs); Touch(); }
        public override void QueryCompleted(NavigationQuery query, Dictionary<string,object> result, double durationMs)
        {
            var selected = result.TryGetValue("first",out var resultFirst) && resultFirst is IDictionary<string,object> firstFields && firstFields.TryGetValue("name",out var firstName) ? firstName : null;
            Log("info",DiagnosticFormatter.FormatEvent("navigation.query.complete",new Dictionary<string,object?> { ["request"] = query.RequestId, ["first"] = selected, ["duration_ms"] = durationMs }));
            if (!Enabled || _query != query) return;
            _complete = true; _duration = durationMs;
            if (result.TryGetValue("first",out var first) && first is IDictionary<string,object> fields && fields.TryGetValue("name",out var name)) _selected = name as string;
            Touch();
        }
        public override void QueryFailed(NavigationQuery query, string error, double durationMs)
        { Log("warning",error); if (!Enabled || _query != query) return; _error = error; _duration = durationMs; _complete = true; Touch(); }
        public void Pick(long requestId, string name, double x, double y, Vec3? start = null, Vec3? end = null)
        {
            if (!Enabled || _complete || _query?.RequestId != requestId) return;
            _markers[name] = new DiagnosticMarker(name,x,y,Tone(name));
            if (start.HasValue && end.HasValue) _rays[name] = new DiagnosticSegment(start.Value,end.Value,"ray",1);
            Touch();
        }
        public override void WriteCompleted(object context, string stream, CameraPoseValue desired, CameraPoseValue? actual, bool success)
        {
            var unknown = success && !actual.HasValue;
            var wasUnknown = _unknownReadback.TryGetValue(stream,out var previousUnknown) && previousUnknown;
            _unknownReadback[stream] = unknown;
            var writeStatus = !success ? "failed" : unknown ? "unknown readback" : wasUnknown ? "readback recovered" : "succeeded";
            if (!success || unknown != wasUnknown) Log(!success ? "warning" : "info",$"{stream} write: {writeStatus}", retain: false);
            if (!Enabled) return;
            context = _contextKey(context);
            if (!Equals(context,_context)) { _query = null; _facts.Clear(); _errors.Clear(); _writes.Clear(); _corrections.Clear(); _markers.Clear(); _rays.Clear(); }
            _context = context;
            var state = !success ? "failed" : !actual.HasValue ? "unknown readback" : "equivalent";
            var detail = "";
            if (success && actual.HasValue)
            {
                var difference = (stream == "camera" ? _compare : _objectCompare)(desired,actual.Value);
                state = difference.Changed || difference.Discontinuity ? "differs" : "equivalent";
                detail = $" | translation {difference.Translation.Length():0.###e+0} application units | rotation {difference.Rotation.Length()*180/Math.PI:0.###e+0} deg";
            }
            _writes[stream] = new DiagnosticRow($"{stream} write: {state}{detail}",state == "failed" ? "missing" : state == "equivalent" ? "pass" : "correction");
            Touch();
        }
        public override void Correction(object context, string kind, long id, PoseDifference? difference) => Correct("camera",kind,id,difference);
        public override void ObjectCorrection(object context, string kind, long id, PoseDifference? difference) => Correct("object",kind,id,difference);
        private void Correct(string stream, string kind, long id, PoseDifference? difference)
        {
            if (!_loggedCorrections.TryGetValue(stream,out var previous) || previous.Kind != kind || previous.Id != id)
            {
                var detail = difference.HasValue ? $" | translation {difference.Value.Translation} | rotation {difference.Value.Rotation} rad | scale {difference.Value.Scale}" : "";
                Log("debug",$"{stream} correction {id}: {(kind == "applied" ? "acknowledged" : kind)}{detail}");
                _loggedCorrections[stream] = (kind,id);
            }
            if (!Enabled) return;
            _corrections[stream] = (id,kind == "applied" ? "acknowledged" : kind,kind == "applied" ? _clock()+_retention : (double?)null); Touch();
        }
        public DiagnosticPresentation Presentation()
        {
            var lines = new List<DiagnosticRow>(); var segments = new List<DiagnosticSegment>();
            if (!Enabled) return new DiagnosticPresentation(null,lines,segments,Array.Empty<DiagnosticMarker>(),Revision);
            if (_query != null)
            {
                lines.Add(new DiagnosticRow($"Navigation diagnostics | gesture {_query.GestureId} | query {_query.RequestId} | {_duration:0.0} ms"));
                if (_error != null) lines.Add(new DiagnosticRow(_error,"missing"));
                var scale = DrawingScale();
                foreach (var name in _query.Values.Concat(_query.First).Distinct())
                {
                    if (!_facts.TryGetValue(name,out var fact))
                    {
                        var skipped = _complete && _selected != null && Array.IndexOf(_query.First,name)>Array.IndexOf(_query.First,_selected);
                        lines.Add(new DiagnosticRow($"{name}: {(skipped ? "skipped" : "not evaluated")}","skipped")); continue;
                    }
                    var text = DiagnosticFormatter.FormatEvent("navigation.fact",new Dictionary<string,object?>
                    { ["fact"] = name, ["value"] = fact.Value, ["result"] = _errors.ContainsKey(name) ? "error" : fact.Value == null ? "missing" : "ok", ["error"] = _errors.TryGetValue(name,out var error) ? error : null, ["duration_ms"] = fact.Duration });
                    lines.Add(new DiagnosticRow(text+(name == _selected ? " < returned candidate" : ""),_errors.ContainsKey(name) || fact.Value == null ? "missing" : Tone(name)));
                    AddVisuals(segments,name,fact.Value,scale);
                }
            }
            if (_status != null) lines.Add(new DiagnosticRow(_status));
            lines.AddRange(_writes.Values);
            foreach (var entry in _corrections)
                if (!entry.Value.Until.HasValue || _clock()<entry.Value.Until.Value)
                    lines.Add(new DiagnosticRow($"{entry.Key} correction {entry.Value.Id}: {entry.Value.State}","correction"));
            var markers = _markers.Values.GroupBy(m => (m.X,m.Y,m.Tone))
                .Select(group => new DiagnosticMarker(string.Join("\n",group.Select(m => m.Name)),
                    group.Key.X,group.Key.Y,group.Key.Tone));
            var expiresAt = _corrections.Values.Where(c => c.Until.HasValue && _clock() < c.Until.Value).Select(c => c.Until).DefaultIfEmpty(null).Min();
            return new DiagnosticPresentation(_context,lines,segments,markers,Revision,expiresAt);
        }
        private double DrawingScale()
        {
            foreach(var name in new[]{"selection.bounds","model.bounds","object.bounds"})
                if (_facts.TryGetValue(name,out var fact) && fact.Value is IDictionary<string,object> fields && fields.TryGetValue("min",out var min) && fields.TryGetValue("max",out var max) && Point(min,out var a) && Point(max,out var b))
                    return Math.Max(.0001,(b-a).Length()*.1);
            return 1;
        }
        private static string Tone(string name) => name.StartsWith("pick.") ? (name.Contains("cursor") ? "cursor" : "center") : name == "model.bounds" ? "model" : name == "selection.bounds" ? "selection" : name == "camera.view_target" || name == "scene.cursor" ? "target" : name == "object.bounds" || name == "object.pose" ? "object" : name == "sketch.plane" ? "sketch" : "text";
        private static object? Detach(object? value)
        {
            if (value is IDictionary<string,object> dict) return dict.ToDictionary(x=>x.Key,x=>Detach(x.Value)!);
            if (value is double[] doubles) return doubles.ToArray();
            if (value is object[] objects) return objects.Select(Detach).ToArray();
            return value is string || value is ValueType ? value : null;
        }
        private static bool Point(object? value, out Vec3 point)
        {
            point = default;
            try
            {
                if (value is System.Collections.IList list && list.Count == 3)
                { point = new Vec3(Convert.ToDouble(list[0]),Convert.ToDouble(list[1]),Convert.ToDouble(list[2])); return new[]{point.X,point.Y,point.Z}.All(x=>!double.IsNaN(x)&&!double.IsInfinity(x)); }
            }
            catch { }
            return false;
        }
        private static void AddVisuals(List<DiagnosticSegment> output, string name, object? value, double scale)
        {
            var tone = Tone(name);
            if (value is IDictionary<string,object> dict)
            {
                if (name == "world.orientation" && dict.TryGetValue("forward",out var f) && dict.TryGetValue("up",out var u) && Point(f,out var forward) && Point(u,out var up))
                {
                    var right = forward.Cross(up);
                    if (dict.TryGetValue("handedness",out var hand) && Equals(hand,"left")) right = -right;
                    output.Add(new DiagnosticSegment(default,right*scale,"axis_x",2));
                    output.Add(new DiagnosticSegment(default,up*scale,"axis_y",2));
                    output.Add(new DiagnosticSegment(default,forward*scale,"axis_z",2));
                }
                if (name == "object.pose" && dict.TryGetValue("t",out var pos) && dict.TryGetValue("r",out var rot) && Point(pos,out var center) && Point(rot,out var rotation))
                {
                    var q = Quat.FromRotvec(rotation.X,rotation.Y,rotation.Z);
                    var axes = new[]{new Vec3(1,0,0),new Vec3(0,1,0),new Vec3(0,0,1)};
                    var tones = new[]{"axis_x","axis_y","axis_z"};
                    for(var i=0;i<3;i++) output.Add(new DiagnosticSegment(center,center+q.Rotate(axes[i])*scale,tones[i],2));
                }
                if (name == "sketch.plane" && dict.TryGetValue("origin",out var o) && dict.TryGetValue("normal",out var n) && dict.TryGetValue("x_axis",out var x) && Point(o,out var origin) && Point(n,out var normal) && Point(x,out var axis) && normal.Length()>0 && axis.Length()>0)
                {
                    normal = normal.Normalized(); axis = axis.Normalized(); var y = normal.Cross(axis);
                    if (y.Length()>0)
                    {
                        y = y.Normalized();
                        foreach(var step in new[]{-1.0,-.5,0,.5,1})
                        {
                            output.Add(new DiagnosticSegment(origin+(axis*step-y)*scale,origin+(axis*step+y)*scale,"sketch",1));
                            output.Add(new DiagnosticSegment(origin+(y*step-axis)*scale,origin+(y*step+axis)*scale,"sketch",1));
                        }
                        output.Add(new DiagnosticSegment(origin,origin+normal*scale,"target",2));
                    }
                }
                if (dict.TryGetValue("point",out var hit)) AddVisuals(output,name,hit,scale);
                if (dict.TryGetValue("bounds",out var bounds)) AddVisuals(output,name,bounds,scale);
                if (dict.TryGetValue("min",out var low) && dict.TryGetValue("max",out var high) && Point(low,out var a) && Point(high,out var b) && a.X<=b.X && a.Y<=b.Y && a.Z<=b.Z)
                {
                    var corners = Enumerable.Range(0,8).Select(i=>new Vec3((i&4)==0?a.X:b.X,(i&2)==0?a.Y:b.Y,(i&1)==0?a.Z:b.Z)).ToArray();
                    for(var i=0;i<8;i++) foreach(var bit in new[]{1,2,4}) if((i&bit)==0) output.Add(new DiagnosticSegment(corners[i],corners[i|bit],tone,1,.35));
                }
            }
            else if (Point(value,out var point) && (name.StartsWith("pick.") || name == "camera.view_target" || name == "scene.cursor"))
                foreach(var offset in new[]{new Vec3(scale*.08,0,0),new Vec3(0,scale*.08,0),new Vec3(0,0,scale*.08)}) output.Add(new DiagnosticSegment(point-offset,point+offset,tone,1,.35));
        }
    }
}
