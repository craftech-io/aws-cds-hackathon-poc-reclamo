// Agent tests only (`agent-test run`): one file at a time and one test at a time, because the local model
// serializes turns anyway. A conversation of several turns on a local model takes minutes, hence the
// timeouts. The root `vitest.config.ts` never includes this folder.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/agent/**/*.agent.test.ts"],
    fileParallelism: false,
    testTimeout: 2_400_000,
    hookTimeout: 120_000,
  },
});
