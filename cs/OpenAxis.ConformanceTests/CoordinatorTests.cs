using System;
using System.Collections.Generic;
using System.Linq;
using System.IO;
using System.Text.Json;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using OpenAxis.Client;
using OpenAxis.Geometry;
using OpenAxis.Navigation;

namespace OpenAxis.ConformanceTests
{
    internal static class CoordinatorTests
    {
        private static int _checks;
        private static void PerformanceSubset(JsonElement actual, JsonElement expected)
        {
            if (actual.ValueKind == JsonValueKind.String && expected.ValueKind == JsonValueKind.Array) {
                foreach (var part in expected.EnumerateArray()) Check(actual.GetString()!.Contains(part.GetString()!), $"performance missing {part}: {actual}");
            } else if (expected.ValueKind == JsonValueKind.Object) {
                foreach (var p in expected.EnumerateObject()) PerformanceSubset(actual.GetProperty(p.Name), p.Value);
            } else if (expected.ValueKind == JsonValueKind.Array) {
                Check(actual.GetArrayLength() == expected.GetArrayLength(), "performance report count");
                for (int i = 0; i < expected.GetArrayLength(); i++) PerformanceSubset(actual[i], expected[i]);
            } else if (expected.ValueKind == JsonValueKind.Number) Check(Math.Abs(actual.GetDouble() - expected.GetDouble()) < 1e-6, $"performance {actual} != {expected}");
            else Check(actual.ToString() == expected.ToString(), $"performance {actual} != {expected}");
        }
        internal static int RunShared(string directory)
        {
            int before = _checks;
            using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(directory, "coordinator.json")));
            Check(document.RootElement.GetProperty("version").GetInt32() == 1, "fixture version");
            using var performance = JsonDocument.Parse(File.ReadAllText(Path.Combine(directory, "performance.json")));
            var logDirectory = Path.Combine(Path.GetTempPath(), "openaxis-performance-" + Guid.NewGuid());
            foreach (var scenario in document.RootElement.GetProperty("scenarios").EnumerateArray().Concat(performance.RootElement.GetProperty("scenarios").EnumerateArray()))
            {
                using var logger = OpenAxis.Diagnostics.DiagnosticLog.Configure("performance-tests", logDirectory);
                logger.DebugLogging = true;
                var reports = new List<string>();
                logger.Message += (_, message) => { if (message.StartsWith("navigation.performance ")) reports.Add(message); };
                var objects = new Objects();
                var h = new Harness(objects: objects);
                void Dispatch(JsonElement e)
                {
                    long gesture = e.TryGetProperty("gesture", out var g) ? g.GetInt64() : 7;
                    switch (e.GetProperty("op").GetString())
                    {
                        case "orbit": h.Dispatch(new NavigationState { GestureId = gesture, Camera = new CameraNavigationState { Mode = "orbit" } }); break;
                        case "pivot": h.Dispatch(new CameraPivot { GestureId = gesture, Point = new double[3] }); break;
                        case "write_error": throw new Exception("host write failed");
                        case "end": h.Dispatch(new MotionEnd { GestureId = gesture }); break;
                        case "start": h.Start(gesture); break;
                        case "query": h.Query(id: gesture, gesture: gesture, values: e.TryGetProperty("values", out var values) ? values.EnumerateArray().Select(v => v.GetString()!).ToArray() : null); break;
                        case "object_pose": h.Dispatch(new ObjectPose { GestureId = gesture, Seq = e.GetProperty("seq").GetInt64(), T = new[] { e.GetProperty("x").GetDouble(), 0, 0 }, R = new double[3] }); break;
                        case "on_read": h.Adapter.OnRead = () => { foreach (var item in e.GetProperty("events").EnumerateArray()) Dispatch(item); }; break;
                        case "pose": h.Dispatch(Pose(e.GetProperty("x").GetDouble(), e.GetProperty("seq").GetInt64(), gesture)); break;
                        case "context_changed": h.Adapter.Context = new object(); h.Session.ContextChanged(); break;
                        case "close": h.Session.Dispose(); break;
                        case "native_camera": h.Adapter.Camera = Value(e.GetProperty("x").GetDouble()); h.Session.NativeCameraChanged(); break;
                        case "advance":
                            double now = e.GetProperty("time").GetDouble();
                            Check(now >= h.Now, "monotonic clock"); h.Now = now;
                            var due = h.Scheduler.Deadlines.Where(item => item.Item1 <= now).ToArray();
                            h.Scheduler.Deadlines.RemoveAll(item => item.Item1 <= now);
                            foreach (var item in due) item.Item2();
                            break;
                        case "drain": h.Scheduler.Run(); break;
                        case "on_write": h.Adapter.OnWrite = () => { foreach (var item in e.GetProperty("events").EnumerateArray()) Dispatch(item); }; break;
                        case "expect":
                            foreach (var property in e.EnumerateObject())
                                switch (property.Name)
                                {
                                    case "op": break;
                                    case "summaries": Check(reports.Count == property.Value.GetInt32(), "summary count"); break;
                                    case "performance":
                                        using (var json = JsonDocument.Parse(JsonSerializer.Serialize(reports))) PerformanceSubset(json.RootElement, property.Value);
                                        break;
                                    case "writes": Check(h.Adapter.Writes.SequenceEqual(property.Value.EnumerateArray().Select(x => x.GetDouble())), "writes"); break;
                                    case "pending": Check(h.Scheduler.Queue.Count == property.Value.GetInt32(), "pending"); break;
                                    case "cancels": Check(h.Messages.OfType<MotionCancel>().Count() == property.Value.GetInt32(), "cancels"); break;
                                    case "deltas": Check(h.Messages.OfType<CameraDelta>().Count() == property.Value.GetInt32(), "deltas"); break;
                                    default: throw new Exception("Unknown assertion " + property.Name);
                                }
                            break;
                        default: throw new Exception("Unknown operation " + e.GetProperty("op"));
                    }
                }
                int index = 0;
                try
                {
                    foreach (var e in scenario.GetProperty("events").EnumerateArray())
                    {
                        try { Dispatch(e); }
                        catch (Exception error) { throw new Exception($"{scenario.GetProperty("name").GetString()} step {index}: {e}", error); }
                        index++;
                    }
                }
                finally { h.Session.Dispose(); h.Scheduler.Run(); }
            }
            return _checks - before;
        }
        private static readonly MethodInfo DispatchMethod = typeof(OpenAxisClient).GetMethod("DispatchMessage", BindingFlags.Instance | BindingFlags.NonPublic)!;
        private static readonly MethodInfo StateMethod = typeof(OpenAxisClient).GetMethod("SetState", BindingFlags.Instance | BindingFlags.NonPublic)!;
        private static void Check(bool condition, string message)
        { _checks++; if (!condition) throw new Exception("Coordinator: " + message); }
        private static CameraPoseValue Value(double x) => new CameraPoseValue(new Vec3(x, 0, 0), new Vec3(0, 0, 0), fov: 1);
        private static CameraPose Pose(double x, long seq, long gesture = 7, long? ack = null) =>
            new CameraPose { GestureId = gesture, Seq = seq, T = new[] { x, 0.0, 0.0 }, R = new double[3], Fov = 1, AppliedDeltaId = ack };

        private sealed class Scheduler : INavigationScheduler
        {
            internal readonly Queue<Action> Queue = new Queue<Action>();
            internal readonly List<Action> Timers = new List<Action>();
            internal readonly List<(double, Action)> Deadlines = new List<(double, Action)>();
            internal bool FailPost;
            public void Post(Action callback)
            {
                if (FailPost) throw new InvalidOperationException("scheduler unavailable");
                lock (Queue) Queue.Enqueue(callback);
            }
            public void PostAt(double deadline, Action callback) { Timers.Add(callback); Deadlines.Add((deadline, callback)); }
            internal void Run()
            {
                for (int i = 0; i < 100; i++)
                {
                    Action callback;
                    lock (Queue) { if (Queue.Count == 0) return; callback = Queue.Dequeue(); }
                    callback();
                }
                throw new Exception("Coordinator busy loop");
            }
        }

        private sealed class Adapter : INavigationAdapter
        {
            internal object Context = new object();
            internal CameraPoseValue Camera = Value(10);
            internal readonly List<double> Writes = new List<double>();
            internal readonly List<string> Facts = new List<string>();
            internal readonly List<Vec3?> Pivots = new List<Vec3?>();
            internal Action? OnFact, OnWrite;
            internal bool ReadFail;
            internal NavigationSession Session = null!;
            private readonly int _thread = Thread.CurrentThread.ManagedThreadId;
            private void CheckHost()
            {
                Check(Thread.CurrentThread.ManagedThreadId == _thread, "adapter called on correct thread");
                var gate = typeof(NavigationSession).GetField("_gate", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(Session)!;
                Check(!Monitor.IsEntered(gate), "adapter called outside session lock");
            }
            public object CaptureContext() { CheckHost(); return Context; }
            public bool IsCurrent(object context) { CheckHost(); return ReferenceEquals(Context, context); }
            public INavigationCapture BeginQuery(object context) { CheckHost(); return new Capture(this); }
            internal Action? OnRead;
            internal CameraPoseValue? Read(object context)
            {
                CheckHost();
                var callback = OnRead; OnRead = null; callback?.Invoke();
                if (ReadFail) throw new Exception("read unavailable");
                return Camera;
            }
            public NavigationWriteResult ApplyCamera(object context, CameraPoseValue desired, NavigationState? state, Vec3? pivot)
            {
                CheckHost(); Writes.Add(desired.Position.X); Camera = desired;
                var callback = OnWrite; OnWrite = null; callback?.Invoke();
                return new NavigationWriteResult(true, ReadFail ? null : Camera);
            }
            public void ShowPivot(object context, Vec3? point) { CheckHost(); Pivots.Add(point); }
            private sealed class Capture : INavigationCapture
            {
                private readonly Adapter _adapter;
                internal Capture(Adapter adapter) { _adapter = adapter; }
                public object? Resolve(string name)
                {
                    _adapter.CheckHost(); _adapter.Facts.Add(name);
                    var callback = _adapter.OnFact; _adapter.OnFact = null; callback?.Invoke();
                    if (name == "camera.pose") return new Dictionary<string, object>
                        { ["t"] = new[] { _adapter.Camera.Position.X, 0.0, 0.0 }, ["r"] = new double[3], ["fov"] = 1.0 };
                    if (name == "pick.cursor") return new[] { 1.0, 2.0, 3.0 };
                    return NavigationQuery.Unavailable;
                }
                public CameraPoseValue? InitialCameraObservation() => _adapter.Camera;
            }
        }

        private sealed class Harness
        {
            internal readonly OpenAxisClient Client = new OpenAxisClient("test");
            internal readonly Adapter Adapter = new Adapter();
            internal readonly Scheduler Scheduler = new Scheduler();
            internal readonly NavigationSession Session;
            internal List<Msg> Messages = new List<Msg>();
            internal bool FailResponse;
            internal double Now;
            internal Func<Msg, Task>? SendOverride;
            internal Harness(int maxQueries = 32, int budget = 32,
                Func<CameraPoseValue, CameraPoseValue, PoseDifference>? comparison = null, NavigationObserver? observer = null,
                Objects? objects = null, bool observeObjects = true, int maxWork = 64, OpenAxis.Diagnostics.NavigationDiagnostics? diagnostics = null)
            {
                Session = new NavigationSession(Client, Adapter, Scheduler, observation: Adapter.Read, clock: () => Now,
                    maxQueries: maxQueries, drainBudget: budget, maxWork: maxWork, captureSender: () =>
                    {
                        var destination = Messages;
                        return message =>
                        {
                            if (SendOverride != null) return SendOverride(message);
                            if (FailResponse && message is Response) throw new Exception("send failed");
                            destination.Add(message);
                            return Task.CompletedTask;
                        };
                    }, comparison: comparison, observer: observer, diagnostics: diagnostics, objectAdapter: objects,
                    objectObservation: objects != null && observeObjects ? objects.Read : (Func<object, ObjectPoseValue?>?)null);
                Adapter.Session = Session;
                State(ConnectionState.Connected);
            }
            internal void Dispatch(Msg message) => DispatchMethod.Invoke(Client, new object[] { message });
            internal void State(ConnectionState state) => StateMethod.Invoke(Client, new object[] { state });
            internal void Start(long id = 7) => Dispatch(new MotionStart { GestureId = id });
            internal void Query(long id = 1, long? gesture = 7, string[]? values = null, string[]? first = null)
            {
                var parameters = new Dictionary<string, object> { ["values"] = values ?? new[] { "camera.pose" } };
                if (gesture.HasValue) parameters["gesture_id"] = gesture.Value;
                if (first != null) parameters["first"] = first;
                Dispatch(new Request { Id = id, Method = "navigation.query", Params = parameters });
            }
            internal void Ready() { Start(); Query(); Scheduler.Run(); }
        }

        private sealed class Objects : INavigationObjectAdapter, INavigationObjectCapture
        {
            internal object? Context = new object();
            internal ObjectPoseValue Pose = new ObjectPoseValue(new Vec3(0, 0, 0), new Vec3(0, 0, 0));
            internal double Limit = 5;
            internal int Writes;
            internal bool Unknown, Fail, FailPivot;
            internal Action? OnWrite;
            internal readonly List<Vec3?> Pivots = new List<Vec3?>();
            public object? CaptureContext() => Context;
            public bool IsCurrent(object context) => ReferenceEquals(Context, context);
            public INavigationObjectCapture BeginQuery(object context) => this;
            public object? Resolve(string name) => name == "object.pose" ? new Dictionary<string, object>
                { ["t"] = new[] { Pose.Position.X, 0.0, 0.0 }, ["r"] = new double[3] } : NavigationQuery.Unavailable;
            public ObjectPoseValue? InitialObjectObservation() => Unknown ? null : Pose;
            internal ObjectPoseValue? Read(object context) => InitialObjectObservation();
            public ObjectWriteResult ApplyObject(object context, ObjectPoseValue desired, NavigationState? state, Vec3? pivot)
            {
                Writes++;
                if (Fail) return new ObjectWriteResult(false);
                Pose = new ObjectPoseValue(new Vec3(Math.Min(Limit, desired.Position.X), 0, 0), desired.RotationVector);
                OnWrite?.Invoke();
                return new ObjectWriteResult(true, Unknown ? null : Pose);
            }
            public void ShowPivot(object context, Vec3? pivot)
            {
                if (FailPivot) throw new Exception("renderer failed");
                Pivots.Add(pivot);
            }
        }

        private sealed class ReentrantCorrectionObserver : NavigationObserver
        {
            internal Action OnApplied = () => { };
            public override void ObjectCorrection(object context, string kind, long id, PoseDifference? difference)
            { if (kind == "applied") OnApplied(); }
        }

        private static ObjectPose ObjectOutput(double x, long seq, long? ack = null) => new ObjectPose
            { GestureId = 7, Seq = seq, T = new[] { x, 0.0, 0.0 }, R = new double[3], AppliedDeltaId = ack };

        private static void ObjectTests()
        {
            {
                var objects = new Objects(); var h = new Harness(objects: objects);
                h.Start(); h.Query(values: new[] { "camera.pose", "object.pose" }); h.Scheduler.Run();
                h.Adapter.Camera = Value(12); h.Session.NativeCameraChanged(); h.Scheduler.Run();
                var cameraDelta = h.Messages.OfType<CameraDelta>().Single();
                h.Dispatch(ObjectOutput(3, 1, cameraDelta.DeltaId)); h.Dispatch(Pose(15, 1)); h.Scheduler.Run();
                Check(objects.Pose.Position.X == 3 && h.Adapter.Writes.Count == 0, "camera barrier permits object writes and ignores object ack");
                h.Dispatch(Pose(13, 2, ack: cameraDelta.DeltaId)); h.Scheduler.Run();
                Check(h.Adapter.Writes.Last() == 13, "camera stream resumes on its own ack");
            }
            {
                var objects = new Objects(); var observer = new ReentrantCorrectionObserver();
                var h = new Harness(objects: objects, observer: observer);
                h.Start(); h.Query(values: new[] { "object.pose" }); h.Scheduler.Run();
                h.Dispatch(ObjectOutput(8, 1)); h.Scheduler.Run();
                observer.OnApplied = h.Session.ContextChanged;
                h.Dispatch(ObjectOutput(4, 2, h.Messages.OfType<ObjectDelta>().Single().DeltaId)); h.Scheduler.Run();
                Check(objects.Writes == 1 && !h.Session.IsActive, "observer invalidation cannot authorize subsequent write");
            }
            {
                var objects = new Objects { FailPivot = true }; var h = new Harness(objects: objects);
                h.Start(); h.Query(values: new[] { "object.pose" }); h.Scheduler.Run();
                h.Dispatch(new ObjectPivot { GestureId = 7, Point = new[] { 1.0, 2.0, 3.0 } });
                h.Dispatch(ObjectOutput(3, 1)); h.Scheduler.Run();
                Check(objects.Writes == 1 && h.Session.IsActive, "pivot rendering cannot block object writes");
                h.Start(8); h.Scheduler.Run();
                Check(h.Session.IsActive, "old pivot cleanup failure cannot cancel new gesture");
            }
            foreach (bool observe in new[] { true, false })
            {
                var objects = new Objects();
                var h = new Harness(objects: objects, observeObjects: observe);
                h.Start(); h.Query(values: new[] { "camera.pose", "object.pose" }); h.Scheduler.Run();
                h.Dispatch(ObjectOutput(0, 1)); h.Scheduler.Run();
                Check(objects.Writes == 0, "initial unchanged object pose does not claim/write");
                h.Dispatch(ObjectOutput(8, 2)); h.Scheduler.Run();
                var delta = h.Messages.OfType<ObjectDelta>().Single();
                Check(delta.T[0] == -3 && objects.Pose.Position.X == 5, "constrained result sends existing object delta");
                h.Dispatch(Pose(11, 1)); h.Dispatch(ObjectOutput(9, 3)); h.Scheduler.Run();
                Check(h.Adapter.Writes.Last() == 11 && objects.Writes == 1, "object ack barrier does not block camera");
                h.Dispatch(Pose(12, 2, ack: delta.DeltaId)); h.Scheduler.Run();
                h.Dispatch(ObjectOutput(9, 4)); h.Scheduler.Run();
                Check(objects.Writes == 1, "camera ack cannot clear object barrier");
                h.Dispatch(ObjectOutput(5, 5, delta.DeltaId)); h.Scheduler.Run();
                Check(objects.Writes == 1, "acknowledged constrained pose avoids another setter");
                h.Dispatch(ObjectOutput(4, 6, delta.DeltaId)); h.Scheduler.Run();
                Check(objects.Pose.Position.X == 4 && objects.Writes == 2, "motion away from constraint resumes");
                objects.Context = new object();
                h.Dispatch(Pose(13, 3)); h.Scheduler.Run();
                Check(!h.Session.IsActive && h.Messages.OfType<MotionCancel>().Count() == 1, "invalid object cancels whole gesture");
                Check(h.Adapter.Writes.Last() == 12, "invalid object prevents camera write too");
                h.Session.Dispose(); h.Scheduler.Run();
            }
            {
                var objects = new Objects { Context = null };
                var h = new Harness(objects: objects); h.Ready();
                Check(h.Messages.OfType<Response>().Single().Error == null, "camera query succeeds without selected object");
            }
            {
                var objects = new Objects(); var h = new Harness(objects: objects);
                h.Adapter.Context = null!;
                h.Start(); h.Query(values: new[] { "object.pose" }); h.Scheduler.Run();
                h.Dispatch(ObjectOutput(3, 1)); h.Scheduler.Run();
                Check(objects.Writes == 1, "object-only query and writes require no camera viewport");
                h.Dispatch(new ObjectPivot { GestureId = 7, Point = new[] { 1.0, 2.0, 3.0 } }); h.Scheduler.Run();
                h.Dispatch(new MotionEnd { GestureId = 7 }); h.Scheduler.Run();
                Check(objects.Pivots.Last() == null && !h.Session.IsActive, "object pivot cleared on gesture end");
            }
            {
                var objects = new Objects(); var h = new Harness(objects: objects);
                h.Start(); h.Query(values: new[] { "object.pose" }); h.Scheduler.Run();
                h.Dispatch(ObjectOutput(8, 1)); h.Scheduler.Run();
                h.Now = 2; foreach (var timer in h.Scheduler.Timers.ToArray()) timer(); h.Scheduler.Run();
                Check(!h.Session.IsActive && h.Messages.OfType<MotionCancel>().Count() == 1, "object ack timeout cancels gesture");
            }
            {
                var objects = new Objects { Unknown = true }; var h = new Harness(objects: objects);
                h.Start(); h.Query(values: new[] { "object.pose" }); h.Scheduler.Run();
                h.Dispatch(ObjectOutput(8, 1)); h.Scheduler.Run();
                Check(!h.Messages.OfType<ObjectDelta>().Any(), "unknown object readback does not invent correction");
                objects.Unknown = false; h.Session.NativeObjectChanged(); h.Scheduler.Run();
                var recovered = h.Messages.OfType<ObjectDelta>().Single();
                Check(recovered.T[0] == -3, "first recovered object readback reconciles requested and realized poses");
                h.Dispatch(ObjectOutput(5, 2, recovered.DeltaId)); h.Scheduler.Run();
                objects.Pose = new ObjectPoseValue(new Vec3(4, 0, 0), new Vec3(0, 0, 0));
                h.Session.NativeObjectChanged(); h.Scheduler.Run();
                Check(h.Messages.OfType<ObjectDelta>().Last().T[0] == -1, "later native object movement corrects normally");
            }
            foreach (bool fail in new[] { true, false })
            {
                var objects = new Objects { Fail = fail }; var h = new Harness(objects: objects);
                h.Start(); h.Query(values: new[] { "object.pose" }); h.Scheduler.Run();
                if (!fail) objects.OnWrite = () => objects.Context = new object();
                h.Dispatch(ObjectOutput(8, 1)); h.Scheduler.Run();
                Check(!h.Session.IsActive && !h.Messages.OfType<ObjectDelta>().Any(), "failed/stale object write cancels without correction");
            }
            {
                var objects = new Objects(); var h = new Harness(objects: objects);
                h.Start(); h.Query(values: new[] { "object.pose" }); h.Scheduler.Run();
                objects.OnWrite = () => h.Start(8);
                h.Dispatch(ObjectOutput(8, 1)); h.Scheduler.Run();
                Check(h.Session.IsActive && !h.Messages.OfType<ObjectDelta>().Any(), "reentrant new gesture rejects old constrained write completion");
                objects.OnWrite = null;
                h.Query(gesture: 8, values: new[] { "object.pose" }); h.Scheduler.Run();
                var output = ObjectOutput(3, 2); output.GestureId = 8;
                h.Dispatch(output); h.Scheduler.Run();
                Check(objects.Pose.Position.X == 3, "new gesture object stream remains usable");
            }
            {
                var objects = new Objects(); var h = new Harness(objects: objects);
                h.Start(); h.Query(values: new[] { "camera.pose", "object.pose" }); h.Scheduler.Run();
                h.SendOverride = _ => throw new InvalidOperationException("socket failed");
                h.Dispatch(ObjectOutput(8, 1)); h.Scheduler.Run();
                Check(!h.Session.IsActive, "object delta send failure cancels entire session");
                h.Dispatch(Pose(11, 1)); h.Scheduler.Run();
                Check(h.Adapter.Writes.Count == 0, "camera cannot write after object send failure");
            }
            {
                var objects = new Objects(); var h = new Harness(objects: objects, observeObjects: false);
                h.Start(); h.Query(values: new[] { "object.pose" }); h.Scheduler.Run();
                objects.Pose = new ObjectPoseValue(new Vec3(99, 0, 0), new Vec3(0, 0, 0));
                h.Query(id: 2, values: Array.Empty<string>(), first: new[] { "object.pose" }); h.Scheduler.Run();
                h.Dispatch(ObjectOutput(0, 1)); h.Scheduler.Run();
                Check(objects.Writes == 0, "later object query cannot reseed initial baseline");
                h.Dispatch(ObjectOutput(8, 2)); h.Scheduler.Run();
                h.State(ConnectionState.Disconnected); h.State(ConnectionState.Connected); h.Scheduler.Run();
                h.Start(); h.Query(values: new[] { "object.pose" }); h.Scheduler.Run();
                h.Dispatch(ObjectOutput(4, 1)); h.Scheduler.Run();
                Check(objects.Pose.Position.X == 4, "reconnect retires old object acknowledgement barrier");
            }
        }

        private sealed class BrokenObserver : NavigationObserver
        {
            internal Action Verify = () => { };
            internal int Calls;
            private void Fail() { Verify(); Calls++; throw new Exception("diagnostic failure"); }
            public override void GestureStarted(long id) => Fail();
            public override void QueryStarted(object context, NavigationQuery query) => Fail();
            public override void Fact(string name, object? value, double durationMs) => Fail();
            public override void QueryCompleted(NavigationQuery query, Dictionary<string, object> result, double durationMs) => Fail();
        }

        private static void QueueRetentionTests()
        {
            var objects = new Objects { Limit = 100 };
            var h = new Harness(objects: objects, maxWork: 2);
            h.Start(); h.Query(values: new[] { "camera.pose", "object.pose" }); h.Scheduler.Run();
            h.Query(2);
            h.Dispatch(Pose(11, 1)); h.Dispatch(ObjectOutput(1, 1));
            h.Query(3);
            // Once control capacity is full, both independent streams must still
            // retain their latest frame. Replacements belong after query 3.
            for (int seq = 2; seq <= 100; seq++)
            {
                h.Dispatch(Pose(10 + seq, seq));
                h.Dispatch(ObjectOutput(seq, seq));
            }
            var queue = typeof(NavigationSession).GetField("_queue", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(h.Session)!;
            var queued = (int)queue.GetType().GetProperty("Count")!.GetValue(queue)!;
            Check(queued == 4, "queue bound is control capacity plus one pose per stream");
            h.Query(4); // Control overflow must still receive a terminal response.
            h.Dispatch(new MotionEnd { GestureId = 7 });
            h.Scheduler.Run();
            Check(h.Adapter.Writes.SequenceEqual(new[] { 110.0 }) && objects.Writes == 1 && objects.Pose.Position.X == 100,
                "full mixed queue applies newest camera and object frames before gesture ends");
            var third = h.Messages.OfType<Response>().Single(r => r.Id == 3);
            var thirdValues = (Dictionary<string, object>)third.Result!["values"];
            var thirdCamera = (Dictionary<string, object>)thirdValues["camera.pose"];
            Check(((double[])thirdCamera["t"])[0] == 10, "replacement pose cannot overtake intervening query");
            Check(h.Messages.OfType<Response>().Single(r => r.Id == 4).Error != null, "control overflow remains bounded and replies once");
            Check(!h.Session.IsActive, "end follows retained final frames");

            h = new Harness(maxWork: 1); h.Ready();
            h.Dispatch(Pose(11, 1));
            h.Dispatch(new CameraPivot { GestureId = 7, Point = new[] { 3.0, 4.0, 5.0 } });
            h.Dispatch(Pose(12, 2));
            h.Adapter.OnWrite = () => Check(h.Adapter.Pivots.Last().HasValue, "newest frame remains after intervening pivot");
            h.Scheduler.Run();
            Check(h.Adapter.Writes.SequenceEqual(new[] { 12.0 }), "pivot plus saturated newest frame is retained");

            h = new Harness(maxWork: 1); h.Ready();
            h.Dispatch(new NavigationState { GestureId = 7, Camera = new CameraNavigationState { Mode = "orbit" } });
            h.Dispatch(Pose(11, 1)); h.Scheduler.Run();
            Check(h.Adapter.Writes.Count == 0, "initial orbit frame is deferred");
            h.Dispatch(new CameraPivot { GestureId = 7, Point = new[] { 1.0, 2.0, 3.0 } });
            h.Dispatch(Pose(12, 2)); h.Scheduler.Run();
            Check(h.Adapter.Writes.SequenceEqual(new[] { 12.0 }), "older deferred release cannot evict newer queued frame");
        }

        private static void ReadbackRecoveryTests()
        {
            var h = new Harness(); h.Ready();
            h.Adapter.ReadFail = true;
            h.Dispatch(Pose(20, 1)); h.Scheduler.Run();
            var state = (SessionState)typeof(NavigationSession).GetField("_state", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(h.Session)!;
            Check(!state.Baseline.HasValue, "successful unknown readback never fabricates observed baseline");
            h.Adapter.ReadFail = false; h.Adapter.Camera = Value(22);
            h.Dispatch(Pose(21, 2)); h.Scheduler.Run();
            var delta = h.Messages.OfType<CameraDelta>().Single();
            Check(delta.T[0] == 2 && h.Adapter.Writes.SequenceEqual(new[] { 20.0 }),
                "recovered readback corrects from last request before another camera write");
            h.Dispatch(Pose(22, 3, ack: delta.DeltaId)); h.Scheduler.Run();
            Check(h.Adapter.Writes.Count == 1, "recovery correction acknowledgement skips already-realized pose");

            h = new Harness(); h.Ready(); h.Adapter.ReadFail = true;
            h.Dispatch(Pose(20, 1)); h.Scheduler.Run();
            h.Dispatch(Pose(25, 2)); h.Scheduler.Run();
            h.Adapter.Camera = Value(27); h.Adapter.ReadFail = false;
            h.Session.NativeCameraChanged(); h.Scheduler.Run();
            Check(h.Messages.OfType<CameraDelta>().Single().T[0] == 2,
                "consecutive unknown writes replace requested recovery reference");

            var objects = new Objects { Unknown = true };
            h = new Harness(objects: objects, observeObjects: false);
            h.Start(); h.Query(values: new[] { "object.pose" }); h.Scheduler.Run();
            h.Dispatch(ObjectOutput(8, 1)); h.Scheduler.Run();
            h.Dispatch(ObjectOutput(8, 2)); h.Scheduler.Run();
            Check(objects.Writes == 2 && !h.Messages.OfType<ObjectDelta>().Any(),
                "unobserved object request is never used as actual-observation fallback");
            objects.Unknown = false;
            h.Dispatch(ObjectOutput(8, 3)); h.Scheduler.Run();
            Check(h.Messages.OfType<ObjectDelta>().Single().T[0] == -3,
                "object completed known readback reconciles through normal correction");
        }

        private sealed class EvidenceObserver : NavigationObserver
        {
            internal NavigationState? State;
            internal NavigationQuery? Failed;
            internal Action Verify = () => { };
            public override void NavigationStateChanged(NavigationState state)
            {
                Verify(); State = state;
                throw new Exception("passive state observer");
            }
            public override void QueryFailed(NavigationQuery query, string error, double durationMs)
            {
                Verify(); Failed = query;
                Check(!string.IsNullOrEmpty(error) && durationMs >= 0, "query failure evidence");
            }
        }

        internal static int Run()
        {
            {
            var evidence = new EvidenceObserver();
            var evidenceHarness = new Harness(observer: evidence);
            evidence.Verify = () => evidenceHarness.Adapter.CaptureContext();
            evidenceHarness.Ready();
            evidenceHarness.Dispatch(new NavigationState { GestureId = 7, Camera = new CameraNavigationState { Mode = "free_camera", LockRoll = false, LockTranslationPlane = false } });
            Check(evidence.State == null, "state observer must wait for scheduler");
            evidenceHarness.Scheduler.Run();
            Check(evidence.State?.GestureId == 7 && evidence.State.Camera?.Mode == "free_camera", "state evidence missing");
            evidenceHarness.Dispatch(Pose(11, 1)); evidenceHarness.Scheduler.Run();
            Check(evidenceHarness.Adapter.Writes.Count == 1, "state observer exception changed navigation");
            evidenceHarness.Adapter.OnFact = () => evidenceHarness.Adapter.Context = new object();
            evidenceHarness.Query(id: 42); evidenceHarness.Scheduler.Run();
            Check(evidence.Failed?.RequestId == 42, "failed query identity missing");
            evidenceHarness.Session.Dispose();
            }
            var diagnosticModel = new OpenAxis.Diagnostics.NavigationDiagnostics(true);
            var diagnosticsHarness = new Harness(diagnostics:diagnosticModel);
            diagnosticsHarness.Ready(); diagnosticsHarness.Dispatch(Pose(11,1)); diagnosticsHarness.Scheduler.Run();
            Check(diagnosticModel.Presentation().Lines.Any(line=>line.Text.Contains("camera write: equivalent")),"session feeds write evidence to diagnostics");
            var diagnosticThread = Thread.CurrentThread.ManagedThreadId;
            diagnosticModel.Changed = () => Check(Thread.CurrentThread.ManagedThreadId == diagnosticThread,
                "diagnostic mutation is marshalled to application thread");
            Task.Run(() => diagnosticsHarness.Dispatch(Pose(12,1))).GetAwaiter().GetResult();
            diagnosticsHarness.Scheduler.Run();
            Check(diagnosticModel.Presentation().Lines.Any(line=>line.Text.Contains("output_rejected")),
                "rejected server output reaches shared diagnostics");
            diagnosticsHarness.Session.ContextChanged(); diagnosticsHarness.Scheduler.Run();
            Check(diagnosticModel.History.Any(line=>line.Contains("cancelled:") && line.Contains("context_changed")),
                "cancellation reason reaches shared diagnostics");
            Check(diagnosticsHarness.Adapter.Writes.Count == 1,"diagnostics do not repeat writes");
            diagnosticsHarness.Session.Dispose();

            _checks = 0;
            QueueRetentionTests();
            ReadbackRecoveryTests();
            ObjectTests();
            foreach (bool failScheduler in new[] { false, true })
            {
                var connected = new OpenAxisClient("constructor-recovery");
                StateMethod.Invoke(connected, new object[] { ConnectionState.Connected });
                var scheduler = new Scheduler { FailPost = failScheduler };
                var adapter = new Adapter();
                bool failed = false;
                try
                {
                    new NavigationSession(connected, adapter, scheduler, captureSender: () =>
                    {
                        if (!failScheduler) throw new InvalidOperationException("sender unavailable");
                        return _ => Task.CompletedTask;
                    });
                }
                catch (InvalidOperationException) { failed = true; }
                Check(failed, "constructor propagates initialization failure");
                scheduler.FailPost = false;
                var recovered = new NavigationSession(connected, adapter, scheduler,
                    captureSender: () => _ => Task.CompletedTask);
                adapter.Session = recovered;
                scheduler.Run();
                Check(!recovered.IsActive, "replacement session attaches after failed constructor");
                recovered.Dispose();
                scheduler.Run();
            }
            var idle = new Harness();
            idle.Ready();
            for (int seq = 1; seq <= 60; seq++)
            {
                idle.Dispatch(Pose(10, seq));
                idle.Scheduler.Run();
            }
            Check(idle.Adapter.Writes.Count == 0, "idle frame stream performs no camera commits");
            Check(idle.Scheduler.Queue.Count == 0 && idle.Scheduler.Timers.Count == 0,
                "idle frames leave no scheduled work or correction deadlines");
            idle.Dispatch(Pose(11, 61));
            idle.Scheduler.Run();
            idle.Dispatch(Pose(11, 62));
            idle.Scheduler.Run();
            Check(idle.Adapter.Writes.SequenceEqual(new[] { 11.0 }), "changed pose writes once; repeated pose skips");
            var tolerant = new Harness(comparison: (a, b) =>
                PoseDifference.Compare(a, b, 1e-5, 1e-6, 1e-6, 1e-6));
            tolerant.Ready();
            tolerant.Adapter.OnWrite = () => tolerant.Adapter.Camera = Value(11.000001);
            tolerant.Dispatch(Pose(11, 1));
            tolerant.Scheduler.Run();
            Check(!tolerant.Messages.OfType<CameraDelta>().Any(), "adapter tolerance suppresses rounding correction");
            tolerant.Adapter.Context = new object();
            tolerant.Session.CheckContext();
            tolerant.Scheduler.Run();
            Check(tolerant.Messages.OfType<MotionCancel>().Any(), "explicit context check cancels stale binding");
            var h = new Harness();
            h.Start(); h.Query(first: new[] { "missing", "pick.cursor", "never" });
            for (int seq = 1; seq < 20; seq++) h.Dispatch(Pose(10 + seq, seq));
            Check(h.Adapter.Facts.Count == 0 && h.Adapter.Writes.Count == 0, "callbacks only enqueue");
            Check(h.Scheduler.Queue.Count == 1, "wake coalesced");
            h.Scheduler.Run();
            Check(h.Adapter.Writes.SequenceEqual(new[] { 29.0 }), "latest pose applied");
            Check(h.Adapter.Facts.SequenceEqual(new[] { "camera.pose", "missing", "pick.cursor" }), "short circuit uses evaluator");

            h = new Harness(); h.Ready();
            Task.Run(() => h.Dispatch(Pose(11, 1))).GetAwaiter().GetResult();
            Check(h.Adapter.Writes.Count == 0, "transport thread does not touch adapter");
            h.Scheduler.Run(); Check(h.Adapter.Writes.SequenceEqual(new[] { 11.0 }), "UI drain applies transport work");

            h = new Harness(); h.Start(); h.Query(); h.Dispatch(Pose(11, 1)); h.Dispatch(new MotionEnd { GestureId = 7 });
            h.Scheduler.Run(); Check(h.Adapter.Writes.SequenceEqual(new[] { 11.0 }), "query and final pose in one drain");

            h = new Harness(); h.Start(); h.Query(gesture: null); h.Dispatch(Pose(11, 1)); h.Scheduler.Run();
            Check(h.Adapter.Writes.Count == 0, "unscoped query cannot authorize camera");

            h = new Harness(); h.Start(); h.Adapter.OnFact = () => h.Adapter.Context = new object(); h.Query(); h.Scheduler.Run();
            Check(h.Messages.OfType<Response>().Count() == 1 && h.Messages.OfType<Response>().Single().Error != null,
                "invalid context fails query once");
            Check(h.Messages.OfType<MotionCancel>().Count() == 1, "invalid context sends cancellation");

            h = new Harness(); h.Start(); h.Adapter.OnFact = () => h.Start(8); h.Query(); h.Scheduler.Run();
            Check(h.Messages.OfType<Response>().Count() == 1, "replacement during query retires once");

            h = new Harness(); h.Ready(); h.Adapter.ReadFail = true; h.Dispatch(Pose(20, 1)); h.Scheduler.Run();
            h.Adapter.ReadFail = false; h.Dispatch(Pose(21, 2)); h.Scheduler.Run();
            Check(h.Adapter.Writes.SequenceEqual(new[] { 20.0, 21.0 }), "read failure retries next frame");
            Check(!h.Messages.OfType<CameraDelta>().Any(), "SDK motion not reported as native input");

            h = new Harness(); h.Ready(); h.Adapter.Camera = Value(12); h.Session.NativeCameraChanged(); h.Scheduler.Run();
            h.Adapter.Camera = Value(15); h.Query(2); h.Dispatch(Pose(12, 1, ack: 0)); h.Scheduler.Run();
            Check(h.Messages.OfType<CameraDelta>().Select(m => m.T[0]).SequenceEqual(new[] { 2.0, 3.0 }),
                "query preserves baseline behind pending correction");
            Check(h.Adapter.Writes.Count == 0, "correction barrier prevents native overwrite");

            h = new Harness(); h.Ready(); h.Adapter.Camera = Value(12); h.Session.NativeCameraChanged(); h.Scheduler.Run();
            h.Now = 2; h.Scheduler.Timers[0](); h.Scheduler.Run();
            Check(h.Messages.OfType<MotionCancel>().Any(m => m.Reason == "camera_delta_timeout"), "timeout without new poses");

            h = new Harness(); h.FailResponse = true; h.Start(); h.Query(); h.Scheduler.Run();
            Check(h.Messages.OfType<MotionCancel>().Any(), "reply send failure cancels");
            h.Dispatch(Pose(20, 1)); h.Scheduler.Run(); Check(h.Adapter.Writes.Count == 0, "failed reply invalidates readiness");

            h = new Harness(maxQueries: 2, budget: 1); h.Start();
            for (int i = 0; i < 5; i++) h.Query(i);
            h.Scheduler.Run();
            Check(h.Messages.OfType<Response>().Count() == 5, "all overflow requests terminated");
            Check(h.Messages.OfType<Response>().Count(m => m.Error != null) == 3, "bounded query mailbox");

            h = new Harness(budget: 1); h.Ready();
            h.Adapter.OnWrite = () => { h.Start(8); h.Query(2, 8); h.Session.Drain(); };
            h.Dispatch(Pose(11, 1)); h.Scheduler.Run();
            Check(h.Adapter.Writes.SequenceEqual(new[] { 11.0 }), "reentrant drain does not write twice");
            Check(h.Messages.OfType<Response>().Any(m => m.Id == 2 && m.Error == null), "replacement work not lost during drain");

            h = new Harness(); h.Start(); h.Query(); h.State(ConnectionState.Disconnected);
            h.Messages = new List<Msg>(); h.State(ConnectionState.Connected); h.Scheduler.Run();
            Check(h.Messages.Count == 0, "old queued reply never goes to new connection");

            h = new Harness(); h.Start(); h.Query(); h.Session.Dispose(); h.Scheduler.Run();
            Check(h.Adapter.Facts.Count == 0, "close retires queued query without adapter calls");
            var replacement = new NavigationSession(h.Client, h.Adapter, h.Scheduler);
            replacement.Dispose(); // detach released exclusive ownership

            h = new Harness();
            bool duplicateRejected = false;
            try { _ = new NavigationSession(h.Client, h.Adapter, h.Scheduler); }
            catch (InvalidOperationException) { duplicateRejected = true; }
            Check(duplicateRejected, "attachment is exclusive");

            h = new Harness(); h.Ready(); h.Adapter.OnWrite = () => h.Adapter.Context = new object();
            h.Dispatch(Pose(11, 1)); h.Scheduler.Run();
            Check(h.Messages.OfType<MotionCancel>().Any(), "unannounced context change during write cancels");

            h = new Harness(); h.Ready();
            h.Dispatch(new CameraPivot { GestureId = 7, Point = new[] { 1.0, 2.0, 3.0 } }); h.Scheduler.Run();
            h.Dispatch(Pose(11, 1)); h.Session.ContextChanged(); h.Scheduler.Run();
            Check(h.Adapter.Writes.Count == 0 && h.Adapter.Pivots.Last() == null, "cancel retires pose and hides pivot");

            h = new Harness(); h.Ready();
            var delayed = new TaskCompletionSource<bool>();
            h.SendOverride = message => message is Response response && response.Id == 2 ? delayed.Task : Task.CompletedTask;
            h.Query(2); h.Scheduler.Run();
            h.State(ConnectionState.Disconnected); h.State(ConnectionState.Connected); h.Start(); h.Query(3); h.Scheduler.Run();
            delayed.SetException(new Exception("old reply failed")); h.Scheduler.Run();
            h.Dispatch(Pose(20, 2)); h.Scheduler.Run();
            Check(h.Adapter.Writes.SequenceEqual(new[] { 20.0 }), "old reply failure does not cancel new connection");

            h = new Harness(); h.Ready(); h.Query(2, values: new[] { "object.pose" }); h.Scheduler.Run();
            Check(((Dictionary<string, object>)h.Messages.OfType<Response>().Last().Result!["values"]).Count == 0, "object facts unavailable");
            h.Dispatch(new ObjectPose { GestureId = 7, Seq = 1 }); h.Scheduler.Run();
            Check(h.Messages.OfType<MotionCancel>().Any(m => m.Reason == "object_navigation_unsupported"), "object output explicitly rejected");

            h = new Harness(budget: 1); h.Ready();
            h.Adapter.OnWrite = () => h.Dispatch(Pose(12, 2)); h.Dispatch(Pose(11, 1)); h.Scheduler.Run();
            Check(h.Adapter.Writes.SequenceEqual(new[] { 11.0, 12.0 }), "work arriving during last budget item gets another wake");

            h = new Harness(); h.Ready();
            h.Adapter.Camera = new CameraPoseValue(new Vec3(10, 0, 0), new Vec3(0, 0, 0), orthoExtent: 20);
            h.Session.NativeCameraChanged(); h.Scheduler.Run();
            Check(h.Messages[h.Messages.Count - 2] is CameraPose rebase && rebase.Seq == null && rebase.OrthoExtent == 20,
                "rebase sends actual absolute camera without server fields");
            var marker = (CameraDelta)h.Messages.Last();
            Check(marker.T.All(v => v == 0) && marker.R.All(v => v == 0), "rebase followed by identity delta");
            h.Dispatch(new CameraPose { GestureId = 7, Seq = 1, T = new[] { 10.0, 0.0, 0.0 }, OrthoExtent = 20 });
            h.Scheduler.Run();
            Check(h.Adapter.Writes.Count == 0, "matching unacknowledged rebase never writes");
            h.Dispatch(new CameraPose { GestureId = 7, Seq = 2, T = new[] { 12.0, 0.0, 0.0 }, OrthoExtent = 20 });
            h.Scheduler.Run();
            Check(h.Adapter.Writes.Count == 0, "matching old pose did not release barrier for subsequent output");
            h.Dispatch(new CameraPose { GestureId = 7, Seq = 3, T = new[] { 11.0, 0.0, 0.0 }, OrthoExtent = 20,
                AppliedDeltaId = marker.DeltaId }); h.Scheduler.Run();
            Check(h.Adapter.Writes.SequenceEqual(new[] { 11.0 }), "incorporating pose releases rebase barrier");

            foreach (var failedPart in new[] { "camera.pose", "camera.delta" })
            {
                h = new Harness(); h.Ready();
                var current = h;
                h.SendOverride = message =>
                {
                    if (message.Type == failedPart) throw new Exception("rebase send failed");
                    current.Messages.Add(message); return Task.CompletedTask;
                };
                h.Adapter.Camera = new CameraPoseValue(new Vec3(10, 0, 0), new Vec3(0, 0, 0), orthoExtent: 20);
                h.Session.NativeCameraChanged(); h.Scheduler.Run();
                Check(h.Messages.OfType<MotionCancel>().Any(), "failure of either rebase send cancels");
                if (failedPart == "camera.pose") Check(!h.Messages.OfType<CameraDelta>().Any(), "no marker after failed rebase");
            }

            h = new Harness(); h.Ready();
            h.Dispatch(new NavigationState { GestureId = 7, Camera = new CameraNavigationState { Mode = "orbit" } });
            h.Dispatch(Pose(11, 1)); h.Scheduler.Run();
            Check(h.Adapter.Writes.Count == 0 && h.Scheduler.Queue.Count == 0, "orbit pose waits for pivot without spinning");
            h.Dispatch(new CameraPivot { GestureId = 7, Point = new[] { 1.0, 0.0, 0.0 } }); h.Scheduler.Run();
            Check(h.Adapter.Writes.SequenceEqual(new[] { 11.0 }), "pivot releases deferred orbit pose");

            var observer = new BrokenObserver();
            h = new Harness(observer: observer);
            var observed = h;
            observer.Verify = () => observed.Adapter.IsCurrent(observed.Adapter.Context);
            h.Ready(); h.Dispatch(Pose(11, 1)); h.Scheduler.Run();
            Check(observer.Calls >= 4, "observer ran through query lifecycle");
            Check(h.Adapter.Writes.SequenceEqual(new[] { 11.0 }) && h.Messages.OfType<Response>().Count() == 1,
                "observer errors cannot fail writes or duplicate query completion");

            Console.WriteLine($"Navigation coordinator checks passed: {_checks}");
            return _checks;
        }
    }
}
