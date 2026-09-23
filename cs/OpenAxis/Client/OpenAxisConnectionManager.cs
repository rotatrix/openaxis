using System;
using System.Diagnostics;
using System.Collections.Generic;
using OpenAxis.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

namespace OpenAxis.Client
{
    public enum ConnectionManagerState { Stopped, Connecting, Ready, Retrying, Stopping }

    /// <summary>A complete snapshot. Null axes/focus omit those announcements.</summary>
    public sealed class ConnectionMetadata
    {
        public string[] Tags { get; set; } = Array.Empty<string>();
        public string[] Capabilities { get; set; } = Array.Empty<string>();
        public string[]? Axes { get; set; }
        public bool? Focused { get; set; }
    }

    public sealed class RetryPolicy
    {
        public TimeSpan InitialDelay { get; set; } = TimeSpan.FromSeconds(2);
        public TimeSpan MaxDelay { get; set; } = TimeSpan.FromSeconds(4);
        public double Multiplier { get; set; } = 2;
        public double Jitter { get; set; } = 0.2;
    }

    /// <summary>Opt-in supervisor for one client with a reusable NavigationSession.
    /// Metadata and observers run on the networking thread; use cached application facts.
    /// A custom connect operation must honor its cancellation token and complete only
    /// after wrapper initialization. This component never calls native application APIs.</summary>
    public sealed class OpenAxisConnectionManager
    {
        private readonly Func<ConnectionState> _state;
        private readonly Func<CancellationToken, Task> _connect;
        private readonly Func<Task> _disconnect;
        private readonly Func<Task> _waitDisconnected;
        private readonly Func<CancellationToken, Func<Msg, Task>> _captureSender;
        private readonly Func<ConnectionMetadata> _metadata;
        private readonly double _initial, _maximum, _multiplier, _jitter;
        private readonly TimeSpan _startupTimeout;
        private readonly object _gate = new object();
        private readonly SemaphoreSlim _announcements = new SemaphoreSlim(1, 1);
        private readonly Random _random = new Random();
        private CancellationTokenSource? _stop;
        private Task? _task;
        private bool _stopRequested;
        private volatile ConnectionManagerState _lifecycleState;
        private bool _outageLogged;
        private readonly Action<string, string> _log;
        private readonly string _url;

        public OpenAxisConnectionManager(OpenAxisClient client, Func<ConnectionMetadata> metadata,
            Func<CancellationToken, Task>? connect = null, RetryPolicy? retry = null,
            TimeSpan? startupTimeout = null, Action<string, string>? log = null)
            : this(() => client.State, connect ?? client.ConnectAsync, client.DisconnectAsync,
                  client.WaitDisconnectedAsync, client.CaptureConnectionSender, metadata, retry, startupTimeout, log, client.Url) { }

        internal OpenAxisConnectionManager(Func<ConnectionState> state, Func<CancellationToken, Task> connect,
            Func<Task> disconnect, Func<Task> waitDisconnected, Func<CancellationToken, Func<Msg, Task>> captureSender,
            Func<ConnectionMetadata> metadata, RetryPolicy? retry = null, TimeSpan? startupTimeout = null,
            Action<string, string>? log = null, string? url = null)
        {
            var policy = retry ?? new RetryPolicy();
            _initial = policy.InitialDelay.TotalMilliseconds;
            _maximum = policy.MaxDelay.TotalMilliseconds;
            _multiplier = policy.Multiplier;
            _jitter = policy.Jitter;
            _startupTimeout = startupTimeout ?? TimeSpan.FromSeconds(5);
            if (_initial <= 0 || _maximum < _initial || _maximum > int.MaxValue
                || double.IsNaN(_multiplier) || double.IsInfinity(_multiplier) || _multiplier < 1
                || double.IsNaN(_jitter) || _jitter < 0 || _jitter > 1
                || _startupTimeout.TotalMilliseconds <= 0 || _startupTimeout.TotalMilliseconds > int.MaxValue)
                throw new ArgumentOutOfRangeException(nameof(retry), "Invalid lifecycle timing options");
            _state = state; _connect = connect; _disconnect = disconnect;
            _waitDisconnected = waitDisconnected; _captureSender = captureSender;
            _metadata = metadata ?? throw new ArgumentNullException(nameof(metadata));
            _url = url ?? Protocol.DefaultUrl;
            _log = log ?? DiagnosticLog.Emit;
        }

        public ConnectionManagerState State => _lifecycleState;
        public event Action<ConnectionManagerState, Exception?, TimeSpan?>? StateChanged;

        /// <summary>Returns the entire run. Repeated starts share it until shutdown completes.</summary>
        public Task StartAsync(CancellationToken cancellationToken = default)
        {
            lock (_gate)
            {
                if (_task != null && !_task.IsCompleted) return _task;
                if (_state() != ConnectionState.Disconnected) throw new InvalidOperationException("Client already in use");
                _stop?.Dispose();
                _stop = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                _stopRequested = false;
                var token = _stop.Token;
                return _task = Task.Run(() => RunAsync(token));
            }
        }

        public async Task StopAsync()
        {
            Task? task;
            lock (_gate)
            {
                task = _task;
                if (task == null || task.IsCompleted) return;
                if (!_stopRequested)
                {
                    // Claim shutdown before notifying observers, which may re-enter.
                    _stopRequested = true;
                    Notify(ConnectionManagerState.Stopping);
                    _stop!.Cancel();
                }
            }
            await task.ConfigureAwait(false);
        }

        public Task RefreshMetadataAsync() => State == ConnectionManagerState.Ready ? AnnounceAsync() : Task.CompletedTask;

        private async Task AnnounceAsync(CancellationToken cancellationToken = default)
        {
            var send = _captureSender(cancellationToken); // Capture before waiting; never replay an old update on a new socket.
            await _announcements.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                var value = _metadata();
                // Copy before awaits; callers may replace or mutate their application snapshot.
                var tags = (string[])value.Tags.Clone();
                var capabilities = (string[])value.Capabilities.Clone();
                var axes = value.Axes == null ? null : (string[])value.Axes.Clone();
                var focused = value.Focused;
                await send(new Tags { TagValues = tags }).ConfigureAwait(false);
                await send(new Capabilities { CapabilityValues = capabilities }).ConfigureAwait(false);
                if (axes != null) await send(new Subscribe { AxesValues = axes }).ConfigureAwait(false);
                if (focused.HasValue) await send(new Focus { Focused = focused.Value }).ConfigureAwait(false);
            }
            finally { _announcements.Release(); }
        }

        private async Task RunAsync(CancellationToken stop)
        {
            double delay = _initial;
            try
            {
                while (!stop.IsCancellationRequested)
                {
                    Exception? error = null;
                    Notify(ConnectionManagerState.Connecting);
                    try
                    {
                        using (var startup = CancellationTokenSource.CreateLinkedTokenSource(stop))
                        {
                            startup.CancelAfter(_startupTimeout);
                            await _connect(startup.Token).ConfigureAwait(false);
                            startup.Token.ThrowIfCancellationRequested();
                            await AnnounceAsync(startup.Token).ConfigureAwait(false);
                            startup.Token.ThrowIfCancellationRequested();
                        }
                        if (_state() != ConnectionState.Connected) throw new InvalidOperationException("Connection lost during startup");
                        Notify(ConnectionManagerState.Ready);
                        delay = _initial;
                        await Interruptible(_waitDisconnected(), stop).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException) when (stop.IsCancellationRequested) { break; }
                    catch (Exception ex) { error = ex; }
                    finally { await _disconnect().ConfigureAwait(false); }
                    if (stop.IsCancellationRequested) break;
                    var actual = TimeSpan.FromMilliseconds(Math.Min(_maximum, delay * (1 + (2 * _random.NextDouble() - 1) * _jitter)));
                    Notify(ConnectionManagerState.Retrying, error, actual);
                    await Task.Delay(actual, stop).ConfigureAwait(false);
                    delay = Math.Min(_maximum, delay * _multiplier);
                }
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
            finally
            {
                // External cancellation can finish the run without StopAsync.
                // Prevent a late stop from overwriting the terminal notification.
                lock (_gate) { _stopRequested = true; }
                Notify(ConnectionManagerState.Stopped);
            }
        }

        private static async Task Interruptible(Task task, CancellationToken token)
        {
            var cancelled = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            using (token.Register(() => cancelled.TrySetResult(true)))
            {
                if (await Task.WhenAny(task, cancelled.Task).ConfigureAwait(false) != task)
                    token.ThrowIfCancellationRequested();
                await task.ConfigureAwait(false);
            }
        }

        private void Notify(ConnectionManagerState state, Exception? error = null, TimeSpan? delay = null)
        {
            var suppress = _outageLogged && (state == ConnectionManagerState.Connecting || state == ConnectionManagerState.Retrying);
            if (state == ConnectionManagerState.Retrying) _outageLogged = true;
            else if (state == ConnectionManagerState.Ready || state == ConnectionManagerState.Stopped) _outageLogged = false;
            _lifecycleState = state;
            try
            {
                var fields = new Dictionary<string, object?> { ["url"] = _url, ["protocol"] = Protocol.Version,
                    ["error"] = error?.Message ?? "connection lost", ["retry_delay_s"] = delay?.TotalSeconds };
                var name = state == ConnectionManagerState.Connecting ? "connection.start"
                    : state == ConnectionManagerState.Ready ? "connection.open"
                    : state == ConnectionManagerState.Retrying ? "connection.retry_failed"
                    : state == ConnectionManagerState.Stopped ? "connection.stop" : null;
                if (name != null && !suppress) _log(state == ConnectionManagerState.Retrying ? "warning" : "info",
                    DiagnosticFormatter.FormatEvent(name, fields));
            }
            catch (Exception ex) { Trace.TraceError($"OpenAxis lifecycle log sink failed: {ex}"); }
            var observers = StateChanged;
            if (observers == null) return;
            foreach (Action<ConnectionManagerState, Exception?, TimeSpan?> observer in observers.GetInvocationList())
                try { observer(state, error, delay); }
                catch (Exception ex) { Trace.TraceError($"OpenAxis lifecycle observer failed: {ex}"); }
        }
    }
}
