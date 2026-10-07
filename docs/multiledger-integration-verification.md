# Multi-ledger integration handoff — 2026-10-07

Historical handoff for frozen `3d2edae` and its earlier tree. The new separate
`multiledger-final` candidate's provenance, current contracts and freshly run
results are in `multiledger-final-verification.md`; do not treat counts below
as new final-candidate validation.

## Source and scope

Isolated approved-temp worktree `lcm-multiledger-integration`, branch
`multiledger-integration`. Actual local `main` ref was
`550686b265a208cf31e1f6b1c1b5b1272b5c6e68`, not the requested latest source.
The new worktree alone was aligned to verified security/ops source
`1d46868a4aa198c6a66004b90b203ee0f4b1b24a`; original checkout/ref unchanged.
`8c4e128` is an ancestor of that source. Cherry-picked exactly once, in order:

- `317befc490902ce3e42dbe89cfde6d2a512d6c06` → `d145fac`
- `6935972af60d06b780cc8a172be85867e42c4965` → `ebfd29d`
- `721f10ac6a0958e0fde43140ca2607573ea181c8` → `97e9110`
- Follow-up `b83921404429b8da17d125c6f178d546587efece` (parent `721f10a`)
  → `4af852f`, applied once onto frozen `e885dcbb25f5d82844dcf11284c537df465cb735`.

The frontend source directly descends from `317befc`; it does not include the
backend correction. Initial integration had no conflicts. Follow-up conflicts
in `LedgerSummary` and `ServerSyncPanel` were resolved by retaining the
expense-only `WorkspaceAggregateTotals` type and adopting the follow-up's
`가계부` labels/read-only modal context (no competing modal selector/callback).
Existing typed API/SSR fixtures and income-free browser response were retained.
All security/ops helper and incident
documents from the integration base are retained unchanged. No schema changes,
original dirty/untracked file edits, credentials/history investigation, push,
production access, upload or deployment were performed.

Initial integration fixes were only the expense-only `LedgerSummary` prop type, typed
fetch mock arguments, a structurally compatible legacy-extra-income SSR fixture,
latest no-income aggregate browser fixture and two outdated data-modal texts.
No authorization/calculation semantics were changed by integration resolution.
The assigned frontend follow-up intentionally updates exit guards, legacy cache
fallback prevention, sample-return validation and account-level mutation safety.
Backend contract remains current; frontend contract records the latest totals
shape and source-author follow-up evidence (not independent combined signoff).

## Legacy flow inspection (implementation inspection, not independent review)

- Account/browser profile identity remains in `useLocalUsers`; authenticated
  editable data now uses `ledger:[accountId,workspaceId]` in `useBudgetData`.
  Guest/sample profiles and template-return paths remain supported, not removed.
- Header `현재 가계부` is now the only selector. The obsolete data-modal picker
  and callback are removed; the modal shows read-only account/current-ledger
  context and points to the header. Empty-state guidance points to new ledger
  or invitations, not a new account. Invitation/member internals remain Workspace.
- Authenticated template application creates a new server workspace with
  explicit amounts, refreshes the list and keeps the original active ledger.
  Guest templates still create local profiles; CSV/full-backup import remains
  replacement of the current editable scope with preview/recovery, not ledger
  creation. Viewer/aggregate import application is disabled in page wiring.
- Common persistence-guarded logout is used by header and sync modal. It creates
  a distinct empty guest instead of exposing a legacy server profile. Sample
  return records account/workspace/profile without tokens and validates fresh
  identity/membership/role; invalid authentication falls back to an empty guest.
  Legacy source bytes remain preserved and available through authenticated raw
  JSON export, never silently editable. Account deletion enumerates all deleted-account ledger
  cache/recovery scopes and migration markers, preserving other accounts/guests.
- Migration copies legacy unsynced cache only to the first ledger, never removes
  the source or overwrites a conflicting destination; a session originally
  lacking a selected workspace cannot later hydrate an unknown legacy source.
  Scoped undo/import epoch,
  baseline generations and auth-session checks are retained. Aggregate is only
  explicit selected read mode; no combined income/ratios, unknown schedules are
  nullable and scheduled charges are never described as settled payments.
- Account-specific durable pending/uncertainty state survives late account
  responses, reloads, aggregate toggles and list refresh. Only explicit user
  confirmation acknowledges uncertainty; no automatic POST retry is introduced.

## Initial frozen-tree validation (historical `e885dc`, not follow-up results)

Commands run in this isolated worktree:

- `pnpm install --offline --frozen-lockfile`: passed.
- `pnpm db:generate`: passed (generation only; no DB connection). Initial API
  build before generation failed on missing generated Prisma exports; rerun passed.
- `pnpm --filter @living-cost-manager/shared build`: passed.
- `pnpm --filter @living-cost-manager/api build`: passed.
- `pnpm --filter @living-cost-manager/web exec tsc --noEmit`: passed.
- `pnpm --filter @living-cost-manager/shared test`: 12 files / **166 passed**.
- `pnpm test:web`: 23 files / **242 passed**, rerun after integration fixes.
- `NEXT_PUBLIC_API_BASE_URL=https://api.gamja.top/living-cost-manager/v1 pnpm
  --filter @living-cost-manager/web build`: passed, TypeScript and static export.
  Explicit production origin is build provenance only; nothing uploaded.
- `API_TEST_DATABASE_URL=postgresql://lcm_integration_test@127.0.0.1:55447/lcm_integration_test?schema=integration_test pnpm test:api`:
  18 files / **266 passed** on a newly initialized, synthetic, localhost-only
  PostgreSQL 16 cluster. Repository test guard validated test database/schema
  before migrations/reset. Cluster stopped afterward. First startup failed due
  to the long Unix socket pathname; rerun disabled Unix sockets and used TCP.
- `node apps/web/tests/multiledger-browser.mjs`: passed at local static server
  `127.0.0.1:43187`, mobile 390×844, blocked service workers, all API calls mocked.
  Covers cache switch, late pull/push, aggregate, template/original preservation,
  uncertainty/no retry, viewer, overflow, offline/undo, cross-tab conflict/erasure.
- Original checkout `git status --porcelain=v1` before/after matched. This is
  status evidence, not a claim of an independent byte-level preservation audit.

Logs in the approved temp parent directory: `lcm-integration-install.log`,
`lcm-integration-shared-tests.log`, `lcm-integration-web-tests.log`,
`lcm-integration-web-build.log`, `lcm-integration-api-tests.log`,
`lcm-integration-browser.log`. Local cluster path is recorded in
`lcm-integration-pg-path.txt`.

## Follow-up combined-tree validation — 2026-10-07 10:34–10:35 local

Freshly executed after `4af852f` (all passed):

- `pnpm --filter @living-cost-manager/shared build`
- `pnpm --filter @living-cost-manager/api build`
- `pnpm --filter @living-cost-manager/web exec tsc --noEmit`
- `pnpm --filter @living-cost-manager/shared test`: **12 files / 166 tests**.
- `pnpm test:web`: **24 files / 246 tests**.
- `NEXT_PUBLIC_API_BASE_URL=https://api.gamja.top/living-cost-manager/v1 pnpm
  --filter @living-cost-manager/web build`: fresh static export/TypeScript pass;
  no deployment metadata stamped and no upload performed.
- `node apps/web/tests/multiledger-browser.mjs`: broad mocked mobile suite pass.
- `node apps/web/tests/multiledger-review-browser.mjs`: **6 scenarios passed**,
  including exact legacy100 preservation/noneditable guest vs scoped200,
  fresh viewer sample return, invalid-auth return, refused quota-failure exit,
  aggregate/workspace pending creation and late-account/reload uncertainty.
  Both browser scripts used localhost static export, synthetic data, intercepted
  API requests and blocked service workers. The owned local server was stopped.

API DB tests were **not rerun on the follow-up tree**; the 266 above are explicitly
historical. Real API/browser verification is reserved for the main's tester.
Fresh logs in the approved temp parent: `lcm-integration-followup-builds.log`,
`lcm-integration-followup-shared-tests.log`, `lcm-integration-followup-web-tests.log`,
`lcm-integration-followup-web-build.log`, `lcm-integration-followup-browser.log`,
`lcm-integration-followup-review-browser.log`, `lcm-integration-followup-local-server.log`.

## Readiness and remaining work

Ready to freeze for the main session's independent tester/reviewer, **not**
approved for push/deployment. No independent review was performed here.
Mock browser tests do not establish real API+DB browser integration. The assigned
held-create scenarios passed with mocks, but full independent create/rename
account-switch race coverage, desktop/accessibility audit and real guarded
local end-to-end remain for independent validation. No durable create idempotency
or transactional localStorage CAS guarantee is introduced. Existing cache
conflicts remain preserved for explicit recovery, not automatically merged.
Credential incident stays open and untouched pending bounded-history permission.
