using System;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Linq;
using System.Collections.Generic;
using OpenAxis.Diagnostics;

namespace OpenAxis.ConformanceTests
{
    internal static class DiagnosticLogTests
    {
        public static int Run()
        {
            var root = Path.Combine(Path.GetTempPath(), "openaxis-log-test-" + Guid.NewGuid());
            var checks = 0;
            void Check(bool value) { checks++; if (!value) throw new Exception("File logging check " + checks); }
            try
            {
                var assemblyVersion = typeof(DiagnosticLog).Assembly.GetCustomAttributes(typeof(System.Reflection.AssemblyInformationalVersionAttribute), false)
                    .Cast<System.Reflection.AssemblyInformationalVersionAttribute>().Single().InformationalVersion.Split('+')[0];
                Check(SdkVersion.Value == assemblyVersion);
                using (var headerLog = new DiagnosticLog("header-test", root, maxBytes: 1, clientVersion: "2.3.4"))
                {
                    headerLog.Write("info", "first"); headerLog.Write("info", "second");
                    foreach (var path in new[] { headerLog.FilePath!, headerLog.FilePath + ".1" })
                        Check(File.ReadLines(path).First().Contains("OpenAxis SDK " + SdkVersion.Value + " (C#); client=header-test; client_version=2.3.4"));
                }
                using (var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "logging.json"))))
                {
                    var f = fixture.RootElement;
                    var now = DateTimeOffset.FromUnixTimeMilliseconds(f.GetProperty("epoch_ms").GetInt64()).ToOffset(TimeSpan.FromMinutes(f.GetProperty("offset_minutes").GetInt32()));
                    Directory.CreateDirectory(root);
                    for (var i = 1; i <= 12; i++) {
                        var name = "retention-20200101T000000Z" + (i == 1 ? "" : "-" + i) + ".log";
                        File.WriteAllText(Path.Combine(root, name), "");
                    }
                    using (var retention = new DiagnosticLog("retention", root)) {
                        var expected = f.GetProperty("retained_suffixes").EnumerateArray().Select(i => "retention-20200101T000000Z-" + i.GetInt32() + ".log").OrderBy(n => n);
                        Check(expected.SequenceEqual(Directory.GetFiles(root, "retention-2020*.log").Select(Path.GetFileName).OrderBy(n => n)));
                    }
                    var r = f.GetProperty("rotation");
                    using (var boundary = new DiagnosticLog("boundary", root, maxBytes: r.GetProperty("max_bytes").GetInt32() + System.Text.Encoding.UTF8.GetByteCount(DiagnosticLog.FormatRecord("info", "OpenAxis SDK " + SdkVersion.Value + " (C#); client=boundary; client_version=unknown")))) {
                        var headerBytes = new FileInfo(boundary.FilePath!).Length;
                        for (var i = 0; i < r.GetProperty("writes_before_rotation").GetInt32(); i++) boundary.Write("info", r.GetProperty("message").GetString()!);
                        Check(new FileInfo(boundary.FilePath!).Length == r.GetProperty("max_bytes").GetInt32() + headerBytes);
                        Check(!File.Exists(boundary.FilePath + ".1"));
                        boundary.Write("info", r.GetProperty("message").GetString()!);
                        Check(new FileInfo(boundary.FilePath + ".1").Length == r.GetProperty("max_bytes").GetInt32() + headerBytes);
                    }
                    var mirrors = new List<string>();
                    using (var log = new DiagnosticLog("conformance", root))
                    {
                        log.Message += (level, message) => mirrors.Add(level);
                        var expected = "";
                        foreach (var record in f.GetProperty("records").EnumerateArray())
                        {
                            var level = record.GetProperty("level").GetString()!;
                            var message = record.GetProperty("message").GetString()!;
                            Check(DiagnosticLog.NormalizeLevel(level) == record.GetProperty("normalized").GetString());
                            Check(DiagnosticLog.FormatRecord(level, message, now) == record.GetProperty("line").GetString());
                            log.Write(level, message);
                            if (record.GetProperty("normalized").GetString() != "debug") expected += record.GetProperty("line").GetString();
                        }
                        var complete = File.ReadAllText(log.FilePath!);
                        var actual = complete.Substring(complete.IndexOf('\n') + 1);
                        Check(Regex.Replace(actual, @"[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3} [+-][0-9]{2}:[0-9]{2}", f.GetProperty("stamp").GetString()!) == expected);
                        var count = mirrors.Count;
                        log.Dispose(); log.Write("info", "after close");
                        Check(mirrors.Count == count && File.ReadAllText(log.FilePath!) == complete);
                    }
                    foreach (var client in f.GetProperty("invalid_clients").EnumerateArray())
                    {
                        bool rejected = false;
                        try { using var invalid = new DiagnosticLog(client.GetString()!, root); }
                        catch (ArgumentException) { rejected = true; }
                        Check(rejected);
                    }
                    var configured = f.GetProperty("configuration").EnumerateArray().Select(c => DiagnosticLog.Configure(c.GetString()!, root)).ToArray();
                    Check(ReferenceEquals(configured[0], configured[2]) && !ReferenceEquals(configured[0], configured[1]));
                    DiagnosticLog.Emit("info", "reactivated");
                    Check(File.ReadAllText(configured[0].FilePath!).Contains("reactivated") && !File.ReadAllText(configured[1].FilePath!).Contains("reactivated"));
                    configured[0].Dispose();
                    using (var fresh = DiagnosticLog.Configure("alpha", root)) Check(!ReferenceEquals(fresh, configured[0]));
                    configured[1].Dispose();
                }
                using (var active = new DiagnosticLog("test", root, maxBytes: 100))
                {
                    var mirrored = 0;
                    active.Message += (_, __) => throw new Exception("broken mirror");
                    active.Message += (_, __) => mirrored++;
                    active.Write("info", new string('x', 80));
                    active.Write("warning", "new record");
                    Check(File.Exists(active.FilePath + ".1"));
                    Check(File.ReadAllText(active.FilePath!).Contains("new record"));
                    Check(mirrored == 2);
                    using (var concurrent = new DiagnosticLog("test", root))
                        Check(active.FilePath != concurrent.FilePath);
                    for (var i = 0; i < 12; i++) using (var old = new DiagnosticLog("test", root)) { }
                    Check(!File.Exists(active.FilePath));
                    Check(Directory.GetFiles(root, "test-*.log").Length == 10);
                }
                using (var clean = new DiagnosticLog("test", root, keep: 0))
                    Check(Directory.GetFiles(root, "test-*.log").Length == 1);
                var blocked = Path.Combine(root, "blocked");
                File.WriteAllText(blocked, "file");
                using (var failed = new DiagnosticLog("test", blocked))
                {
                    Check(failed.Error != null);
                    var seen = false;
                    failed.Message += (_, __) => seen = true;
                    failed.Write("info", "still mirrored");
                    Check(seen);
                }
            }
            finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
            return checks;
        }
    }
}
