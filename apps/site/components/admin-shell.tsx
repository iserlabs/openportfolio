import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getIronSessionData, getSession } from "@/lib/session";

const NAV_LINKS = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/upload", label: "Upload" },
  { href: "/admin/collections", label: "Collections" },
  { href: "/admin/site", label: "Site settings" },
];

/**
 * The owner gate for the whole admin area -- there's no middleware in this
 * app, so every `/admin/*` page calls this itself, and calls it *first*,
 * before any PDS data fetching: a page that fetched first and gated later
 * (e.g. only inside `<AdminShell>`, which is rendered after a page's own
 * `await`s resolve) would run real `listAllRecords`/`getRecord` network
 * calls for a request that was never going to be allowed to see the result,
 * for any anonymous visitor who simply requests `/admin/collections`.
 *
 * Redirecting to `/admin/login` (rather than returning some "not allowed"
 * value for the page to render inline) is deliberate: that page already
 * renders the right explanation for either non-owner case (not signed in at
 * all vs. signed in as the wrong account) from `getSession()` itself, so
 * callers don't need to duplicate that messaging.
 */
export async function requireAdminSession() {
  const session = await getSession();
  if (!session.isOwner) redirect("/admin/login");
  return session;
}

/**
 * Shared chrome for every `/admin/*` page: nav + a signed-in-as/sign-out
 * strip, wrapping whatever page content is passed as `children`. Also
 * re-runs {@link requireAdminSession} itself (redundant on every call site
 * that already gated first, but cheap -- a cookie read, not a network call
 * -- and keeps this component safe to use even if some future page forgets
 * to gate before fetching).
 *
 * The inline `"use server"` `signOut` action (rather than adding one to the
 * locked `app/admin/actions.ts` write path) mirrors `admin/login/page.tsx`'s
 * own inline `startAdminLogin` action -- session-cookie lifecycle isn't part
 * of that file's `social.opencontent.*` record-mutation surface.
 */
export async function AdminShell({ children }: { children: ReactNode }) {
  const session = await requireAdminSession();

  async function signOut() {
    "use server";
    const ironSession = await getIronSessionData();
    ironSession.destroy();
    redirect("/admin/login");
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 py-10">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <nav className="-mx-3 flex flex-wrap gap-1">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-black dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-50"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <form action={signOut} className="flex items-center gap-3">
          <span className="text-sm text-zinc-500 dark:text-zinc-500">{session.handle ?? session.did}</span>
          <button
            type="submit"
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Sign out
          </button>
        </form>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
