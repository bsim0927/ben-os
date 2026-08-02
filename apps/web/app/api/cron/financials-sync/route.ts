import { authorizeCronRequest } from "@/lib/cron";
import { messageFor } from "@/lib/errors";
import { financialsPool, withAuthorizedSession } from "@/lib/financials/db";
import { createSimpleFinClient } from "@/lib/financials/simplefin";
import { syncSimpleFin } from "@/lib/financials/sync";

/** `pg` needs a real socket, which the edge runtime doesn't have. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The scheduled SimpleFIN poll. Invoked by Vercel Cron (see `vercel.json`),
 * which issues a GET carrying `Authorization: Bearer $CRON_SECRET`.
 *
 * The status code answers "did the poll run", not "was every bank healthy".
 * Per-connection failures come back inside the body with a 200, because a
 * broken institution is data the dashboard should show — retrying the whole poll
 * over it would burn the request budget without fixing anything.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = authorizeCronRequest(request);

  if (!auth.authorized) {
    return Response.json({ error: auth.reason }, { status: 401 });
  }

  const accessUrl = process.env.SIMPLEFIN_ACCESS_URL?.trim();

  // Names the two ways to be here, because they need opposite things: someone
  // who has never claimed a token needs the claim route, and someone who has
  // needs to notice the variable didn't reach this build.
  if (!accessUrl) {
    return Response.json(
      {
        error:
          "SIMPLEFIN_ACCESS_URL is not set on this deployment. If you already hold an Access " +
          "URL, add it to the Vercel project's environment variables for the Production " +
          "environment and redeploy — variables are read at build time, so a running " +
          "deployment keeps the ones it was built with. If you have not claimed one yet, " +
          "POST a Setup Token to /api/financials/claim first.",
      },
      { status: 503 },
    );
  }

  try {
    const result = await withAuthorizedSession(financialsPool(), (unitOfWork) =>
      syncSimpleFin({ client: createSimpleFinClient(accessUrl), unitOfWork }),
    );

    return Response.json(result);
  } catch (cause) {
    // Only reached when the poll itself failed — the fetch, or the database.
    // 502 rather than 500 so an alert can tell "SimpleFIN or Postgres is down"
    // apart from "this route is broken".
    return Response.json({ error: messageFor(cause) }, { status: 502 });
  }
}
