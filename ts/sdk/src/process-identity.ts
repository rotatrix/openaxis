/** Current native process identity for target.pid; browsers have no OS PID. */
export async function currentProcessId(): Promise<string> {
  const process = (globalThis as unknown as { process?: { pid: number; platform: string; versions?: { node?: string } } }).process;
  if (!process?.versions?.node) throw new Error("Process identity unavailable in this runtime");
  if (process.platform === "linux") {
    const moduleName = "node:fs/promises";
    const fs = await import(moduleName);
    const namespace: string = await fs.readlink("/proc/self/ns/pid");
    const match = /^pid:\[([1-9][0-9]*)\]$/.exec(namespace);
    if (!match) throw new Error("PID namespace unavailable");
    return `${match[1]}:${process.pid}`;
  }
  if (process.platform === "win32" || process.platform === "darwin") return String(process.pid);
  throw new Error("Unsupported process identity platform");
}
