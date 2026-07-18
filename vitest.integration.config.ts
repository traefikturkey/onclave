import { defineConfig } from "vitest/config";

// Runs the broker-backed suites against the compose.test.yaml rabbitmq via
// `just test-integration`; ONCLAVE_TEST_AMQP_URL points at that broker.
export default defineConfig({
  test: {
    include: ["**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    passWithNoTests: true,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
