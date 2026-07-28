# Runbook: Upgrade PDS

Bumping the pinned reference-PDS image version safely, and rolling it back
if the upgrade doesn't go well.

Audience: same as the other runbooks. This is the one runbook here that
touches infrastructure you didn't build — the reference PDS is upstream,
unmodified, composition-only (see `deploy/docker-compose.yml`'s own top
comment: *"never a fork"*). That means you get upstream's bug fixes for
free, but also upstream's occasional breaking change, and this runbook is
about not finding out about one the hard way.

## Where the pin actually lives

One line, `deploy/docker-compose.yml`:

```yaml
pds:
  image: ghcr.io/bluesky-social/pds:0.4 # version-pinned; never modified
```

That's the entire surface area of a PDS upgrade under normal
circumstances: bump the tag, pull, recreate that one service. Everything
else in the `pds` service block (the fixed federation endpoints —
`PDS_DID_PLC_URL`, `PDS_BSKY_APP_VIEW_URL`, `PDS_CRAWLERS`, etc. — and the
generated secrets) is unrelated to the image version and shouldn't be
touched as part of a routine upgrade.

Unlike `app` (`build: { context: .., dockerfile: apps/site/Dockerfile }`),
`pds` is declared with a bare `image:` — it's pulled pre-built from the
registry, never compiled from source here. That means `docker compose up -d
--build` (the command `deploy/README.md` documents for updating the *app*)
does **not** rebuild or re-pull `pds` — you need an explicit `docker compose
pull pds` for that, which is exactly why this is its own runbook instead of
a line in `install.md`'s "Updating" section.

## Before touching anything

1. **Read the target version's release notes** on the
   [reference PDS's own repo](https://github.com/bluesky-social/pds)
   (or wherever the `ghcr.io/bluesky-social/pds` image's changelog lives for
   the tag you're moving to) before changing the pin. Specifically look for
   language like "breaking," "migration," or "one-way" — some releases run
   an on-disk schema migration on first boot against the PDS's own SQLite
   data directory, which is not something a simple image-tag rollback can
   undo. This runbook can't tell you what a specific future release does;
   that's why this step comes first, every time, not just once.
2. **Get a fresh snapshot before you touch anything.** Either wait for that
   night's automatic backup, or trigger a manual one right now:
   ```sh
   curl -o pre-upgrade-$(date +%F).car https://yourdomain.com/admin/export \
     -H "Cookie: <your admin session cookie>"
   ```
   (Signing in through a browser and using "Save As" on
   `https://yourdomain.com/admin/export` is simpler than wrangling the
   cookie header by hand — either way, get a CAR dated *today*, before the
   upgrade, sitting somewhere other than this VPS.) If `BACKUP_DIR` is
   configured, also confirm last night's run actually succeeded:
   `docker compose logs app | grep '\[backup\]'`.
3. **If a schema migration is even a possibility for this release** (per
   step 1), also make sure your most recent `BACKUP_DIR/blobs/` is complete
   — a one-way migration plus a rollback plan that turns out to only be
   "swap the image tag back" is not actually a rollback plan if the on-disk
   data changed shape underneath it. See
   [`restore-from-backup.md`](./restore-from-backup.md) if it comes to
   that.

## The flagship-first rule

If you operate more than one Open Portfolio instance — your own reference
deployment plus others, or several unrelated installs you maintain — **never
bump the pin everywhere at once.** Upgrade the instance you watch most
closely (logs, backups, your own daily usage) first, and let it run for a
defined soak period — a day or two of normal use, including at least one
upload and one nightly backup cycle — before touching any other instance's
pin. A single-instance operator gets the same benefit for free by simply not
rushing: don't bump the pin and walk away for a week; bump it, then actually
use the site for a bit before considering it done.

The reasoning is the same either way: this is upstream's code, not this
project's, running with real production data behind it — the value of a
staged rollout doesn't depend on how many instances you happen to run.

## Doing the upgrade

**1. Edit the pin:**
```yaml
pds:
  image: ghcr.io/bluesky-social/pds:<new-tag> # version-pinned; never modified
```

**2. Pull and recreate just `pds`** — deliberately not `docker compose up -d
--build` (that flag is a no-op for an `image:`-declared service, but typing
it invites confusion about what actually happened) and deliberately not
touching `app`/`caddy`:
```sh
cd deploy
docker compose pull pds
docker compose up -d pds
```

**3. Health-check**, same endpoint `setup.sh` itself polls on a first
install:
```sh
curl -fsS https://pds.yourdomain.com/xrpc/_health
docker compose logs pds
```
Watch the logs specifically for migration output on this first boot after
the pull — this is where a one-way schema change (per step 1 above) would
announce itself.

**4. Smoke test**, not just a health check — log in at
`https://yourdomain.com/admin/login` as owner, and actually do a write: edit
a record, or upload a small test image and delete it afterward. A healthy
`/xrpc/_health` response only proves the PDS process is up, not that OAuth,
repo writes, and blob uploads all still work end to end. Then confirm
`https://yourdomain.com/admin/export` still streams a valid CAR.

## Rollback

If the smoke test fails, or anything in the logs looks wrong, and step 1's
release-notes check didn't turn up a one-way migration for this version:

```sh
# revert the one line back to the previous tag
docker compose pull pds
docker compose up -d pds
```

That's it — pinned images make rollback exactly as simple as the upgrade
itself, two commands, previous tag, because the `pds-data` volume
underneath is untouched by an image swap alone *as long as the new version
didn't rewrite it on-disk*. If it did (a one-way migration you either missed
in the release notes or that wasn't flagged as breaking), a tag-revert alone
won't undo it — at that point, don't guess: restore from the pre-upgrade
snapshot you took in step 2, following
[`restore-from-backup.md`](./restore-from-backup.md), onto a clean
`pds-data` volume.

## What not to do

- Don't edit any other field in the `pds` service block as part of a
  routine version bump — `PDS_DID_PLC_URL`, `PDS_BSKY_APP_VIEW_URL`, and
  the rest are fixed federation endpoints, not upgrade-related.
- Don't run `docker compose up -d --build` expecting it to also update
  `pds` — it only rebuilds `app` (the only service declared with `build:`).
- Don't touch the `pds-data` Docker volume directly (no manual file edits,
  no reaching into the container to "fix" something by hand) — if the
  volume's contents need to change, that's what
  [`restore-from-backup.md`](./restore-from-backup.md) is for, with an
  artifact you can trust, not an ad hoc edit you can't.
- Don't skip step 1's release-notes read because "it's just a version
  bump" — that's true for most releases and false for exactly the one that
  matters.
