import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, resolve, sep, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { root, python, cpp, csharp, buildSteps, run } from './tasks.mjs';

export function endpoint(value) {
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname) throw new Error('Expected a ws:// or wss:// server URL');
  return value;
}
export function viewerCommand(viewer, url) {
  if (viewer === 'python') return [python, [join(root, 'examples/python_demo_3d_app/main.py'), '--url', url]];
  return [{ cpp, csharp }[viewer], ['--url', url]];
}
export async function browserServer(directory, serverUrl) {
  const base = resolve(directory);
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };
  const server = createServer(async (request, response) => {
    try {
      const path = resolve(base, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
      if (!path.startsWith(base + sep)) { response.writeHead(403).end(); return; }
      const content = await readFile(path);
      response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  return { server, url: `http://127.0.0.1:${server.address().port}/typescript-demo-3d-app.html?${new URLSearchParams({ url: serverUrl })}` };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    url: { type: 'string', default: 'ws://127.0.0.1:6607' }, 'no-build': { type: 'boolean' }, list: { type: 'boolean' },
  } });
  if (positionals[0] === 'cs') positionals[0] = 'csharp';
  const viewers = ['browser', 'python', 'cpp', 'csharp'];
  if (values.list) { console.log('browser\npython\ncpp\ncs'); return; }
  if (positionals.length > 1 || (positionals[0] && !viewers.includes(positionals[0]))) throw new Error('Usage: pnpm demo [browser|python|cpp|cs] [--url ws://...] [--no-build]');
  const url = endpoint(values.url);
  const active = new Set();
  const servers = new Set();
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const cleanup = () => {
    for (const child of active) {
      // Windows venv python.exe can redirect to another process. Stop its tree.
      if (process.platform === 'win32' && child.pid)
        spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      else child.kill();
    }
    active.clear();
    for (const server of servers) { server.close(); server.closeAllConnections(); }
    input.close();
  };
  input.on('SIGINT', cleanup);
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  try {
    console.log(`Connecting to ${url}. Start Rotatrix separately.\nSee examples/ACCEPTANCE.md for manual checks.`);
    async function launch(viewer) {
      if (!values['no-build']) {
        const steps = viewer === 'browser' ? [
          ['Build TypeScript SDK', 'pnpm', ['-C', 'ts/sdk', 'build']],
          ['Build browser demos', 'pnpm', ['-C', 'examples/demos', 'build']],
        ] : buildSteps(viewer);
        for (const step of steps) run(...step);
      }
      if (viewer === 'browser') {
        const directory = join(root, 'examples/demos/dist');
        if (!existsSync(join(directory, 'typescript-demo-3d-app.html'))) throw new Error('Run pnpm build typescript first');
        const { server, url: browserUrl } = await browserServer(directory, url);
        servers.add(server);
        console.log(`Browser demo: ${browserUrl}`);
        const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        const child = spawn(command, process.platform === 'win32' ? ['url.dll,FileProtocolHandler', browserUrl] : [browserUrl], { stdio: 'ignore' });
        child.on('error', error => console.error(`Open the printed URL in your browser: ${error.message}`));
      } else {
        const [command, args] = viewerCommand(viewer, url);
        if (!existsSync(command)) throw new Error(`Missing ${command}; run pnpm build ${viewer} first`);
        const child = spawn(command, args, { cwd: dirname(command), stdio: ['ignore', 'inherit', 'inherit'] });
        active.add(child);
        child.once('exit', code => { active.delete(child); console.log(`${viewer} exited (${code})`); });
        child.once('error', error => { active.delete(child); console.error(`${viewer}: ${error.message}`); });
      }
    }
    if (positionals[0]) await launch(positionals[0]);
    while (!input.closed) {
      const choice = (await input.question('\n1 Browser  2 Python  3 C++  4 C#  q Quit\n> ')).trim();
      if (choice === 'q') break;
      const viewer = viewers[Number(choice) - 1];
      if (viewer) {
        try { await launch(viewer); } catch (error) { console.error(error.message); }
      }
    }
  } finally { cleanup(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
