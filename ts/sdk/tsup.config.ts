import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    protocol: "src/protocol/index.ts",
    geometry: "src/geometry/index.ts",
    diagnostics: "src/diagnostics.ts",
    _verify: "src/verify.ts",
  },
  dts: true,
  format: ["esm"],
  sourcemap: true,
  clean: true,
});
