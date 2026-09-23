import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const python = join(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' :
  existsSync(join(root, '.venv-host')) ? '.venv-host/bin/python' : '.venv/bin/python');
export const csharp = join(root, 'examples/csharp_demo_3d_app/bin/Release/net8.0',
  process.platform === 'win32' ? 'OpenAxisDemo.exe' : 'OpenAxisDemo');
export const cpp = join(root, 'cpp/build/demo', process.platform === 'win32' ? 'Release/openaxis_demo.exe' : 'openaxis_demo');
const project = 'examples/csharp_demo_3d_app/OpenAxisDemo.csproj';

export function needsConfigure(args, cwd = root) {
  const source = args.indexOf('-S');
  const build = args.indexOf('-B');
  if (source < 0 || build < 0) return true;
  const directory = resolve(cwd, args[build + 1]);
  const cachePath = join(directory, 'CMakeCache.txt');
  if (!existsSync(cachePath)) return true;
  // A cache alone can remain after failed configuration; require generated files.
  if (!readdirSync(directory).some(name => ['build.ninja', 'Makefile'].includes(name) || name.endsWith('.sln')))
    return true;
  const cache = new Map([...readFileSync(cachePath, 'utf8').matchAll(/^([^:#\r\n]+):[^=\r\n]+=(.*)\r?$/gm)]
    .map(([, key, value]) => [key, value.trim()]));
  const home = cache.get('CMAKE_HOME_DIRECTORY');
  if (!home || resolve(home) !== resolve(cwd, args[source + 1])) return true;
  return args.filter(arg => arg.startsWith('-D')).some(arg => {
    const equal = arg.indexOf('=');
    const key = arg.slice(2, equal).split(':')[0];
    return equal < 0 || cache.get(key) !== arg.slice(equal + 1);
  });
}

export function run(label, command, args, dryRun = false) {
  if (command === 'cmake' && args.includes('-S') && !needsConfigure(args)) {
    console.log(`\n${label}: reusing existing configuration`);
    return;
  }
  console.log(`\n${label}\n> ${command} ${args.join(' ')}`);
  if (dryRun) return;
  if (process.env.BUILD_PHASE_FILE) writeFileSync(process.env.BUILD_PHASE_FILE, label);
  // All pnpm arguments here are fixed task definitions, never user input.
  const windowsPnpm = process.platform === 'win32' && command === 'pnpm';
  const result = spawnSync(windowsPnpm ? 'cmd.exe' : command,
    windowsPnpm ? ['/d', '/s', '/c', `pnpm ${args.join(' ')}`] : args,
    { cwd: root, stdio: 'inherit', env: { ...process.env,
      OPENAXIS_SDK_ROOT: root, PYTHONPATH: join(root, 'py/openaxis/src') } });
  if (result.error || result.status !== 0) throw new Error(`${label} failed: ${result.error?.message ?? result.signal ?? result.status}`);
}

export function pythonSetup(tests = false) {
  return [
    ...(!existsSync(python) ? [['Create Python environment', 'uv', ['venv', '.venv', '--python', '3.11', '--no-project']]] : []),
    ['Install editable Python SDK', 'uv', ['pip', 'install', '--python', python, '-e', './py/openaxis',
      ...(tests ? ['pytest'] : ['-r', 'examples/python_demo_3d_app/requirements.txt'])]],
  ];
}
const cppConfigure = (demo) => ['Configure C++', 'cmake', ['-S', 'cpp', '-B', 'cpp/build',
  '-DOPENAXIS_BUILD_TESTS=ON', '-DOPENAXIS_WARNINGS_AS_ERRORS=ON', `-DOPENAXIS_BUILD_DEMO=${demo ? 'ON' : 'OFF'}`, '-DCMAKE_BUILD_TYPE=Release',
  ...(process.platform === 'linux' ? ['-DGLFW_BUILD_WAYLAND=OFF'] : [])]];

export function buildSteps(language = 'all') {
  if (language === 'cs') language = 'csharp';
  const selected = name => language === 'all' || language === name;
  return [
    ...(selected('typescript') ? [
      ['Build TypeScript SDK', 'pnpm', ['-C', 'ts/sdk', 'build']],
      ['Build documentation and browser demos', 'pnpm', ['build:site']],
    ] : []),
    ...(selected('python') ? pythonSetup() : []),
    ...(selected('csharp') ? [['Build C# SDK and demo', 'dotnet', ['build', project, '-c', 'Release']]] : []),
    ...(selected('cpp') ? [cppConfigure(true), ['Build C++ SDK and demos', 'cmake', ['--build', 'cpp/build', '--config', 'Release']]] : []),
  ];
}

export function testSteps(language = 'all', privateRoot) {
  if (language === 'cs') language = 'csharp';
  const selected = name => language === 'all' || language === name;
  return [
    ...(language === 'all' ? [['Tooling tests', process.execPath, ['--test', 'scripts/tasks.test.mjs']]] : []),
    ...(selected('typescript') ? [
      ['TypeScript SDK tests', 'pnpm', ['-C', 'ts/sdk', 'test']],
      ['Browser demo tests', 'pnpm', ['-C', 'examples/demos', 'test']],
    ] : []),
    ...(selected('python') ? [...pythonSetup(true),
      ['Python SDK tests', python, ['-m', 'pytest', '-c', 'py/openaxis/pyproject.toml', 'py/openaxis/tests']]] : []),
    ...(selected('csharp') ? [
      ['C# SDK tests', 'dotnet', ['run', '--project', 'cs/OpenAxis.ConformanceTests/OpenAxis.ConformanceTests.csproj']],
      ['C# demo tests', 'dotnet', ['run', '--project', project, '-c', 'Release', '--', '--test']],
    ] : []),
    ...(selected('cpp') ? [cppConfigure(true),
      ['Build C++ tests', 'cmake', ['--build', 'cpp/build', '--config', 'Release']],
      ['C++ tests', 'ctest', ['--test-dir', 'cpp/build', '-C', 'Release', '--output-on-failure', '--no-tests=error']]] : []),
    ...(privateRoot ? [['Private verification', process.execPath, [join(privateRoot, 'run.mjs'), language]]] : []),
  ];
}

export function privateTests(explicit) {
  const directory = explicit ? resolve(explicit) : join(root, 'private/tests');
  if ((explicit || existsSync(join(root, 'private'))) && !existsSync(join(directory, 'run.mjs')))
    throw new Error(`Private test runner not found: ${directory}`);
  return existsSync(directory) ? directory : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      'dry-run': { type: 'boolean' }, 'private-tests': { type: 'string' },
    } });
    const [task, language = 'all'] = positionals;
    if (!['build', 'test'].includes(task) || !['all', 'typescript', 'python', 'cs', 'csharp', 'cpp'].includes(language) || positionals.length > 2)
      throw new Error('Usage: pnpm build|test [typescript|python|cs|cpp] [--dry-run]');
    const tests = task !== 'build' ? privateTests(values['private-tests']) : undefined;
    if (task !== 'build') console.log(tests ? `Public + private tests (${tests})` : 'Public tests; private suite unavailable');
    const steps = task === 'build' ? buildSteps(language) : testSteps(language, tests);
    for (const [label, command, args] of steps) run(label, command, args, values['dry-run']);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
