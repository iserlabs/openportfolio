# apps/site/Dockerfile -- built from the MONOREPO ROOT as build context
# (see deploy/docker-compose.yml: `build: { context: .., dockerfile:
# apps/site/Dockerfile }`), because pnpm/turbo need the whole workspace
# (pnpm-lock.yaml, pnpm-workspace.yaml, packages/lexicons) to resolve
# `@open-portfolio/lexicons` -- same reason Luminance's own
# apps/ingestor/Dockerfile is built from its repo root.
#
# Stages: base -> deps (full install, for building) / prod-deps (prod-only
# install, for running) -> build (turbo build) -> runner (slim runtime).
#
# IMPORTANT, hard-won: this does NOT use `pnpm deploy` to flatten `apps/site`
# into a standalone directory, and the runner deliberately keeps the exact
# same `<root>/apps/site/...` nesting depth the build used. Next's Turbopack
# production output marks native-binary deps (better-sqlite3, sharp) as
# "externals" by generating symlinks under `apps/site/.next/node_modules/`
# with a build-time-computed *relative* target back up to the workspace
# root's `node_modules/.pnpm/...` (verified by inspecting the actual build
# output, e.g. `.next/node_modules/better-sqlite3-<hash> ->
# ../../../../node_modules/.pnpm/better-sqlite3@.../node_modules/better-sqlite3`
# -- four `../` levels, matching apps/site/.next/node_modules's build-time
# depth below the repo root). `pnpm deploy` collapses that nesting by one
# level (site's own dir becomes the new root), which breaks those four-`../`
# symlinks and makes the server crash on boot with "Cannot find module
# 'better-sqlite3-<hash>'" the moment `instrumentation.ts` reaches
# better-sqlite3 -- reproduced locally while building this Dockerfile.
# Preserving the original directory depth sidesteps the whole problem
# instead of trying to rewrite Turbopack's generated symlinks after the fact.
#
# `deps` and `prod-deps` both run the same build-toolchain install and
# `pnpm install`, from the same repo-root manifests, so their `.pnpm` layout
# is identical to what `build` produces from -- `prod-deps` just adds
# `--prod` to drop devDependencies (typescript, vitest, tailwindcss, ...)
# from the final image.
#
# `deps`/`build` and `runner` all share the same Debian-based node:24-slim
# image (glibc, not musl/Alpine) so that better-sqlite3's native binding and
# sharp's libvips binaries stay valid in the final image. Do not switch any
# stage to an Alpine base without re-verifying both packages still resolve
# (or compile) for it.
#
# KNOWN LIMITATION (amd64 verified end-to-end; arm64 has an upstream gap):
# better-sqlite3@13 ships prebuilt native addons *bundled in the npm package
# itself* for every platform (`prebuilds/linux-x64.node`,
# `prebuilds/linux-arm64.node`, ...; see its `lib/binding.js`), and always
# prefers that bundled prebuild over any local `node-gyp` compile when one
# exists for the current platform/arch -- so the `python3`/`make`/`g++`
# toolchain below is only insurance for platforms it *doesn't* bundle one
# for. Verified on `--platform linux/amd64` (the common case for a VPS):
# both better-sqlite3 (a real insert/select) and sharp load and run
# correctly in the built image. On `linux/arm64`, this specific version's
# bundled prebuild requires glibc >= 2.38, which Debian bookworm (this
# base image's OS) doesn't have (2.36) -- `require("better-sqlite3")`
# fails with `GLIBC_2.38' not found` at the point it's first actually
# opened (not at import time, so this doesn't surface until something
# calls `new Database(...)`). If deploying to an arm64 VPS, either wait for
# a node:*-slim base on a newer Debian, or force-rebuild from source after
# deleting the bundled arm64 prebuild so `binding.js` falls through to a
# freshly-compiled `build/Release/better_sqlite3.node` instead.
#
# exiftool-vendored (the sole authoritative GPS-strip/read path -- see
# apps/site/lib/photo-metadata.ts's stripGps/extractPrefill) is NOT a
# native Node addon: it's the real ExifTool, a Perl program, shipped via
# the `exiftool-vendored.pl` optional dependency and spawned as a
# subprocess -- so it needs a `perl` binary on PATH *in the runner stage*,
# not just a compatible Node ABI. Confirmed present by default on
# node:24-slim (Debian bookworm ships perl-base as a core package) --
# verified end-to-end in the actual built image: wrote GPSLatitude/
# GPSLongitude onto a fixture JPEG, ran the exact `-gps:all=
# -overwrite_original` strip stripGps() uses, confirmed the tags were gone
# and the decoded pixel bytes were unchanged (the metadata-only-surgery
# invariant). This is an assumption about the base image, though, not
# something this Dockerfile enforces: switching `runner` off node:24-slim
# (e.g. to a distroless or from-scratch base) would silently break GPS
# stripping -- `exiftool.write()` would reject at runtime with a spawn
# ENOENT, not a build-time failure -- so re-verify this specifically
# (not just better-sqlite3/sharp) before ever changing that base image.

# syntax=docker/dockerfile:1.7

FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"
RUN corepack enable

FROM base AS with-native-toolchain
WORKDIR /app
# python3/make/g++: node-gyp build toolchain, for any native dependency
# that needs to compile from source rather than use a bundled/downloaded
# prebuild (see the amd64/arm64 note below on better-sqlite3 specifically).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*
# Manifests only, for install-layer caching -- source is added in `build`.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json .npmrc ./
COPY apps/site/package.json apps/site/package.json
COPY packages/lexicons/package.json packages/lexicons/package.json

FROM with-native-toolchain AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM with-native-toolchain AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

FROM deps AS build
COPY . .
# Same command CI runs (`.github/workflows/ci.yml`): turbo builds
# packages/lexicons (tsc -> dist/) before apps/site (next build -> .next/),
# per turbo.json's `dependsOn: ["^build"]`.
RUN pnpm build

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app
# /data (SQLITE_PATH's parent) and /backups (BACKUP_DIR) are chowned here,
# before they're ever used as volume mount points: for a *named* volume
# (app-data, in docker-compose.yml) Docker initializes a fresh volume by
# copying the image directory's existing content and ownership, so the
# non-root `node` user (uid 1000, built into this base image) can already
# write to it on first boot instead of inheriting a root-owned mount point.
RUN mkdir -p /data /backups && chown node:node /data /backups
# Two copies, not one: pnpm's per-workspace-package node_modules
# (apps/site/node_modules -- symlinks for site's *own* deps, including the
# `next` CLI at node_modules/.bin/next) is separate from the repo root's
# node_modules (root-level deps plus the shared `.pnpm` content-addressable
# store those per-package symlinks point *into*, three `../` levels up from
# apps/site/node_modules). Both are required; copying only the root one
# leaves apps/site/node_modules -- and `next` itself -- missing.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/apps/site/node_modules ./apps/site/node_modules
COPY --from=build --chown=node:node /app/apps/site/.next ./apps/site/.next
COPY --from=build --chown=node:node /app/apps/site/package.json ./apps/site/package.json
COPY --from=build --chown=node:node /app/apps/site/next.config.ts ./apps/site/next.config.ts
WORKDIR /app/apps/site
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start"]
