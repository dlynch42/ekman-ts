import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "runner/**/*.ts"],
      // The runner's entry point and its report formatter only run from `npm run conformance`.
      exclude: ["src/index.ts", "runner/cli.ts", "runner/report.ts"],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
