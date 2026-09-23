// Validate the assembled static artifact, including base paths and spec anchors.
import './check-doc-examples.mjs';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../site');
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
const docs = files(root).filter(path => path.endsWith('.html')
  && !path.includes(`${sep}demos${sep}`));
const errors = [];
for (const file of ['OpenAxisDemo.csproj', 'Program.cs', 'MyApplication.cs', 'MyOpenAxisIntegration.cs', 'DemoTests.cs', 'README.md']) {
  if (!existsSync(resolve(root, 'examples/csharp_demo_3d_app', file))) {
    errors.push(`Missing C# demo 3D app file: ${file}`);
  }
}
for (const path of ['guide/navigation-integration', 'guide/connection-shutdown', 'guide/dynamic-tags', 'guide/picking-pivots',
  'guide/concurrent-input', 'guide/object-manipulation', 'guide/diagnostics-logging',
  'guide/axis-streaming', 'guide/asynchronous-hosts', 'reference/navigation-hosts',
  'reference/connection-lifecycle', 'reference/language-support']) {
  const html = readFileSync(resolve(root, path, 'index.html'), 'utf8');
  if (!html.includes('data-sync-key="sdk-language"') || !/role="tab"[^>]*>\s*C#\s*</.test(html)) {
    errors.push(`Missing synchronized C# language selector: ${path}`);
  }
  if (!/role="tab"[^>]*>\s*TypeScript\s*</.test(html)) {
    errors.push(`Missing TypeScript language selector: ${path}`);
  }
  if (!/role="tab"[^>]*>\s*C\+\+\s*</.test(html)) {
    errors.push(`Missing C++ language selector: ${path}`);
  }
}
for (const file of ['main.cpp', 'integration.hpp', 'application.cpp', 'application.hpp', 'diagnostic_view.cpp', 'diagnostic_view.hpp', 'CMakeLists.txt', 'test_application.cpp', 'README.md']) {
  if (!existsSync(resolve(root, 'examples/cpp_demo_3d_app', file)))
    errors.push(`Missing C++ demo source: ${file}`);
}
for (const file of ['axis-streaming.ts', 'README.md', 'tsconfig.json']) {
  if (!existsSync(resolve(root, 'examples/typescript', file)))
    errors.push(`Missing TypeScript example: ${file}`);
}
for (const file of ['application.ts', 'integration.ts', 'main.ts', 'README.md', 'package.json']) {
  if (!existsSync(resolve(root, 'examples/typescript_demo_3d_app', file)))
    errors.push(`Missing TypeScript demo source: ${file}`);
}
for (const file of ['scene.json', 'probes.json', 'test-boxes.json']) {
  if (!existsSync(resolve(root, 'examples/demo_3d_scene', file)))
    errors.push(`Missing shared demo scene: ${file}`);
}
if (!existsSync(resolve(root, 'examples/demos/lib/navigation-diagnostic-overlay.js')))
  errors.push('Missing shared TypeScript diagnostic renderer');
for (const file of ['main.py', 'application.py', 'integration.py', 'requirements.txt']) {
  if (!existsSync(resolve(root, 'examples/python_demo_3d_app', file))) {
    errors.push(`Missing Python demo 3D app file: ${file}`);
  }
}
const ids = new Map();
const unescape = value => value.replaceAll('&amp;', '&').replaceAll('&#39;', "'").replaceAll('&quot;', '"');
for (const file of docs) {
  const html = readFileSync(file, 'utf8');
  const source = '/' + relative(root, file).split(sep).join('/');
  for (const match of html.matchAll(/<(?:a|link|script|img)\b[^>]*?\b(?:href|src)="([^"]+)"/g)) {
    const url = new URL(unescape(match[1]), `https://docs.test${source}`);
    if (url.origin !== 'https://docs.test') continue;
    let target = resolve(root, '.' + decodeURIComponent(url.pathname));
    if (target !== root && !target.startsWith(root + sep)) { errors.push(`${source}: outside artifact ${url.pathname}`); continue; }
    if (existsSync(target) && statSync(target).isDirectory()) target = resolve(target, 'index.html');
    if (!existsSync(target)) { errors.push(`${source}: missing ${url.pathname}`); continue; }
    if (url.hash && target.endsWith('.html') && !target.includes(`${sep}demos${sep}`)) {
      if (!ids.has(target)) ids.set(target, new Set([...readFileSync(target, 'utf8').matchAll(/\bid="([^"]+)"/g)].map(m => unescape(m[1]))));
      if (!ids.get(target).has(decodeURIComponent(url.hash.slice(1)))) errors.push(`${source}: missing anchor ${url.pathname}${url.hash}`);
    }
  }
}
for (const required of ['pagefind/pagefind.js', 'spec/index.html', 'legal/index.html', 'legal/license/index.html', 'LEGAL.md', 'LICENSE', 'SPEC.md', 'demos/index.html', 'examples/minimal_camera.py']) {
  if (!existsSync(resolve(root, required))) errors.push(`Missing required output: ${required}`);
}
if (errors.length) throw new Error(errors.join('\n'));
console.log(`Verified ${docs.length} documentation pages: internal links, assets, fragments, search, specification and demo entry point.`);
