"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { moveItem } from "@/lib/reorder";
import { safeExternalHref } from "@/lib/safe-href";
import { saveSite } from "../actions";
import { buildSiteFormData, type SiteLinkLike } from "./site-form-data";

const THEME_OPTIONS = [
  { value: "", label: "Default" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "Follow system" },
];

export interface SiteFormInitial {
  title: string;
  about: string;
  theme: string;
  links: SiteLinkLike[];
  /** Already reconciled against the current collection set (`lib/collection-order.ts`'s `mergeCollectionOrder`) by the server page. */
  collectionOrder: string[];
}

/**
 * One save via `saveSite`. Reorders (nav order + links) use simple up/down
 * buttons rather than the collection editor's HTML5 drag-and-drop — both
 * lists here are short (`site.links` caps at 10, collections rarely number
 * more than a handful), and keyboard-operable buttons are more robust than
 * mouse-only drag for a list this size.
 */
export function SiteForm({
  initial,
  collections,
}: {
  initial: SiteFormInitial;
  collections: { rkey: string; title: string }[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [title, setTitle] = useState(initial.title);
  const [about, setAbout] = useState(initial.about);
  const [theme, setTheme] = useState(initial.theme);
  const [links, setLinks] = useState<SiteLinkLike[]>(initial.links);
  const [order, setOrder] = useState<string[]>(initial.collectionOrder);
  const [error, setError] = useState<string | undefined>();
  const [linkErrors, setLinkErrors] = useState<Record<number, string>>({});

  function collectionTitle(rkey: string): string {
    return collections.find((c) => c.rkey === rkey)?.title ?? rkey;
  }

  function addLink() {
    setLinks((ls) => [...ls, { label: "", uri: "" }]);
  }
  function updateLink(index: number, patch: Partial<SiteLinkLike>) {
    setLinks((ls) => ls.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function removeLink(index: number) {
    setLinks((ls) => ls.filter((_, i) => i !== index));
  }

  function save() {
    if (!title.trim()) {
      setError("title is required");
      return;
    }

    const nextLinkErrors: Record<number, string> = {};
    links.forEach((link, i) => {
      const hasLabel = link.label.trim().length > 0;
      const hasUri = link.uri.trim().length > 0;
      if (!hasLabel && !hasUri) return; // a fully-blank row is just dropped at save time, not an error
      if (!hasLabel || !hasUri) {
        nextLinkErrors[i] = "both a label and a URL are required";
      } else if (!safeExternalHref(link.uri)) {
        nextLinkErrors[i] = "must be a valid http:// or https:// URL";
      }
    });
    setLinkErrors(nextLinkErrors);
    if (Object.keys(nextLinkErrors).length > 0) {
      setError("fix the highlighted link(s) before saving");
      return;
    }

    setError(undefined);
    startTransition(async () => {
      const fd = buildSiteFormData({ title, about, theme, collectionOrder: order, links });
      const result = await saveSite(fd);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="mt-6 max-w-2xl space-y-8">
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">Title</span>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} className={INPUT_CLASS} />
      </label>

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">About</span>
        <textarea value={about} onChange={(e) => setAbout(e.target.value)} rows={4} className={INPUT_CLASS} />
      </label>

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">Theme</span>
        <select value={theme} onChange={(e) => setTheme(e.target.value)} className={INPUT_CLASS}>
          {THEME_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <div>
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Collection nav order</h2>
        {order.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">No collections yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {order.map((rkey, index) => (
              <li
                key={rkey}
                className="flex items-center gap-3 rounded-md border border-zinc-200 p-2 text-sm dark:border-zinc-800"
              >
                <span className="flex-1 truncate text-black dark:text-zinc-100">{collectionTitle(rkey)}</span>
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => setOrder((o) => moveItem(o, index, index - 1))}
                  className="text-xs text-zinc-500 hover:text-black disabled:opacity-30 dark:hover:text-zinc-100"
                  aria-label={`Move ${collectionTitle(rkey)} up`}
                >
                  ▲
                </button>
                <button
                  type="button"
                  disabled={index === order.length - 1}
                  onClick={() => setOrder((o) => moveItem(o, index, index + 1))}
                  className="text-xs text-zinc-500 hover:text-black disabled:opacity-30 dark:hover:text-zinc-100"
                  aria-label={`Move ${collectionTitle(rkey)} down`}
                >
                  ▼
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Links</h2>
        <ul className="mt-2 space-y-3">
          {links.map((link, index) => (
            <li key={index} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={link.label}
                  onChange={(e) => updateLink(index, { label: e.target.value })}
                  placeholder="Label (e.g. Instagram)"
                  className={INPUT_CLASS}
                />
                <input
                  type="text"
                  value={link.uri}
                  onChange={(e) => updateLink(index, { uri: e.target.value })}
                  placeholder="https://…"
                  className={INPUT_CLASS}
                />
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => setLinks((ls) => moveItem(ls, index, index - 1))}
                  className="shrink-0 text-xs text-zinc-500 hover:text-black disabled:opacity-30 dark:hover:text-zinc-100"
                  aria-label="Move link up"
                >
                  ▲
                </button>
                <button
                  type="button"
                  disabled={index === links.length - 1}
                  onClick={() => setLinks((ls) => moveItem(ls, index, index + 1))}
                  className="shrink-0 text-xs text-zinc-500 hover:text-black disabled:opacity-30 dark:hover:text-zinc-100"
                  aria-label="Move link down"
                >
                  ▼
                </button>
                <button
                  type="button"
                  onClick={() => removeLink(index)}
                  className="shrink-0 text-xs text-zinc-500 hover:text-red-500 dark:hover:text-red-400"
                >
                  Remove
                </button>
              </div>
              {linkErrors[index] ? (
                <p role="alert" className="mt-1 text-xs text-red-500">
                  {linkErrors[index]}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={addLink}
          className="mt-3 text-sm text-zinc-600 underline hover:text-black dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          + Add link
        </button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        onClick={save}
        disabled={isPending}
        className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
      >
        {isPending ? "Saving…" : "Save site settings"}
      </button>
    </div>
  );
}

const INPUT_CLASS =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-black placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600 dark:focus:border-zinc-600";
