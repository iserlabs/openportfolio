import type { Metadata } from "next";
import { getPortfolio } from "@/lib/portfolio";
import { safeExternalHref } from "@/lib/safe-href";

export const dynamic = "force-dynamic"; // see (public)/layout.tsx's comment

export async function generateMetadata(): Promise<Metadata> {
  const { site } = await getPortfolio();
  const title = site ? `About — ${site.title}` : "About";
  return { title, description: site?.about };
}

/**
 * `site.links[].uri` is re-validated through `safeExternalHref` HERE, at
 * render time -- never trusting that the stored record's scheme is safe
 * just because the site-settings form already ran it through the same
 * check at write time (defense-in-depth carried from the A7 review: a
 * record written by any other means -- direct PDS write, a future admin
 * bug, a differently-behaved client -- must not be able to smuggle a
 * `javascript:`/`data:` href onto the public page). A link whose `uri`
 * fails validation is dropped from the list entirely, not rendered inert.
 */
export default async function AboutPage() {
  const { site } = await getPortfolio();

  return (
    <section className="max-w-2xl">
      <h1 className="text-xl font-semibold tracking-tight text-zinc-50">About</h1>
      {site?.about ? (
        <p className="mt-6 whitespace-pre-wrap leading-relaxed text-zinc-300">{site.about}</p>
      ) : (
        <p className="mt-6 text-sm text-zinc-500">Nothing here yet.</p>
      )}

      {site?.links && site.links.length > 0 ? (
        <ul className="mt-10 flex flex-col gap-2 border-t border-zinc-900 pt-6">
          {site.links.flatMap((link) => {
            const href = safeExternalHref(link.uri);
            if (!href) return [];
            return [
              <li key={link.label}>
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-zinc-300 underline underline-offset-4 hover:text-zinc-50"
                >
                  {link.label}
                </a>
              </li>,
            ];
          })}
        </ul>
      ) : null}
    </section>
  );
}
