import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { blobRefCid } from "@/lib/blob-ref";
import { imgSrc } from "@/lib/img-src";
import { collectionCover, collectionPhotographs, getPortfolio } from "@/lib/portfolio";
import { PhotoGrid, type GridItem } from "@/components/photo-grid";

export const dynamic = "force-dynamic"; // see (public)/layout.tsx's comment

interface CollectionPageParams {
  params: Promise<{ rkey: string }>;
}

export async function generateMetadata({ params }: CollectionPageParams): Promise<Metadata> {
  const { rkey } = await params;
  const { collections, photographs } = await getPortfolio();
  const collection = collections.find((c) => c.rkey === rkey);
  if (!collection) return {};

  const cover = collectionCover(collection.record, photographs);
  const coverCid = cover ? blobRefCid(cover.image.ref) : undefined;

  return {
    title: collection.record.title,
    description: collection.record.description,
    openGraph: {
      title: collection.record.title,
      description: collection.record.description,
      images: coverCid && cover ? [{ url: imgSrc(coverCid), width: cover.aspectRatio.width, height: cover.aspectRatio.height }] : undefined,
    },
  };
}

export default async function CollectionPage({ params }: CollectionPageParams) {
  const { rkey } = await params;
  const portfolio = await getPortfolio();
  const collection = portfolio.collections.find((c) => c.rkey === rkey);
  if (!collection) notFound();

  const items: GridItem[] = collectionPhotographs(collection.record, portfolio.photographs).flatMap(
    ({ rkey: photoRkey, photograph }) => {
      const cid = blobRefCid(photograph.image.ref);
      if (!cid) return [];
      return [
        {
          rkey: photoRkey,
          cid,
          alt: photograph.alt ?? photograph.title ?? "",
          width: photograph.aspectRatio.width,
          height: photograph.aspectRatio.height,
        },
      ];
    },
  );

  return (
    <section>
      <h1 className="text-xl font-semibold tracking-tight text-zinc-50">{collection.record.title}</h1>
      {collection.record.description ? (
        <p className="mt-2 max-w-2xl text-sm text-zinc-400">{collection.record.description}</p>
      ) : null}
      <div className="mt-8">
        {items.length > 0 ? (
          <PhotoGrid items={items} />
        ) : (
          <p className="text-sm text-zinc-500">No photographs in this collection yet.</p>
        )}
      </div>
    </section>
  );
}
