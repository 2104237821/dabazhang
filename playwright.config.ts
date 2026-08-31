import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./output/playwright/test-results",
  snapshotDir: "./tests/e2e/__screenshots__",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["line"], ["html", { outputFolder: "output/playwright/report", open: "never" }]]
    : [["list"]],
  expect: { timeout: 5_000, toHaveScreenshot: { animations: "disabled", maxDiffPixelRatio: 0.01 } },
  use: {
    baseURL: "http://127.0.0.1:4181",
    colorScheme: "dark",
    locale: "zh-CN",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1366, height: 768 }
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "node apps/server/dist/index.js",
    url: "http://127.0.0.1:4181/readyz",
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "4181",
      STATIC_ROOT: `${projectRoot}apps/web/dist`,
      ACTION_TIMEOUT_MS: "1000",
      DISCONNECT_GRACE_MS: "1000",
      BOT_DELAY_MIN_MS: "0",
      BOT_DELAY_MAX_MS: "0",
      COMMAND_RATE_LIMIT_MAX: "10000",
      COMMAND_RATE_LIMIT_WINDOW_MS: "100"
    }
  }
});
