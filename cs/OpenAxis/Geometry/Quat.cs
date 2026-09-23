using System;

namespace OpenAxis.Geometry
{
    /// <summary>Unit quaternion (W, X, Y, Z) representing a rotation.</summary>
    public readonly struct Quat
    {
        public readonly double W;
        public readonly double X;
        public readonly double Y;
        public readonly double Z;

        public Quat(double w, double x, double y, double z) { W = w; X = x; Y = y; Z = z; }

        public static Quat Identity => new Quat(1, 0, 0, 0);

        /// <summary>Hamilton product.</summary>
        public static Quat operator *(Quat a, Quat b) => new Quat(
            a.W * b.W - a.X * b.X - a.Y * b.Y - a.Z * b.Z,
            a.W * b.X + a.X * b.W + a.Y * b.Z - a.Z * b.Y,
            a.W * b.Y - a.X * b.Z + a.Y * b.W + a.Z * b.X,
            a.W * b.Z + a.X * b.Y - a.Y * b.X + a.Z * b.W);

        public Quat Normalize()
        {
            var n = Math.Sqrt(W * W + X * X + Y * Y + Z * Z);
            return n < 1e-12 ? Identity : new Quat(W / n, X / n, Y / n, Z / n);
        }

        /// <summary>Return the inverse of this rotation.</summary>
        public Quat Inverse()
        {
            var q = Normalize();
            return new Quat(q.W, -q.X, -q.Y, -q.Z);
        }

        /// <summary>Sandwich product q v q*.</summary>
        public Vec3 Rotate(Vec3 v)
        {
            // Optimized: t = 2*(q_xyz x v), result = v + w*t + q_xyz x t
            var qv = new Vec3(X, Y, Z);
            var t = 2.0 * qv.Cross(v);
            return v + W * t + qv.Cross(t);
        }

        /// <summary>SO(3) exponential map: rotation vector -> unit quaternion.</summary>
        public static Quat FromRotvec(double wx, double wy, double wz)
        {
            var theta = Math.Sqrt(wx * wx + wy * wy + wz * wz);
            if (theta < 1e-10)
                return new Quat(1.0, wx * 0.5, wy * 0.5, wz * 0.5).Normalize();
            var half = theta * 0.5;
            var s = Math.Sin(half) / theta;
            return new Quat(Math.Cos(half), wx * s, wy * s, wz * s);
        }

        /// <summary>
        /// Rotation matrix columns -> quaternion (Shepperd's method).
        /// Matrix is [right | up | backward] where each is a column.
        /// </summary>
        public static Quat FromAxes(Vec3 right, Vec3 up, Vec3 backward)
        {
            double m00 = right.X,    m01 = up.X,    m02 = backward.X;
            double m10 = right.Y,    m11 = up.Y,    m12 = backward.Y;
            double m20 = right.Z,    m21 = up.Z,    m22 = backward.Z;
            var tr = m00 + m11 + m22;

            if (tr > 0)
            {
                var s = 0.5 / Math.Sqrt(tr + 1.0);
                return new Quat(0.25 / s, (m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s);
            }
            else if (m00 > m11 && m00 > m22)
            {
                var s = 2.0 * Math.Sqrt(1.0 + m00 - m11 - m22);
                return new Quat((m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s);
            }
            else if (m11 > m22)
            {
                var s = 2.0 * Math.Sqrt(1.0 + m11 - m00 - m22);
                return new Quat((m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s);
            }
            else
            {
                var s = 2.0 * Math.Sqrt(1.0 + m22 - m00 - m11);
                return new Quat((m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s);
            }
        }

        /// <summary>SO(3) logarithmic map: unit quaternion -> rotation vector.</summary>
        public (double wx, double wy, double wz) ToRotvec()
        {
            // Ensure positive hemisphere for unique rotation vector
            var q = W >= 0 ? this : new Quat(-W, -X, -Y, -Z);
            var vLen = Math.Sqrt(q.X * q.X + q.Y * q.Y + q.Z * q.Z);
            if (vLen < 1e-10)
                return (0.0, 0.0, 0.0);
            var angle = 2.0 * Math.Atan2(vLen, q.W);
            var s = angle / vLen;
            return (q.X * s, q.Y * s, q.Z * s);
        }

        /// <summary>Spherical linear interpolation.</summary>
        public Quat Slerp(Quat other, double t)
        {
            var dot = W * other.W + X * other.X + Y * other.Y + Z * other.Z;
            if (dot < 0)
            {
                other = new Quat(-other.W, -other.X, -other.Y, -other.Z);
                dot = -dot;
            }
            if (dot > 0.9995)
            {
                return new Quat(
                    W + t * (other.W - W),
                    X + t * (other.X - X),
                    Y + t * (other.Y - Y),
                    Z + t * (other.Z - Z)).Normalize();
            }
            var theta = Math.Acos(Math.Min(dot, 1.0));
            var sinTheta = Math.Sin(theta);
            var a = Math.Sin((1.0 - t) * theta) / sinTheta;
            var b = Math.Sin(t * theta) / sinTheta;
            return new Quat(
                a * W + b * other.W,
                a * X + b * other.X,
                a * Y + b * other.Y,
                a * Z + b * other.Z);
        }

        public override string ToString() => $"Quat({W:G}, {X:G}, {Y:G}, {Z:G})";
    }
}
