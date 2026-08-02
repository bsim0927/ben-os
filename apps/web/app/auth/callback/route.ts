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
  const base = deploymentOrigin(request, origin);

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
 * Behind Vercel's proxy the request's own origin is the internal one, so
 * redirecting to it would bounce the user somewhere they can't reach. Locally
 * there's no proxy and the request origin is already correct.
 */
function deploymentOrigin(request: Request, origin: string): string {
  const forwardedHost = request.headers.get("x-forwarded-host");

  if (process.env.NODE_ENV === "development" || !forwardedHost) {
    return origin;
  }

  return `https://${forwardedHost}`;
}
