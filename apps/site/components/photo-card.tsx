import Link from "next/link";

/**
 * Ported from `~/workspace/luminance.social/apps/web/components/photo-card.tsx`,
 * trimmed to what an opencontent photograph actually has: no `likeCount`/
 * `replyCount` overlay (the lexicon has no engagement counts) and no
 * sensitive-content blur/reveal step (no equivalent label vocabulary here).
 * The aspect-ratio box + blur-up background + srcSet/sizes shape is kept
 * as-is so a future rendition-aware `src` builder (multiple sizes via the
 * A9 `/img/...` proxy) is a prop-value change here, not a structural one.
 */
export interface PhotoCardProps {
  href: string;
  src: string;
  alt: string;
  width: number;
  height: number;
  /** Above-the-fold LCP candidates: eager-load with a high fetch priority. */
  priority?: boolean;
  /** Eager-load without claiming high fetch priority (tiles just below the fold). */
  eager?: boolean;
  /** Responsive renditions -- browsers pick the smallest sufficient file. Unused until A9 offers more than one size. */
  srcSet?: string;
  sizes?: string;
  /** ~16px blur-up placeholder painted behind the `<img>` until it decodes. Unused until a rendition pipeline can produce one. */
  blurDataUrl?: string | null;
}

export function PhotoCard({
  href,
  src,
  alt,
  width,
  height,
  priority = false,
  eager = false,
  srcSet,
  sizes,
  blurDataUrl,
}: PhotoCardProps) {
  return (
    <Link href={href} className="relative mb-4 block break-inside-avoid overflow-hidden rounded-md bg-zinc-900">
      <div
        style={{
          aspectRatio: `${width}/${height}`,
          ...(blurDataUrl ? { backgroundImage: `url("${blurDataUrl}")`, backgroundSize: "cover" } : {}),
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          srcSet={srcSet}
          sizes={sizes}
          alt={alt}
          width={width}
          height={height}
          loading={priority || eager ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : undefined}
          className="h-full w-full object-cover"
        />
      </div>
    </Link>
  );
}
