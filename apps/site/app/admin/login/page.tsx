import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getOAuthClient } from "@/lib/oauth";
import { getSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Admin sign-in — OpenPortfolio",
};

const ERRORS: Record<string, string> = {
  handle: "Enter your Bluesky handle to continue.",
  login: "We couldn't start the login for that handle. Check it and try again.",
  oauth: "Login didn't complete. Please try again.",
};

/**
 * Single admin sign-in flow: unlike Luminance's `/login` + `/register` split
 * (which carries a `mode`/`returnTo` app-state through the OAuth `state`
 * round trip), this app has exactly one identity worth signing in as -- the
 * owner -- so there is nothing to fork on at the callback and no returnTo to
 * carry; a successful callback always lands on `/admin`.
 */
export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const session = await getSession();
  const message = error ? ERRORS[error] : undefined;

  async function startAdminLogin(formData: FormData) {
    "use server";
    const handle = String(formData.get("handle") ?? "").trim();
    if (!handle) redirect("/admin/login?error=handle");

    const client = await getOAuthClient();
    let url: URL | undefined;
    try {
      url = await client.authorize(handle);
    } catch {
      url = undefined;
    }
    if (!url) redirect("/admin/login?error=login");
    redirect(url.toString());
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-20">
      <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
        Admin sign-in
      </h1>
      <p className="mt-4 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
        Sign in with the site owner&apos;s AT Protocol account to manage this
        portfolio.
      </p>

      {message ? (
        <p
          role="alert"
          className="mt-6 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
        >
          {message}
        </p>
      ) : null}

      {session.did ? (
        <p className="mt-6 rounded-md border border-zinc-200 bg-zinc-100 px-4 py-3 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-300">
          Signed in as{" "}
          <span className="font-medium text-black dark:text-zinc-100">
            {session.handle ?? session.did}
          </span>
          {session.isOwner ? null : " — this account is not the site owner."}
        </p>
      ) : (
        <form action={startAdminLogin} className="mt-8 space-y-3">
          <label
            htmlFor="handle"
            className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Bluesky handle
          </label>
          <input
            id="handle"
            name="handle"
            type="text"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="alice.bsky.social"
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-black placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600 dark:focus:border-zinc-600"
          />
          <button
            type="submit"
            className="w-full rounded-md bg-black px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            Continue with AT Protocol
          </button>
        </form>
      )}
    </div>
  );
}
