import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { OpenAxisConnectionManager, configureLogging } from '../../ts/sdk/dist/index.js';

test('focus changes use managed snapshots, including pause and resume', async () => {
  let disconnectGate;
  let focused = true;
  const client = {
    url: 'ws://localhost:6607', state: 'disconnected', listeners: new Set(), messages: [], attempts: 0,
    set(state) { this.state = state; for (const l of this.listeners) l.onStateChange?.(state); },
    async connect() { this.attempts++; this.set('connected'); },
    async disconnect() { await disconnectGate; this.set('disconnected'); },
    addListener(l) { this.listeners.add(l); return () => this.listeners.delete(l); },
    captureNavigationSender() {
      const attempt = this.attempts;
      return m => {
        if (this.state !== 'connected' || attempt !== this.attempts) throw Error('retired');
        this.messages.push(m);
      };
    },
  };
  const context = {
    OpenAxisConnectionManager, configureLogging, console, setTimeout, clearTimeout,
    addEventListener() {}, removeEventListener() {},
    document: { hidden: false, hasFocus: () => focused, addEventListener() {}, removeEventListener() {} },
  };
  const source = readFileSync(new URL('./lib/focus-manager.js', import.meta.url), 'utf8')
    .replace(/^import .*$/m, '').replaceAll('export ', '');
  runInNewContext(source + '\nglobalThis.FocusManager = FocusManager;', context);
  const focus = new context.FocusManager(client, { metadata: () => ({ tags: ['demo'] }) });
  async function until(predicate) {
    const end = Date.now() + 2000;
    while (!predicate()) { assert.ok(Date.now() < end, 'condition timed out'); await new Promise(r => setTimeout(r, 1)); }
  }
  const lastFocus = () => client.messages.filter(m => m.type === 'focus').at(-1)?.focused;
  try {
    await until(() => focus.lifecycle.state === 'ready');
    assert.equal(lastFocus(), true);
    focus.onBlur(); // Respect the event even before document.hasFocus() changes.
    await until(() => lastFocus() === false);
    focus.onFocus();
    await until(() => lastFocus() === true);
    focus.pause();
    await until(() => focus.lifecycle.state === 'stopped');
    assert.equal(lastFocus(), false);
    focus.resume();
    await until(() => client.attempts === 2 && focus.lifecycle.state === 'ready');
    assert.equal(lastFocus(), true);
    assert.deepEqual(client.messages.filter(m => m.type === 'tags').at(-1).tags, ['demo']);
    // History restoration can arrive before the previous connection finishes
    // stopping, and before the restored document regains focus.
    for (const restoreFocused of [true, false]) {
      const attempts = client.attempts;
      let finishDisconnect;
      disconnectGate = new Promise(resolve => { finishDisconnect = resolve; });
      focus.onPageHide();
      focused = restoreFocused;
      focus.onPageShow();
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(client.attempts, attempts);
      finishDisconnect();
      await focus.stopping;
      disconnectGate = undefined;
      if (!restoreFocused) {
        assert.equal(client.attempts, attempts);
        focused = true;
        focus.onFocus();
      }
      await until(() => client.attempts === attempts + 1 && focus.lifecycle.state === 'ready');
      assert.equal(lastFocus(), true);
    }
  } finally {
    focus.destroy();
    await focus.stopping;
  }
});
