import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { LIVE_TEST_TIMEOUT_MS } from "./src/fetch-timeout.ts";

// The red-line smoke (src/smoke.ts): the blocking release check. Its two
// tracks are its two files, run side by side; each file's cases run in order.
// src/reporter.ts writes REDLINE_REPORT against smoke/manifest.json and, under
// REDLINE_GATE=1, fails the run unless every case passes.
process.env.REDLINE_MANIFEST ||= join(
  import.meta.dirname,
  "smoke",
  "manifest.json",
);

export default defineConfig({
  test: {
    include: ["smoke/**/*.test.ts"],
    fileParallelism: true,
    maxWorkers: 2,
    testTimeout: LIVE_TEST_TIMEOUT_MS,
    hookTimeout: LIVE_TEST_TIMEOUT_MS,
    setupFiles: ["./smoke/setup.ts"],
    reporters: ["verbose", "./src/reporter.ts"],
  },
});
