import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

/** POST-only, so a stray link preview can't sign the user out. */
export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();

  // 303 so the browser follows with GET rather than re-POSTing.
  return NextResponse.redirect(new URL("/login", request.url), 303);
}
