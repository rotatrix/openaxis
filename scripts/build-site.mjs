// Combine independently built docs and demos. The artifact is mounted at /,
// with documentation at the root and browser demos under /demos/.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = resolve(root, 'site');
const docs = resolve(root, 'docs/dist');
const demos = resolve(root, 'examples/demos/dist');
for (const path of [docs, demos]) {
  if (!existsSync(resolve(path, 'index.html'))) throw new Error(`Build output missing: ${path}`);
}
if (site !== resolve(root, 'site')) throw new Error('Unexpected output directory');
rmSync(site, { recursive: true, force: true });
mkdirSync(site, { recursive: true });
cpSync(docs, site, { recursive: true });
cpSync(demos, resolve(site, 'demos'), { recursive: true });
cpSync(resolve(root, 'SPEC.md'), resolve(site, 'SPEC.md'));
cpSync(resolve(root, 'LEGAL.md'), resolve(site, 'LEGAL.md'));
cpSync(resolve(root, 'LICENSE'), resolve(site, 'LICENSE'));
cpSync(resolve(root, 'examples/python_demo_3d_app'), resolve(site, 'examples/python_demo_3d_app'), {
  recursive: true, filter: path => !path.includes('__pycache__') && !path.endsWith('.pyc'),
});
cpSync(resolve(root, 'examples/csharp_demo_3d_app'), resolve(site, 'examples/csharp_demo_3d_app'), {
  recursive: true, filter: path => !['bin', 'obj', '.vs'].includes(basename(path)),
});
for (const folder of ['typescript_demo_3d_app', 'cpp_demo_3d_app', 'demo_3d_scene']) {
  cpSync(resolve(root, 'examples', folder), resolve(site, 'examples', folder), {
    recursive: true, filter: path => !['node_modules', 'dist'].includes(basename(path)),
  });
}
// The reference integration imports the gallery's shared diagnostic renderer.
mkdirSync(resolve(site, 'examples/demos/lib'), { recursive: true });
cpSync(resolve(root, 'examples/demos/lib/navigation-diagnostic-overlay.js'),
  resolve(site, 'examples/demos/lib/navigation-diagnostic-overlay.js'));
if (existsSync(resolve(root, 'docs/examples'))) {
  cpSync(resolve(root, 'docs/examples'), resolve(site, 'examples'), {
    recursive: true, filter: path => !path.includes('__pycache__') && !path.endsWith('.pyc'),
  });
}
console.log('Assembled site/: Starlight documentation, canonical specification and existing demos.');
