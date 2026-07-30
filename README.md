# openportfolio

A self-hostable, ATProto-native portfolio CMS. The owner's portfolio —
photographs, collections, site config — lives as `social.opencontent.*`
records in their *own* PDS, not an app silo; this app is one consumer of
that lexicon commons (source of truth: the sibling `opencontent-lexicons`
repo, which `packages/lexicons` mirrors and never front-runs).

## Workspace

pnpm + Turborepo monorepo:

- `apps/site` — Next.js 16 app (React 19, Tailwind 4): public portfolio +
  `/admin` CMS + OAuth confidential client + image proxy + CAR backup/export.
  See `apps/site/AGENTS.md` for the working notes.
- `packages/lexicons` — `@openportfolio/lexicons`: typed record builders +
  mirrored `social.opencontent.*` JSON schemas.
- `deploy/` — Caddy + pinned reference PDS + app Docker composition, and the
  one-command `setup.sh` VPS installer.
- `docs/runbooks/` — operator runbooks (see below).

## Development

Run from the repo root:

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test                # unit suite only (what CI runs)
pnpm --filter site dev   # local dev server
```

Two heavier suites are local/nightly only, deliberately not in CI:

```sh
pnpm --filter site test:integration   # against a real @atproto/dev-env PDS
pnpm --filter site test:e2e           # Playwright author loop, real OAuth
                                      # (first run: pnpm --filter site exec playwright install chromium)
```

Run both before trusting changes to the publish/OAuth path.

## Self-hosting

A fresh Ubuntu VPS + two DNS records + `deploy/setup.sh` gets you a running,
federated, single-owner instance (TLS via Caddy, your own pinned PDS, nightly
CAR + blob backups, an offline recovery-key ceremony). Start with
[`deploy/README.md`](deploy/README.md); the runbooks cover everything past
the happy path:

- [`docs/runbooks/install.md`](docs/runbooks/install.md) — install, with
  troubleshooting for every failure mode (including upload limitations, e.g.
  no HEIC)
- [`docs/runbooks/recovery-key.md`](docs/runbooks/recovery-key.md) — the
  offline PLC recovery key: ceremony, storage, break-glass procedure
- [`docs/runbooks/restore-from-backup.md`](docs/runbooks/restore-from-backup.md)
  — disaster recovery from your own `BACKUP_DIR` artifacts
- [`docs/runbooks/migrate-away.md`](docs/runbooks/migrate-away.md) — moving
  your whole identity to another PDS (the no-lock-in guarantee)
- [`docs/runbooks/upgrade-pds.md`](docs/runbooks/upgrade-pds.md) — bumping
  the pinned PDS image safely

## Status

Feature-complete v1 — full admin CMS, OAuth confidential client, image pipeline, CAR backup/export, one-command VPS installer, and operator runbooks — pending staging validation and the flagship deployment. Private until productization.
