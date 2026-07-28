import type { ReactNode } from "react";
import Link from "next/link";
import { getPortfolio } from "@/lib/portfolio";

/**
 * `dynamic = "force-dynamic"`, not `revalidate`: `revalidate` alone still
 * lets Next attempt to *prerender a static shell at build time* for any
 * segment that isn't gated behind a request-time API -- tried here first,
 * and it broke `next build` the moment `PDS_URL` pointed at any host not
 * reachable from the build machine (exactly the case in CI, which has no
 * live PDS), the same "must build without a live upstream" problem the
 * admin pages already solved with `force-dynamic` (see
 * `app/admin/collections/page.tsx`). `force-dynamic` means every request
 * genuinely re-renders, but the actual PDS fetch underneath is still only
 * paid once per 60s: `getPortfolio()` carries its own in-process TTL cache
 * (`lib/pds.ts`'s shared `cached()`, process-wide since this app is a
 * single-instance SQLite deployment, not serverless) that admin actions
 * bust immediately on publish. So the 60s freshness window is real, it's
 * just enforced by that cache instead of Next's route cache -- rendering
 * itself is cheap (a cache hit + JSX), so re-running it every request costs
 * effectively nothing extra.
 */
export const dynamic = "force-dynamic";

/**
 * Shared chrome for the whole public site: a left sidebar (site title,
 * collection nav in `getPortfolio()`'s already-ordered position, an About
 * link) and the page content on the right -- the sidebar-left/grid-right,
 * dark-minimal look the brief points at (klee.photos / Format-style
 * portfolio sites). No admin imports; this reads only through
 * `getPortfolio()`, same as every page it wraps.
 */
export default async function PublicLayout({ children }: { children: ReactNode }) {
  const { site, collections } = await getPortfolio();
  const title = site?.title ?? "Portfolio";

  return (
    <div className="flex min-h-screen w-full flex-col bg-black text-zinc-100 md:flex-row">
      <aside className="shrink-0 border-b border-zinc-900 px-6 py-8 md:sticky md:top-0 md:h-screen md:w-56 md:overflow-y-auto md:border-b-0 md:border-r md:px-6 md:py-10">
        <Link href="/" className="block text-base font-medium tracking-tight text-zinc-50">
          {title}
        </Link>
        {collections.length > 0 ? (
          <nav className="mt-8 flex flex-col gap-2">
            {collections.map((c) => (
              <Link
                key={c.rkey}
                href={`/c/${c.rkey}`}
                className="text-sm text-zinc-500 transition-colors hover:text-zinc-50"
              >
                {c.record.title}
              </Link>
            ))}
          </nav>
        ) : null}
        <div className="mt-8 border-t border-zinc-900 pt-6">
          <Link href="/about" className="text-sm text-zinc-500 transition-colors hover:text-zinc-50">
            About
          </Link>
        </div>
      </aside>
      <main className="flex-1 px-6 py-10 md:px-12 md:py-12">{children}</main>
    </div>
  );
}
