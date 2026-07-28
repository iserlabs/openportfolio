import { imgSrc, imgSrcSet } from "@/lib/img-src";
import { PhotoCard } from "./photo-card";

/**
 * Ported from `~/workspace/luminance.social/apps/web/components/photo-grid.tsx`'s
 * CSS-columns masonry-ish layout, with the data shape swapped for
 * opencontent records: `rkey`-keyed hrefs to `/p/[rkey]` and an image `src`/
 * `srcSet` built via `lib/img-src.ts` against the real `/img/...` proxy
 * (A9). `sizes` matches Luminance's grid tile value exactly.
 */
export interface GridItem {
  rkey: string;
  cid: string;
  alt: string;
  width: number;
  height: number;
  /** ~16px blur-up placeholder from `lib/blur.ts`, or null/undefined if the proxy hasn't served this cid yet. */
  blurDataUrl?: string | null;
}

export function PhotoGrid({ items }: { items: GridItem[] }) {
  return (
    <div className="block gap-4 sm:columns-2 lg:columns-3">
      {items.map((item, i) => (
        <PhotoCard
          key={item.rkey}
          href={`/p/${item.rkey}`}
          src={imgSrc(item.cid)}
          srcSet={imgSrcSet(item.cid)}
          sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
          alt={item.alt}
          width={item.width}
          height={item.height}
          priority={i < 2}
          eager={i >= 2 && i < 4}
          blurDataUrl={item.blurDataUrl}
        />
      ))}
    </div>
  );
}
