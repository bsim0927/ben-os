import type { User } from "@supabase/supabase-js";

/**
 * The single Google account permitted to use ben-os.
 *
 * Hardcoded rather than read from an env var, deliberately: this value is the
 * app-layer half of a pair, and its other half is the string literal inside
 * `is_authorized()` (see `supabase/migrations/20260801000000_auth_baseline.sql`).
 * ADR 0001 rejected indirection for the SQL side so the gate can't be changed
 * outside a reviewed commit; splitting the app side into runtime config would
 * reintroduce exactly the drift that decision avoids. Changing the authorized
 * account means editing both, together.
 */
export const ALLOWED_EMAIL = "bimmons927@gmail.com";

/** Where a rejected visitor is sent. Shared so both gates agree on the answer. */
export const LOGIN_PATH = "/login";

/**
 * The app-layer gate. Mirrors `is_authorized()`'s comparison — trimmed,
 * case-insensitive, exact — so a request can never pass one gate and fail the
 * other. This is the check; the RLS policy is the backstop behind it.
 */
export function isAuthorizedEmail(email: string | null | undefined): boolean {
  if (!email) return false;

  return email.trim().toLowerCase() === ALLOWED_EMAIL;
}

/**
 * Where to send someone who may not see the console. A signed-in visitor gets
 * told why; a signed-out one just gets the sign-in page. Both gates call this,
 * so they can't drift on the destination.
 */
export function loginRedirectFor(user: User | null): string {
  return user ? `${LOGIN_PATH}?error=unauthorized` : LOGIN_PATH;
}

/** How the authorized user is identified in the shell's sidebar footer. */
export type AuthorizedUser = {
  name: string;
  initial: string;
};

export function authorizedUserFor(user: User): AuthorizedUser {
  const metadata = user.user_metadata as { full_name?: string; name?: string } | undefined;
  const name = metadata?.full_name?.trim() || metadata?.name?.trim() || user.email || "Account";

  return { name, initial: name.charAt(0).toUpperCase() };
}
