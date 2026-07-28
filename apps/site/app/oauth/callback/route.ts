import { redirect } from "next/navigation";
import { getOAuthClient, resolveHandle } from "@/lib/oauth";
import { getIronSessionData } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * OAuth redirect target for `/admin/login`. Completes the authorization code
 * exchange, best-effort resolves the authenticated DID's handle, and stores
 * both in the encrypted session cookie. Whether this DID is actually the
 * site owner (vs. some other visitor who typed their own handle into the
 * login form) is decided later, by `getSession()`/`requireOwner()` -- this
 * route only ever establishes "who signed in," never "are they allowed to
 * administer this site."
 *
 * `redirect()` throws NEXT_REDIRECT, so every redirect here is deliberately
 * outside a try/catch (per Next's guidance).
 */
export async function GET(req: Request) {
  const client = await getOAuthClient();
  const params = new URL(req.url).searchParams;

  let did: string | undefined;
  try {
    const { session } = await client.callback(params);
    did = session.did;
  } catch {
    did = undefined;
  }

  if (!did) redirect("/admin/login?error=oauth");

  const handle = await resolveHandle(did);

  const session = await getIronSessionData();
  session.did = did;
  session.handle = handle;
  await session.save();

  redirect("/admin");
}
