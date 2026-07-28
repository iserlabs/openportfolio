import { getDb } from "@/lib/db";
import { proxyImage, type Preset } from "@/lib/image-proxy";

/**
 * Ported from `~/workspace/luminance.social/apps/web/app/img/[did]/[cid]/[preset]/route.ts`,
 * dropped the `[did]` segment: this is a single-owner site, so the owner's
 * DID is always `env.OWNER_DID` (resolved inside `lib/pds.ts`'s `blobUrl`,
 * not passed through the URL).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ cid: string; preset: string }> },
) {
  const { cid, preset } = await params;
  const r = await proxyImage(getDb(), {
    cid,
    preset: preset as Preset,
    accept: req.headers.get("accept") ?? "",
  });
  // Buffer's backing ArrayBufferLike isn't structurally assignable to the DOM
  // lib's BodyInit (which wants a concrete ArrayBuffer) -- re-view as Uint8Array<ArrayBuffer>.
  const body = r.body ? new Uint8Array(r.body) : null;
  return new Response(body, {
    status: r.status,
    headers: {
      "Cache-Control": r.cacheControl,
      // Responses are content-negotiated (avif/webp/jpeg by Accept) -- any
      // cache in front must key variants accordingly.
      Vary: "Accept",
      ...(r.contentType ? { "Content-Type": r.contentType } : {}),
    },
  });
}
