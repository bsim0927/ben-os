"use client";

import { useState } from "react";

import { consoleButtonClassName } from "@/components/console";
import { createClient } from "@/lib/supabase/client";

/**
 * Starts the Google OAuth redirect. Whether the account that comes back is
 * *allowed* is decided server-side in `/auth/callback` — never here.
 */
export function GoogleSignInButton() {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signIn() {
    setPending(true);
    setFailed(false);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });

    // On success the browser is already navigating away; only a failure
    // returns control here.
    if (error) {
      setPending(false);
      setFailed(true);
    }
  }

  return (
    <div>
      <button type="button" onClick={signIn} disabled={pending} className={consoleButtonClassName}>
        {pending ? "Redirecting…" : "Continue with Google"}
      </button>
      {failed ? (
        <p role="alert" className="text-negative mt-2 text-[12px]">
          Could not reach Google. Try again.
        </p>
      ) : null}
    </div>
  );
}
