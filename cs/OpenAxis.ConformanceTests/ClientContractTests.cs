using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using MessagePack;
using OpenAxis.Client;

namespace OpenAxis.ConformanceTests;

internal static class ClientContractTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    private static void Set(OpenAxisClient c, string field, object value) => typeof(OpenAxisClient).GetField(field, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(c, value);
    private static object? Invoke(OpenAxisClient c, string method, params object[] args) => typeof(OpenAxisClient).GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(c, args);
    private sealed class Listener : OpenAxisListenerBase
    {
        public readonly List<string> Events = new();
        public NavigationQuery? Query;
        public bool Inline;
        public override void OnMotionStart(long id) { Events.Add($"start:{id}"); throw new Exception("passive callback"); }
        public override void OnMotionEnd(long id) => Events.Add($"end:{id}");
        public override void OnStateChange(ConnectionState state) { throw new Exception("passive state callback"); }
        public override bool OnNavigationQuery(NavigationQuery query)
        {
            Query = query;
            if (!Inline) return true;
            query.Complete(new Dictionary<string, object>());
            return false;
        }
    }
    private sealed class Pair : IDisposable
    {
        private readonly HttpListener server = new();
        public readonly ClientWebSocket Client = new();
        public WebSocket Peer = null!;
        public static async Task<Pair> Open()
        {
            var pair = new Pair();
            var portProbe = new TcpListener(IPAddress.Loopback, 0); portProbe.Start();
            var port = ((IPEndPoint)portProbe.LocalEndpoint).Port; portProbe.Stop();
            pair.server.Prefixes.Add($"http://localhost:{port}/"); pair.server.Start();
            var accept = pair.server.GetContextAsync();
            var connect = pair.Client.ConnectAsync(new Uri($"ws://localhost:{port}/"), CancellationToken.None);
            var context = await accept.WaitAsync(TimeSpan.FromSeconds(5));
            pair.Peer = (await context.AcceptWebSocketAsync(null)).WebSocket;
            await connect.WaitAsync(TimeSpan.FromSeconds(5));
            return pair;
        }
        public void Dispose() { Client.Abort(); Peer.Abort(); Client.Dispose(); Peer.Dispose(); server.Close(); }
    }
    private static async Task<Dictionary<string, object>> Receive(WebSocket peer)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var bytes = new MemoryStream(); var buffer = new byte[4096];
        WebSocketReceiveResult part;
        do { part = await peer.ReceiveAsync(new ArraySegment<byte>(buffer), timeout.Token); bytes.Write(buffer, 0, part.Count); } while (!part.EndOfMessage);
        return MessagePackSerializer.Deserialize<Dictionary<string, object>>(bytes.ToArray());
    }
    public static async Task Run()
    {
        using var first = await Pair.Open();
        var ordinary = new Listener(); var owner = new Listener();
        var client = new OpenAxisClient("contract", ordinary);
        client.AttachNavigation(owner);
        Set(client, "_ws", first.Client); Set(client, "_state", ConnectionState.Connected);
        var cancellation = new CancellationTokenSource(); Set(client, "_cts", cancellation);
        var receive = (Task)Invoke(client, "ReceiveLoop", cancellation.Token)!;
        Set(client, "_receiveTask", receive);
        var fixture = Program.LoadFixture("client.json");
        foreach (var message in (IEnumerable)fixture["lifecycle"])
            Invoke(client, "DispatchMessage", MsgDispatch.Unpack(Program.Map(message)));
        Check(ordinary.Events.SequenceEqual(owner.Events) && ordinary.Events.SequenceEqual(new[] { "start:7", "end:7" }), "mixed interface lifecycle");
        foreach (var raw in (IEnumerable)fixture["malformed_requests"])
        {
            var message = Program.Map(raw);
            await first.Peer.SendAsync(new ArraySegment<byte>(MessagePackSerializer.Serialize(message)), WebSocketMessageType.Binary, true, CancellationToken.None);
            var reply = await Receive(first.Peer);
            Check(Convert.ToInt64(reply["id"]) == Convert.ToInt64(message["id"]), "malformed RPC correlation");
            Check((string)((IDictionary)reply["error"])["code"]! == "bad_request", "malformed RPC error");
        }
        Invoke(client, "DispatchMessage", new Request { Id = 90, Method = "navigation.query" });
        var retained = owner.Query!;
        await client.DisconnectAsync();
        Check(client.State == ConnectionState.Disconnected, "throwing observer prevented cleanup");
        using var second = await Pair.Open();
        Set(client, "_ws", second.Client); Set(client, "_state", ConnectionState.Connected);
        Set(client, "_cts", new CancellationTokenSource());
        retained.Complete(new Dictionary<string, object> { { "old", true } });
        Check(retained.Completed, "retired completion must be terminal");
        owner.Inline = true;
        Invoke(client, "DispatchMessage", new Request { Id = 91, Method = "navigation.query" });
        var fresh = await Receive(second.Peer);
        Check(Convert.ToInt64(fresh["id"]) == 91 && fresh.ContainsKey("result"), "retired response reached replacement connection");
        Invoke(client, "DispatchMessage", new Request { Id = 92, Method = "navigation.query" });
        fresh = await Receive(second.Peer);
        Check(Convert.ToInt64(fresh["id"]) == 92, "completion followed by fallback response");
        second.Client.Abort(); await client.DisconnectAsync();
        Console.WriteLine("C# shared client transport contract passed");
    }
}
