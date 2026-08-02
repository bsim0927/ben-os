import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { supabaseEnv } from "./env";

/**
 * A Supabase client for Server Components, layouts and route handlers.
 *
 * Built per request — never hoist it to a module-level singleton, or one
 * visitor's session would leak into another's render.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const { url, anonKey } = supabaseEnv();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components can't write cookies. Harmless: the middleware
          // runs on every request and persists refreshed tokens there.
        }
      },
    },
  });
}
