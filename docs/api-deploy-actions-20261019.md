# Actions API promotion pipeline — feasibility + readiness (2026-10-19)

**Current default resource design: §12 (verified runtime overlay).** §11 is the
separate full-Linux/cold estimate, NOT a mandatory forecast for a compatible code-only
release. The unused §10 ephemeral-VM proposal is withdrawn
(no VM was created). Its 22.7 GiB launch gate does not apply to reuse of the
already-running engine. The physical 15 GiB policy floor is unchanged. Baseline
feature 8a362056 was published; this follow-up remains local/unexecuted pending review.

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
- Historical free space measured 25 GiB at the earlier session start (22.4 GiB at build time —
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
actual local restore/migration/invariants/cleanup → authenticated receipt handoff →
migrate → promote → verify → public verify → opskv BACKEND_IMAGE
CAS registration. Each op is idempotent-classified against LIVE state
(`fresh` / `promote-only` / `promoted` / halt) so a re-run INSPECTS instead
of blind-replaying; halt codes 20–29 are stable and abort the job.

Key guarantees encoded and behaviour-tested (current results in §8):
- capacity fail → zero writes; digest/sha mismatch → no docker load, no
  migration; stale prod identity → no overwrite; extra/aborted/unexpected
  migrations → refuse; failed backup/restore/migrate/lock → stop before any
  compose change; failed compose-up → immediate single-file revert (service
  level); verify drift → halt; rollback op reverts the image ONLY and is
  never wired into the workflow; secrets never in argv/stdout/stderr/logs
  (sentinel-injection tests; raw child errors only in protected 0600 local logs);
  off-host backup copy is a 0600 runner file
  removed at job end — customer financial rows are NEVER uploaded to
  artifact storage on a public repository; opskv registration is CAS'd.
- Helper bytes are SHA-pinned from the trusted main SHA before execution;
  remote ops accept only regex-validated `--sha/--run/--attempt` plus
  digests; **P1 fix**: all sensitive temp files (dumps, rollback archives)
  are created via mktemp-ONLY under a trusted root-owned 0700 staging
  directory (`/var/lib/gamja-lcm-ci`), never under predictable `/tmp`
  paths; **P2 fix**: DB connection identity is verified before any SQL
  mutation (actual candidate Prisma connection: database/schema/server address/port
  against the physical backup container's network address; sealed job-only env copy);
  **P2 fix**: OCI capacity gates verify actual filesystem free
  space before each phase (backup/tempfile/rollbacktar/candidatearchive)
  using expected peak×1.2 + reserve + floor per policy.
- **P2 fix**: Restore rehearsal is REMOVED from production PG container.
  The backup is verified for integrity (sha256 + size + manifest) on OCI,
  then the actual restore rehearsal is performed on the Mac Mini isolated
  PG16 cluster (Unix socket, peer auth, no TCP, 0700 permissions) by
  `deploy.mjs fetch-and-rehearse-local`. No CREATE/DROP DATABASE in
  production PG. The protected dump does cross the existing SSH connection to
  the operator's Mac Mini; no customer data is uploaded to GitHub artifacts.
- **P2 fix**: SSH quoting uses SINGLE validated remote command via POSIX
  shell-quoting (`shellQuote()` function). All paths are from pinned
  constants or regex-validated tokens. No secrets on the command line.
- **P2 fix**: CI metadata/sql binding verification uses Node crypto (not
  broken awk `BEGIN{$1...}` which always fails before input). Direct hash
  compare with proper error reporting.
- **ADDITIONAL fix**: Metadata verification enforces binding against
  expected inputs (runId/runAttempt/repo/workflow/platform). Rejects
  missing/mismatched/replayed attempt/cross-run/cross-repo. Verifies
  actual loaded image matches metadata (platform + revision label + image ID).

Restore-rehearsal location: **P2 fix — CHANGED from OCI to Mac Mini**. The
fresh dump is verified for integrity (sha256 + size + manifest) on the OCI
host, then transferred to the runner workspace as a 0600 protected file
(never uploaded to GitHub artifact storage — customer financial rows stay
in protected operator storage). The actual restore rehearsal is performed
on the Mac Mini isolated PG16 cluster (Unix socket, peer auth, no TCP,
0700 permissions) by `deploy.mjs fetch-and-rehearse-local`. No
CREATE/DROP DATABASE in production PG container. The protected dump crosses
the existing SSH connection, not GitHub artifact storage. The Mac Mini peer-auth Unix-socket cluster is
reserved for the CI unit suites and restore rehearsal. This is a stated
design change, not a silent substitution.

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
  documented here as historical evidence ONLY, not proof for the current revision; unique
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

## 8. Manual quality escalation — local-only correction (2026-10-19)

Root causes reproduced: hash-only OCI rehearsal was incorrectly usable as
authority; the actual local restore function was unwired and used incompatible
helper output/URL/schema assumptions; optional metadata checks accepted missing
identity; SSH fake skipped the real outer shell; VM capacity returned a synthetic
999 GiB on measurement failures. A red regression confirmed missing metadata
was accepted (47 existing tests passed, the new regression failed).
Separately, the current regression tests run against a disposable copy of
committed pre-fix `fc0a1ad` helpers produced 10 expected failures: four restore
authority cases, two connection identity cases, outer-shell helper installation,
two VM measurement cases, and mandatory metadata. That source-copy fixture was
removed by an EXIT trap; the working checkout was never reset or overwritten.

Current call graph is explicit in ci.yml: fetch the dump **and** 0600 manifest,
then `fetch-and-rehearse-local`, then migration. `local-restore.mjs` owns a fresh
0700 PG16 cluster, peer-only Unix socket, no TCP, dedicated `lcm_restore_test_db`.
libpq receives explicit socket/port/OS user/database arguments; installed local
Prisma receives a separate URL with `schema=lcm`. Restore nonzero always fails.
The exactly pinned SQL and pending inventory are checked. Existing table rows,
columns/constraints and pre-existing migration history are fingerprinted before
and after; only the approved table/history delta is accepted. No app, billing,
reminder or outreach worker is started. Finally stops/removes the owned cluster
on failure as well as success; a cleanup failure denies the receipt.

Only successful restore + migration invariants + cleanup submits a small receipt
over the existing authenticated operator SSH path. No new signing key is needed:
the trust boundary is the existing approved owner workflow/account, not arbitrary
receipt writers. The root-private receipt binds exact source SHA, run, attempt,
dump SHA, SQL SHA, helper source SHA and invariant proof. Migration/promotion
reject missing/replayed/mismatched receipts; OCI `rehearse` is integrity-only and
cannot grant permission. Production backup/rows/history remain untouched by cleanup;
the unnecessary local dump is removed after receipt acceptance, sealed job env
is removed by the always cleanup step. Private raw diagnostics are never artifacts.

All SSH commands are one POSIX-quoted string; the fake joins post-host argv and
executes an **outer** `sh -c` plus a normal sudo stub. Archive metadata is mandatory
against actual GitHub repository/workflow/source/run/attempt, including image size;
send, verify and remote load bind it before writes/load. Raw image revision,
platform, image ID and size are rechecked (image config ID is NOT a registry digest).
Docker free space is measured read-only via `colima ssh -- df -Pk <DockerRootDir>`;
any command/parse/mount failure stops. Host **and** VM gate remain 20.8 GiB with
15 GiB floor. OCI transfer/load, backup temporary+copy and rollback temporary+copy
check combined peak×1.2 + reserve + floor on their target filesystems.

Validation: API pipeline suite **72/72** includes actual synthetic custom-dump restore and
Prisma migration, record/history invariants, invalid dump, missing state recovery,
stop failure, missing/replayed/different-dump receipt, wrong-server/default schema,
each missing/empty metadata field, VM measurement/parse failure, outer SSH
installation/archive roundtrip and failure-output sentinels. Runner kit 48/48;
Python restore proof 10/10 and clean-build proof 5/5; Node marketing kit 17/17.
`verification-target.test.mjs` is **not standalone**: its two cases require the
purpose-created verify-usability ownership marker; invoking it without that
harness correctly refused before any fixture write. No out-of-scope fix was made.
Node/Bash syntax, Ruby Psych YAML parse and `git diff --check` passed. Ruby emitted
an existing optional ffi-extension warning but YAML parsing succeeded.

Deployment also prepares only frozen/offline root dependencies (no lifecycle
installers) after the unchanged capacity gate and checks the installed CLI version
against pnpm-lock plus the existing Darwin ARM64 engine **before any OCI operation**.
Rehearsal pins `PRISMA_SCHEMA_ENGINE_BINARY` to that local engine; its mirror is
loopback-only so missing engine/cache cannot silently download. The checkout's
node_modules are not assumed to survive earlier jobs. This offline cache preparation
has NOT been exercised by an Actions deployment here; a missing cached engine is a
fail-closed first-run prerequisite, not a claimed deployment success.

Capacity measured during this correction: host ~18.9 GiB, actual Docker filesystem
`/dev/vdb1` mounted at `/var/lib/docker` 7,837,496 KiB (~7.47 GiB), not VM `/`.
The real `image.mjs capacity` command returns failure at the unchanged 20.8 GiB
gate. No Docker image/archive was built or installed; old 29f8d0b evidence is not
current-image proof. No push, trigger, SSH mutation, production DB operation or
real credential access occurred. Independent security re-review remains pending.
All test-owned clusters/data/socket directories and fixture trees are removed in
finally/afterEach; no shared image, volume, VM or other worktree was cleaned.

## 9. Compare classifier P2 follow-up (local only)

The prior classifier incorrectly required `compare_from_sha`/`compare_to_sha`,
which GitHub compare REST does not supply. Invented fixture fields masked the
problem: real web-only responses always selected the release-specific API job.
New realistic REST-shape tests first reproduced five failures against a969.

The fixed route uses the validated immutable push `before` and event SHA, not
mutable refs. The response must bind `base_commit.sha` exactly to before, have
consistent ahead/identical status and a complete, valid, unique commit list whose
last SHA is the exact event head. `total_commits` must equal that list's size and
remain **below 250**. Files must be present and **below 300**: absence of a
nonexistent `total_count` is not evidence that a 300-file response is complete.
Missing/malformed/error/truncated evidence remains `needs_api=true`. An exact
identical comparison may skip only with equal before/head and empty lists.
Both `filename` and `previous_filename` are checked; API→web renames and API
deletions cannot silently skip API work. Pipeline helper sources under
`scripts/ci/api/` themselves are API-impacting. The workflow now also declares
the missing `id: classify`, so its existing job output references resolve.

Verification: **131 API tests** (the prior 72 plus 59 additional cases), runner
kit **48/48**, Python restore/metadata proof **10/10**, clean-build proof **5/5**;
Node syntax, Ruby YAML parse and diff checks. Fixtures use REST fields only,
including CLI consumption of unchanged JSON, exact SHA mismatches, 249/250
commit and 299/300 file boundaries, rename/deletion and malformed/error inputs.
No live compare fetch was necessary; these are explicitly synthetic source
metadata fixtures, not fabricated claims of a GitHub response being fetched.

The fixed OLD-image production CAS guard is deliberately unchanged. This is a
first-release pipeline: a later API upgrade needs a separately verified rebaseline,
not guard removal. Pure web pushes can skip API only with complete positive
evidence; the full public99→current source range still includes API foundation
changes and must select API. Capacity gates/floors remain unchanged and blocked;
no image build, push, workflow trigger or production application occurred here.

## 10. Planned owned ephemeral builder — readiness only (supersedes shared-build context)

**Not provisioned or executed here. Independent resource-helper review must pass
before the first real start/download/build, which is reserved for GitHub Actions.**
The existing `default` Colima instance, its 21 product containers and shared
volumes are NOT the build target and are never stopped, resized, reset or pruned.
The owner account remains Sanghyun as explicitly requested; no OS-account or
cloud/provider/credential change is introduced. These source changes describe a
planned lifecycle, not an applied runtime/ops inventory entry in another repository.

Installed read-only CLI help was checked: Colima 0.10.3 supports `--cpus`,
`--memory`, `--disk`, `--root-disk`, `--profile`, `--activate=false`,
`--ssh-config=false`, and `--mount` (RO unless suffixed `:w`; `none` is also
documented but is not used). Startup uses 2 CPU / 3 GiB RAM / 40 GiB sparse
data disk / 20 GiB sparse root, aarch64/vz/docker/virtiofs, `--template=false`,
`--ssh-agent=false` and exactly the real job workspace as one RO mount. No home,
private SSH, host agent or arbitrary writable mount is supplied. Generated
`lima.yaml` is parsed as safe data and must contain exactly that RO mount,
`forwardAgent=false` and `loadDotSSHPubKeys=false` before any build. Unexpected
mounts/configuration halt and clean only the owned profile; no shared Lima config
is patched. Actual generated configuration still needs first-run verification.

`build-profile.mjs` derives `lcm-api-build-<run>-<attempt>` and
`colima-lcm-api-build-<run>-<attempt>` from the trusted main Owner workflow identity
and exact source SHA. Workspace git HEAD/cleanliness is checked before allocation.
Profiles, Lima disks, Docker contexts or job journals that already exist are
refused, not adopted. A fresh 0700 state root at
`~/.local/state/lcm-api-build/<run>-<attempt>` contains a 0600 identity/stage journal
and private log. The global LCM `active` directory is claimed atomically; the
profile directory is claimed exclusively and receives its own 0600 owner marker
before provisioning. Same-attempt resume is deliberately unsupported. This is a
cooperative owner-account lease, not isolation against malicious same-UID code.

Only the derived context/profile and scratch path are exported to GITHUB_ENV.
All image-engine commands have an explicit owned `--context`; guest capacity
uses explicit `colima --profile ... ssh -- df -Pk <DockerRootDir>`. Context endpoint
must equal that owned profile's Unix Docker socket. No artifact metadata can
select a context. Read-only global client-context metadata, other context names,
the explicit shared `colima` container-ID inventory and public shared ssh_config
digest are compared before/after; drift is reported, never "fixed" by switching
contexts or restarting another product. No default-engine build, probe or cleanup
is performed by `image.mjs`.

Resource conditions (unchanged floor/image gate):
- Cold startup requires **22.7 GiB host free**: existing 20.8 GiB gate plus
  forecast 1.85 GiB bootstrap, rounded upward. The supplied cold forecast is
  ~316.9 MiB public download + ~1.2 GiB root allocation + ~0.3 GiB data format
  + logs; it is an estimate, not a measured new-profile startup result.
- Host RAM admission requires at least 4 GiB available (3 GiB VM + 1 GiB reserve),
  using free/inactive/speculative pages, and the expected Darwin ARM64 platform.
  No memory purge, swap alteration or other process termination is attempted.
- Immediately after startup and before each heavy phase, **host and actual owned
  guest Docker data filesystem must both have ≥20.8 GiB free**. VM `/` is not an
  acceptable substitute for the data mount. Missing/failed measurements halt.
- An independent parent monitors every owned start/build/probe/archive child.
  Image children require a matching private controller PID/nonce; a direct worker
  flag cannot bypass monitoring. Every five seconds host free is checked (plus
  guest free once the builder is ready);
  below **16.5 GiB** (15 floor + 1 reserve + .5 margin), unknown measurement,
  timeout or cancellation stops only the detached child group created by that
  parent, then tears down its own VM. No process-name scans or unrelated PID kills.
  Startup has a 10-minute timeout; the job has a 60-minute bound. Forecast gates
  still apply: the monitor is a backstop, not permission to start below budget.

The lifecycle journals exact profile/Lima/data-disk paths, budgets and host free
before/after. Cleanup revalidates canonical owner/identity/marker immediately
before official `stop` and `delete --force --data` on that one profile; even a
failed partial-start stop proceeds to its own official delete. Unknown ownership
or failed deletion preserves the precise lease and fails the gate. No wildcard
profile cleanup, shared-cache deletion or whole-VM copies are used. One official
Colima 0.10.3 public boot blob (~316.9 MiB) may remain as a checksum-protected,
reusable upstream cache; its purpose is avoiding repeated cold downloads and its
retention is reviewed after the first run, not blindly pruned or promised as
"net zero" space. No custom/force disk image or boot-cache bypass is accepted.

Actions always cleans synthetic containers first; saves/uploads the public image
archive; and only **after upload** stops/deletes the marked VM and removes its
own transient archive files. Failure/cancellation also reaches idempotent cleanup.
Small private journals/logs and a 0600 archive-metadata digest proof remain even
if upload fails, for first-run evidence review; financial backup
and isolated restore still run natively on Mac PG and never enter this builder.
The deploy job no longer assumes the builder lives: artifact verification is
strict hash/metadata-only locally; actual image identity/platform/size checks
remain in the existing OCI load helper. Offline native CLI preparation uses a
host-only 20.8 GiB capacity gate, not the shared VM. Production backup/receipt,
SQL hash `229a1fa4...`, timeouts, additive migration and OLD-image CAS are unchanged.

Source validation uses only fake Colima/context/filesystem fixtures and the
existing native synthetic PG suite. New tests cover resource admission, foreign
profiles/aliases/markers/SHAs, atomic lease collision, mounts, unknown/low guest
space, partial-start cleanup, context socket binding, idempotence, private output,
real Node-child budget abort and cancellation without killing an unrelated child.
Those Node processes are test-owned; no real VM/download/image build is used.
Existing financial, archive, SSH and classifier tests remain. Current host free
was freshly read at ~22.9 GiB during readiness; this is not an atomic reservation
and must be remeasured by Actions alongside RAM. Runtime resource viability,
actual bootstrap peak and first-build health remain **unverified**, not deployed.
No new paid cloud resource is allocated, but storage/RAM/CPU/Actions quota still
have costs; no zero-cost, guaranteed reclaim or guaranteed completion claim is made.

Local results for this readiness revision: **178/178 API tests** (all prior 131
retained), **48/48 runner tests**, **10/10 Python restore proof**, **5/5 Python
clean-build proof**. Node and Bash syntax, Ruby Psych YAML parse, extracted image
job shell syntax and `git diff --check` passed. The existing optional Ruby ffi
extension warning did not prevent parsing. All new fake profile directories,
synthetic archives/proofs, monitor children and existing synthetic native clusters
were cleaned by the fixture lifecycle; no real boot blob or VM was created.
Host available was 23,996,136 KiB before and 23,979,296 KiB after a recorded full local
checks; concurrent-session movement is not attributed to these tests. This is
source/test readiness pending independent review, not physical startup proof.

## 11. Existing-engine resource redesign — PROPOSED/NOT BUILT

Owner explicitly approved replacing the unused new-VM path with existing runner/
Docker reuse. The active path uses only `docker --context colima` and read-only
`colima --profile default ssh -- df -Pk /var/lib/docker`. It contains no VM start,
stop, delete, resize, context switch, shared prune, daemon maintenance, swap cleanup
or tool installation. No new profile exists to remove. The earlier 4 GiB peak was
an **uncalibrated estimate**, not an observed build peak; it is removed from the
active forecast, rather than replaced with a smaller unexplained constant.

### Read-only inputs and explicit caps

| Input | Observation / meaning |
|---|---|
| Build context | 97 regular tracked allowlisted files, 600,586 B including `.dockerignore`; content-hashed. No untracked/private files or Darwin node_modules are sent. Symlinks and >3 MiB source context fail. |
| Package fingerprint | `a09911e4e514d640bd1f238427a583aabf5f503671121ad3f1937a4712f39c2c`; changes require a new reference, never silent smaller fallback. |
| Darwin dependencies | `du -sk node_modules` = 892,720 KiB (914,145,280 B). A local reference only: hardlink/APFS accounting is not unique physical usage or a Linux measurement. |
| Linux dependency allowance | Twice that reference = 1,828,290,560 B; another equal allowance for package store. **Proposed uncalibrated caps**, to be independently reviewed and then sampled, not claims about actual Linux size. |
| Old candidate | 29f8d0b runtime ~660,000,000 B and archive 153,910,829 B are historical SIZE inputs only. They do not prove this source/image works. |
| Runtime cap | Historical runtime ×1.5, rounded up to MiB = 990,904,320 B. Streaming archive cap = runtime cap ×1.1 = 1,089,994,752 B. Both are enforced rejection limits, not measured new outputs. |
| Other proposed allowances | Compile = 128 MiB + source bytes×8; synthetic PG volume 256 MiB (checked in its owned container), BuildKit metadata/cache allowance 256 MiB. Build-stage accounting cap = 4,786,507,856 B. |
| Public Node base | Existing `node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1`, linux/arm64, Node **24.21.0**. API inspect size 62,065,778 B differs from listing 238 MB; forecast uses upper listing 239,000,000 B, not the smaller API number. |
| Public PG base | Existing `postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`; listing 411 MB, upper reference 412,000,000 B. |
| Anonymous cache | Docker reports 136 cache records / 5.283 GB. No matching-input provenance: **zero warm credit**, no deletion. |
| Native build backend | `docker --context colima buildx version` reports unknown command on this host. **BuildKit unavailable; blocked**, no install or unsafe legacy cancellation fallback. |

The source Dockerfile is not modified. Only the private staged public context
replaces BOTH mutable `FROM node:24-alpine` references with that same observed
immutable digest; staged Dockerfile hash is recorded. Full install/build/deploy/
Prisma engine generation still happens inside Linux. Host Node 24.18.0 remains
the existing CI/native toolchain, not a source of shipped Darwin dependencies.
Linux build/runtime both use 24.21.0; no claim of identical host/guest patch version.

### Separate physical and logical admission

Physical host requirement = **15 GiB floor + 1 GiB recovery + remaining additional
host forecast×1.2**. Guest requirement = **2 GiB proposed LCM operational reserve
+ remaining additional guest forecast×1.2**. The 2 GiB proposal (~6.8% of measured
29.36 GiB ext4 capacity) gives bounded-job headroom for other databases; their
future growth is unknown, not guaranteed safe. It needs peer acceptance before
execution and is NOT a global policy change or lowering the physical 15 GiB floor.
Do not add host and nested guest allocations together as two physical reservations:
host forecast already includes possible guest sparse-file growth once.

For the observed cached public bases but **unproven dependency cache**:

| Forecast (NOT actual sampled peak) | Additional host | Additional guest | Host free required | Guest free required |
|---|---:|---:|---:|---:|
| Cold/unverified cache | 7,405,275,738 B (~6.897 GiB) | 6,314,283,088 B (~5.881 GiB) | 26,066,200,070 B (~24.28 GiB) | 9,724,623,354 B (~9.06 GiB) |
| Verified identical-input cache | Recomputed only from a protected successful same-input measurement + live retained inline-cache image; **not available now**. It must not be selected merely to fit free space. | | | |

A read-only snapshot during this change had host 21,786,152,960 B (~20.29 GiB)
and guest 8,025,591,808 B (~7.47 GiB). Thus **cold admission fails on both filesystems**,
and BuildKit capability independently fails. There is no measured new build peak,
no claim that 20 GiB is enough, and no measurement build performed here.
If a base is absent, cold pull/extraction allowance increases; unknown metadata
fails. A warm record must bind complete Linux input hash, package fingerprint,
   base digest, build-recipe hash, backend version, public Node version, prior source/run/attempt,
live image ID/inline cache, bounded outputs, SQL hash, archive digest and actual
successful synthetic health. Lost/replayed/invalid cache proof falls back to the
full cold forecast and fresh admission before any build, not a permissive skip.

### Stage/ownership/measurement mechanics

The overall forecast includes cumulative retained install/store/build/runtime
layers, runtime export, archive, synthetic data and context. `--target build`
first produces a job-labelled Linux intermediate; accounting size is checked
against its cap. Final runtime uses its inline cache and gets a separate cap.
Fresh per-stage admission counts only still-to-be-created outputs; persisted
earlier outputs already occupy measured free space and are not pretended free.
Anonymous/shared cache is never pruned. Completed BuildKit layers can remain on
failure/cancel; their observed shared-volume growth is retained as evidence for
review before another attempt, not promised reclaimed.

Container/network names include run/attempt/digest and are DNS-safe; FULL source
SHA/run/attempt labels and fresh-absence intents are mandatory. All executions
and cleanup recheck immutable IDs/labels. A foreign same-name object, wrong run,
changed ID or a preexisting (including untagged) image ID is preserved and fails
cleanup. Only exact fresh own IDs/tags are removed; no pattern sweeps or cache
prune. A successful intermediate inline-cache image is retained with protected
proof for the next identical-input run; Main reviews its specific tag/ID after
measurement/deployment. No forever/global cleanup rule is introduced.

Archive is `docker save <immutable ID> | gzip -n -c` directly into one exclusive
0600 bounded output. Both child statuses and both pipelines must succeed. The
compressed bytes are streamed into SHA256; partial own output is removed on
save/gzip/cap failure, while preexisting output is never overwritten/deleted.
No plain tar or duplicate archive is materialized. Strict artifact metadata,
native protected restore receipt, sealed DB identity, SQL hash 229a..., timeouts,
OLD-image CAS and FE-needs-API-success remain unchanged.

Parent monitoring samples host AND actual DockerRootDir free space every five
seconds with bounded query timeouts. Abort thresholds are host **16.5 GiB** and
guest **2.5 GiB** (respective reserve + margin), or unknown measurement. Cancellation
signals only the owned detached worker group; native BuildKit receives SIGINT to
cancel its solve context. No daemon-wide kill or assumption that legacy builder
disconnect cancels is allowed. Completed cache may remain. GHA cleanup is always
after upload; missing ownership is reported, not overridden. Production is never
marked done from an image/resource sample.

### Controlled measurement recipe — DO NOT RUN before peer review/admission

1. Review this proposal, especially uncalibrated caps and the proposed 2 GiB
   guest reserve. Confirm an ALREADY available native BuildKit backend; do not
   install tools or silently use legacy mode as part of this recipe.
2. Run `node scripts/ci/api/build-profile.mjs plan` for fresh read-only inputs/free
   space. **Stop if either forecast or capability does not fit** (current result).
3. For an explicitly local controlled measurement, set the same public identity
   headers to fixed repo/workflow/main/Owner, SHA=`git rev-parse HEAD`, a unique
   numeric local run ID, attempt=1, `GITHUB_ACTIONS=false`, real `GITHUB_WORKSPACE`,
   and a fresh protected `GITHUB_ENV` file. This is labelled local measurement,
   NOT a GitHub run or production approval proof. Never put credentials in argv.
4. `node scripts/ci/api/build-profile.mjs prepare`; export only context=`colima`
   and the computed own scratch path (do NOT source arbitrary env files).
5. In a shell with an EXIT cleanup trap, run `image.mjs build --sha "$GITHUB_SHA"`,
   then `synthetic`, then `archive --out .../image.tar.gz --metadata .../metadata.json`.
   All use identical source/run/attempt headers and active monitoring. Finally
   `node scripts/ci/api/build-profile.mjs teardown`; remove only that own transient
   archive after retaining/uploading its small metadata. No actual measurement here.
6. Inspect the 0600 job `measurement.json` and `archive-metadata.json` under
   `~/.local/state/lcm-api-shared-build/<run>-<attempt>-<full-sha>`.
   `kind=sampled-actual-not-atomic`, baseline, minimum sampled host/guest free,
   per-sample stage/time/free, output accounting types, source/input/backend/base
   and archive bindings are required. `sharedObservedDelta = baseline-minimum`
   includes other activity; it is neither pure owned growth nor an atomic bound.
   Failure/abort status cannot become passed or grant warm-cache credit.

Before that first peer-reviewed admitted measurement, deployment remains blocked.
No new VM, download, real image build, production restore/migration, push, tool
install, daemon operation or paid resource was performed in this redesign.

Source validation: **187 API pipeline tests**, **48 runner-kit tests**, **15 Python
proof tests**, Node/Bash syntax, YAML and extracted image-job shell parse, and diff
checks. VM-era architectural assertions were replaced with stateful shared-context
ownership/cancellation tests; financial/restore/identity/metadata/real REST classifier
assertions remain. Fake engine integration completes bounded build→synthetic→stream
archive wiring; it is NOT Linux runtime/build evidence. Native PG tests use synthetic
data only. The unchanged app business/frontend tree retains the prior user-reported
848+1skip web / 210 shared / 478 API / Chrome30 proof; it was not rerun or re-labelled
as a new image proof here. All owned test roots, synthetic native clusters and Node
children are cleaned; shared images, volumes, caches and OS daemons are untouched.

## 12. Verified runtime overlay — source-ready, NOT BUILT/EXPORTED/DEPLOYED

The default image path now reuses the pinned current runtime ONLY when dependency
compatibility is positively proven. There is no pnpm install, new OS/node base
pull, anonymous-cache credit or VM in this path. Failure is a hard gate, not an
automatic lower-budget cold fallback. The §11 cold profile remains separately
larger and requires a separately reviewed private-client execution path.

### Actual read-only evidence and local CLI installation

- OCI backend/current-image CAS read-only metadata matched image ID
  `sha256:5d133132b544a0d5b07d471dab7e4a8a1dfb51d491be12ab7c7bb36c14ce667f`,
  source `a2c7bd9af46d84dc88b2a36656c25949b57076b0`, Linux arm64.
  API inspect bytes=150971118; listing634MB gives conservative accounting635000000B.
  These are image accounting inputs, not unique physical allocation measurements.
- Image ENV **names only**: PATH/NODE_VERSION/YARN_VERSION/RELEASE_SHA/NODE_ENV.
  No DATABASE/JWT/SMTP/provider value was read/copied. A fixed read-only/network-none
  Node command (NOT app startup) passed the no-env/customer-file audit: Node24.19.0,
  ABI137, Prisma6.19.3, shared realpath inside `/app/node_modules/.pnpm/...`.
  Generated-client files measured20199170B/18 files. No archive was exported.
- Current vs a2 API/shared/root package manifests match. Normalized **entire lock**
  matches except the exact existing-snapshot `apps/web.devDependencies.esbuild`
  importer addition `{specifier:0.28.0,version:0.28.0}`. Other snapshots/production/
  native dependency changes fail. API/root/shared production links reaching web fail.
- Buildx0.38.0 was installed through Homebrew core, no sudo/auto-update/cleanup, after
  measured install admission16.8GiB (15+1 recovery+.5 margin+.25×1.2 forecast).
  Public bottle/binary SHA/version/bytes and before/after df are in
  `buildx-install-20261019.json`. Binary64727058B, package48files/65MB; managed
  package/cache retained for legitimate CI reuse, not globally cleaned. Tap warnings
  did not result in new tap trust. No new VM, builder container or daemon config.
- Every overlay Docker call has `--config <own 0700 job/client> --context colima`.
  Minimal private config has only currentContext; plugin symlink targets the pinned
  Homebrew binary. No global config/auths/helpers are read/copied/edited. An exact
  per-subprocess DOCKER_HOST points at the existing default Unix socket so explicit
  `--builder default` uses the native **docker** driver. Read-only inspection proved
  BuildKit0.30.0/running default; no bootstrap command. Socket/driver/binary drift fails.

### Same-run artifact → approved baseline export → Linux regeneration

Build-test compiles/tests first, then emits a bounded portable API/shared dist +
current Prisma/schema/migrations + manifests/recipe/helper bundle. Exact source,
run, attempt, dependency-proof digest, file sizes/count and each file SHA are bound.
Only fixed paths/extensions are accepted; no symlinks/traversal/native modules/env/
credentials/backups. Receiver recomputes baseline compatibility and all bytes.
Attempt-scoped same-run artifacts avoid old-attempt replay. Checkout history is
available only to read the fixed a2 baseline, never an arbitrary caller ref.

The api-image job itself has the production environment gate **before** helper or
base export. Root `base-inspect` checks current compose/container/image CAS, safe
ENV names, the source-pinned fixed audit and native versions without DB queries.
Then `base-archive-manifest` reuses the ONE retained protected rollback archive;
only if absent is it generated with accounting-size capacity gates. No duplicate
OCI export or public baseline artifact. A bounded authenticated SSH stream writes
one exclusive private0600 local archive; SHA/bytes/identity are verified before
load. Already-local identical base is explicitly PREEXISTING and not deleted.
New local alias has an exact run/source lease; cleanup never guesses ownership
from a name or deletes preexisting untagged image IDs. Local bulk archive is removed
after load (including failure cleanup); the protected OCI rollback stays.

`Dockerfile.runtime-overlay` uses that verified local alias; no base/dep install.
Old API dist/Prisma and old shared source/dist are purged, shared destination is
resolved and constrained inside `/app/node_modules`, and only the tested bundle
is copied. API/shared package exports/core are checked against the audited base.
All old generated-client JS is removed. Only the existing Linux native query-engine
library is saved temporarily; existing Linux Prisma6.19.3 regenerates the **whole**
new client inside a network-none RUN. The temporary library snapshot is then removed.
Missing engines/generation fail, never install/download. Node major/ABI/native
argon2 load are checked; no Darwin node_modules/client is shipped.

Candidate verification checks exact API/shared/Prisma inventory (including no stale
files), package exports, generated planning model and size cap. Internal owned PG
then migrates the pinned SQL and performs WorkspacePlanningState create/update/find
revision/payload checks on an OWN synthetic workspace, alongside SHA health.
No customer DB, app startup during baseline audit, billing or outreach operation.
Runtime source label/RELEASE_SHA is current; baseline image/source is consciously
recorded as reused runtime, not relabelled as newly rebuilt OS/dependencies.

Archive metadata now requires buildKind; overlay requires baseline ID/source,
dependency proof, bundle hash, audit/helper hash and recipe hash. Local deploy
recomputes source compatibility/recipe hashes. OCI load checks those fields and
source-pinned verifier, then byte-verifies the embedded compiled manifest and new
client BEFORE exposing the candidate to migrate/promote. A full-build artifact
cannot masquerade as overlay under the overlay-only job environment.
Native protected backup/actual isolated Mac restore receipt, sealed URL identity,
SQL229a..., lock5s/statement30s, OLD-image CAS and KEEP rows/history rollback stay.

### Evidence-derived forecast, not a measured build peak

`runtime-overlay-readonly-inputs-20261019.json` retains exact input provenance.
The 538419B/142-file local dist size reference is NOT a current same-run CI artifact.
The actual CI bundle must be regenerated/tested/verified and replaces that number.
Base archive compressed size is **not measured**; before transfer its cap is
635000000×1.1=698500000B. Candidate generation/layer cap uses twice measured old
client bytes + twice actual bundle bytes, rounded MiB: reference41943040B. Runtime
cap676943040B; candidate gzip cap744637344B. No unexplained 3GiB replacement.

Whole-job peaks include compressed base download, imported compressed blobs,
resident base, extraction scratch, overlay/generation writes, PG volume and daemon
save scratch + one streamed host archive. The local baseline archive and PG probe
are removed before the final archive phase. Missing PG cache increases subsequent
resident accounting; already-local base is separately credited only by exact ID.

| Profile (ESTIMATE, not sampled peak) | Host additional peak | Guest additional peak | Host free required | Guest free required |
|---|---:|---:|---:|---:|
| Compatible overlay, base not yet local, PG cached | 2.127GiB | 1.433GiB | **18.553GiB** (15 physical +1 recovery +peak×1.2) | **7.434GiB**, including observed native-GC protection below |
| Separate cold/full profile | ~6.897GiB | ~5.881GiB | ~24.28GiB | ~9.06GiB; incompatible overlay does not automatically invoke it |

The LCM logical reserve proposal remains2GiB, not another Mac physical15GiB.
Additionally the existing daemon reports GC Min Free Space5.588GiB. To avoid
inducing shared automatic cache eviction, overlay admission uses the larger
observed threshold plus rounding allowance and128MiB margin (**5.714GiB**), then
future guest writes×1.2. No GC setting is changed or prune command invoked.
This leaves only ~40MiB guest forecast headroom at the observed7.47GiB: **fresh
gates may block**, and no guaranteed fit/reclaim is claimed. Host floor15 is unchanged.
Initial admission includes cumulative residency. Later gates use current df and
only still-future writes, not a second reservation of already-resident base/layers.

Monitoring requests500ms samples per transfer/import/audit/generation/migrate/
planning/health/archive substage. CLI/query latency is bounded but cadence is not
an atomic guarantee. Baseline/minimum host APFS/guest DockerRootDir and shared
observed deltas are kept; other actors can allocate/free during samples. Host
abort16.5GiB and guest max(2.5GiB, observed-GC guard) stop only the owned worker/
BuildKit request group, never daemon/other clients. All existing ownership/partial
stream cleanup guards remain. Small proof/metadata remain; no net-zero claim.

### First real measurement remains a peer-review gate

No baseline export/load or candidate build occurred here. After independent review:
use the new **same-run tested bundle**, fresh approved root base metadata and private
client; run prepare-overlay → baseline → build → synthetic (including planning
roundtrip) → streamed archive under the existing journal/EXIT cleanup. Prefer the
gated Actions job for export; any explicitly controlled local measurement must
retain execution=local-controlled-measurement and cannot be relabelled as a GHA
deployment artifact. Inspect actual archive bytes, generated-client bytes, source/
baseline proofs, minimum sampled space, other resource preservation and Linux health.
Then review results before the already-approved Actions-only DB/API deployment.
No repeated DB-scope approval, arbitrary floor reduction, secret copy or manual OCI build.

Source verification for this overlay revision: pipeline **239**, runner kit **48**,
Python **15**, Node/CJS/Bash/YAML/diff checks. Tests cover the real current Git
compatibility proof, web-dev-only acceptance, API/native/snapshot/reachable-web
rejection, source/run/attempt/hash/path/symlink bundle drift, baseline identity/
ABI/Prisma/safety drift, pnpm path escapes, private plugin/socket/driver rejection,
preexisting base preservation, exact own alias cleanup, strict overlay metadata,
stream cap/child failure and the prior restore/SQL/identity/REST guards. New engine
execution remains fake; actual readonly base and client capability observations
are distinctly recorded and are not a candidate build/measurement proof.

## 13. Source P2 follow-up — whole CLI lifecycle regression

Independent review identified three executable gaps in403f60a, despite its239
tests: probe ordinals reset per CLI process, overlay lacked the full-build-only
`parts.syntheticPG` path, and baseline dispatch did not enter its already-defined
monitor/controller. No new production/resource permission or architecture is added.

- Probe names are now run/attempt/digest + **fixed phase + ordinal1..10**. The lease
  retains each fresh intent: a removed `--rm` probe cannot have its intent reused,
  while baseline-1/build-1/synthetic-1 are distinct. Invalid phase/ordinal and
  foreign-name/label/ID checks still fail; no intent overwrite or cleanup weakening.
- Both plan types expose one explicit `syntheticPgCap` (existing256MiB value).
  The synthetic CLI parses checked integer KiB from the exact owned PG path and
  enforces that cap; missing/malformed/over-cap values fail before success markers.
- Baseline enters the same parent `runImage` controller as build/synthetic/archive.
  Parent admission,500ms requested samples, cancellation/timeout, private worker
  nonce/PID and owned cleanup now cover SSH transfer, Docker load and base audit.
  Direct baseline `--profile-worker` cannot skip that controller. Import remains
  the baseline capacity phase. Physical15+recovery1 and all forecasts are unchanged.

The new regression uses a **single durable lease and stateful fake engine**, with
separate actual Node CLI processes baseline→build→synthetic→archive, then actual
archive verification and cleanup. Docker/SSH are bounded protocol doubles; SSH
still joins remote argv and executes an outer shell. Only the private-client
dependency is injected with standard test-only Node module hooks; production has
no test-mode flag or budget/ownership bypass. Valid synthetic execution reaches
migration, planning roundtrip, health, footprint validation, cleanup and archive.
An isolated prebuilt-candidate fixture specifically reaches the actual footprint
handler; an over-cap fixture still fails and cleans only its own resources.

Red evidence: current regressions run against a disposable copy of committed403
produced five expected failures. The real worker logs identified `resource-reuse`
at build and `TypeError reading syntheticPG` after the real du handler. Baseline
also accepted a direct worker flag and incorrectly succeeded while fake SSH/load
caused a host/guest capacity dip. The fixed source passes those same CLI tests;
capacity-dip cases record failed/cancelled samples, signal their own child group,
remove the partial LOCAL archive and do not produce build/archive success. Foreign
containers/networks/images remain intact. The baseline source-copy fixture and all
test-owned files/children are removed; no real image, export, customer data or
production operation is involved. First real Linux generation/build/measurement
still requires independent closure of these source fixes.

Verification: **247 pipeline tests**, **48 runner-kit tests**, **15 Python proof
tests**, plus Node/CJS/Bash/YAML/diff checks. The capacity-dip tests also invoke
subsequent build/archive CLIs: a cleaned terminal lease refuses heavy re-entry
before any engine operation and cannot create a success artifact. All prior239
tests remain; tests add no production bypass or changed reserve. No image build,
export/import, production operation, push, new tool or OS change was executed.

## 14. First GHA build failure — native CLI selector diagnosis

Main published615 to feature/main and approved the api-image production gate for
run39226031517/attempt1. Build-test/preflight/classification and baseline transfer/
load/audit succeeded; image build failed, so api-deploy and FE were skipped. Public
FE99/APIa2 and the unapplied new table are unchanged (Main's run observation, not a
new production DB query here). The original cleaned lease was never edited/reused.

The preserved code-only journal confirms completed=[baseline], substage=
overlay-apply-generate, status=failed-or-cancelled. Initial free host22696136704B /
guest8022151168B; sampled minimum22019788800B /7387828224B. These are SHARED sampled
baseline/import deltas, not a full candidate-build peak or owned attribution.
The63-sample final journal and239B private.log show capacity passed; Docker stderr
had been discarded by image.run, so that original child text cannot be recovered.

Actual pinned Buildx0.38 native diagnostics reproduced the pre-solve failure:

`ERROR: use docker --context=default buildx to switch to context "default"`

The source combined explicit context=colima with builder=default. Read-only inspect
of default happened to succeed through the pinned DOCKER_HOST, but commands that
select a solve/history builder reject the context/name mismatch. There was no
failed solve record to recover from BuildKit history. A guarded operator-local
**static check** (`FROM scratch`, no RUN, no tag or image output, `--call=check`)
reproduced this exact stderr with the old selection and passed with context=colima /
builder=colima on the SAME existing native docker-driver daemon. No candidate/base
export, import, generation, DB or promotion was performed in that diagnostic.

Protected small evidence (0600 under own0700 directories):
- `/Users/sanghyun/.lcm-static-build-diagnostic-fI6Gvb/receipt.json` + private.log:
  failed old selection, UUID3bcdbf00-db6a-4e86-ab94-0f8cc0a8747c; host before/after
 21680680960/21680664576B, guest8021929984B unchanged.
- `/Users/sanghyun/.lcm-static-build-diagnostic-QYODXJ/receipt.json` + private.log:
  passed matching selection, UUID9b93d7d4-5fc2-4cc9-9d55-4b43c5cec91b; host
 21836640256/21836472320B, guest8022142976/8022114304B. Tiny solver metadata may
 remain in the existing cache; no prune/reclaim or isolated df attribution claim.
All temporary contexts/plugin symlinks/static Dockerfiles were removed in finally.
The small unique receipts/logs are retained for review, not uploaded publicly.

Fix: keep private `--config ... --context colima`, exact existing Unix socket and
native docker driver, but inspect/build the matching context-native builder
**colima**, never create a builder, switch global context or edit global config.
Driver/endpoint/version/GC validation still fails closed. Resource forecasts,
physical15+recovery1, rollback/base CAS and restore/SQL/provenance guards are unchanged.

`image.run` now streams child stderr to own0600 `code-child.log`, preserving failed
stdout privately too. A structured0600 `child-failure.json` contains only fixed
operation/status/signal codes. Public CI gets e.g. `operation=overlay-build
child-exit=1 diagnostics=protected`, never raw stderr/env/credential values. Success
stdout remains machine-readable; expected readiness failures don't poison the
failure marker. This module is code-image-only, not used on customer restore logs.

Tests cover context-native builder acceptance/default endpoint rejection and an
actual failing fake build handler whose sentinel stderr stays private while its
operation/status reaches the real parent CLI. Whole-CLI ownership/monitor tests
remain. The passing static diagnostic proves the CLI selection fix only: actual
overlay apply/generate/planning health and a complete image peak are still NOT
verified. Main must review/push a new source SHA and run fresh gated Actions; no
blind reuse of the cleaned615 lease, old artifacts or old attempt as a full proof.

Verification for this diagnostic fix: **254 pipeline tests**, **48 runner tests**,
**15 Python proof tests**, Node/CJS/Bash/YAML/diff checks pass. The native static
old-selector failure and matching-selector success above are actual commands;
candidate execution in automated tests is still a stateful fake engine. All
test-owned roots/children and temporary native client contexts are cleaned. Only
the two small protected static receipts/logs are retained for review. No full
candidate image, base export/load, customer backup/restore, DDL, promotion, push,
global client configuration change, VM operation or daemon maintenance occurred.

## 15. First actual API backup failure — identity cast, not a dump/permission failure

Main's run39230515032/attempt1 at source847 passed build-test/classification,
production-gated image build, Linux Prisma regeneration, planning-model roundtrip,
health and archive upload. The preserved image journal was read selectively:
status=passed, completed baseline/runtime/synthetic/archive, cleaned,89 samples,
runtime accounting667000000B. Admission host21868621824B/guest8022114304B;
minimum21286473728B/7282618368B; shared deltas582148096B/739495936B. These are
sampled SHARED observations, not atomic/owned peak attribution. The prior §14
first image-build blocker is closed by that actual run; it is not a deployment proof.

API-deploy imported the candidate but failed backup. Read-only confirmation here:
serving image remains5d133132.../a2, public health200/ok/sourcea2; schema livingcost.lcm
has24 tables,11 applied/12 history, planning table absent. The run directory has
no customer dump, backup.manifest, restore receipt or migrate.log. Its150B stderr
contains no classified backup error; it is not evidence of a valid backup. No dump,
restore, migration, activation, KV write or backup retry was executed manually.

**Actual cause:** the candidate's real Prisma connection metadata returned the
correct DB/schema/server/port, but `inet_server_addr()::text` formats a bare IPv4
address as `PG_IP/32`. Docker's expected container address is `PG_IP`. The strict
string comparison therefore halts before pg_dump. A second read-only query showed
`host(inet_server_addr())` removes exactly that mask, without changing the actual
server. No credential URL/value/hash or customer record was returned. Current
read-only serving Config.Image also matches the pinned old compose digest reference.

Fix is PostgreSQL `host(inet_server_addr())`, NOT dropping server/schema/case/port
checks, changing URL parsing, granting permissions or altering sealed-env semantics.
Local reproduction runs the committed847 backup helper with a fake that correctly
models PostgreSQL's inet driver result: halt25/db-identity-mismatch, no pg_dump or
manifest. Current helper passes the same target. Native isolated synthetic PG16
also confirms literal `inet::text` vs `host(inet)` behavior without enabling TCP.
Existing real synthetic dump/restore/migration tests remain; no production dump was made.

Backup now records only fixed substep/outcome/code/source-line metadata in its
root-private0600 backup-status.json. Known halts and unexpected shell errors never
record BASH_COMMAND, SQL, env or row output. Root mktemp/staging, size/peak guards,
actual Prisma URL connection and native-restore-before-DDL receipt are unchanged.

Deploy child failures retain at most64KiB failed stderr per call in own0700/0600
`~/.local/state/lcm-api-deploy-diagnostics/<run>-<attempt>-<sha>/failed-stderr.log`,
outside artifact directories. **No child stdout is persisted**, especially binary
dump transfer. Only one strict allowlisted helper halt can become a public
operation/code/detail; unknown/multiline/binary output is discarded from diagnostics.
Raw stderr stays private; no customer restore log is opened or copied to chat/artifacts.

### Release detection is based on serving API, not event.before

The classifier fetches bounded public health from the fixed HTTPS API URL (no
redirect/auth), accepts only healthy exact40hex source, then GETs the fixed repo
compare `LIVE_API_SHA...EVENT_HEAD`. Exact base/head, explicit merge-base ancestry,
status, complete chronological commits below250 and files below300 are required;
unknown/error/foreign/nonancestor/truncation stays needs_api=true. Event.before is
not treated as a successful release. Thus a web-only commit after failed847 still
includes the undeployed planning foundation from livea2 and cannot skip API.
Conversely live847 followed only by web changes can skip rebuilding API.

Business/schema/package and concrete image producer/recipe helpers count as API
input. Deploy/restore/diagnostic/classifier/metadata-only support alone does not
change an already-serving payload. CI workflow changes remain conservative API
input. The pinned old-image CAS is NOT refreshed from health or removed; a later
genuine API upgrade still needs a reviewed baseline manifest refresh.

### Exact deployed reference and official KV CAS

Current code's local IMAGE_NAME and remote NEW_REF already both used `:candidate`;
there was no proven suffix mismatch to guess-fix. Registration now obtains the
actual compose/container Config.Image, immutable ID and serving health identity
from a source-pinned serving-reference helper. Only that exact observed string is
written after public health agrees. `opskv show` must identify existing kind=config
and a valid version; `get --output` uses a fresh0600 file, removed after comparison.
Before backup/SQL a new read-only KV preflight requires official value to match
the observed serving reference. Unknown/unverified differences fail without a
set; no key is created or silently overwritten. After verified promotion, only
the reviewed pinned old reference may transition to the observed new reference,
using the read version CAS; an already-equal value is idempotent. Source/health,
kind, reference, Config.Image drift and stale CAS are tested. No actual key value
was retrieved here; only public CLI help was checked, and no KV write occurred.

Next is independent review, then a **fresh new-SHA Actions run**. Do not run the
remote backup/migration by hand or reuse failed evidence as a successful restore.
The one conditional DB/API approval is retained without asking it again. A first
successful fresh backup/actual native restore and receipt is still mandatory
before the already-approved pinned SQL229a operation. Public FE remains99/APIa2.

Local validation for this revision: **286 pipeline tests**, **48 runner tests**,
**15 Python proof tests**, Node/CJS/Bash/YAML and extracted classifier/deploy shell
syntax, and diff checks pass. Read-only production state/metadata probes are
separate from local fake and isolated native synthetic-PG reproductions. All own
test roots/clusters/children and temporary KV fixture files were cleaned. No live
KV value read/write, remote helper upload/backup retry, image build, migration,
promotion, OS action or Git push occurred. Existing protected failed-run evidence
and customer data were not modified or deleted.
