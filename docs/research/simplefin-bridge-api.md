# Research: SimpleFIN Bridge API

## Question

What does the SimpleFIN Bridge API provide — auth/token flow, endpoints, data shapes for
accounts/balances/transactions, sync model (polling vs push), rate limits, and cost — and what
does an existing SimpleFIN setup already grant access to?

## Findings

### 0. SimpleFIN (the protocol) vs. SimpleFIN Bridge (the hosted service)

SimpleFIN is an open, free, read-only financial-data **protocol** ("Simple Financial
Interchange"): a small HTTP spec that any bank or aggregator can implement for free, positioned
as a simpler/cheaper alternative to formats like QFX ("Banks don't have to pay anyone to use it
(like they do with QFX)") — [simplefin.org](https://www.simplefin.org/).

**SimpleFIN Bridge** (`beta-bridge.simplefin.org`) is a hosted aggregator that *implements* the
SimpleFIN protocol on top of many banks that don't natively speak it — i.e. it's the
Plaid-equivalent layer: it does the actual bank-credential linking/scraping and exposes the
result as a standard SimpleFIN server. A client app (like this dashboard) never talks to the
bank directly — it talks to Bridge using the plain SimpleFIN protocol. Source:
[beta-bridge.simplefin.org](https://beta-bridge.simplefin.org/),
[beta-bridge.simplefin.org/info/developers](https://beta-bridge.simplefin.org/info/developers).

### 1. Auth/token flow (setup token → access URL exchange)

This is a one-shot bearer-credential handoff, not OAuth (no refresh tokens, no expiring access
tokens, no redirect/consent screens per-request):

1. The user, inside SimpleFIN Bridge's UI, links their bank(s) and generates a **Setup Token** —
   a base64-encoded blob that decodes to a one-time **claim URL**.
2. The user pastes that Setup Token into the client application (this only happens once, during
   account linking).
3. The application base64-decodes the Setup Token to get the claim URL, then issues a single
   `POST` to it (with `Content-Length: 0`). The response body is the **Access URL** — a URL with
   HTTP Basic Auth credentials embedded directly in it:
   `scheme://username:password@host/path`.
4. **The claim step can only be done once per Setup Token** — a second attempt returns `403`,
   which the spec explicitly flags as a signal the token/data may have been compromised.
5. From then on, the app stores the Access URL (i.e., the basic-auth credentials) and uses it
   directly for every future call to `{ACCESS_URL}/accounts` — no further token refresh or
   re-auth is needed until the user revokes access on the Bridge side (which invalidates the
   credentials, subsequent calls return `403`).

Reference cURL from the developer guide:

```bash
SETUP_TOKEN='[your-token]'
CLAIM_URL="$(echo "$SETUP_TOKEN" | base64 --decode)"
ACCESS_URL=$(curl -H "Content-Length: 0" -X POST "$CLAIM_URL")
curl -L "${ACCESS_URL}/accounts?version=2"
```

Source: [SimpleFIN Bridge Developer Guide](https://beta-bridge.simplefin.org/info/developers),
[SimpleFIN Protocol spec](https://www.simplefin.org/protocol.html).

### 2. Endpoints and data shapes

The protocol (v2, current — [simplefin.org/protocol.html](https://www.simplefin.org/protocol.html))
defines four required endpoints on any SimpleFIN-compatible server (Bridge implements all of
these):

- `GET /info` — returns the array of protocol versions the server supports.
- `GET /create` — starts the linking workflow, produces a Setup Token (this is a Bridge/server-UI
  concern, not something the client app calls directly in normal operation).
- `POST /claim/:token` — the one-time claim exchange described above.
- `GET /accounts` — the only data endpoint. **There is no separate `/transactions` endpoint** —
  transactions are nested inside each account object returned by `/accounts`.

**`GET /accounts` query parameters:**

| Param | Meaning |
|---|---|
| `version` | protocol version, e.g. `version=2` (recommended to pin explicitly) |
| `start-date` | Unix epoch seconds, inclusive |
| `end-date` | Unix epoch seconds, exclusive |
| `pending` | `1` to include pending transactions |
| `account` | account ID filter, repeatable, for fetching a subset of accounts |
| `balances-only` | `1` to skip transaction data entirely and return just balances (cheaper call) |

**Response shape — top-level "Account Set":**

- `accounts` (array of Account objects)
- `connections` (array of Connection objects — v2 only, replaces v1's flat "Organization" object)
- `errlist` (array of structured errors — v2; the deprecated v1 equivalent was a plain `errors`
  array of strings)

**Account object:**

| Field | Required? | Notes |
|---|---|---|
| `id` | required | stable account identifier |
| `name` | required | account display name |
| `conn_id` | required (v2) | identifies which Connection (login) this account belongs to — lets you distinguish two logins to the same bank |
| `currency` | required | ISO 4217 code (e.g. `"USD"`), or a URL for non-standard "currencies" (e.g. rewards points) that resolves to JSON `{name, abbr}` |
| `balance` | required | current balance, numeric string |
| `balance-date` | required | Unix timestamp of when `balance`/`available-balance` were computed |
| `available-balance` | optional | |
| `transactions` | optional | array of Transaction objects, omitted if `balances-only=1` |
| `extra` | optional | institution-specific bag of extra fields |

**Transaction object:**

| Field | Required? | Notes |
|---|---|---|
| `id` | required | stable transaction identifier |
| `posted` | required | Unix timestamp |
| `amount` | required | numeric string; **positive = money deposited into the account**, negative = withdrawal/spend |
| `description` | required | free-text description from the institution |
| `transacted_at` | optional | when the transaction actually occurred, vs. `posted` |
| `pending` | optional | boolean |
| `extra` | optional | institution-specific extra data |

There is **no standardized transaction category field**. SimpleFIN does not do categorization —
any `category`/`merchant` normalization would have to be a schema/app-layer concern on top of
`description` (and whatever an institution stuffs into `extra`).

**Connection object (v2):**

| Field | Required? | Notes |
|---|---|---|
| `conn_id` | required | |
| `name` | required | institution/connection display name |
| `org_id` | required | |
| `sfin_url` | required | the SimpleFIN server URL for this connection |
| `org_url` | optional | |

**Errors:** structured objects with `code` (format `prefix.subcode`, prefix ∈ `gen`/`con`/`act`
for general/connection/account scope — apps should fall back to treating unknown subcodes as the
naked prefix), `msg`, and optional `conn_id`/`account_id`. HTTP-level: `200` success, `402`
payment required, `403` auth failure/already-claimed token.

Source: [SimpleFIN Protocol v2 spec](https://www.simplefin.org/protocol.html),
[SimpleFIN Protocol v1 spec](https://www.simplefin.org/protocol-v1.html) (for the v1→v2 diff).

### 3. Sync model: pull-only, no webhooks

SimpleFIN (both the protocol and Bridge's implementation of it) is **strictly pull/polling** —
the client calls `GET /accounts` whenever it wants fresh data. There is no webhook, push
notification, or subscription mechanism documented anywhere in the protocol spec or the Bridge
developer guide. Bridge's own guidance assumes a client-side scheduler (e.g. a daily cron job),
not a server-initiated push. Source: [protocol.html](https://www.simplefin.org/protocol.html),
[Bridge developer guide](https://beta-bridge.simplefin.org/info/developers).

### 4. Rate limits / usage constraints (Bridge-specific — not in the base protocol)

The open protocol spec itself documents **no** rate limits. SimpleFIN Bridge, as the hosted
implementation, imposes practical limits documented in its developer guide:

- **~24 requests/day expected**, with "a little leeway above this limit" during initial setup;
  quotas appear to reset over the course of the day; exceeding the limit produces warnings in
  the `errlist` first, then eventual token disablement if abuse continues.
- Individual-account queries (`account=` filter) and whole-account-set queries appear to draw
  from separate quotas.
- **`start-date`/`end-date` window is capped at 90 days per request.** To pull a longer history
  you must make multiple sequential `/accounts` calls with different windows.
- **Recommended polling pattern:** pick a random minute (not top-of-hour) to reduce load-spike
  contention, e.g. "every 6 hours at 17 minutes past the hour."
  Overlap consecutive fetch windows by ~5 days to avoid gaps from late-posting transactions.
- **Historical depth on a fresh connection varies per institution** — no guaranteed minimum
  number of days of backfilled history; some banks may only backfill a short window, others
  longer.

Source: [SimpleFIN Bridge Developer Guide](https://beta-bridge.simplefin.org/info/developers).

### 5. Cost

- **The SimpleFIN protocol itself is free** — any bank or developer can implement/consume the
  spec at no charge. It's explicitly pitched as free-to-implement in contrast to fee-based
  formats like QFX. Source: [simplefin.org](https://www.simplefin.org/).
- **SimpleFIN Bridge, the hosted aggregation service, is a paid product** (this is what covers
  the cost of actually maintaining bank-scraping/connections across institutions):
  - **$1.50 + tax / month**, or
  - **$15.00 + tax / year**
  - This is a flat account-level subscription (not metered per API call). Bridge's pricing page
    also states plan limits of **up to 25 institutions and 25 connected apps** per Bridge
    account.
  Source: [beta-bridge.simplefin.org](https://beta-bridge.simplefin.org/).

### 6. What an existing SimpleFIN setup already grants access to

Having already gone through Bridge's account-linking flow once means:

- The linking/consent UI step (bank login, MFA, selecting which accounts to share) is **already
  done** and does not need to be re-implemented or re-triggered by this app.
- What was produced is a **Setup Token**, which is redeemable **exactly once** for a persistent
  **Access URL** containing HTTP Basic Auth credentials (username:password embedded in the URL).
- That Access URL, once claimed, is the **long-lived credential** — there's no separate
  refresh-token step, no expiry to renew on a schedule. It remains valid until the user revokes
  it from the Bridge dashboard (or Bridge itself disables it for quota abuse).
- Every future data pull is just `GET {ACCESS_URL}/accounts[?params]` using that same Basic Auth
  credential — i.e., "having a SimpleFIN setup" reduces to "possessing one already-claimed
  Access URL string," which this app's backend would store as a secret and use directly. No
  per-request user interaction, redirect, or re-auth is required going forward.
- If the Setup Token has not yet been claimed by *this* app, it must be redeemed (step 3 in
  section 1) before first use, and only once — attempting to reuse an already-claimed token
  fails with `403`.

Source: [Bridge developer guide](https://beta-bridge.simplefin.org/info/developers),
[SimpleFIN protocol spec](https://www.simplefin.org/protocol.html).

## Implications for schema design

These constraints should directly inform the "Financials schema" ticket (accounts/transactions/
net-worth tables):

- **No native transaction categories.** The schema needs its own `category`/`merchant`
  normalization layer — SimpleFIN only gives `description` (free text) plus an opaque `extra`
  bag. Don't expect a clean enum from the source.
- **Amounts and balances arrive as numeric strings, not floats** — store as fixed-point/decimal
  (e.g. `numeric`/`decimal` column types), not floating point, to avoid rounding errors; sign
  convention is positive = deposit, negative = withdrawal.
- **Currency is per-account, not global** — the `currency` field lives on each Account, and can
  in rare cases be a URL (non-ISO "currency," e.g. loyalty points) rather than an ISO 4217 code.
  The schema's currency column should be a string type wide enough for a URL, not a fixed-length
  ISO code, or should special-case non-ISO currencies.
- **`conn_id` matters:** two accounts can share the same bank but different logins/connections;
  model `connection` as its own entity (id, name, org info) rather than assuming one row per
  institution.
- **Transaction `id` is the source of truth for idempotent upserts** — dedupe/upsert transactions
  by `(id)` (scoped to account/connection) since polling will re-fetch overlapping date windows
  by design (5-day overlap recommendation) and will see the same transaction repeatedly.
- **Balance has a timestamp (`balance-date`) distinct from any transaction** — for net-worth
  history, snapshot `(account_id, balance, available_balance, balance_date)` on each poll rather
  than deriving balance purely from summed transactions, since `balance-date` may lag or lead
  the transaction feed.
- **History depth is bounded and institution-dependent** — the schema/sync design cannot assume
  unlimited backfill on first connection; plan for incremental accumulation over time via
  repeated 90-day-max polls rather than a single "get everything" import. A backfill job may need
  to walk backwards in 90-day windows until an institution stops returning data.
- **Sync must be a scheduled pull job** (e.g. every few hours, at a random offset, ~24
  requests/day budget), not an event listener — no webhook receiver is needed in this app's
  architecture, but a durable job scheduler/cron is.
- **`pending` transactions can change or disappear** — if surfacing pending transactions in the
  net-worth/transactions view, the schema should support updating or removing a transaction
  previously seen as pending (it may later post with a different `id`/amount), not just append-only
  inserts.
- **Errors are structured and partial-failure-tolerant** — a single `/accounts` call can return
  data for some accounts and `errlist` entries for others (e.g., one bank connection is broken);
  the sync job/schema should handle per-connection error states rather than treating the whole
  poll as atomic success/failure.

## Sources

Primary (official):
- [simplefin.org](https://www.simplefin.org/) — protocol overview, mission, cost-of-protocol statement
- [simplefin.org/protocol.html](https://www.simplefin.org/protocol.html) — SimpleFIN protocol v2 spec (endpoints, data shapes, errors)
- [simplefin.org/protocol-v1.html](https://www.simplefin.org/protocol-v1.html) — protocol v1 spec, used for the v1→v2 diff
- [beta-bridge.simplefin.org](https://beta-bridge.simplefin.org/) — Bridge pricing, institution/app limits
- [beta-bridge.simplefin.org/info/developers](https://beta-bridge.simplefin.org/info/developers) — Bridge developer guide: setup token flow, rate limits, polling guidance, 90-day window
- [github.com/simplefin](https://github.com/simplefin) — SimpleFIN GitHub org (spec/website source repo, reference client libraries)

No secondary/blog sources were needed — the official protocol spec and Bridge developer guide
covered every part of the question directly.
