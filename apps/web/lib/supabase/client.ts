import { createBrowserClient } from "@supabase/ssr";

import { supabaseEnv } from "./env";

/**
 * A Supabase client for browser code: the OAuth redirect, and the Financials
 * module's categorization writes (`lib/financials/categorize.ts`). Those writes
 * go direct rather than through a route handler because RLS already gates every
 * row on `is_authorized()` — see that module for the reasoning.
 */
export function createClient() {
  const { url, anonKey } = supabaseEnv();

  return createBrowserClient(url, anonKey);
}
