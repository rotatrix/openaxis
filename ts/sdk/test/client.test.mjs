import assert from "node:assert/strict";
import test from "node:test";
import { proof, trust } from "./authorization-helper.mjs";
import { decode, encode } from "@msgpack/msgpack";
import { ConnectionState, OpenAxisClient, PROTO_VERSION } from "../dist/index.js";

const bytes = value => {
  const encoded = encode(value);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
};

class FakeWebSocket {
  static instances = [];
  readyState = 0;
  binaryType = "";
  sent = [];
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;

  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  open() { this.readyState = 1; this.onopen?.({}) }
  message(value) { this.onmessage?.({ data: bytes(value) }) }
  send(value) { const m=decode(value); this.sent.push(m); if(m.type==="request"&&m.method==="q")queueMicrotask(()=>this.message({type:"response",id:m.id,result:proof(m.params.c)})); }
  close() { this.readyState = 3; this.onclose?.({}) }
}

globalThis.WebSocket = FakeWebSocket;

test("verification failure prevents Connected", async () => {
  const states=[];
  const client=new OpenAxisClient({clientName:"untrusted"},{onStateChange:s=>states.push(s)});
  const connecting=client.connect();const socket=FakeWebSocket.instances.at(-1);
  socket.open();socket.message({type:"hello_ack",proto:PROTO_VERSION,server_name:"test"});
  await assert.rejects(connecting,/invalid_proof/);
  assert.equal(client.state,ConnectionState.Disconnected);
  assert.ok(!states.includes(ConnectionState.Connected));
});

test("browser connects without q or identity", async () => {
  const original=globalThis.process, oldSelf=globalThis.self;
  const client=new OpenAxisClient({clientName:"browser"});
  try {
    globalThis.process=undefined;globalThis.self={};
    const connecting=client.connect();const socket=FakeWebSocket.instances.at(-1);
    socket.open();socket.message({type:"hello_ack",proto:PROTO_VERSION,server_name:"test"});
    await connecting;
    assert.equal(client.verificationStatus,"not_checked_browser");
    assert.equal(socket.sent.filter(m=>m.type==="request").length,0);
    await client.disconnect();
  } finally {globalThis.process=original;globalThis.self=oldSelf;await client.disconnect();}
});

async function connect(listener = {}) {
  const client = trust(new OpenAxisClient({ clientName: "test" }, listener));
  const connecting = client.connect();
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();
  assert.deepEqual(socket.sent[0], { type: "hello", proto: PROTO_VERSION, client_name: "test", sdk: { name: "openaxis-typescript", version: "1.0.0-rc.1" } });
  assert.equal(client.state, ConnectionState.Connecting);
  socket.message({ type: "hello_ack", proto: PROTO_VERSION, server_name: "test-server" });
  await connecting;
  assert.equal(client.state, ConnectionState.Connected);
  return { client, socket };
}

test("connect waits for a validated hello_ack", async () => {
  const states = [];
  const { client } = await connect({ onStateChange: state => states.push(state) });
  assert.deepEqual(states, [ConnectionState.Connecting, ConnectionState.Connected]);
  await client.disconnect();
  assert.equal(client.state, ConnectionState.Disconnected);
});

test("request IDs stop at the shared maximum instead of wrapping", async () => {
  const { client, socket } = await connect();
  client.nextRequestId = Number.MAX_SAFE_INTEGER;
  const pending = client.request("example", {});
  const request = socket.sent.at(-1);
  assert.equal(request.id, Number.MAX_SAFE_INTEGER);
  socket.message({ type: "response", id: request.id, result: {} });
  await pending;
  assert.throws(() => client.request("example", {}), /exhausted/);
  await client.disconnect();
});

test("disconnect after hello_ack cannot resurrect the retired socket", async () => {
  const client = new OpenAxisClient({ clientName: "retired-handshake" });
  const connecting = client.connect();
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();
  socket.message({ type: "hello_ack", proto: PROTO_VERSION, server_name: "test-server" });
  await client.disconnect();
  await assert.rejects(connecting, /closed during handshake/);
  assert.equal(client.state, ConnectionState.Disconnected);
  assert.equal(socket.readyState, 3);
});

test("client declares an optional target in hello", async () => {
  const client = trust(new OpenAxisClient({ clientName: "Inventor", clientVersion: "2.3.4", target: { pid: "18432", app: "Inventor", app_version: "2027.1" } }));
  const connecting = client.connect();
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();
  assert.deepEqual(socket.sent[0].target, { pid: "18432", app: "Inventor", app_version: "2027.1" });
  assert.equal(socket.sent[0].client_version, "2.3.4");
  socket.message({ type: "hello_ack", proto: PROTO_VERSION, server_name: "test-server" });
  await connecting;
  await client.disconnect();
  assert.throws(() => new OpenAxisClient({ clientName: "bad", target: { pid: 0 } }), /positive/);
  assert.throws(() => new OpenAxisClient({ clientName: "bad", target: {} }), /requires pid or app/);
});

test("disconnect cancels an in-progress handshake", async () => {
  const client = new OpenAxisClient({ clientName: "test", handshakeTimeoutMs: 1_000 });
  const connecting = client.connect();
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();
  await client.disconnect();
  await assert.rejects(connecting, /connection closed/);
  assert.equal(client.state, ConnectionState.Disconnected);
});

test("correlated requests resolve and reject", async () => {
  const { client, socket } = await connect();
  const success = client.request("example.success", { value: 1 });
  const request = socket.sent.at(-1);
  socket.message({ type: "response", id: request.id, result: { ok: true } });
  assert.deepEqual(await success, { ok: true });

  const failure = client.request("example.failure");
  const failedRequest = socket.sent.at(-1);
  socket.message({ type: "response", id: failedRequest.id, error: { code: "unavailable", message: "not now" } });
  await assert.rejects(failure, error => error.code === "unavailable");
  await client.disconnect();
});

test("command requests protect their method-owned name", async () => {
  const { client, socket } = await connect();
  const command = client.executeCommand("view.fit", { animated: false });
  const request = socket.sent.at(-1);
  assert.deepEqual(request, {
    type: "request", id: request.id, method: "command.execute",
    params: { name: "view.fit", animated: false },
  });
  socket.message({ type: "response", id: request.id, result: {} });
  await command;
  await assert.rejects(client.executeCommand("view.fit", { name: "different" }), /reserved 'name'/);
  await client.disconnect();
});

test("disconnect rejects pending requests", async () => {
  const { client } = await connect();
  const pending = client.request("example.pending", {}, { timeoutMs: null });
  await client.disconnect();
  await assert.rejects(pending, /connection closed/);
});

test("navigation.query is typed and unknown requests receive unsupported", async () => {
  const { client, socket } = await connect({
    onNavigationQuery(query) {
      query.complete(query.evaluate(name => name === "document.id" ? "doc" : undefined));
      return true;
    },
  });
  socket.message({ type: "request", id: 7, method: "navigation.query", params: { values: ["document.id"] } });
  assert.deepEqual(socket.sent.at(-1), { type: "response", id: 7, result: { values: { "document.id": "doc" } } });
  socket.message({ type: "request", id: 8, method: "future.method", params: {} });
  assert.equal(socket.sent.at(-1).error.code, "unsupported");
  await client.disconnect();
});

test("unknown messages are delivered as extensions", async () => {
  const extensions = [];
  const { client, socket } = await connect({ onExtension: (type, message) => extensions.push([type, message]) });
  socket.message({ type: "com.example.message", value: 1 });
  assert.deepEqual(extensions, [["com.example.message", { type: "com.example.message", value: 1 }]]);
  await client.disconnect();
});
