import { OpenAxisClient, OpenAxisConnectionManager } from "@openaxis/sdk";

// Call at browser application startup; await the returned function at teardown.
export function startAxisStreaming(): () => Promise<void> {
  let axes: readonly string[] = [];
  const client = new OpenAxisClient({ clientName: "axis-example" }, {
    onAxes(value) { axes = value; },
    onFrame(frame) {
      console.log(frame.t_us, Object.fromEntries(axes.map((axis, i) => [axis, frame.values[i]])));
    },
  });
  const connection = new OpenAxisConnectionManager(client, {
    metadata: () => ({
      tags: ["app.axis-example"], axes: ["tx", "ty", "tz", "rx", "ry", "rz"],
      focused: document.hasFocus(),
    }),
  });
  const pending = new Set<Promise<void>>();
  const refresh = () => {
    const update = connection.refreshMetadata().catch(console.error);
    pending.add(update);
    void update.then(() => pending.delete(update));
  };
  window.addEventListener("focus", refresh);
  window.addEventListener("blur", refresh);
  const running = connection.start().catch(console.error);
  return async () => {
    window.removeEventListener("focus", refresh);
    window.removeEventListener("blur", refresh);
    await connection.stop();
    await running;
    await Promise.allSettled(pending);
  };
}
