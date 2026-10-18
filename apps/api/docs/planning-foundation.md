# Workspace planning foundation (local readiness, 2026-10-18)

This is server/shared groundwork, not a deployed feature. No frontend, production
database, credential, workflow or infrastructure was changed. All new financial
state is workspace-shared; private coaching intent is neither reused nor archived.

## Contract

`GET /workspaces/:workspaceId/planning`: authenticated current members, including
viewers. Does not create a row. Returns:

```json
{
  "workspaceId": "workspace-id",
  "revision": 0,
  "currentSnapshotVersion": 0,
  "data": { "schemaVersion": 1, "paydayDay": null, "weekStartDay": 1, "weeks": [], "reserves": [] }
}
```

`PUT` same path: verified owner/editor only. Body is exactly
`{ expectedRevision, expectedSnapshotVersion, data }`; response has the GET shape.
Never automatically retry a 409 or adopt the returned/server revision and overwrite.
Reload BOTH budget snapshot and planning, ask for reconciliation, then save explicitly.
All successful responses are `Cache-Control: private, no-store`; body cap 512 KiB.
Invalid bodies/query fields: 400; no membership/missing workspace/viewer writes: 403;
unauthenticated/revoked JWT: 401; corrupt/unavailable storage: safe 503. A 503 is not
an empty server state. Preserve local financial data on all failures.

Shared exports in `packages/shared/src/planning.ts`:
`workspacePlanningDataSchema`, `workspacePlanningSchema`,
`putWorkspacePlanningSchema`, `planningWeekSchema`, `planningReserveSchema`,
`planningDateSchema`, `WorkspacePlanningData`, `WorkspacePlanning`,
`PutWorkspacePlanning`, `createDefaultWorkspacePlanningData`, `planningWeekEnd`.

- `paydayDay`: null or integer 1..31 (calendar clamping belongs to the future UI).
- `weekStartDay`: ISO Monday=1 through Sunday=7, default **1 (Monday)**. Every weekly
  `weekStart` must match it. Changing this setting with history requires explicit
  reconciliation; no automatic history remapping/deletion.
- `weeks` (max 520): `{weekStart, budgetAmount, spentAmount, recordedAt}`.
  Dates are real four-digit-year `YYYY-MM-DD`; week starts must be no later than
  `9999-12-25`, so their inclusive start+6 UTC calendar-day end stays within that
  range. `planningWeekEnd` checks the same start bound before arithmetic. Reserve
  due dates retain the full date range through `9999-12-31`.
  Amounts: null or integer KRW 0..2147483647. Null actual means
  **unknown**, not zero; zero actual requires an ISO timestamp. `recordedAt` must
  be null iff `spentAmount` is null. Budget zero is valid. Unique starts required.
- `reserves` (max 1000): `{id, costId, savedAmount, targetAmount, targetDueDate,
  recordedAt, costLabel?}`. IDs max 200 chars, unique reserve ID and one reserve
  per cost ID. Amounts have the same null/zero bounds. Due date nullable real date;
  label optional max 120 chars, a historical/orphan display snapshot only. Any
  non-null recorded saved/target/date requires an ISO timestamp. Null target means
  future clients may display the current item's amount, **not** a server-recorded
  value. Unknown fields and unknown schema versions are rejected, not stripped.
- No automatic expiry, pruning, reserve reset, or cost existence lookup. Resolve
  active cost references at consumption; preserve orphaned values and histories.
- Monthly review can derive from weekly history; no separate persisted review
  settings/state is added speculatively. Simulations need no persisted ledger write.

## Storage, concurrency and backups

Exactly one new table: `WorkspacePlanningState` with workspace PK/FK, revision,
JSONB payload and timestamps; one optional Prisma Workspace relation. No existing
column changes, no FixedCost FK. Snapshot delete/recreate therefore cannot clear
planning. An old snapshot body cannot overwrite planning.

Planning writes reauthorize membership (row SHARE lock) and verified email inside
a Serializable transaction. They lock Workspace FOR UPDATE, compare syncVersion
and planning revision, and conditionally increment the planning revision. No
Workspace syncVersion increment on planning-only writes. Narrow creation unique
conflicts and PostgreSQL serialization/deadlock failures become manual 409s.
Unrelated unique/storage failures remain safe 503s. There is no automatic retry.

Both financial writers use the same Workspace lock. Every successful planning PUT
appends one existing BackupSnapshot containing full current budget plus
`planning: {revision,data}` in the same transaction. Budget PUT archives its current
planning too, while its public GET/PUT shape remains unchanged. New budget archives
record the resulting syncVersion (previous archives used the submitted version).
History summaries still consume the old top-level budget fields. No private intent,
membership metadata or credentials are copied into shared archives. Backup failure
rolls back the complete write. Existing archive retention is unchanged; growth must
be capacity-monitored, never silently pruned by this foundation.

## Production DB approval gate — CONDITIONALLY APPROVED, NOT EXECUTED BY THIS TASK

SQL: `prisma/migrations/20261018110000_workspace_planning_state/migration.sql`.
It wraps CREATE TABLE + Workspace FK in one transaction, with `lock_timeout=5s`
and `statement_timeout=30s`. Workspace FK acquisition can block writers; this is
not a zero-lock/zero-downtime guarantee. On lock failure stop and inspect migration
state/locks; do not loop retries or mark a failed migration applied without proof.

On 2026-10-19 Owner explicitly approved this reviewed single additive migration and
API promotion through GitHub Actions, conditional on fresh backup/restore and the
reviewed gates. **Do not request the same-scope approval again.** Approval is not
evidence of execution or fulfilled gates; this backend subagent performs no
production writes/infrastructure changes. The approved boundaries remain:

> Approve only the additive WorkspacePlanningState migration on the confirmed LCM
> production database through the reviewed GitHub Actions + Mac Mini pipeline,
> after a fresh protected consistent backup, verified size/free-space, and a
> successful isolated restore rehearsal. Permit a bounded maintenance window for
> the Workspace FK lock (5s acquisition / 30s statement timeout); abort on unexpected
> writers, failed backup/restore/locks/migration, or identity mismatch. No existing
> columns/data changes, no new providers/paid resources, no manual OCI fallback.
> Promote the exact tested API digest only after migration verification. Rollback
> switches only to a confirmed compatible previous API image and retains the new
> table, all planning rows, and backups. Any destructive restore needs separate approval.

Before applying, record exact DB/schema and current image digest, pending migration
inventory, backup location/access/restore verification, writer/timer inventory and
the planned maintenance/health checks. Never print rows or secrets. Existing
pre-billing images are not safe writable rollback targets. Old API compatibility
does not imply it can archive newly added planning on its own old snapshot writes;
planning storage and already-written archives remain intact. Prefer forward fix.

Local tests cover exact checked-in SQL lock-timeout rollback, unchanged synthetic
preexisting rows, successful additive application and isolated pg_dump/restore;
the actual generated `260c8d4` client remains writable beside the new table and
cannot clear planning during cost replacement. This does **not** verify production
capacity, privileges, backup freshness, lock contention, or remote image re-pull.

## Actions API deployment feasibility — historical foundation plan

The following records the original foundation assessment. A separate CI implementer
subsequently committed `93bd2fd1e267fbe630a6c95a6de14098d0f4afcd`; that pipeline
change is outside this backend follow-up's edit/review scope. Any earlier image or
artifact proof for that SHA does not establish identity for the newer backend fixes.
Main must use freshly built/tested exact-SHA artifacts and recheck conditional gates.

Read-only source evidence: `.github/workflows/ci.yml`, `apps/api/Dockerfile`,
`DEPLOYMENT_MIGRATION.md`, and the gamja-ops runner worktree `assets/services.yaml`
LCM entry. Current Actions builds/tests API but deploys **Pages only**. Registry
metadata records runtime API `a2c7bd9...`, OCI Compose project `livingcost`,
`/opt/livingcost/docker-compose.yml`, container `livingcost-backend`. The deployment
markdown's October 3 operator steps are historical and must not be used as a manual
fallback; the newer registry records remote image re-pull as unverified.

A separate implementer/main must create and review an Actions API promotion path:
repository-scoped existing `self-hosted, macOS, ARM64, lcm-production` runner;
protected exact SHA, serialized environment promotion; gated tested build artifact;
existing approved registry (historically OCIR `livingcost/backend`), verified push
and re-pull digest; protected credential delivery via existing opskv references only;
approved migration job before API activation; narrow existing SSH identity only for
the target Compose backend image update; preserve other services/env/networks;
compare release SHA/header and separately perform DB readiness + authenticated
synthetic planning/snapshot read/write checks. Retain compatible rollback digest.

Current workflow has `contents: read` and no API publish capability. OCIR publishing
does not need GitHub `packages: write`; grant that narrowly only if an independently
approved existing GHCR target is actually selected. Do not invent a registry, IAM,
provider secret or paid resource. Verify existing identity/auth/pull capabilities
without exposing secret values. Runner label/mode alone is not OS isolation. Update
the central gamja-ops registry/runbook during the actual infrastructure change.
No workflow, SSH, registry or provider call was made by this backend task.

## Local verification

- Shared: 210 passing (197 existing + 13 new), rerun on the edge-fix follow-up.
- Last full API regression: 475 passing on the Monday-default revision (including
  two migration rehearsals). Current edge-fix focused API regression: 47 passing
  across planning, snapshot and billing-unit tests, including three new cases.
  The full updated API suite has not been rerun locally; it remains for fresh CI.
- Shared/API TypeScript builds passed on the Monday-default revision; no new build
  was run for the capacity-constrained edge follow-up. No dependency installs or new dependencies.
- API tests use only a dedicated Unix-socket peer-auth ephemeral PostgreSQL cluster,
  TCP disabled, synthetic data. No production DB or real user browser touched.
- Independent read-only reviewer/security review remains the main session's duty;
  this subagent did not delegate or claim independent review/deployment completion.

Resource receipt: measured free space was 27 GiB before, 26 GiB after (parallel
activity means this is not attributable to this task). Budget was 1 GiB peak ×1.2
+ 1 GiB recovery reserve + 15 GiB floor, under measured availability. Owned test
clusters under the approved OpenCode temp root `p9c4` and
`lcm-planning-20261018-a9c4` were stopped/removed; the failed first start exceeded
the Unix socket path limit. The existing helper refused the no-state failed-start
cleanup (`pidAlive(0)` edge), so exact owned data/socket paths were removed only
after PG_VERSION/UID checks, no postmaster.pid, and pg_ctl status=3. No helper or
other process was modified/killed. A shell source attempt on the synthetic GitHub
env file also failed on unquoted `&`; subsequent tests passed the URL as a quoted
environment value, without executing env-file contents. Initial test failures were
fixed: narrow raw PostgreSQL serialization mapping, updated mock/expected archive
version, and libpq URI spaces (`%20`, not `+`). Final tests/builds all passed.

Remaining evidence is <200 KiB total in those two exact temp directories
(test logs + failed-start log; no cluster/data/socket remains). Ignored legacy
generated clients self-cleaned. Existing small shared/API dist outputs (204/572
KiB) are retained for main-session handoff/tests; phase-1 web output/node_modules
were not deleted. No remaining task-owned large artifact, new installation,
browser profile, Docker image or global cache cleanup.

Monday-default follow-up: new empty planning now defaults to ISO 1 (Monday).
Explicit Sunday (7) remains supported and Sunday fixtures select it deliberately;
no persisted history is remapped. The future MVP UI must not expose weekday changes
with existing history without explicit reconciliation. Shared 209/API 475 tests
and both TypeScript builds were rerun successfully. The follow-up's owned peer-auth
test cluster `p1d7` was stopped and its data/socket removed; 48 KiB of evidence is
retained there. Free space before/after was 25 GiB, within the same approved budget.
No migration, archive/locking policy, CI, frontend or production change was made.

2026-10-19 edge follow-up: bounded weekly end dates and a typed backend-only
`PlanningStorageUnavailableError` now make corrupt/future planning return the same
safe 503 during budget snapshot PUT, while the transaction rolls back all budget,
planning and archive rows. Only this error is mapped; unrelated authorization,
version-conflict and database errors keep their existing behavior. Tests compare
the entire pre/post workspace financial graph, including timestamps and archives.

Capacity precheck measured 17,619,860 KiB available (~16.80 GiB), exceeding the
focused 0.2 GiB peak ×1.2 + 1 GiB recovery reserve + 15 GiB floor (=16.24 GiB).
Only one owned peer-auth socket-only test cluster `p5b1` was started. The focused
test run used a task-owned temporary Vitest alias to the shared **source** exports,
avoiding a dist build and ensuring the new boundary validation was exercised.
The cluster was stopped and data/socket removed after tests; the temporary test
configuration was removed too. Remaining logs occupy 20 KiB. Final free space was
17,617,860 KiB (~16.80 GiB), not an exact task-attributed delta. No image, dependency, generator, full build,
production operation or other actor's files/cache were touched. Independent
review/security recheck and fresh exact-SHA CI remain Main's next steps.
