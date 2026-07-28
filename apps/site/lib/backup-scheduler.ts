import { runBackup } from "./backup";
import { pruneOauthStates } from "./oauth";

/**
 * Node-only scheduling logic, split out of `instrumentation.ts` itself so
 * the Node-only dependency chain (this -> `./backup`/`./oauth` ->
 * `node:fs`/`node:path`/`node:stream` and `better-sqlite3`'s native
 * binding) is never a *static* import of `instrumentation.ts`.
 *
 * Next builds `instrumentation.ts` for both the Node and Edge runtime
 * targets (its docs: "works in both the Node.js and Edge runtime"), and
 * Turbopack resolves a plain top-level `import` for *both* targets even when
 * the call site is guarded by a `NEXT_RUNTIME` runtime check -- a runtime
 * `if` doesn't prevent build-time module resolution. `instrumentation.ts`
 * reaches this file via a dynamic `import()` inside its own
 * `NEXT_RUNTIME === "nodejs"` branch instead, which Turbopack doesn't
 * eagerly resolve for the Edge build target.
 */

const REGISTERED_FLAG = "__openPortfolioBackupSchedulerRegistered";
const TICK_MS = 24 * 60 * 60 * 1000; // 24h between ticks
const FIRST_RUN_DELAY_MS = 60 * 1000; // first run 60s after boot -- long enough to clear cold-start
const PRUNE_OLDER_THAN_MS = 60 * 60 * 1000; // 1h

/**
 * One scheduler tick, two independent chores (the janitor pattern, carried
 * over from Task A5's review, decoupled per the A10 review):
 *
 *  1. `runBackup()` -- the CAR + blob backup. No-ops via `{skipped: true}`
 *     on its own when `env.BACKUP_DIR` isn't configured; that's a supported
 *     per-install default, not this function's concern.
 *  2. `pruneOauthStates(1h)` -- the `oauth_states` janitor. Runs
 *     unconditionally, every tick, regardless of whether backups are
 *     configured: an install that never sets `BACKUP_DIR` still
 *     accumulates abandoned OAuth authorize->callback rows that need
 *     garbage-collecting. Wrapped in its own try/catch so a database
 *     hiccup here can't crash the process from inside a timer callback
 *     (an uncaught throw in a `setInterval` callback is fatal in Node) --
 *     same "never throws out of a scheduled tick" invariant `runBackup`
 *     already upholds for itself.
 */
function tick(): void {
  void runBackup();
  try {
    pruneOauthStates(PRUNE_OLDER_THAN_MS);
  } catch (err) {
    console.error("[backup] pruneOauthStates failed:", err instanceof Error ? err.message : String(err));
  }
}

export function registerBackupScheduler(): void {
  // Next dev's hot reload re-invokes this on every module reload;
  // module-scoped state doesn't survive that, but `globalThis` does. Without
  // this guard, a long dev session would accumulate one extra live
  // setInterval per reload.
  const registry = globalThis as Record<string, unknown>;
  if (registry[REGISTERED_FLAG]) return;
  registry[REGISTERED_FLAG] = true;

  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS);
  }, FIRST_RUN_DELAY_MS);
}
