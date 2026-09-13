import { defineConfig, devices } from "@playwright/test";
import { uiOutput, uiReporter } from "./harness-config.js";

export default defineConfig({
  testDir: "./admin",
  outputDir: uiOutput("admin"),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 20_000,
  expect: { timeout: 5_000 },
  reporter: uiReporter("admin"),
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
