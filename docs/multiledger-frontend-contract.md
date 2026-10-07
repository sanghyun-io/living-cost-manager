# Multi-ledger frontend integration — 2026-10-07

Base: backend `317befc490902ce3e42dbe89cfde6d2a512d6c06` (source base
`8c4e128`). Isolated branch `frontend/multiledger`; no original dirty checkout,
API/shared source, production, DB, credential, or billing changes.

## Identity, transitions and storage

- Guest/sample profiles remain browser-local. Authenticated cache identity is
  `ledger:` + JSON `[serverUserId,workspaceId]`, encoded through the existing
  versioned user-storage key. Income/categories/cards/costs, recovery/import
  backups, offline edits and undo identity all use that scope.
- Only the first observed active workspace of an account inherits its legacy
  profile cache. Copy only; never delete the source or overwrite an existing
  destination. A persistent completion marker prevents remigrating a later
  edited cache. Conflicting originals remain at both keys; the data-management
  status explains that no overwrite occurred. No heuristic financial merging.
- Switching synchronously saves/verifies the outgoing cache, cancels import
  decisions, closes management dialogs and resets filters/deletion mode. Quota,
  corruption, erasure or detected cross-tab divergence refuses switching.
  Ledger-specific modal/quick-add drafts remount; undo does not carry to another
  ledger. Baseline/auto-sync generations reset on each switch; pending local
  edits stay in their outgoing ledger's cache.
- A never-before-cached target may initialize from its server snapshot only if
  its initial local snapshot and stored value are still unchanged. Existing
  caches, including empty or unsynced caches, retain the explicit pull/recovery
  decision. Initialization never enables automatic uploads.
- Existing sync ticket identity rejects late pull/push and ABA transitions.
  Creation/rename/aggregate have account+workspace epoch checks and synchronous
  auth-session-ref checks, including the interval before React renders a new
  session. Aggregate response state never enters the editable budget hook.
- Storage events detect same-ledger external edits and block further saves and
  sync. Canonical account erasure tombstones stop all ledger scopes. Account
  deletion removes every scoped ledger cache/recovery and migration marker but
  preserves other accounts and guest profiles.
- localStorage has no cross-process compare-and-swap: this is detection and
  fail-safe protection, not a claim of transactional cross-tab locking.

## User paths

- Restrained responsive header selector displays the book name. Explicit new
  book and owner-only rename require verified email. Viewer financial controls
  and import application are read-only; backend authorization remains binding.
- Authenticated template application POSTs explicit user-entered amounts into
  a NEW workspace, retains the account connection and active original ledger,
  refreshes the selector, and never emits bulk marketing-created signals.
  Guest template behavior remains a new local profile.
- POST creation has a 15-second abort timeout, exactly one attempt, no retry.
  Network/timeout/5xx uncertainty blocks new creation until a successful manual
  list refresh; the user must check whether the book already exists. There is
  no server idempotency key, so this is not an exactly-once creation guarantee.
- `합산 보기` starts with zero selected ledgers, caps selection at 20, dedups
  workspace IDs, and requests server totals only for explicit selection.
  It hides individual income/editing, never displays aggregate income/residual
  ratios or savings, and clearly warns that the same actual expense in two
  books counts twice. Unsynced edits are excluded from server aggregate totals.
- No new ledger archive/delete workflow. Existing account deletion boundary,
  guest/sample paths, privacy/GPC/DNT defaults and billing settings are retained.
  Sample-switch wording now distinguishes logout from authenticated ledger
  selection (which keeps the account connected).

## Financial display

Individual monthly summary/category buckets/filtered totals retain raw
`amount/periodMonths` until display rounding. Individual scheduled totals use
the same shared KST calculator as aggregate. `null` is shown as unknown, not
zero; mixed unknown schedules show a count and explicitly excluded charges.
The 30-day figure is scheduled charges, never settled payments. Upcoming
individual reminders use the KST calendar date from the same reference instant.
Aggregate reports its server-sampled date interval. Per-item row monthly amounts
remain rounded display values; totals do not sum those rounded row values.

## Author-run evidence

- `pnpm --filter @living-cost-manager/shared build`: passed.
- `pnpm test:web`: **23 files / 242 tests passed** (2026-10-07 10:12 local).
- `NEXT_PUBLIC_API_BASE_URL=https://api.gamja.top/living-cost-manager/v1 pnpm
  --filter @living-cost-manager/web build`: passed including TypeScript/static
  export. Public API origin is explicit build provenance, not deployment proof.
- `node apps/web/tests/multiledger-browser.mjs`: passed against locally served
  static export at `127.0.0.1:43187`, Chromium 390×844, service workers blocked,
  ALL API calls intercepted with synthetic fixtures. Covers persistent cache
  switching, late pull and push across books, explicit aggregate/no income,
  authenticated template/new-cache initialization/original unchanged, uncertain
  create/no retry, viewer controls, mobile overflow, offline edit/delete/undo
  scope, real second-tab cache conflict and account-erasure events.
- Unit additions cover legacy unsynced migration, conflicting destination,
  account+workspace/ABA sync scopes, all-ledger erasure, shared final rounding,
  duplicate actual expenses, unknown-vs-zero schedules, aggregate SSR copy,
  explicit API routes/dedup and creation timeout without retry.

## Remaining validation / limitations

Parent must arrange independent read-only review and independent testing. The
browser run uses mocks, not a real API+DB end-to-end integration. Full browser
account-switch races (including delayed create/rename), desktop visual review,
keyboard/screen-reader audit and real guarded-local-API end-to-end remain for
independent validation. Conflicting legacy caches are preserved and reported;
there is no new UI that automatically merges or restores that old source.
No production deployment was performed. The credential incident remains OPEN;
identity is unconfirmed and this work does not touch or close it.
