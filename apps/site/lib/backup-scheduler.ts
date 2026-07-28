import { env } from "./env";
import { runBackup } from "./backup";

/**
 * Node-only scheduling logic, split out of `instrumentation.ts` itself so
 * the Node-only dependency chain (this -> `./backup` -> `node:fs`/`node:path`/
 * `node:stream` and, transitively via `pruneOauthStates`, `better-sqlite3`'s
 * native binding) is never a *static* import of `instrumentation.ts`.
 *
 * Next builds `instrumentation.ts` for both the Node and Edge runtime
 * targets (its docs: "works in both the Node.js and Edge runtime"), and
 * Turbopack resolves a plain top-level `import` for *both* targets even when
 * the call site is guarded by a `NEXT_RUNTIME` runtime check -- a runtime
 * `if` doesn't prevent build-time module resolution. `instrumentation.ts`
 * reaches this file via `require()` inside its own `NEXT_RUNTIME === "nodejs"`
 * branch instead (the exact pattern Next's own docs show for
 * runtime-specific instrumentation code), which Turbopack treats as opaque
 * for the Edge build target rather than eagerly resolving it.
 */

const REGISTERED_FLAG = "__openPortfolioBackupSchedulerRegistered";
const TICK_MS = 24 * 60 * 60 * 1000; // 24h between backups
const FIRST_RUN_DELAY_MS = 60 * 1000; // first run 60s after boot -- long enough to clear cold-start

export function registerBackupScheduler(): void {
  if (!env.BACKUP_DIR) return; // backups disabled -- nothing to schedule

  // Next dev's hot reload re-invokes this on every module reload;
  // module-scoped state doesn't survive that, but `globalThis` does. Without
  // this guard, a long dev session would accumulate one extra live
  // setInterval per reload.
  const registry = globalThis as Record<string, unknown>;
  if (registry[REGISTERED_FLAG]) return;
  registry[REGISTERED_FLAG] = true;

  setTimeout(() => {
    void runBackup();
    setInterval(() => {
      void runBackup();
    }, TICK_MS);
  }, FIRST_RUN_DELAY_MS);
}
