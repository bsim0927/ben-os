# The Holdings drill-down: what "current" means, and what a type grouping can honestly claim

**Status**: accepted

The `Financials / Holdings` page ([#28](https://github.com/bsim0927/ben-os/issues/28)) is the per-security view of an investment Account — the thing SimpleFIN cannot see and the reason SnapTrade is in this app at all ([ADR 0007](./0007-snaptrade-holdings-sync.md)). [ADR 0004](./0004-financials-holding-schema.md) settled the tables it reads; [ADR 0008](./0008-fidelity-balance-bridge.md) settled the surface it hangs off. Neither settled which rows of an append-only table count as "now", which is where all the difficulty in this page lives.

## Decisions

1. **Current holdings are the account's latest `as_of` reading — not the latest row per `(account, security)`.**

   `financials_holding` appends a fresh row per security on every sync ([ADR 0004](./0004-financials-holding-schema.md) decision 1), so "current" is a query. The two candidate queries look equivalent and are not:

   |                  | AMZN | GOOGL    | IONQ       |
   | ---------------- | ---- | -------- | ---------- |
   | Reading at 03:35 | ✓    | ✓ @ $10  | ✓          |
   | Reading at 13:54 | ✓    | ✓ @ $100 | — _(sold)_ |

   Latest-per-`(account, security)` returns IONQ's 03:35 row forever, because no later row will ever supersede a holding that no longer exists. The ledger would carry a phantom holding, and every total on the page would include it. Taking the account's newest reading whole has no such failure: a holding absent from it is absent because the brokerage no longer reports it.

   The unique key `(account_id, security_id, as_of)` means one row per security falls out of the reading rather than needing to be deduplicated on top of it.

2. **The maximum `as_of` is resolved per account, not globally.** The two Fidelity accounts sync as separate units of work ([ADR 0007](./0007-snaptrade-holdings-sync.md)), and their readings land seconds apart — `13:54:26` and `13:54:28` in the live data. A single global maximum would empty whichever account finished first.

3. **Two queries, not one bounded query.** The page asks for the latest `as_of` and then for exactly that reading. The obvious alternative — `order by as_of desc limit N` and pick the newest group in code — works until an account holds more than `N` holdings, at which point the newest snapshot is cut in half and every figure on the page is quietly short a holding. This is a different risk from the row bounds the overview carries (`SNAPSHOT_LIMIT`, `TRANSACTION_LIMIT`): those lose the _oldest_ history and say so, while this would lose part of the _current_ state and could not tell. The cost is one extra sequential round trip on a drill-down page.

4. **The unrealized gain is summed from the holdings that have both figures, not taken as `total value − total cost basis`.** The two agree whenever every holding is priced and costed, which is every reading this database holds so far. They part company on a holding that arrived without a cost basis — a transfer in, routinely — where the difference of the totals reports that holding's _entire value_ as profit. So the gain is measured over the holdings it can be measured for, and the page says how many that was whenever it is fewer than all of them. Each section's subtotal follows the same rule for the same reason.

5. **Grouping is `financials_security.security_type`, and the page says out loud that this is a wrapper and not an asset class.** A bond ETF is filed under ETFs here, not fixed income. The honest alternatives were both worse: no provider in this stack reports asset class, so inferring one would mean this app guessing at a security's contents from its ticker, and dropping the grouping entirely would lose the composition view that is half the reason for the page. A caption under the donut states the limitation, which is the whole of the fix — a reader who knows what the split is cannot be misled by it, and one who doesn't would have been misled by any of the three options.

   A `security_type` with no label keeps its raw value as its heading rather than being folded into "Other". The vocabulary is a check constraint away from growing, and a section headed `warrant` is a worse page than one headed "Warrants" but a far better one than holdings pooled silently under a heading that isn't theirs.

6. **Sorting is scoped to a section.** Clicking a column header reorders that section's holdings and nothing else ([#20](https://github.com/bsim0927/ben-os/issues/20) story 37). A global sort would dissolve the grouping, which is the layout. Gain is two adjacent sortable columns — dollars and percent — because they rank differently and a reader wants each: the largest loser by dollars is usually the biggest holding, and by percent usually is not.

7. **Which account is being read lives in the URL (`?account=`), not in component state.** A particular account's holdings can then be linked to, reloaded, and returned to with the browser's own back button, and the bridge panel that links here can name its account directly. An unknown or absent account falls back to the first rather than erroring — the page is reachable from a stale bookmark, and that does not deserve a dead end.

8. **Tax lots are read defensively, because their shape has never been observed.** SnapTrade gates lot detail behind its paid plans, so `financials_holding.tax_lots` is null on every row this database has ever written. What the parser models is therefore what a lot _is_ — some units, bought at some price, on some day — over the plausible spellings of those fields, and a payload it cannot read costs the holding its breakdown and nothing else. The raw jsonb stays in the row either way. When no holding in an account has lots, the page says why rather than showing an empty column; a page that silently showed no lots would look like one that had lost them.

9. **The code says Holding, and exactly one heading says Position.** `CONTEXT.md` names Holding as this codebase's word and lists Position as the one to avoid, so the derived type, the sort function, the counts and the section labels all use Holding. The single exception is the ledger's first column header, because [#28](https://github.com/bsim0927/ben-os/issues/28) enumerates the columns it wants and "Position" is the heading it picked. A spec that names a column has chosen the word on that column; everywhere the spec did not choose, the glossary does.

10. **The page says when a total was summed across more than one currency.** `sharedCurrency` drops the symbol when the holdings disagree, which is what the overview already does across accounts — but dropping a symbol makes a figure honest about its _units_ and not about its _arithmetic_, and the sum underneath has still added two currencies together. v1 has one currency, so the line should never appear; that is the reason to render it rather than to leave the case implicit.

## Consequences

- Every figure on this page is derived at read time from `quantity ×` a per-unit column ([ADR 0004](./0004-financials-holding-schema.md) decision 3), so there is nothing here to invalidate and nothing that can drift from the rows beneath it. The page is `force-dynamic` and holds no cache.
- The page is a read surface with no writes at all — unlike a Chase transaction, a Holding has no user-owned field. There is no picker, no form, and no mutation route.
- Decision 1 means a holding sold between two syncs disappears from this page the moment the next sync lands, with no record of it here. That is correct for a page headed "current holdings", and it is also the whole of what this page knows: reconstructing a holding's history is possible from the appended snapshots but is not something any surface does yet.
- Decision 3 makes this page's cost two sequential round trips against `financials_holding` plus one for the account list. Worth revisiting only if the page ever feels slow, and the fix would be a `DISTINCT ON` view rather than a bound.
