using System.Text.Json;
using OpenAxis.Geometry;
using OpenAxis.Navigation;

namespace OpenAxisDemo;

// Renderer-neutral triangles generated from the seed-123 TypeScript scene.
public sealed class DemoScene
{
    public int Seed { get; set; }
    public CameraData Camera { get; set; } = new();
    public double OrthoExtent { get; set; }
    public GroundData Ground { get; set; } = new();
    public Item[] Objects { get; set; } = [];
    public static DemoScene Load(string resource = "scene.json")
    {
        using var stream = typeof(DemoScene).Assembly.GetManifestResourceStream(resource)!;
        return JsonSerializer.Deserialize<DemoScene>(stream, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
    }
    public sealed class CameraData
    {
        public double[] T { get; set; } = [];
        public double[] R { get; set; } = [];
        public double Fov { get; set; }
        public CameraPoseValue Pose => new(Vector(T), Vector(R), fov: Fov);
    }
    public sealed class GroundData { public double Size { get; set; } public double Step { get; set; } public double Y { get; set; } }
    public sealed class Item
    {
        public string Name { get; set; } = "";
        public int Color { get; set; }
        public double[] Position { get; set; } = [];
        public double[] Rotation { get; set; } = [];
        public double[] Vertices { get; set; } = [];
        public double[] Normals { get; set; } = [];
        public double[] Uv { get; set; } = [];
        public int[] Indices { get; set; } = [];
        public ObjectPoseValue Pose => new(Vector(Position), Vector(Rotation));

    }
    static Vec3 Vector(double[] value) => new(value[0], value[1], value[2]);
}
