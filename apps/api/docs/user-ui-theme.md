# User UI theme (additive `User.uiTheme`) — backend contract

## Approval context and current status (read first)

- Owner EXPLICITLY approved a new production DB change: add a `uiTheme` field
  (default `jade`) to the user record so the logged-in user's theme persists
  across devices — conditional on backup/restore verification and independent
  review passing ("사용자 정보에 저장 (권장)" selected).
- This document describes the LOCAL implementation on branch
  `feat/jade-user-theme-20261020` (worktree `lcm-jade-user-theme-20261020`,
  base `02c70d1`). **No production SQL was executed, no SSH, no push, no
  merge.** Production application (migration run against the live `lcm`
  schema) remains gated on the Owner's stated conditions.
- Approved shape: exactly one additive TEXT column on the existing `User` row.
  Not a separate table, not a JSON scope change; `WorkspacePlanningState` and
  coaching-intent storage were deliberately NOT (re)used — those carry shared
  financial / private coaching semantics and misusing them is out of contract.

## Storage

`prisma/migrations/20261020120000_add_user_ui_theme/migration.sql`
(SHA-256 `1ba3540c796a3e198803a6b9e3c49c60ae300adb5e329505cd25f5be9e06386b`):

```sql
ALTER TABLE "User"
  ADD COLUMN "uiTheme" TEXT NOT NULL DEFAULT 'jade',
  ADD CONSTRAINT "User_uiTheme_check" CHECK ("uiTheme" IN
    ('jade', 'aqua', 'violet', 'raspberry', 'tangerine'));
```

- Bounded `lock_timeout='5s'` / `statement_timeout='30s'` inside one
  transaction, mirroring `20261018110000_workspace_planning_state`. The runner
  must stop on failure; never silently retry.
- Constant default backfills existing rows as `jade` without a table rewrite
  (PostgreSQL 11+). No DROP, no rename, no financial column touched.
  `User.updatedAt` keeps `@updatedAt` semantics; a theme write is the only
  field changed (plus `updatedAt` itself).
- Rollback boundary: an older app binary on the new DB keeps working — unknown
  column ignored, new inserts take the default. Application rollback MUST
  retain the column (dropping it destroys stored choices and breaks the new
  binary). The rehearsal test covers exactly this old-binary insert.
- SQL CHECK mirrors the `renewalStatus`/`UserProductTourState` precedent:
  TEXT ids, so a future theme is another additive migration, never an enum
  rewrite. The CHECK is defense-in-depth; the API read path still falls back
  to `jade` for any legacy/corrupt value.

## Shared contract (`packages/shared/src/userTheme.ts`, exported from index)

- `UI_THEME_IDS = ["jade","aqua","violet","raspberry","tangerine"]`
- `DEFAULT_UI_THEME = "jade"`
- `uiThemeSchema` — the enum
- `updateThemeRequestSchema` — **request** contract: strictly `{ uiTheme }`;
  unknown keys, including `userId`, are rejected (400). Invalid requests are
  never coerced.
- `normalizeStoredUiTheme(value)` — **stored** fallback only: anything
  missing/unknown maps to `jade`. Invalid stored data reads as `jade` and is
  never rewritten by a GET. The two functions deliberately differ: reject vs
  fall back.
- `userDtoSchema` gained `uiTheme: uiThemeSchema.optional()`. Optional keeps
  pre-migration server payloads parseable during rollout; the API always
  sends a validated id. Frontend (next, sequential scope) consumes these
  exports; the backend is done regardless of frontend landing order.

## API

Existing prefix applies (production: `/living-cost-manager/v1`). Registered in
`authRoutes` beside `GET /me`.

- `GET /me` — `user` DTO now carries `uiTheme` (validated, with read
  fallback). All auth response paths include it via `toUserDto`: register
  (201), login, refresh, change-password re-issue — every `UserRecord` read is
  a full-row `findUnique`, no partial selects feed the DTO.
- `PUT /me/theme` — body exactly `{ "uiTheme": "<one of five>" }`.
  - 200 → `{ "uiTheme": "<stored id>" }` — explicit minimal envelope; GET /me
    keeps the `{ user }` shape. (Chosen for contract consistency: personal
    preference endpoints here return the preference resource itself, like
    product-tour, not a user wrapper.)
  - 400 — invalid enum, missing/null/non-string value, wrong key, or any
    unknown key (`userId`, `workspaceId`, extras).
  - 401 — missing/invalid/stale token (after logout or password change,
    existing `tokenVersion` semantics).
  - Identity is `request.user.sub` only. The body cannot name another user;
    no workspace path parameter exists on this route.
- Authorization policy: `authenticate` only — same documented policy as the
  product tour (personal, harmless UI preference). Email verification,
  workspace membership and owner/editor/viewer roles are NOT required; a
  viewer changing their own theme touches no shared state, private coaching
  intent, tour state or snapshots.
- `Cache-Control: no-store`; route-local limiter PUT 30/minute per existing
  per-route IP bucket mechanism (same values as product-tour PUT). No new
  global switch, no proxy-trust change.
- Writes are last-write-wins — approved for a single theme value only: no
  revision column, no CAS, no conflict semantics, and no authority implied for
  any other preference. Theme writes never rotate `tokenVersion`, never reset
  `name`, and never touch membership/coaching/tour/budget/snapshot data.
- A theme change does NOT flow into LCM1/LCM2 backup payloads: household
  backups carry financial data only; foreign UI preferences must not enter
  the byte-compatible export/import contract.

## Verification performed (local, ephemeral cluster only)

- Ephemeral purpose-built PostgreSQL cluster via the existing
  `scripts/ci/ephemeral-postgres.mjs` (Unix-socket peer auth, no TCP,
  db/role/schema `lcm_ci_test`, reset by `setup-test-db.ts` before every run;
  the test-isolation guard rejects any non-localhost/test-marked URL).
- `packages/shared`: 216/216 tests pass (6 new user-theme contract tests).
- `apps/api`: 494/494 tests, 34 files, `fileParallelism:false` preserved.
  - `user-theme.test.ts` (15 tests): 401s incl. post-logout stale token;
    register/login/refresh//me all carry `jade`; five ids writable; every 400
    class with no write; cross-user isolation (body naming another user is
    400, never writes); unverified-email parity; corrupt stored row reads jade
    with GET not mutating (CHECK temporarily dropped on the synthetic
    ephemeral DB, restored in the same test, then healed by a valid PUT);
    theme survives a full snapshot replace and leaves tour/coaching counts
    untouched.
  - `user-theme-migration.test.ts` (1 long test): exact checked-in SQL against
    an isolated copy schema — bounded lock abort (≥4.9s, column absent, rows
    unchanged), apply (existing row → `jade`), CHECK rejects `magenta` and
    accepts the five, pre-theme-style insert (old binary) still works via the
    default, and a `pg_dump`→restore round trip preserves column, default and
    CHECK; synthetic schemas dropped in cleanup.
- Two pre-existing exact-DTO assertions in `auth.test.ts` were extended by
  adding `uiTheme: "jade"` only — no assertion removed, no auth weakened.
- `pnpm --filter api build` (tsc) and `shared verify:package` pass.

## Ownership / artifact budget (for main's final accounting)

- This task's installs: worktree `node_modules` (pnpm hardlinks from the warm
  store; `--frozen-lockfile`, 0 downloads), `apps/api/dist` and
  `packages/shared/dist` build outputs, and the ephemeral cluster state dir
  `~/lcm-ci-test-pg` (stopped + removed at the end of this task).
- No `.env` was read or created; the DB URL used is the ephemeral socket URL
  only, never a production `DATABASE_URL`. No production user was created and
  no real token was minted anywhere outside the ephemeral cluster.
- Not an opskv setting; no new environment variable exists for themes.

## Remaining gates before production

1. Independent reviewer pass (currently blocked: reviewer quota unavailable —
   explicitly NOT claimed complete; the author's own tests are not a review).
2. Production backup/restore rehearsal per the Owner's condition.
3. CI/capacity manifest promotion path is separate and later: this change
   must not be folded into the existing a2-prepromote pipeline manifest
   without its own review at the exact current base.
