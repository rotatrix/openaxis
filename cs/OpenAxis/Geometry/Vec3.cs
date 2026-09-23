using System;

namespace OpenAxis.Geometry
{
    /// <summary>3D vector with basic linear algebra operations.</summary>
    public readonly struct Vec3
    {
        public readonly double X;
        public readonly double Y;
        public readonly double Z;

        public Vec3(double x, double y, double z) { X = x; Y = y; Z = z; }

        public static Vec3 operator +(Vec3 a, Vec3 b) => new Vec3(a.X + b.X, a.Y + b.Y, a.Z + b.Z);
        public static Vec3 operator -(Vec3 a, Vec3 b) => new Vec3(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
        public static Vec3 operator *(Vec3 v, double s) => new Vec3(v.X * s, v.Y * s, v.Z * s);
        public static Vec3 operator *(double s, Vec3 v) => new Vec3(v.X * s, v.Y * s, v.Z * s);
        public static Vec3 operator -(Vec3 v) => new Vec3(-v.X, -v.Y, -v.Z);

        public double Dot(Vec3 o) => X * o.X + Y * o.Y + Z * o.Z;

        public Vec3 Cross(Vec3 o) => new Vec3(
            Y * o.Z - Z * o.Y,
            Z * o.X - X * o.Z,
            X * o.Y - Y * o.X);

        public double Length() => Math.Sqrt(Dot(this));

        public Vec3 Normalized()
        {
            var n = Length();
            return n > 1e-12 ? new Vec3(X / n, Y / n, Z / n) : new Vec3(0, 0, 0);
        }

        public override string ToString() => $"Vec3({X:G}, {Y:G}, {Z:G})";
    }
}
