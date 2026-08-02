# Research: Brokerage Holdings Data Provider

## Question

SimpleFIN (via SimpleFIN Bridge — see `docs/research/simplefin-bridge-api.md`) gives this app
free, read-only bank/checking balances and transactions, but its `Account` object is flat: one
`balance` number, identical shape for every account type, no per-security positions. The app
needs real brokerage holdings for a Fidelity account — per-security quantity, cost basis, and
market value. That requires a second data provider. Which one, and what does integrating it
actually look like: auth flow, data shape, sync model, rate limits, cost — for a single-user
hobby app connecting one or two of *its own* accounts, not a business with customers?

## Findings

### 1. Plaid Investments

**What it is.** A product on top of Plaid's standard Item/Link model, specifically for
brokerage/retirement accounts: holdings, securities, and up to 24 months of investment
transactions. Source:
[plaid.com/docs/investments](https://plaid.com/docs/investments/),
[plaid.com/docs/api/products/investments](https://plaid.com/docs/api/products/investments/).

**Auth flow (Plaid Link — OAuth-style, but Plaid's own token model, not raw OAuth):**

1. Backend calls `/link/token/create` with `investments` in the `products` array, scoped to your
   `client_id`/`secret` for the target environment (Sandbox / Trial / Production).
2. Frontend initializes **Plaid Link** (a hosted, Plaid-built UI widget) with that `link_token`.
   The user picks their institution and authenticates directly with the institution (credentials
   never touch your app) — for OAuth-institution logins this includes a redirect back into Link.
3. Link returns a short-lived `public_token` to the frontend.
4. Backend exchanges `public_token` → long-lived `access_token` via
   `/item/public_token/exchange`. The `access_token` (plus the resulting `item_id`) is what you
   store and use for every subsequent `/investments/*` call — no interactive re-auth needed
   unless the Item enters an error state (`ITEM_LOGIN_REQUIRED`), which requires sending the user
   back through Link in "update mode."

Source: [plaid.com/docs/api/products/investments](https://plaid.com/docs/api/products/investments/).

**Data shape.**

`POST /investments/holdings/get` returns `accounts`, `holdings`, `securities`:

*Holding object:*

| Field | Notes |
|---|---|
| `account_id` | which Plaid account the holding belongs to |
| `security_id` | joins to the `securities` array |
| `institution_price` / `institution_price_as_of` / `institution_price_datetime` | last price the institution reported, and when |
| `institution_value` | market value of the holding as reported by the institution |
| `cost_basis` | total cost basis for the holding |
| `quantity` | units held |
| `iso_currency_code` / `unofficial_currency_code` | ISO 4217, or institution-specific code |
| `vested_quantity` / `vested_value` | for equity-comp accounts |
| `tax_lots` | array of per-lot acquisition data (see below) |

*Tax lot object (per-lot cost basis):* `institution_lot_id`, `original_purchase_datetime`,
`quantity`, `purchase_price`, `cost_basis`, `current_value`, `position_type` (long/short).

*Security object:* `security_id`, `isin`, `cusip`, `sedol` (deprecated), `institution_security_id`,
`institution_id`, `name`, `ticker_symbol`, `is_cash_equivalent`, `type` (cash / cryptocurrency /
derivative / equity / etf / fixed income / loan / mutual fund / other), `subtype`, `close_price` /
`close_price_as_of` / `close_price_datetime`, `iso_currency_code`, `market_identifier_code`
(ISO 10383 MIC), `sector`, `industry`, `cfi_code`, `figi`, plus nested `option_contract` and
`fixed_income` detail objects for those security types.

`POST /investments/transactions/get` returns `InvestmentTransaction` objects: `investment_transaction_id`,
`account_id`, `security_id`, `date`, `datetime`, `description`, `quantity` (positive = buy,
negative = sell), `amount` (positive when cash is debited), `price`, `fees`, `type` (buy / sell /
cancel / cash / fee / transfer), `subtype`.

Source: [plaid.com/docs/api/products/investments](https://plaid.com/docs/api/products/investments/).

**Sync model.** Not a webhook-push-only system — it's poll-then-notify. Plaid refreshes
investment data on its own schedule ("typically...overnight, after market hours" per Plaid's
docs) and fires webhooks when new data is ready: `HOLDINGS: DEFAULT_UPDATE` ("new holdings
available") and `INVESTMENTS_TRANSACTIONS: DEFAULT_UPDATE` / `HISTORICAL_UPDATE`. Your app listens
for the webhook, then calls `/investments/holdings/get` to pull the actual data — there's no
sub-daily real-time refresh-on-demand for Investments the way some other Plaid products offer.
Source: [plaid.com/docs/api/products/investments](https://plaid.com/docs/api/products/investments/).

**Rate limits.** In Production: `/investments/holdings/get` — 15 requests/min per Item, 2,000/min
per client; `/investments/transactions/get` — 30/min per Item, 20,000/min per client. (Sandbox is
higher: 100/min per Item, 1,000/min per client for both.) Far more headroom than a single-account
hobby app would ever need. Source: Plaid rate-limit documentation (aggregated from
[plaid.com/docs/errors/rate-limit-exceeded](https://plaid.com/docs/errors/rate-limit-exceeded/)).

**Cost and production-access process.** Plaid does not publish per-product dollar figures on its
public pricing page — [plaid.com/pricing](https://plaid.com/pricing/) states pricing is one-time
fees, per-connected-account subscription fees, or per-successful-API-call fees depending on
product, and directs you to sales/"Plaid Billing" for real numbers. What's publicly documented:

- **Sandbox** (fake data) is free and unlimited.
- **Trial plan** (new as of ~April 15, 2026, for US/Canada teams created on or after that date):
  free, real production data, up to **10 Production Items**, access to most OAuth institutions,
  *before* going through full Production approval. This directly targets the "I just want to
  connect my own account" case that didn't exist cleanly before.
- **Limited Production** (older teams, pre-April-2026): free but capped, meant as a bridge to
  paid Production.
- Full **Production** access still requires an application-profile / company-profile review, and
  for OAuth institutions a security questionnaire — Plaid's own support content acknowledges "the
  current onboarding flow is not designed for personal use cases," though they say they're
  revamping it.
- Consumers/end-users are never charged directly by Plaid regardless of tier.

Source: [plaid.com/pricing](https://plaid.com/pricing/), Plaid Customer Help Center — "Can I use
Plaid for free?" and "How are Sandbox, Production, Trial plan, and Limited Production different?"
(support.plaid.com), Plaid launch-checklist and production-access docs.

**The disqualifying fact: Plaid does not currently support Fidelity.** Fidelity built its own
OAuth-based data-sharing platform, **Fidelity Access** (announced ~2018, running through the
**Akoya** data-sharing hub that Fidelity spun out in 2020), and made it the *exclusive* channel
for third-party data sharing on Fidelity accounts. Multiple independent sources (Infinite Kind /
Moneydance support desk, October 2023: *"Unfortunately, Fidelity no longer support[s] Plaid"* —
users attempting to link get "Connectivity not supported. Plaid does not support connections
between Fidelity and Moneydance") confirm Plaid and Fidelity's direct relationship was cut when
Fidelity moved to Akoya-only distribution, because a number of aggregators (reportedly including
Plaid) declined to sign Akoya's terms. I found **no evidence this has been reversed** as of
research date (Aug 2026) — Plaid's recent public data-access-agreement announcements are with
JPMorganChase (renewed Sept 2025), PNC (2024, itself via Akoya as PNC's chosen provider), and TD —
none mention Fidelity. This means Plaid Investments, however good its data shape and rate limits
are, **cannot currently connect the Fidelity account this app needs**, independent of pricing or
approval-process friction.
Sources: [Infinite Kind support thread, Oct 2023](https://infinitekind.tenderapp.com/discussions/online-banking/1247360-fidelity-and-plaid),
[Akoya — "Fidelity data-sharing hub aims to end screen scraping"](https://akoya.com/news/fidelity-data-sharing-hub-aims-to-end-screen-scraping),
[JPMorganChase/Plaid renewal, Sept 2025](https://www.jpmorganchase.com/newsroom/press-releases/2025/jpmc-plaid-renewed-data-access-agreement).

### 2. SnapTrade

**What it is.** A brokerage-account-connectivity API positioned for both commercial fintech apps
*and* individual/personal use — it explicitly ships a "Personal" integration mode distinct from
"Commercial," aimed at exactly this app's situation (the account owner and the API consumer are
the same person). Source:
[docs.snaptrade.com](https://docs.snaptrade.com/),
[docs.snaptrade.com/docs/personal-vs-commercial](https://docs.snaptrade.com/docs/personal-vs-commercial).

**Fidelity support — and how.** SnapTrade explicitly lists Fidelity as a supported brokerage
([snaptrade.com/brokerage-integrations/fidelity-api](https://snaptrade.com/brokerage-integrations/fidelity-api)),
connected via **OAuth**, and the connection flow the page documents is: accept SnapTrade's terms
→ redirect to Fidelity's site → log into Fidelity → **agree to the Fidelity Access User
Agreement** → select accounts to share. The explicit mention of the "Fidelity Access User
Agreement" confirms SnapTrade is connecting through Fidelity's own official Fidelity
Access/Akoya-style data-sharing channel, as an approved recipient — this is the same official
mechanism Fidelity uses for all third-party sharing, just with a partner (SnapTrade) that
actually has a signed agreement, unlike Plaid. Trading is *not* available through this Fidelity
connection (data/read access only), which is fine for this app's holdings-only use case.
SnapTrade's FAQ separately notes that a short list of brokers — **Alpaca, Tradier, Tradestation,
Questrade** (and Fidelity is mentioned as needing "special setup" in the same context) — require
extra application steps to enable; this is broker-imposed, not a SnapTrade production-approval
gate on the developer.

**Auth flow (Personal mode).**

1. One-time setup: create a **Personal `clientId` + `consumerKey`** pair in the SnapTrade
   dashboard — every account gets exactly one free Personal key pair, no approval workflow.
2. No `registerUser`/`userSecret` step in Personal mode — the docs are explicit: *"Personal
   customers... [use] a Personal client ID and consumer key,"* requests are signed with the
   `consumerKey` directly, and you **omit `userId`/`userSecret`** entirely; SnapTrade resolves
   identity from the API key itself.
3. Backend calls the login/"Generate Connection Portal URL" endpoint, gets back a `redirectURI`.
4. User opens that URL (SnapTrade's hosted **Connection Portal**), picks Fidelity, and goes
   through Fidelity's own OAuth login + Fidelity Access consent screen (per above).
5. On success, SnapTrade redirects back to your app (`status=SUCCESS&connection_id=<id>` via
   query string, or a `postMessage` with `{status: 'SUCCESS', authorizationId}` if embedded) — or
   `status=ERROR&error_code=...`.
6. Backend stores the resulting `authorizationId` (the persistent connection/brokerage-authorization
   ID) and uses it for all subsequent `/accounts`, `/holdings`, `/positions` calls, signed with
   the same Personal `consumerKey`. Access tokens underneath "typically expire after a few weeks"
   per-brokerage and may require the user to re-auth through the portal occasionally (this is a
   Fidelity/brokerage-side token lifetime, not something SnapTrade lets you control).

Source: [docs.snaptrade.com/docs/personal-vs-commercial](https://docs.snaptrade.com/docs/personal-vs-commercial),
[docs.snaptrade.com/docs/implement-connection-portal](https://docs.snaptrade.com/docs/implement-connection-portal),
[docs.snaptrade.com/docs/connections](https://docs.snaptrade.com/docs/connections).

**Data shape.**

`GET` "List account holdings" returns nested `Account`, `Balance`, and `Position[]` objects:

*Account:* `id` (SnapTrade UUID), `brokerage_authorization` (connection UUID),
`name`, `number` (may be masked), `institution_account_id` (stable ID from the brokerage),
`institution_name`, `created_date`, `funding_date`, `opening_date`, `sync_status` (see below),
`balance` (total account market value), `status` (`open` / `closed` / `archived` / null),
`raw_type`, `account_category` (`INVESTMENT` / `DEPOSIT` / `LOC`), `is_paper` (simulated trading
account flag).

*Balance:* `currency` (`{id, code, name}` — ISO 4217 `code`), `cash`, `buying_power` (margin
accounts).

*Position:* `symbol` (nested security/instrument object — ticker, name, type, exchange, etc.),
`units` (share count; negative = short; fractional allowed), `price` (last known market price),
`open_pnl`, `average_purchase_price` (cost basis per share — **note: per-share average, not a
lot-level breakdown by default**), `currency`, `cash_equivalent` (bool), and an optional
`tax_lots[]` array (purchase date, quantity, purchase price, cost basis, current value, position
type, lot ID) when the brokerage/endpoint exposes lot-level detail.

Source: [docs.snaptrade.com/reference — List account holdings](https://docs.snaptrade.com/reference/Account%20Information/AccountInformation_getUserHoldings),
[docs.snaptrade.com/reference — List account positions](https://docs.snaptrade.com/reference/Account%20Information/AccountInformation_getUserAccountPositions).

**Sync model.** Two plan tiers control this directly:

- **Daily plan** (read-only): SnapTrade auto-syncs each connection **once per day** (time not
  fixed/guaranteed, but "guaranteed once per day" per the FAQ). Holdings/transactions are cached
  between syncs. An on-demand **Refresh connection** endpoint exists for forcing an intraday
  update, but the docs flag "additional charges may apply" per call, and recommend waiting for
  the `ACCOUNT_HOLDINGS_UPDATED` / `ACCOUNT_TRANSACTIONS_UPDATED` webhook rather than polling.
- **Real-time plan**: holdings endpoints fetch straight from the brokerage on every call (still
  not a push/streaming model — it's synchronous on-request), with a documented courtesy
  recommendation of "no more often than once every 10 minutes per account."

`sync_status` on the Account object exposes `initialSyncCompleted`/`lastSuccessfulSync` timestamps
for both holdings and transactions independently, so the app can detect staleness without
guessing.

Source: [docs.snaptrade.com/docs/syncing](https://docs.snaptrade.com/docs/syncing),
[docs.snaptrade.com/docs/realtime-data](https://docs.snaptrade.com/docs/realtime-data).

**Rate limits.** Two layers, both apply, stricter wins: **250 req/min per `clientId`** (all
endpoints combined) and, for Personal users specifically, **10 req/min per account** on a set of
~9 account-scoped endpoints (holdings, balances, positions, orders, activities, quotes, etc.).
Response headers (`X-RateLimit-*` / `X-RateLimit-Account-*`) expose remaining quota. For a
single-user app polling one or two accounts on a schedule, this is not a practical constraint.
Source: [docs.snaptrade.com/docs/ratelimiting](https://docs.snaptrade.com/docs/ratelimiting).

**Cost.**

- **Personal API key: completely free**, no stated cap on number of brokerage connections for
  Personal use, and explicitly **no business/production-approval process** — the docs frame
  Personal mode as "for your own brokerage accounts," in contrast to Commercial mode's
  per-connected-user billing (~$2/user/month real-time or ~$1/user/month daily, plus $0.05/manual
  refresh — irrelevant here since Personal isn't billed this way).
- The general "free developer tier" (separate from Personal) is capped at 5 brokerage connections
  with unlimited users, real-time data, and trading — but Personal mode is the better fit here
  since it's the officially sanctioned path for a solo user connecting their own accounts, is
  unambiguously free, and doesn't carry the Commercial per-user billing model at all.

Source: [docs.snaptrade.com/docs/billing](https://docs.snaptrade.com/docs/billing),
[docs.snaptrade.com/docs/personal-vs-commercial](https://docs.snaptrade.com/docs/personal-vs-commercial),
[snaptrade.com/pricing](https://snaptrade.com/pricing).

**SDK fit for this stack.** Official TypeScript/Node SDK, `snaptrade-typescript-sdk` on npm
(source: [github.com/passiv/snaptrade-sdks](https://github.com/passiv/snaptrade-sdks) — "passiv"
is SnapTrade's parent company), initialized with `clientId`/`consumerKey` — drops straight into a
Next.js/TypeScript backend (API route or server action) with no additional runtime.

### 3. Fidelity's own developer/retail API

**There is no public Fidelity developer program for individual/retail programmatic account
access.** What exists instead:

- **Fidelity Access** (built ~2018, on **Akoya** rails since Akoya's 2020 spin-out from Fidelity):
  an OAuth 2.0 / OpenID Connect data-sharing platform, but it is **B2B** — Fidelity (via Akoya)
  signs data-sharing agreements with aggregator companies (Plaid, SnapTrade, Finicity, Yodlee-class
  players), not with individual developers. There is no self-serve signup for a lone developer to
  get direct API credentials to their own Fidelity account. Source:
  [Fidelity Access & Data Security](https://www.fidelity.com/security/fidelity-access-data-security),
  [Fidelity newsroom — "Update on Fidelity's Secure Data Sharing Efforts"](https://newsroom.fidelity.com/pressreleases/update-on-fidelity-s-secure-data-sharing-efforts/s/7a30c2e4-f070-4396-b04c-b773678d59f9),
  [Akoya — Fidelity data-sharing hub](https://akoya.com/news/fidelity-data-sharing-hub-aims-to-end-screen-scraping).
- **Fidelity WorkplaceXchange APIs**: exist, but are scoped to plan-sponsor / 401(k)-administrator
  / advisor integrations — not personal retail account access. Source:
  [workplacexchange.fidelity.com/public/wpx/api-catalog](https://workplacexchange.fidelity.com/public/wpx/api-catalog).
- **Unofficial options**: there are open-source projects (e.g. a Playwright-based
  `fidelity-api` on GitHub/PyPI) that browser-automate a logged-in Fidelity session to scrape
  account data. This is explicitly unaffiliated with Fidelity, violates the likely spirit (if not
  letter) of Fidelity's terms of service, is fragile against UI changes/anti-bot measures, and is
  not something to build production automation on for a finance app. Noted for completeness, not
  recommended.

**Conclusion for this item:** no viable direct-from-Fidelity option exists for a retail user. Any
integration has to go through an approved third-party aggregator that already has a Fidelity
Access agreement — which is exactly what SnapTrade is.

### 4. Manual entry (baseline to compare against)

The zero-integration fallback: a `financials_holding` row per security, entered/updated by hand
(ticker, quantity, cost basis, as-of date) whenever the user wants a snapshot, no external API,
no OAuth, no ongoing cost, no rate limits, no dependency risk. Tradeoffs: no automatic
freshness (data goes stale until the user remembers to update it), no transaction-level history
unless the user also logs trades by hand, and it doesn't exercise `financials_connection`/
`provider_account_id` machinery the rest of the schema already has for automated sync. Given this
app's `financials_account.kind = 'investment'` already implies "this is a real linked investment
account" (see ADR 0003 / issue #13), manual entry is best treated as a **degrade-gracefully path**
(e.g., if a SnapTrade connection breaks or during initial rollout) rather than the primary design,
not as the chosen provider.

## Schema design implications

For a future `financials_holding` (or `financials_position`) table:

- **Provider-agnostic shape, modeled on the union of Plaid's and SnapTrade's fields** (both are
  structurally the same: an account → security → position join, optionally with per-lot detail):
  - `id` (uuid pk)
  - `account_id` → `financials_account.id` (fk; only meaningful where `financials_account.kind =
    'investment'`)
  - `provider_holding_id` or reuse the existing `provider_account_id` pattern **plus** a
    provider-side security identifier (SnapTrade's `symbol.id` / Plaid's `security_id`) — holdings
    themselves generally aren't independently ID'd by the provider the way transactions are, so
    the natural dedupe key is **`(account_id, security_id)`**, not a provider-issued holding ID.
  - `security_id` (your own internal id, or just store the provider's security identifier
    directly) with **denormalized security fields** worth keeping on the holding row or a
    sibling `financials_security` table: `symbol`/`ticker_symbol`, `name`, `security_type`
    (equity/etf/mutual fund/fixed income/cash/crypto/option/other — both providers use a similar
    enum), and at least one cross-provider identifier (`cusip`/`isin`/`figi`) for de-duplication
    if a security ever needs to be matched across providers.
  - `quantity` / `units` — **numeric, not float**, matching the SimpleFIN precedent; supports
    fractional shares (both providers explicitly allow fractional units).
  - `average_cost_basis` (per-unit) **and/or** `total_cost_basis` — providers give you one or
    both depending on brokerage; store both if available and derive the missing one, since some
    brokerages only report one or the other reliably.
  - `market_price` (per-unit "last known/institution price") and `market_value` (total) — same
    "don't assume institution_value == quantity × price exactly" caution as SimpleFIN's balance
    vs. transactions gap; store both rather than deriving one from the other.
  - `currency` — ISO 4217 code column, matching the existing SimpleFIN currency handling; both
    providers scope currency per-position (a position can be denominated differently than the
    account's default currency, e.g. a foreign-listed ETF).
  - `as_of` / `priced_at` timestamp — holdings are **snapshot data**, not append-only events like
    transactions; there is no stable "holding ID" to upsert against the way SimpleFIN transactions
    have `id`. The natural sync pattern is **replace-on-sync**: on each successful poll, upsert by
    `(account_id, security_id)` and either update `as_of`/values in place, or (better for
    historical net-worth charting) insert a new snapshot row per sync and let `as_of` distinguish
    them — decide based on whether the product wants point-in-time portfolio history or just
    current-state holdings.
  - Optional `tax_lots jsonb` (or a child `financials_holding_lot` table) if lot-level cost basis
    ever matters (tax planning) — both providers expose this, but not universally per brokerage/
    security, so it should be nullable/optional, not a required join.

- **`financials_connection.provider`** gets a second literal value (e.g. `'snaptrade'`) alongside
  `'simplefin'`; `financials_connection.extra jsonb` is already the right place to stash
  provider-specific connection metadata (SnapTrade's `authorizationId`, sync mode, etc.) without a
  schema migration, following the pattern ADR 0003 already established.

- **`financials_account.kind = 'investment'`** rows from a SnapTrade connection map cleanly:
  SnapTrade's `account_category: 'INVESTMENT'` corresponds directly, and its `balance` field
  (total account market value) can populate the same balance-snapshot mechanism already used for
  SimpleFIN depository accounts — so `financials_account`/balance history doesn't need a new
  concept, only `financials_holding` is genuinely new.

- **Sync job design differs from SimpleFIN's**: SimpleFIN was pure poll-only with a hard 90-day
  window cap; SnapTrade's Daily-plan model is poll-plus-webhook (`ACCOUNT_HOLDINGS_UPDATED`), so
  the job architecture should be ready to either receive a webhook (if the Next.js app exposes a
  public endpoint) or fall back to a scheduled daily pull matching the free Daily-plan cadence —
  no benefit to polling more often than once/day on the free personal tier.

## Recommendation

**Use SnapTrade, in Personal integration mode.** It is the only one of the three providers that
(a) actually connects to Fidelity at all — Plaid dropped Fidelity support in 2023 when Fidelity
moved to exclusive Akoya/Fidelity-Access-agreement distribution, and no reversal is documented as
of Aug 2026 — and (b) has an explicit, free, approval-free "Personal" mode built for exactly this
scenario (one person, their own brokerage accounts, no end-customers). Plaid Investments has a
richer, more standardized data model (proper `tax_lots`, cleaner security taxonomy, generous rate
limits) and would be the better technical choice in the abstract, but it's disqualified for this
issue's stated need since it cannot link the Fidelity account at all; it's worth remembering only
if a future non-Fidelity brokerage gets added and personal-tier friction (Trial plan, 10-Item cap)
turns out acceptable. Fidelity has no direct developer API a retail user can register for — its
only sanctioned third-party channel is Fidelity Access, gated behind aggregator-level agreements,
which is precisely what SnapTrade already holds. Manual entry remains the sensible degrade path
(e.g., if a SnapTrade connection breaks, or as an interim step before the sync job exists) but
shouldn't be the primary design given the schema already anticipates a real second provider.

## Sources

Primary (official):
- [plaid.com/docs/investments](https://plaid.com/docs/investments/) — Investments product overview
- [plaid.com/docs/api/products/investments](https://plaid.com/docs/api/products/investments/) — endpoint/field reference, webhooks
- [plaid.com/pricing](https://plaid.com/pricing/) — pricing model structure
- [plaid.com/docs/errors/rate-limit-exceeded](https://plaid.com/docs/errors/rate-limit-exceeded/) — rate limits
- Plaid Customer Help Center: "Can I use Plaid for free?" and "How are Sandbox, Production, Trial plan, and Limited Production different?" (support.plaid.com)
- [docs.snaptrade.com](https://docs.snaptrade.com/) — Getting Started
- [docs.snaptrade.com/docs/personal-vs-commercial](https://docs.snaptrade.com/docs/personal-vs-commercial)
- [docs.snaptrade.com/docs/implement-connection-portal](https://docs.snaptrade.com/docs/implement-connection-portal)
- [docs.snaptrade.com/docs/connections](https://docs.snaptrade.com/docs/connections)
- [docs.snaptrade.com/docs/syncing](https://docs.snaptrade.com/docs/syncing)
- [docs.snaptrade.com/docs/realtime-data](https://docs.snaptrade.com/docs/realtime-data)
- [docs.snaptrade.com/docs/ratelimiting](https://docs.snaptrade.com/docs/ratelimiting)
- [docs.snaptrade.com/docs/billing](https://docs.snaptrade.com/docs/billing)
- [docs.snaptrade.com/docs/faq](https://docs.snaptrade.com/docs/faq)
- [docs.snaptrade.com/reference — List account holdings](https://docs.snaptrade.com/reference/Account%20Information/AccountInformation_getUserHoldings)
- [docs.snaptrade.com/reference — List account positions](https://docs.snaptrade.com/reference/Account%20Information/AccountInformation_getUserAccountPositions)
- [snaptrade.com/brokerage-integrations/fidelity-api](https://snaptrade.com/brokerage-integrations/fidelity-api) — Fidelity connection flow, Fidelity Access User Agreement
- [snaptrade.com/pricing](https://snaptrade.com/pricing)
- [github.com/passiv/snaptrade-sdks](https://github.com/passiv/snaptrade-sdks) — official TypeScript SDK
- [fidelity.com/security/fidelity-access-data-security](https://www.fidelity.com/security/fidelity-access-data-security)
- [newsroom.fidelity.com — Update on Fidelity's Secure Data Sharing Efforts](https://newsroom.fidelity.com/pressreleases/update-on-fidelity-s-secure-data-sharing-efforts/s/7a30c2e4-f070-4396-b04c-b773678d59f9)
- [akoya.com/news — Fidelity data-sharing hub aims to end screen scraping](https://akoya.com/news/fidelity-data-sharing-hub-aims-to-end-screen-scraping)
- [workplacexchange.fidelity.com/public/wpx/api-catalog](https://workplacexchange.fidelity.com/public/wpx/api-catalog)
- [jpmorganchase.com — JPMorganChase and Plaid renewed data access agreement, Sept 2025](https://www.jpmorganchase.com/newsroom/press-releases/2025/jpmc-plaid-renewed-data-access-agreement)

Secondary (used only to establish the Plaid–Fidelity disconnection timeline, cross-checked against
official Fidelity/Akoya statements above on *why* it happened):
- [Infinite Kind (Moneydance) support thread, Oct 2023 — "Fidelity and Plaid"](https://infinitekind.tenderapp.com/discussions/online-banking/1247360-fidelity-and-plaid)
- [Infinite Kind support thread — "Fidelity Net Benefits and Investments not working with OFX or Plaid"](https://infinitekind.tenderapp.com/discussions/online-banking/1252236-fidelity-net-benefits-and-investments-not-working-with-ofx-or-plaid)
