import { createBrowserClient } from "@supabase/ssr";

import { supabaseEnv } from "./env";

/** A Supabase client for browser code — used only to start the OAuth redirect. */
export function createClient() {
  const { url, anonKey } = supabaseEnv();

  return createBrowserClient(url, anonKey);
}
