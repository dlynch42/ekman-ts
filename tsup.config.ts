import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "stores/index": "src/stores/index.ts" },
  tsconfig: "tsconfig.build.json",
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Class names are what a log line and an `instanceof`-free check read. Without this the
  // bundler renames a class that refers to itself.
  keepNames: true,
  target: "es2022",
  outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
});
