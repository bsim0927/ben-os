import { authorizeApiRequest } from "@/lib/api-auth";
import { messageFor } from "@/lib/errors";
import { financialsPool, withAuthorizedSession } from "@/lib/financials/db";
import {
  createSnapTradeClient,
  readSnapTradeCredentials,
  type SnapTradeAccount,
} from "@/lib/financials/snaptrade";
import { createFinancialsStore } from "@/lib/financials/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Says which SnapTrade account *is* which account this app already has.
 *
 * The step that has no automatic answer. Both Fidelity accounts are already in
 * the database, synced from SimpleFIN under SimpleFIN's own ids; SnapTrade
 * reports the same two accounts under different ids and a differently-masked
 * number. Nothing in either provider's data says the two describe the same
 * account, and guessing — matching on a trailing four digits, say — would
 * silently file one account's holdings under another's if it were ever wrong.
 * So the mapping is asserted by the person who owns the accounts, once.
 *
 * `GET` shows both sides so the mapping can be read off; `POST` records it.
 * Recording it also sets `kind = 'investment'` on each account, because pointing
 * a brokerage connection at an account *is* the user saying it holds securities
 * — the assertion ADR 0003 makes user-owned.
 *
 * Both write through `DATABASE_URL` rather than the caller's PostgREST session,
 * so the SQL that defines the connection's `extra` shape lives in exactly one
 * place — the store the sync reads it back with.
 */

type LinkRequest = { links?: unknown };

export async function GET(): Promise<Response> {
  const gate = await authorizeApiRequest();

  if (gate) return gate;

  const lookup = readSnapTradeCredentials();

  if (!lookup.configured) {
    return Response.json({ error: lookup.reason }, { status: 503 });
  }

  try {
    const [snapTradeAccounts, local] = await Promise.all([
      createSnapTradeClient(lookup.credentials).listAccounts(),
      withAuthorizedSession(financialsPool(), (unitOfWork) =>
        unitOfWork(async (query) => {
          const store = createFinancialsStore(query);

          return {
            accounts: await store.listLinkableAccounts(),
            connection: await store.readSnapTradeConnection(),
          };
        }),
      ),
    ]);

    return Response.json({
      snapTradeAccounts: snapTradeAccounts.map(describe),
      accounts: local.accounts,
      links: local.connection?.accountLinks ?? {},
      next:
        'POST { "links": { "<snapTradeAccountId>": "<accountId>" } } to this route. ' +
        "Every SnapTrade account left out is one the holdings sync will not fetch.",
    });
  } catch (cause) {
    return Response.json({ error: messageFor(cause) }, { status: 502 });
  }
}

export async function POST(request: Request): Promise<Response> {
  const gate = await authorizeApiRequest();

  if (gate) return gate;

  const lookup = readSnapTradeCredentials();

  if (!lookup.configured) {
    return Response.json({ error: lookup.reason }, { status: 503 });
  }

  let body: LinkRequest;

  try {
    body = (await request.json()) as LinkRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const links = parseLinks(body.links);

  if (links === null) {
    return Response.json(
      { error: 'Expected { links: { "<snapTradeAccountId>": "<accountId>" } }.' },
      { status: 400 },
    );
  }

  if (links.length === 0) {
    return Response.json(
      { error: "No links given — there would be nothing to sync." },
      { status: 400 },
    );
  }

  let snapTradeAccounts: SnapTradeAccount[];

  try {
    snapTradeAccounts = await createSnapTradeClient(lookup.credentials).listAccounts();
  } catch (cause) {
    return Response.json({ error: messageFor(cause) }, { status: 502 });
  }

  // Checked against SnapTrade rather than taken on trust: an id that SnapTrade
  // does not recognise would be accepted happily and then fail on every
  // scheduled run, which is a much worse place to find out.
  const byId = new Map(snapTradeAccounts.map((account) => [account.id, account]));
  const unknown = links.filter(([snapTradeAccountId]) => !byId.has(snapTradeAccountId));

  if (unknown.length > 0) {
    return Response.json(
      {
        error: `SnapTrade does not report these accounts: ${unknown.map(([id]) => id).join(", ")}.`,
        snapTradeAccounts: snapTradeAccounts.map(describe),
      },
      { status: 400 },
    );
  }

  // The authorization is derived, not asked for. It is the durable identity of
  // the connection (ADR 0004 decision 7), and reading it off the accounts being
  // linked is strictly more reliable than a human copying it out of a redirect.
  const authorizations = new Set(
    links.map(([snapTradeAccountId]) => byId.get(snapTradeAccountId)?.brokerage_authorization),
  );

  if (authorizations.size !== 1 || authorizations.has(undefined)) {
    return Response.json(
      {
        error:
          "The accounts given belong to different SnapTrade connections (or none). " +
          "Link one connection at a time — its authorization is what the sync stores.",
      },
      { status: 400 },
    );
  }

  const authorizationId = [...authorizations][0] as string;

  try {
    const result = await withAuthorizedSession(financialsPool(), (unitOfWork) =>
      unitOfWork(async (query) => {
        const store = createFinancialsStore(query);

        // One transaction: a half-recorded mapping — connection stored, `kind`
        // unset, or the reverse — is a state nothing later would notice.
        const missing: string[] = [];

        for (const [, accountId] of links) {
          if (!(await store.markAccountInvestment(accountId))) missing.push(accountId);
        }

        if (missing.length > 0) {
          throw new UnknownAccountError(missing);
        }

        await store.upsertSnapTradeConnection({
          authorizationId,
          name: byId.get(links[0][0])?.institution_name ?? "SnapTrade",
          accountLinks: Object.fromEntries(links),
        });

        return { authorizationId, links: Object.fromEntries(links) };
      }),
    );

    return Response.json({
      ...result,
      next: "The next scheduled run of /api/cron/financials-holdings will sync these accounts.",
    });
  } catch (cause) {
    if (cause instanceof UnknownAccountError) {
      return Response.json({ error: cause.message }, { status: 400 });
    }

    return Response.json({ error: messageFor(cause) }, { status: 502 });
  }
}

class UnknownAccountError extends Error {
  constructor(accountIds: string[]) {
    super(`No financials_account rows with these ids: ${accountIds.join(", ")}.`);
    this.name = "UnknownAccountError";
  }
}

/** `null` for a shape that isn't a link map; entries otherwise. */
function parseLinks(value: unknown): [string, string][] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;

  const entries = Object.entries(value as Record<string, unknown>);

  if (entries.some(([, accountId]) => typeof accountId !== "string" || accountId.trim() === "")) {
    return null;
  }

  return entries.map(([snapTradeAccountId, accountId]) => [
    snapTradeAccountId,
    (accountId as string).trim(),
  ]);
}

/** Just enough of a SnapTrade account to recognise it by, for a human reading JSON. */
function describe(account: SnapTradeAccount) {
  return {
    id: account.id,
    name: account.name ?? null,
    number: account.number ?? null,
    institutionName: account.institution_name ?? null,
    brokerageAuthorization: account.brokerage_authorization ?? null,
    holdingsLastSyncedAt: account.sync_status?.holdings?.last_successful_sync ?? null,
  };
}
