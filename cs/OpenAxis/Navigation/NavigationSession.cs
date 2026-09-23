// Synchronous-adapter coordinator. Native callbacks run on the supplied scheduler.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading.Tasks;
using OpenAxis.Client;
using OpenAxis.Geometry;

namespace OpenAxis.Navigation
{
    public interface INavigationScheduler
    {
        void Post(Action callback); // thread-safe enqueue, never inline
        void PostAt(double deadline, Action callback); // same monotonic clock as session
    }
    public interface INavigationCapture
    {
        object? Resolve(string name);
        CameraPoseValue? InitialCameraObservation();
    }
    public readonly struct NavigationWriteResult
    {
        public readonly bool Success;
        public readonly CameraPoseValue? Realized;
        public NavigationWriteResult(bool success, CameraPoseValue? realized = null)
        { Success = success; Realized = realized; }
    }
    public interface INavigationAdapter
    {
        object? CaptureContext();
        bool IsCurrent(object context);
        INavigationCapture BeginQuery(object context);
        NavigationWriteResult ApplyCamera(object context, CameraPoseValue desired, NavigationState? state, Vec3? pivot);
        void ShowPivot(object context, Vec3? point); // no-op if no renderer
    }

    public sealed class NavigationSession : OpenAxisListenerBase, IDisposable
    {
        private sealed class QueryWork
        {
            internal readonly NavigationQuery Query;
            internal readonly SessionToken? Token;
            internal readonly long Epoch;
            internal readonly Func<Msg, Task>? Send;
            internal QueryWork(NavigationQuery query, SessionToken? token, long epoch, Func<Msg, Task>? send)
            { Query = query; Token = token; Epoch = epoch; Send = send; }
        }
        private sealed class Work
        {
            internal readonly string Kind;
            internal readonly SessionToken? Token;
            internal readonly object? Value;
            internal Work(string kind, SessionToken? token, object? value) { Kind = kind; Token = token; Value = value; }
        }
        private sealed class Binding
        {
            internal readonly SessionToken Token;
            internal readonly object Context;
            internal Binding(SessionToken token, object context) { Token = token; Context = context; }
        }

        private readonly object _gate = new object();
        private readonly SessionState _state;
        private readonly SessionState _objects;
        private readonly INavigationObjectAdapter? _objectAdapter;
        private readonly Func<object, ObjectPoseValue?>? _objectObservation;
        private Binding? _objectContext;
        private Vec3? _objectPivot;
        private readonly INavigationAdapter _adapter;
        private readonly INavigationScheduler _scheduler;
        private readonly Func<object, CameraPoseValue?>? _observation;
        private readonly Func<double> _clock;
        private readonly Func<Func<Msg, Task>> _captureSender;
        private readonly Action _detach;
        private readonly LinkedList<Work> _queue = new LinkedList<Work>();
        private readonly HashSet<QueryWork> _queries = new HashSet<QueryWork>();
        private readonly int _maxQueries, _maxWork, _budget;
        private bool _scheduled, _draining, _closed, _cleanup;
        private Binding? _context;
        private NavigationState? _navigation;
        private Vec3? _pivot;
        private Work? _deferredPose;
        private Func<Msg, Task>? _send;
        private readonly NavigationObserver? _observer;
        private readonly OpenAxis.Diagnostics.NavigationDiagnostics? _diagnostics;
        private readonly NavigationPerformance _performance = new();
        private long? _uiGesture;
        private string _cleanupReason = "connection_changed";

        public bool IsActive { get { lock (_gate) return !_closed && _state.GestureId.HasValue && !_state.Ending; } }

        private void Notify(Action<NavigationObserver> callback)
        {
            if (_diagnostics != null) try { callback(_diagnostics); } catch { }
            if (_observer == null) return;
            try { callback(_observer); }
            catch (Exception ex) { Trace.TraceInformation($"Navigation observer failed: {ex.Message}"); }
        }

        public NavigationSession(OpenAxisClient client, INavigationAdapter adapter, INavigationScheduler scheduler,
            Func<object, CameraPoseValue?>? observation = null, Func<double>? clock = null,
            double timeout = 1, int maxQueries = 32, int maxWork = 64, int drainBudget = 32,
            Func<CameraPoseValue, CameraPoseValue, PoseDifference>? comparison = null,
            NavigationObserver? observer = null, INavigationObjectAdapter? objectAdapter = null,
            Func<object, ObjectPoseValue?>? objectObservation = null,
            Func<ObjectPoseValue, ObjectPoseValue, PoseDifference>? objectComparison = null,
            OpenAxis.Diagnostics.NavigationDiagnostics? diagnostics = null)
            : this(client, adapter, scheduler, client.CaptureNavigationSender, observation, clock,
                timeout, maxQueries, maxWork, drainBudget, comparison, observer, objectAdapter,
                objectObservation, objectComparison, diagnostics)
        { }

        // Tests replace transport without exposing an escape hatch from captured-
        // connection delivery guarantees to integration authors.
        internal NavigationSession(OpenAxisClient client, INavigationAdapter adapter, INavigationScheduler scheduler,
            Func<Func<Msg, Task>> captureSender,
            Func<object, CameraPoseValue?>? observation = null, Func<double>? clock = null,
            double timeout = 1, int maxQueries = 32, int maxWork = 64, int drainBudget = 32,
            Func<CameraPoseValue, CameraPoseValue, PoseDifference>? comparison = null,
            NavigationObserver? observer = null, INavigationObjectAdapter? objectAdapter = null,
            Func<object, ObjectPoseValue?>? objectObservation = null,
            Func<ObjectPoseValue, ObjectPoseValue, PoseDifference>? objectComparison = null,
            OpenAxis.Diagnostics.NavigationDiagnostics? diagnostics = null)
        {
            if (Math.Min(maxQueries, Math.Min(maxWork, drainBudget)) < 1) throw new ArgumentOutOfRangeException(nameof(maxQueries));
            _adapter = adapter; _scheduler = scheduler; _observation = observation;
            _observer = observer;
            _diagnostics = diagnostics;
            _diagnostics?.Bind(comparison, objectComparison);
            _clock = clock ?? (() => Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency);
            _state = new SessionState(comparison: comparison, timeout: timeout);
            _objectAdapter = objectAdapter; _objectObservation = objectObservation;
            _objects = new SessionState(comparison: (a, b) => objectComparison == null ? PoseDifference.Compare(a, b) : objectComparison(ObjectPoseValue.FromState(a), ObjectPoseValue.FromState(b)), timeout: timeout);
            _maxQueries = maxQueries; _maxWork = maxWork; _budget = drainBudget;
            _captureSender = captureSender ?? throw new ArgumentNullException(nameof(captureSender));
            _detach = client.AttachNavigation(this);
            try
            {
                if (client.State == ConnectionState.Connected) OnStateChange(client.State);
            }
            catch
            {
                _detach();
                throw;
            }
        }

        private void PostDiagnostic(Action<NavigationObserver> action)
        {
            try { _scheduler.Post(() => { if (!_closed) Notify(action); }); }
            catch { } // Optional observer dispatch must not change navigation.
        }

        private void Wake()
        {
            lock (_gate)
            {
                if (_scheduled || _draining || (_queue.Count == 0 && !_cleanup && !_state.Ending)) return;
                _scheduled = true;
            }
            try { _scheduler.Post(Drain); }
            catch { lock (_gate) _scheduled = false; throw; }
        }

        private bool Enqueue(string kind, SessionToken? token, object? value = null)
        {
            var work = new Work(kind, token, value);
            var pose = kind == "pose" || kind == "object_pose";
            if (pose)
            {
                // A stream owns one pending pose slot in addition to the bounded
                // control/query queue. Append at its latest arrival position so a
                // replacement cannot overtake an intervening query or pivot.
                var sequence = ((AcceptedCameraPose)value!).Sequence;
                if (_queue.Any(w => w.Kind == kind && Nullable.Equals(w.Token, token)
                    && ((AcceptedCameraPose)w.Value!).Sequence >= sequence)) return true;
                var previous = _queue.Count;
                RemoveWork(w => w.Kind == kind && Nullable.Equals(w.Token, token));
                var perf = token.HasValue ? _performance.Stream(token.Value, kind == "object_pose") : null;
                if (perf != null) perf.Coalesced += previous - _queue.Count;
                _queue.AddLast(work);
            }
            else if (_queue.Last != null && kind != "query" && _queue.Last.Value.Kind == kind
                && Nullable.Equals(_queue.Last.Value.Token, token)) _queue.Last.Value = work;
            else if (_queue.Count(w => w.Kind != "pose" && w.Kind != "object_pose") < _maxWork) _queue.AddLast(work);
            else return false;
            return true;
        }

        private void RemoveWork(Func<Work, bool> remove)
        {
            var node = _queue.First;
            while (node != null)
            {
                var next = node.Next;
                if (remove(node.Value)) _queue.Remove(node);
                node = next;
            }
        }

        public override void OnStateChange(ConnectionState state)
        {
            QueryWork[] retired;
            lock (_gate)
            {
                if (_closed) return;
                _performance.Finish("connection_changed", _clock());
                _state.Connection(); _objects.Connection();
                retired = _queries.ToArray();
                _queue.Clear();
                _cleanup = true;
                _cleanupReason = "connection_changed";
                _send = state == ConnectionState.Connected ? _captureSender() : null;
            }
            foreach (var work in retired) Reply(work, null, false);
            Wake();
        }

        public override void OnMotionStart(long gestureId)
        {
            QueryWork[] retired;
            lock (_gate)
            {
                if (_closed || _send == null) return;
                _state.Start(gestureId); _objects.Start(gestureId);
                _performance.Begin(gestureId, _state.Token, _clock());
                retired = _queries.Where(q => q.Token.HasValue).ToArray();
                RemoveWork(w => w.Kind != "query" || ((QueryWork)w.Value!).Token.HasValue);
                _cleanup = true;
                _cleanupReason = "superseded";
            }
            foreach (var work in retired) Reply(work, null);
            Wake();
        }

        public override void OnMotionEnd(long gestureId)
        {
            lock (_gate)
            {
                if (_closed || gestureId != _state.GestureId) return;
                _state.End(_state.Token); _objects.End(_objects.Token);
            }
            Wake();
        }

        public override bool OnNavigationQuery(NavigationQuery query)
        {
            QueryWork work;
            bool accepted;
            lock (_gate)
            {
                work = new QueryWork(query, query.Scoped ? _state.Token : (SessionToken?)null, _state.Epoch, _send);
                _queries.Add(work);
                accepted = !_closed && _send != null && _queries.Count <= _maxQueries
                    && (!query.Scoped || (query.GestureId == _state.GestureId && !_state.Ending))
                    && Enqueue("query", work.Token, work);
            }
            if (!accepted) Reply(work, null);
            Wake();
            return true;
        }

        public override void OnCameraPose(CameraPose pose)
        {
            bool rejected;
            lock (_gate)
            {
                if (_closed || !pose.Seq.HasValue || !pose.GestureId.HasValue) return;
                var accepted = _state.Receive(_state.Epoch, pose.GestureId.Value, pose.Seq.Value,
                    new CameraPoseValue(new Vec3(pose.T[0], pose.T[1], pose.T[2]),
                        new Vec3(pose.R[0], pose.R[1], pose.R[2]), pose.Fov, pose.OrthoExtent), pose.AppliedDeltaId);
                rejected = accepted == null;
                if (accepted != null) {
                    var perf = _performance.Stream(accepted.Token);
                    if (_deferredPose?.Value is AcceptedCameraPose deferred && deferred.Token.Equals(accepted.Token)
                        && perf != null && perf.IsPending(deferred.Sequence)) perf.Coalesced++;
                    perf?.Receive(accepted.Sequence, _clock());
                    Enqueue("pose", accepted.Token, accepted);
                }
            }
            if (rejected) PostDiagnostic(o => o.OutputRejected("camera.pose", pose.GestureId!.Value, "inactive_or_stale_output"));
            Wake();
        }
        public override void OnNavigationState(NavigationState state) => Feedback("navigation", state.GestureId, NavigationState.Unpack(state.Pack()));
        public override void OnCameraPivot(CameraPivot pivot) => Feedback("pivot", pivot.GestureId, new Vec3(pivot.Point[0], pivot.Point[1], pivot.Point[2]));
        public override void OnObjectPose(ObjectPose pose)
        {
            SessionEffect? effect = null;
            bool rejected = false;
            lock (_gate)
            {
                if (_closed || !pose.Seq.HasValue || !pose.GestureId.HasValue) return;
                if (_objectAdapter == null && pose.GestureId == _state.GestureId)
                    effect = _state.Cancel(_state.Token, "object_navigation_unsupported");
                else
                {
                    var accepted = _objects.Receive(_objects.Epoch, pose.GestureId.Value, pose.Seq.Value,
                        new ObjectPoseValue(new Vec3(pose.T[0], pose.T[1], pose.T[2]), new Vec3(pose.R[0], pose.R[1], pose.R[2])).ToState(), pose.AppliedDeltaId);
                    rejected = accepted == null;
                    if (accepted != null) {
                    _performance.Stream(accepted.Token, true)?.Receive(accepted.Sequence, _clock());
                    Enqueue("object_pose", accepted.Token, accepted);
                }
                }
            }
            if (effect != null) Publish(effect);
            if (rejected) PostDiagnostic(o => o.OutputRejected("object.pose", pose.GestureId!.Value, "inactive_or_stale_output"));
            Wake();
        }
        public override void OnObjectPivot(ObjectPivot pivot) => Feedback("object_pivot", pivot.GestureId, new Vec3(pivot.Point[0], pivot.Point[1], pivot.Point[2]));
        public void NativeObjectChanged()
        {
            lock (_gate) if (!_closed && _objects.Ready) Enqueue("object_observe", _objects.Token);
            Wake();
        }
        private void Feedback(string kind, long gestureId, object value)
        {
            lock (_gate)
                if (!_closed && gestureId == _state.GestureId && !_state.Ending) Enqueue(kind, _state.Token, value);
            Wake();
        }
        public void NativeCameraChanged()
        {
            lock (_gate) if (!_closed && _state.Ready) Enqueue("observe", _state.Token);
            Wake();
        }
        public void ContextChanged()
        {
            SessionEffect effect;
            lock (_gate) effect = _state.Cancel(_state.Token, "context_changed");
            Publish(effect);
        }

        public void CheckContext()
        {
            Binding? bound;
            lock (_gate) bound = _context;
            if (bound != null) Valid(bound.Token, bound.Context);
            lock (_gate) bound = _objectContext;
            if (bound != null) Valid(bound.Token, bound.Context, true);
        }

        private bool Valid(SessionToken token, object context, bool objects = false)
        {
            bool adapterValid;
            try { adapterValid = objects ? _objectAdapter!.IsCurrent(context) : _adapter.IsCurrent(context); } catch { adapterValid = false; }
            bool current;
            SessionEffect? effect = null;
            lock (_gate)
            {
                current = !_closed && _state.Current(token);
                if (current && !adapterValid) effect = _state.Cancel(token, "context_changed");
            }
            if (effect != null) Publish(effect);
            return current && adapterValid;
        }

        private void NotifyCorrection(bool objects, object context, string kind, long id, PoseDifference? difference)
            => Notify(o => { if (objects) o.ObjectCorrection(context, kind, id, difference); else o.Correction(context, kind, id, difference); });

        private bool BoundContextsValid(SessionToken token)
        {
            Binding? camera, objects;
            lock (_gate) { camera = _context; objects = _objectContext; }
            return (camera == null || !camera.Token.Equals(token) || Valid(token, camera.Context))
                && (objects == null || !objects.Token.Equals(token) || Valid(token, objects.Context, true));
        }

        private void Reply(QueryWork work, Dictionary<string, object>? result, bool wire = true)
        {
            bool valid;
            lock (_gate)
            {
                if (!_queries.Remove(work)) return;
                work.Query.Claim(); // no callback under lock; session owns the send
                valid = work.Epoch == _state.Epoch && !_closed;
            }
            if (wire && valid && work.Send != null)
                Submit(new Response { Id = work.Query.RequestId, Result = result,
                    Error = result == null ? new RpcError { Code = "unavailable", Message = "Navigation context unavailable" } : null },
                    work.Epoch, work.Send, work.Token);
        }

        private void Answer(QueryWork work)
        {
            Binding? bound;
            lock (_gate)
            {
                if (!_queries.Contains(work)) return;
                bound = work.Token.HasValue ? _context : null;
            }
            var started = _clock();
            try
            {
                if (work.Token.HasValue && !BoundContextsValid(work.Token.Value)) { Reply(work, null); return; }
                object? context = null;
                INavigationCapture? capture = null;
                object? objectContext = null;
                INavigationObjectCapture? objectCapture = null;
                ObjectPoseValue? objectFact = null;
                object? Resolve(string name)
                {
                    if (name.StartsWith("object.", StringComparison.Ordinal))
                    {
                        if (_objectAdapter == null) return NavigationQuery.Unavailable;
                        if (objectCapture == null)
                        {
                            var existing = work.Token.HasValue ? _objectContext : null;
                            objectContext = existing != null && existing.Token.Equals(work.Token!.Value) ? existing.Context : _objectAdapter.CaptureContext();
                            if (objectContext == null || !_objectAdapter.IsCurrent(objectContext)) return NavigationQuery.Unavailable;
                            objectCapture = _objectAdapter.BeginQuery(objectContext);
                            if (capture == null) Notify(o => o.QueryStarted(objectContext, work.Query));
                        }
                    }
                    else if (capture == null)
                    {
                        context = bound != null && bound.Token.Equals(work.Token!.Value) ? bound.Context : _adapter.CaptureContext();
                        if (context == null || ReferenceEquals(context, NavigationQuery.Unavailable) || !_adapter.IsCurrent(context))
                            throw new InvalidOperationException("Navigation context unavailable");
                        capture = _adapter.BeginQuery(context);
                        if (objectCapture == null) Notify(o => o.QueryStarted(context, work.Query));
                    }
                    var factStarted = _clock();
                    object? value;
                    try { value = name.StartsWith("object.", StringComparison.Ordinal) ? objectCapture!.Resolve(name) : capture!.Resolve(name); }
                    catch (Exception ex)
                    {
                        Trace.TraceInformation($"Navigation fact {name} failed: {ex.Message}");
                        Notify(o => o.FactFailed(name, ex.Message, (_clock() - factStarted) * 1000));
                        value = NavigationQuery.Unavailable;
                    }
                    Notify(o => o.Fact(name, value, (_clock() - factStarted) * 1000));
                    if (name == "camera.pose" && value != null && !ReferenceEquals(value, NavigationQuery.Unavailable))
                        CameraPose.FromValue((Dictionary<string, object>)value);
                    if (name == "object.pose" && value != null && !ReferenceEquals(value, NavigationQuery.Unavailable))
                    {
                        var pose = ObjectPose.FromValue((Dictionary<string, object>)value);
                        objectFact = new ObjectPoseValue(new Vec3(pose.T[0], pose.T[1], pose.T[2]), new Vec3(pose.R[0], pose.R[1], pose.R[2]));
                    }
                    return value;
                }
                var result = work.Query.Evaluate(Resolve);
                var adapterValid = (context == null || _adapter.IsCurrent(context)) && (objectContext == null || _objectAdapter!.IsCurrent(objectContext));
                if (work.Token.HasValue) adapterValid &= BoundContextsValid(work.Token.Value);
                ObjectPoseValue? objectInitial = _objectObservation == null ? objectFact : null;
                if (_objectObservation != null && objectCapture != null) try { objectInitial = objectCapture.InitialObjectObservation(); } catch { }
                CameraPoseValue? observation = null;
                if (_observation != null && capture != null)
                    try { observation = capture.InitialCameraObservation(); } catch { }
                bool valid;
                lock (_gate)
                {
                    valid = _queries.Contains(work) && work.Epoch == _state.Epoch && !_closed && adapterValid
                        && (!work.Token.HasValue || _state.Current(work.Token.Value));
                    if (valid && work.Token.HasValue)
                    {
                        if (context != null) _context = new Binding(work.Token.Value, context);
                        var supplied = ((Dictionary<string, object>)result["values"]).ContainsKey("camera.pose")
                            || (result.TryGetValue("first", out var first) && first is Dictionary<string, object> winner
                                && (string)winner["name"] == "camera.pose");
                        if (supplied) valid = _state.CameraQuery(work.Token.Value, observation, allowEnding: true);
                        var objectSupplied = ((Dictionary<string, object>)result["values"]).ContainsKey("object.pose")
                            || (result.TryGetValue("first", out var objectFirst) && objectFirst is Dictionary<string, object> objectWinner && (string)objectWinner["name"] == "object.pose");
                        if (objectContext != null) _objectContext = new Binding(work.Token.Value, objectContext);
                        if (objectSupplied) valid &= _objects.CameraQuery(work.Token.Value, objectInitial?.ToState(), allowEnding: true);
                    }
                }
                if (!valid && work.Token.HasValue) CancelQueryContext(work.Token.Value);
                Reply(work, valid ? result : null);
                if (valid) Notify(o => o.QueryCompleted(work.Query, result, (_clock() - started) * 1000));
                else Notify(o => o.QueryFailed(work.Query, "Navigation context changed", (_clock() - started) * 1000));
            }
            catch (Exception ex)
            {
                Trace.TraceInformation($"Navigation fact collection failed: {ex.Message}");
                Reply(work, null);
                Notify(o => o.QueryFailed(work.Query, ex.Message, (_clock() - started) * 1000));
            }
        }
        private void CancelQueryContext(SessionToken token)
        {
            SessionEffect effect;
            lock (_gate) effect = _state.Cancel(token, "context_changed");
            Publish(effect);
        }

        private void Process(Work work)
        {
            Binding? bound;
            bool current;
            var objects = work.Kind.StartsWith("object_", StringComparison.Ordinal);
            var stream = objects ? _objects : _state;
            var token = work.Token!.Value;
            lock (_gate) current = !_closed && _state.Current(token);
            if (!current) return;
            if (!BoundContextsValid(token)) return;
            if (work.Kind == "navigation") { _navigation = (NavigationState)work.Value!; Notify(o => o.NavigationStateChanged(_navigation)); ReleaseDeferred(); return; }
            lock (_gate) { bound = objects ? _objectContext : _context; current = !_closed && _state.Current(token); }
            if (!current || bound == null || !bound.Token.Equals(token) || !Valid(token, bound.Context, objects)) return;
            var context = bound.Context;
            if (work.Kind == "object_pivot") { _objectPivot = (Vec3)work.Value!; try { _objectAdapter!.ShowPivot(context, _objectPivot); } catch { } return; }
            if (work.Kind == "pivot") { _pivot = (Vec3)work.Value!; try { _adapter.ShowPivot(context, _pivot); } catch { } ReleaseDeferred(); return; }
            if (work.Kind == "pose" && _navigation?.Camera?.Mode == "orbit" && !_pivot.HasValue)
            { _deferredPose = work; return; }
            PerformanceStream? perf;
            double? receivedAt = null;
            lock (_gate) {
                perf = _performance.Stream(token, objects);
                if (work.Value is AcceptedCameraPose queued) receivedAt = perf?.Process(queued.Sequence, _clock());
            }
            CameraPoseValue? actual = null;
            var hasObservation = objects ? _objectObservation != null : _observation != null;
            var observationStarted = hasObservation ? _clock() : 0;
            if (objects) { if (_objectObservation != null) try { actual = _objectObservation(context)?.ToState(); } catch { } }
            else if (_observation != null) try { actual = _observation(context); } catch { }
            if (hasObservation) perf?.Observation.Add(_clock() - observationStarted);
            if (!Valid(token, context, objects)) return;
            SessionEffect effect;
            long? pendingBefore, pendingAfter;
            lock (_gate)
            {
                pendingBefore = stream.PendingId;
                effect = (work.Kind == "pose" || work.Kind == "object_pose") ? stream.Process((AcceptedCameraPose)work.Value!, actual, _clock())
                    : stream.Observe(token, actual, _clock());
                pendingAfter = stream.PendingId;
            }
            if (work.Value is AcceptedCameraPose accepted && pendingBefore.HasValue
                && pendingBefore != pendingAfter && accepted.AppliedDeltaId >= pendingBefore)
                NotifyCorrection(objects, context, "applied", pendingBefore.Value, null);
            if (pendingAfter.HasValue && effect.Kind != "delta" && effect.Kind != "rebase")
                NotifyCorrection(objects, context, "waiting", pendingAfter.Value, null);
            if (effect.Kind == "apply")
            {
                if (!Valid(token, context, objects) || !BoundContextsValid(token))
                {
                    lock (_gate) stream.CompleteWrite(effect.Write!, null, _clock(), false);
                    return;
                }
                NavigationWriteResult result;
                var applyStarted = _clock();
                try
                {
                    if (objects)
                    {
                        var written = _objectAdapter!.ApplyObject(context, ObjectPoseValue.FromState(((AcceptedCameraPose)work.Value!).Pose), _navigation, _objectPivot);
                        result = new NavigationWriteResult(written.Success, written.Realized?.ToState());
                    }
                    else result = _adapter.ApplyCamera(context, ((AcceptedCameraPose)work.Value!).Pose, _navigation, _pivot);
                }
                catch { result = new NavigationWriteResult(false); }
                perf?.Applied(applyStarted, _clock(), result.Success, receivedAt);
                Notify(o => o.WriteCompleted(context, objects ? "object" : "camera", ((AcceptedCameraPose)work.Value!).Pose, result.Realized, result.Success));
                Valid(token, context, objects); // completion must not seed an invalid adapter context
                BoundContextsValid(token);
                lock (_gate) effect = stream.CompleteWrite(effect.Write!, objects || _observation != null ? result.Realized : null, _clock(), result.Success);
            }
            if (effect.Kind == "delta" || effect.Kind == "rebase")
                NotifyCorrection(objects, context, effect.Kind, effect.DeltaId!.Value, effect.Difference);
            Publish(effect, objects);
        }

        private void ReleaseDeferred()
        {
            if (_deferredPose == null || (_navigation?.Camera?.Mode == "orbit" && !_pivot.HasValue)) return;
            var work = _deferredPose;
            _deferredPose = null;
            lock (_gate) Enqueue(work.Kind, work.Token, work.Value);
        }

        private void Submit(Msg message, long epoch, Func<Msg, Task>? send, SessionToken? token = null, long? deltaId = null, Msg? before = null, bool objects = false)
        {
            if (send == null) return;
            var stream = objects ? _objects : _state;
            _ = Deliver();
            async Task Deliver()
            {
                lock (_gate)
                {
                    if (epoch != _state.Epoch || _closed) return;
                    if (deltaId.HasValue && (!_state.Current(token!.Value) || stream.PendingId != deltaId)) return;
                }
                try
                {
                    if (before != null) await send(before).ConfigureAwait(false);
                    lock (_gate)
                    {
                        if (epoch != _state.Epoch || _closed) return;
                        if (deltaId.HasValue && (!_state.Current(token!.Value) || stream.PendingId != deltaId)) return;
                    }
                    await send(message).ConfigureAwait(false);
                }
                catch
                {
                    SessionEffect? effect = null;
                    lock (_gate)
                    {
                        if (deltaId.HasValue) effect = stream.SendFailed(token!.Value, deltaId.Value);
                        else if (token.HasValue) effect = _state.Cancel(token.Value, "navigation_reply_send_failed");
                    }
                    if (effect != null) Publish(effect, objects);
                }
            }
        }

        private void Publish(SessionEffect effect, bool objects = false)
        {
            if (effect.Kind != "delta" && effect.Kind != "rebase" && effect.Kind != "cancel") return;
            if (objects && effect.Kind == "cancel" && effect.Reason != null && effect.Reason.StartsWith("camera_", StringComparison.Ordinal))
                effect = new SessionEffect("cancel", effect.Token, effect.GestureId, reason: "object_" + effect.Reason.Substring(7));
            Func<Msg, Task>? send;
            double? deadline;
            QueryWork[] retired = Array.Empty<QueryWork>();
            var token = effect.Token!.Value;
            lock (_gate)
            {
                send = _send; deadline = (objects ? _objects : _state).Deadline;
                if (effect.Kind == "cancel")
                {
                    _performance.Finish(effect.Reason!, _clock(), effect.Token);
                    _state.Cancel(token, effect.Reason ?? "cancelled");
                    _objects.Cancel(token, effect.Reason ?? "cancelled");
                    if (token.Epoch == _state.Epoch && _state.Generation == token.Generation + 1)
                    { _cleanup = true; _cleanupReason = effect.Reason ?? "cancelled"; }
                    RemoveWork(w => w.Token.HasValue && w.Token.Value.Equals(token));
                    retired = _queries.Where(q => q.Token.HasValue && q.Token.Value.Equals(token)).ToArray();
                }
            }
            foreach (var work in retired) Reply(work, null);
            if (effect.Kind == "delta" || effect.Kind == "rebase")
            {
                var d = effect.Difference!.Value;
                CameraPose? rebase = null;
                if (effect.Pose.HasValue)
                {
                    var p = effect.Pose.Value;
                    rebase = new CameraPose { GestureId = effect.GestureId!.Value,
                        T = new[] { p.Position.X, p.Position.Y, p.Position.Z },
                        R = new[] { p.RotationVector.X, p.RotationVector.Y, p.RotationVector.Z },
                        Fov = p.Fov, OrthoExtent = p.OrthoExtent };
                }
                if (objects) Submit(new ObjectDelta { GestureId = effect.GestureId!.Value,
                    T = new[] { d.Translation.X, d.Translation.Y, d.Translation.Z },
                    R = new[] { d.Rotation.X, d.Rotation.Y, d.Rotation.Z }, DeltaId = effect.DeltaId }, token.Epoch, send, token, effect.DeltaId, objects: true);
                else Submit(new CameraDelta { GestureId = effect.GestureId!.Value,
                    T = new[] { d.Translation.X, d.Translation.Y, d.Translation.Z },
                    R = new[] { d.Rotation.X, d.Rotation.Y, d.Rotation.Z },
                    OrthoExtentScale = d.Scale, DeltaId = effect.DeltaId }, token.Epoch, send, token, effect.DeltaId, before: rebase);
                if (deadline.HasValue) _scheduler.PostAt(deadline.Value, () => Timeout(token, effect.DeltaId!.Value, objects));
            }
            else
            {
                PostDiagnostic(o => o.Cancelled(effect.GestureId!.Value,effect.Reason ?? "cancelled"));
                Submit(new MotionCancel { GestureId = effect.GestureId!.Value, Reason = effect.Reason }, token.Epoch, send);
            }
            Wake();
        }
        private void Timeout(SessionToken token, long deltaId, bool objects)
        {
            SessionEffect effect;
            lock (_gate) effect = (objects ? _objects : _state).Expire(token, deltaId, _clock());
            Publish(effect, objects);
        }

        public void Drain()
        {
            lock (_gate)
            {
                _scheduled = false;
                if (_draining) return;
                _draining = true;
            }
            try
            {
                for (int i = 0; i < _budget; i++)
                {
                    bool cleanup;
                    string reason;
                    lock (_gate) { cleanup = _cleanup; reason = _cleanupReason; _cleanup = false; }
                    if (cleanup)
                    {
                        if (_context != null) try { _adapter.ShowPivot(_context.Context, null); } catch { }
                        if (_objectContext != null) try { _objectAdapter!.ShowPivot(_objectContext.Context, null); } catch { }
                        _objectContext = null; _objectPivot = null;
                        _context = null; _navigation = null; _pivot = null; _deferredPose = null;
                        if (_uiGesture.HasValue) Notify(o => o.GestureFinished(_uiGesture.Value, reason));
                        _uiGesture = null;
                    }
                    long? active;
                    lock (_gate) active = _closed ? null : _state.GestureId;
                    if (active.HasValue && _uiGesture != active)
                    {
                        _uiGesture = active;
                        Notify(o => o.GestureStarted(active.Value));
                    }
                    Work? work;
                    lock (_gate)
                    {
                        work = _queue.First?.Value;
                        if (work != null) _queue.RemoveFirst();
                        else if (_state.Ending) { _performance.Finish("motion_end", _clock()); _state.Finish(_state.Token); _objects.Finish(_objects.Token); _cleanup = true; _cleanupReason = "motion_end"; }
                    }
                    if (work == null) break;
                    if (work.Kind == "query") Answer((QueryWork)work.Value!); else Process(work);
                }
            }
            finally {
                List<PerformanceGesture>? reports;
                lock (_gate) reports = _performance.Take();
                NavigationPerformance.Flush(reports);
                lock (_gate) _draining = false;
                Wake();
            }
        }

        public void Dispose()
        {
            QueryWork[] retired;
            lock (_gate)
            {
                if (_closed) return;
                _performance.Finish("closed", _clock());
                _closed = true; _state.Connection(); _objects.Connection();
                retired = _queries.ToArray(); _queue.Clear(); _cleanup = true;
                _cleanupReason = "closed";
            }
            foreach (var work in retired) Reply(work, null, false);
            _detach();
            Wake();
        }
    }
}
