import path from "path";
import { defineConfig, configDefaults } from "vitest/config";

// Node environment: this app's tests exercise server-side code (lib/*, app
// route handlers/actions) rather than rendered components, so no DOM
// environment is needed.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
  test: {
    environment: "node",
    // The default include glob (**/*.{test,spec}.*) would otherwise sweep up
    // the dev-env integration suite (integration/**/*.test.ts -- slow, boots
    // a real PDS, run via `test:integration`) and the Playwright E2E suite
    // (e2e/**/*.spec.ts -- imports `@playwright/test`, boots a real dev-env
    // network *and* a real browser, run via `test:e2e`; see e2e/global-
    // setup.ts). Both have their own config/script and must stay out of
    // `pnpm test`. Mirrors Luminance's apps/web/vitest.config.ts split.
    exclude: [...configDefaults.exclude, "integration/**", "e2e/**"],
  },
});
