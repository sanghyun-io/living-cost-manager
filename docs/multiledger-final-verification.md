# Final multi-ledger candidate — 2026-10-07

## Frozen source provenance

New isolated worktree:
`/private/var/folders/f_/kdvkncsn11l2nssxg_75xglc0000gp/T/opencode/lcm-multiledger-final`,
branch `multiledger-final`, created from frozen
`3d2edae6ba634e2ba45686b65af09e4cded57123`.
The old integration worktree/branch and tester source were not modified.

Exactly these two new commits were cherry-picked, with no conflicts:

- Frontend `4ccf6094dae5ee2617735df61f83f0ddc5aa9a4a` (parent `b839214`)
  → `d317993`; its parent is already integrated as `4af852f`, not reapplied.
- Debugger `dd91a10d978fafb6b188dd8cab09aacd0ec32327` (parent frozen `3d2edae`)
  → `6fd31e5`.

No extra functional integration changes or test-type repairs were necessary.
Only verification/contract documentation was added after these picks. Existing
income-free aggregate type, backend/shared sources, schema, security/ops helpers
and incident documents remain unchanged. No original dirty/untracked file edits,
credential/history lookup, production access, push, deployment or instruction
changes were performed. Original checkout status was captured before/after;
status equality is not a claim of an independent byte-level preservation audit.

## Current combined contracts

- The header `현재 가계부` remains the sole authoritative selector; sync modal
  context is read-only. Guest/sample flows remain supported, not deleted.
- Sample return validates identity/permission asynchronously, then revalidates
  generation, outgoing sample persistence and freshly read tombstone-filtered
  registry before switching on both successful return and guest fallback.
  Latest edits made while permission reads are pending must save successfully;
  failed persistence refuses exit. Concurrent legitimate registry entries survive
  and erased account/profile metadata cannot be reactivated. Legacy caches and
  raw-source backups are not removed.
- `loadServerWorkspaces` now returns an explicit `applied` or `discarded`
  result. Applied results carry an `isCurrent` predicate bound to list request,
  identity/mode epoch and existing sync safety. Discarded, failed or superseded
  reads do not establish that the displayed list has been reviewed.
- Creation reconciliation requires an applied, still-current list read plus
  explicit acknowledgment. A refreshed/discarded empty array is not proof of
  failed creation; account pending/uncertainty markers are not blindly cleared.
  No automatic POST replay or server idempotency guarantee is introduced.
- Aggregate remains explicit selected read-only mode with expense/schedule-only
  totals, no combined income/ratios. Unknown schedules remain nullable; scheduled
  charges are not settlement evidence. Reviewed API authorization/calculation
  semantics are unchanged.

## Fresh implementer-run validation

Executed on the combined final candidate at 2026-10-07 10:42–10:43 local:

- `pnpm install --offline --frozen-lockfile`: passed.
- `pnpm db:generate`: passed; client generation only, no DB access.
- `pnpm --filter @living-cost-manager/shared build`: passed.
- `pnpm --filter @living-cost-manager/api build`: passed.
- `pnpm --filter @living-cost-manager/web exec tsc --noEmit`: passed.
- `pnpm --filter @living-cost-manager/shared test`: **12 files / 166 passed**.
- `pnpm test:web`: **25 files / 253 passed** (includes 7 new reconciliation tests).
- `NEXT_PUBLIC_API_BASE_URL=https://api.gamja.top/living-cost-manager/v1 pnpm
  --filter @living-cost-manager/web build`: passed; fresh TypeScript/static export
  from this worktree, explicit production API origin. No metadata-only stamping,
  upload, release or runtime readiness claim.
- `LCM_BROWSER_ORIGIN=http://127.0.0.1:43189 node apps/web/tests/multiledger-browser.mjs`:
  broad mocked mobile regression suite passed.
- `LCM_BROWSER_ORIGIN=http://127.0.0.1:43189 node apps/web/tests/multiledger-review-browser.mjs`:
  **13 scenarios passed**, including latest sample edits, quota-failure refusal,
  newer return/logout cancellation, second-page erasure/concurrent registration,
  legacy100 vs scoped200, viewer permission refresh and account creation races.
  Both scripts use synthetic data, intercepted API requests and blocked service
  workers. Owned localhost static server stopped by an exit trap afterward.
- `git diff --check`: passed.

Logs in the approved temp parent directory: `lcm-final-install.log`,
`lcm-final-builds.log`, `lcm-final-shared-tests.log`, `lcm-final-web-tests.log`,
`lcm-final-web-build.log`, `lcm-final-browser.log`, `lcm-final-review-browser.log`,
`lcm-final-local-server.log`. Earlier integration and source-author logs are
preserved and are not presented as fresh final-candidate results.

## Remaining validation / approval

Ready for main's tester source-revision upgrade and independent combined review.
Source-fix independent review outcomes were pending when assigned; no review PASS
or approval is claimed here. Full API DB tests were **not rerun** and no real DB
was restarted; historical API counts in the older verification document do not
validate this final tree. Real guarded-local API/browser E2E, full independent
race/a11y coverage and combined review remain required. Mock scenarios are not
real API/browser proof. No transactional localStorage CAS or exactly-once create
guarantee is claimed. Credential incident remains untouched/open pending bounded
historical-record permission. Static build success is not a deployment/release
claim; no push or service launch was performed.
