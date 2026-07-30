import type { Metadata } from "next";
import { AdminShell } from "@/components/admin-shell";
import { UploadForm } from "./upload-form";

export const metadata: Metadata = {
  title: "Upload — OpenPortfolio",
};

// Owner-only, session-gated -- never prerender at build.
export const dynamic = "force-dynamic";

/**
 * Upload is deliberately a pure "publish" surface — drop files, prefill,
 * edit, publish. Browsing/deleting already-published photographs lives on
 * the Collections page instead (its "add photograph to a collection"
 * picker already has to list every photograph, and photograph deletion's
 * "referenced by N collections" warning is inherently a collections-
 * membership question — see `collection-editor.tsx`), so this page has no
 * server data to fetch at all.
 */
export default function AdminUploadPage() {
  return (
    <AdminShell>
      <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">Upload</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Drop one or more images to publish. GPS location data is stripped by default — check &ldquo;keep GPS&rdquo; on a
        file to publish it unchanged.
      </p>
      <UploadForm />
    </AdminShell>
  );
}
