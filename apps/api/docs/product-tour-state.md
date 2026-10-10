# Personal product tour state v1

## Contract and boundaries

The existing API prefix applies (production contract:
`/living-cost-manager/v1/onboarding/product-tour`). Both methods use the
existing `authenticate` helper: access JWT issuer/audience/type/expiry and
current `User.tokenVersion` must match. The subject is `request.user.sub`,
never a client-supplied user ID. Owner/editor/viewer and users without a
workspace may use this free personal preference. Email confirmation is not
required here; existing verification/paid-feature gates are unchanged.

- GET 200: `{ "version": 1, "status": "unseen", "updatedAt": null }` if no
  version-1 row exists; otherwise status is `completed`/`skipped` and timestamp
  is an ISO string. GET never inserts a row.
- PUT accepts **only** `{ "version": 1, "status": "completed" | "skipped" }`.
  Extra keys, string versions, future versions and `unseen` writes are 400.
  Returns the exact GET shape, with the resulting stored state.
- Completion dominates skips, including concurrent/late requests. A single
  parameterized PostgreSQL `INSERT ... ON CONFLICT` evaluates the locked latest
  row; no read-then-write race. Identical/effectively unchanged writes retain
  `updatedAt`. Other version keys are untouched.
- Responses set `Cache-Control: no-store`. Missing/invalid/stale/deleted-account
  tokens are 401. Database/missing-table failures are generic 500, **not** unseen;
  clients must defer the invitation rather than infer a new user.
- Existing limiter mechanism: GET 120/minute, PUT 30/minute, per existing
  route-local IP bucket. This is not a new unlimited/global feature switch.
  The existing test-only limiter bypass is unchanged; a development-mode test
  verifies real 429s. No new proxy trust setting is introduced.

Only finish/skip is recorded, with no per-step analytics, profile fields,
workspace/cost data, marketing/legal consent, payment provider initialization,
or customer-ID enumeration. Default request logging does not serialize the
body, response preference, user email/ID or authorization headers (tested).
Account deletion cascades the preference; existing billing deletion guards and
retention remain in place. This customer preference is not an opskv setting.

## Additive schema and rollout boundary

`20261010000000_user_product_tour_state/migration.sql` creates exactly one table
`UserProductTourState`, composite PK `(userId, version)`, two SQL CHECKs and one
FK to `User` (delete/update cascade). The PK also indexes the FK's leading user
column. No existing table, type or column is altered. The User array in Prisma
is relation metadata only; existing SQL/binaries see the same User columns.
SQL CHECKs are deliberately native PostgreSQL constraints, not Prisma enums.

Migration SHA-256:
`1e572309a5682646eb824f257cc6f4da24b68f58c7184edbcbc6e6fb05a553b7`.
The nine existing migration files are byte-identical to source base
`52f4d129c94fc4e806aca74408c4418034d2fe1e`, including template history. Do not
normalize existing drift, reset the production DB, run a blanket migrate
deploy, or rewrite historical migration checksums to apply this feature.

Unqualified quoted identifiers deliberately use the connection's current
schema/search_path. Before any production application, the main operator must
independently review the SQL, verify the exact database/schema/search_path,
roles, existing migration history and actual absence of the new table. Execute
only this reviewed additive DDL in a transaction with bounded locks, e.g.
`SET LOCAL lock_timeout = '2s'` and `SET LOCAL statement_timeout = '20s'`.
The FK can contend for a referenced-User table lock; a timeout must abort the
whole transaction, not leave a partially created table. Handle the migration
history entry through the separately reviewed deployment procedure; this
implementation does not provide or run a production operator script.

**This child performed no production backup, review, DB command or rollout.**
Owner's scoped approval still requires the main's actual protected backup,
restore rehearsal and independent review before applying. Deploy the table
before the new API; old API clients are additive-compatible. Until the route
is available the frontend must defer on 404/error. Rollback API/web binaries
while retaining this table/state, not dropping customer preferences or
restoring stale credentials. No production environment/CF/mail/ops repo changes
are included. No business outcome or deployment completion is claimed.

## Executed local evidence

Environment: Node 24.18.0, pnpm 11.1.3, frozen lockfile install, disposable
Docker PostgreSQL 16, loopback-only random port, synthetic records only.
Existing `resolveApiTestDatabaseUrl` requires an explicit localhost URL with
test markers in both database and schema. No original `.env` was read/copied.

- `pnpm db:generate`, shared build and API TypeScript build passed.
- Full API suite: **29 files / 448 tests passed** = baseline 422 + new 26.
  Existing reset harness applied all nine unchanged migrations plus the new
  migration to the gated disposable schema. Billing/audit/immutable financial
  tests remain passing.
- New route/service coverage: readonly GET, exact response/ISO date, own-account
  isolation across sessions, all three workspace roles, unverified user,
  strict invalid bodies, access-vs-refresh and stale/deleted tokens, future
  version retention, idempotent timestamps, 50 concurrent mixed writes ending
  completed with one row, CHECK/FK/PK enforcement, cascade, failure safety,
  production-like limiter enforcement and log privacy.
- Existing DELETE `/account` with a synthetic active billing contract remains
  409 and retains preference. When legitimately idle, deletion is 204,
  preference cascades, contract remains detached, token is rejected.
- Exact checked-in DDL rehearsed on a separate disposable test schema while
  another transaction held User ACCESS EXCLUSIVE. It failed with PostgreSQL
  `55P03` at >=1.9 seconds under a 2-second lock budget; rollback left no table.
  After releasing the lock, the same bounded transaction succeeded and had
  precisely one PK, two CHECKs and one FK. Actual missing-table GET/PUT both
  returned generic 500 before application (no SQL leak/fake unseen).
- Generated the actual `260c8d4` Prisma schema into disposable ignored output.
  Old client has no preference delegate and still creates/reads User and
  workspace/memberships alongside new state. Its existing User deletion in a
  transaction cascades the new preference. This is client/DB compatibility,
  not a claim of having run an old production container.
- Separate local DB: replayed only nine baseline SQL files, inserted one
  synthetic user, `pg_dump -Fc`, restored into another disposable test DB with
  `pg_restore --exit-on-error`. Before applying: one retained user and no new
  table. Applied exact new DDL with transaction/2s lock/20s statement limits:
  one retained user and zero preference rows. This proves a **local synthetic**
  backup/restore rehearsal, not a production backup.

Re-run with a freshly provisioned local test database/schema:

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm --filter @living-cost-manager/shared build
pnpm --filter @living-cost-manager/api build
# Provide only the explicitly isolated synthetic API_TEST_DATABASE_URL.
pnpm --filter @living-cost-manager/api test
```

Cold local Docker API build may be run after the local commit using the
existing Dockerfile and `--build-arg RELEASE_SHA=<that-commit>`; its final
execution result belongs in the main handoff. This document does not certify a
release image for the later integrated frontend/backend commit. Independent
read-only review and integrated build/deployment verification remain with main.
