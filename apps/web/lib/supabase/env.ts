/**
 * Supabase connection details, read at call time rather than module load so a
 * missing variable surfaces as a clear error on the request that needs it
 * instead of a blank failure at import.
 *
 * Both are publishable values — the anon key is safe in the browser bundle
 * precisely because `is_authorized()`-backed RLS is what actually guards data.
 */
export function supabaseEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY — see .env.example",
    );
  }

  return { url, anonKey };
}
