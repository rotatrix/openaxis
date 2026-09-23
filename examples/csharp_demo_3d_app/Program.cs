using Raylib_cs;
namespace OpenAxisDemo;
internal static class Program
{
    public static void Main(string[] args)
    {
        if (args.Contains("--test")) { DemoTests.Run(); return; }
        if (args.Length == 2 && args[0] == "--test-integration") { DemoTests.RunIntegration(args[1]); return; }
        int urlIndex = Array.IndexOf(args, "--url");
        if (urlIndex >= 0 && urlIndex + 1 == args.Length) throw new ArgumentException("--url requires a WebSocket URL");
        var app = new MyApplication();
        SynchronizationContext.SetSynchronizationContext(app.Dispatcher);
        app.OpenWindow();
        MyOpenAxisIntegration? integration = null;
        try
        {
            integration = new MyOpenAxisIntegration(app, args.Contains("--debug"), urlIndex >= 0 ? args[urlIndex+1] : "ws://127.0.0.1:6607");
            int frames = 0;
            while (!Raylib.WindowShouldClose())
            {
                app.PollInput(); app.Tick(); app.Draw();
                if (args.Contains("--screenshot") && ++frames == 5)
                { Raylib.TakeScreenshot("csharp-raylib-preview.png"); break; }
            }
        }
        finally
        {
            try { if (integration != null) app.Await(integration.StopAsync()); }
            finally { app.Close(); app.CloseWindow(); SynchronizationContext.SetSynchronizationContext(null); }
        }
    }
}
