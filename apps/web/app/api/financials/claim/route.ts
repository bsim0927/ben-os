import { claimSetupToken } from "@/lib/financials/simplefin";
import { isAuthorizedEmail } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Redeems a SimpleFIN Setup Token for the Access URL, once.
 *
 * The Access URL comes back in the response and is deliberately *not* written
 * anywhere: ADR 0002 keeps it out of the database because it is a Basic Auth
 * credential covering the whole Bridge subscription, not domain data. The
 * operator copies it into `SIMPLEFIN_ACCESS_URL` by hand, which is the only step
 * that makes it durable.
 *
 * A route rather than a script because the claim has to happen exactly once and
 * the result has to be read by a human — running it behind the same gate as the
 * rest of the console means no second credential path exists to get wrong.
 */
export async function POST(request: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Re-checked here rather than trusted from the proxy, for the reason the shell
  // layout re-checks: a routing mistake should cost a 401, not a bank credential.
  if (!user || !isAuthorizedEmail(user.email)) {
    return new Response(null, { status: 401 });
  }

  let setupToken: unknown;

  try {
    ({ setupToken } = await request.json());
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (typeof setupToken !== "string" || setupToken.trim() === "") {
    return Response.json({ error: "Expected { setupToken: string }." }, { status: 400 });
  }

  try {
    const accessUrl = await claimSetupToken(setupToken);

    return Response.json({
      accessUrl,
      next: "Set SIMPLEFIN_ACCESS_URL to this value. It is not stored — claiming again will fail.",
    });
  } catch (cause) {
    return Response.json(
      { error: cause instanceof Error ? cause.message : String(cause) },
      { status: 502 },
    );
  }
}
