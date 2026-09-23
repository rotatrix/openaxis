import { ConnectionState } from "../../../ts/sdk/src/index.js";

const COLORS = {
  ready: "#30c040", retrying: "#e8a030", stopping: "#e8a030", stopped: "#666",
  [ConnectionState.Disconnected]: "#666",
  [ConnectionState.Connecting]: "#e8a030",
  [ConnectionState.Connected]: "#30c040",
  [ConnectionState.Disconnecting]: "#e8a030",
};

const LABELS = {
  ready: "ready", retrying: "reconnecting\u2026", stopping: "stopping\u2026", stopped: "disconnected",
  [ConnectionState.Disconnected]: "disconnected",
  [ConnectionState.Connecting]: "connecting\u2026",
  [ConnectionState.Connected]: "connected",
  [ConnectionState.Disconnecting]: "disconnecting\u2026",
};

const PAUSED_COLOR = "#556688";
const PAUSED_LABEL = "paused";

/**
 * Create a connection status HUD pill overlay.
 * Returns an update(state) function with a .setPaused(boolean) property.
 *
 * Accepts transport states or managed lifecycle states (including ready/retrying).
 * @returns {((state: string) => void) & { setPaused: (paused: boolean) => void }}
 */
export function createStatusHUD({ pauseHint = true } = {}) {
  const wrap = document.createElement("div");
  Object.assign(wrap.style, {
    position: "fixed",
    top: "12px",
    right: "12px",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    zIndex: "9999",
    pointerEvents: "none",
  });

  const hint = document.createElement("div");
  Object.assign(hint.style, {
    fontFamily: "system-ui, sans-serif",
    fontSize: "12px",
    color: "#666",
    transition: "opacity 0.2s",
    opacity: "0",
  });
  wrap.appendChild(hint);

  const el = document.createElement("div");
  Object.assign(el.style, {
    padding: "6px 14px",
    borderRadius: "20px",
    fontFamily: "system-ui, sans-serif",
    fontSize: "13px",
    fontWeight: "600",
    color: "#fff",
    background: COLORS[ConnectionState.Disconnected],
    transition: "background 0.2s",
  });
  el.textContent = LABELS[ConnectionState.Disconnected];
  wrap.appendChild(el);

  document.body.appendChild(wrap);

  let paused = false;
  let lastState = ConnectionState.Disconnected;

  function render() {
    if (paused) {
      el.style.background = PAUSED_COLOR;
      el.textContent = PAUSED_LABEL;
      hint.textContent = "click to resume";
      hint.style.opacity = "1";
    } else {
      el.style.background = COLORS[lastState] || "#666";
      el.textContent = LABELS[lastState] || lastState;
      if ((lastState === ConnectionState.Connected || lastState === "ready") && pauseHint) {
        hint.textContent = "Esc to pause";
        hint.style.opacity = "1";
      } else {
        hint.textContent = "";
        hint.style.opacity = "0";
      }
    }
  }

  function updateHUD(state) {
    lastState = state;
    render();
  }

  updateHUD.setPaused = function (p) {
    paused = p;
    render();
  };

  return updateHUD;
}
