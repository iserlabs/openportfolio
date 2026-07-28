import { fetchRepoCar } from "../../../lib/backup";
import { requireOwner } from "../../../lib/session";

// Relative imports (not the `@/*` tsconfig alias) so this file resolves
// identically under plain Vitest (no path-alias plugin configured for this
// app's test run) and under Next's build -- same reasoning as
// `app/admin/api/prefill/route.ts`'s colocated test.
export const dynamic = "force-dynamic";

/**
 * Always-available "download my data" export -- the sovereignty surface this
 * whole task exists for. Owner-gated GET that streams the owner's entire
 * repo, as `com.atproto.sync.getRepo` returns it (a CAR file, unauthenticated
 * upstream, pinned to `env.PDS_URL`), straight through as this response's
 * body.
 *
 * Deliberately never buffers: `upstream.body` (a `ReadableStream`) is handed
 * directly to the `Response` constructor rather than read into memory first
 * (no `.arrayBuffer()`/`.blob()` in between), so this route's own memory
 * footprint stays flat no matter how large the repo grows. `lib/backup.ts`'s
 * `fetchRepoCar` is the same upstream call `runBackup`'s nightly job uses to
 * write the CAR to disk -- one fetch built one way, piped to two different
 * destinations (an HTTP response here, a file there).
 */
export async function GET(): Promise<Response> {
  try {
    await requireOwner();
  } catch {
    return Response.json({ error: "owner only" }, { status: 403 });
  }

  const upstream = await fetchRepoCar();
  if (!upstream.ok || !upstream.body) {
    return Response.json({ error: "export upstream unavailable" }, { status: 502 });
  }

  const date = new Date().toISOString().slice(0, 10);
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.ipld.car",
      "Content-Disposition": `attachment; filename="portfolio-${date}.car"`,
    },
  });
}
