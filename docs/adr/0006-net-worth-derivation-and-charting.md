# Net worth: how it is derived, and how it is charted

**Status**: accepted

The net worth chart ([#24](https://github.com/bsim0927/ben-os/issues/24)) is the Financials module's hero, and the first surface that turns synced rows into a figure the user reads as fact. [ADR 0002](./0002-financials-schema.md) settled that `financials_balance_snapshot` exists and that net worth is built from it rather than by summing transactions; it did not settle what "net worth on a given day" means when the snapshots are uneven, nor how the chart gets drawn. These are those decisions.

## Decisions

1. **Net worth is derived at read time and never stored.** There is no net-worth column, table, or cached total. The series is computed from `financials_balance_snapshot` on each request by `lib/financials/net-worth.ts`, and the headline, the chart, and the equation strip are three renderings of that one series.

   This is what makes the equation strip's `Chase + Fidelity = Net worth` claim true rather than merely plausible: the strip's terms are read off the same point the chart ends on, so they cannot drift from it. A stored total would introduce a second source that has to be kept in step, and the first time it wasn't, the page would be confidently wrong.

2. **The unit of the series is a UTC day, not a snapshot.** Accounts are polled together but each reports its own `balance-date`, so a point-per-snapshot series steps twice a day — once per institution — and reads as volatility that isn't there. Each day with at least one snapshot becomes one point; where an account was polled twice in a day, its last reading of that day wins.

   UTC rather than the viewer's zone, matching the sync's own timestamps. A local-zone reinterpretation would shuffle snapshots across the day boundary and move points on the chart for no reason.

3. **Only days that have a snapshot become points.** Gaps are not filled with synthetic rows. A missed poll renders as a longer straight segment between the readings either side, because the x-axis is spaced by elapsed time rather than by position in the list. Inventing a row for a day nobody asked the bank about would put data in the chart that the database does not have.

4. **An account's last balance carries forward across a day it did not report — unless it is closed.** A poll that failed for one institution must not read as that account dropping to zero; carrying its last balance forward is the honest reading of "we did not hear otherwise."

   That reasoning expires at closure. A closed account's balance is not stale, it is _gone_, and carrying it forward would inflate net worth indefinitely. So a closed account contributes on every day up to and including its last snapshot — preserving the past figures that [ADR 0002](./0002-financials-schema.md)'s soft closure exists to protect — and nothing after it. Symmetrically, an account contributes nothing to days before its first snapshot.

5. **The range toggle windows a series the browser already holds.** The page sends the whole series once and `1M`/`3M`/`1Y`/`ALL` filter it client-side, so a zoom control costs no round trip. The reference date is passed from the server rather than read from the client's clock, so both renders agree on where a window starts — `new Date()` in the component would be a hydration mismatch waiting for midnight.

   Ranges are plain day counts (30/90/365), not calendar months. Predictable, and the axis is in days anyway.

6. **The headline and the equation strip read off the full series; only the chart reads off the window.** Every non-empty window ends on the latest point, so in normal operation the two are the same figure. They come apart when a window is empty — sync broken for longer than the range, or an account newer than it — and reading the headline off the window there would print a confident `$0.00` for money that is still in the account. So the figures track the latest snapshot that exists, and the chart says it has nothing to draw for that range.

   What the toggle changes is the chart's extent and the reported change across it — otherwise the control would be pure zoom with nothing to say.

   Terms are rounded to cents before they are summed, so the strip's terms add up to the total printed beside them. An equation that is visibly off by a penny discredits the number it is there to explain.

7. **The chart is hand-rolled SVG, with the geometry split from the markup.** `lib/chart.ts` turns data into paths, gridlines, and an endpoint; `components/area-chart.tsx` is only markup. Everything hard is arithmetic — the y scale rounding outward to readable gridline values, the flat-series case that would otherwise divide by zero, points spaced by x value — and it is all testable without a DOM.

8. **The chart carries a visually-hidden data table as its text alternative.** The SVG is `aria-hidden`; the same points are repeated as a `sr-only` table. A chart that exists only as a path is unreadable to a screen reader and unassertable in a test, and one honest text alternative fixes both — the page-level test reads its figures from exactly the numbers the path is drawn from.

9. **The snapshot read is bounded at 1000 rows, newest first.** Roughly a year and a half of twice-daily polling. Newest-first so the bound eats the oldest history rather than the current balance — a chart missing its left edge is visibly short, a chart missing its right edge is silently wrong.

## Considered options

- **A stored or materialised net-worth total** — rejected per decision 1. It would spare the per-request arithmetic, which at this app's scale is microseconds, and buy a whole class of drift bug.
- **A `financials_net_worth_daily` view or rollup table** — deferred, not rejected. It is the right answer to decision 9's bound when the bound starts to bite; building it now would be schema work ahead of the need.
- **Filling every day between the first and last snapshot** — rejected per decision 3. It draws a smoother chart, at the cost of a flat line during an outage being indistinguishable from a flat line during a quiet week.
- **Dropping closed accounts from the series entirely** — rejected per decision 4: it would rewrite history, which is precisely what soft closure exists to prevent.
- **Carrying a closed account forward like any other** — rejected per decision 4: it inflates net worth forever.
- **A server round trip per range change** (`?range=` search param) — rejected per decision 5. Simpler, and it makes a zoom control feel like a page load for data already in the browser.
- **A charting library** (Recharts, visx, Chart.js) — rejected per decision 7. The one chart this app needs is an area with gridlines and an emphasised endpoint; the dependency and its bundle cost more than the geometry does.
- **Asserting the chart through the SVG path string** — rejected per decision 8. It couples the test to pixel arithmetic that the geometry tests already cover, and asserts nothing about whether the figures are right.

## Consequences

- Later Financials surfaces — the Chase flow view's context sparkline, the Fidelity balance bridge — have a chart seam to build on, and `lib/chart.ts` is domain-free enough to serve them.
- Mixed-currency accounts render totals without a currency symbol rather than stamping a sum with a currency it does not mean. Summing across currencies is still wrong; v1 has one, and this is the honest placeholder until it doesn't.
- The raw-data view moved off the module root to `/financials/raw` to make room for the overview, and stays linked from it.
- **The page-level test stubs the Supabase client rather than seeding the real Postgres**, unlike the sync tests. This is a gap, and a known one: the sync talks to Postgres over `pg`, which the test harness can start, while a page reads through PostgREST over HTTP, which it cannot. Closing it means standing up PostgREST in the harness — worth doing once a second module has pages, not for this one. Until then the read path (`order`/`limit`) and this page's RLS behaviour are unasserted, and the RLS backstop is covered only by the sync and guard suites.
