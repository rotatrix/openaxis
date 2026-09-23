using Raylib_cs;
using OpenAxis.Client;
using OpenAxis.Diagnostics;
using OpenAxis.Geometry;
using OpenAxis.Navigation;
using System.IO;

namespace OpenAxisDemo;

internal static class DemoTests
{
    static int checks;
    static void Check(bool condition, string message) { checks++; if (!condition) throw new Exception(message); }
    static void Near(double a, double b, string message) => Check(Math.Abs(a - b) < 1e-6, $"{message}: {a} != {b}");
    static void Near(Vec3 a, Vec3 b, string message) => Check((a - b).Length() < 1e-6, $"{message}: {a} != {b}");
    public static void Run()
    {
        SharedScene();
        var app = new MyApplication(DemoScene.Load("test-boxes.json"));
        try
        {
            app.Resize(900, 600);
            Geometry(app); Controls(app); Diagnostics(app); Adapters(app);

        }
        finally { app.Close(); }
        Console.WriteLine($"C# viewer: {checks} checks passed (geometry, controls, diagnostics and adapters).");
    }
    static void SharedScene()
    {
        var data = DemoScene.Load();
        Check(data.Seed == 123 && data.Objects.Length == 30, "shared seeded scene");
        var app = new MyApplication();
        try
        {
            using var stream = typeof(DemoScene).Assembly.GetManifestResourceStream("probes.json")!;
            using var document = System.Text.Json.JsonDocument.Parse(stream);
            Vec3 Vector(System.Text.Json.JsonElement array) => new(array[0].GetDouble(), array[1].GetDouble(), array[2].GetDouble());
            foreach (var probe in document.RootElement.EnumerateArray())
            {
                int index = probe.GetProperty("index").GetInt32();
                var camera = probe.GetProperty("camera");
                app.SetCamera(new CameraPoseValue(Vector(camera.GetProperty("t")), Vector(camera.GetProperty("r")), fov: camera.GetProperty("fov").GetDouble()));
                app.Select(index);
                var hit = app.Pick(new Point(450, 300), selectionOnly: true);
                var expected = probe.GetProperty("hit");
                if (expected.ValueKind == System.Text.Json.JsonValueKind.Null) Check(hit == null, $"triangle hole: {index}");
                else { Check(hit?.Index == index, $"triangle hit: {index}"); Near(hit!.Position, Vector(expected), $"triangle position: {index}"); }
            }
            app.ResetScene(); app.Select(7); app.BeginEdit(); var original = app.GetObject(7);
            app.MouseEditObject(20, 10, true); app.FinishEdit(true); app.ResetScene();
            Near(app.GetObject(7).Position, original.Position, "seeded reset position");
            Near(app.GetObject(7).RotationVector, original.RotationVector, "seeded reset rotation");
            app.SetStatus("ready");
        }
        finally { app.Close(); }
    }
    static void Geometry(MyApplication app)
    {
        Near(app.GetObject(0).Position, default, "blue cube origin");
        Near(app.GetObject(1).Position, new Vec3(2.8, 0, -1.2), "orange cube origin");
        Near(app.GetObject(2).Position, new Vec3(-2.65, 0, -1.15), "green cube origin");
        Near(app.Bounds().SizeX, 6.9, "model excludes ground");
        foreach (double aspect in new[] { .75, 1.5, 2.0 })
        foreach (bool ortho in new[] { false, true })
        {
            app.Resize(600 * aspect, 600);
            app.SetCamera(new CameraPoseValue(new Vec3(0, 0, 10), default, ortho ? null : 1, ortho ? 8 : null));
            var hit = app.Pick(new Point(app.ViewWidth / 2, 300));
            Check(hit?.Index == 0, "center picks blue cube");
            Near(hit!.Position, new Vec3(0, 0, 1), "world-space hit");
            var pixel = app.Project(hit.Position)!.Value;
            Near(pixel.X, app.ViewWidth / 2, "pick/project x"); Near(pixel.Y, 300, "pick/project y");
            app.Select(1);
            Check(app.Pick(new Point(app.ViewWidth / 2, 300), selectionOnly: true) == null, "selection filter");
            app.Select(-1);
        }
        app.Resize(900, 600);
        foreach (bool ortho in new[] { false, true })
        {
            app.SetCamera(new CameraPoseValue(new Vec3(0, 3, 10), new Vec3(-.3, 0, 0), ortho ? null : 1, ortho ? 8 : null));
            var pixel = app.Project(new Vec3(4, 0.0, 0))!.Value;
            var hit = app.Pick(pixel);
            Check(hit?.Index == -1 && hit.Bounds == MyApplication.GroundBounds, "finite ground hit and bounds");
            Near(hit!.Position.Y, 0.0, "ground height");
            Check(app.Pick(pixel, objectsOnly: true) == null, "ground excluded from selection");
            Check(app.Pick(pixel, selectionOnly: true) == null, "ground excluded from selection queries");
        }
        app.SetCamera(new CameraPoseValue(new Vec3(50, 3, 10), new Vec3(-.3, 0, 0), orthoExtent: 8));
        Check(app.Pick(app.Project(new Vec3(50, 0.0, 0))!.Value) == null, "ground bounded at 40");
        app.SetObject(0, new ObjectPoseValue(new Vec3(0, -3, 0), default));
        app.SetCamera(new CameraPoseValue(new Vec3(0, 3, 10), new Vec3(-.5, 0, 0), fov: 1));
        var below = app.Project(new Vec3(0, -3, 0))!.Value;
        Check(app.Pick(below)?.Index == -1, "navigation hits ground before buried cube");
        Check(app.Pick(below, objectsOnly: true)?.Index == 0, "selection reaches cube behind ground");
        app.PointerDown(MouseButton.Left, below); app.PointerUp(MouseButton.Left, below);
        Check(app.Selected == 0, "actual selection ignores ground");
        app.ResetScene();
        app.SetObject(0, new ObjectPoseValue(new Vec3(2, 0, 0), new Vec3(0, 0, Math.PI / 4)));
        Near(app.Bounds(0).SizeX, 2 * Math.Sqrt(2), "transformed bounds");
        var translated = app.Pick(app.Project(new Vec3(2, 0, 0))!.Value, objectsOnly: true);
        Check(translated?.Index == 0, "transformed cube pick");
        Near(app.Project(translated!.Position)!.Value.X, app.Project(new Vec3(2, 0, 0))!.Value.X, "transformed pick reports world coordinates");
        app.ResetScene();
        app.SetCamera(new CameraPoseValue(default, new Vec3(.4, .8, .1), orthoExtent: 8));
        var lens = app;
        Check(lens.NearPlane < 0 && lens.FarPlane > 0, "ortho renders both sides of camera");
        app.ResetScene();
    }
    static void Controls(MyApplication app)
    {
        int cameraChanges = 0, objectChanges = 0;
        app.CameraChanged = () => cameraChanges++; app.ObjectChanged = () => objectChanges++;
        foreach (bool ortho in new[] { false, true })
        {
            var camera = new CameraPoseValue(new Vec3(0, 0, 10), default, ortho ? null : 1, ortho ? 8 : null);
            app.SetCamera(camera);
            var center = app.MouseNavigate(30, 20, default, true);
            var pixel = app.Project(default)!.Value;
            Near(pixel.X, 480, "pan tracks pixels x"); Near(pixel.Y, 320, "pan tracks pixels y");
            var latest = new CameraPoseValue(new Vec3(5, 2, 12), default, camera.Fov, camera.OrthoExtent);
            app.SetCamera(latest); app.MouseNavigate(0, 0, center, true);
            Near(app.Camera.Position, latest.Position, "uses intervening SDK write");
            app.SetCamera(camera);
            for (int i = 0; i < 8; i++) app.Wheel(.125);
            var split = app.Camera; app.SetCamera(camera); app.Wheel(1);
            Near(app.Camera.Position, split.Position, "fractional wheel sum");
            if (ortho) Near(app.Camera.OrthoExtent!.Value, split.OrthoExtent!.Value, "fractional ortho zoom");
            app.Wheel(-1);
            Near(app.Camera.Position, camera.Position, "wheel inverse");
            if (ortho) Near(app.Camera.OrthoExtent!.Value, 8, "ortho inverse");
        }
        foreach (var button in new[] { MouseButton.Left, MouseButton.Middle, MouseButton.Right })
        foreach (bool shift in new[] { false, true })
        {
            app.ResetScene();
            app.PointerDown(button, new Point(450, 300)); app.PointerMove(new Point(470, 310), shift); app.PointerUp(button, new Point(470, 310));
            bool translate = (button == MouseButton.Left) != shift;
            Check((app.Camera.RotationVector.Length() == 0) == translate, "camera drag with Shift swap");
            app.ResetScene(); app.Select(0); app.BeginEdit();
            var camera = app.Camera;
            app.PointerDown(button, new Point(450, 300)); app.PointerMove(new Point(470, 310), shift); app.PointerUp(button, new Point(470, 310));
            Check(app.Operation != null, "drag release does not accept/cancel");
            Check((app.GetObject(0).Position.Length() > 0) == translate, "object translation mode");
            Check((app.GetObject(0).RotationVector.Length() > 0) != translate, "object rotation mode");
            Near(app.Camera.Position, camera.Position, "object edit preserves camera");
            app.FinishEdit(false);
        }
        app.ResetScene();
        app.PointerDown(MouseButton.Left, new Point(450, 300)); app.PointerUp(MouseButton.Left, new Point(450, 300));
        Check(app.Selected == 0 && app.Operation == null, "click selects only");
        app.PointerDown(MouseButton.Left, new Point(450, 300)); app.PointerUp(MouseButton.Left, new Point(450, 300));
        Check(app.Operation != null, "double click enters edit without immediately accepting");
        Check(app.MouseHelpText.Contains("Left-click: Accept") && !app.KeyboardHelpText.Contains("U: Undo"), "contextual help");
        Check(app.ObjectColor(0).Equals(new Color(255, 64, 191, 255)), "pink edit highlight");
        app.Wheel(.125); var edited = app.GetObject(0);
        Check(edited.Position.Z < 0, "fractional object depth");
        app.PointerDown(MouseButton.Left, new Point(450, 300));
        app.PointerMove(new Point(451, 301), false); // Small hand jitter is still a click.
        Check(app.Operation != null, "accept waits for release");
        app.PointerUp(MouseButton.Left, new Point(451, 301));
        Check(app.Operation == null && app.Selected == -1, "accept deselects");
        Near(app.GetObject(0).Position, edited.Position, "accept preserves pose");
        Check(app.ObjectColor(0).Equals(new Color(77, 166, 230, 255)), "normal color after accept");
        app.HandleKey(Key.U); Near(app.GetObject(0).Position, default, "undo accepted edit");
        app.Select(0); app.HandleKey(Key.Enter); app.MouseEditObject(30, 20, true);
        app.PointerDown(MouseButton.Right, new Point(450, 300)); app.PointerUp(MouseButton.Right, new Point(450, 300));
        Near(app.GetObject(0).Position, default, "right click restores initial pose");
        Check(app.Operation == null && app.Selected == -1, "cancel deselects");
        app.Select(0); app.HandleKey(Key.Enter); app.MouseEditObject(20, 10); app.HandleKey(Key.U);
        Check(app.Operation == null, "undo cancels active edit");
        Near(app.GetObject(0).RotationVector, default, "undo cancels rotation");
        app.Select(0); app.BeginEdit(); app.MouseEditObject(20, 10, true); app.HandleKey(Key.Enter);
        app.Select(1); app.BeginEdit(); app.MouseEditObject(20, 10); app.HandleKey(Key.R);
        Check(app.Operation == null && app.Selected == -1, "reset ends edit and deselects");
        Near(app.GetObject(0).Position, default, "reset restores accepted object");
        Near(app.GetObject(1).RotationVector, default, "reset restores active rotation");
        app.HandleKey(Key.U); Near(app.GetObject(0).Position, default, "reset clears undo history");
        int navigationChanges = 0;
        app.NavigationChanged = () => navigationChanges++;
        app.HandleKey(Key.F);
        Check(app.FreeCamera && app.StatusText.Contains("Nav mode (Free Camera)"), "free camera toggle");
        app.HandleKey(Key.F);
        Check(!app.FreeCamera && navigationChanges == 2, "orbit toggle publishes changes");
        app.NavigationChanged = () => { };
        app.HandleKey(Key.O); Check(app.KeyboardHelpText.Contains("Projection (Orthographic)"), "projection status");
        app.HandleKey(Key.R); Check(app.KeyboardHelpText.Contains("Projection (Perspective)"), "reset projection status");
        Check(cameraChanges > 0 && objectChanges > 0, "native input notifies integration");
    }
    static DiagnosticPresentation Presentation(MyApplication app) => new(app,
        new[] { new DiagnosticRow("Navigation diagnostics | gesture 1 | query 1 | 0.0 ms"),
            new DiagnosticRow("pick.viewport_center: (0, 0, 1) < returned candidate", "center"),
            new DiagnosticRow("camera write: equivalent", "pass") },
        new[] { new DiagnosticSegment(new Vec3(-1, -1, 1), new Vec3(1, -1, 1), "model", 1, .35),
            new DiagnosticSegment(new Vec3(1, -1, 1), new Vec3(1, 1, 1), "model", 1, .35),
            new DiagnosticSegment(new Vec3(1, 1, 1), new Vec3(-1, 1, 1), "model", 1, .35),
            new DiagnosticSegment(new Vec3(-1, 1, 1), new Vec3(-1, -1, 1), "model", 1, .35) },
        new[] { new DiagnosticMarker("pick.viewport_center", app.ViewWidth / 2, app.ViewHeight / 2, "center") }, 1);
    static void Diagnostics(MyApplication app)
    {
        Check(!app.DiagnosticsEnabled && app.StatusText.Contains("Diagnostics (Off)"), "diagnostics defaults off");
        var d = new NavigationDiagnostics();
        app.ToggleDiagnostics = () => { d.SetEnabled(!d.Enabled); app.SetDiagnostics(d.Presentation(), d.Enabled); };
        app.HandleKey(Key.D); Check(app.StatusText.Contains("Diagnostics (On)"), "diagnostic toggle status");
        app.SetStatus("ready"); Check(app.StatusText.StartsWith("ready\nWin activates"), "status retains connection and modes");
        app.SetDiagnostics(Presentation(app), true);
        Check(app.DiagnosticFrame!.Segments.Count == 4 && app.DiagnosticFrame.Markers.Count == 1, "full diagnostic presentation retained");
        app.ShowPivot(new Vec3(100, 100, 100)); Near(app.Bounds().SizeX, 6.9, "pivot excluded from bounds");
        app.ShowPivot(null); Check(app.Pivot == null, "pivot cleanup");
        app.SetCamera(new CameraPoseValue(new Vec3(0, 0, 10), default, orthoExtent: 8));
        app.SetDiagnostics(null, false);
        double initialNear = app.NearPlane, initialFar = app.FarPlane;
        double initialDepthRange = initialFar - initialNear;
        app.SetDiagnostics(new DiagnosticPresentation(app, Array.Empty<DiagnosticRow>(),
            new[] { new DiagnosticSegment(new Vec3(0, 0, 500), new Vec3(0, 0, -700), "model", 1, .35) }, Array.Empty<DiagnosticMarker>(), 2), true);
        var lens = app;
        Check(lens.NearPlane < -490 && lens.FarPlane > 710, "ortho diagnostics included in clipping");
        app.HandleKey(Key.D);
        Check(app.DiagnosticFrame == null && app.StatusText.Contains("Diagnostics (Off)"), "disable clears all diagnostics");
        lens = app;
        Near(lens.FarPlane - lens.NearPlane, initialDepthRange, "clipping contracts after diagnostics removed");
        app.ResetScene();
    }
    static void Adapters(MyApplication app)
    {
        var camera = new MyNavigationAdapter(app);
        Check(ReferenceEquals(camera.CaptureContext(), app), "camera context");
        Check(ReferenceEquals(camera.BeginQuery(app).Resolve("unknown"), NavigationQuery.Unavailable), "missing facts");
        Near((double)camera.BeginQuery(app).Resolve("navigation.translation_scale")!, 4.0, "free-camera translation scale");
        var capture = camera.BeginQuery(app);
        var hit = (Dictionary<string, object>)capture.Resolve("pick.viewport_center")!;
        Check(hit.ContainsKey("markerPosition") && ((double[])hit["point"])[2] == 1, "pick evidence recorded");
        app.Select(-1);
        Check(ReferenceEquals(capture.Resolve("pick.viewport_center.selection"), NavigationQuery.Unavailable)
            , "empty selection has no diagnostic sample");
        app.Select(0);
        app.SetCamera(new CameraPoseValue(new Vec3(100, 0, 10), default, fov: 1));
        Check(((Dictionary<string, object>)camera.BeginQuery(app).Resolve("pick.viewport_center.selection")!).ContainsKey("markerPosition"), "selection miss retains diagnostic sample");
        var desired = new CameraPoseValue(new Vec3(1, 2, 9), new Vec3(.1, .2, .3), orthoExtent: 6);
        var result = camera.ApplyCamera(app, desired, null, null);
        Check(result.Success && result.Realized!.Value.OrthoExtent == 6, "camera readback");
        app.ResetScene(); app.Select(0); app.BeginEdit();
        var objects = new MyObjectAdapter(app); var operation = objects.CaptureContext()!;
        Check(objects.IsCurrent(operation), "stable object context");
        var written = objects.ApplyObject(operation, new ObjectPoseValue(new Vec3(8, 1, 0), new Vec3(0, .4, 0)), null, null);
        Check(written.Success && written.Realized!.Value.Position.X == 8, "object readback");
        app.FinishEdit(false);
        Check(!objects.IsCurrent(operation), "cancel invalidates context");
        Near(app.GetObject(0).Position, default, "cancel restores SDK write");
        app.Select(0); app.BeginEdit(); Check(!ReferenceEquals(operation, objects.CaptureContext()), "new operation has new identity");
        app.FinishEdit(true);
        using var scheduler = new MyApplicationScheduler(app.Dispatcher);
        bool invoked = false; scheduler.Post(() => invoked = true);
        Check(!invoked, "scheduler defers");
        app.Dispatcher.Drain();
        Check(invoked, "scheduler drains");
        app.Alive = false;
        Check(!camera.IsCurrent(app) && camera.CaptureContext() == null, "closed viewport invalidation");
        app.Alive = true;
    }
    // Driven by test_integration.py's real loopback WebSocket server.
    public static void RunIntegration(string url)
    {

        var app = new MyApplication();
        var originalObject = app.GetObject(0);
        MyOpenAxisIntegration? integration = null;
        Exception? failure = null;
        int phase = 0;
        bool finishing = false;
        var watch = System.Diagnostics.Stopwatch.StartNew();
        SynchronizationContext.SetSynchronizationContext(app.Dispatcher);
        integration = new MyOpenAxisIntegration(app, url: url);
        app.ToggleDiagnostics();
        while (!finishing)
        {
            app.Tick(); Thread.Sleep(1);
            try
            {
                if (watch.Elapsed.TotalSeconds > 15) throw new TimeoutException($"Loopback test stalled in phase {phase}");
                if (phase == 0 && app.Camera.Position.X == 1 && app.Pivot.HasValue
                    && app.DiagnosticFrame is { Markers.Count: > 0, Segments.Count: > 0 })
                {
                    Check(app.StatusText.Contains("Diagnostics (On)"), "live diagnostics state");
                    app.MouseNavigate(15, 0, default, true); app.CameraChanged(); phase = 1;
                }
                else if (phase == 1 && app.Pivot == null)
                {
                    Check(app.Camera.Position.X != 1, "native camera correction survived acknowledgement");
                    app.Select(0); app.BeginEdit(); phase = 2;
                }
                else if (phase == 2 && app.GetObject(0).Position.X == 2)
                {
                    app.MouseEditObject(20, 0, true); phase = 3;
                }
                else if (phase == 3 && app.GetObject(0).Position.X == 3)
                {
                    // Wait for motion_end to reach the session before verifying the
                    // application's edit transaction remains active (server ends it via pivot cleanup).
                    if (app.ObjectPivot != null) continue;
                    Check(app.Operation != null, "gesture end preserves native edit transaction");
                    app.FinishEdit(false); Near(app.GetObject(0).Position, originalObject.Position, "cancel restores streamed object");
                    Near(app.GetObject(0).RotationVector, originalObject.RotationVector, "cancel restores seeded rotation");
                    phase = 4;
                }
            }
            catch (Exception error) { failure = error; }
            if (!finishing && (phase == 4 || failure != null))
            {
                finishing = true;
                try { if (integration != null) app.Await(integration.StopAsync()); }
                catch (Exception error) { failure ??= error; }
                finally { app.Close(); }
            }
        }
        SynchronizationContext.SetSynchronizationContext(null);
        if (failure != null) throw failure;
        Check(phase == 4, "loopback completed");
        Console.WriteLine("C# live loopback passed: query/pick diagnostics, camera and object writes, native correction acknowledgements, metadata and shutdown.");
    }
}
