using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.WebSockets;
using System.Threading;
using System.Threading.Tasks;
using MessagePack;

namespace OpenAxis.Client
{
    public sealed class RpcRequestException : Exception
    {
        public string Code { get; }
        public RpcRequestException(string code, string? message) : base(message == null ? code : $"{code}: {message}")
        {
            Code = code;
        }
    }

    /// <summary>Async MessagePack-over-WebSocket client for OpenAxis 1.0.</summary>
    public sealed class OpenAxisClient
    {
        private const int MaxMessageBytes = 1024 * 1024;
        private static readonly MessagePackSerializerOptions SerializerOptions =
            MessagePackSerializerOptions.Standard.WithSecurity(MessagePackSecurity.UntrustedData);
        private readonly string _url;
        private readonly string _clientName;
        private readonly string? _clientVersion;
        private readonly Target? _target;
        private readonly IOpenAxisListener _listener;
        private IOpenAxisListener? _navigationListener;
        private readonly SemaphoreSlim _sendLock = new SemaphoreSlim(1, 1);
        private readonly object _pendingLock = new object();
        private readonly Dictionary<long, TaskCompletionSource<Response>> _pendingRequests = new Dictionary<long, TaskCompletionSource<Response>>();
        private long _nextRequestId;
        private long _lastSendTimestamp;
        private string? _lastVerificationFailure;
        private void ReportVerificationFailure(string message)
        {
            if (message == _lastVerificationFailure) return;
            _lastVerificationFailure = message;
            OpenAxis.Diagnostics.DiagnosticLog.Emit("warning", message);
        }
        private double? _verificationExpiry;
        private double _verificationDeadline;
        public string? VerificationStatus { get; private set; }
        private bool VerificationExpired => _verificationExpiry.HasValue &&
            (DateTimeOffset.UtcNow.ToUnixTimeSeconds() >= _verificationExpiry.Value || Stopwatch.GetTimestamp() >= _verificationDeadline);

        private volatile ConnectionState _state = ConnectionState.Disconnected;
        private ClientWebSocket? _ws;
        private CancellationTokenSource? _cts;
        private Task? _receiveTask;
        private Task? _heartbeatTask;
        private TaskCompletionSource<bool> _disconnected = CompletedSignal();

        public OpenAxisClient(string clientName, IOpenAxisListener? listener = null, string? url = null, Target? target = null, string? clientVersion = null)
        {
            if (string.IsNullOrWhiteSpace(clientName)) throw new ArgumentException("Client name is required", nameof(clientName));
            _url = url ?? Protocol.DefaultUrl;
            _clientName = clientName;
            _clientVersion = clientVersion == null ? null : MsgUtil.String(clientVersion, "clientVersion");
            _target = target == null ? null : Target.Unpack(target.Pack());
            _listener = listener ?? new OpenAxisListenerBase();
        }

        public ConnectionState State => _state;
        private long AllocateRequestId()
        {
            lock (_pendingLock)
            {
                if (_nextRequestId > Protocol.MaxInteger) throw new InvalidOperationException("OpenAxis request IDs exhausted");
                return _nextRequestId++;
            }
        }
        public string Url => _url;

        public Task WaitDisconnectedAsync() => _disconnected.Task;

        private static TaskCompletionSource<bool> CompletedSignal()
        {
            var signal = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            signal.SetResult(true);
            return signal;
        }

        internal Action AttachNavigation(IOpenAxisListener listener)
        {
            if (Interlocked.CompareExchange(ref _navigationListener, listener, null) != null)
                throw new InvalidOperationException("A Navigation session is already attached");
            return () => Interlocked.CompareExchange(ref _navigationListener, null, listener);
        }

        internal Func<Msg, Task> CaptureNavigationSender() => CaptureConnectionSender(CancellationToken.None);

        internal Func<Msg, Task> CaptureConnectionSender(CancellationToken cancellationToken)
        {
            var ws = _ws;
            var ct = _cts?.Token ?? CancellationToken.None;
            return async msg =>
            {
                using var linked = cancellationToken.CanBeCanceled
                    ? CancellationTokenSource.CreateLinkedTokenSource(ct, cancellationToken) : null;
                var sendToken = linked?.Token ?? ct;
                var bytes = MessagePackSerializer.Serialize(msg.Pack(), SerializerOptions);
                await _sendLock.WaitAsync(sendToken).ConfigureAwait(false);
                try
                {
                    if (VerificationExpired || _state == ConnectionState.Connecting || ws == null || !ReferenceEquals(_ws, ws) || ws.State != WebSocketState.Open)
                        throw new InvalidOperationException("Navigation connection was retired");
                    await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Binary, true, sendToken).ConfigureAwait(false);
                    Interlocked.Exchange(ref _lastSendTimestamp, Stopwatch.GetTimestamp());
                }
                finally { _sendLock.Release(); }
            };
        }

        public async Task ConnectAsync(CancellationToken ct = default)
        {
            if (_state != ConnectionState.Disconnected)
                throw new InvalidOperationException($"Cannot connect from state {_state}");
            SetState(ConnectionState.Connecting);
            _cts = new CancellationTokenSource();
            try
            {
                using (var connectCts = CancellationTokenSource.CreateLinkedTokenSource(ct, _cts.Token))
                {
                    _ws = new ClientWebSocket();
                    await _ws.ConnectAsync(new Uri(_url), connectCts.Token).ConfigureAwait(false);
                    await SendMsgAsync(new Hello { Proto = Protocol.Version, ClientName = _clientName, Target = _target,
                        ClientVersion = _clientVersion, Sdk = new SdkInfo { Name = "openaxis-csharp", Version = OpenAxis.Diagnostics.SdkVersion.Value } }).ConfigureAwait(false);
                    var ack = await ReceiveOneAsync(connectCts.Token).ConfigureAwait(false) as HelloAck;
                    if (ack == null) throw new InvalidOperationException("Expected hello_ack");
                    if (ack.Proto != Protocol.Version)
                        throw new InvalidOperationException($"Server selected unsupported protocol '{ack.Proto}'");
                    using var proofCts = CancellationTokenSource.CreateLinkedTokenSource(connectCts.Token);
                    proofCts.CancelAfter(TimeSpan.FromSeconds(10));
                    var challenge = new byte[32];
                    using (var rng = System.Security.Cryptography.RandomNumberGenerator.Create()) rng.GetBytes(challenge);
                    var id = AllocateRequestId();
                    await SendMsgAsync(new Request { Id = id, Method = "q", Params = new Dictionary<string, object> { { "v", 1 }, { "c", challenge } } }).ConfigureAwait(false);
                    while (true)
                    {
                        var incoming = await ReceiveOneAsync(proofCts.Token).ConfigureAwait(false);
                        if (incoming is Error failure) throw Verification.RemoteFailure(failure.Code, ReportVerificationFailure);
                        if (incoming is not Response response || response.Id != id) continue;
                        if (response.Error != null) throw Verification.RemoteFailure(response.Error.Code, ReportVerificationFailure);
                        var result = response.Result ?? new Dictionary<string, object>();
                        if (MessagePackSerializer.Serialize(result, SerializerOptions).Length > 20 * 1024) throw new VerificationException();
                        _verificationExpiry = Verification.Verify(result, challenge, report: ReportVerificationFailure);
                        _lastVerificationFailure = null;
                        _verificationDeadline = _verificationExpiry.HasValue ? Stopwatch.GetTimestamp() + Math.Max(0, _verificationExpiry.Value - DateTimeOffset.UtcNow.ToUnixTimeSeconds()) * Stopwatch.Frequency : 0;
                        VerificationStatus = _verificationExpiry.HasValue ? "software_verified" : "hardware_verified";
                        break;
                    }
                }
            }
            catch
            {
                await CleanupAsync(false).ConfigureAwait(false);
                SetState(ConnectionState.Disconnected);
                throw;
            }
            SetState(ConnectionState.Connected);
            _heartbeatTask = Task.Run(() => HeartbeatLoop(_cts.Token));
            _receiveTask = Task.Run(() => ReceiveLoop(_cts.Token));
        }

        public async Task DisconnectAsync()
        {
            if (_state == ConnectionState.Disconnecting)
            {
                await WaitDisconnectedAsync().ConfigureAwait(false);
                return;
            }
            if (_state != ConnectionState.Connected && _state != ConnectionState.Connecting) return;
            SetState(ConnectionState.Disconnecting);
            await CleanupAsync(false).ConfigureAwait(false);
            SetState(ConnectionState.Disconnected);
        }

        public Task SendTagsAsync(string[] tags) => SendMsgAsync(new Tags { TagValues = tags });
        public Task SendFocusAsync(bool focused) => SendMsgAsync(new Focus { Focused = focused });
        public Task SendCapabilitiesAsync(string[] capabilities) => SendMsgAsync(new Capabilities { CapabilityValues = capabilities });
        public Task SubscribeAsync(string[] axes) => SendMsgAsync(new Subscribe { AxesValues = axes });
        public Task SendMotionCancelAsync(long gestureId, string? reason = null) =>
            SendMsgAsync(new MotionCancel { GestureId = gestureId, Reason = reason });
        public Task SendViewportSettledAsync() => SendMsgAsync(new ViewportSettled());
        public Task SendCameraPoseAsync(long gestureId, double[] t, double[] r, double? fov = null, double? orthoExtent = null) =>
            SendMsgAsync(new CameraPose { GestureId = gestureId, T = t, R = r, Fov = fov, OrthoExtent = orthoExtent });
        public Task SendCameraDeltaAsync(long gestureId, double[] t, double[] r, double? orthoExtentScale = null, long? deltaId = null) =>
            SendMsgAsync(new CameraDelta { GestureId = gestureId, T = t, R = r, OrthoExtentScale = orthoExtentScale, DeltaId = deltaId });
        public Task SendObjectPoseAsync(long gestureId, double[] t, double[] r) =>
            SendMsgAsync(new ObjectPose { GestureId = gestureId, T = t, R = r });
        public Task SendObjectDeltaAsync(long gestureId, double[] t, double[] r, long? deltaId = null) =>
            SendMsgAsync(new ObjectDelta { GestureId = gestureId, T = t, R = r, DeltaId = deltaId });
        public Task SendResponseAsync(long requestId, Dictionary<string, object> result) =>
            SendMsgAsync(new Response { Id = requestId, Result = result });
        public Task SendResponseErrorAsync(long requestId, string code, string? message = null) =>
            SendMsgAsync(new Response { Id = requestId, Error = new RpcError { Code = code, Message = message } });

        public async Task<Dictionary<string, object>> RequestAsync(
            string method,
            Dictionary<string, object>? parameters = null,
            TimeSpan? timeout = null,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var id = AllocateRequestId();
            var tcs = new TaskCompletionSource<Response>(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (_pendingLock) _pendingRequests[id] = tcs;
            try
            {
                await SendMsgAsync(new Request { Id = id, Method = method, Params = parameters ?? new Dictionary<string, object>() }).ConfigureAwait(false);
                using (var waitCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
                {
                    var delay = Task.Delay(timeout ?? TimeSpan.FromSeconds(5), waitCts.Token);
                    if (await Task.WhenAny(tcs.Task, delay).ConfigureAwait(false) != tcs.Task)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        throw new TimeoutException($"OpenAxis request '{method}' timed out");
                    }
                    waitCts.Cancel();
                }
                var response = await tcs.Task.ConfigureAwait(false);
                if (response.Error != null) throw new RpcRequestException(response.Error.Code, response.Error.Message);
                return response.Result ?? new Dictionary<string, object>();
            }
            finally
            {
                lock (_pendingLock) _pendingRequests.Remove(id);
            }
        }

        public Task<Dictionary<string, object>> ExecuteCommandAsync(
            string name,
            Dictionary<string, object>? parameters = null,
            TimeSpan? timeout = null,
            CancellationToken cancellationToken = default)
        {
            if (string.IsNullOrWhiteSpace(name)) throw new ArgumentException("Command name is required", nameof(name));
            var commandParameters = parameters == null
                ? new Dictionary<string, object>()
                : new Dictionary<string, object>(parameters);
            if (commandParameters.ContainsKey("name"))
                throw new ArgumentException("Command parameters must not contain the reserved 'name' field", nameof(parameters));
            commandParameters["name"] = name;
            return RequestAsync("command.execute", commandParameters, timeout, cancellationToken);
        }

        private async Task SendMsgAsync(Msg msg)
        {
            if (VerificationExpired) { _ws?.Abort(); throw new VerificationException("expired"); }
            if (_state == ConnectionState.Connecting && msg is not Hello && !(msg is Request q && q.Method == "q"))
                throw new InvalidOperationException("Verification is pending");
            var ws = _ws;
            if (ws == null || ws.State != WebSocketState.Open)
                throw new InvalidOperationException("OpenAxis client is not connected");
            var bytes = MessagePackSerializer.Serialize(msg.Pack(), SerializerOptions);
            await _sendLock.WaitAsync().ConfigureAwait(false);
            try
            {
                await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Binary, true,
                    _cts?.Token ?? CancellationToken.None).ConfigureAwait(false);
                Interlocked.Exchange(ref _lastSendTimestamp, Stopwatch.GetTimestamp());
            }
            finally { _sendLock.Release(); }
        }

        private async Task<Msg> ReceiveOneAsync(CancellationToken? cancellationToken = null)
        {
            var ws = _ws ?? throw new InvalidOperationException("Not connected");
            var ct = cancellationToken ?? _cts?.Token ?? CancellationToken.None;
            using (var stream = new MemoryStream())
            {
                var buffer = new byte[65536];
                WebSocketReceiveResult part;
                do
                {
                    part = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct).ConfigureAwait(false);
                    if (part.MessageType != WebSocketMessageType.Binary) throw new InvalidOperationException("Expected binary frame");
                    if (stream.Length + part.Count > MaxMessageBytes)
                        throw new InvalidOperationException($"OpenAxis message exceeds the {MaxMessageBytes}-byte limit");
                    stream.Write(buffer, 0, part.Count);
                } while (!part.EndOfMessage);
                return Unpack(stream.ToArray());
            }
        }

        private async Task HeartbeatLoop(CancellationToken ct)
        {
            try
            {
                while (!ct.IsCancellationRequested)
                {
                    await Task.Delay(1000, ct).ConfigureAwait(false);
                    if (VerificationExpired) { _ws?.Abort(); return; }
                    var lastSend = Interlocked.Read(ref _lastSendTimestamp);
                    if (lastSend != 0 &&
                        (Stopwatch.GetTimestamp() - lastSend) / (double)Stopwatch.Frequency < 1.0)
                        continue;
                    await SendMsgAsync(new Heartbeat()).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) { }
            catch (WebSocketException) { }
            catch (InvalidOperationException) { }
        }

        private async Task ReceiveLoop(CancellationToken ct)
        {
            try
            {
                while (!ct.IsCancellationRequested && _ws?.State == WebSocketState.Open)
                {
                    Msg msg;
                    var send = CaptureConnectionSender(ct);
                    try { msg = await ReceiveOneAsync().ConfigureAwait(false); }
                    catch (InvalidRequestException ex)
                    {
                        Observe(send(new Response { Id = ex.RequestId, Error = new RpcError { Code = "bad_request", Message = ex.Message } }));
                        continue;
                    }
                    catch (ArgumentException ex)
                    {
                        Observe(SendMsgAsync(new Error { Code = "bad_request", Message = ex.Message }));
                        continue;
                    }
                    try { DispatchMessage(msg); }
                    catch (Exception ex) { OpenAxis.Diagnostics.DiagnosticLog.Emit("error", $"OpenAxis listener callback failed: {ex}"); }
                }
            }
            catch (OperationCanceledException) { }
            catch (WebSocketException) { }
            catch (InvalidOperationException) { }
            finally
            {
                if (_state == ConnectionState.Connected)
                {
                    SetState(ConnectionState.Disconnecting);
                    await CleanupAsync(true).ConfigureAwait(false);
                    SetState(ConnectionState.Disconnected);
                }
            }
        }

        private static Msg Unpack(byte[] data)
        {
            var reader = new MessagePackReader(new ReadOnlyMemory<byte>(data));
            var d = MessagePackSerializer.Deserialize<Dictionary<string, object>>(ref reader, SerializerOptions);
            if (!reader.End) throw new ArgumentException("Expected exactly one MessagePack value");
            try { return MsgDispatch.Unpack(d); }
            catch (ArgumentException ex)
            {
                if (d.TryGetValue("type", out var type) && Equals(type, "request") && d.TryGetValue("id", out var id))
                {
                    long requestId;
                    try { requestId = MsgUtil.LongInteger(id, "request.id"); }
                    catch (ArgumentException) { throw ex; }
                    throw new InvalidRequestException(requestId, ex.Message);
                }
                throw;
            }
        }

        private sealed class InvalidRequestException : ArgumentException
        {
            public long RequestId { get; }
            public InvalidRequestException(long requestId, string message) : base(message) { RequestId = requestId; }
        }

        private void DispatchMessage(Msg msg)
        {
            if (VerificationExpired) { _ws?.Abort(); return; }
            var navigation = _navigationListener ?? _listener;
            switch (msg)
            {
                case Response response:
                    TaskCompletionSource<Response>? pending;
                    lock (_pendingLock) _pendingRequests.TryGetValue(response.Id, out pending);
                    if (pending != null) pending.TrySetResult(response); else _listener.OnResponse(response);
                    break;
                case Request request: DispatchRequest(request); break;
                case Frame frame: _listener.OnFrame(frame); break;
                case Buttons buttons: _listener.OnButtons(buttons.Value); break;
                case MotionStart start: NotifyLifecycle(listener => listener.OnMotionStart(start.GestureId)); break;
                case MotionEnd end: NotifyLifecycle(listener => listener.OnMotionEnd(end.GestureId)); break;
                case NavigationState state: navigation.OnNavigationState(state); break;
                case CameraPose pose: navigation.OnCameraPose(pose); break;
                case CameraPivot pivot: navigation.OnCameraPivot(pivot); break;
                case ObjectPose pose: navigation.OnObjectPose(pose); break;
                case ObjectPivot pivot: navigation.OnObjectPivot(pivot); break;
                case Axes axes: _listener.OnAxes(axes.AxesValues); break;
                case Error error: _listener.OnError(error.Code, error.Message); break;
                case UnknownMsg unknown: _listener.OnExtension(unknown.MessageType, unknown.Value); break;
            }
        }

        private void DispatchRequest(Request request)
        {
            var send = CaptureConnectionSender(CancellationToken.None);
            NavigationQuery? query = null;
            void Error(string code, string message) => Observe(send(new Response { Id = request.Id, Error = new RpcError { Code = code, Message = message } }));
            try
            {
                bool handled = false;
                if (request.Method == "navigation.query")
                {
                    query = new NavigationQuery(
                        request,
                        result => Observe(send(new Response { Id = request.Id, Result = result })),
                        (code, message) => Observe(send(new Response { Id = request.Id, Error = new RpcError { Code = code, Message = message } })));
                    handled = (_navigationListener ?? _listener).OnNavigationQuery(query) || query.Completed;
                }
                if (!handled) handled = _listener.OnRequest(request);
                if (!handled && query?.Completed != true) Error("unsupported", $"Unsupported method: {request.Method}");
            }
            catch (ArgumentException ex)
            {
                if (query?.Completed != true) Error("bad_request", ex.Message);
            }
            catch (Exception ex)
            {
                if (query?.Completed != true) Error("unavailable", ex.Message);
            }
        }

        private void SetState(ConnectionState state)
        {
            if (state == ConnectionState.Disconnected) { VerificationStatus = null; _verificationExpiry = null; }
            if (state == ConnectionState.Connecting)
                _disconnected = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            _state = state;
            NotifyLifecycle(listener => listener.OnStateChange(state));
            if (state == ConnectionState.Disconnected) _disconnected.TrySetResult(true);
        }

        private void NotifyLifecycle(Action<IOpenAxisListener> callback)
        {
            var navigation = _navigationListener;
            if (navigation != null)
                try { callback(navigation); }
                catch (Exception ex) { OpenAxis.Diagnostics.DiagnosticLog.Emit("error", $"OpenAxis lifecycle listener failed: {ex}"); }
            if (!ReferenceEquals(navigation, _listener))
                try { callback(_listener); }
                catch (Exception ex) { OpenAxis.Diagnostics.DiagnosticLog.Emit("error", $"OpenAxis lifecycle listener failed: {ex}"); }
        }

        private static void Observe(Task task)
        {
            _ = task.ContinueWith(
                failed => OpenAxis.Diagnostics.DiagnosticLog.Emit("error", $"OpenAxis background send failed: {failed.Exception}"),
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted,
                TaskScheduler.Default);
        }

        private async Task CleanupAsync(bool fromReceive)
        {
            _cts?.Cancel();
            if (_heartbeatTask != null)
            {
                try { await _heartbeatTask.ConfigureAwait(false); } catch { }
                _heartbeatTask = null;
            }
            if (!fromReceive && _receiveTask != null)
            {
                try { await _receiveTask.ConfigureAwait(false); } catch { }
            }
            _receiveTask = null;
            var ws = _ws;
            _ws = null;
            if (ws != null)
            {
                try
                {
                    if (ws.State == WebSocketState.Open)
                    {
                        using (var closeCts = new CancellationTokenSource(TimeSpan.FromSeconds(2)))
                            await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", closeCts.Token).ConfigureAwait(false);
                    }
                }
                catch { }
                ws.Dispose();
            }
            _cts?.Dispose();
            _cts = null;
            lock (_pendingLock)
            {
                foreach (var pending in _pendingRequests.Values)
                    pending.TrySetException(new InvalidOperationException("OpenAxis connection closed"));
                _pendingRequests.Clear();
            }
        }
    }
}
