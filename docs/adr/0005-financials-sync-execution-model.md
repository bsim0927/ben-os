# Financials sync job: execution model

**Status**: accepted

The SimpleFIN sync ([#23](https://github.com/bsim0927/ben-os/issues/23)) is the first scheduled job this app has, and the first code that writes to module tables without a user in front of it. [ADR 0002](./0002-financials-schema.md) and [ADR 0003](./0003-financials-multi-provider-and-account-kind.md) settled what it stores; nothing settled how it runs. These are those decisions, made while building it and confirmed against a live SimpleFIN account.

## Decisions

1. **The job runs under RLS, as `authenticated` — not as the service role.** It connects with `DATABASE_URL` (a superuser connection) and immediately drops to the `authenticated` role, presenting the authorized email as a `request.jwt.claims` setting, so `is_authorized()` is evaluated on every statement it runs.

   Stated precisely, because it is easy to oversell: this is **not** a containment boundary. The connection string is already superuser-equivalent, and anyone holding it can simply decline to drop the role. What it buys is that the sync exercises the same policies as every other client, so a broken policy fails a test rather than going unnoticed — a consistency and testing property, not a security one.

2. **The role and the JWT claim are scoped to each transaction, not to the connection.** A pooler in transaction mode — which is what Supabase offers serverless clients, and what Vercel Cron is — assigns a backend connection per transaction. Session-level settings land on a backend that is released immediately, and the transaction that follows may run somewhere that never saw them: still superuser, still carrying `BYPASSRLS`, and **silently**. The writes succeed, the rows are correct, and the backstop is gone with no signal.

   Scoping them to the transaction makes the job behave identically under direct, session-pooler, and transaction-pooler connections. Choosing a connection string stops being a decision with a security consequence.

3. **One transaction per connection, not one per poll.** Postgres aborts an entire transaction on the first failed statement. A poll-wide transaction would let one institution's bad data roll back every other institution's writes — precisely the outcome per-connection error isolation exists to prevent, and the reason SimpleFIN reports failures per-connection in `errlist` at all.

4. **The sync never writes user-owned columns.** `financials_account.kind`, `financials_account.status` and `financials_transaction.category_id` are absent from every `on conflict do update` list. Each is set by the user — `kind` because no provider signals it (ADR 0003), `status` because closure is a decision the user records (ADR 0002), `category_id` because SimpleFIN has no categories — so a sync that wrote them would undo the user on every poll.

   Nothing in the sync ever sets `status = 'closed'`, and it deliberately does not infer closure from an account's absence: a broken connection returns no accounts either, and guessing wrong would drop a live account out of net worth.

5. **The first poll reaches back 45 days; every later poll, 5.** A 5-day overlap is the right steady-state reach — it is Bridge's recommendation, and re-fetching it is free because `(account_id, provider_transaction_id)` dedupes it. Applied to an empty database it would instead mean the account's history began five days ago, with no later poll ever going back for the rest.

   45 rather than the 90 a single call may carry: a 90-day poll succeeds, but Bridge answers it with `gen.api: Requested date range exceeds recommended range of 45 days. In the future, this may be capped.` — observed on the first live sync and documented nowhere. This is a cold start, not a backfill; deeper history would need a separate job walking successive windows against the same daily budget.

6. **Pending transactions are pruned only when the provider actually answered.** A pending transaction routinely re-posts under a different provider id, so a vanished one can never be matched to its replacement and would double-count forever. It is pruned when `last_synced_at` predates the current run — but only for accounts the poll returned, only within the window the poll asked about, and only when the account carried a `transactions` array at all. An empty array is the provider saying "nothing here"; an omitted one is the provider not answering, and absence of evidence is not evidence.

7. **Scheduled routes authenticate with a shared secret, not a session.** Routes under `/api/cron` are exempt from the app-layer session gate, because a scheduler has no Google session and never can. They compare a bearer token against `CRON_SECRET` in constant time instead, and **fail closed** when it is unset — an unconfigured secret must never read as "open".

8. **The sync's tests run against a real Postgres with RLS active.** This job's behaviour largely _is_ SQL — the upsert keys that make an overlapping poll idempotent, the predicate that prunes a vanished pending transaction, the policies that decide whether it may write at all. A fake query layer would assert only that the tests agree with themselves.

## Considered options

- **A service-role connection** — rejected per decision 1. Simpler, standard, and genuinely defensible in a single-user app; rejected because it costs the consistency property for a saving the transaction-scoped approach does not require.
- **Session-scoped role and claim, with `discard all` on release** — the original implementation, rejected per decision 2 once the pooling interaction was understood. It also made the reset load-bearing: a failed `discard all` would hand the next borrower a connection still wearing the role.
- **A single transaction for the whole poll** — rejected per decision 3. Atomic net-worth snapshots sound appealing, but a poll that dies halfway is far less likely than one institution being broken, which is the case `errlist` exists for.
- **Anchoring each poll to the last successful sync** instead of a fixed overlap — rejected: institutions post transactions days late, so a cursor would step straight over anything that appeared behind it.
- **An in-memory or fake query layer for tests** — rejected per decision 8.
- **Docker and `supabase start` for the test database** — rejected: it would make `pnpm test` fail for anyone without Docker running, and need a service container in CI besides. `embedded-postgres` ships real Postgres 17 binaries and starts in under a second with nothing installed.

## Consequences

- Any connection string Supabase offers is safe to configure, so setup instructions can say "copy whichever one it gives you" rather than explaining pooling modes.
- Another scheduled job means another route under `/api/cron` and another `vercel.json` entry; the secret gate is already shared and needs no per-job work.
- The **daily** cadence is a Vercel Hobby constraint, not a design preference — Hobby permits one cron run per day and rejects a more frequent expression at deploy time. Raising it means Vercel Pro or an external scheduler calling the same route; nothing in the job assumes a particular frequency beyond the overlap exceeding the gap between polls.
- Per-connection failures are reported in the response body with a 200, not as an HTTP error. A broken institution is data the dashboard should show, and retrying the whole poll over it would burn the request budget without fixing anything.
