import { defineConfig, devices } from "@playwright/test";

/**
 * Config for the real-server e2e smoke lane (`tests/e2e-smoke.spec.ts`).
 *
 * The mocked UI smoke suite lives in `playwright.config.ts`; this lane
 * boots a real `hubris-server` binary instead (see
 * `tests/e2e-smoke.setup.ts`), so it has its own config: no Vite
 * `webServer`, a single worker sharing one server instance, and the base
 * URL handed to the spec via `HUBRIS_E2E_BASE_URL` because the port is
 * only known after global setup binds it.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: /e2e-smoke\.spec\.ts/,
  globalSetup: "./tests/e2e-smoke.setup.ts",
  // The whole flow (server boot, SSE, PTY round-trip) gets a generous
  // budget so slow CI runners don't flake the lane. Must exceed the sum
  // of the spec's per-assertion timeouts (~110s in the worst case), or
  // the whole-test budget fires before the step budgets can.
  timeout: 240_000,
  // Fail the build on an accidentally committed .only() instead of
  // silently narrowing CI coverage.
  forbidOnly: !!process.env.CI,
  // One shared real-server instance; parallel workers would fight over
  // the same backend state.
  workers: 1,
  // One retry in CI only: this lane crosses a real server, PTY, and SSE
  // stream, so a rare timing hiccup (slow runner, shell startup) should
  // not fail the build outright. Locally, flakes should stay visible.
  retries: process.env.CI ? 1 : 0,
  expect: {
    timeout: 15_000,
  },
  use: {
    trace: "retain-on-failure",
    launchOptions: {
      // Disable WebGL so xterm's WebGL addon fails to activate and the
      // terminal falls back to the DOM renderer, which keeps terminal
      // text queryable via toContainText assertions.
      args: ["--disable-webgl", "--disable-webgl2"],
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
