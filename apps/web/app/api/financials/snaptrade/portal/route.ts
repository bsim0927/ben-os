import { isAuthorizedEmail } from "@/lib/auth";
import { messageFor } from "@/lib/errors";
import {
  createSnapTradeClient,
  readSnapTradeCredentials,
  SNAPTRADE_FIDELITY_SLUG,
} from "@/lib/financials/snaptrade";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Asks SnapTrade for a Connection Portal URL.
 *
 * The link flow cannot be automated and shouldn't be: the middle of it is
 * Fidelity's own login and the Fidelity Access consent screen, which exist
 * precisely so that a human agrees to the sharing. So this route's whole job is
 * to hand back a URL for that human to open, in the same spirit as
 * `/api/financials/claim` — a route rather than a script, because the result has
 * to be read by a person and the gate already exists.
 *
 * The portal URL is short-lived and single-use. Nothing stores it; the durable
 * thing that comes out the far side is the `authorizationId`, which
 * `/api/financials/snaptrade/link` records.
 */
export async function POST(request: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Re-checked here rather than trusted from the proxy, for the same reason the
  // claim route re-checks: a routing mistake should cost a 401, not an open door
  // to linking a brokerage account.
  if (!user || !isAuthorizedEmail(user.email)) {
    return new Response(null, { status: 401 });
  }

  const lookup = readSnapTradeCredentials();

  if (!lookup.configured) {
    return Response.json({ error: lookup.reason }, { status: 503 });
  }

  // A body is optional — the useful default is "open straight into Fidelity",
  // which is the only brokerage this app has a reason to link.
  const options = await request
    .json()
    .then((body: unknown) => (body === null || typeof body !== "object" ? {} : body))
    .catch(() => ({}));

  const { broker, customRedirect } = options as { broker?: unknown; customRedirect?: unknown };

  try {
    const redirectUri = await createSnapTradeClient(lookup.credentials).connectionPortalUrl({
      broker: typeof broker === "string" && broker !== "" ? broker : SNAPTRADE_FIDELITY_SLUG,
      ...(typeof customRedirect === "string" && customRedirect !== "" ? { customRedirect } : {}),
    });

    return Response.json({
      redirectUri,
      next:
        "Open this in a browser and complete the Fidelity login and Fidelity Access consent. " +
        "Then GET /api/financials/snaptrade/link to see which accounts SnapTrade now exposes, " +
        "and POST the links back to it.",
    });
  } catch (cause) {
    return Response.json({ error: messageFor(cause) }, { status: 502 });
  }
}
