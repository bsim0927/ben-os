# SnapTrade holdings sync: linking, and what `as_of` means

**Status**: accepted

[ADR 0004](./0004-financials-holding-schema.md) settled the shape of
`financials_security` and `financials_holding`. Building the sync that fills them
([#27](https://github.com/bsim0927/ben-os/issues/27)) turned up two things it did
not settle, both of which change what the tables mean rather than only how the
job runs. [ADR 0005](./0005-financials-sync-execution-model.md) covers everything
the two syncs share — RLS, transaction scoping, the cron secret — and is not
restated here.

## Decisions

1. **The holdings sync attaches to accounts that already exist. It never creates
   one.**

   Both Fidelity accounts are already `financials_account` rows, synced from
   SimpleFIN, already carrying balances that net worth is derived from. SnapTrade
   reports the same two accounts. A sync that upserted them the way the SimpleFIN
   sync does would produce a second row per account, and net worth — a sum over
   accounts — would count Fidelity twice. Roughly $5,900 of invented money, from
   a job whose own writes were all individually correct.

   So this sync does not discover accounts, does not write
   `financials_balance_snapshot`, and does not touch `financials_account` outside
   the link step below. It contributes exactly the thing SimpleFIN cannot see:
   the per-security positions inside an account it is told about.

2. **Which SnapTrade account is which local account is asserted by the user, once,
   and stored on the connection.**

   Nothing in either provider's data says a SnapTrade account and a SimpleFIN
   account describe the same real account. The ids are unrelated, and the account
   numbers are masked differently. Matching them automatically — on the trailing
   four digits, say — is the sort of heuristic that works until it doesn't, and
   its failure mode is filing one account's holdings under another's, silently.

   The mapping is therefore user-owned data, the same category as
   `financials_account.kind` and for the same reason ADR 0003 gave: no provider
   signals it. It lives in `financials_connection.extra.accounts` on the
   SnapTrade connection — `{ "<snaptrade account id>": "<financials_account.id>" }`
   — beside the `authorization_id` ADR 0004 decision 7 already put there.
   `/api/financials/snaptrade/link` is where a human states it, and stating it
   also sets `kind = 'investment'`: pointing a brokerage connection at an account
   _is_ the user saying it holds securities.

3. **`as_of` is the provider's reading time, not the run's.**

   ADR 0004 decision 5 wants `(account_id, security_id, as_of)` to make a retried
   sync idempotent. Stamping `now()` does not deliver that — a retry a second
   later carries a different `as_of`, misses the unique constraint entirely, and
   writes a second snapshot of identical numbers. The key only works if `as_of`
   is a property of the _reading_.

   SnapTrade's `sync_status.holdings.last_successful_sync` is exactly that: when
   it last refreshed the connection from the brokerage. On the free Daily plan
   that moves once a day, so every run between refreshes sees the same value,
   collides on every row, and writes nothing. It is also simply more truthful —
   `as_of` should say when the position was real, not when this app got around to
   asking.

   Where the provider reports no timestamp, the run's own instant is used and
   that idempotency is lost for those rows. A reading with an approximate
   timestamp is worth more than no reading.

4. **The unit of work is an account, not a connection.** SnapTrade serves
   holdings per account, so a broken account is one failed HTTP call among
   several. One transaction and one `try` each, so a brokerage that answers for
   the Individual account and not the Roth still gets the Individual written —
   ADR 0005 decision 3's reasoning, applied one level down, because that is where
   the failures land here.

5. **The client is hand-written, not `snaptrade-typescript-sdk`.** Same call
   `simplefin.ts` makes: three endpoints, and a `fetch`-shaped client is one the
   tests can stub at the wire. The exception is request signing, which is not
   small enough to guess — so `signaturePayload` is a deliberate
   reimplementation of the official SDK's own signing function, pinned by a test
   against the canonical example SnapTrade publishes for its mock-signature
   endpoint.

## Considered options

- **Letting SnapTrade own the Fidelity accounts and SimpleFIN skip them** —
  rejected. SimpleFIN's poll returns the whole subscription in one call and would
  have to learn to exclude accounts, and Fidelity's balance history would restart
  from whenever SnapTrade was linked.
- **Matching accounts on trailing digits of the account number** — rejected per
  decision 2. Two accounts sharing a last four is not exotic, and the failure is
  silent.
- **A `financials_account_link` table** — the honest model for "one real account,
  observed through two providers", and worth revisiting if a third provider ever
  overlaps. Rejected for now as a table with two rows in it, where a jsonb key on
  a row that already exists says the same thing.
- **Storing the SnapTrade account id in `financials_account.extra`** — rejected:
  the SimpleFIN sync replaces `extra` wholesale on every poll, so the link would
  survive until the next morning.
- **`as_of = now()`** — rejected per decision 3; it defeats the constraint that
  exists to make retries free.
- **A webhook (`ACCOUNT_HOLDINGS_UPDATED`) instead of a schedule** — deferred,
  not rejected. SnapTrade recommends it over polling and it would make the sync
  fire when the data actually changes. It needs a public unauthenticated endpoint
  with its own signature verification, which is a larger surface than a second
  cron entry, and daily polling costs nothing on the Daily plan.

## Consequences

- The holdings sync does nothing at all until a human has been through the
  Connection Portal _and_ posted the account links. `not-linked` is reported as a
  resting state with a 200, not an error — otherwise every scheduled run before
  then looks like a broken job.
- `/api/cron/financials-holdings` is the **second** cron entry, which is Vercel
  Hobby's limit. A third scheduled job needs Vercel Pro or an external scheduler
  calling the route with `CRON_SECRET`.
- `security_type` is this app's vocabulary mapped from SnapTrade's `type.code`,
  and SnapTrade publishes no exhaustive list of those codes. Unmapped codes land
  as `other` with the raw code kept in `financials_security.extra`, so a wrong or
  missing mapping stays visible and is one migration from being fixed.
- Quantities and prices arrive as JSON numbers, so they are through a double
  before this app sees them; `numeric` columns stop anything _further_ being
  lost, but cannot recover precision the wire format never carried.
