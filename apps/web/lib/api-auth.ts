/**
 * The session gate on API routes a human calls.
 *
 * The same three lines were being written at the top of every such route —
 * fetch the user, compare the email, 401 — which is exactly how one of them
 * ends up subtly different from the others. It lives here rather than in
 * `lib/auth.ts` because reading the session needs `@/lib/supabase/server`, and
 * `lib/auth.ts` is imported by client components: pulling a `next/headers`
 * dependency into it would break their bundle.
 *
 * Deliberately separate from `authorizeCronRequest`. Scheduled routes
 * authenticate with a shared secret precisely *because* they have no session
 * (ADR 0005 decision 7), so one helper covering both would have to take the
 * difference as an argument and would answer neither question clearly.
 */

import { isAuthorizedEmail } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * `null` when the caller is the authorized user; the response to return
 * otherwise.
 *
 * Checked here rather than trusted from the middleware, on purpose: these
 * routes reach real credentials and real writes, so a routing mistake should
 * cost a 401 rather than a bank connection.
 */
export async function authorizeApiRequest(): Promise<Response | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return !user || !isAuthorizedEmail(user.email) ? new Response(null, { status: 401 }) : null;
}
