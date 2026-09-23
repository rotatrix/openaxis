using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using OpenAxis.Client;
using OpenAxis.Diagnostics;
using OpenAxis.Geometry;

namespace OpenAxis.ConformanceTests
{
    internal static class Program
    {
        private static readonly string FixtureDirectory =
            Path.Combine(AppContext.BaseDirectory, "fixtures");
        private static int _checks;

        private static void Main(string[] args)
        {
            if (args.Length == 3 && args[0] == "--log-probe")
            {
                using var log = new DiagnosticLog("interop", args[1], maxBytes: 100, keep: args[2] == "cleanup" ? 0 : 5);
                if (log.FilePath == null) throw new IOException(log.Error);
                log.Write("info", "probe");
                Console.WriteLine(log.FilePath);
                if (args[2] == "hold") Console.ReadLine();
                return;
            }
            CheckApiSurface();
            var identity = ProcessIdentity.Current();
            new Target { Pid = identity }.Pack();
            Check(identity.EndsWith(System.Diagnostics.Process.GetCurrentProcess().Id.ToString(System.Globalization.CultureInfo.InvariantCulture)), "current process identity");
            CheckMessageFixtures();
            CheckReleaseFixtures();
            ClientContractTests.Run().GetAwaiter().GetResult();
            CheckNavigationQuery();
            CheckGeometryFixtures();
            CheckDiagnostics();
            _checks += DiagnosticLogTests.Run();
            _checks += NavigationDiagnosticsTests.Run(FixtureDirectory);
            _checks += SessionTests.Run(FixtureDirectory);
            _checks += CoordinatorTests.Run();
            _checks += CoordinatorTests.RunShared(FixtureDirectory);
            _checks += OpenAxisConnectionManagerTests.Run();
            Console.WriteLine($"OpenAxis C# conformance checks passed: {_checks}");
        }

        private static void CheckApiSurface()
        {
            Check(Protocol.Version == "openaxis/1.0", "protocol version");
            Check(Protocol.DefaultUrl == "ws://localhost:6607", "default URL");
            var legacyHello = new Hello { Proto = Protocol.Version, ClientName = "CAD" };
            Check(!legacyHello.Pack().ContainsKey("target"), "legacy hello omits target");
            var targetedHello = new Hello
            {
                Proto = Protocol.Version, ClientName = "CAD",
                Target = new Target { Pid = "18432", App = "Inventor" },
            };
            var parsedHello = (Hello)MsgDispatch.Unpack(targetedHello.Pack());
            Check(parsedHello.Target?.Pid == "18432" && parsedHello.Target.App == "Inventor", "hello target round trip");
            Throws<ArgumentException>(() => new Target { Pid = "0" }.Pack(), "target rejects zero PID");
            Throws<ArgumentException>(() => new Target().Pack(), "target requires identity");
            Throws<ArgumentException>(() => new OpenAxisClient("CAD", clientVersion: " "), "client version rejects blank strings");
            Check(!legacyHello.Pack().ContainsKey("client_version") && !legacyHello.Pack().ContainsKey("sdk"), "optional diagnostic fields are omitted");
            Check(typeof(Protocol).GetField("LegacyVersion") == null, "legacy protocol selector removed");
            Check(typeof(CameraPose).GetProperty("Mode") == null, "relative pose mode removed");
            Check(typeof(CameraPoseValue).GetProperty("Mode") == null, "geometry pose is protocol-neutral");
            Check(typeof(Vec3).IsValueType && typeof(Vec3).GetFields().All(field => field.IsInitOnly), "vectors are immutable values");
            Check(typeof(Quat).IsValueType && typeof(Quat).GetFields().All(field => field.IsInitOnly), "quaternions are immutable values");
            Check(typeof(CameraPoseValue).IsValueType, "geometry pose result is a value");
            Throws<ArgumentException>(() => new CameraPoseValue(
                new Vec3(0, 0, 0),
                new Vec3(0, 0, 0),
                fov: 1.0,
                orthoExtent: 2.0), "geometry pose rejects two projections");
            Throws<ArgumentOutOfRangeException>(() => new CameraPoseValue(
                new Vec3(0, 0, 0),
                new Vec3(0, 0, 0),
                orthoExtent: 0.0), "geometry pose validates orthographic extent");
            Check(!typeof(OpenAxisClient).GetMethods().Any(method => method.Name == "SendExtAsync"), "draft ext API removed");

            var sdkAssembly = typeof(OpenAxisClient).Assembly;
            Check(sdkAssembly.GetName().Name == "OpenAxis", "SDK ships as one assembly");
            Check(typeof(Protocol).Assembly == sdkAssembly, "protocol model belongs to SDK assembly");
            Check(typeof(Msg).Assembly == sdkAssembly, "messages belong to SDK assembly");
            Check(typeof(NavigationQuery).Assembly == sdkAssembly, "Navigation helper belongs to SDK assembly");
            Check(typeof(Vec3).Assembly == sdkAssembly, "geometry belongs to SDK assembly");
            Check(typeof(DiagnosticFormatter).Assembly == sdkAssembly, "diagnostics belong to SDK assembly");

            var orientation = WorldOrientation.Unpack(new Dictionary<string, object>
            {
                { "forward", new object[] { 0.0, 0.0, 1.0 } },
                { "up", new object[] { 0.0, 1.0, 0.0 } },
                { "handedness", "left" },
            });
            Check(orientation.Handedness == WorldHandedness.Left, "world orientation parses handedness");
            Check(SemanticallyEqual(orientation.Pack(), new Dictionary<string, object>
            {
                { "forward", new[] { 0.0, 0.0, 1.0 } },
                { "up", new[] { 0.0, 1.0, 0.0 } },
                { "handedness", "left" },
            }), "world orientation round trip");
            Throws<ArgumentException>(() => WorldOrientation.Unpack(new Dictionary<string, object>
            {
                { "forward", new object[] { 0.0, 0.0, -1.0 } },
                { "up", new object[] { 0.0, 1.0, 0.0 } },
                { "handedness", "sideways" },
            }), "world orientation rejects invalid handedness");

            var extension = new UnknownMsg
            {
                MessageType = "vendor.example",
                Value = new Dictionary<string, object> { { "payload", 1 } },
            };
            Check((string)extension.Pack()["type"] == "vendor.example", "unknown message construction supplies type");
            Throws<ArgumentException>(() => new UnknownMsg
            {
                MessageType = "vendor.example",
                Value = new Dictionary<string, object> { { "type", "vendor.other" } },
            }.Pack(), "unknown message rejects inconsistent type");
        }

        private static void CheckNavigationQuery()
        {
            Dictionary<string, object>? completed = null;
            var failures = new List<(string code, string? message)>();
            var query = new NavigationQuery(
                new Request
                {
                    Id = 41,
                    Method = "navigation.query",
                    Params = new Dictionary<string, object>
                    {
                        { "gesture_id", 73 },
                        { "values", new[] { "shared", "missing", "shared" } },
                        { "first", new[] { "missing", "first.available", "first.unreached" } },
                    },
                },
                result => completed = result,
                (code, message) => failures.Add((code, message)));

            var calls = new Dictionary<string, int>();
            object? Resolve(string name)
            {
                calls[name] = calls.TryGetValue(name, out var count) ? count + 1 : 1;
                switch (name)
                {
                    case "shared": return "cached";
                    case "missing": return NavigationQuery.Unavailable;
                    case "first.available": return new Dictionary<string, object> { { "point", new[] { 1.0, 2.0, 3.0 } } };
                    default: throw new InvalidOperationException($"Unexpected resolution of {name}");
                }
            }

            var result = query.Evaluate(Resolve);
            var values = Map(result["values"]);
            var first = Map(result["first"]);
            Check(query.RequestId == 41 && query.Scoped && query.GestureId == 73, "Navigation query typed identity");
            Check(query.HasFirst, "Navigation query preserves first presence");
            Check(values.Count == 1 && (string)values["shared"] == "cached", "Navigation query omits unavailable facts");
            Check((string)first["name"] == "first.available", "Navigation query selects first available candidate");
            Check(calls["shared"] == 1 && calls["missing"] == 1, "Navigation query memoizes repeated names");
            Check(calls["first.available"] == 1 && !calls.ContainsKey("first.unreached"), "Navigation query short-circuits first candidates");

            query.Complete(result);
            Check(ReferenceEquals(completed, result) && failures.Count == 0, "Navigation query completes once");
            Throws<InvalidOperationException>(() => query.Complete(result), "Navigation query rejects duplicate completion");
            Throws<InvalidOperationException>(() => query.Fail("unavailable"), "Navigation query rejects failure after completion");

            var failureQuery = new NavigationQuery(
                new Request { Id = 42, Method = "navigation.query" },
                _ => throw new InvalidOperationException("failure query must not complete"),
                (code, message) => failures.Add((code, message)));
            var unscopedResult = failureQuery.Evaluate(_ => throw new InvalidOperationException("no facts requested"));
            Check(!failureQuery.Scoped && !failureQuery.HasFirst, "Navigation query preserves omitted optional fields");
            Check(!unscopedResult.ContainsKey("first"), "Navigation query omits unrequested first result");
            failureQuery.Fail("unavailable", "application context changed");
            Check(failures.Count == 1 && failures[0].code == "unavailable", "Navigation query fails once");
            Throws<InvalidOperationException>(() => failureQuery.Fail("unavailable"), "Navigation query rejects duplicate failure");

            Throws<ArgumentException>(() => new NavigationQuery(
                new Request { Id = 43, Method = "command.execute" },
                _ => { },
                (_, __) => { }), "Navigation query rejects another RPC method");
            Throws<ArgumentException>(() => new NavigationQuery(
                new Request
                {
                    Id = 44,
                    Method = "navigation.query",
                    Params = new Dictionary<string, object> { { "values", "camera.pose" } },
                },
                _ => { },
                (_, __) => { }), "Navigation query validates requested-name arrays");
        }

        private static void CheckMessageFixtures()
        {
            var fixture = LoadFixture("messages.json");
            Check(Convert.ToInt32(fixture["schema_version"]) == 1, "message fixture schema version");
            Check((string)fixture["protocol"] == Protocol.Version, "fixture protocol version");

            foreach (var testCase in Cases(fixture, "valid_messages"))
            {
                var name = (string)testCase["name"];
                var wire = Map(testCase["message"]);
                var parsed = MsgDispatch.Unpack(wire);
                Check(!(parsed is UnknownMsg), $"valid message is known: {name}");
                Check(SemanticallyEqual(parsed.Pack(), wire), $"valid message round trip: {name}");
            }

            foreach (var testCase in Cases(fixture, "invalid_messages"))
            {
                var name = (string)testCase["name"];
                var wire = Map(testCase["message"]);
                Throws(() => MsgDispatch.Unpack(wire), $"invalid message rejected: {name}");
            }

            foreach (var testCase in Cases(fixture, "unknown_messages"))
            {
                var name = (string)testCase["name"];
                var wire = Map(testCase["message"]);
                var parsed = MsgDispatch.Unpack(wire);
                Check(parsed is UnknownMsg, $"unknown message has no standard semantics: {name}");
                Check(SemanticallyEqual(parsed.Pack(), wire), $"unknown message remains intact: {name}");
            }
        }

        private static void CheckGeometryFixtures()
        {
            var fixture = LoadFixture("geometry.json");
            Check(Convert.ToInt32(fixture["schema_version"]) == 1, "geometry fixture schema version");
            var tolerance = Convert.ToDouble(fixture["tolerance"]);

            foreach (var testCase in Cases(fixture, "quaternion_inverse"))
            {
                var q = Numbers(testCase["quaternion"]);
                var rotation = new Quat(q[0], q[1], q[2], q[3]);
                var product = rotation * rotation.Inverse();
                Check(
                    SemanticallyEqual(
                        new[] { product.W, product.X, product.Y, product.Z },
                        testCase["expected_product"],
                        tolerance),
                    $"quaternion inverse: {testCase["name"]}");
            }

            foreach (var testCase in Cases(fixture, "camera_basis_from_rotvec"))
            {
                var r = Numbers(testCase["r"]);
                var rotation = Quat.FromRotvec(r[0], r[1], r[2]);
                var right = rotation.Rotate(new Vec3(1, 0, 0));
                if ((string)testCase["handedness"] == "left") right = -right;
                var up = rotation.Rotate(new Vec3(0, 1, 0));
                var backward = rotation.Rotate(new Vec3(0, 0, 1));
                var actual = new Dictionary<string, object>
                {
                    { "right", new[] { right.X, right.Y, right.Z } },
                    { "up", new[] { up.X, up.Y, up.Z } },
                    { "backward", new[] { backward.X, backward.Y, backward.Z } },
                };
                Check(
                    SemanticallyEqual(actual, testCase["expected"], tolerance),
                    $"camera basis from rotvec: {testCase["name"]}");
            }

            foreach (var testCase in Cases(fixture, "pose_from_look_at"))
            {
                var projection = Map(testCase["projection"]);
                var pose = PoseHelpers.PoseFromLookAt(
                    Vector(testCase["eye"]),
                    Vector(testCase["target"]),
                    Vector(testCase["up"]),
                    projection.TryGetValue("fov", out var fov) ? Convert.ToDouble(fov) : (double?)null,
                    projection.TryGetValue("ortho_extent", out var extent) ? Convert.ToDouble(extent) : (double?)null);
                var actual = new Dictionary<string, object>
                {
                    { "t", new[] { pose.Position.X, pose.Position.Y, pose.Position.Z } },
                    { "r", new[] { pose.RotationVector.X, pose.RotationVector.Y, pose.RotationVector.Z } },
                };
                if (pose.Fov.HasValue) actual["fov"] = pose.Fov.Value;
                if (pose.OrthoExtent.HasValue) actual["ortho_extent"] = pose.OrthoExtent.Value;
                Check(
                    SemanticallyEqual(actual, testCase["expected"], tolerance),
                    $"pose from look-at: {testCase["name"]}");
            }

            foreach (var testCase in Cases(fixture, "look_at_from_pose"))
            {
                var value = Map(testCase["pose"]);
                var pose = new CameraPoseValue(
                    Vector(value["t"]),
                    Vector(value["r"]),
                    value.TryGetValue("fov", out var fov) ? Convert.ToDouble(fov) : (double?)null,
                    value.TryGetValue("ortho_extent", out var extent) ? Convert.ToDouble(extent) : (double?)null);
                var pivot = testCase["pivot"] == null ? (Vec3?)null : Vector(testCase["pivot"]);
                var (eye, target, up) = PoseHelpers.LookAtFromPose(
                    pose,
                    Convert.ToDouble(testCase["default_distance"]),
                    pivot);
                var actual = new Dictionary<string, object>
                {
                    { "eye", new[] { eye.X, eye.Y, eye.Z } },
                    { "target", new[] { target.X, target.Y, target.Z } },
                    { "up", new[] { up.X, up.Y, up.Z } },
                };
                Check(
                    SemanticallyEqual(actual, testCase["expected"], tolerance),
                    $"look-at from pose: {testCase["name"]}");
            }
        }

        private static void CheckDiagnostics()
        {
            Check(
                DiagnosticFormatter.FormatEvent("navigation.fact", new Dictionary<string, object?>
                {
                    { "fact", "model.bounds" },
                    { "result", "ok" },
                    { "value", new Dictionary<string, object?>
                        {
                            { "min", new[] { -1.6649999618, -0.6940374374, -0.007499963 } },
                            { "max", new[] { 1.4941880703, 0.595210433, 1.239323497 } },
                        }
                    },
                    { "duration_ms", 1.082 },
                    { "gesture", 3 },
                    { "request", 3 },
                }) == "  model.bounds — found (-1.665, -0.694, -0.007) … (1.494, 0.595, 1.239) · 1.082 ms",
                "diagnostics format fact result");

            Check(
                DiagnosticFormatter.FormatEvent("navigation.pivot", new Dictionary<string, object?>
                {
                    { "source", "query:pick.cursor" },
                    { "result", "selected" },
                    { "point", new[] { 0.8999999762, 0.0005832684, 0.6752421856 } },
                    { "client", "Rhino" },
                    { "request", 38L },
                    { "gesture", 43L },
                }) == "  pick.cursor — selected at (0.900, 0.001, 0.675) · Rhino, gesture 43, request 38",
                "diagnostics format pivot result");

            Check(
                DiagnosticFormatter.FormatEvent("navigation.query.complete", new Dictionary<string, object?>
                {
                    { "missing", new[] { "selection.bounds" } },
                    { "first", "pick.cursor" },
                    { "duration_ms", 2.0 },
                    { "gesture", 3L },
                    { "request", 3L },
                }) == "query complete — missing selection.bounds; first: pick.cursor · 2.000 ms · request 3",
                "diagnostics format query summary");

            var timestamp = new DateTime(2026, 9, 4, 11, 56, 59, 321, DateTimeKind.Local);
            Check(
                DiagnosticFormatter.FormatLogLine("motion started · gesture 3", now: timestamp)
                    == "2026-09-04 11:56:59.321  motion started · gesture 3",
                "diagnostics format local timestamp");
            Check(
                DiagnosticFormatter.FormatLogLine("motion canceled", DiagnosticLevel.Warning, timestamp)
                    == "2026-09-04 11:56:59.321  WARN motion canceled",
                "diagnostics format warning severity");
        }

        internal static Dictionary<string, object> LoadFixture(string name)
        {
            using (var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(FixtureDirectory, name))))
                return Map(ConvertJson(document.RootElement));
        }

        internal static IEnumerable<Dictionary<string, object>> Cases(
            Dictionary<string, object> fixture,
            string group)
        {
            foreach (var item in (IEnumerable)fixture[group]) yield return Map(item!);
        }

        private static object ConvertJson(JsonElement value)
        {
            switch (value.ValueKind)
            {
                case JsonValueKind.Object:
                    var properties = value.EnumerateObject().ToArray();
                    if (properties.Length == 1 && properties[0].Name == "$number")
                    {
                        switch (properties[0].Value.GetString())
                        {
                            case "nan": return double.NaN;
                            case "positive_infinity": return double.PositiveInfinity;
                            case "negative_infinity": return double.NegativeInfinity;
                            default: throw new InvalidDataException("Unknown $number fixture value");
                        }
                    }
                    var map = new Dictionary<string, object>(properties.Length);
                    foreach (var property in properties) map[property.Name] = ConvertJson(property.Value);
                    return map;
                case JsonValueKind.Array:
                    return value.EnumerateArray().Select(ConvertJson).ToArray();
                case JsonValueKind.String:
                    return value.GetString()!;
                case JsonValueKind.Number:
                    if (value.TryGetInt32(out var intValue)) return intValue;
                    if (value.TryGetInt64(out var longValue)) return longValue;
                    return value.GetDouble();
                case JsonValueKind.True: return true;
                case JsonValueKind.False: return false;
                case JsonValueKind.Null: return null!;
                default: throw new InvalidDataException($"Unsupported JSON fixture value {value.ValueKind}");
            }
        }

        internal static Dictionary<string, object> Map(object value) =>
            value as Dictionary<string, object>
            ?? throw new InvalidDataException("Expected fixture map");

        private static void CheckReleaseFixtures()
        {
            var unpack = typeof(OpenAxisClient).GetMethod("Unpack", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!;
            foreach (var c in Cases(LoadFixture("wire.json"), "cases"))
            {
                bool accepted = true;
                try {
                    var msg = (Msg)unpack.Invoke(null, new object[] { Convert.FromHexString((string)c["hex"]) })!;
                    if (msg is Request r && r.Method == "navigation.query") new NavigationQuery(r, _ => {}, (_, __) => {});
                } catch { accepted = false; }
                Check(accepted == (bool)c["valid"], $"wire: {c["name"]}");
            }
            foreach (var c in Cases(LoadFixture("queries.json"), "cases"))
            {
                var query = new NavigationQuery(new Request { Id = 1, Method = "navigation.query", Params = Map(c["params"]) }, _ => {}, (_, __) => {});
                var calls = new List<string>(); var facts = Map(c["facts"]);
                var result = query.Evaluate(name => { calls.Add(name); return facts.TryGetValue(name, out var value) ? value : NavigationQuery.Unavailable; });
                Check(SemanticallyEqual(result, c["result"]) && SemanticallyEqual(calls, c["calls"]), $"query: {c["name"]}");
            }
            var terminal = new NavigationQuery(new Request { Id = 1, Method = "navigation.query" }, _ => throw new InvalidOperationException("send failed"), (_, __) => {});
            Throws<ArgumentNullException>(() => terminal.Complete(null!), "validate before claim");
            Check(!terminal.Completed, "invalid completion leaves query open");
            Throws<InvalidOperationException>(() => terminal.Complete(new Dictionary<string, object>()), "failed send");
            Check(terminal.Completed, "failed send remains terminal");
        }

        private static double[] Numbers(object value) =>
            ((IEnumerable)value).Cast<object>().Select(Convert.ToDouble).ToArray();

        private static Vec3 Vector(object value)
        {
            var numbers = Numbers(value);
            return new Vec3(numbers[0], numbers[1], numbers[2]);
        }

        private static bool SemanticallyEqual(object? actual, object? expected, double tolerance = 0.0)
        {
            if (actual == null || expected == null) return actual == null && expected == null;
            if (actual is IDictionary actualMap && expected is IDictionary expectedMap)
            {
                if (actualMap.Count != expectedMap.Count) return false;
                foreach (DictionaryEntry entry in expectedMap)
                {
                    if (!actualMap.Contains(entry.Key) ||
                        !SemanticallyEqual(actualMap[entry.Key], entry.Value, tolerance)) return false;
                }
                return true;
            }
            if (actual is IEnumerable actualValues && expected is IEnumerable expectedValues &&
                !(actual is string) && !(expected is string))
            {
                var left = actualValues.Cast<object?>().ToArray();
                var right = expectedValues.Cast<object?>().ToArray();
                return left.Length == right.Length &&
                       left.Zip(right, (a, b) => SemanticallyEqual(a, b, tolerance)).All(equal => equal);
            }
            if (IsNumber(actual) && IsNumber(expected))
            {
                var left = Convert.ToDouble(actual);
                var right = Convert.ToDouble(expected);
                if (double.IsNaN(left) || double.IsNaN(right)) return double.IsNaN(left) && double.IsNaN(right);
                return Math.Abs(left - right) <= tolerance;
            }
            return actual.Equals(expected);
        }

        private static bool IsNumber(object value) =>
            value is sbyte || value is byte || value is short || value is ushort ||
            value is int || value is uint || value is long || value is ulong ||
            value is float || value is double || value is decimal;

        private static void Check(bool condition, string name)
        {
            _checks++;
            if (!condition) throw new InvalidOperationException($"Check failed: {name}");
        }

        private static void Throws(Action action, string name)
        {
            Throws<ArgumentException>(action, name);
        }

        private static void Throws<TException>(Action action, string name)
            where TException : Exception
        {
            _checks++;
            try { action(); }
            catch (TException) { return; }
            throw new InvalidOperationException($"Expected {typeof(TException).Name}: {name}");
        }
    }
}
