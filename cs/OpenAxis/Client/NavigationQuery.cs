using System;
using System.Collections.Generic;
using System.Threading;

namespace OpenAxis.Client
{
    /// <summary>
    /// A validated <c>navigation.query</c> request delivered by the client runtime.
    /// Evaluate it once on the application thread, then complete or fail it exactly once.
    /// </summary>
    public sealed class NavigationQuery
    {
        /// <summary>Return this sentinel when a requested fact cannot be provided.</summary>
        public static readonly object Unavailable = new object();

        // Pick resolvers may include local markerPosition coordinates. A marker
        // without point is a tested miss, not an available ordered candidate.
        internal static object? WireFactValue(string name, object? value)
        {
            if ((name == "pick.cursor" || name == "pick.viewport_center" || name == "pick.cursor.selection" || name == "pick.viewport_center.selection") && value is IDictionary<string, object> pick)
            {
                if (!pick.TryGetValue("point", out var point) || point == null) return Unavailable;
                var hit = new Dictionary<string, object>(pick);
                hit.Remove("markerPosition");
                return hit;
            }
            return value;
        }

        private readonly Action<Dictionary<string, object>> _complete;
        private readonly Action<string, string?> _fail;
        private int _completed;
        public bool Completed => Volatile.Read(ref _completed) != 0;

        public long RequestId { get; }
        public long? GestureId { get; }
        public string[] Values { get; }
        public string[] First { get; }
        public bool Scoped { get; }
        public bool HasFirst { get; }

        internal NavigationQuery(
            Request request,
            Action<Dictionary<string, object>> complete,
            Action<string, string?> fail)
        {
            if (request == null) throw new ArgumentNullException(nameof(request));
            if (request.Method != "navigation.query")
                throw new ArgumentException("NavigationQuery requires a navigation.query request", nameof(request));

            RequestId = request.Id;
            var parameters = request.Params;
            Scoped = parameters.TryGetValue("gesture_id", out var gesture);
            GestureId = Scoped
                ? MsgUtil.LongInteger(gesture!, "navigation.query.gesture_id")
                : (long?)null;
            Values = parameters.TryGetValue("values", out var values)
                ? MsgUtil.ToStringArray(values)
                : Array.Empty<string>();
            HasFirst = parameters.TryGetValue("first", out var first);
            First = HasFirst
                ? MsgUtil.ToStringArray(first!)
                : Array.Empty<string>();
            _complete = complete ?? throw new ArgumentNullException(nameof(complete));
            _fail = fail ?? throw new ArgumentNullException(nameof(fail));
        }

        /// <summary>
        /// Resolve requested facts synchronously. Each distinct name is resolved at most
        /// once, and ordered <c>first</c> alternatives stop at the first available value.
        /// </summary>
        public Dictionary<string, object> Evaluate(Func<string, object?> resolveFact)
        {
            if (resolveFact == null) throw new ArgumentNullException(nameof(resolveFact));

            var cache = new Dictionary<string, object?>();
            object? Resolve(string name)
            {
                if (!cache.TryGetValue(name, out var value))
                    cache[name] = value = WireFactValue(name, resolveFact(name));
                return value;
            }

            var values = new Dictionary<string, object>();
            foreach (var name in Values)
            {
                var value = Resolve(name);
                if (value != null && !ReferenceEquals(value, Unavailable))
                    values[name] = value;
            }

            var result = new Dictionary<string, object> { { "values", values } };
            if (HasFirst)
            {
                Dictionary<string, object>? selected = null;
                foreach (var name in First)
                {
                    var value = Resolve(name);
                    if (value == null || ReferenceEquals(value, Unavailable)) continue;
                    selected = new Dictionary<string, object>
                    {
                        { "name", name },
                        { "value", value },
                    };
                    break;
                }
                result["first"] = selected!;
            }
            return result;
        }

        public void Complete(Dictionary<string, object> result)
        {
            if (result == null) throw new ArgumentNullException(nameof(result));
            Claim();
            _complete(result);
        }

        public void Fail(string code, string? message = null)
        {
            if (string.IsNullOrWhiteSpace(code))
                throw new ArgumentException("Error code is required", nameof(code));
            Claim();
            _fail(code, message);
        }

        internal void Claim()
        {
            if (Interlocked.Exchange(ref _completed, 1) != 0)
                throw new InvalidOperationException("NavigationQuery has already been completed");
        }
    }
}
