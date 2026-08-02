import { consoleButtonClassName, Wordmark } from "@/components/console";
import { GoogleSignInButton } from "@/components/google-sign-in-button";
import { isAuthorizedEmail } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * The only page outside the shell.
 *
 * It has two jobs: start Google sign-in, and be a dead end for anyone who
 * signed in successfully as the wrong person — offering "continue with Google"
 * to them would just loop them back here.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Driven by the session, not just the query string — the callback signs a
  // rejected account out, so either state can be the one that lands here.
  const wrongAccount = user && !isAuthorizedEmail(user.email) ? (user.email ?? "Unknown") : null;
  const denied = wrongAccount !== null || error === "unauthorized";

  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="border-hairline bg-panel w-full max-w-sm rounded-lg border p-6">
        <Wordmark />

        <h1 className="text-muted mt-5 text-[11px] tracking-[0.08em] uppercase">Sign in</h1>

        {denied ? (
          <p
            role="alert"
            className="border-negative bg-panel-2 text-ink mt-3 border-l-2 px-3 py-2 text-[13px]"
          >
            That Google account is not authorized for this console.
          </p>
        ) : (
          <p className="text-muted mt-3 text-[13px]">
            This console is restricted to a single Google account.
          </p>
        )}

        {wrongAccount ? (
          <div className="mt-5">
            <p className="text-muted text-[11px] tracking-[0.06em] uppercase">Signed in as</p>
            <p className="text-ink mt-1 truncate text-[13px]">{wrongAccount}</p>
            <form action="/auth/signout" method="post" className="mt-4">
              <button type="submit" className={consoleButtonClassName}>
                Sign out
              </button>
            </form>
          </div>
        ) : (
          <div className="mt-5">
            <GoogleSignInButton />
          </div>
        )}
      </div>
    </main>
  );
}
