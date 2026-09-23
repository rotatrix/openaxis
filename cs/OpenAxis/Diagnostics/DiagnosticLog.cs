using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

#if OPENAXIS_EMBEDDED_LOGGER
namespace OpenAxis.EmbeddedDiagnostics
#else
namespace OpenAxis.Diagnostics
#endif
{
    /// <summary>Optional per-instance rotating file logger. No network traffic.</summary>
    public sealed class DiagnosticLog : IDisposable
    {
        private static readonly object registryGate = new object();
        private static DiagnosticLog? current;
        private static readonly Dictionary<string, DiagnosticLog> configured = new Dictionary<string, DiagnosticLog>();
        private readonly object gate = new object();
        private bool closed;
        private readonly long maxBytes;
        private readonly byte[] header;
        public string SessionHeader { get; }
        public string? FilePath { get; private set; }
        public string? Error { get; private set; }
        public bool DebugLogging { get; set; }
        public event Action<string, string>? Message;

        public static string DefaultDirectory()
        {
            var custom = Environment.GetEnvironmentVariable("ROTATRIX_LOG_DIR");
            if (!string.IsNullOrEmpty(custom)) return custom!;
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var root = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
                ? Environment.GetEnvironmentVariable("LOCALAPPDATA")
                : RuntimeInformation.IsOSPlatform(OSPlatform.OSX)
                    ? Path.Combine(home, "Library", "Application Support")
                    : Environment.GetEnvironmentVariable("XDG_DATA_HOME");
            if (string.IsNullOrEmpty(root)) root = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
                ? Path.Combine(home, "AppData", "Local") : Path.Combine(home, ".local", "share");
            return Path.Combine(root!, "Rotatrix", "logs");
        }

        /// <summary>Set the default destination for SDK events in this host.</summary>
        public static DiagnosticLog Configure(string client, string? directory = null, string? clientVersion = null)
        {
            lock (registryGate)
            {
                if (!configured.TryGetValue(client, out current) || current.closed)
                    configured[client] = current = new DiagnosticLog(client, directory, clientVersion: clientVersion);
                return current;
            }
        }

        public static void Emit(string level, string message)
        {
            var sink = current;
            if (sink != null) sink.Write(level, message);
            else System.Diagnostics.Trace.WriteLine(DiagnosticFormatter.FormatLogLine(message,
                level == "warning" ? DiagnosticLevel.Warning : level == "error" ? DiagnosticLevel.Error : DiagnosticLevel.Info));
        }

        public DiagnosticLog(string client, string? directory = null, long maxBytes = 5 * 1024 * 1024, int keep = 10, string? clientVersion = null)
        {
            if (!Regex.IsMatch(client, @"\A[a-z0-9][a-z0-9_-]*\z")) throw new ArgumentException("Invalid client identifier", nameof(client));
            if (maxBytes <= 0 || keep < 0) throw new ArgumentOutOfRangeException(nameof(maxBytes));
            this.maxBytes = maxBytes;
            SessionHeader = $"OpenAxis SDK {SdkVersion.Value} (C#); client={client}; client_version={clientVersion ?? "unknown"}";
            header = Encoding.UTF8.GetBytes(FormatRecord("info", SessionHeader));
            try
            {
                directory = Path.GetFullPath(directory ?? DefaultDirectory());
                Directory.CreateDirectory(directory);
                var stem = client + "-" + DateTime.UtcNow.ToString("yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture);
                lock (registryGate)
                {
                    var first = Directory.GetFiles(directory, stem + "*.log")
                        .Select(p => Regex.Match(Path.GetFileName(p), @"\A" + Regex.Escape(stem) + @"(?:-([0-9]+))?\.log\z"))
                        .Where(m => m.Success).Select(m => m.Groups[1].Success ? int.Parse(m.Groups[1].Value) : 1).DefaultIfEmpty(0).Max() + 1;
                    for (var index = first; index < first + 10000; index++)
                    {
                        var path = Path.Combine(directory, stem + (index == 1 ? "" : "-" + index) + ".log");
                        FileStream file;
                        try { file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete); }
                        catch (IOException) when (File.Exists(path)) { continue; }
                        using (file) { file.Write(header, 0, header.Length); }
                        FilePath = path; break;
                    }
                    if (FilePath == null) throw new IOException("No available log filename");
                    Cleanup(directory, client, keep, FilePath);
                }
            }
            catch (Exception error) when (error is IOException || error is UnauthorizedAccessException)
            { Error = error.Message; }
        }

        private static void Cleanup(string directory, string client, int keep, string currentPath)
        {
            var pattern = new Regex(@"\A" + Regex.Escape(client) + @"-[0-9]{8}T[0-9]{6}Z(?:-(?:[2-9]|[1-9][0-9]+))?\.log\z");
            var retained = 1;
            foreach (var path in Directory.GetFiles(directory, client + "-*.log")
                .OrderByDescending(p => Regex.Match(Path.GetFileName(p), @"[0-9]{8}T[0-9]{6}Z").Value, StringComparer.Ordinal)
                .ThenByDescending(p => { var m = Regex.Match(p, @"Z-([0-9]+)\.log$"); return m.Success && int.TryParse(m.Groups[1].Value, out var n) ? n : 1; }))
            {
                if (!pattern.IsMatch(Path.GetFileName(path)) || path == currentPath) continue;
                try
                {
                    if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) continue;
                    if (++retained > Math.Max(1, keep)) { File.Delete(path); File.Delete(path + ".1"); }
                }
                catch (Exception error) when (error is IOException || error is UnauthorizedAccessException) { }
            }
        }

        public static string NormalizeLevel(string level)
        {
            switch (level.ToLowerInvariant())
            {
                case "debug": return "debug";
                case "warning": case "warn": return "warning";
                case "error": case "critical": return "error";
                default: return "info";
            }
        }
        public static string FormatRecord(string level, string message, DateTimeOffset? now = null) =>
            (now ?? DateTimeOffset.Now).ToString("yyyy-MM-dd HH:mm:ss.fff zzz", CultureInfo.InvariantCulture)
            + " " + NormalizeLevel(level).ToUpperInvariant() + " "
            + Regex.Replace(message, @"\x1b\[[0-?]*[ -/]*[@-~]", "").Replace("\r\n", "\n").Replace("\r", "\n").Replace("\n", "\n    ") + "\n";

        public void Write(string level, string message)
        {
            level = NormalizeLevel(level);
            if (level == "debug" && !DebugLogging) return;
            var line = FormatRecord(level, message);
            lock (gate)
            {
                if (closed) return;
                try
                {
                    if (FilePath != null)
                    {
                        var data = Encoding.UTF8.GetBytes(line);
                        var size = new FileInfo(FilePath).Length;
                        if (size > header.Length && size + data.Length > maxBytes)
                        { File.Delete(FilePath + ".1"); File.Move(FilePath, FilePath + ".1"); size = 0; }
                        using (var stream = new FileStream(FilePath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
                        {
                            if (size == 0) stream.Write(header, 0, header.Length);
                            stream.Write(data, 0, data.Length);
                        }
                        Error = null;
                    }
                }
                catch (Exception error) when (error is IOException || error is UnauthorizedAccessException) { Error = error.Message; }
            }
            var observers = Message;
            if (observers != null)
                foreach (Action<string, string> sink in observers.GetInvocationList())
                    try { sink(level, message); } catch { }
        }

        public void Dispose()
        {
            lock (gate) { closed = true; }
        }
    }
}
