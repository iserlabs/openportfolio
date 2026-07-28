import { getIronSession, type IronSession } from "iron-session";
import { env } from "./env";

/**
 * Encrypted-cookie session payload. Only the authenticated DID (identity)
 * plus the resolved handle (a display convenience) are ever persisted here.
 * `next/headers` is imported lazily inside {@link getIronSessionData} so
 * this module stays importable outside a Next request context (e.g. unit
 * tests) -- same reasoning as Luminance's `apps/web/lib/session.ts`.
 */
export type SessionData = { did?: string; handle?: string };

const SESSION_COOKIE = "open_portfolio_session";

/**
 * This app has exactly one privileged identity -- the site owner
 * (`env.OWNER_DID`) -- rather than Luminance's `ADMIN_DIDS` allow-list, so
 * the rule collapses from "is the did a member of this list" to "does the
 * did equal this one value". Extracted as a pure function so it's
 * unit-testable without standing up a request-scoped cookie store.
 */
export function isOwnerDid(did: string | undefined, ownerDid: string): boolean {
  return did != null && did === ownerDid;
}

/**
 * The mutable iron-session handle (has `.save()`/`.destroy()`), for routes
 * and server actions that need to set or clear the cookie. Reads env lazily.
 */
export async function getIronSessionData(): Promise<IronSession<SessionData>> {
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, {
    cookieName: SESSION_COOKIE,
    password: env.SESSION_SECRET,
    cookieOptions: {
      httpOnly: true,
      sameSite: "lax",
      // Secure cookies over HTTPS; relaxed on http://localhost for dev.
      secure: env.PUBLIC_URL.startsWith("https://"),
      path: "/",
    },
  });
}

/**
 * Read-only view of the current session for pages/actions: the DID + handle
 * plus the derived `isOwner` flag.
 */
export async function getSession(): Promise<{ did?: string; handle?: string; isOwner: boolean }> {
  const s = await getIronSessionData();
  return { did: s.did, handle: s.handle, isOwner: isOwnerDid(s.did, env.OWNER_DID) };
}

/**
 * Gate for admin-only server actions/routes. Throws rather than redirecting:
 * a redirect would be wrong for the (future) route-handler call sites that
 * need to return e.g. a 403 JSON response, while server actions can catch
 * this and map it into whatever result shape their form expects (and
 * page-level call sites can catch it and call `redirect()` themselves, which
 * needs to happen outside a try/catch anyway per Next's own guidance since
 * `redirect()` throws its own internal signal). A thrown `Error` is the one
 * shape every call site can uniformly handle without this module having to
 * guess which behavior a given caller wants.
 */
export async function requireOwner(): Promise<string> {
  const session = await getSession();
  if (!session.isOwner || !session.did) {
    throw new Error("owner only");
  }
  return session.did;
}
