import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { E2EConfig } from "./global-setup";

// ── Task A13: the full author loop, through a real browser ─────────────────
// Owner: scripted OAuth against dev-env's real @atproto/oauth-provider sign-in
// form (a plain HTML username/password form -- production Bluesky's own OAuth
// UI is the same shape, just not automatable against the real network) ->
// drag-drop upload with the dropzone's real file input, prefilled from the
// fixture's embedded IPTC/XMP title -> publish -> the public site renders it.
// Non-owner: a second, unrelated dev-env account completes the identical
// OAuth dance and is rejected at /admin. See e2e/global-setup.ts's header
// comment for the whole harness architecture (why no `webServer`, why a
// self-signed-HTTPS fake hostname, why `next build`+`start` over `next dev`).

let cfg: E2EConfig;

test.beforeAll(async () => {
  const configPath = process.env.E2E_CONFIG_PATH;
  if (!configPath) {
    throw new Error("E2E_CONFIG_PATH is not set -- this spec must be run through playwright.config.ts's globalSetup (e2e/global-setup.ts), not directly.");
  }
  cfg = JSON.parse(await readFile(configPath, "utf8")) as E2EConfig;
});

/**
 * Drives the full scripted-OAuth sign-in for `handle`: /admin/login -> fill
 * handle -> dev-env's real authorize/sign-in page (a different origin --
 * the PDS itself, not this app -- so this is a genuine cross-origin
 * navigation) -> password -> its consent screen -> back on this app's own
 * `/oauth/callback`, which redirects the browser onward (the owner lands on
 * `/admin`; a non-owner is bounced to `/admin/login` by `requireAdminSession`
 * before `/admin` ever renders anything -- callers assert on wherever they
 * land next).
 */
async function signIn(page: Page, handle: string, password: string): Promise<void> {
  await page.goto(`${cfg.baseUrl}/admin/login`);
  await page.getByLabel("Bluesky handle").fill(handle);
  await page.getByRole("button", { name: "Continue with AT Protocol" }).click();

  await page.waitForURL((url) => url.pathname.startsWith("/oauth/authorize"));
  // The username field arrives prefilled (and read-only) from the handle
  // the app's own authorize() call passed -- asserting on it here doubles
  // as proof the OAuth request actually carried the right identity.
  await expect(page.locator('input[name="username"]')).toHaveValue(handle);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  // Consent screen: "Grant access to your <handle> account".
  await page.getByRole("button", { name: "Authorize", exact: true }).click();
}

test.describe("author loop", () => {
  test("owner signs in, uploads a photograph with prefilled metadata, and publishes it live", async ({ page }) => {
    await test.step("sign in as the site owner", async () => {
      await signIn(page, cfg.ownerHandle, cfg.ownerPassword);
      await page.waitForURL((url) => url.pathname === "/admin");
      await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    });

    let photoHref = "";
    await test.step("drag-drop upload, prefilled title visible, publish", async () => {
      await page.goto(`${cfg.baseUrl}/admin/upload`);
      // The dropzone's own file input, set directly (this app's real drag-
      // drop dropzone forwards onto the same hidden <input type="file">).
      await page.locator('input[type="file"]').setInputFiles(cfg.fixturePath);

      // Prefill: /admin/api/prefill's real exiftool/exifr read of the
      // fixture's embedded title, surfaced in the (editable) Title field --
      // the observable proof this app actually reads embedded metadata
      // rather than requiring it typed in by hand.
      await expect(page.getByLabel("Title")).toHaveValue(cfg.fixtureTitle);

      await page.getByRole("button", { name: "Publish", exact: true }).click();
      await expect(page.getByText("Published.", { exact: true })).toBeVisible();
    });

    await test.step("the public homepage renders the published tile", async () => {
      await page.goto(`${cfg.baseUrl}/`);
      const tile = page.locator('a[href^="/p/"]').first();
      await expect(tile).toBeVisible();
      photoHref = (await tile.getAttribute("href")) ?? "";
      expect(photoHref).toMatch(/^\/p\//);
    });

    await test.step("the photograph's own page renders its title", async () => {
      await page.goto(`${cfg.baseUrl}${photoHref}`);
      await expect(page.getByRole("heading", { level: 1, name: cfg.fixtureTitle })).toBeVisible();
    });
  });

  test("a signed-in visitor who is not the site owner is rejected at /admin", async ({ page }) => {
    await test.step("sign in as a second, unrelated dev-env account", async () => {
      await signIn(page, cfg.nonOwnerHandle, cfg.nonOwnerPassword);
    });

    const rejectionText = page.getByText("this account is not the site owner.", { exact: false });

    await test.step("the callback bounces straight to the login page's not-owner message", async () => {
      await page.waitForURL((url) => url.pathname === "/admin/login");
      await expect(rejectionText).toBeVisible();
    });

    await test.step("navigating straight to /admin redirects back to the same rejection", async () => {
      await page.goto(`${cfg.baseUrl}/admin`);
      await page.waitForURL((url) => url.pathname === "/admin/login");
      await expect(rejectionText).toBeVisible();
    });
  });
});
