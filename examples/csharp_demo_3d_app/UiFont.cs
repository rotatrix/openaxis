using System.Buffers.Binary;
using System.Diagnostics;

namespace OpenAxisDemo;

internal static class UiFont
{
    public static (string Path, float HeightPerEm)? Find()
    {
        string[] candidates = OperatingSystem.IsWindows()
            ? [.. new[] { "segoeui.ttf", "tahoma.ttf", "arial.ttf" }
                .Select(name => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Fonts), name))]
            : OperatingSystem.IsMacOS()
                ? ["/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf",
                   "/System/Library/Fonts/Supplemental/Verdana.ttf",
                   "/System/Library/Fonts/Supplemental/Tahoma.ttf"]
                : ["/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
                   "/usr/share/fonts/noto/NotoSans-Regular.ttf",
                   "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                   "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
                   "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
                   "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
                   "/usr/share/fonts/liberation-sans/LiberationSans-Regular.ttf"];
        // Fontconfig honors the Linux desktop's configured sans-serif family,
        // including fonts installed outside the common distribution paths above.
        if (OperatingSystem.IsLinux() && FontconfigMatch() is string preferred)
            candidates = [preferred, .. candidates];
        foreach (var path in candidates)
        {
            if (!File.Exists(path)) continue;
            try { return (path, HeightPerEm(path)); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            catch (ArgumentOutOfRangeException) { }
        }
        return null;
    }

    static string? FontconfigMatch()
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo("fc-match")
            {
                ArgumentList = { "--format=%{file}", "sans-serif" },
                UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true,
            });
            if (process == null) return null;
            var output = process.StandardOutput.ReadToEndAsync();
            if (!process.WaitForExit(2000)) { process.Kill(); return null; }
            return process.ExitCode == 0 ? output.GetAwaiter().GetResult().Trim() : null;
        }
        catch (System.ComponentModel.Win32Exception) { return null; }
        catch (InvalidOperationException) { return null; }
    }

    // raylib's TTF size is ascent-to-descent height. Convert UI em sizes using
    // the selected font's own metrics instead of a font-specific multiplier.
    static float HeightPerEm(string path)
    {
        var bytes = File.ReadAllBytes(path);
        ushort U16(int offset) => BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(offset, 2));
        short I16(int offset) => BinaryPrimitives.ReadInt16BigEndian(bytes.AsSpan(offset, 2));
        int head = -1, hhea = -1;
        for (int i = 0; i < U16(4); i++)
        {
            int entry = 12 + 16 * i;
            uint tag = BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(entry, 4));
            uint offset = BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(entry + 8, 4));
            if (offset > bytes.Length) throw new InvalidDataException("Invalid font table offset.");
            if (tag == 0x68656164) head = (int)offset; // head
            if (tag == 0x68686561) hhea = (int)offset; // hhea
        }
        if (head < 0 || hhea < 0) throw new InvalidDataException("Missing font metrics.");
        int units = U16(head + 18), height = I16(hhea + 4) - I16(hhea + 6);
        if (units == 0 || height <= 0) throw new InvalidDataException("Invalid font metrics.");
        return (float)height / units;
    }
}
