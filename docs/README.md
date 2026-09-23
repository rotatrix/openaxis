# Documentation site

The public SDK documentation is built with Astro Starlight. Content lives in
`src/content/docs/`; the canonical protocol remains `../SPEC.md` and is
rendered directly by the custom spec page. Do not create a second specification.

From the OpenAxis repository root (Node 22.12+ and pnpm):

```sh
pnpm install --frozen-lockfile
pnpm dev            # docs + demos; browse http://localhost:5180/
pnpm dev:docs       # http://localhost:5180/ (docs server only)
pnpm build:docs
pnpm preview:docs   # includes built search; demos are assembled separately
pnpm build:site     # docs + existing demos + internal-link validation -> site/
```

The public documentation is at `https://openaxis.rotatrix.com/`. The assembled
artifact serves documentation at `/` and browser demos at `/demos/`.
Serve `site/` locally to reproduce this layout. Building locally does not publish
anything.

## Publishing

The public repository's `.github/workflows/pages.yml` builds and validates
`site/` on pushes to `master`, then deploys it to GitHub Pages. Review branches
and forks do not deploy. The workflow can also be rerun manually on `master`.
Package publishing is separate from documentation deployment.

## Local demos

The docs dev server proxies `/demos/` to the demo server on port 5188, including
hot-reload WebSockets. `pnpm dev` starts both servers. If Rotatrix's root dev
command already runs the demo server, use `pnpm dev:docs` to avoid a port conflict.
`pnpm build:site` preserves `/demos/`
without migrating the demo implementation. Runnable tutorial source is copied
to `/examples/` in the assembled artifact.

## Authoring

Follow the prose and walkthrough guidance in
[`Writing documentation`](src/content/docs/contributing/documentation.md).
The notes below cover site tooling and source-example maintenance.

- Navigation excerpts come from the runnable apps in `../examples/`: Python,
  C#, TypeScript and C++. `examples/typescript/axis-streaming.ts` is the focused
  standalone streaming example. Check it with
  `pnpm exec tsc -p docs/examples/typescript/tsconfig.json`.
- Use Starlight `Tabs` / `TabItem` with `syncKey="sdk-language"`.
  Run `node scripts/check-doc-examples.mjs` from the OpenAxis root to validate
  selector structure and source-backed excerpts.
- Run the TypeScript reference app checks from its
  [README](../examples/typescript_demo_3d_app/README.md).
- The C# walkthrough imports excerpts directly from the runnable cross-platform raylib
  viewer in `../examples/csharp_demo_3d_app/`. Build and check it with
  `dotnet run --project examples/csharp_demo_3d_app/OpenAxisDemo.csproj -- --test`
  from the OpenAxis root with .NET 8 or newer.

- New pages require `title` and `description` frontmatter and a sidebar entry.
- Use `/.../` for site links. The artifact checker validates links and
  fragments, including links to the specification's established heading IDs.
- Use Markdown by default. Mermaid fences render as diagrams; surround diagrams
  with prose that explains the same sequence. JavaScript is loaded only on pages
  containing diagrams, and unrendered diagram source remains available.
- Source examples must be marked complete or illustrative. The minimal Python
  viewer has geometry tests and a real-window loopback test:

```sh
python -m pip install -e py/openaxis
python examples/python_demo_3d_app/test_app.py
python examples/python_demo_3d_app/test_app.py --gui
```

Demo snippets can be simplified independently of their full-source links. In MDX,
import `SourceLink` from `../../../components/SourceLink.astro` and place
`<SourceLink file="python_demo_3d_app/integration.py" symbol="MyOpenAxisIntegration.start" />`
after the snippet. Use the specific method for partial snippets and the class
for whole-class snippets. C# constructors use `ClassName.ClassName`.
When neighboring snippets share the same source target, include one link after
the final snippet in that group.
The viewer indexes classes, methods and top-level functions from the
working demo sources at build time; omit `symbol` to link to a whole file.
Do not store line numbers in these links. Missing symbols fail the build.
Run `node scripts/source-viewer.test.mjs` from the OpenAxis root to check symbol
stability when source lines move.

C++ guide excerpts come from `../examples/cpp_demo_3d_app/main.cpp`. The source
viewer currently provides file-level links for `.cpp`/`.hpp`, with C++ syntax
highlighting; method-symbol indexing is not implemented. Build and test the
reference app with the commands in its README before changing excerpts.
