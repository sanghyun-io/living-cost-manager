# Multi-ledger frontend integration — 2026-10-07

Final combined candidate additionally integrates frontend `4ccf609` and debugger
`dd91a10` atop frozen integration `3d2edae` in a separate worktree. Current
sample-return persistence/live-registry and applied-current-list reconciliation
contracts, fresh combined test results and pending independent checks are in
`multiledger-final-verification.md`. Source-author results below remain historical.

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
  list refresh AND explicit user reconciliation; the user must check whether
  the book already exists and acknowledge possible delayed completion. There is
  no server idempotency key, so this is not an exactly-once creation guarantee.
- `합산 보기` starts with zero selected ledgers, caps selection at 20, dedups
  workspace IDs, and requests server totals only for explicit selection.
  It hides individual income/editing, never displays aggregate income/residual
  ratios or savings, and clearly warns that the same actual expense in two
  books counts twice. Unsynced edits are excluded from server aggregate totals.
- No new ledger archive/delete workflow. Existing account deletion boundary,
  guest/sample paths, privacy/GPC/DNT defaults and billing settings are retained.
  Authenticated sample entry now retains the connection but disables server
  sync; exit verifies the same account and current ledger membership/role.

## Financial display

Integrated contract: backend `6935972` exports `WorkspaceAggregateTotals`
without `monthlyIncome`. `LedgerSummary` accepts these expense/schedule-only
fields (individual summaries remain structurally compatible). The browser
fixture now uses that latest shape; the SSR regression additionally verifies
that a legacy response's extra income field is never displayed.

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

## Independent-review follow-up (2026-10-07)

Integration provenance: source follow-up
`b83921404429b8da17d125c6f178d546587efece` was subsequently cherry-picked as
`4af852f` onto `multiledger-integration` at `e885dc`. The source-author account
below describes its original isolated frontend branch. Combined-tree execution
and remaining independent verification are recorded separately in
`multiledger-integration-verification.md`; expense-only aggregate totals remain
bound to backend `6935972`.

The parent independently reproduced three defects in `721f10a`. This follow-up
changes only this frontend branch, not the active integration worktree:

1. All visible account exits use one persistence-guarded page handler, including
   the sync dialog. Logout creates a unique empty `guest:<uuid>` profile, never
   reactivates `server:<user>` legacy data. The budget hook also refuses that
   fallback if auth disappears independently. Exact legacy sources remain
   preserved and have an authenticated raw-JSON export (no automatic hydration).
   A session with no original selected workspace records that fact, so later
   creating/selecting a book cannot inherit an unknown obsolete source.
2. Sample return metadata stores account+workspace+profile identity, with no
   tokens. Sample entry saves the outgoing ledger and isolates editable demo
   data. Return verifies `/me` identity and fresh membership/role. Revoked or
   unconfirmed authentication returns to a distinct empty guest. Logout during
   sample clears the return pointer. No guest/account cache is copied across.
3. Pending creation and ambiguous outcomes belong to the ACCOUNT, not the
   selected-ledger/read-only-view epoch. A pre-POST durable marker prevents a
   reload from becoming a blind retry. Late results update their originating
   account's state even after scope/logout/account changes; other accounts do
   not display that uncertainty. Aggregate toggles cancel only read requests.
   Refresh shows the actual list but does not clear uncertainty: explicit user
   acknowledgment of delayed-completion/duplicate risk is required. This still
   is NOT an exactly-once guarantee or server transaction reconciliation.
4. The header `현재 가계부` chooser is authoritative. The competing sync-modal
   selector and callback route are removed; the modal shows read-only current
   context and guarded sync actions. Creation/rename respect readiness, role,
   verification, account-pending and uncertainty conditions. User-facing ledger
   terminology is `가계부`; guide text no longer describes authenticated
   templates as logging out. API/internal identifiers remain Workspace.

Regression browser evidence uses local static export and exclusively synthetic
fixtures. `multiledger-review-browser.mjs` has six reproduced scenarios:
modal logout (scoped 200 vs preserved legacy 100, downloadable exact source),
sample return (200 with freshly changed viewer role) and sample logout,
invalid-auth sample return, quota failure refusing exit, held POST → aggregate
→ workspace switch → network failure, and held POST → logout → account B →
late failure → account A → reload. Both held-POST cases make exactly ONE POST;
refresh alone keeps creation disabled. The existing broader mock-browser suite
is retained. The uncertainty screenshot and raw-source download are synthetic
evidence at approved-temp `multiledger-review-uncertainty.png` and
`multiledger-review-synthetic-legacy.json`; no original captures/logs were erased.

New hook tests exercise actual `useLedgers` with dependency-aware hook state:
account pending/read epoch separation, late-account outcomes, durable reload,
explicit reconciliation, and refusal before POST when marker persistence fails.
An additional storage test covers unknown original-workspace migration. The
parent must independently review/test this follow-up and compile against its
latest backend `6935972`; this branch intentionally does not cherry-pick that
backend or claim latest-backend integration, production validation or signoff.

Follow-up author validation at 2026-10-07 10:31 local: web **24 files / 246
tests passed**; explicit-production-API static export and TypeScript passed;
all **6 review-reproduction browser scenarios** and the existing broad browser
regression script passed. Both scripts intercepted every API request and used
only synthetic local data. `git diff --check` passed. No independent follow-up
review or real API/DB/production validation is claimed.

## Second independent-review follow-up (parent `b839214`, 2026-10-07)

The original three findings were independently closed, but two new sample-return
race findings were reported. This follow-up is scoped to `useLocalUsers.ts`, its
synthetic browser regressions, and this contract; it does not modify the frozen
integration revision `3d2` or its active independent tester/reviewer work.

- Permission requests no longer mutate auth/session/selection before final
  outgoing persistence. A live render ref plus return generation checks the
  outgoing profile, authenticated account/workspace, and active storage pointer.
  AFTER `/me` and membership validation, the latest outgoing save callback is
  invoked immediately before the synchronous transition, with no intervening
  await. This guard also applies to invalid-auth/deleted-target guest fallback.
  Quota/conflict failure keeps the current sample and latest memory edits and
  displays a refusal message. Editing while permission validation is pending
  remains supported; disabling the editor is not used as a substitute for save.
- Return/fallback registry writes use freshly loaded, tombstone-filtered storage,
  never the pre-request list or an in-memory registry fallback. Account targets
  must still exist in that live registry with matching account identity and no
  erasure marker. Successful permission responses cannot resurrect erased
  metadata, financial caches, session, or account selection. Existing server
  profile cache is not seeded by this path. Legitimate concurrent guest/profile
  entries are preserved. Adjacent login/logout registry reads and template-return
  target lookup now likewise use live filtered storage. No tombstone is cleared
  and no legacy backup is deleted by these changes.

Author validation on final source at 2026-10-07 10:39: **24 files / 246 Vitest
tests passed** (count unchanged); TypeScript and explicit-origin static export
passed. The review browser script now passes **13 scenarios: original 6 + 7
new race cases**, covering newer return cancellation, newer logout cancellation,
latest sample edit persistence, held `/me` with sample edit + quota failure for
both successful and failed permission responses, and actual second-page erasure
plus concurrent guest registration for both successful and failed responses.
The broader `multiledger-browser.mjs` script also passed. The final added browser
case was executed after that build without further implementation changes.
Commands: `pnpm test:web`;
`NEXT_PUBLIC_API_BASE_URL=https://api.gamja.top/living-cost-manager/v1 pnpm --filter @living-cost-manager/web build`;
`node apps/web/tests/multiledger-review-browser.mjs`;
`node apps/web/tests/multiledger-browser.mjs`; `git diff --check`.
Synthetic follow-up evidence uses separate approved-temp filenames
`multiledger-rereview-uncertainty.png` and
`multiledger-rereview-synthetic-legacy.json`.

This is author verification on the isolated frontend branch, NOT a PASS claim
for frozen integration `3d2`, latest backend `6935972`, independent rereview,
real API/DB, production, or desktop/screen-reader validation. localStorage checks
are not transactional cross-tab locking; creation has no backend idempotency
guarantee. Production and credentials remain untouched; no subdelegation.
