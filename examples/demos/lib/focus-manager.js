import { OpenAxisConnectionManager, configureLogging } from "../../../ts/sdk/src/index.js";

/** Demo-only policy: report focus without closing; disconnect on page exit. */
export class FocusManager {
  constructor(client, { metadata = () => ({}), onPauseChange, onState } = {}) {
    this.onPauseChange = onPauseChange;
    this.paused = false;
    this.active = false;
    this.pageHidden = false;
    this.timer = undefined;
    this.stopping = Promise.resolve();
    this.generation = 0;
    this.focused = false;
    configureLogging("web-demo");
    this.lifecycle = new OpenAxisConnectionManager(client, {
      metadata: () => ({ ...metadata(), focused: this.focused && this.hasControlFocus() }),
      onState,
    });
    this.onFocus = () => {
      this.reportFocus(this.hasControlFocus());
      this.scheduleConnect();
    };
    this.onBlur = () => {
      this.generation++;
      clearTimeout(this.timer);
      this.timer = undefined;
      this.reportFocus(false);
    };
    this.onPageHide = () => {
      this.pageHidden = true;
      this.disconnectNow();
    };
    this.onPageShow = () => {
      this.pageHidden = false;
      this.onFocus();
    };
    this.onVisibilityChange = () => {
      if (document.hidden) this.onBlur();
      else this.onFocus();
    };
    this.onAlt = event => {
      // Keep Alt navigation modifiers from focusing the browser menu on release.
      if (event.key === "Alt" && this.hasControlFocus()) event.preventDefault();
    };
    this.start();
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.focused = this.hasControlFocus();
    addEventListener("focus", this.onFocus);
    addEventListener("blur", this.onBlur);
    addEventListener("pagehide", this.onPageHide);
    addEventListener("pageshow", this.onPageShow);
    addEventListener("keydown", this.onAlt);
    addEventListener("keyup", this.onAlt);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    if (document.hasFocus()) this.scheduleConnect();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.generation++;
    removeEventListener("focus", this.onFocus);
    removeEventListener("blur", this.onBlur);
    removeEventListener("pagehide", this.onPageHide);
    removeEventListener("pageshow", this.onPageShow);
    removeEventListener("keydown", this.onAlt);
    removeEventListener("keyup", this.onAlt);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  isPaused() { return this.paused }

  hasControlFocus() {
    return this.active && !this.paused && !this.pageHidden && !document.hidden && document.hasFocus();
  }

  reportFocus(focused) {
    this.focused = focused;
    void this.lifecycle.refreshMetadata().catch(error => console.debug("OpenAxis focus refresh interrupted", error));
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.onPauseChange?.(true);
    this.scheduleDisconnect();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.onPauseChange?.(false);
    this.onFocus();
  }

  scheduleConnect() {
    clearTimeout(this.timer);
    const generation = ++this.generation;
    if (!this.hasControlFocus()) return;
    this.timer = setTimeout(async () => {
      await this.stopping;
      if (generation !== this.generation || !this.hasControlFocus()) return;
      void this.lifecycle.start().catch(error => console.error("OpenAxis lifecycle stopped", error));
    }, 0);
  }

  scheduleDisconnect() {
    clearTimeout(this.timer);
    this.generation++;
    this.reportFocus(false);
    this.timer = setTimeout(() => this.disconnectNow(), 0);
  }

  disconnectNow() {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.reportFocus(false);
    this.stopping = this.lifecycle.stop();
  }

  destroy() {
    this.stop();
    this.disconnectNow();
    return this.stopping;
  }
}

export function manageFocus(client, options) { return new FocusManager(client, options) }
