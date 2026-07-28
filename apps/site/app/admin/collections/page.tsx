import type { Metadata } from "next";
import {
  OPENCONTENT_COLLECTION,
  OPENCONTENT_PHOTOGRAPH,
  type CollectionRecord,
  type PhotographRecord,
} from "@open-portfolio/lexicons";
import { AdminShell, requireAdminSession } from "@/components/admin-shell";
import { rkeyFromUri } from "@/lib/at-uri";
import { blobRefCid } from "@/lib/blob-ref";
import { imgSrc } from "@/lib/img-src";
import { listAllRecords } from "@/lib/pds";
import { CollectionEditor, type EditableCollection, type PhotographOption } from "./collection-editor";

export const metadata: Metadata = {
  title: "Collections — Open Portfolio",
};

// Reads live PDS data on every request -- never prerender at build.
export const dynamic = "force-dynamic";

export default async function AdminCollectionsPage() {
  await requireAdminSession(); // gate before fetching -- see its own comment

  const [collectionRecords, photographRecords] = await Promise.all([
    listAllRecords<CollectionRecord>(OPENCONTENT_COLLECTION),
    listAllRecords<PhotographRecord>(OPENCONTENT_PHOTOGRAPH),
  ]);

  const photographs: PhotographOption[] = photographRecords
    .slice()
    .sort((a, b) => (b.value.createdAt ?? "").localeCompare(a.value.createdAt ?? ""))
    .map((r) => {
      const cid = blobRefCid(r.value.image.ref);
      return {
        uri: r.uri,
        cid: r.cid,
        title: r.value.title,
        // Re-encoded proxy rendition (spec §9), not the raw PDS blob -- A9.
        thumbnailUrl: cid ? imgSrc(cid, "thumb") : undefined,
      };
    });

  const collections: EditableCollection[] = collectionRecords
    .slice()
    .sort((a, b) => (b.value.createdAt ?? "").localeCompare(a.value.createdAt ?? ""))
    .map((r) => ({
      rkey: rkeyFromUri(r.uri),
      title: r.value.title,
      description: r.value.description,
      items: r.value.items,
      cover: r.value.cover,
    }));

  return (
    <AdminShell>
      <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">Collections</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Group photographs into galleries. Drag to reorder, set a cover, and delete photographs you no longer need.
      </p>
      <CollectionEditor collections={collections} photographs={photographs} />
    </AdminShell>
  );
}
