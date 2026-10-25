import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/src/**/*.test.tsx",
      "infra/**/*.test.ts",
      "scripts/**/*.test.ts",
      "tests/flows/**/*.test.ts",
      "tests/ui-server/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.sst/**", "packages/web/e2e/**"],
    passWithNoTests: true,
  },
});
