import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedEmail } from "@/lib/auth";

import { supabaseEnv } from "./env";

const LOGIN_PATH = "/login";

/** Routes that must stay reachable before we know who the visitor is. */
const PUBLIC_PREFIXES = ["/auth"];

/**
 * The app-layer gate, run ahead of every render.
 *
 * Two jobs, and the order matters: refresh the Supabase session (writing any
 * rotated tokens back onto the outgoing response), then decide whether this
 * visitor may see the page at all. The layout re-checks independently — this is
 * the outer door, not the only one.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });
  const { url, anonKey } = supabaseEnv();

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }

        response = NextResponse.next({ request });

        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // `getUser()` revalidates the token with Supabase — unlike `getSession()`,
  // which trusts whatever the cookie claims. Never gate on the latter.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const authorized = isAuthorizedEmail(user?.email);
  const { pathname } = request.nextUrl;

  if (PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return response;
  }

  if (pathname === LOGIN_PATH) {
    // A signed-in wrong account stays here on purpose: this is where it's told
    // it isn't authorized, and where it can sign out.
    return authorized ? redirectCarryingCookies(request, "/", response) : response;
  }

  if (authorized) {
    return response;
  }

  return redirectCarryingCookies(
    request,
    user ? `${LOGIN_PATH}?error=unauthorized` : LOGIN_PATH,
    response,
  );
}

/**
 * Redirect without dropping cookies Supabase just refreshed — losing them here
 * signs the user out at random, one request later.
 */
function redirectCarryingCookies(
  request: NextRequest,
  path: string,
  carrying: NextResponse,
): NextResponse {
  const redirect = NextResponse.redirect(new URL(path, request.nextUrl));

  for (const cookie of carrying.cookies.getAll()) {
    redirect.cookies.set(cookie);
  }

  return redirect;
}
