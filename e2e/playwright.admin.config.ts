import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./admin",
  outputDir: "../test-results/admin",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 20_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI ? "line" : "list",
  // The fixture creates a new loopback server, RSA key and in-memory RPC state for every test.
  // Never inherit E2E_BASE_URL: these tests perform writes and must not target a deployed Worker.
  use: {
    ...devices["Desktop Chrome"],
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
});
