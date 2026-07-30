# Runbook: Migrate Away

Moving your entire identity — repo records, blobs, and the `did:plc:...`
itself — off this OpenPortfolio instance and onto a different PDS (another
OpenPortfolio instance, or any ATProto-compliant PDS). This is the
sovereignty guarantee the whole project is built on: nothing here locks you
in, and this runbook is the proof.

Audience: same as the other runbooks. This one assumes slightly more care,
because it ends with **deactivating your current account** — read the whole
thing once before running any command in anger.

## What "migration" actually means

Your identity is the `did:plc:...`, not the hostname. Migrating moves:

1. Your **repo** (every ATProto record: `social.opencontent.*` and anything
   else in your repo) to a new PDS.
2. Your **blobs** (the actual image bytes) to that new PDS's blobstore.
3. Your **PLC identity document** to say the new PDS hosts you now.

Your `did:plc:...` itself never changes. Anything that referenced you by DID
(which is everything ATProto-native) keeps working once step 3 lands;
anything that referenced you by your old handle will need to resolve
through the DID like everything else always has.

## Before you start

- **`goat` installed on your own machine** — not the VPS you're leaving.
  Doing this from a machine you trust, separate from the server you're
  migrating away from, matters: several steps below need your **full
  account password** (not an OAuth session, not an app password —
  `goat`'s own migration commands say so explicitly: "requires full auth
  (not app password)" / "requires full account password"), and you don't
  want to be typing that into a box you're simultaneously trying to walk
  away from.
- **Your full account password** for the account you're leaving (the
  `OWNER_PASSWORD` value from this instance's `.env`, or whatever you've
  since changed it to) — an OAuth-issued session from logging into the
  admin dashboard is not sufficient for the PLC-signing steps.
- **A destination PDS already running.** If it's another OpenPortfolio
  instance, that means you've already run [`install.md`](./install.md)
  there — DNS pointed, `setup.sh` complete, its own `PDS_ADMIN_PASSWORD`
  in hand. If it's some other ATProto PDS, you need equivalent admin access
  or an invite code for it.
- **Your source PDS's admin credentials are *not* required** for the
  migration itself — everything below authenticates as *your account*, not
  as the PDS operator. (You'll want them anyway if you're about to
  decommission that server.)

Every `goat` subcommand below is verified against the installed CLI's own
`--help` output and source (`goat` v0.2.3) — nothing here is guessed from
the API docs. Where the manual, multi-step version of a flow hasn't been
run end-to-end against a live pair of PDS instances in this task, it's
flagged explicitly with **VERIFY ON STAGING (Task D1)** rather than asserted
as tested.

One more thing worth knowing up front: `goat` keeps exactly **one** logged-in
session at a time, in a plaintext file at `~/.local/state/goat/auth-session.json`
(mode 600 — confirmed from `goat`'s own source; it stores your account
password in the clear alongside the session tokens). Every `goat account
login` below **overwrites** that file. The steps are written in the order
that requires the fewest login switches, but you will switch sessions
between the old and new account more than once — pay attention to which
account each step's heading says you should be logged in as. Run `goat
account logout` when you're done, and don't leave that state file sitting
around longer than you need it.

## Setup

```sh
mkdir -p ./migration && cd ./migration
OLD_DID="did:plc:..."             # your current DID (OWNER_DID in .env)
OLD_PDS="https://pds.yourolddomain.com"
NEW_PDS="https://pds.yournewdomain.com"
```

## Step 1 — Export your repo (read-only, unauthenticated)

```sh
goat repo export "$OLD_DID" --output ./repo.car
```

`goat repo export` talks to your DID's current PDS over the public,
unauthenticated `com.atproto.sync.getRepo` endpoint — no login needed, and
nothing on the source account is touched. Safe to run any number of times.

## Step 2 — Export your blobs (read-only, unauthenticated)

```sh
goat blob export "$OLD_DID" --output ./blobs
```

Downloads every blob to `./blobs/<cid>` (filename is the raw CID, no
extension) via `com.atproto.sync.listBlobs` + `com.atproto.sync.getBlob` —
also public and unauthenticated, also safe to re-run (it skips any CID
already present on disk).

## Step 3 — Create the account on the destination PDS

This is the one step that needs a decision: does the destination PDS give
you admin access?

**If the destination is your own OpenPortfolio instance** (you have its
`PDS_ADMIN_PASSWORD` from its `.env`), the cleanest verified path is the
admin-side create, which mints its own invite code for you:

```sh
goat pds admin account create \
  --pds-host "$NEW_PDS" \
  --admin-password '<destination PDS_ADMIN_PASSWORD>' \
  --handle "obootstrap.pds.yournewdomain.com" \
  --password '<a-new-password-you-choose>' \
  --email "you@example.com" \
  --existing-did "$OLD_DID"
```

**If you don't have admin access to the destination** (a third-party PDS),
you need an invite code from its operator, then the plain (non-admin)
create:

```sh
goat account create \
  --pds-host "$NEW_PDS" \
  --handle "obootstrap.pds.yournewdomain.com" \
  --password '<a-new-password-you-choose>' \
  --email "you@example.com" \
  --invite-code "<code-from-destination-operator>" \
  --existing-did "$OLD_DID"
```

`--existing-did` is what makes this a migration instead of a brand-new
identity — both `goat account create` and `goat pds admin account create`
support it (confirmed in source: `"an existing DID to use (eg, non-PLC DID,
or migration)"`). Use a bootstrap-style handle here, same reasoning as
`setup.sh`'s own account creation in [`install.md`](./install.md) — you'll
update the handle to your real domain in a later step, once the new
deployment's `/.well-known/atproto-did` is actually serving this DID.

> **VERIFY ON STAGING (Task D1):** `--existing-did` is a documented,
> verified `goat`/reference-PDS flag, but the exact server-side acceptance
> rules for claiming an *already-registered* DID this way (as opposed to a
> fresh one) haven't been exercised end-to-end against a live pair of PDS
> instances in this task. Run this step against a disposable scratch DID
> first and confirm the response (`Success! DID: ... Handle: ...`) before
> trusting it against your real identity.

## Step 4 — Log in to the new account

```sh
goat account login --username "$OLD_DID" --password '<the-new-password-from-step-3>' --pds-host "$NEW_PDS"
```

## Step 5 — Import the repo

```sh
goat repo import ./repo.car
```

Uses the session from step 4. This writes every record into the new
account's repo — but the blobs those records reference don't exist on the
new PDS's blobstore yet. That's expected; that's step 6.

## Step 6 — Upload every blob

`goat blob upload` takes one file at a time, so loop over what step 2
downloaded:

```sh
for f in ./blobs/*; do
  goat blob upload "$f"
done
```

Blob CIDs are content-addressed hashes of the raw bytes — re-uploading the
exact same bytes reproduces the exact same CID, so the records you just
imported (which reference the *old* CIDs) line up automatically with no
remapping needed.

Confirm nothing was missed:

```sh
goat account missing-blobs
```

Should print nothing. If it lists any CIDs, re-run the upload loop for just
those (they're almost always a transient upload failure, not a genuinely
missing blob you don't have — check `./blobs/<cid>` exists locally first).

## Step 7 — Migrate the PLC identity

This is the step that actually moves your DID's "who hosts me" pointer. It
needs a 2FA token from your **old** account, credentials fetched from your
**new** account, and a signature from your **old** account — three
alternations of the single `goat` session. This exact sequence (fetch
recommended creds from new → sign with old + token → submit via new) is
lifted directly from `goat account migrate`'s own implementation (the
tool's built-in one-shot command — see the callout at the end of this
runbook), not invented for this doc.

**7a. Request a 2FA token, logged in as the OLD account:**

```sh
goat account login --username "$OLD_DID" --password '<your-real-old-password>' --pds-host "$OLD_PDS"
goat account plc request-token
```

Check your email for the token (it's tied to the account's `OWNER_EMAIL`).

**7b. Fetch the recommended DID credentials, logged in as the NEW account:**

```sh
goat account login --username "$OLD_DID" --password '<the-new-password-from-step-3>' --pds-host "$NEW_PDS"
goat account plc recommended > recommended.json
```

This asks the *new* PDS what it thinks your identity document should say
(its own service endpoint, its own signing keys) — not a live change yet,
just a proposal.

**7c. Sign that proposal, logged in as the OLD account, with the token from 7a:**

```sh
goat account login --username "$OLD_DID" --password '<your-real-old-password>' --pds-host "$OLD_PDS"
goat account plc sign recommended.json --token '<the-2fa-token-from-your-email>' > signed.json
```

**7d. Submit it, logged in as the NEW account:**

```sh
goat account login --username "$OLD_DID" --password '<the-new-password-from-step-3>' --pds-host "$NEW_PDS"
goat account plc submit signed.json
```

> **VERIFY ON STAGING (Task D1):** each individual subcommand in 7a–7d is
> verified against `goat`'s source. The *manual*, four-separate-CLI-process
> version of this handoff — where the single global session file gets
> overwritten between every sub-step, rather than `goat account migrate`'s
> in-process pair of API clients that never touch disk in between — has not
> been run end-to-end in this task. If anything in this section behaves
> unexpectedly, the fallback is the one-shot `goat account migrate` command
> described at the end of this runbook, which performs the same sequence
> without the manual session-juggling.

## Step 8 — Activate the new account, deactivate the old one

Still logged in as the new account from 7d:

```sh
goat account activate
```

Then switch back:

```sh
goat account login --username "$OLD_DID" --password '<your-real-old-password>' --pds-host "$OLD_PDS"
goat account deactivate
```

**This is the point of no easy return.** Before running `deactivate`,
confirm step 7's PLC update actually landed (see Verify, below) — a
deactivated old account is still technically reversible with
`goat account activate` against the old PDS if you catch it immediately,
but the two accounts diverging while both are half-active is not a state
you want to spend time in. Don't run this until you've verified.

## Step 9 — Update the handle on the new account (optional)

If you want your real domain as the handle on the new instance (rather than
the bootstrap handle from step 3), this needs the new deployment's
`https://yournewdomain.com/.well-known/atproto-did` to already be serving
this DID — same constraint `setup.sh` documents for a fresh install. Once
confirmed:

```sh
goat account login --username "$OLD_DID" --password '<the-new-password-from-step-3>' --pds-host "$NEW_PDS"
goat account update-handle yournewdomain.com
```

## Verify

```sh
goat plc data "$OLD_DID"
```

Confirm `services.atproto_pds.endpoint` now points at `$NEW_PDS` and
`rotationKeys` looks like what you expect (your offline recovery key, if you
registered one, should still be there and still highest-priority — see
[`recovery-key.md`](./recovery-key.md); it survives a PDS migration
untouched, since migration only changes hosting, not who holds rotation
authority, unless you specifically remove keys as part of it).

```sh
goat account status "$OLD_DID"
# on the new PDS, should print: Active: true
goat ls "$OLD_DID" --collection social.opencontent.photograph
# spot-check this against the record count you had on the old instance
```

Then, in a browser: visit `https://yournewdomain.com/admin/login`, sign in,
and confirm your content actually renders — the record/blob counts matching
is necessary but not sufficient; look at the real site.

## Housekeeping

```sh
goat account logout
```

Clears the local session file. Do this once you're confident the migration
landed — no reason to leave your password sitting in plaintext on disk
longer than the migration itself took.

## The one-shot alternative: `goat account migrate`

`goat` ships a single command that performs steps 3, 5, 6, 7, and 8 above
in one process, using two in-memory API clients instead of the
overwrite-the-session-file dance in step 7:

```sh
goat account login --username "$OLD_DID" --password '<your-real-old-password>' --pds-host "$OLD_PDS"
goat account plc request-token
# — get the token from email —
goat account migrate \
  --pds-host "$NEW_PDS" \
  --new-handle "obootstrap.pds.yournewdomain.com" \
  --new-password '<a-new-password-you-choose>' \
  --plc-token '<the-2fa-token-from-your-email>'
```

This is `goat`'s own maintained implementation, not a shortcut this runbook
is inventing — its source is what the manual steps above were written to
match. It's faster and skips the manual session-switching entirely, but it
also gives you no checkpoint between "created the new account" and
"deactivated the old one" — if something goes wrong partway through, you're
debugging a partially-migrated account with less visibility into which step
failed. **Recommended for a second or third migration, once you trust the
process; recommended *against* for your first one** — walk through the
manual steps above at least once so you know what "working" looks like at
each stage before you hand the whole thing to one command.
