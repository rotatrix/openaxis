using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace OpenAxis
{
    public static class ProcessIdentity
    {
        [DllImport("libc", SetLastError = true)]
        private static extern IntPtr readlink(string path, byte[] buffer, UIntPtr size);

        /// <summary>Current native process identity for Target.Pid. Throws if unavailable.</summary>
        public static string Current()
        {
            using var process = Process.GetCurrentProcess();
            var pid = process.Id.ToString(CultureInfo.InvariantCulture);
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
            {
                var buffer = new byte[128];
                var count = readlink("/proc/self/ns/pid", buffer, (UIntPtr)buffer.Length).ToInt64();
                if (count <= 0 || count >= buffer.Length) throw new InvalidOperationException("PID namespace unavailable");
                var match = Regex.Match(Encoding.UTF8.GetString(buffer, 0, (int)count), @"\Apid:\[([1-9][0-9]*)\]\z");
                if (!match.Success) throw new InvalidOperationException("PID namespace unavailable");
                return match.Groups[1].Value + ":" + pid;
            }
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows) || RuntimeInformation.IsOSPlatform(OSPlatform.OSX)) return pid;
            throw new PlatformNotSupportedException("Unsupported process identity platform");
        }
    }
}
