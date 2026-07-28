import { env } from "@/lib/env";

// Reads env at request time -- mirrors oauth/client-metadata.json/route.ts's
// own `dynamic` export: importing `env` must never throw at build (zero-env
// build invariant), so this route must never be prerendered at build time.
export const dynamic = "force-dynamic";

/** ATProto DID document handle-verification well-known: proves this domain is the given DID's PDS-declared handle. Plain text, no JSON envelope -- per the atproto spec, the body IS the DID string. */
export function GET() {
  return new Response(env.OWNER_DID, {
    headers: { "content-type": "text/plain" },
  });
}
