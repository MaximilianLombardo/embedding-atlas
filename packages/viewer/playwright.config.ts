// Copyright (c) 2025 Apple Inc. Licensed under MIT License.
import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the viewer's chrome smoke tests.
 *
 * Spec: ./e2e/chrome.spec.ts — exercises the icon strip + settings
 * panel state model end-to-end against the local dev server.
 *
 * Not gated in CI yet — run on demand with `npm run test:e2e -w
 * @embedding-atlas/viewer`. The dev server is auto-started by
 * Playwright's `webServer` config below; if a dev server is already
 * running on http://localhost:5173, that one is reused
 * (`reuseExistingServer: true`).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // localStorage state is shared; serialize.
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 60000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
