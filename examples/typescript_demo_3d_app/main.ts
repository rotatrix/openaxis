import { MyApplication } from "./application.js";
import { MyOpenAxisIntegration, showDiagnostics } from "./integration.js";

const options = new URLSearchParams(location.search);
const app = new MyApplication();
app.mount();
const integration = new MyOpenAxisIntegration(
  app,
  options.has("debug"),
  options.get("url") ?? undefined,
);
integration.start();
const stopDiagnostics = showDiagnostics(
  integration,
  document.getElementById("diagnostics-output")!,
  app.renderer!.domElement,
  () => app.camera,
  (context) => app.alive && context === app,
);
let frame: number;
function render() {
  const diagnostics = integration.diagnostics.presentation();
  app.setDiagnosticPoints(
    integration.diagnostics.enabled && diagnostics.context === app
      ? diagnostics.segments.flatMap((segment) => [segment.start, segment.end])
      : [],
  );
  app.render();
  frame = requestAnimationFrame(render);
}
render();

let stopping: Promise<void> | undefined;
export function shutdown(): Promise<void> {
  if (stopping) return stopping;
  app.finishEdit(false);
  app.alive = false;
  cancelAnimationFrame(frame);
  stopDiagnostics();
  return (stopping = integration.stop().finally(() => app.dispose()));
}
// A cached page keeps its scene; the integration reconnects on pageshow.
window.addEventListener("pagehide", (event) => {
  if (!event.persisted)
    void shutdown().catch((error) =>
      console.error("Demo shutdown failed", error),
    );
});
