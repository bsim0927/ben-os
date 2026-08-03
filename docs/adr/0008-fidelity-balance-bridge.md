# The Fidelity balance bridge: residual growth, and tagging a feed whose signs lie

**Status**: accepted

The balance bridge ([#26](https://github.com/bsim0927/ben-os/issues/26)) is what an investment Account gets where a depository one gets Flow — the other half of the `kind` split [ADR 0003](./0003-financials-multi-provider-and-account-kind.md) introduced. [ADR 0002](./0002-financials-schema.md) settled the tables; [ADR 0006](./0006-net-worth-derivation-and-charting.md) settled how balances become a series. Neither settled how to explain a balance that moved, which is the only thing the bridge is for.

The question is harder than it looks for one reason: **the largest term has no transaction behind it.** Nothing posts to `financials_transaction` when a holding rises in price. A bridge built by summing rows can therefore never reconcile to the balance it is explaining.

## Decisions

1. **Growth is the residual, and that is a correctness property rather than a shortcut.** The four middle segments are computed as

   ```
   growth = (end − start) − contributions − dividends − fees
   ```

   so that `start + contributions + dividends + growth + fees = end` holds by construction, for any input, including inputs the tagging gets wrong.

   This is the decision everything else leans on. The tagging below is a heuristic over free-text descriptions and _will_ meet a wording it does not know. Because growth absorbs whatever is left, an unrecognised row moves money between two segments and can never make the bridge disagree with the account. The failure mode is a mislabelled explanation, never a wrong total — which is the right way round, because a total that silently drifted from the real balance is the one error nobody would catch by looking.

2. **The two ends come from `financials_balance_snapshot`; the middle comes from `financials_transaction`.** The tables do different jobs and neither substitutes for the other. Only the snapshot table records what the account was actually worth, and per [ADR 0002](./0002-financials-schema.md) summing transactions drifts the moment a `balance-date` leads or lags the feed. Only the transaction table can say _why_.

3. **Activity is tagged from the description alone. The amount's sign is not consulted.**

   This is not a stylistic preference — the sign on this feed is wrong, and we have matched pairs proving it. SimpleFIN's stated convention is positive-in, negative-out, and the Chase rows honour it. Fidelity's do not:

   | Date       | Account       | Description                                 | Amount    |
   | ---------- | ------------- | ------------------------------------------- | --------- |
   | 2026-07-20 | CHASE COLLEGE | `FID BKG SVC LLC MONEYLINE …`               | −2,400.00 |
   | 2026-07-20 | Individual    | `Electronic Funds Transfer Received (Cash)` | −2,400.00 |

   Money left Chase and arrived at Fidelity, and **both legs post negative**. The same holds for the 2026-06-05 pair (−50, −100) and 2026-06-02 (−100). Worse, both legs of an _internal_ transfer post negative too: `TRANSFERRED TO VS XXX-XXX715-1 CURRENT CONTRIBUTION` at −500 in the Individual account, and `CASH CONTRIBUTION CURRENT YEAR` at −500 in the Roth on the same day. The sign does not even distinguish the two ends of one movement.

   So direction is read off the tag and magnitude off `|amount|`. Dividends are the one family whose sign happens to be right, and they are treated the same way for consistency rather than being a special case that works by luck.

4. **Outbound is checked before inbound, because the wording overlaps.** `TRANSFERRED TO … CURRENT CONTRIBUTION` is worded as a contribution because it _is_ one — to the other account. Matching `contribution` first would count money leaving as money arriving and put double its value on the wrong side of the bridge. `transferred to` therefore wins.

   Contributions are reported as a **net**: an outbound transfer is a negative contribution, not a segment of its own. The bridge's shape is fixed at six columns, and a `Withdrawals` column that is empty in almost every period would cost more than it explains.

5. **Internal reallocations are deliberately untagged.** A reinvestment, a buy, or a sell moves value _within_ the account and changes its worth by nothing. These are matched first and tagged `null`, so they land in no segment.

   Ignoring them is safe only because of decision 1: growth is derived from the balance delta rather than by summing the rows nobody tagged, so an untagged row contributes exactly nothing. A reinvested dividend posts twice — `DIVIDEND RECEIVED …` then `REINVESTMENT …` — and counting the second anywhere would take the first straight back out of growth.

6. **The window opens on the first snapshot day inside the period, and activity is counted strictly after it.** `start` is that day's _closing_ balance, so anything posted on it is already inside the figure; counting it again would take its value back out of growth. This is why narrowing the period does not merely trim the bridge — it moves which activity is inside the start balance and which is still to be explained.

7. **Fewer than two balance readings means no bridge, said out loud.** Balance history accrues one point per sync and cannot be backfilled ([ADR 0006](./0006-net-worth-derivation-and-charting.md)), so a freshly linked account genuinely has nothing to bridge between. The panel says so rather than drawing a bridge of zeroes, which would claim the balance had stood still — a claim about money, where the truth is a claim about the history we hold.

8. **No transaction list, and no category picker.** The bridge replaces the chronological list rather than sitting above one. A brokerage posts a dozen rows a month, most of them internal, which is a poor thing to read and a poor thing to categorize — and the tagging in decision 3 is automatic precisely so that no manual work is invited ([#20](https://github.com/bsim0927/ben-os/issues/20), story 32). `financials_transaction.category_id` stays untouched on these accounts.

9. **The waterfall's geometry is split from its markup, and the chart carries a text alternative.** `waterfallGeometry` in `lib/chart.ts` joins `areaChartGeometry` there; `components/bridge-panels.tsx` is markup. The SVG is `aria-hidden` with the same figures repeated as an `sr-only` table, matching [ADR 0006](./0006-net-worth-derivation-and-charting.md) decision 8 — the page-level test reads the bridge from exactly the numbers the bars are drawn from.

   The scale leaves headroom below the lowest running value. A bridge's values sit within a percent or two of each other (start 10,000, end 10,500), so a floor at the minimum flattens the Start and End columns to nothing while the changes they bracket take the whole box.

## Considered options

- **Summing transactions to produce growth** — impossible, not merely rejected: no row is written when a price moves. This is the constraint that makes decision 1 the only honest option.
- **Trusting the amount's sign and treating the tag as a label** — rejected per decision 3, on matched-pair evidence. It is the reading the SimpleFIN docs imply, and it is wrong on this feed in both directions.
- **Negating every Fidelity amount at sync time** — rejected. It fixes the transfer rows and breaks the dividend rows, which are already correct; and it would put a provider-specific lie into the stored data rather than into the one module that has to reason about it.
- **A `Withdrawals` column of its own** — rejected per decision 4. Honest, and empty in most periods.
- **Tagging on write, in a column** — rejected. The tagging is a heuristic that will be revised, and a stored tag would freeze whichever version of the rules happened to run at sync time. Deriving it at read time means an improved rule improves history too.
- **Letting the user correct a tag** — deferred, not rejected. It is the obvious next step if the descriptions turn out to be more varied than the current feed suggests, and decision 1 means a wrong tag is already survivable in the meantime.
- **Drawing the bridge from 0 rather than with headroom** — rejected per decision 9: truthful about the axis, and it renders every segment the bridge exists to show as a sliver.
