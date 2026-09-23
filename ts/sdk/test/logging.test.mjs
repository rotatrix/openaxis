import assert from "node:assert/strict";
import test from "node:test";
import { configureLogging, NavigationDiagnostics } from "../dist/index.js";

test("session header uses package version and host-supplied client version", async () => {
  const { readFileSync } = await import("node:fs");
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
  const seen = [];
  const options = { clientVersion: '2.3.4', sinks: [(level, message) => seen.push(message)] };
  const log = configureLogging('header-test', options);
  assert.equal(seen[0], `OpenAxis SDK ${version} (TypeScript); client=header-test; client_version=2.3.4`);
  configureLogging('header-test', options);
  assert.equal(seen.length, 1);
  log.close();
});

test("SDK diagnostics and host messages share configured sinks", () => {
  const records = [];
  const log = configureLogging("test", { sinks: [
    () => { throw new Error("broken UI") },
    (level, message) => records.push([level, message]),
  ] });
  log.write("info", "host message");
  log.write("debug", "hidden");
  new NavigationDiagnostics().observe("gesture_started", { gestureId: 1 });
  assert.equal(records.length, 3);
  assert.match(records[0][1], /OpenAxis SDK .*client=test/);
  assert.equal(records[1][1], "host message");
  assert.match(records[2][1], /gesture_started/);
  log.debug = true;
  log.write("debug", "visible");
  assert.equal(records.at(-1)[1], "visible");
});


test("shared logging contract", async () => {
  const { readFileSync } = await import("node:fs");
  const { DiagnosticLog, formatLogRecord, normalizeLogLevel } = await import("../dist/index.js");
  const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/openaxis-1.0/logging.json", import.meta.url)));
  const records = [];
  const log = new DiagnosticLog("conformance", { sinks: [(level, message) => records.push([level, message])] });
  for (const record of fixture.records) {
    assert.equal(normalizeLogLevel(record.level), record.normalized);
    assert.equal(formatLogRecord(record.level, record.message, new Date(fixture.epoch_ms), fixture.offset_minutes), record.line);
    log.write(record.level, record.message);
  }
  assert.deepEqual(records.slice(1).map(r => r[0]), fixture.records.filter(r => fixture.debug_off.includes(r.normalized)).map(r => r.normalized));
  const before = records.length;
  log.close(); log.write("info", "after close");
  assert.equal(records.length, before);
  for (const client of fixture.invalid_clients) assert.throws(() => new DiagnosticLog(client));
  const configured = fixture.configuration.map(client => configureLogging(client, { sinks: [] }));
  assert.equal(configured[0], configured[2]); assert.notEqual(configured[0], configured[1]);
  configured[0].close(); assert.notEqual(configureLogging(fixture.configuration[0], { sinks: [] }), configured[0]);
});
