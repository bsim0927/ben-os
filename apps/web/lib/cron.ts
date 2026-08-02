import { timingSafeEqual } from "node:crypto";

/**
 * The gate on scheduled routes.
 *
 * Routes under `/api/cron` are the one part of the app the session gate lets
 * through unauthenticated (see `lib/supabase/middleware.ts`) — a cron invocation
 * carries no Google session and never can. They authenticate themselves with a
 * shared secret instead, which is what Vercel Cron sends as a bearer token.
 */
export type CronAuth = { authorized: true } | { authorized: false; reason: string };

/**
 * Why a rejection says which rejection it is.
 *
 * The instinct is to give an unauthenticated caller nothing, and the first
 * version of this did exactly that — a bodyless 401. In practice the only
 * person who ever reads it is the operator trying to work out why their own
 * `curl` bounced, and "401, no body" is indistinguishable from a proxy or a
 * protection layer eating the request. The three reasons below tell an attacker
 * nothing they can't already infer from a 401 with an empty body: whether the
 * endpoint is closed is unchanged, because it fails closed in every branch.
 *
 * The secret itself is never echoed, and no branch reveals its length.
 */
export function authorizeCronRequest(request: Request): CronAuth {
  // A configured secret may still arrive with a stray newline from a dashboard
  // paste. Trimming both sides costs nothing — whitespace at either end of a
  // shared secret is a typo in every case, never a deliberate character.
  const secret = process.env.CRON_SECRET?.trim();

  // Fail closed. An unset secret must not mean "let everyone in" — that is
  // exactly the misconfiguration this check exists to survive.
  if (!secret) {
    return {
      authorized: false,
      reason:
        "CRON_SECRET is not set on this deployment. Add it in the Vercel project's " +
        "environment variables, then redeploy — variables are read at build time, so " +
        "adding one does not affect a deployment that is already running.",
    };
  }

  const header = request.headers.get("authorization");

  if (!header) {
    return { authorized: false, reason: "No Authorization header was sent." };
  }

  if (!header.startsWith("Bearer ")) {
    return {
      authorized: false,
      reason: "The Authorization header must be of the form 'Bearer <CRON_SECRET>'.",
    };
  }

  if (!constantTimeEquals(header.slice("Bearer ".length).trim(), secret)) {
    return {
      authorized: false,
      reason:
        "The bearer token does not match CRON_SECRET. If it was set recently, redeploy — " +
        "a running deployment keeps the values it was built with.",
    };
  }

  return { authorized: true };
}

/**
 * Compared in constant time so the response's timing can't be used to recover
 * the secret a character at a time. Lengths are compared first because
 * `timingSafeEqual` throws on a mismatch — that leaks length, which is a far
 * cheaper thing to give away than the contents.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  if (left.length !== right.length) return false;

  return timingSafeEqual(left, right);
}
