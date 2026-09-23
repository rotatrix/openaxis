using System;

namespace OpenAxis.Geometry
{
    /// <summary>
    /// Protocol-neutral camera pose value used by the geometry conversion helpers.
    /// Position and rotation are expressed in the caller's world coordinates.
    /// </summary>
    public readonly struct CameraPoseValue
    {
        public Vec3 Position { get; }
        public Vec3 RotationVector { get; }
        public double? Fov { get; }
        public double? OrthoExtent { get; }

        public CameraPoseValue(
            Vec3 position,
            Vec3 rotationVector,
            double? fov = null,
            double? orthoExtent = null)
        {
            if (fov.HasValue && orthoExtent.HasValue)
                throw new ArgumentException("A camera pose value cannot contain both perspective and orthographic projection");
            if (fov.HasValue && (!IsFinite(fov.Value) || fov.Value <= 0))
                throw new ArgumentOutOfRangeException(nameof(fov), "FOV must be positive and finite");
            if (orthoExtent.HasValue && (!IsFinite(orthoExtent.Value) || orthoExtent.Value <= 0))
                throw new ArgumentOutOfRangeException(nameof(orthoExtent), "Orthographic extent must be positive and finite");
            if (!IsFinite(position) || !IsFinite(rotationVector))
                throw new ArgumentException("Camera position and rotation vector must be finite");

            Position = position;
            RotationVector = rotationVector;
            Fov = fov;
            OrthoExtent = orthoExtent;
        }

        private static bool IsFinite(Vec3 value) =>
            IsFinite(value.X) && IsFinite(value.Y) && IsFinite(value.Z);

        private static bool IsFinite(double value) =>
            !double.IsNaN(value) && !double.IsInfinity(value);
    }

    /// <summary>
    /// Helpers for converting between eye/target/up camera representations
    /// and the OpenAxis wire format (position + rotation vector).
    ///
    /// The semantic camera frame is right-handed: +Z is backward (away from
    /// target), +Y is up, and +X is right. In a left-handed client world the
    /// pose rotation is the proper factor of that frame; world.orientation
    /// carries the reflection separately. These eye/target/up helpers produce
    /// that factor without requiring a handedness argument.
    /// </summary>
    public static class PoseHelpers
    {
        /// <summary>Convert eye/target/up camera to a position and rotation-vector pose.</summary>
        public static CameraPoseValue PoseFromLookAt(
            Vec3 eye, Vec3 target, Vec3 up,
            double? fov = null, double? orthoExtent = null)
        {
            var backward = (eye - target).Normalized();
            var distance = (eye - target).Length();
            if (distance < 1e-12)
            {
                return new CameraPoseValue(eye, new Vec3(0, 0, 0), fov, orthoExtent);
            }

            var right = up.Cross(backward).Normalized();
            if (right.Length() < 1e-6)
            {
                var fallback = Math.Abs(up.Y) > 0.9 ? new Vec3(1, 0, 0) : new Vec3(0, 1, 0);
                right = fallback.Cross(backward).Normalized();
            }
            var upOrtho = backward.Cross(right).Normalized();

            var q = Quat.FromAxes(right, upOrtho, backward).Normalize();
            var rv = q.ToRotvec();

            return new CameraPoseValue(
                eye,
                new Vec3(rv.wx, rv.wy, rv.wz),
                fov,
                orthoExtent);
        }

        /// <summary>
        /// Convert a position and rotation-vector pose to eye/target/up vectors.
        /// If pivot is given, computes target distance from (eye-pivot).backward.
        /// </summary>
        public static (Vec3 eye, Vec3 target, Vec3 up) LookAtFromPose(
            CameraPoseValue pose,
            double defaultDistance = 10.0,
            Vec3? pivot = null)
        {
            var rotation = pose.RotationVector;
            var q = Quat.FromRotvec(rotation.X, rotation.Y, rotation.Z);
            var eye = pose.Position;
            var up = q.Rotate(new Vec3(0, 1, 0));
            var backward = q.Rotate(new Vec3(0, 0, 1));

            double distance;
            if (pivot != null)
            {
                var depth = (eye - pivot.Value).Dot(backward);
                distance = Math.Max(depth, 0.01);
            }
            else
            {
                distance = defaultDistance;
            }

            var target = eye - backward * distance;
            return (eye, target, up);
        }
    }
}
