import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { asMap } from '../dist/protocol.js';
import { decode, encode } from '@msgpack/msgpack';
import { decodeMessage, NavigationQuery, OpenAxisClient, ConnectionState, UNAVAILABLE, createNavigationObserver } from '../dist/index.js';

const fixture = name => JSON.parse(readFileSync(new URL(`../../../fixtures/openaxis-1.0/${name}.json`, import.meta.url)));
test('map validation accepts plain objects across realms and rejects non-map objects', () => {
  for (const expression of ['({ value: 1 })', 'Object.assign(Object.create(null), { value: 1 })']) {
    const value = runInNewContext(expression);
    assert.equal(asMap(value), value);
  }
  for (const expression of ['[]', 'new Uint8Array(2)', 'new Date()', 'new Map()', 'new (class Example {})()']) {
    assert.throws(() => asMap(runInNewContext(expression)), /must be a map/);
  }
});
test('observer fallback accepts future event names and optional fields', () => {
  const seen = [];
  const observer = createNavigationObserver({ gesture_started: v => seen.push(v.gestureId) }, e => seen.push(e.event));
  observer({ event: 'gesture_started', values: { gestureId: 7, future: true } });
  observer({ event: 'future_event', values: { future: true } });
  observer({ event: 'constructor', values: {} });
  assert.deepEqual(seen, [7, 'future_event', 'constructor']);
});
for (const c of fixture('wire').cases) test(`wire: ${c.name}`, () => {
  const parse = () => decodeMessage(Uint8Array.from(Buffer.from(c.hex, 'hex')));
  if (c.valid) parse(); else assert.throws(parse);
});
for (const c of fixture('queries').cases) for (const asynchronous of [false, true]) test(`query: ${c.name} async=${asynchronous}`, async () => {
  const q = new NavigationQuery({ type: 'request', id: 1, method: 'navigation.query', params: c.params }, () => {}, () => {});
  const calls = [];
  const resolve = name => { calls.push(name); return c.facts[name] ?? UNAVAILABLE };
  assert.deepEqual(asynchronous ? await q.evaluateAsync(async name => resolve(name)) : q.evaluate(resolve), c.result);
  assert.deepEqual(calls, c.calls);
});

test('client lifecycle, malformed requests, and terminal connection ownership', async () => {
  const events = [[], []]; let retained; let inline = false;
  const ordinary = { onMotionStart: id => events[0].push(['start', id]), onMotionEnd: id => events[0].push(['end', id]) };
  const navigation = { onMotionStart: id => { events[1].push(['start', id]); throw Error('passive') }, onMotionEnd: id => events[1].push(['end', id]),
    onStateChange: () => { throw Error('passive') },
    onNavigationQuery: query => { retained = query; if (inline) { query.complete({ values: {} }); return false } return true } };
  const c = new OpenAxisClient({ clientName: 'contract' }, ordinary);
  c.attachNavigation(navigation);
  const socket = () => ({ readyState: 1, sent: [], send(b) { this.sent.push(decode(b)) }, close() { this.readyState = 3 } });
  const old = c.socket = socket(); c.connectionState = ConnectionState.Connected;
  for (const m of fixture('client').lifecycle) c.handleMessage(encode(m));
  assert.deepEqual(events[0], [['start', 7], ['end', 7]]); assert.deepEqual(events[1], events[0]);
  for (const m of fixture('client').malformed_requests) c.handleMessage(encode(m));
  assert.deepEqual(old.sent.map(m => [m.id, m.error.code]), fixture('client').malformed_requests.map(m => [m.id, 'bad_request']));
  c.handleMessage(encode({ type: 'request', id: 90, method: 'navigation.query' }));
  const replacement = c.socket = socket();
  assert.throws(() => retained.complete({ values: {} }), /retired/); assert.equal(retained.completed, true);
  assert.deepEqual(replacement.sent, []); assert.throws(() => retained.fail('unavailable'), /already/);
  inline = true; c.handleMessage(encode({ type: 'request', id: 91, method: 'navigation.query' }));
  assert.equal(replacement.sent.length, 1); assert.ok(replacement.sent[0].result);
  await c.disconnect(); assert.equal(c.state, ConnectionState.Disconnected); assert.equal(replacement.readyState, 3);
});

test('query validation precedes terminal claim', () => {
  const q = new NavigationQuery({ type: 'request', id: 1, method: 'navigation.query', params: {} }, () => { throw Error('send failed') }, () => {});
  assert.throws(() => q.complete([])); assert.equal(q.completed, false);
  assert.throws(() => q.complete({}), /send failed/); assert.equal(q.completed, true);
});
