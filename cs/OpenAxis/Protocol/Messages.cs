using System;
using System.Collections;
using System.Collections.Generic;

namespace OpenAxis.Client
{
    public static class Protocol
    {
        public const string Version = "openaxis/1.0";
        public const long MaxInteger = 9007199254740991;
        public const string DefaultUrl = "ws://localhost:6607";
    }

    /// <summary>Handedness of the application world coordinate system.</summary>
    public enum WorldHandedness
    {
        Right,
        Left,
    }

    /// <summary>Typed value for the required <c>world.orientation</c> Navigation fact.</summary>
    public sealed class WorldOrientation
    {
        public double[] Forward { get; set; } = new double[] { 0, 0, -1 };
        public double[] Up { get; set; } = new double[] { 0, 1, 0 };
        public WorldHandedness Handedness { get; set; } = WorldHandedness.Right;

        public Dictionary<string, object> Pack()
        {
            string handedness;
            switch (Handedness)
            {
                case WorldHandedness.Right: handedness = "right"; break;
                case WorldHandedness.Left: handedness = "left"; break;
                default: throw new ArgumentException("world.orientation.handedness must be right or left");
            }
            return new Dictionary<string, object>
            {
                { "forward", MsgUtil.Vec3(Forward, "world.orientation.forward") },
                { "up", MsgUtil.Vec3(Up, "world.orientation.up") },
                { "handedness", handedness },
            };
        }

        public static WorldOrientation Unpack(Dictionary<string, object> value)
        {
            if (value == null) throw new ArgumentNullException(nameof(value));
            var handedness = value.TryGetValue("handedness", out var handednessValue)
                ? MsgUtil.String(handednessValue, "world.orientation.handedness")
                : "right";
            if (handedness != "right" && handedness != "left")
                throw new ArgumentException("world.orientation.handedness must be right or left");
            return new WorldOrientation
            {
                Forward = MsgUtil.Req3(value, "forward", "world.orientation"),
                Up = MsgUtil.Req3(value, "up", "world.orientation"),
                Handedness = handedness == "right" ? WorldHandedness.Right : WorldHandedness.Left,
            };
        }
    }

    public abstract class Msg
    {
        public abstract string Type { get; }
        public virtual Dictionary<string, object> Pack() =>
            new Dictionary<string, object> { { "type", Type } };
    }

    public sealed class UnknownMsg : Msg
    {
        public string MessageType { get; set; } = "";
        public Dictionary<string, object> Value { get; set; } = new Dictionary<string, object>();
        public override string Type => MessageType;
        public override Dictionary<string, object> Pack()
        {
            var messageType = MsgUtil.String(MessageType, "message.type");
            if (Value == null) throw new ArgumentException("Unknown message value must be a map");
            var result = new Dictionary<string, object>(Value);
            if (result.TryGetValue("type", out var existingType) &&
                MsgUtil.String(existingType, "message.type") != messageType)
                throw new ArgumentException("Unknown message type does not match its value");
            result["type"] = messageType;
            return result;
        }
    }

    public static class MsgDispatch
    {
        public static Msg Unpack(Dictionary<string, object> d)
        {
            if (!d.TryGetValue("type", out var typeObj) || !(typeObj is string type) || type.Length == 0)
                throw new ArgumentException("Message missing string 'type' field");
            switch (type)
            {
                case "hello": return Hello.Unpack(d);
                case "hello_ack": return HelloAck.Unpack(d);
                case "heartbeat": return new Heartbeat();
                case "error": return Error.Unpack(d);
                case "request": return Request.Unpack(d);
                case "response": return Response.Unpack(d);
                case "tags": return Tags.Unpack(d);
                case "focus": return Focus.Unpack(d);
                case "capabilities": return Capabilities.Unpack(d);
                case "subscribe": return Subscribe.Unpack(d);
                case "axes": return Axes.Unpack(d);
                case "motion_start": return MotionStart.Unpack(d);
                case "motion_end": return MotionEnd.Unpack(d);
                case "motion_cancel": return MotionCancel.Unpack(d);
                case "viewport.settled": return new ViewportSettled();
                case "navigation.state": return NavigationState.Unpack(d);
                case "frame": return Frame.Unpack(d);
                case "buttons": return Buttons.Unpack(d);
                case "camera.pose": return CameraPose.Unpack(d);
                case "camera.delta": return CameraDelta.Unpack(d);
                case "camera.pivot": return CameraPivot.Unpack(d);
                case "object.pose": return ObjectPose.Unpack(d);
                case "object.delta": return ObjectDelta.Unpack(d);
                case "object.pivot": return ObjectPivot.Unpack(d);
                default: return new UnknownMsg { MessageType = type, Value = d };
            }
        }
    }

    internal static class MsgUtil
    {
        public static object Req(Dictionary<string, object> d, string key, string typeName)
        {
            if (!d.TryGetValue(key, out var value))
                throw new ArgumentException($"{typeName} missing required '{key}'");
            return value;
        }

        public static int Integer(object value, string name)
        {
            if (value is bool || !(value is sbyte || value is byte || value is short || value is ushort ||
                                   value is int || value is uint || value is long || value is ulong))
                throw new ArgumentException($"{name} must be a non-negative integer");
            try
            {
                var result = Convert.ToInt64(value);
                if (result < 0 || result > int.MaxValue)
                    throw new ArgumentException($"{name} must be a non-negative integer no greater than {int.MaxValue}");
                return (int)result;
            }
            catch (OverflowException)
            {
                throw new ArgumentException($"{name} must be a non-negative integer no greater than {int.MaxValue}");
            }
        }

        public static long LongInteger(object value, string name)
        {
            if (value is bool || !(value is sbyte || value is byte || value is short || value is ushort ||
                                   value is int || value is uint || value is long || value is ulong))
                throw new ArgumentException($"{name} must be a non-negative integer");
            try
            {
                var result = Convert.ToInt64(value);
                if (result < 0 || result > Protocol.MaxInteger) throw new ArgumentException($"{name} must be an integer from 0 through {Protocol.MaxInteger}");
                return result;
            }
            catch (OverflowException)
            {
                throw new ArgumentException($"{name} must be a non-negative integer");
            }
        }

        public static string String(object value, string name, bool allowEmpty = false)
        {
            if (!(value is string result) || (!allowEmpty && string.IsNullOrWhiteSpace(result)))
                throw new ArgumentException($"{name} must be a{(allowEmpty ? "" : " non-empty")} string");
            return result;
        }

        public static bool Boolean(object value, string name)
        {
            if (!(value is bool result)) throw new ArgumentException($"{name} must be a boolean");
            return result;
        }

        public static double Finite(object value, string name)
        {
            if (!(value is byte || value is sbyte || value is short || value is ushort ||
                  value is int || value is uint || value is long || value is ulong ||
                  value is float || value is double || value is decimal))
                throw new ArgumentException($"{name} must be a finite number");
            double result;
            try { result = Convert.ToDouble(value); }
            catch (Exception ex) when (ex is FormatException || ex is InvalidCastException || ex is OverflowException)
            {
                throw new ArgumentException($"{name} must be finite");
            }
            if (double.IsNaN(result) || double.IsInfinity(result))
                throw new ArgumentException($"{name} must be finite");
            return result;
        }

        public static double Positive(object value, string name)
        {
            var result = Finite(value, name);
            if (result <= 0) throw new ArgumentException($"{name} must be positive and finite");
            return result;
        }

        public static double[] Req3(Dictionary<string, object> d, string key, string typeName)
        {
            var result = ToDoubleArray(Req(d, key, typeName), $"{typeName}.{key}");
            if (result.Length != 3) throw new ArgumentException($"{typeName} '{key}' must have 3 elements");
            return result;
        }

        public static string[] ToStringArray(object value)
        {
            if (!(value is IEnumerable values) || !(value is Array || value is IList) || value is byte[])
                throw new ArgumentException("Expected an array of strings");
            var result = new List<string>();
            foreach (var item in values)
            {
                if (!(item is string name) || name.Length == 0)
                    throw new ArgumentException("Expected non-empty string array entries");
                result.Add(name);
            }
            return result.ToArray();
        }

        public static double[] ToDoubleArray(object value, string name)
        {
            if (!(value is IEnumerable values) || !(value is Array || value is IList) || value is byte[])
                throw new ArgumentException("Expected a numeric array");
            var result = new List<double>();
            foreach (var item in values) result.Add(Finite(item!, name));
            return result.ToArray();
        }

        public static double[] Vec3(double[] value, string name)
        {
            if (value == null || value.Length != 3) throw new ArgumentException($"{name} must have exactly 3 elements");
            for (var i = 0; i < value.Length; i++) Finite(value[i], name);
            return value;
        }

        public static Dictionary<string, object> ToMap(object value, string name)
        {
            if (value is Dictionary<string, object> ready) return ready;
            if (value is IDictionary map)
            {
                var result = new Dictionary<string, object>(map.Count);
                foreach (DictionaryEntry entry in map)
                {
                    if (!(entry.Key is string key) || string.IsNullOrEmpty(key))
                        throw new ArgumentException($"{name} contains a non-string or empty key");
                    result[key] = entry.Value!;
                }
                return result;
            }
            throw new ArgumentException($"{name} must be a map");
        }
    }

    /// <summary>The application receiving control from this connection.</summary>
    public sealed class Target
    {
        public string? Pid { get; set; }
        public string? App { get; set; }
        public string? AppVersion { get; set; }

        public Dictionary<string, object> Pack()
        {
            if (Pid == null && App == null)
                throw new ArgumentException("hello.target requires pid or app");
            var result = new Dictionary<string, object>();
            if (Pid != null)
            {
                if (!System.Text.RegularExpressions.Regex.IsMatch(Pid, @"\A[1-9][0-9]*(?::[1-9][0-9]*)?\z")) throw new ArgumentException("hello.target.pid must be a canonical positive PID string");
                result["pid"] = Pid;
            }
            if (App != null) result["app"] = MsgUtil.String(App, "hello.target.app");
            if (AppVersion != null) result["app_version"] = MsgUtil.String(AppVersion, "hello.target.app_version");
            return result;
        }

        public static Target Unpack(Dictionary<string, object> value)
        {
            var target = new Target
            {
                Pid = value.TryGetValue("pid", out var pid) ? MsgUtil.String(pid, "hello.target.pid") : null,
                App = value.TryGetValue("app", out var app) ? MsgUtil.String(app, "hello.target.app") : null,
                AppVersion = value.TryGetValue("app_version", out var version) ? MsgUtil.String(version, "hello.target.app_version") : null,
            };
            target.Pack();
            return target;
        }
    }

    public sealed class SdkInfo
    {
        public string Name { get; set; } = "";
        public string Version { get; set; } = "";
        public Dictionary<string, object> Pack() => new Dictionary<string, object>
            { { "name", MsgUtil.String(Name, "hello.sdk.name") }, { "version", MsgUtil.String(Version, "hello.sdk.version") } };
        public static SdkInfo Unpack(Dictionary<string, object> value) => new SdkInfo
            { Name = MsgUtil.String(MsgUtil.Req(value, "name", "hello.sdk"), "hello.sdk.name"),
              Version = MsgUtil.String(MsgUtil.Req(value, "version", "hello.sdk"), "hello.sdk.version") };
    }

    public sealed class Hello : Msg
    {
        public override string Type => "hello";
        public string Proto { get; set; } = "";
        public string ClientName { get; set; } = "";
        public Target? Target { get; set; }
        public string? ClientVersion { get; set; }
        public SdkInfo? Sdk { get; set; }
        public override Dictionary<string, object> Pack()
        {
            var result = new Dictionary<string, object>
                { { "type", Type }, { "proto", MsgUtil.String(Proto, "hello.proto") }, { "client_name", MsgUtil.String(ClientName, "hello.client_name") } };
            if (Target != null) result["target"] = Target.Pack();
            if (ClientVersion != null) result["client_version"] = MsgUtil.String(ClientVersion, "hello.client_version");
            if (Sdk != null) result["sdk"] = Sdk.Pack();
            return result;
        }
        public static Hello Unpack(Dictionary<string, object> d) => new Hello
            { Proto = MsgUtil.String(MsgUtil.Req(d, "proto", "hello"), "hello.proto"), ClientName = MsgUtil.String(MsgUtil.Req(d, "client_name", "hello"), "hello.client_name"), Target = d.TryGetValue("target", out var target) ? OpenAxis.Client.Target.Unpack(MsgUtil.ToMap(target, "hello.target")) : null,
              ClientVersion = d.TryGetValue("client_version", out var version) ? MsgUtil.String(version, "hello.client_version") : null,
              Sdk = d.TryGetValue("sdk", out var sdk) ? SdkInfo.Unpack(MsgUtil.ToMap(sdk, "hello.sdk")) : null };
    }

    public sealed class HelloAck : Msg
    {
        public override string Type => "hello_ack";
        public string Proto { get; set; } = "";
        public string ServerName { get; set; } = "";
        public override Dictionary<string, object> Pack() => new Dictionary<string, object>
            { { "type", Type }, { "proto", MsgUtil.String(Proto, "hello_ack.proto") }, { "server_name", MsgUtil.String(ServerName, "hello_ack.server_name") } };
        public static HelloAck Unpack(Dictionary<string, object> d) => new HelloAck
            { Proto = MsgUtil.String(MsgUtil.Req(d, "proto", "hello_ack"), "hello_ack.proto"), ServerName = MsgUtil.String(MsgUtil.Req(d, "server_name", "hello_ack"), "hello_ack.server_name") };
    }

    public sealed class Heartbeat : Msg { public override string Type => "heartbeat"; }

    public sealed class Error : Msg
    {
        public override string Type => "error";
        public string Code { get; set; } = "";
        public string Message { get; set; } = "";
        public override Dictionary<string, object> Pack() => new Dictionary<string, object>
            { { "type", Type }, { "code", MsgUtil.String(Code, "error.code") }, { "message", MsgUtil.String(Message, "error.message", true) } };
        public static Error Unpack(Dictionary<string, object> d) => new Error
            { Code = MsgUtil.String(MsgUtil.Req(d, "code", "error"), "error.code"), Message = MsgUtil.String(MsgUtil.Req(d, "message", "error"), "error.message", true) };
    }

    public sealed class RpcError
    {
        public string Code { get; set; } = "";
        public string? Message { get; set; }
        public Dictionary<string, object> Pack()
        {
            var result = new Dictionary<string, object> { { "code", MsgUtil.String(Code, "response.error.code") } };
            if (Message != null) result["message"] = Message;
            return result;
        }
    }

    public sealed class Request : Msg
    {
        public override string Type => "request";
        public long Id { get; set; }
        public string Method { get; set; } = "";
        public Dictionary<string, object> Params { get; set; } = new Dictionary<string, object>();
        public override Dictionary<string, object> Pack() => new Dictionary<string, object>
            { { "type", Type }, { "id", MsgUtil.LongInteger(Id, "request.id") }, { "method", MsgUtil.String(Method, "request.method") }, { "params", Params ?? throw new ArgumentException("request.params must be a map") } };
        public static Request Unpack(Dictionary<string, object> d) => new Request
        {
            Id = MsgUtil.LongInteger(MsgUtil.Req(d, "id", "request"), "request.id"),
            Method = MsgUtil.String(MsgUtil.Req(d, "method", "request"), "request.method"),
            Params = d.TryGetValue("params", out var p) ? MsgUtil.ToMap(p, "request.params") : new Dictionary<string, object>(),
        };
    }

    public sealed class Response : Msg
    {
        public override string Type => "response";
        public long Id { get; set; }
        public Dictionary<string, object>? Result { get; set; }
        public RpcError? Error { get; set; }
        public override Dictionary<string, object> Pack()
        {
            if ((Result == null) == (Error == null)) throw new ArgumentException("response requires exactly one of result or error");
            var d = new Dictionary<string, object> { { "type", Type }, { "id", MsgUtil.LongInteger(Id, "response.id") } };
            if (Result != null) d["result"] = Result; else d["error"] = Error!.Pack();
            return d;
        }
        public static Response Unpack(Dictionary<string, object> d)
        {
            bool hasResult = d.ContainsKey("result"), hasError = d.ContainsKey("error");
            if (hasResult == hasError) throw new ArgumentException("response requires exactly one of result or error");
            var response = new Response { Id = MsgUtil.LongInteger(MsgUtil.Req(d, "id", "response"), "response.id") };
            if (hasResult) response.Result = MsgUtil.ToMap(d["result"], "response.result");
            else
            {
                var error = MsgUtil.ToMap(d["error"], "response.error");
                response.Error = new RpcError
                {
                    Code = MsgUtil.String(MsgUtil.Req(error, "code", "response.error"), "response.error.code"),
                    Message = error.TryGetValue("message", out var m) ? MsgUtil.String(m, "response.error.message", true) : null,
                };
            }
            return response;
        }
    }

    public sealed class Focus : Msg
    {
        public override string Type => "focus";
        public bool Focused { get; set; }
        public override Dictionary<string, object> Pack() => new Dictionary<string, object>
            { { "type", Type }, { "focused", Focused } };
        public static Focus Unpack(Dictionary<string, object> d) => new Focus
            { Focused = MsgUtil.Boolean(MsgUtil.Req(d, "focused", "focus"), "focus.focused") };
    }

    public sealed class Tags : Msg
    {
        public override string Type => "tags";
        public string[] TagValues { get; set; } = Array.Empty<string>();
        public override Dictionary<string, object> Pack() => new Dictionary<string, object> { { "type", Type }, { "tags", MsgUtil.ToStringArray(TagValues) } };
        public static Tags Unpack(Dictionary<string, object> d) => new Tags { TagValues = MsgUtil.ToStringArray(MsgUtil.Req(d, "tags", "tags")) };
    }

    public sealed class Capabilities : Msg
    {
        public override string Type => "capabilities";
        public string[] CapabilityValues { get; set; } = Array.Empty<string>();
        public override Dictionary<string, object> Pack() => new Dictionary<string, object> { { "type", Type }, { "capabilities", MsgUtil.ToStringArray(CapabilityValues) } };
        public static Capabilities Unpack(Dictionary<string, object> d) => new Capabilities { CapabilityValues = MsgUtil.ToStringArray(MsgUtil.Req(d, "capabilities", "capabilities")) };
    }

    public sealed class Subscribe : Msg
    {
        public override string Type => "subscribe";
        public string[] AxesValues { get; set; } = Array.Empty<string>();
        public override Dictionary<string, object> Pack() => new Dictionary<string, object> { { "type", Type }, { "axes", MsgUtil.ToStringArray(AxesValues) } };
        public static Subscribe Unpack(Dictionary<string, object> d) => new Subscribe { AxesValues = MsgUtil.ToStringArray(MsgUtil.Req(d, "axes", "subscribe")) };
    }

    public sealed class Axes : Msg
    {
        public override string Type => "axes";
        public string[] AxesValues { get; set; } = Array.Empty<string>();
        public override Dictionary<string, object> Pack() => new Dictionary<string, object>
            { { "type", Type }, { "axes", MsgUtil.ToStringArray(AxesValues) } };
        public static Axes Unpack(Dictionary<string, object> d) => new Axes { AxesValues = MsgUtil.ToStringArray(MsgUtil.Req(d, "axes", "axes")) };
    }

    public sealed class MotionStart : Msg
    {
        public override string Type => "motion_start";
        public long GestureId { get; set; }
        public override Dictionary<string, object> Pack() => new Dictionary<string, object>
            { { "type", Type }, { "gesture_id", MsgUtil.LongInteger(GestureId, "motion_start.gesture_id") } };
        public static MotionStart Unpack(Dictionary<string, object> d) => new MotionStart
            { GestureId = MsgUtil.LongInteger(MsgUtil.Req(d, "gesture_id", "motion_start"), "motion_start.gesture_id") };
    }

    public sealed class MotionEnd : Msg
    {
        public override string Type => "motion_end";
        public long GestureId { get; set; }
        public override Dictionary<string, object> Pack() => new Dictionary<string, object>
            { { "type", Type }, { "gesture_id", MsgUtil.LongInteger(GestureId, "motion_end.gesture_id") } };
        public static MotionEnd Unpack(Dictionary<string, object> d) => new MotionEnd
            { GestureId = MsgUtil.LongInteger(MsgUtil.Req(d, "gesture_id", "motion_end"), "motion_end.gesture_id") };
    }

    public sealed class MotionCancel : Msg
    {
        public override string Type => "motion_cancel";
        public long GestureId { get; set; }
        public string? Reason { get; set; }
        public override Dictionary<string, object> Pack()
        {
            var d = new Dictionary<string, object> { { "type", Type }, { "gesture_id", MsgUtil.LongInteger(GestureId, "motion_cancel.gesture_id") } };
            if (Reason != null) d["reason"] = MsgUtil.String(Reason, "motion_cancel.reason", true);
            return d;
        }
        public static MotionCancel Unpack(Dictionary<string, object> d) => new MotionCancel
        {
            GestureId = MsgUtil.LongInteger(MsgUtil.Req(d, "gesture_id", "motion_cancel"), "motion_cancel.gesture_id"),
            Reason = d.TryGetValue("reason", out var reason) ? MsgUtil.String(reason, "motion_cancel.reason", true) : null,
        };
    }

    public sealed class ViewportSettled : Msg { public override string Type => "viewport.settled"; }

    public sealed class Buttons : Msg
    {
        public override string Type => "buttons";
        public int Value { get; set; }
        public override Dictionary<string, object> Pack() => new Dictionary<string, object>
            { { "type", Type }, { "buttons", MsgUtil.Integer(Value, "buttons.buttons") } };
        public static Buttons Unpack(Dictionary<string, object> d) => new Buttons
            { Value = MsgUtil.Integer(MsgUtil.Req(d, "buttons", "buttons"), "buttons.buttons") };
    }

    public sealed class Frame : Msg
    {
        public override string Type => "frame";
        public long Seq { get; set; }
        public long TUs { get; set; }
        public double[] Values { get; set; } = Array.Empty<double>();
        public override Dictionary<string, object> Pack() => new Dictionary<string, object>
            { { "type", Type }, { "seq", MsgUtil.LongInteger(Seq, "frame.seq") }, { "t_us", MsgUtil.LongInteger(TUs, "frame.t_us") }, { "values", MsgUtil.ToDoubleArray(Values, "frame.values") } };
        public static Frame Unpack(Dictionary<string, object> d) => new Frame
        {
            Seq = MsgUtil.LongInteger(MsgUtil.Req(d, "seq", "frame"), "frame.seq"), TUs = MsgUtil.LongInteger(MsgUtil.Req(d, "t_us", "frame"), "frame.t_us"),
            Values = MsgUtil.ToDoubleArray(MsgUtil.Req(d, "values", "frame"), "frame.values"),
        };
    }

    public sealed class CameraNavigationState
    {
        public string Mode { get; set; } = "orbit";
        public bool? LockRoll { get; set; }
        public bool? LockTranslationPlane { get; set; }
        public double? TranslationScale { get; set; }
        public Dictionary<string, object> Pack()
        {
            if (Mode != "orbit" && Mode != "free_camera")
                throw new ArgumentException("navigation.state.camera.mode must be orbit or free_camera");
            if (Mode == "orbit" && (LockRoll.HasValue || LockTranslationPlane.HasValue || TranslationScale.HasValue))
                throw new ArgumentException("orbit navigation state cannot contain free-camera fields");
            var d = new Dictionary<string, object> { { "mode", Mode } };
            if (Mode == "free_camera" && (!LockRoll.HasValue || !LockTranslationPlane.HasValue))
                throw new ArgumentException("free_camera requires both constraint booleans");
            if (LockRoll.HasValue) d["lock_roll"] = LockRoll.Value;
            if (LockTranslationPlane.HasValue) d["lock_translation_plane"] = LockTranslationPlane.Value;
            if (TranslationScale.HasValue) d["translation_scale"] = MsgUtil.Positive(TranslationScale.Value, "navigation.state.camera.translation_scale");
            return d;
        }
        internal static CameraNavigationState Unpack(object value)
        {
            var d = MsgUtil.ToMap(value, "navigation.state.camera");
            var mode = MsgUtil.String(MsgUtil.Req(d, "mode", "navigation.state.camera"), "navigation.state.camera.mode");
            if (mode != "orbit" && mode != "free_camera")
                throw new ArgumentException("navigation.state.camera.mode must be orbit or free_camera");
            if (mode == "free_camera" && (!d.ContainsKey("lock_roll") || !d.ContainsKey("lock_translation_plane")))
                throw new ArgumentException("free_camera requires both constraint booleans");
            if (mode == "orbit" && (d.ContainsKey("lock_roll") || d.ContainsKey("lock_translation_plane") || d.ContainsKey("translation_scale")))
                throw new ArgumentException("orbit navigation state cannot contain free-camera fields");
            return new CameraNavigationState
            {
                Mode = mode,
                LockRoll = d.TryGetValue("lock_roll", out var lr) ? MsgUtil.Boolean(lr, "navigation.state.camera.lock_roll") : (bool?)null,
                LockTranslationPlane = d.TryGetValue("lock_translation_plane", out var lp) ? MsgUtil.Boolean(lp, "navigation.state.camera.lock_translation_plane") : (bool?)null,
                TranslationScale = d.TryGetValue("translation_scale", out var ts) ? MsgUtil.Positive(ts, "navigation.state.camera.translation_scale") : (double?)null,
            };
        }
    }

    public sealed class ObjectNavigationState
    {
        public bool AllowTranslation { get; set; }
        public bool AllowRotation { get; set; }
        public Dictionary<string, object> Pack() => new Dictionary<string, object>
        {
            { "allow_translation", AllowTranslation },
            { "allow_rotation", AllowRotation },
        };
        internal static ObjectNavigationState Unpack(object value)
        {
            var d = MsgUtil.ToMap(value, "navigation.state.object");
            return new ObjectNavigationState
            {
                AllowTranslation = MsgUtil.Boolean(MsgUtil.Req(d, "allow_translation", "navigation.state.object"), "navigation.state.object.allow_translation"),
                AllowRotation = MsgUtil.Boolean(MsgUtil.Req(d, "allow_rotation", "navigation.state.object"), "navigation.state.object.allow_rotation"),
            };
        }
    }

    public sealed class NavigationState : Msg
    {
        public override string Type => "navigation.state";
        public long GestureId { get; set; }
        public CameraNavigationState? Camera { get; set; }
        public ObjectNavigationState? Object { get; set; }
        public override Dictionary<string, object> Pack()
        {
            if (Camera == null && Object == null) throw new ArgumentException("navigation.state requires an active camera or object");
            var d = new Dictionary<string, object> { { "type", Type }, { "gesture_id", MsgUtil.LongInteger(GestureId, "navigation.state.gesture_id") } };
            if (Camera != null) d["camera"] = Camera.Pack();
            if (Object != null) d["object"] = Object.Pack();
            return d;
        }
        public static NavigationState Unpack(Dictionary<string, object> d)
        {
            var camera = d.TryGetValue("camera", out var cameraValue) ? CameraNavigationState.Unpack(cameraValue) : null;
            var obj = d.TryGetValue("object", out var objectValue) ? ObjectNavigationState.Unpack(objectValue) : null;
            if (camera == null && obj == null) throw new ArgumentException("navigation.state requires an active camera or object");
            return new NavigationState
            {
                GestureId = MsgUtil.LongInteger(MsgUtil.Req(d, "gesture_id", "navigation.state"), "navigation.state.gesture_id"),
                Camera = camera,
                Object = obj,
            };
        }
    }

    public sealed class CameraPose : Msg
    {
        public override string Type => "camera.pose";
        public long? GestureId { get; set; }
        public long? Seq { get; set; }
        public long? AppliedDeltaId { get; set; }
        public double[] T { get; set; } = new double[] { 0, 0, 0 };
        public double[] R { get; set; } = new double[] { 0, 0, 0 };
        public double? Fov { get; set; }
        public double? OrthoExtent { get; set; }

        public Dictionary<string, object> Value()
        {
            if (Fov.HasValue == OrthoExtent.HasValue) throw new ArgumentException("camera.pose requires exactly one projection");
            var d = new Dictionary<string, object>
                { { "t", MsgUtil.Vec3(T, "camera.pose.t") }, { "r", MsgUtil.Vec3(R, "camera.pose.r") } };
            if (Fov.HasValue) d["fov"] = MsgUtil.Positive(Fov.Value, "camera.pose.fov");
            else d["ortho_extent"] = MsgUtil.Positive(OrthoExtent!.Value, "camera.pose.ortho_extent");
            return d;
        }

        public override Dictionary<string, object> Pack()
        {
            if (!GestureId.HasValue) throw new ArgumentException("camera.pose requires gesture_id as a top-level message");
            var d = Value();
            d["type"] = Type;
            d["gesture_id"] = MsgUtil.LongInteger(GestureId.Value, "camera.pose.gesture_id");
            if (Seq.HasValue) d["seq"] = MsgUtil.LongInteger(Seq.Value, "camera.pose.seq");
            if (AppliedDeltaId.HasValue) d["applied_delta_id"] = MsgUtil.LongInteger(AppliedDeltaId.Value, "camera.pose.applied_delta_id");
            return d;
        }

        public static CameraPose FromValue(Dictionary<string, object> d)
        {
            var pose = new CameraPose
            {
                T = MsgUtil.Req3(d, "t", "camera.pose"), R = MsgUtil.Req3(d, "r", "camera.pose"),
                Fov = d.TryGetValue("fov", out var f) ? MsgUtil.Positive(f, "camera.pose.fov") : (double?)null,
                OrthoExtent = d.TryGetValue("ortho_extent", out var oe) ? MsgUtil.Positive(oe, "camera.pose.ortho_extent") : (double?)null,
            };
            pose.Value();
            return pose;
        }

        public static CameraPose Unpack(Dictionary<string, object> d)
        {
            var pose = FromValue(d);
            pose.GestureId = MsgUtil.LongInteger(MsgUtil.Req(d, "gesture_id", "camera.pose"), "camera.pose.gesture_id");
            pose.Seq = d.TryGetValue("seq", out var seq) ? MsgUtil.LongInteger(seq, "camera.pose.seq") : (long?)null;
            pose.AppliedDeltaId = d.TryGetValue("applied_delta_id", out var aid) ? MsgUtil.LongInteger(aid, "camera.pose.applied_delta_id") : (long?)null;
            return pose;
        }
    }

    public sealed class CameraDelta : Msg
    {
        public override string Type => "camera.delta";
        public long GestureId { get; set; }
        public double[] T { get; set; } = new double[] { 0, 0, 0 };
        public double[] R { get; set; } = new double[] { 0, 0, 0 };
        public double? OrthoExtentScale { get; set; }
        public long? DeltaId { get; set; }
        public override Dictionary<string, object> Pack()
        {
            var d = new Dictionary<string, object>
            {
                { "type", Type },
                { "gesture_id", MsgUtil.LongInteger(GestureId, "camera.delta.gesture_id") },
                { "t", MsgUtil.Vec3(T, "camera.delta.t") },
                { "r", MsgUtil.Vec3(R, "camera.delta.r") },
            };
            if (OrthoExtentScale.HasValue) d["ortho_extent_scale"] = MsgUtil.Positive(OrthoExtentScale.Value, "camera.delta.ortho_extent_scale");
            if (DeltaId.HasValue) d["delta_id"] = MsgUtil.LongInteger(DeltaId.Value, "camera.delta.delta_id");
            return d;
        }
        public static CameraDelta Unpack(Dictionary<string, object> d) => new CameraDelta
        {
            GestureId = MsgUtil.LongInteger(MsgUtil.Req(d, "gesture_id", "camera.delta"), "camera.delta.gesture_id"),
            T = MsgUtil.Req3(d, "t", "camera.delta"), R = MsgUtil.Req3(d, "r", "camera.delta"),
            OrthoExtentScale = d.TryGetValue("ortho_extent_scale", out var scale) ? MsgUtil.Positive(scale, "camera.delta.ortho_extent_scale") : (double?)null,
            DeltaId = d.TryGetValue("delta_id", out var id) ? MsgUtil.LongInteger(id, "camera.delta.delta_id") : (long?)null,
        };
    }

    public sealed class CameraPivot : Msg
    {
        public override string Type => "camera.pivot";
        public long GestureId { get; set; }
        public double[] Point { get; set; } = new double[] { 0, 0, 0 };
        public override Dictionary<string, object> Pack()
        {
            return new Dictionary<string, object>
                { { "type", Type }, { "gesture_id", MsgUtil.LongInteger(GestureId, "camera.pivot.gesture_id") }, { "point", MsgUtil.Vec3(Point, "camera.pivot.point") } };
        }
        public static CameraPivot Unpack(Dictionary<string, object> d) => new CameraPivot
        {
            GestureId = MsgUtil.LongInteger(MsgUtil.Req(d, "gesture_id", "camera.pivot"), "camera.pivot.gesture_id"),
            Point = MsgUtil.Req3(d, "point", "camera.pivot"),
        };
    }

    public sealed class ObjectPose : Msg
    {
        public override string Type => "object.pose";
        public long? GestureId { get; set; }
        public long? Seq { get; set; }
        public long? AppliedDeltaId { get; set; }
        public double[] T { get; set; } = new double[] { 0, 0, 0 };
        public double[] R { get; set; } = new double[] { 0, 0, 0 };
        public Dictionary<string, object> Value() => new Dictionary<string, object>
            { { "t", MsgUtil.Vec3(T, "object.pose.t") }, { "r", MsgUtil.Vec3(R, "object.pose.r") } };
        public override Dictionary<string, object> Pack()
        {
            if (!GestureId.HasValue) throw new ArgumentException("object.pose requires gesture_id as a top-level message");
            var d = Value();
            d["type"] = Type;
            d["gesture_id"] = MsgUtil.LongInteger(GestureId.Value, "object.pose.gesture_id");
            if (Seq.HasValue) d["seq"] = MsgUtil.LongInteger(Seq.Value, "object.pose.seq");
            if (AppliedDeltaId.HasValue) d["applied_delta_id"] = MsgUtil.LongInteger(AppliedDeltaId.Value, "object.pose.applied_delta_id");
            return d;
        }
        public static ObjectPose FromValue(Dictionary<string, object> d)
        {
            RejectProjection(d);
            return new ObjectPose {
            T = MsgUtil.Req3(d, "t", "object.pose"),
            R = MsgUtil.Req3(d, "r", "object.pose"),
            };
        }
        internal static void RejectProjection(Dictionary<string, object> d)
        {
            if (d.ContainsKey("fov") || d.ContainsKey("ortho_extent") || d.ContainsKey("ortho_extent_scale"))
                throw new ArgumentException("object messages cannot contain projection fields");
        }
        public static ObjectPose Unpack(Dictionary<string, object> d)
        {
            var pose = FromValue(d);
            pose.GestureId = MsgUtil.LongInteger(MsgUtil.Req(d, "gesture_id", "object.pose"), "object.pose.gesture_id");
            pose.Seq = d.TryGetValue("seq", out var seq) ? MsgUtil.LongInteger(seq, "object.pose.seq") : (long?)null;
            pose.AppliedDeltaId = d.TryGetValue("applied_delta_id", out var aid) ? MsgUtil.LongInteger(aid, "object.pose.applied_delta_id") : (long?)null;
            return pose;
        }
    }

    public sealed class ObjectDelta : Msg
    {
        public override string Type => "object.delta";
        public long GestureId { get; set; }
        public double[] T { get; set; } = new double[] { 0, 0, 0 };
        public double[] R { get; set; } = new double[] { 0, 0, 0 };
        public long? DeltaId { get; set; }
        public override Dictionary<string, object> Pack()
        {
            var d = new Dictionary<string, object>
            {
                { "type", Type },
                { "gesture_id", MsgUtil.LongInteger(GestureId, "object.delta.gesture_id") },
                { "t", MsgUtil.Vec3(T, "object.delta.t") },
                { "r", MsgUtil.Vec3(R, "object.delta.r") },
            };
            if (DeltaId.HasValue) d["delta_id"] = MsgUtil.LongInteger(DeltaId.Value, "object.delta.delta_id");
            return d;
        }
        public static ObjectDelta Unpack(Dictionary<string, object> d)
        {
            ObjectPose.RejectProjection(d);
            return new ObjectDelta {
            GestureId = MsgUtil.LongInteger(MsgUtil.Req(d, "gesture_id", "object.delta"), "object.delta.gesture_id"),
            T = MsgUtil.Req3(d, "t", "object.delta"), R = MsgUtil.Req3(d, "r", "object.delta"),
            DeltaId = d.TryGetValue("delta_id", out var id) ? MsgUtil.LongInteger(id, "object.delta.delta_id") : (long?)null,
            };
        }
    }

    public sealed class ObjectPivot : Msg
    {
        public override string Type => "object.pivot";
        public long GestureId { get; set; }
        public double[] Point { get; set; } = new double[] { 0, 0, 0 };
        public override Dictionary<string, object> Pack()
        {
            return new Dictionary<string, object>
                { { "type", Type }, { "gesture_id", MsgUtil.LongInteger(GestureId, "object.pivot.gesture_id") }, { "point", MsgUtil.Vec3(Point, "object.pivot.point") } };
        }
        public static ObjectPivot Unpack(Dictionary<string, object> d) => new ObjectPivot
        {
            GestureId = MsgUtil.LongInteger(MsgUtil.Req(d, "gesture_id", "object.pivot"), "object.pivot.gesture_id"),
            Point = MsgUtil.Req3(d, "point", "object.pivot"),
        };
    }

}
