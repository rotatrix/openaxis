using System.Diagnostics;
using OpenAxis.Client;
using OpenAxis.Diagnostics;
using OpenAxis.Geometry;
using OpenAxis.Navigation;

namespace OpenAxisDemo;

public sealed class MyApplicationScheduler(FrameDispatcher dispatcher) : INavigationScheduler, IDisposable
{
    readonly CancellationTokenSource stop = new();
    public void Post(Action callback) => dispatcher.BeginInvoke(callback);
    public void PostAt(double deadline, Action callback) => _ = Later(deadline, callback);
    async Task Later(double deadline, Action callback)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(Math.Max(0, deadline - Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency)), stop.Token).ConfigureAwait(false);
            if (!stop.IsCancellationRequested) Post(callback);
        }
        catch (OperationCanceledException) { }
    }
    public void Dispose() { stop.Cancel(); stop.Dispose(); }
}

public sealed class MyNavigationAdapter(MyApplication app) : INavigationAdapter
{
    public object? CaptureContext() => app.Alive ? app : null;
    public bool IsCurrent(object context) => ReferenceEquals(context, app) && app.Alive;
    public CameraPoseValue? Read(object context) => app.Camera;
    public INavigationCapture BeginQuery(object context) => new MyQueryCapture(app);
    public NavigationWriteResult ApplyCamera(object context, CameraPoseValue desired, NavigationState? state, Vec3? pivot)
    { app.SetCamera(desired); return new NavigationWriteResult(true, app.Camera); }
    public void ShowPivot(object context, Vec3? point) => app.ShowPivot(point);
}

public sealed class MyQueryCapture : INavigationCapture
{
    readonly MyApplication app;
    readonly CameraPoseValue pose;
    readonly double width, height;
    readonly Point? cursor;
    public MyQueryCapture(MyApplication app)
    {
        this.app = app; pose = app.Camera;
        width = Math.Max(1, app.ViewWidth); height = Math.Max(1, app.ViewHeight);
        cursor = app.Cursor;
    }
    public CameraPoseValue? InitialCameraObservation() => pose;
    public object? Resolve(string name)
    {
        switch (name)
        {
            case "world.orientation": return new Dictionary<string, object> { ["forward"] = new[] { 0, 0, -1 }, ["up"] = new[] { 0, 1, 0 }, ["handedness"] = "right" };
            case "camera.pose": return Values.Camera(pose);
            // World units per quarter ball turn in Rotatrix at unit gain.
            case "navigation.translation_scale": return 4.0;
            case "viewport.aspect": return width / height;
            case "viewport.cursor": return cursor is Point p ? new[] { 2 * p.X / width - 1, 1 - 2 * p.Y / height } : NavigationQuery.Unavailable;
            case "model.bounds": return Values.Bounds(app.Bounds());
            case "selection.bounds": return app.Selected >= 0 ? Values.Bounds(app.Bounds(app.Selected)) : NavigationQuery.Unavailable;
        }
        if (name is "pick.cursor" or "pick.cursor.selection" or "pick.viewport_center" or "pick.viewport_center.selection")
        {
            Point? pixel = name.StartsWith("pick.cursor") ? cursor : new Point(width / 2, height / 2);
            if (pixel is Point point && point.X >= 0 && point.X < width && point.Y >= 0 && point.Y < height
                && (!name.EndsWith(".selection") || app.Selected >= 0))
            {
                var hit = app.Pick(point, name.EndsWith(".selection"));
                if (hit != null)
                    return new Dictionary<string, object> { ["markerPosition"] = new[] { point.X, point.Y }, ["point"] = Values.Vector(hit.Position), ["bounds"] = Values.Bounds(hit.Bounds) };
                return new Dictionary<string, object> { ["markerPosition"] = new[] { point.X, point.Y } };
            }
        }
        return NavigationQuery.Unavailable;
    }
}

public sealed class MyObjectAdapter(MyApplication app) : INavigationObjectAdapter
{
    public object? CaptureContext() => app.Alive ? app.Operation : null;
    public bool IsCurrent(object context) => app.Alive && ReferenceEquals(context, app.Operation);
    public ObjectPoseValue? Read(object context) => app.GetObject(((MyApplication.Edit)context).Index);
    public INavigationObjectCapture BeginQuery(object context) => new MyObjectCapture(Read(context)!.Value, app.Bounds(((MyApplication.Edit)context).Index));
    public ObjectWriteResult ApplyObject(object context, ObjectPoseValue desired, NavigationState? state, Vec3? pivot)
    { app.SetObject(((MyApplication.Edit)context).Index, desired); return new ObjectWriteResult(true, Read(context)); }
    public void ShowPivot(object context, Vec3? point) => app.ShowObjectPivot(point);
}

public sealed class MyObjectCapture(ObjectPoseValue pose, Rect3D bounds) : INavigationObjectCapture
{
    public ObjectPoseValue? InitialObjectObservation() => pose;
    public object? Resolve(string name) => name switch
    {
        "object.pose" => new Dictionary<string, object> { ["t"] = Values.Vector(pose.Position), ["r"] = Values.Vector(pose.RotationVector) },
        "object.bounds" => Values.Bounds(bounds),
        _ => NavigationQuery.Unavailable,
    };
}

public static class Values
{
    public static double[] Vector(Vec3 v) => new[] { v.X, v.Y, v.Z };
    public static Dictionary<string, object> Bounds(Rect3D b) => new() { ["min"] = new[] { b.X, b.Y, b.Z }, ["max"] = new[] { b.X + b.SizeX, b.Y + b.SizeY, b.Z + b.SizeZ } };
    public static Dictionary<string, object> Camera(CameraPoseValue p)
    {
        var value = new Dictionary<string, object> { ["t"] = Vector(p.Position), ["r"] = Vector(p.RotationVector) };
        if (p.Fov is double fov) value["fov"] = fov;
        if (p.OrthoExtent is double span) value["ortho_extent"] = span;
        return value;
    }
}

public sealed class MyOpenAxisIntegration
{
    readonly MyApplication app;
    readonly MyApplicationScheduler scheduler;
    readonly NavigationSession session;
    readonly NavigationDiagnostics diagnostics;
    readonly OpenAxisConnectionManager connection;
    readonly Task running;
    readonly HashSet<Task> updates = new();
    (long Revision, double? Expires, bool Enabled)? diagnosticKey;
    // Replaced on the UI thread, read on the network thread. Never mutate a published snapshot.
    ConnectionMetadata metadata = new();
    bool stopping;

    public MyOpenAxisIntegration(MyApplication app, bool debug = false, string url = "ws://127.0.0.1:6607")
    {
        this.app = app;
        var client = new OpenAxisClient("csharp-demo-3d-app", url: url, target: new Target { Pid = OpenAxis.ProcessIdentity.Current(), App = "csharp-demo-3d-app" });
        var adapter = new MyNavigationAdapter(app);
        var objects = new MyObjectAdapter(app);
        scheduler = new MyApplicationScheduler(app.Dispatcher);
        var fileLog = DiagnosticLog.Configure("csharp-demo");
        fileLog.DebugLogging = debug;
        fileLog.Message += (level, message) => Console.WriteLine($"{level}: {message}");
        diagnostics = new NavigationDiagnostics(contextKey: _ => app) { DebugLogging = debug };
        session = new NavigationSession(client, adapter, scheduler, observation: adapter.Read,
            objectAdapter: objects, objectObservation: objects.Read, diagnostics: diagnostics);
        connection = new OpenAxisConnectionManager(client, () => Volatile.Read(ref metadata));
        connection.StateChanged += StatusChanged;
        app.CameraChanged = session.NativeCameraChanged;
        app.ObjectChanged = session.NativeObjectChanged;
        app.ContextChanged = () => { session.ContextChanged(); PublishMetadata(); };
        app.NavigationChanged = PublishMetadata;
        app.FocusChanged = PublishMetadata;
        app.ToggleDiagnostics = () => { diagnostics.SetEnabled(!diagnostics.Enabled); RefreshDiagnostics(null, EventArgs.Empty); };
        // Match the Python frame loop: render passive SDK presentation, including expiry.
        app.Rendering += RefreshDiagnostics;
        PublishMetadata();
        running = connection.StartAsync();
    }
    void StatusChanged(ConnectionManagerState state, Exception? error, TimeSpan? delay) => scheduler.Post(() =>
    {
        if (!stopping) app.SetStatus(state == ConnectionManagerState.Retrying
            ? $"Reconnecting in {delay?.TotalSeconds ?? 0:F1}s" + (error == null ? "" : $": {error.Message}")
            : state.ToString().ToLowerInvariant());
    });
    void RefreshDiagnostics(object? sender, EventArgs args)
    {
        var frame = diagnostics.Presentation();
        var key = (frame.Revision, frame.ExpiresAt, diagnostics.Enabled);
        if (diagnosticKey == key) return;
        diagnosticKey = key;
        app.SetDiagnostics(frame, diagnostics.Enabled);
    }
    void PublishMetadata()
    {
        var tags = new List<string> { "demo-3d-services" };
        if (app.FreeCamera) tags.Add("navigation.hint.free_camera");
        if (app.Operation != null) tags.AddRange(new[] { "interaction.object.rotate", "interaction.object.translate" });
        Volatile.Write(ref metadata, new ConnectionMetadata
        {
            Tags = tags.ToArray(),
            Capabilities = new[] { "navigation" }, Focused = app.IsActive,
        });
        if (stopping || connection.State != ConnectionManagerState.Ready) return;
        var update = connection.RefreshMetadataAsync(); updates.Add(update); _ = ObserveUpdate(update);
    }
    async Task ObserveUpdate(Task update)
    {
        try { await update; }
        catch (Exception error) { Console.WriteLine($"Metadata refresh interrupted: {error.Message}"); }
        finally { updates.Remove(update); }
    }
    public async Task StopAsync()
    {
        stopping = true;
        app.NavigationChanged = app.FocusChanged = app.ContextChanged = () => { };
        app.FinishEdit(false);
        connection.StateChanged -= StatusChanged;
        await connection.StopAsync(); await running;
        try { await Task.WhenAll(updates.ToArray()); } catch (Exception error) { Console.WriteLine(error.Message); }
        session.Dispose(); session.Drain();
        scheduler.Dispose(); app.Rendering -= RefreshDiagnostics;
        app.CameraChanged = app.ObjectChanged = app.ToggleDiagnostics = () => { };
        app.ShowPivot(null); app.ShowObjectPivot(null); app.SetDiagnostics(null, false); app.SetStatus("OpenAxis detached");
    }
}
