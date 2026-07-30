# openportfolio

A self-hostable, ATProto-native portfolio CMS.

## Workspace

pnpm + Turborepo monorepo:

- `apps/site` — Next.js 16 app (React 19, Tailwind 4)
- `packages/lexicons` — `social.opencontent.*` ATProto lexicon constants

## Commands

Run from the repo root:

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## Status

Feature-complete v1 — full admin CMS, OAuth confidential client, image pipeline, CAR backup/export, one-command VPS installer, and operator runbooks — pending staging validation and the flagship deployment. Private until productization.
