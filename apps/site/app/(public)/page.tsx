import type { Metadata } from "next";
import { blobRefCid } from "@/lib/blob-ref";
import { getPortfolio, homeFeed } from "@/lib/portfolio";
import { PhotoGrid, type GridItem } from "@/components/photo-grid";

export const dynamic = "force-dynamic"; // see (public)/layout.tsx's comment

export async function generateMetadata(): Promise<Metadata> {
  const { site } = await getPortfolio();
  return {
    title: site?.title ?? "Portfolio",
    description: site?.about,
  };
}

/**
 * Home page per the spec's ordering rule: the first collection in
 * `getPortfolio()`'s ordered `collections` (site.collectionOrder honored),
 * showing its own resolved photographs -- or, when there are no collections
 * at all yet, every published photograph, newest-first. All of that
 * selection logic lives in `lib/portfolio.ts`'s `homeFeed`; this page only
 * shapes the result into grid props.
 */
export default async function HomePage() {
  const portfolio = await getPortfolio();
  const feed = homeFeed(portfolio);

  const items: GridItem[] = feed.photographs.flatMap(({ rkey, photograph }) => {
    const cid = blobRefCid(photograph.image.ref);
    if (!cid) return [];
    return [
      {
        rkey,
        cid,
        alt: photograph.alt ?? photograph.title ?? "",
        width: photograph.aspectRatio.width,
        height: photograph.aspectRatio.height,
      },
    ];
  });

  return (
    <section>
      {feed.collection ? (
        <h1 className="mb-8 text-xl font-semibold tracking-tight text-zinc-50">{feed.collection.record.title}</h1>
      ) : null}
      {items.length > 0 ? (
        <PhotoGrid items={items} />
      ) : (
        <p className="text-sm text-zinc-500">Nothing published yet.</p>
      )}
    </section>
  );
}
