/**
 * Next 16's instrumentation contract (`next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md`):
 * `register()` runs once per server instance, before the server starts
 * handling requests, in *both* the Node and Edge runtimes. Everything the
 * backup scheduler needs (fs writes, long-lived timers, fetches to the PDS,
 * and transitively `better-sqlite3`'s native binding via `pruneOauthStates`)
 * is Node-only, so it's gated behind `process.env.NEXT_RUNTIME === "nodejs"`
 * -- the documented way to scope instrumentation logic to a single runtime.
 *
 * The Node-only logic lives in `./lib/backup-scheduler`, reached here via a
 * dynamic `import()` *inside* the runtime check rather than a top-level
 * `import` -- a top-level import gets statically resolved for the Edge
 * build target too, even though it's only ever *called* under the Node
 * runtime check, and that Edge build fails outright trying to bundle
 * `better-sqlite3`'s native addon loader (transitively, via
 * `pruneOauthStates`). Verified against `next build`: a top-level import of
 * `./lib/backup-scheduler` here reproduces exactly that Edge-bundle failure;
 * the dynamic `import()` below does not.
 *
 * No cron container (spec §5): the backup scheduler is *this process*
 * self-scheduling via `setInterval`, not an external dyno/cron dispatching
 * into the app.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerBackupScheduler } = await import("./lib/backup-scheduler");
  registerBackupScheduler();
}
