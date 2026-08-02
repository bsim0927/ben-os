import { timingSafeEqual } from "node:crypto";

/**
 * The gate on scheduled routes.
 *
 * Routes under `/api/cron` are the one part of the app the session gate lets
 * through unauthenticated (see `lib/supabase/middleware.ts`) — a cron invocation
 * carries no Google session and never can. They authenticate themselves with a
 * shared secret instead, which is what Vercel Cron sends as a bearer token.
 *
 * Nothing here is user-facing, so a failure is a flat 401 with no detail: an
 * unauthenticated caller learns only that the route exists.
 */
export function isAuthorizedCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;

  // Fail closed. An unset secret must not mean "let everyone in" — that is
  // exactly the misconfiguration this check exists to survive.
  if (!secret) return false;

  const header = request.headers.get("authorization");

  if (!header?.startsWith("Bearer ")) return false;

  return constantTimeEquals(header.slice("Bearer ".length), secret);
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
