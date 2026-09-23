import assert from "node:assert/strict";
import test from "node:test";
import { readlink } from "node:fs/promises";
import { currentProcessId } from "../dist/index.js";

test("current process identity uses the actual namespace and PID", async () => {
  const expected = process.platform === "linux"
    ? `${(await readlink("/proc/self/ns/pid")).slice(5, -1)}:${process.pid}` : String(process.pid);
  assert.equal(await currentProcessId(), expected);
});
test("browser does not invent a process identity", async () => {
  const saved = globalThis.process;
  try { globalThis.process = undefined; await assert.rejects(currentProcessId(), /unavailable/); }
  finally { globalThis.process = saved; }
});
