# Multi-ledger integration handoff — 2026-10-07

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

The frontend source directly descends from `317befc`; it does not include the
backend correction. No conflicts occurred. All security/ops helper and incident
documents from the integration base are retained unchanged. No schema changes,
original dirty/untracked file edits, credentials/history investigation, push,
production access, upload or deployment were performed.

Integration fixes are only the expense-only `LedgerSummary` prop type, typed
fetch mock arguments, a structurally compatible legacy-extra-income SSR fixture,
latest no-income aggregate browser fixture and two outdated data-modal texts.
No reviewed authorization, calculation, cache migration or async safety logic
was changed. Backend contract remains current; frontend contract records the
latest totals shape.

## Legacy flow inspection (implementation inspection, not independent review)

- Account/browser profile identity remains in `useLocalUsers`; authenticated
  editable data now uses `ledger:[accountId,workspaceId]` in `useBudgetData`.
  Guest/sample profiles and template-return paths remain supported, not removed.
- Header shows current ledger name and adds the authenticated ledger selector.
  The old data-modal selector remains a supported second entry point to the
  **same** `handleSelectServerWorkspace` save-before-switch/scoped handler.
  Its label now explains this equivalence; its empty-state no longer tells an
  existing account to create another account, instead pointing to new ledger,
  invitations and list refresh. Its historic accessible selector label is
  retained for compatibility. Invitation/member vocabulary remains workspace.
- Authenticated template application creates a new server workspace with
  explicit amounts, refreshes the list and keeps the original active ledger.
  Guest templates still create local profiles; CSV/full-backup import remains
  replacement of the current editable scope with preview/recovery, not ledger
  creation. Viewer/aggregate import application is disabled in page wiring.
- Sample switching explicitly says it disconnects the server; ledger selection
  keeps the account connected. Header logout saves before disconnect, then
  starts a local profile. Account deletion enumerates all deleted-account ledger
  cache/recovery scopes and migration markers, preserving other accounts/guests.
- Migration copies legacy unsynced cache only to the first ledger, never removes
  the source or overwrites a conflicting destination. Scoped undo/import epoch,
  baseline generations and auth-session checks are retained. Aggregate is only
  explicit selected read mode; no combined income/ratios, unknown schedules are
  nullable and scheduled charges are never described as settled payments.

## Implementer-run validation

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

## Readiness and remaining work

Ready to freeze for the main session's independent tester/reviewer, **not**
approved for push/deployment. No independent review was performed here.
Mock browser tests do not establish real API+DB browser integration. Delayed
create/rename account-switch races, desktop/accessibility audit and real guarded
local end-to-end remain for independent validation. No durable create idempotency
or transactional localStorage CAS guarantee is introduced. Existing cache
conflicts remain preserved for explicit recovery, not automatically merged.
Credential incident stays open and untouched pending bounded-history permission.
