# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**OpenPortfolio** — a self-hostable, ATProto-native portfolio CMS. The owner's
portfolio (photographs, collections, site config) lives as
`social.opencontent.*` records in their *own* pinned PDS, not an app silo; the
app is one consumer of that commons. Ships as a Docker deployment (Caddy +
pinned PDS + app) installed onto a fresh VPS by `deploy/setup.sh`. Private
until productization.

## Layout

pnpm (10.x) + Turborepo monorepo:

- `apps/site` — Next.js 16 / React 19 / Tailwind 4. Public routes in
  `app/(public)`, admin CMS under `/admin`, ATProto OAuth **confidential
  client** (`lib/oauth.ts`), image proxy (`app/img`), CAR backup/export
  (`lib/backup.ts`, `lib/backup-scheduler.ts`). Unit tests sit next to source
  (`lib/*.test.ts`).
- `packages/lexicons` — `@openportfolio/lexicons`: typed record builders
  (`src/records.ts`) + mirrored JSON schemas (`lexicons/`).
- `deploy/` — `docker-compose.yml`, `Caddyfile`, and the one-command
  `setup.sh` installer (recovery-key ceremony, relay crawl).
- `docs/runbooks/` — operator runbooks: install, recovery-key, migrate-away,
  restore-from-backup, upgrade-pds.

## Commands

Run from the repo root:

- `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm test` (turbo; unit
  suite only)
- `pnpm --filter site dev` — local dev server
- `pnpm --filter site test:integration` — dev-env suite
  (`vitest.integration.config.ts`): real local PDS via `@atproto/dev-env`,
  excluded from the default `test` script
- `pnpm --filter site test:e2e` — Playwright author-loop E2E against a real
  dev-env network + production build (first run: `pnpm --filter site exec
  playwright install chromium`)

CI (`.github/workflows/ci.yml`) runs only build + typecheck + unit test. The
integration and E2E suites are **local/nightly only** — run them yourself
before trusting a change to the publish/OAuth path.

## Hard rules

- **Lexicons lead, this repo follows.** `packages/lexicons` mirrors the
  sibling `opencontent-lexicons` repo (the editorial source of truth) and must
  never diverge from or front-run it. Schema evolution is additive-only.
- **Consumer contract:** dangling strongRefs are skipped (never an error),
  unknown fields are ignored, unlisted collections still render.
- The site record's lexicon key is `literal:self` — always write it with
  rkey `"self"` (one record per repo).
- `fNumber` is a **string** (lexicons have no float type); don't "fix" it.
- Brand token is fused: `openportfolio` in identifiers, "OpenPortfolio" in
  prose — never "Open Portfolio" or `open-portfolio`.
