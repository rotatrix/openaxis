using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using OpenAxis.Client;

namespace OpenAxis.ConformanceTests
{
    internal static class OpenAxisConnectionManagerTests
    {
        private sealed class Client
        {
            public volatile ConnectionState State;
            public int Attempts, Failures, Cleanup;
            public bool Block;
            public readonly List<Msg> Messages = new List<Msg>();
            private TaskCompletionSource<bool> _closed = Signal();
            private static TaskCompletionSource<bool> Signal() => new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            public async Task Connect(CancellationToken token)
            {
                Attempts++;
                _closed = Signal();
                State = ConnectionState.Connecting;
                if (Block) await Task.Delay(Timeout.Infinite, token);
                if (Attempts <= Failures) throw new InvalidOperationException("offline");
                State = ConnectionState.Connected;
            }
            public Task Disconnect()
            {
                Cleanup++;
                State = ConnectionState.Disconnected;
                _closed.TrySetResult(true);
                return Task.CompletedTask;
            }
            public Task Wait() => _closed.Task;
            public Func<Msg, Task> Capture(CancellationToken token)
            {
                var generation = Attempts;
                return message =>
                {
                    token.ThrowIfCancellationRequested();
                    if (State != ConnectionState.Connected || generation != Attempts) throw new InvalidOperationException("retired");
                    lock (Messages) Messages.Add(message);
                    return Task.CompletedTask;
                };
            }
        }

        private static async Task Until(Func<bool> condition)
        {
            using var deadline = new CancellationTokenSource(2000);
            while (!condition()) await Task.Delay(1, deadline.Token);
        }

        public static int Run() => CheckAsync().GetAwaiter().GetResult();
        private static async Task<int> CheckAsync()
        {
            int checks = 0;
            void Check(bool value) { checks++; if (!value) throw new Exception("Lifecycle check " + checks); }
            var client = new Client { Failures = 2 };
            string[] tags = { "first" };
            var policy = new RetryPolicy { InitialDelay = TimeSpan.FromMilliseconds(5), MaxDelay = TimeSpan.FromMilliseconds(20), Jitter = 0 };
            var delays = new List<double>();
            var logs = new List<(string Level, string Message)>();
            var lifecycle = new OpenAxisConnectionManager(() => client.State, client.Connect, client.Disconnect, client.Wait, client.Capture,
                () => new ConnectionMetadata { Tags = tags, Axes = Array.Empty<string>(), Focused = false }, policy,
                log: (level, message) => logs.Add((level, message)));
            lifecycle.StateChanged += (s, e, d) => { if (d.HasValue) delays.Add(d.Value.TotalMilliseconds); };
            var run = lifecycle.StartAsync();
            Check(ReferenceEquals(run, lifecycle.StartAsync()));
            await Until(() => lifecycle.State == ConnectionManagerState.Ready);
            Check(client.Attempts == 3);
            Check(delays.SequenceEqual(new double[] { 5, 10 }));
            Check(client.Messages.Select(m => m.GetType()).SequenceEqual(new[] { typeof(Tags), typeof(Capabilities), typeof(Subscribe), typeof(Focus) }));
            tags = new[] { "second" };
            await lifecycle.RefreshMetadataAsync();
            await client.Disconnect();
            await Until(() => client.Attempts == 4 && lifecycle.State == ConnectionManagerState.Ready);
            Check(((Tags)client.Messages[client.Messages.Count - 4]).TagValues[0] == "second");
            await Task.WhenAll(lifecycle.StopAsync(), lifecycle.StopAsync());
            Check(run.IsCompleted && lifecycle.State == ConnectionManagerState.Stopped);
            Check(client.State == ConnectionState.Disconnected);
            Check(logs.Count(entry => entry.Level == "warning") == 2); // One startup outage, one lost connection.
            Check(logs.Any(entry => entry.Message.Contains("offline") && entry.Message.Contains("retrying in")));
            Check(logs.Any(entry => entry.Message.Contains("openaxis/1.0")));
            Check(logs.Last().Message == "connection stopped");
            Check(!ReferenceEquals(run, lifecycle.StartAsync()));
            await Until(() => lifecycle.State == ConnectionManagerState.Ready);
            await lifecycle.StopAsync();

            foreach (bool block in new[] { false, true })
            {
                client = new Client { Block = block, Failures = 100 };
                lifecycle = new OpenAxisConnectionManager(() => client.State, client.Connect, client.Disconnect, client.Wait, client.Capture,
                    () => new ConnectionMetadata(), new RetryPolicy { InitialDelay = TimeSpan.FromSeconds(60), MaxDelay = TimeSpan.FromSeconds(60) });
                using var stop = new CancellationTokenSource();
                run = lifecycle.StartAsync(stop.Token);
                await Until(() => block ? client.Attempts > 0 : lifecycle.State == ConnectionManagerState.Retrying);
                stop.Cancel();
                await run;
                Check(client.State == ConnectionState.Disconnected && client.Attempts == 1);
            }

            client = new Client { Block = true };
            lifecycle = new OpenAxisConnectionManager(() => client.State, client.Connect, client.Disconnect, client.Wait, client.Capture,
                () => new ConnectionMetadata(), policy, TimeSpan.FromMilliseconds(5));
            run = lifecycle.StartAsync();
            await Until(() => client.Attempts >= 2);
            await lifecycle.StopAsync();
            Check(client.Cleanup >= 2);

            foreach (bool close in new[] { false, true })
            {
                client = new Client();
                lifecycle = new OpenAxisConnectionManager(() => client.State, client.Connect, client.Disconnect, client.Wait, client.Capture,
                    () => { if (close) client.Disconnect(); else throw new Exception("snapshot failed"); return new ConnectionMetadata(); }, policy);
                run = lifecycle.StartAsync();
                await Until(() => lifecycle.State == ConnectionManagerState.Retrying);
                await lifecycle.StopAsync();
                Check(client.Messages.Count == 0);
            }
            client = new Client();
            lifecycle = new OpenAxisConnectionManager(() => client.State, client.Connect, client.Disconnect, client.Wait, client.Capture,
                () => new ConnectionMetadata(), log: (level, message) => throw new Exception("sink failed"));
            run = lifecycle.StartAsync();
            await Until(() => lifecycle.State == ConnectionManagerState.Ready);
            await lifecycle.StopAsync();
            Check(run.IsCompleted && client.State == ConnectionState.Disconnected);

            // Re-enter StopAsync after Stopped is published but before the run
            // task completes. This deterministically exercises the shutdown race.
            foreach (bool externalCancellation in new[] { false, true })
            {
                client = new Client();
                lifecycle = new OpenAxisConnectionManager(() => client.State, client.Connect, client.Disconnect, client.Wait, client.Capture,
                    () => new ConnectionMetadata(), policy);
                Task repeatedStop = Task.CompletedTask;
                var states = new List<ConnectionManagerState>();
                lifecycle.StateChanged += (state, error, delay) =>
                {
                    states.Add(state);
                    if (state == ConnectionManagerState.Stopped) repeatedStop = lifecycle.StopAsync();
                };
                using var cancellation = new CancellationTokenSource();
                run = lifecycle.StartAsync(cancellation.Token);
                await Until(() => lifecycle.State == ConnectionManagerState.Ready);
                if (externalCancellation) cancellation.Cancel();
                else await lifecycle.StopAsync();
                await run;
                await repeatedStop;
                Check(lifecycle.State == ConnectionManagerState.Stopped);
                Check(states.Last() == ConnectionManagerState.Stopped);
                Check(states.Count(state => state == ConnectionManagerState.Stopping) == (externalCancellation ? 0 : 1));
            }
            return checks;
        }
    }
}
