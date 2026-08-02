import type { User } from "@supabase/supabase-js";

/** Whoever the session cookies resolve to on a request under test. */
export function fakeUser(email: string, metadata: Record<string, unknown> = {}): User {
  return { id: "user-1", email, user_metadata: metadata } as unknown as User;
}
