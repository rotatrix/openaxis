import test from 'node:test';
import assert from 'node:assert/strict';
import { NavigationQuery, NavigationDiagnostics, UNAVAILABLE } from '../dist/index.js';

for (const asynchronous of [false, true]) test(`pick marker metadata stays local (${asynchronous ? 'async' : 'sync'})`, async () => {
  const names = ['pick.cursor.selection', 'pick.cursor', 'pick.viewport_center', 'pick.viewport_center.selection'];
  const query = new NavigationQuery({ id: 7, method: 'navigation.query', params: { values: names.slice(0, 2), first: names } }, () => {}, () => {});
  const diagnostics = new NavigationDiagnostics({ enabled: true });
  diagnostics.observe('query_started', { query });
  const samples = [UNAVAILABLE, { markerPosition: [-.5, .25] }, { point: [1, 2, 3], markerPosition: [0, 0] }];
  const calls = [];
  const resolve = name => {
    calls.push(name);
    const value = samples[names.indexOf(name)];
    diagnostics.observe('fact', { query, name, value, durationMs: 0 });
    return value;
  };
  const result = asynchronous ? await query.evaluateAsync(async name => resolve(name)) : query.evaluate(resolve);
  assert.deepEqual(result, { values: {}, first: { name: names[2], value: { point: [1, 2, 3] } } });
  assert.deepEqual(calls, names.slice(0, 3));
  assert.deepEqual(samples[2].markerPosition, [0, 0]);
  const frame = diagnostics.presentation();
  assert.deepEqual(frame.markers.map(m => [m.label, m.point]), [[names[1], [-.5, .25]], [names[2], [0, 0]]]);
  assert.equal(frame.segments.length, 3);
});
