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
  /**
   * E2E/dev-only escape hatch (Task A13): when set, `getOAuthClient()` also
   * resolves identities against a LOCAL dev-env network instead of the real
   * internet (this instance's own `PDS_URL` doubles as the XRPC handle
   * resolver -- both the owner and every other test account live on that
   * same dev-env PDS -- and this value becomes the PLC directory URL), and
   * tolerates http endpoints throughout. Exists solely so a Playwright
   * harness can drive real ATProto OAuth against `@atproto/dev-env`'s
   * `TestNetworkNoAppView`, whose fake `.test` handles and locally-issued
   * `did:plc:*`s don't resolve against the real plc.directory/DNS. Unset
   * (the default) in every real deployment -- production handle/DID
   * resolution always uses the library's real defaults.
   */
  get OAUTH_PLC_URL() { return process.env.OAUTH_PLC_URL; },
};
