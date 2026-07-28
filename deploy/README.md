# Deploying Open Portfolio

Takes a fresh Ubuntu VPS with DNS pointed at it to a running, federated,
single-owner ATProto portfolio. One command (`./setup.sh`) after two DNS
records and a `docker` install.

## What you need first

- A VPS running Ubuntu (22.04/24.04) with a public IP, and `docker` +
  the Docker Compose plugin installed (`curl -fsSL https://get.docker.com | sh`
  gets you both).
- A domain you control, with access to add DNS records.
- A real email address (used only for the PDS account you're about to
  create — never shared beyond your own PDS).

## 1. DNS

Point both of these at your VPS's public IP **before** running `setup.sh` —
it checks this and refuses to continue (with the exact fix) if it isn't
right yet:

| Type | Name              | Value              |
| ---- | ----------------- | ------------------ |
| A    | `yourdomain.com`     | `<VPS public IP>` |
| A    | `pds.yourdomain.com` | `<VPS public IP>` |

Give it a few minutes to propagate. `dig +short yourdomain.com` and
`dig +short pds.yourdomain.com` should both print your VPS's IP.

## 2. Configure

On the VPS, in this `deploy/` directory:

```sh
cp .env.example .env
```

Edit `.env` and set at least:

- `DOMAIN` — your apex domain (e.g. `yourdomain.com`)
- `OWNER_EMAIL` — a real email address you control

Leave every other key blank — `setup.sh` generates all of them
(passwords, the PDS's PLC rotation key, your session secret, your OAuth
signing key) on first run and writes them back into `.env`. Nothing in
`.env` is ever shared with, or readable by, anything outside this VPS;
`.env` itself is gitignored.

## 3. Run it

```sh
./setup.sh
```

Four phases, in order:

1. **Preflight** — confirms DNS resolves correctly, ports 80/443 are free,
   and `docker`/`curl`/`dig`/`openssl` are present. Hard-exits with the
   exact thing to fix if not (wrong DNS record, a port already in use by
   another web server, a missing tool).
2. **Stack up** — builds and starts `caddy` (TLS termination + reverse
   proxy), `pds` (the unmodified reference ATProto PDS, pinned to
   `ghcr.io/bluesky-social/pds:0.4`), and `app` (this site); generates your
   session secret and OAuth signing key; creates your owner account on the
   PDS and migrates its handle to your bare domain; restarts `app` so it
   picks up everything just written.
3. **Recovery-key ceremony** — if the [`goat`](https://github.com/bluesky-social/goat)
   CLI is installed, generates an **offline** PLC rotation key, registers
   it as your identity's highest-priority key, and saves it to
   `./recovery-key-KEEP-OFFLINE.txt`. **Move that file off this server
   immediately** (password manager, printed on paper — anywhere but here)
   — it's the only thing that can recover your identity if this server is
   ever compromised, and setup.sh prints the full explanation (and the
   72-hour window that matters) when it runs. If `goat` isn't installed,
   this step — and step 4 — are skipped with instructions to install it
   and re-run later; nothing else is blocked by skipping it.
4. **Relay crawl** — asks the public Bluesky relay to start crawling your
   PDS, so posts made through it reach the wider network.

`setup.sh` is safe to re-run: every step checks whether its work is already
done (a secret already in `.env`, an account already created, a recovery
key file already on disk) and skips it if so — so if preflight fails, or
you don't have `goat` installed yet, fix the one thing and run it again.

## 4. First login

1. Visit `https://yourdomain.com/admin/login`.
2. Sign in with the handle and password `setup.sh` printed at the end of
   the run (also saved as `OWNER_PASSWORD` in `.env`, purely for your own
   reference — the app itself never reads that value).
3. You'll land on your own PDS's authorization screen to approve the
   sign-in (this is standard ATProto OAuth — the login prompt is served by
   your PDS, not this app), then back on your admin dashboard.

From there: upload photos, arrange collections, and adjust site settings —
everything is stored as records in your own PDS repo, under
`social.opencontent.*`.

## Updating

```sh
git pull
docker compose up -d --build
```

Rebuilds the `app` image and restarts it; `caddy` and `pds` are untouched
(and `pds`'s image stays pinned — it's never rebuilt from source, only
composed).

## Backups

Nightly CAR + blob backups are written to `./backups` on the host
(`BACKUP_DIR=/backups` in `.env`, bind-mounted in `docker-compose.yml`) as
long as that variable is set — it is by default. They're your own repo's
data, exported from your own PDS; nothing here depends on a third party to
recover it.
