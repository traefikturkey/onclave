import { defineConfig } from "vitest/config";

// Integration suites need the docker compose test broker and run through
// `just test-integration`; the default run stays broker-free.
export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
  },
});
