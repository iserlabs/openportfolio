import { imgSrc } from "@/lib/img-src";
import { PhotoCard } from "./photo-card";

/**
 * Ported from `~/workspace/luminance.social/apps/web/components/photo-grid.tsx`'s
 * CSS-columns masonry-ish layout, with the data shape swapped for
 * opencontent records: `rkey`-keyed hrefs to `/p/[rkey]` and an image `src`
 * built via {@link imgSrc} (the single seam A9 will repoint at the real
 * `/img/...` proxy).
 */
export interface GridItem {
  rkey: string;
  cid: string;
  alt: string;
  width: number;
  height: number;
}

export function PhotoGrid({ items }: { items: GridItem[] }) {
  return (
    <div className="block gap-4 sm:columns-2 lg:columns-3">
      {items.map((item, i) => (
        <PhotoCard
          key={item.rkey}
          href={`/p/${item.rkey}`}
          src={imgSrc(item.cid)}
          alt={item.alt}
          width={item.width}
          height={item.height}
          priority={i < 2}
          eager={i >= 2 && i < 4}
        />
      ))}
    </div>
  );
}
