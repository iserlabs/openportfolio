import { defineConfig, devices } from "@playwright/test";
import { FAKE_HOST } from "./e2e/global-setup";

// ── Task A13: Playwright E2E (author loop) ───────────────────────────────────
// LOCAL / NIGHTLY ONLY -- deliberately NOT part of CI and NOT wired into
// `turbo test` (see e2e/global-setup.ts's own header comment for the full
// architecture writeup). This suite boots a real local ATProto network
// (`@atproto/dev-env`) plus a real production build of this app in
// `globalSetup`/the teardown it returns, and drives real, unmocked ATProto
// OAuth through a real Chromium instance -- there is no `webServer` entry
// here because the app's env (a dev-env-assigned PDS port; an owner DID
// that doesn't exist until globalSetup creates the account) is only known
// after globalSetup runs, and Playwright always starts a configured
// `webServer` *before* globalSetup (see global-setup.ts's comment for the
// exact mechanics) -- globalSetup owns the whole server lifecycle instead.
//
// Prerequisite (first run only): `pnpm --filter site exec playwright install
// chromium`.
//
// Run: `pnpm --filter site exec playwright test` (equivalently `pnpm
// --filter site test:e2e`).
export default defineConfig({
  testDir: "./e2e",
  // Fail fast if someone left a `.only` in a spec -- mirrors Luminance's
  // apps/web/playwright.config.ts (this suite has no CI run to gate, but the
  // same guard is cheap insurance for a local/nightly run too).
  forbidOnly: !!process.env.CI,
  reporter: "list",
  // Real OAuth redirect chains + a real dev-env network boot are slower
  // than a typical unit-style Playwright spec; give individual tests and
  // web-first assertions real headroom rather than tuning flakiness away
  // with retries.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    trace: "on-first-retry",
    // The app is served over a self-signed cert (e2e/global-setup.ts
    // generates it fresh per run) -- trusted for this throwaway local
    // harness only.
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          // FAKE_HOST resolves nowhere in real DNS; this maps it to the
          // proxy globalSetup starts on 127.0.0.1, entirely within this
          // Chromium instance -- no /etc/hosts edits, no real DNS
          // dependency. See global-setup.ts's header comment for why the
          // app needs a real (if fake) HTTPS hostname at all.
          args: [`--host-resolver-rules=MAP ${FAKE_HOST} 127.0.0.1`],
        },
      },
    },
  ],
  globalSetup: "./e2e/global-setup",
});
