import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import type { Exif } from "@open-portfolio/lexicons";
import { blobRefCid } from "@/lib/blob-ref";
import { blurDataUrls } from "@/lib/blur";
import { absoluteImgSrc, imgSrc } from "@/lib/img-src";
import { getPortfolio, neighborsInCollection } from "@/lib/portfolio";
import { LightboxProvider, LightboxTrigger } from "@/components/lightbox";

export const dynamic = "force-dynamic"; // see (public)/layout.tsx's comment

interface PhotographPageParams {
  params: Promise<{ rkey: string }>;
}

export async function generateMetadata({ params }: PhotographPageParams): Promise<Metadata> {
  const { rkey } = await params;
  const { photographs, site } = await getPortfolio();
  const photo = photographs.get(rkey);
  if (!photo) return {};

  const cid = blobRefCid(photo.image.ref);
  const title = photo.title ?? site?.title ?? "Photograph";
  const description = photo.description;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "article",
      images: cid
        ? [{ url: absoluteImgSrc(cid), width: photo.aspectRatio.width, height: photo.aspectRatio.height }]
        : undefined,
    },
  };
}

// Ordered label/value rows for the EXIF table -- only fields actually present render.
function exifRows(exif: Exif | undefined) {
  if (!exif) return [];
  const rows: { label: string; value: string }[] = [];
  if (exif.camera) rows.push({ label: "Camera", value: exif.camera });
  if (exif.lens) rows.push({ label: "Lens", value: exif.lens });
  if (exif.focalLength) rows.push({ label: "Focal length", value: exif.focalLength });
  if (exif.fNumber) rows.push({ label: "Aperture", value: `f/${exif.fNumber}` });
  if (exif.shutterSpeed) rows.push({ label: "Shutter speed", value: exif.shutterSpeed });
  if (exif.iso !== undefined) rows.push({ label: "ISO", value: String(exif.iso) });
  return rows;
}

export default async function PhotographPage({ params }: PhotographPageParams) {
  const { rkey } = await params;
  const portfolio = await getPortfolio();
  const photo = portfolio.photographs.get(rkey);
  if (!photo) notFound();

  const cid = blobRefCid(photo.image.ref);
  const src = cid ? imgSrc(cid, "full") : null;
  const srcSet = cid ? `${imgSrc(cid, "feed")} 1024w, ${imgSrc(cid, "full")} 2048w` : undefined;
  const blurDataUrl = cid ? (blurDataUrls([cid]).get(cid) ?? null) : null;
  const alt = photo.alt ?? photo.title ?? "";
  const { collection, prevRkey, nextRkey } = neighborsInCollection(portfolio, rkey);
  const rows = exifRows(photo.exif);

  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-8">
      {src ? (
        <LightboxProvider items={[{ src, alt }]}>
          <LightboxTrigger index={0}>
            <div
              style={{
                aspectRatio: `${photo.aspectRatio.width}/${photo.aspectRatio.height}`,
                // Blur-up: the tiny placeholder paints instantly as a background;
                // the real <img> covers it the moment it decodes.
                ...(blurDataUrl ? { backgroundImage: `url("${blurDataUrl}")`, backgroundSize: "cover" } : {}),
              }}
              className="overflow-hidden rounded-md bg-zinc-900"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                srcSet={srcSet}
                sizes="(min-width: 768px) 720px, 100vw"
                alt={alt}
                className="h-full w-full object-contain"
              />
            </div>
          </LightboxTrigger>
        </LightboxProvider>
      ) : null}

      <header>
        {photo.title ? <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">{photo.title}</h1> : null}
        {photo.description ? <p className="mt-3 text-zinc-400">{photo.description}</p> : null}
      </header>

      {rows.length > 0 ? (
        <table className="w-fit text-sm">
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th className="pr-4 py-0.5 text-left font-medium text-zinc-500">{row.label}</th>
                <td className="py-0.5 text-zinc-300">{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {photo.tags && photo.tags.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {photo.tags.map((tag) => (
            <li key={tag} className="rounded-full border border-zinc-800 px-3 py-1 text-xs text-zinc-400">
              {tag}
            </li>
          ))}
        </ul>
      ) : null}

      {photo.license || photo.location ? (
        <dl className="flex flex-col gap-1 text-sm text-zinc-500">
          {photo.location ? (
            <div>
              <dt className="inline font-medium text-zinc-400">Location: </dt>
              <dd className="inline">{photo.location}</dd>
            </div>
          ) : null}
          {photo.license ? (
            <div>
              <dt className="inline font-medium text-zinc-400">License: </dt>
              <dd className="inline">{photo.license}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {collection ? (
        <nav className="mt-4 flex items-center justify-between border-t border-zinc-900 pt-6 text-sm">
          {prevRkey ? (
            <Link href={`/p/${prevRkey}`} className="text-zinc-400 hover:text-zinc-50">
              &larr; Previous
            </Link>
          ) : (
            <span />
          )}
          <Link href={`/c/${collection.rkey}`} className="text-zinc-500 hover:text-zinc-50">
            {collection.record.title}
          </Link>
          {nextRkey ? (
            <Link href={`/p/${nextRkey}`} className="text-zinc-400 hover:text-zinc-50">
              Next &rarr;
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </article>
  );
}
