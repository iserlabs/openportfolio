// Lazy-getter env access, mirroring `~/workspace/luminance.social/apps/web/lib/env.ts`:
// importing this module must never throw even with zero env vars set (so
// `next build` succeeds without a `.env`); each getter only validates its own
// var, and only when actually accessed.
const req = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

export const env = {
  /** Pinned PDS origin. Every `pds.ts` fetch targets this host — never a caller-supplied origin. */
  get PDS_URL() { return req("PDS_URL"); },
  get OWNER_DID() { return req("OWNER_DID"); },
  get PUBLIC_URL() { return req("PUBLIC_URL"); },
  get SESSION_SECRET() { return req("SESSION_SECRET"); },
  get SQLITE_PATH() { return req("SQLITE_PATH"); },
  /** Single-instance OAuth signing key (ES256 JWK, JSON-serialized) for the confidential `private_key_jwt` client -- see `oauth.ts`. Generated per-install by `setup.sh` (Task A11); never shared across deployments. */
  get OAUTH_JWK() { return req("OAUTH_JWK"); },
  /** Optional: backup export location. Unset means backups are disabled, not an error. */
  get BACKUP_DIR() { return process.env.BACKUP_DIR; },
};
