# Actions API promotion pipeline — feasibility + readiness (2026-10-19)

STATUS: readiness only. NOTHING in this document has been executed against
production: no push of this branch, no workflow trigger, no OCI image load,
no database migration, no service change, no opskv write, no registry
operation, no new credential/paid resource. The pipeline below is built,
locally behaviour-tested, and awaiting independent review before ANY run.

## 1. Owner-approved scope (single reference)

2026-10-19 explicit approval covers exactly: the additive
`20261018110000_workspace_planning_state` migration plus API image promotion
through GitHub Actions → Mac Mini runner on the confirmed LCM production
target, with fresh protected backup + isolated restore rehearsal +
verified capacity/target/image identity; lock 5s / statement 30s; halt on
failure, no blind retry; zero deletion of existing data; rollback = old
compatible API image only with the new table/rows/backups retained; no new
paid resources or key rotation. It does NOT authorize any other database,
product, security weakening, root/elevation grants, or new provider keys.
Do not re-ask for this same scope; do not extend past it.

## 2. Measured facts (read-only, 2026-10-19)

### Mac Mini (build/CI host)
- Docker client 29.5.3 / engine 29.5.2 (colima, linux/arm64 server) —
  matches the OCI host platform. Existing engine left untouched: never
  started/reconfigured/reset/pruned; only `lcm-ci-*`-named owned resources
  are created and torn down.
- Free space measured 25 GiB at session start (22.4 GiB at build time —
  concurrent sessions move this; the budget gate is evaluated at RUN time):
  required ≥ floor 15 + peak 4×1.2 + reserve 1 = 20.8 GiB. Floor is policy
  and is never lowered here.
- Runner `lcm-macmini` at `/Users/sanghyun/actions-runner-lcm` runs as the
  owner uid (sanghyun) — pre-existing, user-kept deviation (see
  gamja-ops runbooks/lcm-macmini-ci-runner-20261017.md §6.4/§7). It already
  has the operator SSH path; no keys are copied into GitHub, the repo, or
  artifacts. SSH config `gamja-oci` → ubuntu uid1001 with a pinned
  dedicated user-known-hosts file; `StrictHostKeyChecking` is never relaxed
  and no host keys are touched. Passwordless `sudo` on the OCI host is the
  existing operator path used by every recorded paired release (root-owned
  0600 compose/env files); automating it grants nothing new.

### OCI host (runtime/deploy target only — never built on)
- `gamjaworld-prod-main-vnic`, aarch64, Docker 29.1.3, `/` free 9.1 GiB
  (helper enforces a 4 GiB floor before its own writes + size guards: dump
  ≤1 GiB (daily dumps measured ≈90 KB), archives ≤3 GiB).
- Compose: project `livingcost`, `/opt/livingcost/docker-compose.yml`,
  services `backend` + `cloudflared` ONLY; backend: env_file
  `/opt/livingcost/api/.env`, networks `lcnet`+`gamjadata`, port internal
  4000, no publish, volume `/opt/livingcost/marketing-data`. Untouched by
  design; promotion rewrites exactly ONE line (backend `image:`) under CAS.
- Running backend: container `livingcost-backend`, image ID
  `sha256:5d133132b544a0d5b07d471dab7e4a8a1dfb51d491be12ab7c7bb36c14ce667f`,
  label `org.opencontainers.image.revision=a2c7bd9af46d84dc88b2a36656c25949b57076b0`,
  compose ref `lcm-coaching-a2c7bd9…@sha256:5d133132…` (created 2026-10-15).
- Re-pull availability NOT established: the live image appears under the
  LOCAL name only (`lcm-coaching-a2c7bd9…:latest`); OCIR
  `yny.ocir.io/axuouply2298/livingcost/backend` holds many historical SHA
  tags, none for a2c7bd9's image ID. Therefore: no registry push path is
  used (also no registry credentials are registered in opskv — inventing
  them or minting new keys is out of scope), and rollback relies on a
  host-side `docker save` archive that the pipeline creates ONCE and
  reuses-if-valid (never duplicates while valid).
- DB: container `gamja-data-postgres` (PostgreSQL 16.15), database
  `livingcost`, schema `lcm`, cluster superuser `gamja_admin` (name is
  registry/backup-script metadata, not a secret), runtime role `livingcost`.
  Host `pg_dump/psql` 16.15 = compatible.
- Catalog (names/counts only, never rows): `_prisma_migrations` = 12 total
  rows, 11 applied (the known `20260522000000_initial` history includes one
  pre-existing non-finished historical marker row carried from the first
  release — unchanged baseline), 24 tables in `lcm`,
  `to_regclass('lcm."WorkspacePlanningState"')` = absent,
  pg_stat_activity on `livingcost` = 4 connections. Pending inventory of
  the candidate image vs the DB catalog is exactly the ONE approved
  migration → the helper's `migrate` op accepts it and any deviation halts
  with code 22.
- Planning migration SQL pinned at
  `sha256:229a1fa43233f74fef9110bf4d56307efbee93da1f8baeac3a3347588d1feb35`
  (single transaction; `lock_timeout=5s`, `statement_timeout=30s`; additive
  only). The helper re-checks this hash INSIDE the loaded candidate image
  before applying.
- Timers inventoried at preflight (read-only): `gamja-postgres-backup.timer`
  (daily livingcost dumps, retention 14d/93d per backups.yaml),
  `livingcost-reminders.timer` (active; restart-recovery semantics per
  DEPLOYMENT_MIGRATION.md), `livingcost-marketing-backup.timer`.
- Health: `/v1/health` under API_BASE_PATH; public
  `https://api.gamja.top/living-cost-manager/v1/health` returns
  `commitSha`/`X-Release-Sha`; used for identity verification post-promote.

## 3. Chosen pipeline (implemented in this branch, local only)

Jobs (`.github/workflows/ci.yml`): preflight → build-test (+ new
`scripts/ci/api` test step) and needs-api-detect; when the push is
API-impacting: api-image (Mac Mini build + synthetic health + saved-image
artifact, 1-day retention) → api-deploy (production-environment Owner
gate) → only then FE deploy; pure-web pushes skip both API jobs. FE deploy
explicitly cannot proceed on API failure (result checks, not skipped
masking). Concurrency is serialized (`cancel-in-progress: false`) so a
queued push can never cancel a run mid-migration.

Remote stages (`scripts/ci/api/deploy-host.sh`, named ops):
preflight → ensure-rollback → load-image → backup → fetch off-host copy →
rehearse → migrate → promote → verify → public verify → opskv BACKEND_IMAGE
CAS registration. Each op is idempotent-classified against LIVE state
(`fresh` / `promote-only` / `promoted` / halt) so a re-run INSPECTS instead
of blind-replaying; halt codes 20–29 are stable and abort the job.

Key guarantees encoded and behaviour-tested (46 tests):
- capacity fail → zero writes; digest/sha mismatch → no docker load, no
  migration; stale prod identity → no overwrite; extra/aborted/unexpected
  migrations → refuse; failed backup/restore/migrate/lock → stop before any
  compose change; failed compose-up → immediate single-file revert (service
  level); verify drift → halt; rollback op reverts the image ONLY and is
  never wired into the workflow; secrets never in argv/stdout/stderr/logs
  (sentinel-injection tests); off-host backup copy is a 0600 runner file
  removed at job end — customer financial rows are NEVER uploaded to
  artifact storage on a public repository; opskv registration is CAS'd.
- Helper bytes are SHA-pinned from the trusted main SHA before execution;
  remote ops accept only regex-validated `--sha/--run/--attempt` plus
  digests; the rehearsal is a `CREATE DATABASE`/`pg_restore`/`DROP DATABASE`
  of a job-owned temp database (the only destructive verb anywhere, against
  the object the job itself created, never against `livingcost`).

Restore-rehearsal location: the fresh dump is restored on the OCI host into
an isolated owned temp database inside the existing PG16 container (network
untouched, no app startup, metadata/count queries only, dropped in the same
op). Rationale: zero customer-data egress across SSH for a rehearsal, and
it matches the recorded precedent ("isolated_owned_local_postgresql16_-
database_schema_lcm", gamja-ops backups.yaml). The Mac Mini peer-auth
Unix-socket cluster remains reserved for the CI unit suites. This is a
stated design choice, not a silent substitution.

## 4. Rollback target recipe (provided in advance, per approval)

1. Trigger point: only after a halted promote/verify, decided by the Owner
   (manual `ssh gamja-oci sudo bash <receipts>/deploy-host.sh rollback-image
   --sha <promoted-sha> --run <id> --attempt <n>`).
2. Preconditions enforced by the op: compose backend ref == the pinned
   candidate NEW_REF (CAS), rollback archive + valid meta present, image ID
   present locally.
3. Action: rewrite ONLY the backend image line back to the pinned OLD ref;
   `docker compose -p livingcost -f /opt/livingcost/docker-compose.yml up -d
   --no-deps backend`; verify container image == OLD ID.
4. Data: the WorkspacePlanningState table, all planning rows, and all
   backups are RETAINED — no destructive verb exists for them.
5. Compat gap note (per apps/api/docs/planning-foundation.md): pre-billing
   images (≤260c8d4-era) are NOT safe writable rollback targets; a2c7bd9
   (billing foundation + product tour + coaching prefs) is the compatible
   previous server, but its writes will not archive newly added planning
   payloads — planning storage stays intact, forward-fix is preferred over
   rolling back after planning writes exist.

## 5. Verification performed in THIS readiness session (evidence)

- Behavioural: `scripts/ci/api` 46/46 and existing runner kit 48/48 (kit
  assertion updated to the new needs chain — content truth, not weakened).
- Static: `node --check` all helpers; `bash -n` helper + fakes; YAML parse
  of ci.yml (ruby psych); no packages:write / StrictHostKeyChecking=no /
  test-env vars in the workflow (grep-asserted in tests).
- Real engine run (this branch, pre-approval, LOCAL ONLY): candidate image
  built at local HEAD `29f8d0bd105628e96d3cef34bcf7c6f73ec4772e` on the
  existing colima engine — image ID `sha256:0aff72c39ae2d005420884998900fe
  99397575d01b0efded7c6aba132abec9af`, linux/arm64, revision label = exact
  SHA; synthetic boot PASSED (12 migrations in-image, planning SQL hash in
  image = pinned source hash, `prisma migrate deploy` applied to the
  throwaway internal-network DB, `/v1/health` returned
  `commitSha=29f8d0bd…`/`releaseId=lcm-29f8d0bd…`); archive
  `docker save <imageID>` → 153,910,829 B, sha256
  `db1088d2f031f2db3fc966e530c9ec7b65f56222ef3631df9b9a2c1a4fbca0e7`;
  verify-archive PASS; the archive was `docker load`-tested back to the
  SAME image ID and then the local image copy was removed (the archive
  file itself was later removed under the approved resource cleanup — see
  §7 — its hashes recorded here permanently; image regenerable from the
  exact SHA). This real
  run FOUND AND FIXED a genuine integration bug: saving by immutable image
  ID makes `docker load` report `Loaded image ID:` WITHOUT a tag — the
  helper now accepts both load forms and re-tags the ID itself, with tests
  covering both.
- NOT done (by design): no push, no trigger, no OCI mutations, no DB apply,
  no service change, no opskv writes. Independent review by the main session
  is the next gate.

## 6. Remaining risks / open items for the gated first run
- Same-UID runner trust gap is pre-existing and data-explicit (runbook §7).
- `prisma migrate deploy` runs through the runtime role from the existing
  protected env file; the recorded 2026-10-15 paired release applied via the
  same mechanism, but first production execution still verifies live pending
  inventory before applying (halt codes protect the boundary).
- Workspace FK acquisition can block writers for up to the bounded
  maintenance window (5s lock / 30s statement) — not zero-downtime.
- Artifact storage is not literally free (public-repo Actions quota
  semantics); retention 1 day + ~≤0.7 GiB archive is the budget bound.
- The candidate tag `lcm-ci-api-<sha>:candidate` is re-resolved to the
  image ID at EVERY remote op because no registry exists to digest-pin
  against; ID-equality is the compensating control.
- If the first gated run halts on any code, the remediation is INSPECT +
  document, never a manual local-ssh migration (explicitly out of scope).

## 7. Resource receipts (cleanup executed 2026-10-19 under approved classes)

- Fixed-manifest cleanup (non-wildcard, exact paths, 0600 manifest retained
  as receipt at `$TMP/lcm-cleanup-manifest-20261019.txt`,
  sha256 `77f0c35418221b16507aeb94d60f64d9a4ca9ff6bd532da93d917eb1b0f11541`,
  635 entries): 621 deleted after per-path revalidation (own UID, no symlink,
  no open handles, known-completion). `df` 16.78 → 17.56 GiB (**+0.78 GiB**,
  matches the 771 MiB dry-run estimate; concurrent-session movement is NOT
  attributed to this task).
- Deleted: 599 pipeline-test mkdtemp fixtures (≈121 MiB, class #1); the
  147MB readiness archive FILE only (class #2 — its sha256 `db1088d2…`,
  imageID `0aff72c39ae2…`, source SHA 29f8d0b and build method remain
  documented here, superseded as head-proof by HEAD a8d5206; unique
  `metadata.json` RETAINED 896 B); `lcm-ci-kit-llVJML` closed test copy
  (439 MiB, class #3 — real runner untouched, no listener referenced it);
  `lcm-usability-test-dr2nU4` closed synthetic PGDATA (64 MiB, class #4 —
  PG_VERSION present, no postmaster.pid, lsof 0, own-uid regular files);
  4 `lcm-rh-*` + `lcm-test-2c342453` + empty state dirs + empty kit dirs
  (class #5).
- Skipped fail-closed, recorded: 14 small `lcm-ci-kit-*` dirs containing an
  ACL-protected `aclcheck` fixture file (kit-test lineage owns that logic;
  forced chmod/rm NOT performed — total <1 MiB); Docker volume
  `living-cost-manager_lcm_test_pgdata` (#6 EXCLUDED per instruction —
  10-02 provenance significance unknown); shared buildkit cache; base
  images; VM/global prune; worktree `node_modules`/`.next`/`out`
  (needed by upcoming FE runs); active harness pid 20621 (other session).
- Harness leak FIXED (cause: no per-test cleanup existed):
  `pipeline.test.ts` now registers every mkdtemp root and removes EXACT
  registered paths in `afterEach`/`afterAll` (failure paths included;
  guard-limited to our own `/lcm-api-*` temp roots, no prefix sweep).
  Verified: 48/48 pass, 0 leftover fixtures, peak ≈ ≤22 MiB (≤200 MiB
  requirement met). Kit-test lineage cleanup stays a separate concern.
- Gate status: free 17.56 GiB < 20.8 GiB api-image capacity gate → NO heavy
  build until shared-space recovery; the gate was NOT lowered or modified.
  Small/text work and the fixture-only test suites (own budget
  0.5×1.2+1+15 < actual) remain allowed.
