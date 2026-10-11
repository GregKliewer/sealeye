// Browser tests for the portal (PHASE1-PLAN Step 14): each page loads and shows live
// data from a test API, and tear down works. Playwright starts the test API
// (tests/test-api.mjs) and the built portal (vite preview, which passes /api to it as
// Caddy does). `npm run build` first.
import { defineConfig } from "@playwright/test";

const API_PORT = 3999;
const PORTAL_PORT = 4173;
// A Chromium already on the machine, when there is one (this repo's cloud sessions);
// otherwise Playwright's own, from `npx playwright install chromium`.
const executablePath = process.env.SEALEYE_CHROMIUM || undefined;

export default defineConfig({
  testDir: "tests",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORTAL_PORT}`,
    trace: "retain-on-failure",
    launchOptions: executablePath ? { executablePath } : {}
  },
  webServer: [
    {
      command: "node tests/test-api.mjs",
      url: `http://localhost:${API_PORT}/health`,
      env: { SEALEYE_TEST_API_PORT: String(API_PORT) },
      reuseExistingServer: false
    },
    {
      command: `npx vite preview --port ${PORTAL_PORT} --strictPort`,
      url: `http://localhost:${PORTAL_PORT}`,
      env: { SEALEYE_PORTAL_API: `http://localhost:${API_PORT}` },
      reuseExistingServer: false
    }
  ]
});
