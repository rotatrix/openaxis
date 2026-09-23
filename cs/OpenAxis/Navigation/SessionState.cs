// Serialized stream state only. NavigationSession owns transport, native calls,
// locks and effect dispatch. State implementation remains internal to the SDK.
using System;
using OpenAxis.Geometry;

namespace OpenAxis.Navigation
{
    internal readonly struct SessionToken : IEquatable<SessionToken>
    {
        internal readonly long Epoch, Generation;
        internal SessionToken(long epoch, long generation) { Epoch = epoch; Generation = generation; }
        public bool Equals(SessionToken other) => Epoch == other.Epoch && Generation == other.Generation;
    }

    public readonly struct PoseDifference
    {
        public readonly Vec3 Translation, Rotation;
        public readonly double? Scale;
        public readonly bool Changed, Discontinuity;
        public PoseDifference(Vec3 t, Vec3 r, double? scale, bool changed, bool discontinuity)
        { Translation = t; Rotation = r; Scale = scale; Changed = changed; Discontinuity = discontinuity; }

        public static PoseDifference Compare(CameraPoseValue first, CameraPoseValue second)
            => Compare(first, second, 1e-7, 1e-9, 1e-7, 1e-7);

        public static PoseDifference Compare(CameraPoseValue first, CameraPoseValue second,
            double absolute, double relative, double angular, double projection)
        {
            var t = second.Position - first.Position;
            var q = (Quat.FromRotvec(second.RotationVector.X, second.RotationVector.Y, second.RotationVector.Z)
                * Quat.FromRotvec(first.RotationVector.X, first.RotationVector.Y, first.RotationVector.Z).Inverse())
                .Normalize().ToRotvec();
            var r = new Vec3(q.wx, q.wy, q.wz);
            var discontinuity = first.Fov.HasValue != second.Fov.HasValue;
            if (first.Fov.HasValue && second.Fov.HasValue)
                discontinuity |= Math.Abs(first.Fov.Value - second.Fov.Value) > projection;
            double? scale = null;
            if (first.OrthoExtent.HasValue && second.OrthoExtent.HasValue)
            {
                var ratio = second.OrthoExtent.Value / first.OrthoExtent.Value;
                if (Math.Abs(ratio - 1) > projection) scale = ratio;
            }
            var epsilon = Math.Max(absolute, relative * Math.Max(1, Math.Max(first.Position.Length(), second.Position.Length())));
            return new PoseDifference(t, r, scale,
                t.Length() > epsilon || r.Length() > angular || scale.HasValue, discontinuity);
        }
    }

    internal sealed class AcceptedCameraPose
    {
        internal readonly SessionToken Token;
        internal readonly CameraPoseValue Pose;
        internal readonly long Sequence;
        internal readonly long? AppliedDeltaId;
        internal AcceptedCameraPose(SessionToken token, CameraPoseValue pose, long sequence, long? appliedDeltaId)
        { Token = token; Pose = pose; Sequence = sequence; AppliedDeltaId = appliedDeltaId; }
    }

    internal sealed class CameraWrite
    {
        internal readonly AcceptedCameraPose Accepted;
        internal CameraWrite(AcceptedCameraPose accepted) { Accepted = accepted; }
    }

    internal sealed class SessionEffect
    {
        internal readonly string Kind;
        internal readonly SessionToken? Token;
        internal readonly long? GestureId, DeltaId;
        internal readonly PoseDifference? Difference;
        internal readonly CameraWrite? Write;
        internal readonly string? Reason;
        internal readonly CameraPoseValue? Pose;
        internal SessionEffect(string kind, SessionToken? token = null, long? gestureId = null,
            long? deltaId = null, PoseDifference? difference = null, CameraWrite? write = null, string? reason = null,
            CameraPoseValue? pose = null)
        { Kind = kind; Token = token; GestureId = gestureId; DeltaId = deltaId; Difference = difference; Write = write; Reason = reason; Pose = pose; }
    }

    internal sealed class SessionState
    {
        private readonly Func<CameraPoseValue, CameraPoseValue, PoseDifference> _compare;
        private readonly double _timeout;
        private CameraWrite? _write;
        private long _lastConsumed = -1;
        internal long Epoch { get; private set; }
        internal long Generation { get; private set; }
        internal long? GestureId { get; private set; }
        internal long LastReceived { get; private set; } = -1;
        internal long LastApplied { get; private set; } = -1;
        internal long NextDeltaId { get; private set; }
        internal CameraPoseValue? Baseline { get; private set; }
        // A successful commit with unavailable readback is not an observation.
        // Retain only its requested pose until a real observation can reconcile it.
        private CameraPoseValue? _unobservedWrite;
        internal long? PendingId { get; private set; }
        internal double? Deadline { get; private set; }
        internal bool Ready { get; private set; }
        internal bool Ending { get; private set; }
        internal SessionToken Token => new SessionToken(Epoch, Generation);

        internal SessionState(Func<CameraPoseValue, CameraPoseValue, PoseDifference>? comparison = null, double timeout = 1)
        {
            if (double.IsNaN(timeout) || double.IsInfinity(timeout) || timeout <= 0)
                throw new ArgumentOutOfRangeException(nameof(timeout));
            _compare = comparison ?? PoseDifference.Compare;
            _timeout = timeout;
        }

        internal bool Current(SessionToken token) => token.Equals(Token) && GestureId.HasValue;

        private void Retire()
        {
            Generation++;
            GestureId = null;
            Ready = Ending = false;
            Baseline = null;
            _unobservedWrite = null;
            PendingId = null;
            Deadline = null;
            // Keep an authorized write until its possibly stale completion.
        }

        internal void Connection()
        {
            Retire();
            Epoch++;
            LastReceived = LastApplied = -1;
            _lastConsumed = -1;
            NextDeltaId = 0;
        }

        internal SessionToken Start(long gestureId)
        {
            Retire();
            GestureId = gestureId;
            return Token;
        }

        internal bool End(SessionToken token)
        {
            if (!Current(token)) return false;
            Ending = true;
            return true;
        }

        internal bool Finish(SessionToken token)
        {
            if (!Current(token)) return false;
            Retire();
            return true;
        }

        internal bool CameraQuery(SessionToken token, CameraPoseValue? observation, bool scoped = true, bool supplied = true, bool allowEnding = false)
        {
            if (!scoped || !supplied || !Current(token) || (Ending && !allowEnding) || _write != null) return false;
            if (!Ready) { Ready = true; Baseline = observation; }
            return true;
        }

        internal AcceptedCameraPose? Receive(long epoch, long gestureId, long sequence,
            CameraPoseValue pose, long? appliedDeltaId = null)
        {
            if (epoch != Epoch || !GestureId.HasValue || Ending || gestureId != GestureId
                || sequence <= LastReceived) return null;
            LastReceived = sequence;
            return new AcceptedCameraPose(Token, pose, sequence, appliedDeltaId);
        }

        internal SessionEffect Cancel(SessionToken token, string reason)
        {
            if (!Current(token)) return new SessionEffect("reject");
            var gestureId = GestureId;
            Retire();
            return new SessionEffect("cancel", token, gestureId, reason: reason);
        }

        internal SessionEffect SendFailed(SessionToken token, long deltaId)
        {
            if (!Current(token) || deltaId != PendingId) return new SessionEffect("reject");
            return Cancel(token, "camera_delta_send_failed");
        }

        internal SessionEffect Expire(SessionToken token, long deltaId, double now)
        {
            if (!Current(token) || deltaId != PendingId || !Deadline.HasValue || now < Deadline.Value)
                return new SessionEffect("reject");
            return Cancel(token, "camera_delta_timeout");
        }

        private SessionEffect Delta(CameraPoseValue actual, PoseDifference difference, double now)
        {
            if (NextDeltaId > OpenAxis.Client.Protocol.MaxInteger)
                return Cancel(Token, "camera_delta_id_exhausted");
            _unobservedWrite = null;
            var id = NextDeltaId++;
            PendingId = id;
            Deadline = now + _timeout;
            Baseline = actual;
            return new SessionEffect("delta", Token, GestureId, id, difference);
        }

        private SessionEffect Rebase(CameraPoseValue actual, double now)
        {
            if (Ending) return new SessionEffect("hold");
            var barrier = Delta(actual, new PoseDifference(new Vec3(0, 0, 0), new Vec3(0, 0, 0), null, false, false), now);
            if (barrier.Kind == "cancel") return barrier;
            return new SessionEffect("rebase", Token, GestureId, barrier.DeltaId, barrier.Difference, pose: actual);
        }

        internal SessionEffect Observe(SessionToken token, CameraPoseValue? actual, double now)
        {
            if (!Current(token) || !Ready) return new SessionEffect("reject");
            if (_write != null) return new SessionEffect("hold");
            if (!actual.HasValue) return new SessionEffect("skip");
            var reference = Baseline ?? _unobservedWrite;
            if (!reference.HasValue) { Baseline = actual; return new SessionEffect("skip"); }
            var difference = _compare(reference.Value, actual.Value);
            if (difference.Discontinuity) return Rebase(actual.Value, now);
            if (!difference.Changed)
            {
                if (_unobservedWrite.HasValue) { Baseline = actual; _unobservedWrite = null; }
                return new SessionEffect("skip");
            }
            if (PendingId.HasValue || Ending) return new SessionEffect("hold");
            return Delta(actual.Value, difference, now);
        }

        internal SessionEffect Process(AcceptedCameraPose accepted, CameraPoseValue? actual, double now)
        {
            if (!Current(accepted.Token) || !Ready || accepted.Sequence != LastReceived
                || accepted.Sequence <= _lastConsumed) return new SessionEffect("reject");
            if (_write != null) return new SessionEffect("hold");
            var acknowledged = PendingId.HasValue && accepted.AppliedDeltaId.HasValue
                && accepted.AppliedDeltaId.Value >= PendingId.Value;
            if (acknowledged) { PendingId = null; Deadline = null; }
            var observation = Observe(accepted.Token, actual, now);
            if (observation.Kind != "skip") return observation;
            if (PendingId.HasValue) return new SessionEffect("hold");
            // Reconcile native motion and pending acknowledgements first.
            // Ordinary idle frames can then be consumed without a host commit
            // when the last known realization already matches the request.
            // A known realization can suppress an identical request even when
            // this frame cannot observe. The unobserved-write reference is never
            // eligible: a successful unknown write clears Baseline.
            var realized = actual ?? Baseline;
            if (realized.HasValue)
            {
                var difference = _compare(realized.Value, accepted.Pose);
                if (!difference.Changed && !difference.Discontinuity)
                {
                    _lastConsumed = accepted.Sequence;
                    return new SessionEffect("skip");
                }
            }
            _write = new CameraWrite(accepted);
            return new SessionEffect("apply", Token, GestureId, write: _write);
        }

        internal SessionEffect CompleteWrite(CameraWrite write, CameraPoseValue? actual, double now, bool success = true)
        {
            if (!ReferenceEquals(write, _write)) return new SessionEffect("reject");
            _write = null;
            if (!Current(write.Accepted.Token)) return new SessionEffect("reject");
            if (!success) return Cancel(write.Accepted.Token, "camera_write_failed");
            LastApplied = write.Accepted.Sequence;
            _lastConsumed = write.Accepted.Sequence;
            Baseline = actual;
            _unobservedWrite = actual.HasValue ? null : write.Accepted.Pose;
            if (actual.HasValue && !Ending)
            {
                var difference = _compare(write.Accepted.Pose, actual.Value);
                if (difference.Discontinuity) return Rebase(actual.Value, now);
                if (difference.Changed) return Delta(actual.Value, difference, now);
            }
            return new SessionEffect("skip");
        }
    }
}
