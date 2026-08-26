import { defineConfig, devices } from "@playwright/test";

const galleryUrl = "http://127.0.0.1:4173/playwright/gallery/index.html";

export default defineConfig({
  testDir: "./components",
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
    command: "vp dev --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173/playwright/gallery/health.html",
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
});
