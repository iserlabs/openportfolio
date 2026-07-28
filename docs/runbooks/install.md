# Runbook: Install

Takes a fresh Ubuntu VPS with DNS pointed at it to a running, federated,
single-owner ATProto portfolio. This runbook mirrors `deploy/README.md` but
adds a fix for every way each step can fail — read it once end to end before
you start if this is your first ATProto deploy, then use the troubleshooting
sections as needed while running `setup.sh`.

Audience: you're comfortable with a terminal, `ssh`, and DNS records. You
don't need to know anything about ATProto going in — every command below is
exact and copy-pasteable.

## What you need first

- A VPS running Ubuntu (22.04/24.04) with a public IP, root or sudo access,
  and `docker` + the Docker Compose plugin installed
  (`curl -fsSL https://get.docker.com | sh` gets you both).
- A domain you control, with access to add DNS records at your
  registrar/DNS host.
- A real email address you control (used only to create the PDS account —
  never shared beyond your own PDS).

## 1. DNS

Point both of these at your VPS's public IP **before** running `setup.sh` —
it checks this and refuses to continue (with the exact fix) if it isn't
right yet:

| Type | Name                 | Value              |
| ---- | -------------------- | ------------------ |
| A    | `yourdomain.com`     | `<VPS public IP>`  |
| A    | `pds.yourdomain.com` | `<VPS public IP>`  |

(If your VPS only has an IPv6 address, use `AAAA` records instead — the
preflight check compares against whatever `curl https://ifconfig.me` reports
for this server, so match that family.)

Give it a few minutes to propagate, then confirm from the VPS itself:

```sh
dig +short yourdomain.com
dig +short pds.yourdomain.com
```

Both should print your VPS's IP. If they don't yet, wait and re-check —
`setup.sh`'s own preflight does this exact check for you, so you don't have
to get this perfect before moving on; you can also just run `setup.sh` and
let it tell you what's still wrong.

## 2. Configure

On the VPS, clone this repo and `cd` into `deploy/`:

```sh
cp .env.example .env
```

Edit `.env` and set at least:

- `DOMAIN` — your apex domain (e.g. `yourdomain.com`), no scheme, no
  trailing slash.
- `OWNER_EMAIL` — a real email address you control.

Leave every other key in `.env` blank. `setup.sh` generates all of them —
`PDS_ADMIN_PASSWORD`, `PDS_JWT_SECRET`, `PDS_ROTATION_KEY`, `OWNER_DID`,
`OWNER_PASSWORD`, `SESSION_SECRET`, `OAUTH_JWK` — on first run and writes
them back into this file. `.env` is gitignored and never leaves this VPS;
nothing in it is readable by anything outside this machine.

`BACKUP_DIR=/backups` is pre-filled and optional — leave it as-is unless you
want to disable nightly backups (not recommended; see
[`restore-from-backup.md`](./restore-from-backup.md)).

## 3. Run it

```sh
./setup.sh
```

Four phases, in order. `setup.sh` is **safe to re-run**: every step checks
whether its own work is already done (a secret already in `.env`, an account
already created, a recovery-key file already on disk) and skips it if so —
if it dies partway through (network hiccup, closed SSH session, `Ctrl-C`, a
preflight failure), fix the one thing the error told you to fix and run
`./setup.sh` again. It resumes, it doesn't restart from zero.

### Phase 1/4 — Preflight

Confirms DNS resolves correctly, ports 80/443 are free (or already held by
this project's own `caddy` from an earlier run — that's the expected resume
state, not a conflict), and `docker`/`curl`/`dig`/`openssl` are present.
Hard-exits with the exact thing to fix if not. See
[Troubleshooting: Preflight](#troubleshooting-preflight) below.

### Phase 2/4 — Stack up

Builds and starts `caddy` (TLS termination + reverse proxy), `pds` (the
unmodified reference ATProto PDS, pinned to a fixed release — see
[`upgrade-pds.md`](./upgrade-pds.md) for how that pin gets bumped later),
and `app` (this site). Generates your session secret and OAuth signing key,
creates your owner account on the PDS, then restarts `app` so it picks up
everything just written.

It then tries to migrate your handle from a temporary bootstrap handle
(something like `o1a2b3c4.pds.yourdomain.com`) to your bare domain. **This
step is best-effort** — it needs `https://yourdomain.com/.well-known/atproto-did`
to already be publicly resolvable, which depends on this same run having
gotten that far (DNS propagated, TLS cert issued, `app` serving that route).
If it isn't ready yet, `setup.sh` warns, leaves you on the bootstrap handle,
and prints the exact command to retry it by hand later. **Nothing else
depends on this succeeding** — the app always authenticates by DID, never by
handle, so a still-pending handle migration doesn't block you from logging
in or using the site.

### Phase 3/4 — Recovery-key ceremony

If the [`goat`](https://github.com/bluesky-social/goat) CLI is installed on
this VPS, generates an **offline** PLC rotation key, registers it as your
identity's highest-priority key, and saves it to
`./recovery-key-KEEP-OFFLINE.txt`. **Move that file off this server
immediately** — see [`recovery-key.md`](./recovery-key.md) for the full
ceremony, the exact 72-hour guarantee it buys you, and where to put it.

If `goat` isn't installed, this step (and phase 4) are skipped with
instructions to install it and re-run `./setup.sh` later — nothing else is
blocked by skipping it, but skipping it for good leaves this PDS's own
on-disk key as the *only* thing that can ever recover your identity. Don't
leave this skipped for long; treat it as a launch blocker, not a someday.

### Phase 4/4 — Relay crawl

Asks the public Bluesky relay to start crawling your PDS, so posts made
through it reach the wider network. Skipped automatically if phase 3 was
skipped (same `goat` dependency).

## 4. First login

1. Visit `https://yourdomain.com/admin/login`.
2. Sign in with the handle and password `setup.sh` printed at the end of the
   run (also saved as `OWNER_PASSWORD` in `.env`, purely for your own
   reference — the app itself never reads that value). Normally the handle
   is your bare domain itself; if a message earlier in the run said the
   handle migration was skipped, use the bootstrap handle it printed
   instead — either way, the password is the same.
3. You'll land on your own PDS's authorization screen to approve the
   sign-in (this is standard ATProto OAuth — the login prompt is served by
   your PDS, not this app), then back on your admin dashboard.

## 5. First upload

From the admin dashboard, go to Upload. Drop an image (JPEG, PNG, WebP, or
AVIF — see the note below on HEIC), fill in the title/description/tags
(pre-filled from embedded IPTC/EXIF metadata where present), and publish.
Everything is stored as records in your own PDS repo, under
`social.opencontent.*` — there is no other database of record.

A couple of upload-time limitations worth knowing before you hit them:

- **HEIC isn't supported.** This build's image decoder can open AVIF but not
  plain HEIC (a licensing limitation of the bundled library, not a policy
  choice) — the upload UI will tell you to export as JPEG from Lightroom (or
  your tool of choice) instead. Re-exporting is the only fix; there's no
  server-side conversion path.
- **GPS is stripped by default** on upload (check "keep GPS location data in
  this photo" to opt out per-photo). For AVIF specifically, GPS **cannot**
  be stripped — the metadata tool's AVIF write path isn't reliable enough to
  trust, so this build refuses to try rather than risk silently leaving
  location data in place. If you need an AVIF published without GPS, strip
  it in your export tool first (or re-export as JPEG/PNG/WebP, which do
  support in-app stripping) — the alternative is checking "keep GPS" and
  accepting the location stays in the file.

## Updating the app

```sh
git pull
docker compose up -d --build
```

Rebuilds and restarts `app`; `caddy` and `pds` are untouched (`pds`'s image
stays pinned — it's never rebuilt from source, only composed). For bumping
the `pds` image pin itself, see [`upgrade-pds.md`](./upgrade-pds.md) — don't
just edit that line and `--build` your way past it without reading that
runbook first.

## Backups

Nightly CAR + blob backups are written to `./backups` on the host
(`BACKUP_DIR=/backups` in `.env`) as long as that variable is set — it is by
default. They're your own repo's data, exported from your own PDS; nothing
here depends on a third party to recover it. **`./backups` living only on
this one VPS is itself a single point of failure** — copy it off-host on a
schedule (`rsync`/`rclone` to another machine or object storage). See
[`restore-from-backup.md`](./restore-from-backup.md) for the recovery
procedure, and note that `.env` itself is *not* part of this backup — keep a
separate copy of it (or at least `DOMAIN`/`OWNER_EMAIL`/`OWNER_DID`) if you
want to restore under the same identity without redoing recovery-key work.

You can also pull a manual export any time from
`https://yourdomain.com/admin/export` while signed in as owner — streams a
`application/vnd.ipld.car` file of your whole repo on demand.

---

## Troubleshooting: Preflight

Every preflight failure below is a hard exit with a message telling you
exactly this. Fix the one thing, re-run `./setup.sh` — everything already
done is skipped automatically.

**`Docker is not installed.`**
Install it: `curl -fsSL https://get.docker.com | sh`, then re-run.

**`The Docker Compose plugin is missing (`docker compose version` failed).`**
Install it: https://docs.docker.com/compose/install/linux/, then re-run. (If
you installed Docker via the official script above, this is already
included — this only fires on older/partial installs.)

**`curl is required.` / `dig is required for the DNS check.` / `openssl is required to generate secrets.`**
`sudo apt-get update && sudo apt-get install -y curl dnsutils openssl`, then
re-run.

**`Set DOMAIN in deploy/.env to your real apex domain, then re-run.`**
You left `DOMAIN` blank or at the `example.com` placeholder. Edit `.env`.

**`Set OWNER_EMAIL in deploy/.env to a real email address you control, then re-run.`**
Same, for `OWNER_EMAIL` — it can't still end in `@example.com`.

**`DNS isn't pointed at this server yet.`**
The message itself prints this server's actual public IP and what
`yourdomain.com`/`pds.yourdomain.com` currently resolve to, plus the exact
two DNS records to create or fix. Common causes: you only created one of
the two A records; you created them at the wrong DNS host (double-check
which nameservers your registrar is actually delegating to); propagation
hasn't finished yet (wait a few minutes, re-run). If both records look
correct in `dig` output but this still fails, check for a CDN/proxy layer
(e.g. Cloudflare's orange-cloud proxying) sitting in front of the IP — this
setup needs the DNS record to resolve straight to your VPS, not through a
proxy, at least for the initial cert issuance and this preflight check.

**`Port 80 is already in use on this host` / `Port 443 is already in use`**
Something other than this project's own `caddy` is bound to 80/443 — most
often a previously-installed `nginx` or `apache2`. Stop it:
`sudo systemctl stop nginx apache2` (whichever applies), then re-run. If you
*intend* to run another web server on this box permanently, this project
needs its own VPS or you need to reconfigure that other server to not hold
80/443 (out of scope for this runbook — Caddy needs those two ports for
ACME HTTP-01 + TLS termination).

If you're resuming a run that already got as far as starting `caddy`,
preflight recognizes that specifically (checks whether *this project's*
`caddy` service is what's holding the ports) and treats it as OK, not a
conflict — you should only see this failure for a genuinely foreign
listener.

## Troubleshooting: Stack up (phase 2)

**`PDS never became healthy at https://pds.${DOMAIN}/xrpc/_health`**
`setup.sh` polls this for up to two minutes (TLS cert issuance on first boot
can take a bit). If it still fails:

- `docker compose logs pds` — look for a crash loop or a config error.
- `docker compose logs caddy` — most often this is actually a *Caddy*
  problem (cert issuance failing), not a PDS problem: check for ACME
  challenge failures, which usually trace back to the DNS check above not
  actually being satisfied yet (e.g. propagation caught up *after*
  preflight passed but the record flipped again, or a firewall/security
  group in front of the VPS is blocking inbound 80/443 despite the OS-level
  ports being free).
- Confirm nothing at the network/firewall layer (cloud provider security
  group, `ufw`) is blocking 80/443 inbound — the preflight port check only
  sees the local OS's view, not a cloud firewall in front of it.

**Handle migration warning ("skipping the handle migration to yourdomain.com")**
Not an error — printed when `https://yourdomain.com/.well-known/atproto-did`
didn't start serving your new `OWNER_DID` within the run's polling window.
Your ATProto handle stays on the bootstrap value for now; log in with that
bootstrap handle (printed in the same message) using the same password.
Once the URL above is confirmed serving your DID (`curl -fsS
https://yourdomain.com/.well-known/atproto-did`), retry the update with the
exact `curl` command `setup.sh` printed in that same warning (needs a fresh
`accessJwt` — sign in as the bootstrap handle first to get one).

**A PDS admin API call failed (`PDS call to ... failed (HTTP ...)`)**
Printed with the endpoint, HTTP status, and response body inline. If this
happens on a re-run and the error is about an invite code or an
already-existing account, it usually means a previous run got further than
`setup.sh` currently thinks — check `OWNER_DID` in `.env`; if it's already
set, account creation should have been skipped entirely (this is a bug to
report, not something to work around by hand).

## Troubleshooting: Recovery-key ceremony (phase 3)

**`goat is not installed, so the recovery-key ceremony ... and the relay crawl request ... are being SKIPPED`**
Expected if you haven't installed `goat` yet. Install it (prebuilt binary
from https://github.com/bluesky-social/goat/releases, or `go install
github.com/bluesky-social/goat@latest` with a Go toolchain), then re-run
`./setup.sh` — phases 1/2 skip work already done and it picks up at phase 3.
See [`recovery-key.md`](./recovery-key.md) for what this step actually does
and why you shouldn't leave it skipped.

## Troubleshooting: First login

**403 / "owner only"**
The DID that signed in doesn't match `OWNER_DID` in `.env`. This almost
always means you're signed in as the wrong account — double check you used
the handle/password `setup.sh` printed (not some other Bluesky account you
happened to already be signed into in the same browser). If you've recently
restored from backup or migrated, see
[`restore-from-backup.md`](./restore-from-backup.md) /
[`migrate-away.md`](./migrate-away.md) for the DID-continuity requirements
that keep this from happening.

**Redirected to the PDS authorization screen but it errors**
Check `docker compose logs pds caddy` — this screen is served entirely by
your own PDS over HTTPS through Caddy, so a failure here is almost always a
TLS or PDS-health issue, not an app issue. See the phase-2 troubleshooting
above.

**Stuck in a redirect loop between the app and the PDS**
Usually a stale/mismatched `SESSION_SECRET` or `OAUTH_JWK` after a manual
`.env` edit without restarting `app`. Restart it:
`docker compose up -d app`, and clear cookies for `yourdomain.com` in your
browser before retrying.
