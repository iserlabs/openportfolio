"use server";

import type { Agent } from "@atproto/api";
import {
  buildCollection,
  buildPhotograph,
  buildSite,
  OPENCONTENT_COLLECTION,
  OPENCONTENT_PHOTOGRAPH,
  OPENCONTENT_SITE,
  type SiteLink,
  type StrongRef,
} from "@open-portfolio/lexicons";
import { extractPrefill, stripGps, type Prefill } from "../../lib/photo-metadata";
import { requireOwner } from "../../lib/session";
import { restoreAgent } from "../../lib/oauth";
import { bustCache } from "../../lib/pds";

// A5-review carry: `pruneOauthStates(olderThanMs)` (lib/oauth.ts) is NOT wired
// up here. A periodic sweep needs a real recurring timer, and a "use server"
// action file has no such thing to hook into -- every export here runs as a
// fresh, per-request invocation (this app deploys to serverless/ephemeral
// compute), so a module-scope `setInterval` would neither survive between
// invocations nor behave once (it'd also duplicate across dev hot-reloads).
// Left for A10's scheduler, which is the actual right home for a cron-style
// job.

/**
 * The admin CMS write path -- every mutating action the owner's dashboard
 * calls. Result-shaped (never throws to the client): each exported action is
 * a thin shell that resolves the real owner identity + PDS agent, wrapped in
 * a blanket try/catch, delegating the actual business logic to a `*Core`
 * function. This mirrors Luminance's `apps/web/app/photo/actions.ts` split
 * (`likeActionCore` etc.) -- the `Core` functions take already-resolved
 * plain values (an `ownerDid` and a PDS `Agent`) instead of touching
 * `requireOwner()`/`restoreAgent()`/Next request context themselves, so
 * tests can drive them directly with a stubbed agent (no live OAuth session
 * or PDS needed), the same way Luminance's `interactions.test.ts` drives
 * `likePhoto` et al. with a fake `Agent`.
 *
 * `ownerDid: string | null` is the gate every `*Core` function checks first,
 * before touching `agent` at all -- `null` means "the caller wasn't the
 * owner," and in production this branch is unreachable (the wrapper's
 * `requireOwner()` call throws before a `*Core` function is ever invoked),
 * but it's the seam that makes "non-owner rejected before any agent call"
 * directly testable without needing a live iron-session/cookie request
 * context.
 */

type PublishResult = { ok: true; uri: string } | { ok: false; error: string; code?: "too-large" };
type SaveResult = { ok: true; uri: string } | { ok: false; error: string };
type DeleteResult = { ok: true } | { ok: false; error: string; code?: "referenced"; collections?: string[] };

const OWNER_ONLY_ERROR = "owner only";
const GENERIC_ERROR = "something went wrong — please try again";

// ---- shared formData helpers ------------------------------------------------

function stringField(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseCsvTags(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const tags = value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

/** Parses a JSON-encoded array field, defaulting to `fallback` when the field is absent. Throws on malformed JSON -- callers wrap in try/catch. */
function parseJsonArrayField<T>(formData: FormData, key: string, fallback: T[]): T[] {
  const raw = stringField(formData, key);
  if (!raw) return fallback;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${key} must be a JSON array`);
  return parsed as T[];
}

/** Parses a JSON-encoded object field (a single strongRef, not an array), returning `undefined` when the field is absent. Throws on malformed JSON -- callers wrap in try/catch. */
function parseJsonObjectField<T>(formData: FormData, key: string): T | undefined {
  const raw = stringField(formData, key);
  if (!raw) return undefined;
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${key} must be a JSON object`);
  }
  return parsed as T;
}

// ---- publishPhotograph -------------------------------------------------------

// Mirrors the lexicon's own accept list (packages/lexicons/src/records.ts'
// private PHOTOGRAPH_IMAGE_ACCEPT, not exported) -- checked here too, before
// ever uploading a blob, so an unsupported type (never SVG, per spec §9)
// fails fast instead of burning an upload round trip only to be rejected by
// buildPhotograph afterward.
const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/heic"]);

type PublishDeps = {
  stripGps: typeof stripGps;
  extractPrefill: typeof extractPrefill;
  bustCache: typeof bustCache;
};

const defaultPublishDeps: PublishDeps = { stripGps, extractPrefill, bustCache };

/** Duck-typed check for a PDS 413/BlobTooLarge failure -- matches both a real `@atproto/xrpc` `XRPCError` (which carries `.status`/`.error` as plain own properties) and a plain stubbed-agent rejection shaped the same way in tests. */
function isBlobTooLarge(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: unknown; error?: unknown };
  return e.status === 413 || e.error === "BlobTooLarge";
}

// Looks for a "max"/"limit"-qualified byte count in the PDS's own error
// message (e.g. "... exceeds the maximum allowed size of 5242880 bytes") so
// the surfaced message can name the actual ceiling rather than a generic
// "too big." Anchored on "max"/"limit" (not just any number followed by
// "bytes") so it doesn't accidentally pick up the *uploaded* file's own size
// when a message mentions both.
const LIMIT_HINT = /(?:max|limit)\D{0,40}?(\d[\d,]*)\s*bytes?/i;

function describeTooLarge(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  const match = message.match(LIMIT_HINT);
  if (match) {
    const bytes = Number(match[1].replace(/,/g, ""));
    if (Number.isFinite(bytes) && bytes > 0) {
      const mb = bytes / (1024 * 1024);
      const rounded = mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10;
      return `image is too large for this server's upload limit (${rounded}MB) — try a smaller export`;
    }
  }
  return "image is too large for this server's upload limit — try a smaller export";
}

/**
 * Core publish flow, agent + owner did already resolved: `extractPrefill` on
 * the original bytes for aspectRatio/exif/hasGps -> (unless
 * `keepGps==="true"`) strip GPS **only when `extractPrefill` actually found
 * some** -> `agent.uploadBlob` -> `buildPhotograph` with the returned blob
 * ref -> `createRecord` -> bust the read cache. User-editable fields
 * (title/description/alt/tags/license/location/capturedAt) come from the
 * form -- the CMS's upload-preview step is expected to have prefilled them
 * from `extractPrefill` already and let the owner edit before submit.
 * `aspectRatio` and `exif` are NOT form fields (nothing to edit there) and
 * are always re-derived from the bytes actually being uploaded.
 *
 * GPS-presence gating (review finding): `extractPrefill` runs first and its
 * exiftool-backed `hasGps` decides whether a strip is even attempted --
 * `stripGps` unconditionally rejects AVIF (its exiftool write path is
 * unreliable there, see photo-metadata.ts), so unconditionally calling it
 * for every non-`keepGps` upload broke AVIF uploads that carried no GPS at
 * all. The corrected default-path matrix:
 *   - `hasGps === false` -> publish the original bytes untouched, no strip
 *     call at all, for any accepted container (including GPS-free AVIF).
 *   - `hasGps === true`  -> strip as before; if `stripGps` itself throws
 *     (AVIF-with-GPS, the one combination it refuses), that's surfaced as
 *     `{ok:false, error}` carrying photo-metadata's own actionable message
 *     rather than silently publishing geotagged bytes -- the "GPS never
 *     ships by default" privacy guarantee holds either way: the upload
 *     either has its GPS stripped, or is rejected, never both-avoided.
 *   - `keepGps === "true"` -> unchanged: no strip call regardless of
 *     `hasGps`, prefill is still parsed on the original bytes.
 */
export async function publishPhotographCore(
  ownerDid: string | null,
  agent: Agent,
  formData: FormData,
  deps: Partial<PublishDeps> = {},
): Promise<PublishResult> {
  if (!ownerDid) return { ok: false, error: OWNER_ONLY_ERROR };
  const { stripGps: doStripGps, extractPrefill: doExtractPrefill, bustCache: doBustCache } = {
    ...defaultPublishDeps,
    ...deps,
  };

  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "missing file" };
  if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
    return { ok: false, error: `unsupported image type "${file.type}"` };
  }

  // Explicit `Buffer` annotation (not inferred) -- `Buffer.from(arrayBuffer)`
  // narrows to `Buffer<ArrayBuffer>`, but stripGps's `Promise<Buffer>` return
  // is the interface's wider default `Buffer<ArrayBufferLike>`; without this
  // annotation the reassignment below fails to typecheck.
  let bytes: Buffer = Buffer.from(await file.arrayBuffer());

  let prefill: Prefill;
  try {
    prefill = await doExtractPrefill(bytes);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "could not read image metadata" };
  }

  const keepGps = formData.get("keepGps") === "true";
  if (!keepGps && prefill.hasGps) {
    try {
      bytes = await doStripGps(bytes);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "could not strip GPS metadata" };
    }
  }

  // Orphaned-blob tradeoff: the blob is uploaded (and durably stored on the
  // PDS) BEFORE buildPhotograph/createRecord validate the rest of the
  // record below. If either of those later steps fails, this blob has no
  // record ever referencing it. Left as-is deliberately -- there's no
  // atomic "upload + reference" primitive to make this a single step, and
  // the PDS already garbage-collects blobs no record points to, so an
  // orphan here is inert storage cost, not a correctness or leak problem.
  let uploaded: { ref: unknown; mimeType: string; size: number };
  try {
    const res = await agent.uploadBlob(bytes, { encoding: file.type });
    uploaded = res.data.blob as unknown as { ref: unknown; mimeType: string; size: number };
  } catch (err) {
    if (isBlobTooLarge(err)) return { ok: false, code: "too-large", error: describeTooLarge(err) };
    return { ok: false, error: err instanceof Error ? err.message : "could not upload image" };
  }

  let record: ReturnType<typeof buildPhotograph>;
  try {
    record = buildPhotograph({
      image: { $type: "blob", ref: uploaded.ref, mimeType: uploaded.mimeType, size: uploaded.size },
      aspectRatio: { width: prefill.width, height: prefill.height },
      title: stringField(formData, "title"),
      description: stringField(formData, "description"),
      alt: stringField(formData, "alt"),
      tags: parseCsvTags(stringField(formData, "tags")),
      license: stringField(formData, "license"),
      location: stringField(formData, "location"),
      capturedAt: stringField(formData, "capturedAt"),
      exif: prefill.exif,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "invalid photograph" };
  }

  try {
    const res = await agent.com.atproto.repo.createRecord({
      repo: ownerDid,
      collection: OPENCONTENT_PHOTOGRAPH,
      record,
    });
    doBustCache();
    return { ok: true, uri: res.data.uri };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "could not publish" };
  }
}

export async function publishPhotograph(formData: FormData): Promise<PublishResult> {
  try {
    const did = await requireOwner();
    const agent = await restoreAgent(did);
    return await publishPhotographCore(did, agent, formData);
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }
}

// ---- saveCollection -----------------------------------------------------------

type SaveDeps = { bustCache: typeof bustCache };
const defaultSaveDeps: SaveDeps = { bustCache };

/**
 * Creates (no `rkey` field -- the PDS auto-assigns a TID rkey via a plain
 * `createRecord`) or fully rewrites (an existing `rkey` field -- `putRecord`,
 * used for both edits and reordering `items`) a `social.opencontent.collection`
 * record. `items` arrives as an ordered JSON array of `{uri, cid}` strongRefs;
 * reordering is just resubmitting the same set in a new order through the
 * same `putRecord` call. `cover` arrives as an optional JSON-encoded
 * `{uri, cid}` strongRef (single object, not an array) -- omitted entirely
 * means "no cover set," matching `buildCollection`'s own optional `cover`
 * input.
 */
export async function saveCollectionCore(
  ownerDid: string | null,
  agent: Agent,
  formData: FormData,
  deps: Partial<SaveDeps> = {},
): Promise<SaveResult> {
  if (!ownerDid) return { ok: false, error: OWNER_ONLY_ERROR };
  const { bustCache: doBustCache } = { ...defaultSaveDeps, ...deps };

  // Same "present and non-empty" CMS-level guard as saveSiteCore -- buildCollection
  // itself only requires title to be a string (no minLength).
  const title = stringField(formData, "title");
  if (!title) return { ok: false, error: "title is required" };

  let items: StrongRef[];
  let cover: StrongRef | undefined;
  try {
    items = parseJsonArrayField<StrongRef>(formData, "items", []);
    cover = parseJsonObjectField<StrongRef>(formData, "cover");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "invalid items" };
  }

  let record: ReturnType<typeof buildCollection>;
  try {
    record = buildCollection({
      title,
      description: stringField(formData, "description"),
      items,
      cover,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "invalid collection" };
  }

  const rkey = stringField(formData, "rkey");
  try {
    const res = rkey
      ? await agent.com.atproto.repo.putRecord({ repo: ownerDid, collection: OPENCONTENT_COLLECTION, rkey, record })
      : await agent.com.atproto.repo.createRecord({ repo: ownerDid, collection: OPENCONTENT_COLLECTION, record });
    doBustCache();
    return { ok: true, uri: res.data.uri };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "could not save collection" };
  }
}

export async function saveCollection(formData: FormData): Promise<SaveResult> {
  try {
    const did = await requireOwner();
    const agent = await restoreAgent(did);
    return await saveCollectionCore(did, agent, formData);
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }
}

// ---- deleteRecordAction -------------------------------------------------------

// Only these three own the write path (spec §9's commons-purity boundary) --
// never let this action delete an unrelated collection in the owner's repo
// (e.g. their app.bsky.actor.profile/self) via a crafted `collection` field.
const DELETABLE_COLLECTIONS = new Set<string>([OPENCONTENT_PHOTOGRAPH, OPENCONTENT_COLLECTION, OPENCONTENT_SITE]);

const LIST_COLLECTIONS_PAGE_SIZE = 100;
const LIST_COLLECTIONS_PAGE_CAP = 50; // same bounded-paging philosophy as lib/pds.ts's listAllRecords

/** Pages the owner's own `social.opencontent.collection` records (via the authenticated agent, not the public pds.ts reader) looking for any whose `items` references `photoUri`, returning their titles. */
async function findReferencingCollectionTitles(agent: Agent, ownerDid: string, photoUri: string): Promise<string[]> {
  const titles: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LIST_COLLECTIONS_PAGE_CAP; page++) {
    const res = await agent.com.atproto.repo.listRecords({
      repo: ownerDid,
      collection: OPENCONTENT_COLLECTION,
      limit: LIST_COLLECTIONS_PAGE_SIZE,
      cursor,
    });
    for (const r of res.data.records) {
      const value = r.value as { title?: string; items?: { uri?: string }[] };
      if ((value.items ?? []).some((item) => item.uri === photoUri)) {
        titles.push(value.title ?? "untitled collection");
      }
    }
    cursor = res.data.cursor;
    if (!cursor || res.data.records.length === 0) break;
  }
  return titles;
}

/**
 * Deletes a record in the owner's repo. Before deleting a
 * `social.opencontent.photograph`, pages the owner's collections looking for
 * any that still reference it (spec §-carried A5-review item) and blocks the
 * delete with `{ok:false, code:"referenced", collections:[titles]}` unless
 * `force==="true"` -- collections keep dangling strongRefs otherwise. The
 * check is skipped entirely for non-photograph collections (deleting a
 * collection or the singleton site record has no such membership concern).
 */
export async function deleteRecordActionCore(
  ownerDid: string | null,
  agent: Agent,
  formData: FormData,
  deps: Partial<SaveDeps> = {},
): Promise<DeleteResult> {
  if (!ownerDid) return { ok: false, error: OWNER_ONLY_ERROR };
  const { bustCache: doBustCache } = { ...defaultSaveDeps, ...deps };

  const collection = stringField(formData, "collection");
  const rkey = stringField(formData, "rkey");
  if (!collection || !rkey) return { ok: false, error: "missing record" };
  if (!DELETABLE_COLLECTIONS.has(collection)) return { ok: false, error: "unsupported collection" };

  const force = formData.get("force") === "true";

  if (collection === OPENCONTENT_PHOTOGRAPH && !force) {
    const photoUri = `at://${ownerDid}/${collection}/${rkey}`;
    const referencing = await findReferencingCollectionTitles(agent, ownerDid, photoUri);
    if (referencing.length > 0) {
      return {
        ok: false,
        code: "referenced",
        collections: referencing,
        error: `still referenced by ${referencing.length} collection${referencing.length === 1 ? "" : "s"}`,
      };
    }
  }

  try {
    await agent.com.atproto.repo.deleteRecord({ repo: ownerDid, collection, rkey });
    doBustCache();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "could not delete record" };
  }
}

export async function deleteRecordAction(formData: FormData): Promise<DeleteResult> {
  try {
    const did = await requireOwner();
    const agent = await restoreAgent(did);
    return await deleteRecordActionCore(did, agent, formData);
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }
}

// ---- saveSite -------------------------------------------------------------------

const SITE_RKEY = "self";

/** Upserts the singleton `social.opencontent.site` record at rkey `self` via `putRecord` -- there's no create/edit fork the way collections have, since the rkey is fixed by the lexicon (`key: "literal:self"`). */
export async function saveSiteCore(
  ownerDid: string | null,
  agent: Agent,
  formData: FormData,
  deps: Partial<SaveDeps> = {},
): Promise<SaveResult> {
  if (!ownerDid) return { ok: false, error: OWNER_ONLY_ERROR };
  const { bustCache: doBustCache } = { ...defaultSaveDeps, ...deps };

  // buildSite itself only requires title to be a string (no minLength) --
  // a titleless portfolio site has no sensible use, so this action enforces
  // "present and non-empty" as a CMS-level guard beyond the lexicon's own.
  const title = stringField(formData, "title");
  if (!title) return { ok: false, error: "title is required" };

  let collectionOrder: string[];
  let links: SiteLink[];
  try {
    collectionOrder = parseJsonArrayField<string>(formData, "collectionOrder", []);
    links = parseJsonArrayField<SiteLink>(formData, "links", []);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "invalid site fields" };
  }

  let record: ReturnType<typeof buildSite>;
  try {
    record = buildSite({
      title,
      about: stringField(formData, "about"),
      collectionOrder: collectionOrder.length > 0 ? collectionOrder : undefined,
      links: links.length > 0 ? links : undefined,
      theme: stringField(formData, "theme"),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "invalid site" };
  }

  try {
    const res = await agent.com.atproto.repo.putRecord({
      repo: ownerDid,
      collection: OPENCONTENT_SITE,
      rkey: SITE_RKEY,
      record,
    });
    doBustCache();
    return { ok: true, uri: res.data.uri };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "could not save site" };
  }
}

export async function saveSite(formData: FormData): Promise<SaveResult> {
  try {
    const did = await requireOwner();
    const agent = await restoreAgent(did);
    return await saveSiteCore(did, agent, formData);
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }
}
