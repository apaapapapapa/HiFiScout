import { defineConfig, devices } from "@playwright/test";

const galleryUrl = "http://127.0.0.1:4173/";

export default defineConfig({
  testDir: "./components",
  outputDir: "../test-results/components",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 20_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI ? "line" : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: galleryUrl,
    serviceWorkers: "block",
    reuseContext: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    // Playwright runs webServer commands from e2e/, so make the gallery Vite's working directory.
    command: "vp -C ../playwright/gallery dev --host 127.0.0.1 --port 4173 --strictPort",
    port: 4173,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
});
