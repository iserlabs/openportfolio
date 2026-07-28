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
    // a real PDS, run via `test:integration`). It has its own config/script
    // and must stay out of `pnpm test`. Mirrors Luminance's
    // apps/web/vitest.config.ts split.
    exclude: [...configDefaults.exclude, "integration/**"],
  },
});
