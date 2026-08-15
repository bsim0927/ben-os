import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedEmail, LOGIN_PATH, loginRedirectFor } from "@/lib/auth";

import { supabaseEnv } from "./env";

/**
 * Routes that must stay reachable before we know who the visitor is.
 *
 * `/auth` is the sign-in round trip itself — gating it would lock the door from
 * the inside. `/api/cron` is reached by a scheduler that has no Google session
 * and never can; those routes carry their own bearer-secret check instead
 * (`lib/cron.ts`), so skipping the session gate here does not leave them open.
 * `/api/notes/telegram/webhook` is the same story for the other kind of
 * sessionless caller: Telegram POSTs it server-to-server, and it authenticates
 * itself with the secret-token header plus the chat allowlist (`lib/notes/
 * telegram.ts`, ADR 0011 dec. 4) — so, like cron, letting it past the session
 * gate does not leave it open.
 */
const PUBLIC_PREFIXES = ["/auth", "/api/cron", "/api/notes/telegram/webhook"];

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

  return redirectCarryingCookies(request, loginRedirectFor(user), response);
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
