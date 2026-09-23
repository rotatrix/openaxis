using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using OpenAxis.Geometry;
using OpenAxis.Navigation;

namespace OpenAxis.ConformanceTests
{
    internal static class SessionTests
    {
        internal static int Run(string fixtureDirectory)
        {
            using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(fixtureDirectory, "session.json")));
            int checks = 0, count = 0;
            foreach (var scenario in document.RootElement.GetProperty("scenarios").EnumerateArray())
            {
                var name = scenario.GetProperty("name").GetString();
                var state = new SessionState();
                var tokens = new Dictionary<string, SessionToken>();
                var tickets = new Dictionary<string, AcceptedCameraPose>();
                var writes = new Dictionary<string, CameraWrite>();
                int index = 0;
                foreach (var item in scenario.GetProperty("events").EnumerateArray())
                {
                    var op = item.GetProperty("op").GetString();
                    var token = item.TryGetProperty("token", out var tokenName) ? tokens[tokenName.GetString()!] : state.Token;
                    var actual = item.TryGetProperty("actual", out var actualValue) ? Pose(actualValue) : null;
                    var now = item.TryGetProperty("now", out var time) ? time.GetDouble() : 0;
                    SessionEffect? effect = null;
                    string kind = "ok";
                    switch (op)
                    {
                        case "connection": state.Connection(); break;
                        case "start": tokens[Name(item, "as")] = state.Start(item.GetProperty("gesture").GetInt64()); break;
                        case "query":
                            kind = state.CameraQuery(token, actual, Bool(item, "scoped"), Bool(item, "supplied")) ? "ok" : "reject";
                            break;
                        case "receive":
                            var ticket = state.Receive(
                                item.TryGetProperty("epoch", out var epoch) ? epoch.GetInt64() : state.Epoch,
                                item.TryGetProperty("gesture", out var gesture) ? gesture.GetInt64() : state.GestureId ?? -1,
                                item.GetProperty("seq").GetInt64(), Pose(item.GetProperty("pose"))!.Value,
                                item.TryGetProperty("ack", out var ack) ? ack.GetInt64() : (long?)null);
                            kind = ticket == null ? "reject" : "accepted";
                            if (ticket != null) tickets[Name(item, "as")] = ticket;
                            break;
                        case "process": effect = state.Process(tickets[Name(item, "ticket")], actual, now); break;
                        case "observe": effect = state.Observe(token, actual, now); break;
                        case "complete": effect = state.CompleteWrite(writes[Name(item, "write")], actual, now, Bool(item, "success")); break;
                        case "end": kind = state.End(token) ? "ok" : "reject"; break;
                        case "finish": kind = state.Finish(token) ? "ok" : "reject"; break;
                        case "cancel": effect = state.Cancel(token, item.GetProperty("reason").GetString()!); break;
                        case "timeout": effect = state.Expire(token, item.GetProperty("delta").GetInt64(), now); break;
                        case "send_failed": effect = state.SendFailed(token, item.GetProperty("delta").GetInt64()); break;
                        default: throw new Exception($"Unknown trace operation: {op}");
                    }
                    var result = new Dictionary<string, object?>
                    {
                        ["kind"] = effect?.Kind ?? kind,
                        ["baseline"] = state.Baseline?.Position.X,
                        ["ready"] = state.Ready, ["pending"] = state.PendingId, ["active"] = state.GestureId,
                        ["received"] = state.LastReceived, ["applied"] = state.LastApplied,
                    };
                    if (effect != null)
                    {
                        result["delta_id"] = effect.DeltaId;
                        result["gesture_id"] = effect.GestureId;
                        result["reason"] = effect.Reason;
                        if (effect.Difference.HasValue)
                        {
                            result["t"] = Array(effect.Difference.Value.Translation);
                            result["r"] = Array(effect.Difference.Value.Rotation);
                            result["scale"] = effect.Difference.Value.Scale;
                        }
                        if (effect.Write != null) writes[Name(item, "as")] = effect.Write;
                    }
                    foreach (var expected in item.GetProperty("expect").EnumerateObject())
                    {
                        checks++;
                        if (!Equal(result[expected.Name], expected.Value))
                            throw new Exception($"Session trace '{name}', event {index} ({op}), {expected.Name}: "
                                + $"expected {expected.Value}, got {JsonSerializer.Serialize(result[expected.Name])}");
                    }
                    index++;
                }
                count++;
            }
            if (typeof(SessionState).IsPublic) throw new Exception("SessionState must remain private to SDK");
            Console.WriteLine($"Navigation session: {count} shared scenarios, {checks} assertions");
            return checks + 1;
        }

        private static string Name(JsonElement item, string key) =>
            item.TryGetProperty(key, out var value) ? value.GetString()! : "last";
        private static bool Bool(JsonElement item, string key) =>
            !item.TryGetProperty(key, out var value) || value.GetBoolean();
        private static double[] Array(Vec3 value) => new[] { value.X, value.Y, value.Z };
        private static Vec3 Vector(JsonElement item) => new Vec3(item[0].GetDouble(), item[1].GetDouble(), item[2].GetDouble());

        private static CameraPoseValue? Pose(JsonElement value)
        {
            if (value.ValueKind == JsonValueKind.Null) return null;
            if (value.ValueKind == JsonValueKind.Number)
                return new CameraPoseValue(new Vec3(value.GetDouble(), 0, 0), new Vec3(0, 0, 0), fov: 1);
            var t = value.TryGetProperty("t", out var translation) ? Vector(translation)
                : new Vec3(value.TryGetProperty("x", out var x) ? x.GetDouble() : 0, 0, 0);
            var r = value.TryGetProperty("r", out var rotation) ? Vector(rotation) : new Vec3(0, 0, 0);
            if (value.TryGetProperty("extent", out var extent)) return new CameraPoseValue(t, r, orthoExtent: extent.GetDouble());
            return new CameraPoseValue(t, r, fov: value.TryGetProperty("fov", out var fov) ? fov.GetDouble() : 1);
        }

        private static bool Equal(object? actual, JsonElement expected)
        {
            switch (expected.ValueKind)
            {
                case JsonValueKind.Null: return actual == null;
                case JsonValueKind.String: return actual is string text && text == expected.GetString();
                case JsonValueKind.True: case JsonValueKind.False: return actual is bool flag && flag == expected.GetBoolean();
                case JsonValueKind.Number: return actual != null && Math.Abs(Convert.ToDouble(actual) - expected.GetDouble()) <= 1e-8;
                case JsonValueKind.Array:
                    return actual is double[] values && values.Length == expected.GetArrayLength()
                        && values.Select((v, i) => Math.Abs(v - expected[i].GetDouble()) <= 1e-8).All(v => v);
                default: return false;
            }
        }
    }
}
