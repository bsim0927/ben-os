import { NextResponse } from "next/server";

import { isAuthorizedEmail } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * Where Google sends the user back to.
 *
 * A successful OAuth exchange only proves *a* Google account signed in — so
 * the wrong one is signed straight back out here rather than being left holding
 * a live session it could never use.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const base = siteOrigin(origin);

  if (!code) {
    return NextResponse.redirect(`${base}/login?error=signin_failed`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(`${base}/login?error=signin_failed`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!isAuthorizedEmail(user?.email)) {
    await supabase.auth.signOut();

    return NextResponse.redirect(`${base}/login?error=unauthorized`);
  }

  return NextResponse.redirect(`${base}/`);
}

/**
 * Where to send the user once sign-in resolves.
 *
 * Behind a proxy the request's own origin can be the internal one, which the
 * user can't reach. The fix is configuration, not the `x-forwarded-host` header
 * that Supabase's guide reaches for — that header is attacker-settable, and
 * trusting it would hand anyone the post-sign-in redirect target.
 */
function siteOrigin(origin: string): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;

  return configured ? configured.replace(/\/+$/, "") : origin;
}
