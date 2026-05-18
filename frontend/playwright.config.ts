import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config — runs the Next.js dev server on port 3030 (port 3000
 * is reserved for the local-k8s Grafana). Tests target the dev server and
 * expect a seeded Weaviate at http://localhost:8080.
 *
 * Run from `frontend/`:
 *   npm run test:e2e                # headless, all browsers
 *   npm run test:e2e -- --headed    # open browser windows
 *   npm run test:e2e -- --ui        # interactive UI mode
 *
 * Prereqs:
 *   - weaviate-local-k8s cluster up on localhost:8080
 *   - `python action/scripts/seed_local.py` has been run at least once
 *   - The dev server is either already running on :3030, or this config
 *     starts it via `webServer` below.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // Tests share Weaviate state — run serially.
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",

  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3030",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  // If the dev server isn't already up, start it. reuseExistingServer
  // lets you `npm run dev` in one terminal and `npm run test:e2e` in
  // another without conflicts.
  webServer: {
    command: "npm run dev -- --port 3030",
    url: "http://localhost:3030",
    reuseExistingServer: true,
    timeout: 60_000,
    env: {
      NEXT_TELEMETRY_DISABLED: "1",
      // Default to the local cluster the seed script targets.
      NEXT_PUBLIC_WEAVIATE_URL:
        process.env.NEXT_PUBLIC_WEAVIATE_URL ?? "http://localhost:8080",
      NEXT_PUBLIC_WEAVIATE_API_KEY:
        process.env.NEXT_PUBLIC_WEAVIATE_API_KEY ?? "",
    },
  },
});
