import assert from "node:assert/strict";
import test from "node:test";
import { OpenAxisConnectionManager } from "../dist/index.js";

class Client {
  url = "ws://localhost:6607";
  state = "disconnected";
  listeners = new Set();
  attempts = 0;
  failures = 0;
  messages = [];
  block = false;
  set(state) { this.state = state; for (const l of this.listeners) l.onStateChange?.(state) }
  addListener(l) { this.listeners.add(l); return () => this.listeners.delete(l) }
  async connect() {
    this.attempts++;
    this.set("connecting");
    if (this.block) await new Promise((_, reject) => { this.reject = reject });
    if (this.attempts <= this.failures) throw Error("offline");
    this.set("connected");
  }
  async disconnect() { this.reject?.(Error("closed")); this.set("disconnected") }
  captureNavigationSender() {
    const generation = this.attempts;
    return message => {
      if (this.state !== "connected" || generation !== this.attempts) throw Error("retired");
      this.messages.push([generation, message]);
    };
  }
}
const until = async predicate => {
  const end = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < end, "condition timed out"); await new Promise(r => setTimeout(r, 1)) }
};
const options = more => ({ metadata: () => ({ capabilities: ["navigation"] }),
  retry: { initialDelayMs: 5, maxDelayMs: 20, jitter: 0 }, ...more });

test("SDK logs retries, ready and stop without an application observer", async () => {
  const client = new Client(); client.failures = 1;
  const messages = [];
  const lifecycle = new OpenAxisConnectionManager(client, options({ log: (...args) => messages.push(args) }));
  const run = lifecycle.start();
  await until(() => lifecycle.state === "ready");
  await lifecycle.stop(); await run;
  assert.deepEqual(messages.map(m => m[0]), ["info", "warning", "info", "info"]);
  assert.match(messages[1][1], /offline.*retrying in/);
  assert.match(messages.at(-2)[1], /openaxis\/1.0/);
  assert.equal(messages.at(-1)[1], "connection stopped");
});

test("a failing log sink does not interrupt connection or shutdown", async () => {
  const lifecycle = new OpenAxisConnectionManager(new Client(), options({ log: () => { throw Error("sink failed") } }));
  const run = lifecycle.start();
  await until(() => lifecycle.state === "ready");
  await lifecycle.stop(); await run;
  assert.equal(lifecycle.state, "stopped");
});

test("retry, latest metadata replay, duplicate start, and restart", async () => {
  const client = new Client(); client.failures = 2;
  let tags = ["first"];
  const events = [];
  const lifecycle = new OpenAxisConnectionManager(client, options({ metadata: () => ({ tags, axes: [], focused: false }),
    onState: (...event) => events.push(event) }));
  const run = lifecycle.start();
  assert.equal(lifecycle.start(), run);
  await until(() => lifecycle.state === "ready");
  assert.equal(client.attempts, 3);
  assert.deepEqual(events.filter(e => e[0] === "retrying").map(e => e[2]), [5, 10]);
  assert.deepEqual(client.messages.map(m => m[1].type), ["tags", "capabilities", "subscribe", "focus"]);
  tags = ["second"];
  await lifecycle.refreshMetadata();
  await client.disconnect();
  await until(() => client.attempts === 4 && lifecycle.state === "ready");
  assert.deepEqual(client.messages.at(-4)[1].tags, tags);
  await Promise.all([lifecycle.stop(), lifecycle.stop()]);
  await run;
  assert.equal(client.listeners.size, 0);
  assert.equal(lifecycle.state, "stopped");
  lifecycle.start();
  await until(() => lifecycle.state === "ready");
  await lifecycle.stop();
});

test("stop interrupts handshake and long retry; timeout retries", async () => {
  for (const block of [true, false]) {
    const client = new Client(); client.block = block; client.failures = 100;
    const lifecycle = new OpenAxisConnectionManager(client, options({ retry: { initialDelayMs: 60000, maxDelayMs: 60000 } }));
    const run = lifecycle.start();
    await until(() => block ? client.attempts > 0 : lifecycle.state === "retrying");
    await lifecycle.stop(); await run;
    assert.equal(client.state, "disconnected");
    assert.equal(client.attempts, 1);
  }
  const client = new Client(); client.block = true;
  const lifecycle = new OpenAxisConnectionManager(client, options({ startupTimeoutMs: 5 }));
  lifecycle.start();
  await until(() => client.attempts >= 2);
  await lifecycle.stop();
});

test("early close and metadata failure do not announce readiness", async () => {
  for (const close of [true, false]) {
    const client = new Client();
    const states = [];
    const lifecycle = new OpenAxisConnectionManager(client, options({ metadata: () => {
      if (!close) throw Error("bad snapshot");
      client.set("disconnected"); return {};
    }, onState: s => states.push(s) }));
    lifecycle.start();
    await until(() => lifecycle.state === "retrying");
    await lifecycle.stop();
    assert.ok(!states.includes("ready"));
    assert.deepEqual(client.messages, []);
  }
});

test("custom startup completes before metadata, and accepts cancellation", async () => {
  const client = new Client(); let initialized = false;
  const lifecycle = new OpenAxisConnectionManager(client, options({
    connect: async signal => {
      await client.connect();
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      initialized = true;
    }, metadata: () => { assert.ok(initialized); return {} },
  }));
  lifecycle.start();
  await until(() => client.state === "connected");
  await lifecycle.stop();
  assert.deepEqual(client.messages, []);
});

test("invalid timing and externally connected clients are rejected", () => {
  const client = new Client();
  assert.throws(() => new OpenAxisConnectionManager(client, options({ retry: { jitter: NaN } })));
  client.set("connected");
  assert.throws(() => new OpenAxisConnectionManager(client, options()).start());
});
