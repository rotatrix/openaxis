using System.Collections.Concurrent;
using System.Numerics;
using OpenAxis.Diagnostics;
using OpenAxis.Geometry;
using OpenAxis.Navigation;
using Raylib_cs;

namespace OpenAxisDemo;

public readonly record struct Point(double X, double Y)
{
    public static Point operator -(Point a, Point b) => new(a.X-b.X, a.Y-b.Y);
    public double LengthSquared => X*X + Y*Y;
}
public readonly record struct Rect3D(double X, double Y, double Z, double SizeX, double SizeY, double SizeZ);
public enum MouseButton { Left, Middle, Right }
public enum Key { R, O, Enter, Escape, U, F, D }

// Network callbacks and async continuations return to the owning frame thread.
public sealed class FrameDispatcher : SynchronizationContext
{
    readonly ConcurrentQueue<Action> pending = new();
    public void BeginInvoke(Action callback) => pending.Enqueue(callback);
    public override void Post(SendOrPostCallback callback, object? state) => BeginInvoke(() => callback(state));
    public void Drain() { while (pending.TryDequeue(out var callback)) callback(); }
}

public sealed partial class MyApplication
{
    Font uiFont;
    bool ownsUiFont;
    float fontHeightPerEm;
    public void Tick() { Dispatcher.Drain(); Rendering?.Invoke(this, EventArgs.Empty); }
    public void Await(Task task)
    {
        while (!task.IsCompleted) { Tick(); Thread.Sleep(1); }
        task.GetAwaiter().GetResult();
    }
    public void OpenWindow()
    {
        Raylib.SetConfigFlags(ConfigFlags.ResizableWindow | ConfigFlags.Msaa4xHint | ConfigFlags.HighDpiWindow);
        Raylib.InitWindow(960, 720, "OpenAxis C# demo - raylib");
        Raylib.SetExitKey(KeyboardKey.Null); // Escape cancels editing.
        Raylib.SetTargetFPS(60);
        var codepoints = Enumerable.Range(32, 224).Concat(new[] { 0x2013, 0x2014, 0x2022, 0x2192 }).ToArray();
        if (UiFont.Find() is { } font)
        {
            fontHeightPerEm = font.HeightPerEm;
            uiFont = Raylib.LoadFontEx(font.Path, 32, codepoints, codepoints.Length);
            ownsUiFont = uiFont.Texture.Id != Raylib.GetFontDefault().Texture.Id;
        }
        else uiFont = Raylib.GetFontDefault();
        if (ownsUiFont) Raylib.SetTextureFilter(uiFont.Texture, TextureFilter.Bilinear);
        else
        {
            fontHeightPerEm = 1;
            Console.WriteLine("No usable system font found; using raylib's built-in bitmap font.");
        }
    }
    public void CloseWindow()
    {
        if (ownsUiFont) Raylib.UnloadFont(uiFont);
        Raylib.CloseWindow();
    }
    void DrawText(string text, int x, int y, int size, Color color)
    {
        // Explicit line spacing keeps help and diagnostics consistent at each size.
        foreach (var line in text.Split('\n'))
        {
            Raylib.DrawTextEx(uiFont, line, new Vector2(x, y), size * fontHeightPerEm, 0, color);
            y += size + 4;
        }
    }
    int DrawHelpRow(string heading, string content, int y)
    {
        DrawText(heading, 30, y, 17, new Color(102, 204, 255, 255));
        float width = Math.Max(1, Raylib.GetScreenWidth() - 170);
        foreach (var paragraph in content.Split('\n'))
        {
            string line = "";
            foreach (var word in paragraph.Split(' '))
            {
                string candidate = line.Length == 0 ? word : line + " " + word;
                if (line.Length > 0 && Raylib.MeasureTextEx(uiFont, candidate, 16 * fontHeightPerEm, 0).X > width)
                {
                    DrawText(line, 150, y, 16, Color.White);
                    y += 20;
                    line = word;
                }
                else line = candidate;
            }
            DrawText(line, 150, y, 16, Color.White);
            y += 20;
        }
        return y + 12;
    }
    public void PollInput()
    {
        Resize(Raylib.GetScreenWidth(), Raylib.GetScreenHeight());
        bool focused = Raylib.IsWindowFocused();
        if (focused != IsActive) { IsActive = focused; if (!focused) EndDrag(); FocusChanged(); }
        var mouse = Raylib.GetMousePosition(); var pixel = new Point(mouse.X, mouse.Y);
        Cursor = focused && Raylib.IsCursorOnScreen() ? pixel : null;
        if (!focused) return;
        foreach (var (native, button) in new[] { (Raylib_cs.MouseButton.Left, MouseButton.Left), (Raylib_cs.MouseButton.Middle, MouseButton.Middle), (Raylib_cs.MouseButton.Right, MouseButton.Right) })
        {
            if (Raylib.IsMouseButtonPressed(native)) PointerDown(button, pixel);
            if (Raylib.IsMouseButtonReleased(native)) PointerUp(button, pixel);
        }
        PointerMove(pixel, Raylib.IsKeyDown(KeyboardKey.LeftShift) || Raylib.IsKeyDown(KeyboardKey.RightShift));
        double wheel = Raylib.GetMouseWheelMove(); if (wheel != 0) Wheel(wheel);
        foreach (var key in Enum.GetValues<Key>())
            if (Raylib.IsKeyPressed(Enum.Parse<KeyboardKey>(key.ToString()))) HandleKey(key);
    }
    static Vector3 Vector(Vec3 v) => new((float)v.X, (float)v.Y, (float)v.Z);
    static Vector2 Pixel(Point p) => new((float)p.X, (float)p.Y);
    public void Draw()
    {
        Raylib.BeginDrawing();
        Raylib.ClearBackground(new Color(20, 31, 46, 255));
        var (eye, target, up) = PoseHelpers.LookAtFromPose(Camera);
        // raylib uses vertical degrees for perspective and vertical world span for ortho.
        var camera = new Camera3D(Vector(eye), Vector(target), Vector(up),
            (float)(Camera.OrthoExtent ?? Camera.Fov!.Value * 180 / Math.PI),
            Camera.OrthoExtent.HasValue ? CameraProjection.Orthographic : CameraProjection.Perspective);
        Rlgl.SetClipPlanes(NearPlane, FarPlane);
        Raylib.BeginMode3D(camera);
        Rlgl.DisableBackfaceCulling();
        double extent = data.Ground.Size / 2, y = data.Ground.Y;
        for (double i = -extent; i <= extent; i += data.Ground.Step)
        {
            var color = i == 0 || Math.Abs(i) == extent ? new Color(107, 122, 143, 255) : new Color(61, 77, 94, 255);
            Raylib.DrawLine3D(Vector(new(i,y,-extent)), Vector(new(i,y,extent)), color);
            Raylib.DrawLine3D(Vector(new(-extent,y,i)), Vector(new(extent,y,i)), color);
        }
        // Shared triangle geometry, with smooth per-vertex diffuse lighting.
        Rlgl.Begin(DrawMode.Triangles);
        for (int i = 0; i < poses.Count; i++)
        {
            var item = data.Objects[i]; var color = ObjectColor(i); var rotation = Rotation(poses[i].RotationVector);
            foreach (int v in item.Indices)
            {
                var normal = rotation.Rotate(new Vec3(item.Normals[v*3], item.Normals[v*3+1], item.Normals[v*3+2]));
                double light = Math.Clamp(.45 + .7 * Math.Max(0, normal.Dot(new Vec3(1,2,3).Normalized())), 0, 1);
                Rlgl.Color4ub((byte)(color.R*light), (byte)(color.G*light), (byte)(color.B*light), 255);
                var p = WorldVertex(i,v); Rlgl.Vertex3f((float)p.X, (float)p.Y, (float)p.Z);
            }
        }
        Rlgl.End();
        DrawPivots();
        Raylib.EndMode3D();
        DrawText(Operation == null ? "" : "EDITING OBJECT", 30, 20, 18, new Color(255,89,217,255));
        int helpBottom = DrawHelpRow("MOUSE", MouseHelpText, 50);
        helpBottom = DrawHelpRow("KEYBOARD", KeyboardHelpText, helpBottom);
        helpBottom = DrawHelpRow("ROTATRIX:", StatusText, helpBottom);
        DrawDiagnostics(Math.Max(300, helpBottom));
        Raylib.EndDrawing();
    }
    void DrawPivots()
    {
        // Flush before changing depth state; keep scene depth intact for the visible pass.
        Rlgl.DrawRenderBatchActive(); Rlgl.DisableDepthMask();
        Rlgl.DisableDepthTest();
        Discs(80);
        Rlgl.DrawRenderBatchActive(); Rlgl.EnableDepthTest();
        Discs(255);
        Rlgl.DrawRenderBatchActive(); Rlgl.EnableDepthMask();
    }
    void Discs(byte alpha)
    {
        var rotation = Rotation(Camera.RotationVector);
        foreach (var pivot in new[] { Pivot, ObjectPivot })
        if (pivot is Vec3 point && Project(point) != null)
        {
            double scale = (Camera.OrthoExtent ?? -2 * CameraLocal(point).Z * Math.Tan(Camera.Fov!.Value / 2)) / ViewHeight;
            var right = rotation.Rotate(new Vec3(1,0,0)); var up = rotation.Rotate(new Vec3(0,1,0));
            for (int i = 0; i < 32; i++)
            {
                Vec3 Edge(double radius, double angle) => point + (right * Math.Cos(angle) + up * Math.Sin(angle)) * (radius * scale);
                double a = i*Math.Tau/32, b = (i+1)*Math.Tau/32;
                var innerA = Vector(Edge(4,a)); var innerB = Vector(Edge(4,b));
                var outerA = Vector(Edge(5.5,a)); var outerB = Vector(Edge(5.5,b));
                var black = new Color(0,0,0,(int)alpha);
                Raylib.DrawTriangle3D(Vector(point), innerA, innerB, new Color(0,255,0,(int)alpha));
                Raylib.DrawTriangle3D(innerA, outerA, outerB, black);
                Raylib.DrawTriangle3D(innerA, outerB, innerB, black);
            }
        }
    }
    static Color Tone(string tone, double opacity = 1)
    {
        var rgb = DiagnosticPalette.Color(tone);
        return new Color((byte)rgb[0], (byte)rgb[1], (byte)rgb[2], (byte)(255*opacity));
    }
    void DrawDiagnostics(int textY)
    {
        var frame = diagnosticFrame;
        if (frame == null || (frame.Context != null && !ReferenceEquals(frame.Context, this))) return;
        int row = 0;
        foreach (var line in frame.Lines) DrawText(line.Text, 30, textY + row++*18, 14, Tone(line.Tone));
        foreach (var segment in frame.Segments)
        {
            var a = segment.Start; var b = segment.End;
            if (ClipSegment(ref a, ref b) && Project(a) is Point start && Project(b) is Point end)
                Raylib.DrawLineEx(Pixel(start), Pixel(end), (float)segment.Width, Tone(segment.Tone, segment.Opacity));
        }
        foreach (var marker in frame.Markers)
        {
            int x = (int)marker.X, y = (int)marker.Y;
            Raylib.DrawLine(x-7,y,x+7,y,Tone(marker.Tone,.65)); Raylib.DrawLine(x,y-7,x,y+7,Tone(marker.Tone,.65));
            DrawText(marker.Name,x+12,y-8,14,Tone(marker.Tone));
        }
    }
}
