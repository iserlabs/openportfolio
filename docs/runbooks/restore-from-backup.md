# Runbook: Restore From Backup

Recovering from your own `BACKUP_DIR` artifacts (a dated CAR + an
accumulated blobs directory) onto a fresh PDS, after losing the original VPS
— disk failure, provider issue, accidental `docker volume rm`, anything that
took the running `pds` container's data with it.

Audience: same as the other runbooks. This is a disaster-recovery doc; read
the "Two scenarios" section below *before* your disaster happens, so you
know which one you're in when it does (it depends entirely on whether you
also kept a copy of `.env`, which is a decision you make ahead of time, not
during the incident).

## What's in `BACKUP_DIR` and why you can trust it

Every install with `BACKUP_DIR` set (the default: `/backups`, bind-mounted
to `./backups` on the host) gets, nightly:

```
BACKUP_DIR/
  car/
    2026-07-20.car
    2026-07-21.car
    ...
  blobs/
    <cid>
    <cid>
    ...
```

`car/` is one file per calendar day, **never overwritten retroactively** —
each one is a full snapshot of your repo at that moment (`com.atproto.sync.getRepo`),
not a diff, so any single file in there is self-sufficient on its own. Use
the newest one.

`blobs/` is a **single, flat, cumulative directory** — not dated. Blobs are
content-addressed and immutable, so there's no meaningful "version" of a
given blob; each night's run just adds whatever CIDs it hasn't seen before
and leaves everything else alone. You want the whole directory, not a
particular date's worth.

**Why you can trust that every file present is complete, not truncated:**
both the CAR and each blob are written with a temp-then-rename pattern — the
backup process writes to `<path>.tmp` first, and only `rename()`s it onto
the real filename (`car/<date>.car`, `blobs/<cid>`) after the write finishes
successfully. A run that dies mid-transfer (network hiccup, container
restart, disk full) leaves at most a stray `.tmp` file (best-effort cleaned
up) — it can *never* leave a truncated, half-written file sitting at the
real path. If a file is there, it's complete. You don't need to checksum
anything before trusting it.

**What "the backup succeeded" doesn't guarantee:** a nightly run can report
success overall while still having failed on a handful of individual blobs
(one bad network request, one bad CID) — those are logged and counted
(`blobsFailed`) but don't abort the run; the remaining blobs still get
attempted. A blob that failed one night is retried automatically on
subsequent nights (a failed write never reaches the real path, so it never
looks "already done" to the skip-check) — but if your VPS died the same
night a blob failed and never got a retry, that blob may genuinely be
missing from your last-known-good `blobs/`. Check your app logs
(`docker compose logs app | grep '\[backup\]'`) for recent `blobsFailed`
counts before treating a backup set as complete, and plan to verify after
restore (see the Verify section) rather than assume.

**`BACKUP_DIR` living only on the now-dead VPS is itself the single point of
failure this whole runbook exists to avoid** — if you're reading this and
your only copy of `./backups` was also on that VPS, there is nothing to
restore from. Sync it off-host on a schedule (`rsync`/`rclone` to another
machine or object storage) going forward; this isn't automated by the app.

## `.env` is not part of this backup

Worth saying plainly: `BACKUP_DIR` contains only your ATProto-native data
(CAR + blobs) — deliberately, since that's the sovereign, portable half of
this install. It does **not** contain `.env` — no `PDS_ADMIN_PASSWORD`, no
`PDS_ROTATION_KEY`, no `OWNER_DID`, no `OAUTH_JWK`. Whether you kept a
separate copy of that file determines which of the two restore paths below
you're in.

## Two scenarios

### Scenario A: you also kept a copy of `.env`

The straightforward case. Since you still have `PDS_ROTATION_KEY` (the
PLC rotation key this PDS holds for itself) and `OWNER_DID`, you can bring
up a brand-new PDS that presents as *the same* identity as before — nothing
about your `did:plc:...`'s hosting pointer even needs to change if you're
reusing the same `pds.yourdomain.com` hostname, since the PLC document
already says that hostname hosts you; only the server behind it changed.

### Scenario B: you lost `.env` too

This is identity recovery, not just data recovery. Without the old
`PDS_ROTATION_KEY`/`OWNER_DID`, a fresh `setup.sh` run creates a **new**
DID by default — your restored CAR/blobs are for the *old* DID, so a plain
reinstall won't line up with them. You need either your offline recovery
key (see [`recovery-key.md`](./recovery-key.md)'s break-glass procedure, if
you registered one) to reclaim the PLC document, or you're re-registering
the existing DID on a fresh PDS the same way [`migrate-away.md`](./migrate-away.md)
does with `--existing-did` — follow that runbook's Step 3 and the
**VERIFY ON STAGING (Task D1)** note attached to it, since the exact
server-side rules for claiming an already-registered DID this way haven't
been exercised end-to-end in this task.

The rest of this runbook assumes **Scenario A**. If you're in Scenario B,
do the identity-recovery step first, then come back here for the
CAR/blob-loading steps (5 onward), which are identical either way.

## Steps (Scenario A)

**1. Get the backup artifacts onto the new machine**, from wherever you
synced them off-host:

```sh
rsync -av backup-host:/path/to/backups/ ./backups/
```

**2. Restore `.env`** into `deploy/.env` on the new VPS — same `DOMAIN`,
same `PDS_ADMIN_PASSWORD`/`PDS_JWT_SECRET`/`PDS_ROTATION_KEY`/`OWNER_DID`,
same `OAUTH_JWK`/`SESSION_SECRET` as before. Reusing every secret is what
lets the new PDS present as the exact same identity without touching PLC at
all.

**3. Point DNS at the new VPS's IP** (both `yourdomain.com` and
`pds.yourdomain.com` — see [`install.md`](./install.md)'s DNS section if
you need a refresher), and confirm it's propagated.

**4. Bring up a fresh stack** with the restored `.env` in place:

```sh
cd deploy
docker compose up -d --build
```

Since `OWNER_DID` and the account secrets are already set, `setup.sh`'s own
`ensure_owner_account` logic would skip account creation if you ran it —
but note a fresh `pds` container has **no account at all** yet on its own
disk, even though `.env` says `OWNER_DID` is already assigned. You still
need to create that account on this new PDS instance, using the *same* DID:

```sh
goat pds admin account create \
  --pds-host "https://pds.yourdomain.com" \
  --admin-password "$PDS_ADMIN_PASSWORD" \
  --handle "obootstrap.pds.yourdomain.com" \
  --password "$OWNER_PASSWORD" \
  --email "$OWNER_EMAIL" \
  --existing-did "$OWNER_DID"
```

> **VERIFY ON STAGING (Task D1):** same caveat as `migrate-away.md`'s Step
> 3 — `--existing-did` is a verified, documented flag, but claiming an
> already-registered DID this way against a fresh PDS that reuses the
> *original* `PDS_ROTATION_KEY` (rather than migrating to a new one) hasn't
> been exercised end-to-end in this task. This is the scenario most worth
> rehearsing on a staging PDS before you actually need it under pressure.

**5. Log in and import the repo:**

```sh
goat account login --username "$OWNER_DID" --password "$OWNER_PASSWORD" --pds-host "https://pds.yourdomain.com"
goat repo import ./backups/car/<newest-date>.car
```

Use the most recent `.car` file under `car/` — each one is a full, standalone
snapshot, so you never need to replay more than one.

**6. Upload every blob:**

```sh
for f in ./backups/blobs/*; do
  goat blob upload "$f"
done
goat account missing-blobs
```

The `missing-blobs` check should print nothing. If it lists CIDs, re-check
whether those exist in `./backups/blobs/` at all — per the `blobsFailed`
caveat above, a small number of blobs may genuinely not have made it into
your last backup. Missing blobs manifest in the app as broken images for
whichever photos referenced them; you'll need the original files if you
want those specific photos whole again (re-upload through the admin UI,
which will produce new CIDs and require re-publishing those records).

**7. Restart `app` so it's serving against the freshly-populated PDS, and
re-point `BACKUP_DIR` so nightly backups resume:**

```sh
mkdir -p ./backups && chown 1000:1000 ./backups && chmod 755 ./backups
docker compose up -d app
```

(Same ownership fix `setup.sh` applies on a first install — the app
container runs as uid 1000, and a freshly-restored/created directory
otherwise won't be writable by it.)

## Verify

1. Visit `https://yourdomain.com/admin/login` and sign in as owner. If you
   get a 403 ("owner only"), the DID that signed in doesn't match
   `OWNER_DID` in the restored `.env` — double check you didn't typo the
   restore, and that this is genuinely the same DID whose data you just
   imported.
2. Confirm your photos actually render, not just that records exist —
   broken images mean a blob didn't make it through step 6.
3. Compare a record count against what you remember (or against
   `goat ls "$OWNER_DID" --collection social.opencontent.photograph`
   run *before* the incident, if you have that output saved anywhere) to
   sanity-check nothing was silently dropped.
4. Pull a fresh manual export once things look right
   (`https://yourdomain.com/admin/export`) and confirm it downloads
   cleanly — this is also your first new-instance backup, worth keeping
   as a marker of "restore confirmed good" separate from the
   pre-incident artifacts.

The app's own SQLite database (`SQLITE_PATH`) is **not** part of this
restore and doesn't need to be — it holds only OAuth session/state rows and
a derived thumbnail-blur cache, none of it canonical. A fresh, empty SQLite
file is expected and correct after a restore; it repopulates itself as you
use the site.
