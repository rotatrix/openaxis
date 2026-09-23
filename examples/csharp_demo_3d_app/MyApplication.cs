using System.Diagnostics;
using Raylib_cs;
using OpenAxis.Diagnostics;
using OpenAxis.Geometry;
using OpenAxis.Navigation;

namespace OpenAxisDemo;

// Native application API. Networking and session ownership live in MyOpenAxisIntegration.cs.
public sealed partial class MyApplication
{
    readonly List<ObjectPoseValue> poses = new();
    readonly Stack<(int Index, ObjectPoseValue Pose)> undo = new();
    DiagnosticPresentation? diagnosticFrame;
    bool diagnosticsEnabled;
    string connectionStatus = "Connecting...";
    Point? previous;
    Vec3 dragCenter;
    MouseButton dragButton;
    (MouseButton Button, Point Pixel, Edit Operation)? editClick;
    (int Index, double Time, Point Pixel)? lastClick;
    ObjectPoseValue editStart;
    public sealed record Edit(int Index);
    public Edit? Operation { get; private set; }
    public int Selected { get; private set; } = -1;
    public bool Alive { get; set; } = true;
    public CameraPoseValue Camera { get; private set; } = InitialCamera;
    public bool FreeCamera { get; private set; }
    public Action NavigationChanged = () => { };
    public Action CameraChanged = () => { }, ObjectChanged = () => { }, ContextChanged = () => { }, FocusChanged = () => { }, ToggleDiagnostics = () => { };
    public Vec3? Pivot { get; private set; }
    public Vec3? ObjectPivot { get; private set; }
    public string StatusText { get; private set; } = "";
    public string MouseHelpText { get; private set; } = "";
    public string KeyboardHelpText { get; private set; } = "";
    public bool DiagnosticsEnabled => diagnosticsEnabled;
    public DiagnosticPresentation? DiagnosticFrame => diagnosticFrame;
    readonly DemoScene data;
    static readonly DemoScene DefaultScene = DemoScene.Load();
    public static CameraPoseValue InitialCamera => DefaultScene.Camera.Pose;
    public static readonly Rect3D GroundBounds = new(-DefaultScene.Ground.Size/2, DefaultScene.Ground.Y,
        -DefaultScene.Ground.Size/2, DefaultScene.Ground.Size, 0, DefaultScene.Ground.Size);
    public double ViewWidth { get; private set; } = 900;
    public double ViewHeight { get; private set; } = 600;
    public double NearPlane { get; private set; } = .01;
    public double FarPlane { get; private set; } = 10000;
    public bool IsActive { get; private set; }
    public Point? Cursor { get; private set; }
    public readonly FrameDispatcher Dispatcher = new();
    public event EventHandler? Rendering;
    public MyApplication(DemoScene? sceneData = null)
    {
        data = sceneData ?? DefaultScene;
        foreach (var item in data.Objects) poses.Add(item.Pose);
        ResetCamera(); UpdateSelection();
    }
    public void Resize(double width, double height)
    { ViewWidth = Math.Max(1, width); ViewHeight = Math.Max(1, height); UpdateLens(); }
    public void Close() { Alive = false; }
    ObjectPoseValue InitialObject(int index) => data.Objects[index].Pose;
    public void ResetCamera() => SetCamera(data.Camera.Pose);
    public void ResetScene()
    {
        EndDrag(); FinishEdit(false);
        for (int i = 0; i < poses.Count; i++) SetObject(i, InitialObject(i));
        undo.Clear(); Selected = -1; lastClick = null; UpdateSelection(); ResetCamera(); CameraChanged();
    }
    public void ToggleProjection()
    {
        SetCamera(new CameraPoseValue(Camera.Position, Camera.RotationVector,
            Camera.OrthoExtent.HasValue ? data.Camera.Fov : null, Camera.OrthoExtent.HasValue ? null : data.OrthoExtent));
        CameraChanged();
    }
    public void HandleKey(Key key)
    {
        switch (key)
        {
            case Key.R: ResetScene(); break;
            case Key.O: ToggleProjection(); break;
            case Key.Enter:
                lastClick = null; EndDrag();
                if (Operation == null) BeginEdit(); else FinishEdit(true);
                break;
            case Key.Escape: FinishEdit(false); break;
            case Key.U: UndoEdit(); break;
            case Key.F: FreeCamera = !FreeCamera; NavigationChanged(); UpdateStatus(); break;
            case Key.D: ToggleDiagnostics(); break;
        }
    }
    public void SetCamera(CameraPoseValue pose)
    {
        Camera = pose; UpdateLens(); UpdateStatus();
    }
    void UpdateLens()
    {
        NearPlane = .01; FarPlane = 10000;
        if (Camera.OrthoExtent.HasValue)
        {
            var points = Enumerable.Range(0, poses.Count).SelectMany(i => Corners(Bounds(i))).Concat(Corners(GroundBounds));
            if (diagnosticFrame?.Context is null || ReferenceEquals(diagnosticFrame.Context, this))
                points = points.Concat(diagnosticFrame?.Segments.SelectMany(s => new[] { s.Start, s.End }) ?? Enumerable.Empty<Vec3>());
            var depths = points.Select(p => -CameraLocal(p).Z).ToArray();
            double margin = Math.Max(1, (depths.Max() - depths.Min()) * .1);
            NearPlane = depths.Min() - margin; FarPlane = depths.Max() + margin;
        }
    }
    public void BeginEdit()
    {
        if (Selected < 0 || Operation != null) return;
        EndDrag(); Operation = new Edit(Selected); editStart = poses[Selected]; ContextChanged(); UpdateSelection();
    }
    public void FinishEdit(bool accept)
    {
        EndDrag(); lastClick = null;
        if (Operation is not Edit edit) return;
        Operation = null;
        if (accept) { undo.Push((edit.Index, editStart)); }
        else SetObject(edit.Index, editStart);
        Selected = -1;
        ContextChanged(); UpdateSelection();
    }
    public void UndoEdit()
    {
        if (Operation != null) FinishEdit(false);
        else if (undo.TryPop(out var item)) SetObject(item.Index, item.Pose);
    }
    public void Select(int index)
    {
        if (index < -1 || index >= poses.Count) throw new ArgumentOutOfRangeException(nameof(index));
        if (Operation != null) return;
        Selected = index; UpdateSelection();
    }
    void UpdateSelection()
    {
        MouseHelpText = Operation == null
            ? "Click: Select    Double-click: Edit\nLeft-drag: Pan    Middle/Right-drag: Rotate (Shift to swap)    Wheel: Zoom"
            : "Left-click: Accept    Right-click: Cancel\nLeft-drag: Translate    Middle/Right-drag: Rotate (Shift to swap)    Wheel: Depth";
        UpdateStatus();
    }
    public Color ObjectColor(int index)
    {
        int rgb = Operation?.Index == index ? 0xff40bf : Selected == index ? 0xffd94d : data.Objects[index].Color;
        return new Color((byte)(rgb >> 16), (byte)(rgb >> 8), (byte)rgb, (byte)255);
    }
    public ObjectPoseValue GetObject(int index) => poses[index];
    public void SetObject(int index, ObjectPoseValue pose) { poses[index] = pose; UpdateLens(); }
    Vec3 WorldVertex(int index, int vertex)
    {
        var v = data.Objects[index].Vertices; var pose = poses[index];
        return pose.Position + Rotation(pose.RotationVector).Rotate(new Vec3(v[vertex*3], v[vertex*3+1], v[vertex*3+2]));
    }
    public Rect3D Bounds(int? index = null)
    {
        var points = (index.HasValue ? new[] { index.Value } : Enumerable.Range(0, poses.Count))
            .SelectMany(i => Enumerable.Range(0, data.Objects[i].Vertices.Length / 3).Select(v => WorldVertex(i, v))).ToArray();
        double x = points.Min(p => p.X), y = points.Min(p => p.Y), z = points.Min(p => p.Z);
        return new(x, y, z, points.Max(p => p.X)-x, points.Max(p => p.Y)-y, points.Max(p => p.Z)-z);
    }
    static Vec3 Center(Rect3D bounds) => new(bounds.X + bounds.SizeX / 2, bounds.Y + bounds.SizeY / 2, bounds.Z + bounds.SizeZ / 2);
    static IEnumerable<Vec3> Corners(Rect3D b) => Enumerable.Range(0, 8).Select(i =>
        new Vec3(b.X + ((i & 4) == 0 ? 0 : b.SizeX), b.Y + ((i & 2) == 0 ? 0 : b.SizeY), b.Z + ((i & 1) == 0 ? 0 : b.SizeZ)));
    Vec3 CameraLocal(Vec3 point) => Rotation(Camera.RotationVector).Inverse().Rotate(point - Camera.Position);
    public Point? Project(Vec3 point)
    {
        var local = CameraLocal(point);
        if (!Camera.OrthoExtent.HasValue && -local.Z < .01) return null;
        double span = Camera.OrthoExtent ?? -2 * local.Z * Math.Tan(Camera.Fov!.Value / 2);
        return new Point(ViewWidth / 2 + local.X * ViewHeight / span, ViewHeight / 2 - local.Y * ViewHeight / span);
    }
    public sealed record Hit(int Index, Vec3 Position, Rect3D Bounds);
    public (Vec3 Origin, Vec3 Direction) PickRay(Point pixel)
    {
        var q = Rotation(Camera.RotationVector);
        double span = Camera.OrthoExtent ?? 2 * Math.Tan(Camera.Fov!.Value / 2);
        var offset = new Vec3((pixel.X - ViewWidth / 2) * span / ViewHeight, (ViewHeight / 2 - pixel.Y) * span / ViewHeight, 0);
        var origin = Camera.Position + (Camera.OrthoExtent.HasValue
            ? q.Rotate(offset + new Vec3(0, 0, -NearPlane)) : default);
        var direction = q.Rotate(Camera.OrthoExtent.HasValue ? new Vec3(0, 0, -1) : offset + new Vec3(0, 0, -1));
        return (origin, direction * (1 / direction.Length()));
    }
    public Hit? Pick(Point pixel, bool selectionOnly = false, bool objectsOnly = false)
    {
        if (pixel.X < 0 || pixel.Y < 0 || pixel.X >= ViewWidth || pixel.Y >= ViewHeight) return null;
        Hit? found = null;
        var (rayOrigin, rayDirection) = PickRay(pixel);
        double nearest = double.PositiveInfinity;
        for (int i = 0; i < poses.Count; i++)
        {
            if (selectionOnly && i != Selected) continue;
            var indices = data.Objects[i].Indices;
            for (int t = 0; t < indices.Length; t += 3)
            {
                var a = WorldVertex(i, indices[t]);
                var e1 = WorldVertex(i, indices[t+1]) - a; var e2 = WorldVertex(i, indices[t+2]) - a;
                var h = rayDirection.Cross(e2); double det = e1.Dot(h);
                if (Math.Abs(det) < 1e-12) continue;
                var offset = rayOrigin - a; double u = offset.Dot(h) / det;
                if (u < -1e-10 || u > 1 + 1e-10) continue;
                var q = offset.Cross(e1); double v = rayDirection.Dot(q) / det;
                if (v < -1e-10 || u + v > 1 + 1e-10) continue;
                double distance = e2.Dot(q) / det;
                var point = rayOrigin + rayDirection * distance; double depth = -CameraLocal(point).Z;
                if (distance >= 0 && distance < nearest && depth >= NearPlane && depth <= FarPlane)
                { nearest = distance; found = new Hit(i, point, Bounds(i)); }
            }
        }
        // The grid has no opaque fill. Its finite plane is still a navigation hit target.
        if (!selectionOnly && !objectsOnly)
        {
            var (origin, direction) = PickRay(pixel);
            if (Math.Abs(direction.Y) > 1e-12)
            {
                var point = origin + direction * ((GroundBounds.Y - origin.Y) / direction.Y);
                double depth = -CameraLocal(point).Z;
                if (point.X >= GroundBounds.X && point.X <= GroundBounds.X + GroundBounds.SizeX
                    && point.Z >= GroundBounds.Z && point.Z <= GroundBounds.Z + GroundBounds.SizeZ
                    && depth >= NearPlane && depth <= FarPlane
                    && (found == null || depth < -CameraLocal(found.Position).Z)) found = new Hit(-1, point, GroundBounds);
            }
        }
        return found;
    }
    public void PointerDown(MouseButton button, Point pixel)
    {
        if (button is not (MouseButton.Left or MouseButton.Middle or MouseButton.Right)) return;
        EndDrag();
        if (button == MouseButton.Left && Operation == null)
        {
            int selected = Pick(pixel, objectsOnly: true)?.Index ?? -1;
            double now = Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency;
            bool doubleClick = selected >= 0 && lastClick is { } click && click.Index == selected
                && now - click.Time <= .4 && (pixel - click.Pixel).LengthSquared <= 25;
            Select(selected); lastClick = selected >= 0 ? (selected, now, pixel) : null;
            if (doubleClick) { lastClick = null; BeginEdit(); return; }
        }
        if (pixel.X < 0 || pixel.Y < 0 || pixel.X >= ViewWidth || pixel.Y >= ViewHeight) return;
        previous = pixel; dragButton = button;
        dragCenter = Pick(pixel)?.Position ?? Center(Bounds(Selected >= 0 ? Selected : null));
        if (Operation is Edit edit && button != MouseButton.Middle) editClick = (button, pixel, edit);
    }
    public void PointerMove(Point pixel, bool shift)
    {
        if (previous is not Point old) return;
        if (pixel.X < 0 || pixel.Y < 0 || pixel.X >= ViewWidth || pixel.Y >= ViewHeight) return;
        if (editClick is { } click)
        {
            if ((pixel - click.Pixel).LengthSquared < 16) return;
            editClick = null;
        }
        var delta = pixel - old;
        if (delta.LengthSquared == 0) return;
        lastClick = null;
        bool translate = (dragButton == MouseButton.Left) != shift;
        if (Operation != null) MouseEditObject(delta.X, delta.Y, translate);
        else { dragCenter = MouseNavigate(delta.X, delta.Y, dragCenter, translate); CameraChanged(); }
        previous = pixel;
    }
    public void PointerUp(MouseButton button, Point pixel)
    {
        var click = editClick; EndDrag();
        if (click is { } pending && pending.Button == button && ReferenceEquals(Operation, pending.Operation)
            && pixel.X >= 0 && pixel.Y >= 0 && pixel.X < ViewWidth && pixel.Y < ViewHeight
            && (pixel - pending.Pixel).LengthSquared < 16) FinishEdit(button == MouseButton.Left);
    }
    public void EndDrag() { previous = null; editClick = null; }
    public Vec3 MouseNavigate(double dx, double dy, Vec3 center, bool pan)
    {
        var q = Rotation(Camera.RotationVector);
        if (pan)
        {
            double span = Camera.OrthoExtent ?? 2 * Math.Max(.01, -CameraLocal(center).Z) * Math.Tan(Camera.Fov!.Value / 2);
            var offset = q.Rotate(new Vec3(-dx, dy, 0) * (span / ViewHeight));
            SetCamera(new CameraPoseValue(Camera.Position + offset, Camera.RotationVector, Camera.Fov, Camera.OrthoExtent));
            return center + offset;
        }
        var turn = Rotation(q.Rotate(new Vec3(-dy * .006, -dx * .006, 0)));
        SetCamera(new CameraPoseValue(center + turn.Rotate(Camera.Position - center), Rotvec((turn * q).Normalize()), Camera.Fov, Camera.OrthoExtent));
        return center;
    }
    public void MouseEditObject(double dx = 0, double dy = 0, bool pan = false, double wheel = 0)
    {
        if (Operation is not Edit edit) return;
        var pose = poses[edit.Index]; var q = Rotation(Camera.RotationVector);
        double span = Camera.OrthoExtent ?? 2 * Math.Max(.01, -CameraLocal(pose.Position).Z) * Math.Tan(Camera.Fov!.Value / 2);
        if (pan || wheel != 0)
            SetObject(edit.Index, new ObjectPoseValue(pose.Position + q.Rotate(new Vec3(dx * span / ViewHeight, -dy * span / ViewHeight, -wheel * span * .08)), pose.RotationVector));
        else
        {
            var turn = Rotation(q.Rotate(new Vec3(dy * .006, dx * .006, 0)));
            SetObject(edit.Index, new ObjectPoseValue(pose.Position, Rotvec((turn * Rotation(pose.RotationVector)).Normalize())));
        }
        ObjectChanged();
    }
    public void MouseZoom(double steps)
    {
        double factor = Math.Pow(.85, steps);
        if (Camera.OrthoExtent is double span)
            SetCamera(new CameraPoseValue(Camera.Position, Camera.RotationVector, orthoExtent: Math.Clamp(span * factor, .01, 10000)));
        else
        {
            double distance = Math.Max(.02, -CameraLocal(Center(Bounds(Selected >= 0 ? Selected : null))).Z);
            var offset = Rotation(Camera.RotationVector).Rotate(new Vec3(0, 0, distance * (factor - 1)));
            SetCamera(new CameraPoseValue(Camera.Position + offset, Camera.RotationVector, Camera.Fov));
        }
    }
    public void Wheel(double steps)
    {
        if (Operation != null) MouseEditObject(wheel: steps);
        else { MouseZoom(steps); CameraChanged(); }
    }
    public void ShowPivot(Vec3? point) { Pivot = point; }
    public void ShowObjectPivot(Vec3? point) { ObjectPivot = point; }
    public void SetStatus(string text) { connectionStatus = text; UpdateStatus(); }
    void UpdateStatus()
    {
        var controls = Operation == null ? "Enter: Edit selection    U: Undo    R: Reset scene" : "Enter: Accept    Esc: Cancel    R: Reset scene";
        KeyboardHelpText = $"{controls}    O: Projection ({(Camera.OrthoExtent.HasValue ? "Orthographic" : "Perspective")})";
        StatusText = $"{connectionStatus}\nWin activates camera control (if not remapped)\nF: Nav mode ({(FreeCamera ? "Free Camera" : "Orbit")})    D: Diagnostics ({(diagnosticsEnabled ? "On" : "Off")})";
    }

    public void SetDiagnostics(DiagnosticPresentation? frame, bool enabled)
    {
        diagnosticsEnabled = enabled; diagnosticFrame = enabled ? frame : null;
        UpdateStatus(); UpdateLens();
    }
    bool ClipSegment(ref Vec3 a, ref Vec3 b)
    {
        if (Camera.OrthoExtent.HasValue) return true;
        double da = -CameraLocal(a).Z, db = -CameraLocal(b).Z;
        if (da < .01 && db < .01) return false;
        if (da < .01) a += (b - a) * ((.010001 - da) / (db - da));
        else if (db < .01) b += (a - b) * ((.010001 - db) / (da - db));
        return true;
    }
    public static Quat Rotation(Vec3 r) => Quat.FromRotvec(r.X, r.Y, r.Z);
    public static Vec3 Rotvec(Quat q) { var (x, y, z) = q.ToRotvec(); return new Vec3(x, y, z); }
}
