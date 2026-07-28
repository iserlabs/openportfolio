"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatExifSummary } from "@/lib/exif-summary";
import { formatTagsCsv, parseTagsCsv } from "@/lib/tags-csv";
import { publishPhotograph } from "../actions";
import { canvasDownscale, estimateDownscaleDimensions, parseTooLargeLimitBytes } from "./downscale";
import { buildPublishFormData } from "./publish-form-data";

const ACCEPTED_TYPES = "image/jpeg,image/png,image/webp,image/avif,image/heic";
const TAGS_MAX_ITEMS = 20; // mirrors packages/lexicons/src/records.ts's TAGS_MAX_ITEMS

/** The `/admin/api/prefill` route's success-shape `prefill` payload — mirrors `lib/photo-metadata.ts`'s `Prefill` (declared locally so this client bundle never imports that server-only, node/sharp/exiftool-dependent module). */
interface PrefillData {
  title?: string;
  description?: string;
  tags: string[];
  capturedAt?: string;
  exif: {
    camera?: string;
    lens?: string;
    focalLength?: string;
    fNumber?: string;
    shutterSpeed?: string;
    iso?: number;
  };
  width: number;
  height: number;
  hasGps: boolean;
}

type PrefillStatus = "loading" | "loaded" | "failed";
type PublishStatus = "idle" | "pending" | "success" | "error" | "too-large";

interface Draft {
  id: string;
  file: File;
  width?: number;
  height?: number;
  prefillStatus: PrefillStatus;
  prefillError?: string;
  prefill?: PrefillData;
  publishStatus: PublishStatus;
  publishError?: string;
  uri?: string;
  title: string;
  description: string;
  alt: string;
  tags: string;
  license: string;
  location: string;
  capturedAt: string;
  keepGps: boolean;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `draft-${idCounter}`;
}

function makeDraft(file: File): Draft {
  return {
    id: nextId(),
    file,
    prefillStatus: "loading",
    publishStatus: "idle",
    title: "",
    description: "",
    alt: "",
    tags: "",
    license: "",
    location: "",
    capturedAt: "",
    keepGps: false,
  };
}

/**
 * Multi-file upload: a drop zone that turns each dropped/selected file into
 * a "draft" card, prefilled asynchronously from `/admin/api/prefill` (which
 * just runs `extractPrefill` server-side) while every field stays editable
 * regardless of whether that prefill succeeds — publishing never actually
 * depends on the client having prefill data (the server re-derives
 * aspectRatio/exif itself from the real uploaded bytes), so a failed prefill
 * degrades to "fill in manually," not "can't publish this file."
 *
 * The one exception is the post-rejection downscale flow: `estimateDownscale
 * Dimensions` needs the file's pixel dimensions, which this component only
 * has via a successful prefill (`draft.width`/`height`) — see the
 * `code:"too-large"` branch below.
 */
export function UploadForm() {
  const router = useRouter();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function updateDraft(id: string, patch: Partial<Draft>) {
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }

  async function loadPrefill(id: string, file: File) {
    updateDraft(id, { prefillStatus: "loading", prefillError: undefined });
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch("/admin/api/prefill", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "could not read image metadata");
      const prefill: PrefillData = json.prefill;
      updateDraft(id, {
        prefillStatus: "loaded",
        prefill,
        width: prefill.width,
        height: prefill.height,
        title: prefill.title ?? "",
        description: prefill.description ?? "",
        tags: formatTagsCsv(prefill.tags),
        capturedAt: prefill.capturedAt ?? "",
      });
    } catch (err) {
      updateDraft(id, {
        prefillStatus: "failed",
        prefillError: err instanceof Error ? err.message : "could not read image metadata",
      });
    }
  }

  function addFiles(files: FileList | File[]) {
    const newDrafts = Array.from(files).map(makeDraft);
    setDrafts((ds) => [...ds, ...newDrafts]);
    for (const draft of newDrafts) void loadPrefill(draft.id, draft.file);
  }

  function removeDraft(id: string) {
    setDrafts((ds) => ds.filter((d) => d.id !== id));
  }

  function publish(id: string) {
    const draft = drafts.find((d) => d.id === id);
    if (!draft) return;
    updateDraft(id, { publishStatus: "pending", publishError: undefined });
    startTransition(async () => {
      const result = await publishPhotograph(buildPublishFormData(draft.file, draft));
      if (!result.ok) {
        updateDraft(id, { publishStatus: result.code === "too-large" ? "too-large" : "error", publishError: result.error });
        return;
      }
      updateDraft(id, { publishStatus: "success", uri: result.uri, publishError: undefined });
      router.refresh();
    });
  }

  function downscaleAndRetry(id: string) {
    const draft = drafts.find((d) => d.id === id);
    if (!draft || draft.width == null || draft.height == null) return;
    updateDraft(id, { publishStatus: "pending", publishError: undefined });
    startTransition(async () => {
      try {
        const maxBytes = parseTooLargeLimitBytes(draft.publishError) ?? Math.round(draft.file.size * 0.5);
        const { width, height } = estimateDownscaleDimensions(draft.width!, draft.height!, draft.file.size, maxBytes);
        const blob = await canvasDownscale(draft.file, width, height, 0.92);
        const newFile = new File([blob], draft.file.name, { type: "image/jpeg" });
        updateDraft(id, { file: newFile, width, height });

        const result = await publishPhotograph(buildPublishFormData(newFile, draft));
        if (!result.ok) {
          updateDraft(id, {
            publishStatus: result.code === "too-large" ? "too-large" : "error",
            publishError: result.error,
          });
          return;
        }
        updateDraft(id, { publishStatus: "success", uri: result.uri, publishError: undefined });
        router.refresh();
      } catch (err) {
        updateDraft(id, { publishStatus: "error", publishError: err instanceof Error ? err.message : "downscale failed" });
      }
    });
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  }

  return (
    <div className="mt-6">
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        className={`cursor-pointer rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
          isDragging
            ? "border-zinc-500 bg-zinc-100 dark:border-zinc-500 dark:bg-zinc-900"
            : "border-zinc-300 dark:border-zinc-700"
        }`}
      >
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Drag and drop images here, or click to browse.</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED_TYPES}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {drafts.length > 0 ? (
        <ul className="mt-6 space-y-6">
          {drafts.map((draft) => (
            <li
              key={draft.id}
              className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800"
            >
              <DraftCard
                draft={draft}
                onChange={(patch) => updateDraft(draft.id, patch)}
                onRemove={() => removeDraft(draft.id)}
                onPublish={() => publish(draft.id)}
                onDownscaleAndRetry={() => downscaleAndRetry(draft.id)}
                onRetryPrefill={() => loadPrefill(draft.id, draft.file)}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function DraftCard({
  draft,
  onChange,
  onRemove,
  onPublish,
  onDownscaleAndRetry,
  onRetryPrefill,
}: {
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
  onRemove: () => void;
  onPublish: () => void;
  onDownscaleAndRetry: () => void;
  onRetryPrefill: () => void;
}) {
  const disabled = draft.publishStatus === "pending" || draft.publishStatus === "success";
  const tagCount = parseTagsCsv(draft.tags).length;
  const exifSummary = draft.prefill ? formatExifSummary(draft.prefill.exif) : "";

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-black dark:text-zinc-50">{draft.file.name}</p>
          {draft.prefillStatus === "loading" ? (
            <p className="text-xs text-zinc-500">Reading embedded metadata…</p>
          ) : null}
          {draft.prefillStatus === "failed" ? (
            <p role="status" className="text-xs text-zinc-500">
              Couldn&apos;t read embedded metadata ({draft.prefillError}) — enter details manually, or{" "}
              <button type="button" onClick={onRetryPrefill} className="underline hover:text-zinc-800 dark:hover:text-zinc-200">
                retry
              </button>
              .
            </p>
          ) : null}
          {exifSummary ? <p className="text-xs text-zinc-500">{exifSummary}</p> : null}
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 text-xs text-zinc-500 hover:text-red-500 dark:text-zinc-500 dark:hover:text-red-400"
        >
          {draft.publishStatus === "success" ? "Dismiss" : "Remove"}
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Title">
          <input
            type="text"
            value={draft.title}
            disabled={disabled}
            onChange={(e) => onChange({ title: e.target.value })}
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="Alt text (accessibility)">
          <input
            type="text"
            value={draft.alt}
            disabled={disabled}
            onChange={(e) => onChange({ alt: e.target.value })}
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="Description" className="sm:col-span-2">
          <textarea
            value={draft.description}
            disabled={disabled}
            onChange={(e) => onChange({ description: e.target.value })}
            rows={2}
            className={INPUT_CLASS}
          />
        </Field>
        <Field label={`Tags (comma-separated${tagCount > TAGS_MAX_ITEMS ? `, ${tagCount}/${TAGS_MAX_ITEMS} — too many` : ""})`}>
          <input
            type="text"
            value={draft.tags}
            disabled={disabled}
            onChange={(e) => onChange({ tags: e.target.value })}
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="License">
          <input
            type="text"
            value={draft.license}
            disabled={disabled}
            placeholder="e.g. © 2026, all rights reserved"
            onChange={(e) => onChange({ license: e.target.value })}
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="Location">
          <input
            type="text"
            value={draft.location}
            disabled={disabled}
            placeholder="e.g. Overpeck County Park, NJ"
            onChange={(e) => onChange({ location: e.target.value })}
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="Captured at">
          <input
            type="text"
            value={draft.capturedAt}
            disabled={disabled}
            placeholder="YYYY-MM-DDTHH:mm:ssZ"
            onChange={(e) => onChange({ capturedAt: e.target.value })}
            className={INPUT_CLASS}
          />
        </Field>
      </div>

      {draft.prefillStatus === "loaded" && draft.prefill?.hasGps ? (
        <label className="mt-4 flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={draft.keepGps}
            disabled={disabled}
            onChange={(e) => onChange({ keepGps: e.target.checked })}
          />
          Keep GPS location data in this photo (default is to strip it)
        </label>
      ) : null}

      {draft.publishStatus === "error" || draft.publishStatus === "too-large" ? (
        <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">
          {draft.publishError}
        </p>
      ) : null}

      {draft.publishStatus === "success" ? (
        <p className="mt-4 text-sm text-emerald-600 dark:text-emerald-400">Published.</p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {draft.publishStatus !== "success" ? (
          <button
            type="button"
            onClick={onPublish}
            disabled={disabled}
            className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            {draft.publishStatus === "pending" ? "Publishing…" : "Publish"}
          </button>
        ) : null}

        {draft.publishStatus === "too-large" && draft.width != null && draft.height != null ? (
          <div>
            <button
              type="button"
              onClick={onDownscaleAndRetry}
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Downscale to fit &amp; retry
            </button>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Downscaling re-encodes the image and removes embedded metadata, including GPS.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const INPUT_CLASS =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-black placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600 dark:focus:border-zinc-600";

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block text-sm ${className ?? ""}`}>
      <span className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
      {children}
    </label>
  );
}
