"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { rkeyFromUri } from "@/lib/at-uri";
import { moveItem } from "@/lib/reorder";
import { deleteRecordAction, saveCollection } from "../actions";
import { buildCollectionFormData, type StrongRefLike } from "./collection-form-data";

// Mirror OPENCONTENT_COLLECTION/OPENCONTENT_PHOTOGRAPH from
// @open-portfolio/lexicons as local literals (same convention
// app/admin/actions.test.ts already uses) rather than importing the
// package into this client bundle for two NSID strings.
const COLLECTION_NSID = "social.opencontent.collection";
const PHOTOGRAPH_NSID = "social.opencontent.photograph";

export interface EditableCollection {
  rkey: string;
  title: string;
  description?: string;
  items: StrongRefLike[];
  cover?: StrongRefLike;
}

export interface PhotographOption {
  uri: string;
  cid: string;
  title?: string;
  thumbnailUrl?: string;
}

interface PhotoDeleteState {
  status: "pending" | "referenced" | "error";
  error?: string;
  referencedBy?: string[];
}

/**
 * List + create + editor for `social.opencontent.collection` records, all
 * in one client component (no separate `/admin/collections/[rkey]` route —
 * "selected" is just local state). The editor's photograph picker doubles
 * as the app's only photograph-library browser, which is also where
 * deleting a photograph lives: `deleteRecordActionCore`'s "referenced by N
 * collections" check is a collections-membership question, so surfacing it
 * anywhere else would mean re-fetching the same collections data this page
 * already has.
 */
export function CollectionEditor({
  collections,
  photographs,
}: {
  collections: EditableCollection[];
  photographs: PhotographOption[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftItems, setDraftItems] = useState<StrongRefLike[]>([]);
  const [draftCover, setDraftCover] = useState<StrongRefLike | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | undefined>();

  const [collectionDeleteError, setCollectionDeleteError] = useState<Record<string, string>>({});
  const [photoState, setPhotoState] = useState<Record<string, PhotoDeleteState>>({});

  // Fresh server props landed (router.refresh() after a successful delete) —
  // drop stale per-item state for anything no longer present, the same
  // "fresh props win" pattern as Luminance's LikeButton.
  useEffect(() => {
    const stillPresent = new Set(collections.map((c) => c.rkey));
    setCollectionDeleteError((prev) => {
      const next: Record<string, string> = {};
      for (const [rkey, message] of Object.entries(prev)) if (stillPresent.has(rkey)) next[rkey] = message;
      return next;
    });
  }, [collections]);

  useEffect(() => {
    const stillPresent = new Set(photographs.map((p) => p.uri));
    setPhotoState((prev) => {
      const next: Record<string, PhotoDeleteState> = {};
      for (const [uri, state] of Object.entries(prev)) if (stillPresent.has(uri)) next[uri] = state;
      return next;
    });
  }, [photographs]);

  function openNew() {
    setSelected("new");
    setDraftTitle("");
    setDraftDescription("");
    setDraftItems([]);
    setDraftCover(undefined);
    setSaveError(undefined);
  }

  function openExisting(collection: EditableCollection) {
    setSelected(collection.rkey);
    setDraftTitle(collection.title);
    setDraftDescription(collection.description ?? "");
    setDraftItems(collection.items);
    setDraftCover(collection.cover);
    setSaveError(undefined);
  }

  function save() {
    if (!draftTitle.trim()) {
      setSaveError("title is required");
      return;
    }
    setSaveError(undefined);
    startTransition(async () => {
      const fd = buildCollectionFormData({
        rkey: selected && selected !== "new" ? selected : undefined,
        title: draftTitle,
        description: draftDescription,
        items: draftItems,
        cover: draftCover,
      });
      const result = await saveCollection(fd);
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }
      setSelected(null);
      router.refresh();
    });
  }

  function deleteCollection(rkey: string) {
    setCollectionDeleteError((s) => {
      const next = { ...s };
      delete next[rkey];
      return next;
    });
    startTransition(async () => {
      const fd = new FormData();
      fd.set("collection", COLLECTION_NSID);
      fd.set("rkey", rkey);
      const result = await deleteRecordAction(fd);
      if (!result.ok) {
        setCollectionDeleteError((s) => ({ ...s, [rkey]: result.error }));
        return;
      }
      if (selected === rkey) setSelected(null);
      router.refresh();
    });
  }

  function deletePhotograph(uri: string, force = false) {
    setPhotoState((s) => ({ ...s, [uri]: { status: "pending" } }));
    startTransition(async () => {
      const fd = new FormData();
      fd.set("collection", PHOTOGRAPH_NSID);
      fd.set("rkey", rkeyFromUri(uri));
      if (force) fd.set("force", "true");
      const result = await deleteRecordAction(fd);
      if (!result.ok) {
        if (result.code === "referenced") {
          setPhotoState((s) => ({
            ...s,
            [uri]: { status: "referenced", error: result.error, referencedBy: result.collections ?? [] },
          }));
        } else {
          setPhotoState((s) => ({ ...s, [uri]: { status: "error", error: result.error } }));
        }
        return;
      }
      setDraftItems((items) => items.filter((i) => i.uri !== uri));
      setDraftCover((c) => (c?.uri === uri ? undefined : c));
      router.refresh();
    });
  }

  function addToDraft(photo: PhotographOption) {
    setDraftItems((items) => (items.some((i) => i.uri === photo.uri) ? items : [...items, { uri: photo.uri, cid: photo.cid }]));
  }

  function removeFromDraft(uri: string) {
    setDraftItems((items) => items.filter((i) => i.uri !== uri));
    setDraftCover((c) => (c?.uri === uri ? undefined : c));
  }

  function onItemDrop(index: number, e: React.DragEvent) {
    e.preventDefault();
    const from = Number(e.dataTransfer.getData("text/plain"));
    if (Number.isNaN(from)) return;
    setDraftItems((items) => moveItem(items, from, index));
  }

  function photoTitle(uri: string): string {
    return photographs.find((p) => p.uri === uri)?.title ?? uri;
  }
  function photoThumbnail(uri: string): string | undefined {
    return photographs.find((p) => p.uri === uri)?.thumbnailUrl;
  }

  return (
    <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-[280px_1fr]">
      <div>
        <button
          type="button"
          onClick={openNew}
          className="w-full rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          + New collection
        </button>
        <ul className="mt-4 space-y-2">
          {collections.map((collection) => (
            <li
              key={collection.rkey}
              className={`rounded-md border p-3 text-sm ${
                selected === collection.rkey
                  ? "border-zinc-400 dark:border-zinc-500"
                  : "border-zinc-200 dark:border-zinc-800"
              }`}
            >
              <div className="font-medium text-black dark:text-zinc-50">{collection.title}</div>
              <div className="text-xs text-zinc-500">{collection.items.length} photograph(s)</div>
              <div className="mt-2 flex gap-3">
                <button
                  type="button"
                  onClick={() => openExisting(collection)}
                  className="text-xs text-zinc-600 underline hover:text-black dark:text-zinc-400 dark:hover:text-zinc-100"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => deleteCollection(collection.rkey)}
                  className="text-xs text-zinc-600 hover:text-red-500 dark:text-zinc-400 dark:hover:text-red-400"
                >
                  Delete
                </button>
              </div>
              {collectionDeleteError[collection.rkey] ? (
                <p role="alert" className="mt-1 text-xs text-red-500">
                  {collectionDeleteError[collection.rkey]}
                </p>
              ) : null}
            </li>
          ))}
          {collections.length === 0 ? <li className="text-sm text-zinc-500">No collections yet.</li> : null}
        </ul>
      </div>

      <div>
        {selected !== null ? (
          <div className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
            <h2 className="text-lg font-semibold text-black dark:text-zinc-50">
              {selected === "new" ? "New collection" : "Edit collection"}
            </h2>

            <label className="mt-4 block text-sm">
              <span className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">Title</span>
              <input
                type="text"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                className={INPUT_CLASS}
              />
            </label>

            <label className="mt-4 block text-sm">
              <span className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">Description</span>
              <textarea
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                rows={2}
                className={INPUT_CLASS}
              />
            </label>

            <h3 className="mt-6 text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Photographs in this collection (drag to reorder)
            </h3>
            {draftItems.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">None yet — add some from the library below.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {draftItems.map((item, index) => (
                  <li
                    key={item.uri}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", String(index));
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => onItemDrop(index, e)}
                    className="flex cursor-grab items-center gap-3 rounded-md border border-zinc-200 p-2 dark:border-zinc-800"
                  >
                    <Thumbnail src={photoThumbnail(item.uri)} />
                    <span className="flex-1 truncate text-sm text-black dark:text-zinc-100">{photoTitle(item.uri)}</span>
                    <button
                      type="button"
                      onClick={() => setDraftCover(item)}
                      className={`text-xs ${
                        draftCover?.uri === item.uri
                          ? "font-medium text-amber-600 dark:text-amber-400"
                          : "text-zinc-500 hover:text-black dark:hover:text-zinc-100"
                      }`}
                    >
                      {draftCover?.uri === item.uri ? "★ Cover" : "Set as cover"}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeFromDraft(item.uri)}
                      className="text-xs text-zinc-500 hover:text-red-500 dark:hover:text-red-400"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {saveError ? (
              <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">
                {saveError}
              </p>
            ) : null}

            <div className="mt-4 flex gap-3">
              <button
                type="button"
                onClick={save}
                disabled={isPending}
                className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
              >
                {isPending ? "Saving…" : "Save collection"}
              </button>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-zinc-500">Select a collection to edit, or create a new one.</p>
        )}

        <h2 className="mt-8 text-lg font-semibold text-black dark:text-zinc-50">Photograph library</h2>
        <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {photographs.map((photo) => {
            const inDraft = draftItems.some((i) => i.uri === photo.uri);
            const state = photoState[photo.uri];
            return (
              <li key={photo.uri} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                <div className="flex items-center gap-3">
                  <Thumbnail src={photo.thumbnailUrl} />
                  <span className="flex-1 truncate text-sm text-black dark:text-zinc-100">{photo.title ?? photo.uri}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-3">
                  {selected !== null ? (
                    inDraft ? (
                      <button
                        type="button"
                        onClick={() => removeFromDraft(photo.uri)}
                        className="text-xs text-zinc-600 dark:text-zinc-400"
                      >
                        In collection — Remove
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => addToDraft(photo)}
                        className="text-xs text-zinc-600 underline hover:text-black dark:text-zinc-400 dark:hover:text-zinc-100"
                      >
                        Add to collection
                      </button>
                    )
                  ) : null}
                  <button
                    type="button"
                    onClick={() => deletePhotograph(photo.uri)}
                    disabled={state?.status === "pending"}
                    className="text-xs text-zinc-600 hover:text-red-500 disabled:opacity-50 dark:text-zinc-400 dark:hover:text-red-400"
                  >
                    {state?.status === "pending" ? "Deleting…" : "Delete"}
                  </button>
                </div>
                {state?.status === "referenced" ? (
                  <div role="alert" className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                    <p>
                      Still referenced by {state.referencedBy?.length ?? 0} collection(s)
                      {state.referencedBy && state.referencedBy.length > 0 ? `: ${state.referencedBy.join(", ")}` : ""}.
                    </p>
                    <button
                      type="button"
                      onClick={() => deletePhotograph(photo.uri, true)}
                      className="mt-1 underline hover:text-amber-800 dark:hover:text-amber-200"
                    >
                      Delete anyway
                    </button>
                  </div>
                ) : null}
                {state?.status === "error" ? (
                  <p role="alert" className="mt-2 text-xs text-red-500">
                    {state.error}
                  </p>
                ) : null}
              </li>
            );
          })}
          {photographs.length === 0 ? <li className="text-sm text-zinc-500">No photographs published yet.</li> : null}
        </ul>
      </div>
    </div>
  );
}

function Thumbnail({ src }: { src?: string }) {
  if (!src) {
    return <span className="h-12 w-12 shrink-0 rounded bg-zinc-200 dark:bg-zinc-800" aria-hidden="true" />;
  }
  // eslint-disable-next-line @next/next/no-img-element -- already-resized /img proxy rendition, not a next/image-optimizable local asset.
  return <img src={src} alt="" className="h-12 w-12 shrink-0 rounded object-cover" />;
}

const INPUT_CLASS =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-black placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600 dark:focus:border-zinc-600";
