# ben-os

A single-user personal platform (TypeScript/Next.js on Vercel, Supabase backend) that consolidates personal-admin tools — starting with a Financials vertical, with Email, Calendar, and Notetaking planned as future verticals.

## Language

**Module**:
A self-contained feature area (e.g. Financials) living under `apps/web/app/(modules)/<name>/`, registered in a central module registry, and owning its own prefix-namespaced Supabase tables (`<module>_<entity>`).
_Avoid_: Vertical (used loosely in planning discussions, but "module" is the concrete code/schema unit), plugin, feature.

**Module registry**:
The list in `apps/web/lib/modules.ts` that declares every module — its label, icon, route, and whether it's built yet. It governs enablement, not just routing: a module with `status: "soon"` still appears in the shell, dimmed and inert. Registering a module means adding one entry here.
_Avoid_: Nav config, routes — the registry is the source of truth for what modules exist, and navigation is only one thing it drives.

**Shell**:
The persistent chrome every module renders inside: the left sidebar (module list plus account chip) and the crumb row (`<Module> / <page>` plus a sync-status chip). The shell owns exactly those two things and never reaches into module content. Its visual identity is "Console" — dense, dark-first, hairline borders, tabular numerals, one accent color.
_Avoid_: Layout (ambiguous with Next.js's `layout.tsx` files, of which modules have their own), chrome, frame.

**Authorized user**:
The single Google account permitted to use the app. Enforced in two places: a middleware/layout check at the app layer, and the `is_authorized()` Postgres function as an RLS backstop at the database layer.
_Avoid_: Owner, admin — this app has no multi-tenant or role concept, there is exactly one authorized user.

### Financials module

**Provider**:
The external data source a connection authenticates against (e.g. SimpleFIN; a future brokerage-holdings provider). Every connection belongs to exactly one provider.

**Connection**:
A single login/institution link to a specific provider (e.g. SimpleFIN's `conn_id`). One connection can expose multiple accounts; the same institution can have more than one connection if linked more than once.
_Avoid_: Institution, bank — a connection is one authenticated link to an institution, not the institution itself.

**Account**:
A single financial account (checking, savings, credit card, brokerage, etc.) exposed by a connection, with a live balance synced from its provider. Distinguished by `kind` (`'depository' | 'investment'`), which is user-set — no provider signals account type natively.

**Balance snapshot**:
A point-in-time record of an account's balance as reported by a provider poll — the basis for net worth history, distinct from the account's current balance.
_Avoid_: Balance (ambiguous between "the account's current balance" and "a historical snapshot")

**Net worth**:
The sum of every Account's balance at a point in time, derived from Balance snapshots at read time and never stored. Its unit is a UTC day: an account's last reading of a day wins, an account that missed a poll carries its previous balance forward, and a closed account contributes up to its last snapshot and no further. See [ADR 0006](docs/adr/0006-net-worth-derivation-and-charting.md).
_Avoid_: Total balance — net worth is the sum across accounts, and "balance" already belongs to a single account.

**Poll**:
One scheduled call to a provider, covering every Connection at once — SimpleFIN answers `GET /accounts` for the whole subscription, not per institution. A poll succeeds or fails _per Connection_, so "the poll failed" is almost always wrong; one bank being broken is the normal case.
_Avoid_: Sync, when the unit matters — a Sync is the job, a Poll is one run of it.

**Poll window**:
The date range a poll asks for. Steady state is a 5-day overlap rather than "since last sync", because institutions post transactions late and a cursor would step over them; re-fetching is free because transactions dedupe on `(account_id, provider_transaction_id)`. The first poll against an empty database reaches back 45 days instead — see [ADR 0005](docs/adr/0005-financials-sync-execution-model.md).

**Category**:
A user-assigned label on a transaction. SimpleFIN provides no native categorization, so this is entirely app-owned.
_Avoid_: Tag — categories are single-valued per transaction in v1, not a many-valued tagging system.

**Uncategorized**:
Not a Category — the absence of one (`financials_transaction.category_id is null`). It gets a bar in the flow breakdown and an entry in the picker anyway, because spend nobody has labelled is still spend, and a breakdown that omitted it would not add up to the expenses figure above it.
_Avoid_: Other, Misc — both read as a category someone chose, which is the one thing this isn't.

**Flow**:
The income/expenses/net framing a depository Account gets, derived from its transactions over a range: what came in, what went out, and where it went. The counterpart to the balance-bridge framing an investment Account gets, and the reason `financials_account.kind` is a column at all — a chart of a credit card's balance says it is at −$2,309, and only flow says why.
_Avoid_: Cash flow statement (an accounting artefact with a fixed shape this isn't), spending (only half of it — flow includes income), day-to-day account (the thing is an Account with `kind = 'depository'`; it doesn't need a second name).

**Balance bridge**:
The Start → Contributions → Dividends → Growth → Fees → End framing an investment Account gets, explaining why its balance moved over a period. The counterpart to Flow, and the other half of the reason `financials_account.kind` is a column. Its two ends come from Balance snapshots and its middle from Activity tags, so it is the one surface that reads both tables at once. See [ADR 0008](docs/adr/0008-fidelity-balance-bridge.md).
_Avoid_: Waterfall (the chart shape, not the thing being shown), performance, returns — a bridge attributes a balance change and deliberately does not compute a rate of return.

**Activity tag**:
What a brokerage transaction turns out to be — Contribution, Withdrawal, Dividend, or Fee — derived at read time from its description, never stored and never user-set. Most rows get no tag at all: a reinvestment, buy, or sell moves value inside the account and belongs to no Segment. Direction comes from the tag rather than from the amount's sign, which on Fidelity's feed is unreliable in both directions (ADR 0008, decision 3).
_Avoid_: Category — a Category is user-assigned and lives in a table; an Activity tag is derived and lives nowhere. The distinction is the whole point of an investment account having no category picker.

**Growth**:
The Balance bridge's residual — the balance change that Contributions, Dividends and Fees do not account for. Defined as what is left over rather than measured, because nothing posts to `financials_transaction` when a holding's price moves. This is what makes the bridge reconcile exactly for any input, so a mis-tagged row shifts money between segments and never falsifies the total.
_Avoid_: Gain, return, performance — those imply a measured figure; Growth is explicitly the unexplained remainder, and says so on the page.

**Segment**:
One step of a Balance bridge. Start and End are balances drawn from the axis; the four between them are signed changes that float. Always six, always in that order.

**Security**:
A tradable financial instrument (stock, ETF, mutual fund, etc.), identified by ticker symbol. Provider-agnostic reference data, shared across every Holding that references it.
_Avoid_: Ticker, symbol, instrument — "Security" is the entity; a ticker/symbol is one of its fields.

**Holding**:
A snapshot of how much of a Security an Account holds as of a given sync — quantity, cost basis, market price. A new row is written on every sync (not upserted), so a Holding is a reading rather than a standing record; what counts as the present one is Current holdings, below. Its `as_of` is the _provider's_ reading time, not the moment the job ran — see [ADR 0007](docs/adr/0007-snaptrade-holdings-sync.md).
_Avoid_: Position — used in the SnapTrade research as an interchangeable term, but "Holding" is this codebase's canonical word.

**Current holdings**:
The Holdings stamped with an Account's _latest_ `as_of` — the whole reading, taken together. Deliberately not "the newest row per Account/Security pair", which sounds equivalent and is not: a holding sold between two syncs has no later row to supersede it, so that reading would carry it as a holding forever. Resolved per Account, because the two Fidelity accounts sync seconds apart and a single maximum across both would empty whichever finished first. See [ADR 0009](docs/adr/0009-fidelity-holdings-page.md).
_Avoid_: Portfolio — implies something the app owns and maintains; this is a query over rows the sync appended.

**Allocation**:
How an Account's value is split across Security types — the composition view above the holdings ledger. Its grouping is `financials_security.security_type`, which is the _wrapper_ a security comes in rather than its asset class, so a bond ETF counts as an ETF and not as fixed income. Stated on the page rather than corrected, because no provider in this stack reports asset class and inferring one would mean guessing at a security's contents from its ticker.
_Avoid_: Asset allocation — the established term names exactly the stock/bond split this deliberately is not.

**Tax lot**:
One parcel of a Holding, bought at one price on one day. Stored raw in `financials_holding.tax_lots` and read defensively, because the shape has never been seen: SnapTrade gates lot detail behind its paid plans, so on Personal the column is null on every row this app has written. Null means the provider said nothing, which is not the same as a holding having no lots.

**Account link**:
The user's assertion that a given provider's account and an Account this app already has are the same real account. Needed because two providers report the same Fidelity accounts under unrelated ids, and only the account holder can say so. Recorded on the SnapTrade Connection's `extra`, and the reason the holdings sync attaches to existing Accounts rather than creating its own — a second row would count the account twice in Net worth.
_Avoid_: Mapping, match — "match" suggests something derived from the data, and this is deliberately asserted rather than inferred.

### Notes module

**Notepad**:
A managed, named container that notes are filed into (`notes_notepad`). Carries a `kind` (`freeform` / `checklist` / `list` / …) that sets its default rendering and steers triage, and a `description` — a short purpose line triage both writes on creation and reads to decide where a new note belongs. Identity is its normalized name: a `unique` index on `lower(trim(name))` blocks literal duplicates, and the web manager's Merge reconciles same-thing-different-name cases. See [ADR 0010](docs/adr/0010-notes-data-model.md).
_Avoid_: List, folder, category — a notepad may be a checklist but is not only one, and "category" already belongs to Financials for a single-valued transaction label.

**Note**:
A single captured message filed into a Notepad (`notes_note`). Holds `raw_text` (the immutable original capture) and `body` (the editable working content that starts equal to it), a `structure` payload, its channel provenance, and `captured_at`. Its `notepad_id` is nullable — a note with no notepad is **unfiled**.
_Avoid_: Message, item — "message" is the transport, a note is what we keep; "item" is one rendering (a checklist entry), not the entity.

**Note structure**:
The per-note derived shape, held as a `jsonb` payload on `notes_note.structure` rather than typed columns — e.g. `{"done": false, "due_at": "…"}`, where an absent key means "not that kind of structure" (no `done` ⇒ not a checklist item). Modeled as jsonb deliberately, to design for expansion as new structure kinds arrive. "Checklist-ness" is a hybrid: primarily the notepad's `kind`, with the note's structure carrying exceptions.
_Avoid_: Metadata — structure is the note's inferred content shape, not incidental bookkeeping.

**Unfiled**:
A Note with `notepad_id IS NULL` — the inbox is this query, not a reserved "Inbox" notepad. Filing (`notepad_id`) and triage-having-run (`triaged_at`) are **orthogonal axes**: an unfiled note may be _deliberately unfiled_ (triage ran and judged it belongs nowhere — `triaged_at` set), _pending_ (triage hasn't succeeded yet — `triaged_at IS NULL`), or _permanently failed_ (`triaged_at IS NULL` with the retry ceiling reached). See [ADR 0012](docs/adr/0012-notes-triage-model.md).
_Avoid_: Inbox (as an entity) — there is no Inbox notepad, only the unfiled query; Pending (as a synonym for unfiled) — pending is one _reason_ a note is unfiled, not the whole set.

**Channel**:
Where a Note was captured from — `notes_note.channel` (`'telegram'` for v1, an iOS widget later), paired with a `source` jsonb holding that channel's own identifiers (including a stable `source.external_id` for capture idempotency). Channel-agnostic by construction: the note table hardcodes no per-channel columns, mirroring the Financials `provider` + `extra` multi-provider pattern. `captured_at` is the sender's timestamp, kept distinct from `created_at`.
_Avoid_: Source (for the channel itself) — `source` is the jsonb of channel-specific ids; the channel is the named transport; Provider — that word belongs to Financials' external data sources.

**Adapter**:
The per-channel entry point that receives a channel's native payload (a Telegram webhook update for v1) at its own route, authenticates it in that channel's own way, and translates it into the normalized inbound shape — `raw_text` + `channel` + `source` (with a stable `source.external_id`) + `captured_at`. Telegram is adapter #1; a future iOS widget is another adapter. Each adapter owns its channel's auth and payload mapping and nothing else; it then hands off to the Ingest core. See [ADR 0011](docs/adr/0011-notes-ingest-boundary.md).
_Avoid_: Webhook (as the boundary) — a webhook is one channel's transport; the adapter is the role that translates it.

**Ingest core**:
The single in-process function every Adapter calls to land a captured note — it validates the normalized shape, enforces capture idempotency (`insert … on conflict do nothing` on the `(channel, source->>'external_id')` index), sets `body := raw_text`, `notepad_id := null`, `triaged_at := null`, and inserts through an RLS-enforced `withAuthorizedSession` writer (the Financials pattern — `authenticated` role + JWT claims — never a service role, of which ben-os has none). It trusts its in-process callers for channel auth (that already happened in the Adapter), but the DB write still passes `is_authorized()`, so that policy is the ingest gate exactly as it is the web-manager gate. It never runs triage — an untriaged note (`triaged_at IS NULL`) is the entire hand-off to triage. See [ADR 0011](docs/adr/0011-notes-ingest-boundary.md).
_Avoid_: Ingest endpoint — there is no public generic ingest URL; the core is internal and reached only through an Adapter.

**Triage**:
The agentic step that reads a captured Note (landed unfiled by the Ingest core) and decides where it belongs — an existing Notepad, a new one, or deliberately nowhere — and its structure, in one strict `file_note` LLM tool call. It runs **on-arrival** — decoupled from and _after_ the raw note is acknowledged, never inline in capture — and **once** per note: success sets `triaged_at`, freezing the note against automatic re-triage so a manual move is permanent. Re-triage is only ever an explicit, user-initiated action. See [ADR 0012](docs/adr/0012-notes-triage-model.md).
_Avoid_: Classify, sort — triage may _create_ its target notepad and rewrite the note's body, not merely bucket it; Routing — the note is not forwarded, it is filed in place.

**Triage sweep**:
The once-daily cron pass that re-triages Notes still stuck untriaged — an on-arrival failure, or a note captured while triage was down — up to a bounded retry ceiling. It is a **backstop**, not the workhorse (on-arrival is); framing it as a sweep is what lets it live inside Vercel Hobby's one-cron-run-per-day cap. See [ADR 0012](docs/adr/0012-notes-triage-model.md).
_Avoid_: Batch (triage) — the sweep is a retry backstop over the _failed_ tail, not the primary path; the rejected "scheduled batch triages everything" model is a different thing.

**Capture confirmation**:
The single Telegram reply the bot sends back **after triage runs**, naming the notepad a note landed in and whether triage **reused or newly started** it (`📓 Filed in *Shopping list*` vs `🆕 Started *Shopping list*`), or that the note was kept unfiled or couldn't be filed. It is sent by the triage step — not the Ingest core, which stops at the landed row — and carries the `✏️ Move` button that opens a Correction. There is no separate pre-triage acknowledgement: on the happy path triage is seconds away, so capture `200`s silently and the confirmation is the only human-facing reply. See [ADR 0013](docs/adr/0013-notes-capture-feedback-loop.md).
_Avoid_: Receipt, ack — "ack" is the bare `200` capture returns to Telegram; the confirmation is the later, human-facing message about where the note went.

**Correction**:
Fixing a note's placement from the phone by tapping the confirmation's `✏️ Move` button, which expands to a button per existing notepad plus `➕ New notepad`; a tap reassigns the note's `notepad_id` **directly**, with no LLM. Deterministic by design — correcting a filing is about removing the model's judgment, so it never re-invokes triage. The bot picker is manual-only; asking the agent to re-file (re-triage) is a web-manager action, not a phone one. Arrives as a Telegram `callback_query` handled as its own operation (never `ingestNote`, which is only for new captures). See [ADR 0013](docs/adr/0013-notes-capture-feedback-loop.md).
_Avoid_: Re-triage — re-triage re-runs the model; a Correction is a direct manual reassignment and the phone flow deliberately excludes the model re-run.

**Outbound adapter**:
The per-channel return path that turns triage's channel-agnostic capture outcome (`{ notepad, created?, unfiled?, failed? }`) into a reply on the note's own channel — the mirror of the inbound Adapter. Triage hands the outcome to a `notifyCapture(note, outcome)` dispatcher that selects the Outbound adapter by `note.channel`; the Telegram one renders the Capture confirmation text plus its inline keyboard and calls `sendMessage`, a future iOS-widget one registers its own reply. Keeps triage from importing any transport, so a new channel adds one adapter and no triage change. See [ADR 0013](docs/adr/0013-notes-capture-feedback-loop.md).
_Avoid_: Notifier — the outbound adapter is the channel-specific half; `notifyCapture` is the channel-agnostic dispatcher in front of it.

**Connection Portal**:
SnapTrade's hosted page where the user completes the brokerage OAuth — for Fidelity, its own login plus the Fidelity Access consent screen. The app can request a portal URL but cannot complete the flow; what comes out the far side is the `authorizationId` that identifies the Connection from then on.
