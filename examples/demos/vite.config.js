import { defineConfig } from "vite";
import { resolve } from "path";
export default defineConfig(({ command }) => ({
  // Reference source keeps public package imports, while local demos use this checkout's SDK.
  resolve: { alias: [
    // Node tests use the compiled geometry module; browser builds use source.
    { find: '../../../ts/sdk/dist/geometry.js', replacement: resolve(__dirname, '../../ts/sdk/src/geometry/index.ts') },
    { find: /^@openaxis\/sdk\/geometry$/, replacement: resolve(__dirname, '../../ts/sdk/src/geometry/index.ts') },
    { find: /^@openaxis\/sdk$/, replacement: resolve(__dirname, '../../ts/sdk/src/index.ts') },
  ] },
  server: {
    port: 5188,
    strictPort: true,
  },

  base: command === "build" ? "./" : "/demos/",

  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        "viewspace-2d": resolve(__dirname, "viewspace-2d.html"),
        basic: resolve(__dirname, "basic.html"),
        cube: resolve(__dirname, "cube.html"),
        skybox: resolve(__dirname, "skybox.html"),
        splats: resolve(__dirname, "splats.html"),
        sketchfab: resolve(__dirname, "sketchfab.html"),
        "se2-2d": resolve(__dirname, "se2-2d.html"),
        "se2-3d": resolve(__dirname, "se2-3d.html"),
        "typescript-demo-3d-app": resolve(__dirname, "typescript-demo-3d-app.html"),
      },
    },
  },
}));
