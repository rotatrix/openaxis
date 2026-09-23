using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

#if OPENAXIS_EMBEDDED_LOGGER
namespace OpenAxis.EmbeddedDiagnostics
#else
namespace OpenAxis.Diagnostics
#endif
{
    /// <summary>Severity displayed by <see cref="DiagnosticFormatter.FormatLogLine"/>.</summary>
    public enum DiagnosticLevel
    {
        Info,
        Warning,
        Error,
        Debug,
    }

    /// <summary>
    /// Dependency-free formatting for the human-readable OpenAxis diagnostic vocabulary.
    /// This output is intended for support logs, not machine interchange.
    /// </summary>
    public static class DiagnosticFormatter
    {
        private static readonly IReadOnlyDictionary<string, string> PivotLabels =
            new Dictionary<string, string>
            {
                { "locked", "locked pivot" },
                { "selection.viewport-clipped-center", "selection center" },
                { "last-used", "last pivot" },
                { "model.viewport-clipped-center", "model center" },
                { "model.bounds", "model bounds" },
                { "world.origin", "origin" },
                { "query", "queried pick" },
            };

        public static string FormatEvent(
            string name,
            IReadOnlyDictionary<string, object?>? fields = null)
        {
            if (string.IsNullOrWhiteSpace(name))
                throw new ArgumentException("Diagnostic event name is required", nameof(name));
            fields ??= new Dictionary<string, object?>();

            switch (name)
            {
                case "gesture.start":
                    return "motion started" + Context(fields, client: false, request: false);
                case "gesture.end":
                    return "motion ended" + Context(fields, client: false, request: false);
                case "gesture.cancel":
                    return "motion canceled — " + Words(Get(fields, "reason") ?? "unknown reason")
                        + Context(fields, client: false, request: false);
                case "navigation.fact":
                    return FormatFact(fields);
                case "navigation.fact.error":
                    return "  " + Label(Get(fields, "fact") ?? "fact") + " — error: "
                        + Convert.ToString(Get(fields, "error"), CultureInfo.InvariantCulture)
                        + Context(fields, client: false, gesture: false);
                case "navigation.query.complete":
                    return FormatQueryComplete(fields);
                case "navigation.query.rejected":
                    return "query rejected — " + Words(Get(fields, "reason") ?? "unknown reason")
                        + Context(fields);
                case "navigation.query.error":
                    return "query failed — " + (Get(fields, "error") ?? "unknown failure")
                        + Duration(fields) + Context(fields);
                case "navigation.pivot.order":
                    return "pivot order: " + string.Join(" → ", Items(Get(fields, "candidates")).Select(PivotLabel))
                        + Context(fields);
                case "navigation.pivot":
                    return FormatNavigationPivot(fields);
                case "navigation.policy":
                    return FormatNavigationPolicy(fields);
                case "navigation.object.selected":
                    return FormatObjectSelected(fields);
                case "interaction.object.detected":
                    return FormatObjectInteraction(fields);
                case "interaction.object.ended":
                    return "object interaction ended";
                case "camera.external.delta":
                    return FormatExternalCameraDelta(fields);
                case "object.native_override":
                    return "native object motion overridden by Rotatrix"
                        + Context(fields, client: false, request: false);
                case "object.native_override.summary":
                    return "native object motion overridden " + (Get(fields, "count") ?? 0) + " times"
                        + Context(fields, client: false, request: false);
                case "pivot.selection":
                    return FormatPivotSelection(fields);
                case "pivot.selection.item":
                    return FormatPivotSelectionItem(fields);
                case "pivot.pick":
                    return FormatPivotPick(fields);
                case "connection.start":
                    return "connecting to " + Get(fields, "url");
                case "connection.open":
                    return "connected to " + Get(fields, "url") + " · " + Get(fields, "protocol");
                case "connection.stop":
                    return "connection stopped";
                case "connection.lost":
                    return "connection lost" + (IsTrue(Get(fields, "retry")) ? " — retrying" : "");
                case "connection.retry_failed":
                    return "connection failed — " + (Get(fields, "error") ?? "unknown failure")
                        + " · retrying in " + Number(Get(fields, "retry_delay_s") ?? 0) + " s";
                case "command.rejected":
                    return "command rejected: " + Get(fields, "name");
                case "command.error":
                    return "command failed: " + Get(fields, "name") + " — " + Get(fields, "error");
                default:
                    return FormatFallback(name, fields);
            }
        }

        public static string FormatLogLine(
            string message,
            DiagnosticLevel level = DiagnosticLevel.Info,
            DateTime? now = null)
        {
            if (message == null) throw new ArgumentNullException(nameof(message));
            var severity = level switch
            {
                DiagnosticLevel.Info => "",
                DiagnosticLevel.Warning => "WARN ",
                DiagnosticLevel.Error => "ERROR ",
                DiagnosticLevel.Debug => "DEBUG ",
                _ => throw new ArgumentOutOfRangeException(nameof(level)),
            };
            return (now ?? DateTime.Now).ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture)
                + "  " + severity + message;
        }

        private static string FormatFact(IReadOnlyDictionary<string, object?> fields) =>
            "  " + Label(Get(fields, "fact") ?? "fact") + " — " + FactResult(fields) + Duration(fields);

        private static string FactResult(IReadOnlyDictionary<string, object?> fields)
        {
            var result = Convert.ToString(Get(fields, "result"), CultureInfo.InvariantCulture);
            var value = Get(fields, "value");
            var fact = Convert.ToString(Get(fields, "fact"), CultureInfo.InvariantCulture) ?? "";
            if (result == "error") return "error: " + (Get(fields, "error") ?? "unknown failure");
            if (result != "ok") return fact.StartsWith("pick.", StringComparison.Ordinal) ? "miss" : "missing";
            if (TryMapValue(value, "point", out var pointValue) && Point(pointValue) is string point)
                return "hit at " + point + (TryMapValue(value, "bounds", out var bounds) && Bounds(bounds) is string box ? " | bounds " + box : "");
            return value == null ? "found" : "found " + Value(value);
        }

        private static string FormatQueryComplete(IReadOnlyDictionary<string, object?> fields)
        {
            var details = new List<string>();
            var missing = Items(Get(fields, "missing")).Select(Label).ToArray();
            if (missing.Length > 0) details.Add("missing " + string.Join(", ", missing));
            if (Get(fields, "first") is object first) details.Add("first: " + Label(first));
            var text = "query complete";
            if (details.Count > 0) text += " — " + string.Join("; ", details);
            return text + Duration(fields) + Context(fields, client: false, gesture: false, request: true);
        }

        private static string FormatNavigationPivot(IReadOnlyDictionary<string, object?> fields)
        {
            var source = PivotLabel(Get(fields, "source") ?? "pivot");
            var result = Words(Get(fields, "result") ?? "considered");
            var detail = Get(fields, "reason") is object reason ? " — " + Words(reason) : "";
            if (Point(Get(fields, "point")) is string point) detail += " at " + point;
            return "  " + source + " — " + result + detail + Context(fields);
        }

        private static string FormatNavigationPolicy(IReadOnlyDictionary<string, object?> fields)
        {
            var target = Words(Get(fields, "target") ?? "camera");
            var mode = Get(fields, "camera_mode");
            var policy = target == "camera" && mode != null ? Words(mode) + " camera" : target;
            return "navigation: " + policy + Context(fields, request: false);
        }

        private static string FormatObjectSelected(IReadOnlyDictionary<string, object?> fields)
        {
            var actions = new List<string>();
            if (IsTrue(Get(fields, "translation"))) actions.Add("translation");
            if (IsTrue(Get(fields, "rotation"))) actions.Add("rotation");
            var text = "object control: " + string.Join(" + ", actions.Count > 0 ? actions : new[] { "disabled" });
            if (Point(Get(fields, "pivot")) is string pivot) text += " around " + pivot;
            return text + Context(fields);
        }

        private static string FormatObjectInteraction(IReadOnlyDictionary<string, object?> fields)
        {
            var actions = string.Join(" + ", Items(Get(fields, "actions")).Select(Words));
            var text = "object interaction: " + (actions.Length > 0 ? actions : "detected");
            if (Get(fields, "target") is object target) text += " · " + target;
            if (Get(fields, "type") is object type) text += " (" + type + ")";
            if (Get(fields, "unresolved") is object unresolved) text += " — target unavailable: " + Value(unresolved);
            if (Get(fields, "operations") is object operations) text += " · " + Value(operations);
            return text;
        }

        private static string FormatExternalCameraDelta(IReadOnlyDictionary<string, object?> fields)
        {
            var changes = string.Join(" + ", Items(Get(fields, "changes")).Select(Words));
            var details = new List<string>();
            if (Point(Get(fields, "translation")) is string translation) details.Add("translation " + translation);
            if (Point(Get(fields, "rotation")) is string rotation) details.Add("rotation " + rotation);
            if (Get(fields, "ortho_extent_scale") is object scale) details.Add("ortho scale " + Number(scale));
            return "external camera change: " + (changes.Length > 0 ? changes : details.Count > 0 ? string.Join(", ", details) : "observed");
        }

        private static string FormatPivotSelection(IReadOnlyDictionary<string, object?> fields)
        {
            var result = Convert.ToString(Get(fields, "result"), CultureInfo.InvariantCulture);
            if (result == "empty") return "selection — empty";
            if (result == "inspect") return "selection — inspecting " + (Get(fields, "count") ?? 0) + " item(s)";
            return FormatFallback("pivot.selection", fields);
        }

        private static string FormatPivotSelectionItem(IReadOnlyDictionary<string, object?> fields)
        {
            var item = Get(fields, "item");
            var entityType = Get(fields, "type") ?? Get(fields, "entity_type") ?? "entity";
            var identity = Convert.ToString(entityType, CultureInfo.InvariantCulture) ?? "entity";
            if (Get(fields, "id") is object id) identity += " #" + id;
            if (Get(fields, "name") is object name) identity += " " + name;
            var result = Convert.ToString(Get(fields, "result"), CultureInfo.InvariantCulture);
            var text = "  selection " + item + ": " + identity + " — ";
            if (result == "ok") text += "bounds " + (Bounds(Get(fields, "bounds")) ?? "found");
            else if (result == "missing_bounds") text += "missing bounds";
            else if (result == "error") text += "error: " + (Get(fields, "error") ?? "unknown failure");
            else text += Words(result ?? "inspected");

            var extras = new List<string>();
            if (Get(fields, "occurrence") is object occurrence) extras.Add(Convert.ToString(occurrence, CultureInfo.InvariantCulture) ?? "");
            if (Get(fields, "source") is object source) extras.Add(Words(source));
            if (Get(fields, "geometry_type") is object geometryType) extras.Add("geometry " + Words(geometryType));
            if (Get(fields, "native_type") != null || Get(fields, "native_id") != null)
            {
                var native = Convert.ToString(Get(fields, "native_type") ?? entityType, CultureInfo.InvariantCulture) ?? "entity";
                if (Get(fields, "native_id") is object nativeId) native += " #" + nativeId;
                extras.Add("native " + native);
            }
            AddValueDetail(extras, "reported bounds", Get(fields, "reported_bounds"), Bounds);
            AddValueDetail(extras, "native bounds", Get(fields, "native_bounds"), Bounds);
            if (Get(fields, "transform") is object transform) extras.Add("transform " + Value(transform));
            return text + (extras.Count > 0 ? " · " + string.Join(", ", extras) : "");
        }

        private static string FormatPivotPick(IReadOnlyDictionary<string, object?> fields)
        {
            var kind = Words(Get(fields, "kind") ?? "pick");
            var result = Convert.ToString(Get(fields, "result"), CultureInfo.InvariantCulture);
            var outcome = result switch
            {
                "hit" => "hit",
                "outside_selection" => "hit outside selection",
                "miss" => "miss",
                "unavailable" => "unavailable",
                _ => Words(result ?? "complete"),
            };
            if (Point(Get(fields, "point")) is string point) outcome += " at " + point;
            if (Get(fields, "reason") is object reason) outcome += " — " + Words(reason);
            var owner = Get(fields, "type") ?? Get(fields, "entity_type");
            if (owner != null)
            {
                var identity = Convert.ToString(owner, CultureInfo.InvariantCulture) ?? "entity";
                if (Get(fields, "id") is object id) identity += " #" + id;
                if (Get(fields, "occurrence") is object occurrence) identity += " in " + occurrence;
                outcome += " · " + identity;
            }
            if (Bounds(Get(fields, "bounds")) is string bounds) outcome += " · bounds " + bounds;
            return "  " + kind + " pick — " + outcome;
        }

        private static string FormatFallback(string name, IReadOnlyDictionary<string, object?> fields)
        {
            var ignored = new HashSet<string> { "client", "gesture", "request", "delta_id", "seq" };
            var details = fields
                .Where(entry => !ignored.Contains(entry.Key) && entry.Value != null)
                .Select(entry => Words(entry.Key) + ": " + Value(entry.Value))
                .ToArray();
            var result = Words(name.Replace('.', ' '));
            if (details.Length > 0) result += " — " + string.Join("; ", details);
            return result + Context(fields);
        }

        private static string Context(
            IReadOnlyDictionary<string, object?> fields,
            bool client = true,
            bool gesture = true,
            bool request = true)
        {
            var parts = new List<string>();
            if (client && Get(fields, "client") is object clientValue) parts.Add(Convert.ToString(clientValue, CultureInfo.InvariantCulture) ?? "");
            if (gesture && Get(fields, "gesture") is object gestureValue) parts.Add("gesture " + gestureValue);
            if (request && Get(fields, "request") is object requestValue) parts.Add("request " + requestValue);
            return parts.Count > 0 ? " · " + string.Join(", ", parts) : "";
        }

        private static string Duration(IReadOnlyDictionary<string, object?> fields) =>
            Get(fields, "duration_ms") is object duration ? " · " + Number(duration) + " ms" : "";

        private static string PivotLabel(object? value)
        {
            var source = Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
            if (source.StartsWith("query:", StringComparison.Ordinal)) return source.Substring("query:".Length);
            if (source.StartsWith("viewport.center:", StringComparison.Ordinal))
            {
                var depth = source.Substring("viewport.center:".Length);
                if (depth.EndsWith("-depth", StringComparison.Ordinal)) depth = depth.Substring(0, depth.Length - "-depth".Length);
                return "viewport center (" + Words(depth) + " depth)";
            }
            return PivotLabels.TryGetValue(source, out var label) ? label : Words(source.Replace('.', ' '));
        }

        private static string Value(object? value)
        {
            if (Point(value) is string point) return point;
            if (Bounds(value) is string bounds) return bounds;
            if (value == null) return "missing";
            if (value is bool boolean) return boolean ? "yes" : "no";
            if (IsNumber(value)) return Number(value);
            if (value is string text) return text;
            if (TryEntries(value, out var entries))
                return string.Join("; ", entries.Where(entry => entry.Value != null).Select(entry => Words(entry.Key) + ": " + Value(entry.Value)));
            if (value is IEnumerable) return string.Join(", ", Items(value).Select(Value));
            return Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
        }

        private static string? Point(object? value)
        {
            var items = Items(value).ToArray();
            if (items.Length != 3 || items.Any(item => item == null || !IsNumber(item))) return null;
            return "(" + string.Join(", ", items.Select(Number)) + ")";
        }

        private static string? Bounds(object? value)
        {
            if (!TryMapValue(value, "min", out var minimumValue) || !TryMapValue(value, "max", out var maximumValue)) return null;
            var minimum = Point(minimumValue);
            var maximum = Point(maximumValue);
            return minimum != null && maximum != null ? minimum + " … " + maximum : null;
        }

        private static string Number(object? value)
        {
            if (value is bool boolean) return boolean ? "yes" : "no";
            if (value == null || !IsNumber(value)) return Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
            var number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
            return double.IsNaN(number) || double.IsInfinity(number)
                ? number.ToString(CultureInfo.InvariantCulture)
                : number.ToString("F3", CultureInfo.InvariantCulture);
        }

        private static string Words(object? value) =>
            (Convert.ToString(value, CultureInfo.InvariantCulture) ?? "").Replace('_', ' ').Replace('-', ' ');

        private static string Label(object? value) => Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";

        private static object? Get(IReadOnlyDictionary<string, object?> fields, string name) =>
            fields.TryGetValue(name, out var value) ? value : null;

        private static bool IsTrue(object? value) => value is bool boolean && boolean;

        private static bool IsNumber(object value) =>
            value is sbyte || value is byte || value is short || value is ushort
            || value is int || value is uint || value is long || value is ulong
            || value is float || value is double || value is decimal;

        private static IEnumerable<object?> Items(object? value)
        {
            if (value is string || value is IDictionary || value is not IEnumerable enumerable) yield break;
            foreach (var item in enumerable) yield return item;
        }

        private static bool TryMapValue(object? value, string key, out object? result)
        {
            if (value is IReadOnlyDictionary<string, object?> readonlyMap && readonlyMap.TryGetValue(key, out result)) return true;
            if (value is IDictionary map && map.Contains(key))
            {
                result = map[key];
                return true;
            }
            result = null;
            return false;
        }

        private static bool TryEntries(object value, out IEnumerable<KeyValuePair<string, object?>> entries)
        {
            if (value is IReadOnlyDictionary<string, object?> readonlyMap)
            {
                entries = readonlyMap;
                return true;
            }
            if (value is IDictionary map)
            {
                var converted = new List<KeyValuePair<string, object?>>();
                foreach (DictionaryEntry entry in map)
                    if (entry.Key is string key) converted.Add(new KeyValuePair<string, object?>(key, entry.Value));
                entries = converted;
                return true;
            }
            entries = Array.Empty<KeyValuePair<string, object?>>();
            return false;
        }

        private static void AddValueDetail(
            ICollection<string> details,
            string label,
            object? value,
            Func<object?, string?> specialized)
        {
            if (value != null) details.Add(label + " " + (specialized(value) ?? Value(value)));
        }
    }
}
