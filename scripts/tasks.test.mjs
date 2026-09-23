import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateTests, testSteps, buildSteps, needsConfigure } from './tasks.mjs';
import { browserServer, endpoint } from './demo.mjs';

test('CMake configuration is reused only for generated builds with matching options and source', () => {
  const directory = mkdtempSync(join(tmpdir(), 'openaxis-configure-'));
  const build = join(directory, 'build');
  const args = ['-S', '.', '-B', 'build', '-DOPENAXIS_BUILD_DEMO=ON'];
  try {
    assert.equal(needsConfigure(args, directory), true);
    mkdirSync(build);
    writeFileSync(join(build, 'CMakeCache.txt'),
      `CMAKE_HOME_DIRECTORY:INTERNAL=${directory.replaceAll('\\', '/')}\r\nOPENAXIS_BUILD_DEMO:BOOL=ON\r\n`);
    assert.equal(needsConfigure(args, directory), true, 'failed configure must be retried');
    writeFileSync(join(build, 'Makefile'), '');
    assert.equal(needsConfigure(args, directory), false);
    assert.equal(needsConfigure([...args.slice(0, -1), '-DOPENAXIS_BUILD_DEMO=OFF'], directory), true);
    assert.equal(needsConfigure(['-S', 'other', ...args.slice(2)], directory), true);
    assert.equal(needsConfigure([...args, '-DNEW_OPTION=ON'], directory), true);
  } finally { rmSync(directory, { recursive: true }); }
});
test('cs selects the same build and private test coverage as csharp', () => {
  assert.deepEqual(buildSteps('cs'), buildSteps('csharp'));
  assert.deepEqual(testSteps('cs', '/private/tests'), testSteps('csharp', '/private/tests'));
});

test('an explicit missing private suite fails rather than silently reducing coverage', () => {
  assert.throws(() => privateTests(join(tmpdir(), 'nonexistent-openaxis-private-suite')), /not found/);
});
test('public-only and private test plans use the same public checks', () => {
  const publicSteps = testSteps('python');
  const allSteps = testSteps('python', '/external/private/tests');
  assert.deepEqual(allSteps.slice(0, publicSteps.length), publicSteps);
  assert.deepEqual(allSteps.at(-1), ['Private verification', process.execPath,
    [join('/external/private/tests', 'run.mjs'), 'python']]);
  assert.ok(!buildSteps('csharp').some(step => step[2].includes('--test')));
});
test('browser server serves built assets and passes the endpoint intact', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'openaxis-demo-'));
  writeFileSync(join(directory, 'typescript-demo-3d-app.html'), 'built viewer');
  const target = 'ws://localhost:6607/path?a=1&b=2';
  const { server, url } = await browserServer(directory, target);
  try {
    assert.equal(new URL(url).searchParams.get('url'), target);
    assert.equal(await (await fetch(url)).text(), 'built viewer');
    assert.equal((await fetch(new URL('/..%2foutside', url))).status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true });
  }
});
test('demo endpoints must use WebSockets', () => {
  assert.throws(() => endpoint('https://localhost'));
  assert.throws(() => endpoint('ws://localhost:invalid'));
  assert.equal(endpoint('ws://localhost:6607'), 'ws://localhost:6607');
});
