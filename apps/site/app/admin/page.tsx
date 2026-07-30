import type { Metadata } from "next";
import Link from "next/link";
import {
  OPENCONTENT_COLLECTION,
  OPENCONTENT_PHOTOGRAPH,
  OPENCONTENT_SITE,
  type CollectionRecord,
  type PhotographRecord,
  type SiteRecord,
} from "@openportfolio/lexicons";
import { AdminShell, requireAdminSession } from "@/components/admin-shell";
import { getRecord, listAllRecords } from "@/lib/pds";

export const metadata: Metadata = {
  title: "Admin dashboard — Open Portfolio",
};

// Reads live PDS data + the owner's session on every request -- never
// prerender at build (matches app/oauth/callback/route.ts's and
// app/oauth/jwks.json/route.ts's own explicit `force-dynamic`).
export const dynamic = "force-dynamic";

const QUICK_LINKS = [
  { href: "/admin/upload", label: "Upload photographs" },
  { href: "/admin/collections", label: "Manage collections" },
  { href: "/admin/site", label: "Site settings" },
];

export default async function AdminDashboardPage() {
  // Gate before fetching -- an anonymous visitor to /admin should never
  // trigger a real PDS request (see requireAdminSession's own comment).
  await requireAdminSession();

  const [photographs, collections, site] = await Promise.all([
    listAllRecords<PhotographRecord>(OPENCONTENT_PHOTOGRAPH),
    listAllRecords<CollectionRecord>(OPENCONTENT_COLLECTION),
    getRecord<SiteRecord>(OPENCONTENT_SITE, "self"),
  ]);

  const stats = [
    { label: "Photographs", value: photographs.length, href: "/admin/upload" },
    { label: "Collections", value: collections.length, href: "/admin/collections" },
  ];

  return (
    <AdminShell>
      <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">Dashboard</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        {site
          ? `Site title: "${site.value.title}".`
          : "No site record published yet — set one up in Site settings."}
      </p>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {stats.map((stat) => (
          <Link
            key={stat.label}
            href={stat.href}
            className="rounded-lg border border-zinc-200 bg-white p-6 transition-colors hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-600"
          >
            <div className="text-3xl font-semibold text-black dark:text-zinc-50">{stat.value}</div>
            <div className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{stat.label}</div>
          </Link>
        ))}
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        {QUICK_LINKS.map((link, i) => (
          <Link
            key={link.href}
            href={link.href}
            className={
              i === 0
                ? "rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                : "rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            }
          >
            {link.label}
          </Link>
        ))}
      </div>
    </AdminShell>
  );
}
