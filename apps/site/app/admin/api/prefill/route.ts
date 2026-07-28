import { extractPrefill } from "../../../../lib/photo-metadata";
import { requireOwner } from "../../../../lib/session";

/**
 * Owner-gated prefill endpoint for the upload form: on file selection, the
 * client posts the raw bytes here and gets back `extractPrefill`'s `Prefill`
 * JSON to seed the per-file card's editable fields. Deliberately thin — all
 * the actual metadata parsing lives in `lib/photo-metadata.ts`; this route
 * is just an owner-gate plus a request/response shape around it, mirroring
 * `publishPhotographCore`'s own `extractPrefill` usage (same function, same
 * error-message-passthrough style) without duplicating any of its logic.
 *
 * Not the publish path: this never uploads a blob or writes a record, so
 * there's no GPS-stripping decision to make here — `extractPrefill` only
 * reads metadata, it never mutates the bytes it's given.
 *
 * Relative imports (not the `@/*` tsconfig alias) so this file resolves
 * identically under plain Vitest (no path-alias plugin configured for this
 * app's test run) and under Next's build — see the colocated `route.test.ts`.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    await requireOwner();
  } catch {
    return Response.json({ ok: false, error: "owner only" }, { status: 403 });
  }

  let file: File | null = null;
  try {
    const formData = await req.formData();
    const value = formData.get("file");
    if (value instanceof File) file = value;
  } catch {
    return Response.json({ ok: false, error: "invalid request body" }, { status: 400 });
  }
  if (!file) return Response.json({ ok: false, error: "missing file" }, { status: 400 });

  // Reject files larger than 32 MB before reading
  const MAX_FILE_SIZE = 32 * 1024 * 1024;
  if (file.size > MAX_FILE_SIZE) {
    return Response.json({ ok: false, error: "file too large for prefill" }, { status: 413 });
  }

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const prefill = await extractPrefill(bytes);
    return Response.json({ ok: true, prefill });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : "could not read image metadata" },
      { status: 422 },
    );
  }
}
