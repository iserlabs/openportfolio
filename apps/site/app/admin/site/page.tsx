import type { Metadata } from "next";
import {
  OPENCONTENT_COLLECTION,
  OPENCONTENT_SITE,
  type CollectionRecord,
  type SiteRecord,
} from "@open-portfolio/lexicons";
import { AdminShell, requireAdminSession } from "@/components/admin-shell";
import { rkeyFromUri } from "@/lib/at-uri";
import { mergeCollectionOrder } from "@/lib/collection-order";
import { getRecord, listAllRecords } from "@/lib/pds";
import { SiteForm } from "./site-form";

export const metadata: Metadata = {
  title: "Site settings — Open Portfolio",
};

// Reads live PDS data on every request -- never prerender at build.
export const dynamic = "force-dynamic";

export default async function AdminSitePage() {
  await requireAdminSession(); // gate before fetching -- see its own comment

  const [site, collectionRecords] = await Promise.all([
    getRecord<SiteRecord>(OPENCONTENT_SITE, "self"),
    listAllRecords<CollectionRecord>(OPENCONTENT_COLLECTION),
  ]);

  const collections = collectionRecords.map((r) => ({ rkey: rkeyFromUri(r.uri), title: r.value.title }));
  const allRkeys = collections.map((c) => c.rkey);
  const collectionOrder = mergeCollectionOrder(site?.value.collectionOrder ?? [], allRkeys);

  return (
    <AdminShell>
      <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">Site settings</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Your portfolio&apos;s public identity: title, about text, nav order, links, and theme.
      </p>
      <SiteForm
        initial={{
          title: site?.value.title ?? "",
          about: site?.value.about ?? "",
          theme: site?.value.theme ?? "",
          links: site?.value.links ?? [],
          collectionOrder,
        }}
        collections={collections}
      />
    </AdminShell>
  );
}
