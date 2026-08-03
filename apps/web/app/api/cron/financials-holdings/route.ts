import { authorizeCronRequest } from "@/lib/cron";
import { messageFor } from "@/lib/errors";
import { financialsPool, withAuthorizedSession } from "@/lib/financials/db";
import { syncSnapTradeHoldings } from "@/lib/financials/holdings-sync";
import { createSnapTradeClient, readSnapTradeCredentials } from "@/lib/financials/snaptrade";

/** `pg` needs a real socket, which the edge runtime doesn't have. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The scheduled SnapTrade holdings pull. Invoked by Vercel Cron (see
 * `vercel.json`), which issues a GET carrying `Authorization: Bearer
 * $CRON_SECRET`.
 *
 * Once a day because that is what the free Daily plan gives: SnapTrade refreshes
 * each connection once daily and serves the cached reading in between, so a
 * second call the same day would return the same numbers and write nothing.
 *
 * The status code answers "did the job run", not "was every account healthy" —
 * the same split the SimpleFIN route makes, for the same reason. A brokerage
 * that failed comes back inside the body with a 200.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = authorizeCronRequest(request);

  if (!auth.authorized) {
    return Response.json({ error: auth.reason }, { status: 401 });
  }

  const lookup = readSnapTradeCredentials();

  if (!lookup.configured) {
    return Response.json({ error: lookup.reason }, { status: 503 });
  }

  try {
    const result = await withAuthorizedSession(financialsPool(), (unitOfWork) =>
      syncSnapTradeHoldings({ client: createSnapTradeClient(lookup.credentials), unitOfWork }),
    );

    return Response.json(result);
  } catch (cause) {
    // Only reached when the job itself failed — the database, or reading the
    // connection row. 502 rather than 500 so an alert can tell "SnapTrade or
    // Postgres is down" apart from "this route is broken".
    return Response.json({ error: messageFor(cause) }, { status: 502 });
  }
}
