import type { NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/middleware";

/**
 * Next 16 renamed this file convention from `middleware` to `proxy`. The helper
 * it delegates to keeps the older name — that's what Supabase's own guides call
 * it, and it's the concept the ADRs refer to.
 */
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Everything except static assets — the gate has to cover routes that don't
     * exist yet, so this is a denylist rather than a list of protected paths.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
