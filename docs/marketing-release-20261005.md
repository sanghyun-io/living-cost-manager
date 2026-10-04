# Marketing paired release — 2026-10-05

## Status / authorization

**PREPARATION ONLY; no production changes.** Full application verification is
reported complete below; await final root review and coordinator's tested SHA.
Local documents, isolated ops worktree/helpers
are authorized. Dirty checkouts are not release inputs. No new paid resources,
broader credentials, global security-log weakening, DB mutations/customer reads,
dumps, test accounts, mail or push. Historical dump/migration instructions in the
prior release runbooks do not authorize those operations for this release.

Read AGENTS, generated `.ai/gamja-ops-policy.md`, `usability-release-20261005.md`,
`production-release-20261003.md`, and authoritative ops LCM runbook at `987e6fa`.

## Read-only evidence

- `ssh gamja-oci` uses actual `gamja-oci-proxy` Bastion, not Meshnet.
- Baseline source: `e44808e28da2f9d91b1b50bd41ed6cb0f079f786`.
- OCI: `yny.ocir.io/axuouply2298/livingcost/backend@sha256:c565ec1b63192338dd7570db5293f8b7d9ff6d76ec414737b85532d414673be6`.
- `livingcost-backend`: UID/GID **0:0**, no mounts, restart `unless-stopped`.
  Inspect candidate UID rather than assuming `node`. Reminder timer active.
- Compose `/opt/livingcost/docker-compose.yml`; protected env reference
  `/opt/livingcost/api/.env` (never print). Existing filesystem ~50 GB available.
- Pages `living-cost-manager`: source null/direct-upload, production branch `main`,
  successful `0e2ad67f-4a64-47de-9b5b-d326877075d3`, matching source SHA.
- Existing protected Pages credential works. Web Analytics metadata endpoint
  `/rum/site_info/list` returned **403**; dashboard/configuration remain unverified.
  No permissions expanded, GSC auth scraping or repeat sitemap submission.
- Authoritative dirty `/Users/sanghyun/services/gamja-ops` preserved. Separate
  approved-temp-root `lcm-marketing-ops` worktree, branch
  `docs/lcm-marketing-20261005`, created from latest LCM ops commit `987e6fa`.

## Logging / privacy boundary

Analytics service/file must contain only allowlisted daily counts: no IP, UA,
query, body, referrer, financial values or identities. Existing CF infrastructure
security metadata processing may continue; transport is not anonymous to CF.
Do not weaken global security logs. Builder's earlier blanket all-ingress
suppression prerequisite is superseded by this scope; final docs must reflect it.

Actual API gateway is **host Nginx on8080**, not website `gamja-top-nginx`.
Read-only `nginx -T` shows `/living-cost-manager/v1/` proxy and inherited
`access_log /var/log/nginx/access.log` without explicit format: default combined
includes raw query in `$request`. No custom request-body dump/debug directive
appeared in inspected gateway configuration. Default error logs can include URI
context on errors. No production log/customer request contents were read.

Optional local snippet sanitizes **only marketing-route access logging** by
normalized `$uri`, independent of query strings, preserving other routes and
security/error logs. Review before installing; no global logging suppression.
This alone is NOT a query-free guarantee for all infrastructure/error processing.

Independent review identified historical ops snapshots describing loopback8081,
`location ^~` and commented logging. Those snapshots differ from the **live
read-only `ss`/`nginx -T` evidence collected for this preparation** above; they do
not supersede it. Recheck live listener, effective location modifiers, inherited
logs and Nginx version immediately before any installation. Merge directives into
the actual existing location without changing its modifier, proxy or headers.
Derive route coverage from the final tested SHA; do not assume future endpoints
are covered by the single-route example. Require `nginx -t` before reload.

Ingress proposal reference in ops worktree:
`runbooks/livingcost-marketing-nginx-proposed.diff`, with full directives in
`runbooks/livingcost-marketing-nginx.conf.example`. The map is method-independent
and now covers **all** trailing slash counts, including query-bearing OPTIONS,
rejected POST and GET. Candidate tests use synthetic canaries only, no customer
tokens, auth resets or real event submissions. Nginx normalized-path matching is
for the production LCM prefix and events suffix, including rejected nested paths
covered by the application suffix predicate; other services remain unchanged.
Final predicate/route coverage must be compared again before approval. Error-log request/query context remains
possible and disclosed; global/error security logs are not weakened. CF security
metadata continues independently. Config diff is a review proposal, not installed.

Independent review approves local template commit only (example SHA256
`5156343e1cb01a61c41f7aee1f614a9bac248790fe93e706622ef4491e59ab3e`, diff
`534e9bbf63a67a11c9b6fb2e59dbd8a8b04386548be0924a7960c20aae903acc`).
Before application enumerate inherited AND same-location log destinations/formats/
conditions: inherited sinks can be overridden, same-level logs can duplicate.
Preserve unrelated security sinks; check rewrites/internal redirects/error_page and
more-specific locations against mutable normalized `$uri`. Contextual upstream IP
in proposal must not replace live routing. Actual target diff review/version and
`nginx -t` remain required; latest read-only SSH version check timed out.

## Pending runtime / backup contract

Draft env: `MARKETING_METRICS_ENABLED=true`,
`MARKETING_METRICS_FILE=/var/lib/lcm-marketing/aggregate.json` (verify final SHA).
Proposed existing-disk host `/opt/livingcost/marketing-data` mounted as writable
directory at `/var/lib/lcm-marketing`; directory0700, files0600, candidate UID/GID.
Never public/static. One API process/writer, including rollout; no overlapping
containers. Atomic sibling replacement; <=90 UTC dates including today. No public
or ordinary-JWT aggregate read endpoint. No DB migration.

Backend completion handoff (final source SHA still pending):

- Enabled only with literal `MARKETING_METRICS_ENABLED=true` and an absolute file
  path; otherwise route404. Valid request202 `{ok:true}`; GPC/DNT202 without store.
- 90 UTC dates, at most90 entries,65536-byte file bound,5000 per event/day and10000
  across events/day. API limits120/min globally,32 pending writes and256-byte bodies
  are API concerns, not backup limits.
- Directory0700/file0600; pre-existing unsafe0755/0644 permissions are rejected
  following the root-review fix. One bounded fixed `aggregate.json.tmp` sibling. Unsafe
  orphan/symlink rejected. Backup reads only the published `aggregate.json`.
- File fsync → rename → directory fsync. Ambiguous durability returns latched503,
  no automatic retry; corruption also isolates metrics with503 while health works.
  Health200 alone does not establish metrics readiness. Stop the single writer
  before repair/maintenance; never delete/retry around a latched error blindly.
- Startup pruning and a60-second timer after5 minutes idle; this is not continuous
  midnight deletion. Stopped-process cleanup remains operator-owned. Existing root
  UID0 is unchanged.
- Backup must mirror5000/10000/90-entry limits, not the rejected100000/490 values;
  recheck exact final SHA. No writer-provided backup interface is assumed.

Latest full verification includes API145 tests; final root review and tested SHA
remain pending. Test success is not deployment approval.

Private backup proposal (not installed):

- `/opt/livingcost/marketing-backups`, directory0700/files0600, maintenance owner.
- Proposed maintenance service UID/GID **0:0**, matching currently verified runtime,
  with root-owned backup directory/files. Candidate runtime ownership remains a
  final-SHA check; do not broaden directory permissions to make backup access work.
  Restrict the maintenance unit to read-only live-directory access and writable
  backup directory; verify access under the effective unit user before activation.
- <=7 daily sanitized snapshots, never raw events. On every safe-directory run expire old
  snapshots and prune dates before today minus89 from **every** retained snapshot,
  then atomically publish today. Strict schema/byte bounds; storage<1MB.
- Daily UTC existing-host timer with persistent catch-up, no new resources.
  Missing source must not prevent backup cleanup. Monitor failure; prune before
  export. Stopped hosts/failed timers cannot guarantee instantaneous expiration.
- Backup helper NEVER modifies live file; it reads the atomically published file.
  Read exactly `aggregate.json`, never sibling temporary files or a directory glob.
  Builder must provide in-process idle retention and disabled/stopped cleanup
  contract. External live-file maintenance requires API stopped/no active writer;
  never run a competing writer. Backup maintenance continues when API disabled.
  **Accountable owner:** deployment/operations operator for this LCM release,
  handing ongoing responsibility to the service owner before closeout. That
  operator must check timer failures and perform approved stopped/disabled-file
  cleanup with writer absence verified; a backup timer cannot clean the live file.
  Until the concrete live-file procedure and monitoring check are verified,
  activation remains blocked—there is no unconditional retention guarantee.
- No snapshots in forever release folders, Git, generic backups or offsite copies.
  Restore only with writer stopped, current-window sanitation, correct ownership,
  atomic replacement; then restart one writer. No DB restore.
  Restore source is one validated private snapshot; reapply today-minus89 through
  today date bounds before atomic publication into the live directory, assigning
  the verified API UID/GID (not blindly preserving backup root ownership).
  The <1 MB bound applies to the whole managed backup tree, including lock and
  temporary files, not to each individual snapshot.

## Procedure after coordinator handoff

1. Record full tested SHA/review and confirm no migration/schema change. Archive
   exact commit, checksum; never dirty tree or loopback development artifacts.
2. Build production FE from archive with actual production API URL; write/verify
   exact SHA metadata and reject loopback inputs. Build OCI linux/arm64 from same
   archive with release label. Reuse existing protected credentials without output.
3. Push existing OCIR, inspect remote manifest, pull by digest; verify platform,
   revision and candidate UID. Verify baseline digest availability. Clean temporary
   registry credentials after use.
4. Protected release directory holds source/FE checksums, metadata, Compose backup
   and original image reference ONLY. No DB dump/count/digest query or aggregates.
   Configuration backups0600; rollback originals preserved.
5. Verify mount/env, retention maintenance and narrow logging decision. Update ops
   service/backup/env references and runbook same session; syntax-check configs.
6. Stop old writer before candidate; backend-only Compose recreation with digest,
   `--no-deps --no-build --pull never`. No DB/tunnel recreation or timer disruption.
7. Fresh-container readiness **SELECT 1 only**, internal/public health and exact
   header/body SHA/releaseId. **Never submit a valid synthetic marketing event to
   the real aggregate**: anonymous customer overlap cannot later be identified or
   subtracted. Verify the final documented success response (current draft:
   HTTP202 with `{ "ok": true }`, not204) using identical candidate code in an isolated
   container/API with a temporary aggregate file, disabled jobs and no customer DB
   access. Public checks are malformed400 and GET404 only; verify browser opt-in/
   out with intercepted requests, not real collection. Do not manufacture/repair
   production counters to simulate a smoke test.
   GPC/DNT currently also return202 without recording: an HTTP success alone is
   not proof of persistence. In the isolated temporary-file test only, verify an
   allowed valid event increments its bucket and GPC/DNT leave it unchanged.
   Reconfirm status/body and suppression behavior at the final tested SHA.
8. Direct-upload clean same-SHA FE to existing Pages production; verify deployment
   status/metadata and both canonical/pages.dev release identities. Public browser
   verification uses new local-only contexts with network writes blocked.
9. Verify aggregate GET unavailable; check file permissions/size/timer status, not
   contents. Retain CF403/GSC readiness limits; no traffic or unique-user claims.
10. Independent helper review; ops `verify-assets.rb` and `check-local-drift.rb`.
    Classify historical Mac/other-service drift separately. Record ops commit and
    branch, never claim main merge without evidence.

## Paired rollback

Restore protected prior Compose and baseline digest, disabling new metrics env/
mount; recreate backend without overlapping writers. Roll Pages back to
`0e2ad67f-4a64-47de-9b5b-d326877075d3`. Verify identities match baseline and
SELECT1 passes. Continue backup retention and coordinate stopped live-file cleanup.
No reset/down migration, customer dump or DB restore.

## Pending evidence

Tested SHA, archive checksums, remote digest/platform/UID, Pages ID, actual mount,
target logging decision/tests, readiness/public identity, root review and installed
monitoring/cleanup checks remain pending. Local backup review/unit validation and
ops commits are complete below. This document is not proof of deployment.

### Coordinator full-application verification (before source commit)

Coordinator reports final repeated `verify:usability` exit0 **after both high-risk
fixes**: shared92 + web209 + API145 = **446 application tests**, plus operator17,
ownership2 and service-worker3. Production builds, base desktop/mobile E2E, local
persistence, isolated DB sync/deletion and13 marketing privacy browser scenarios
pass, including failed-remove revocation across two tabs/reload with zeroPOST.
Prior full-run cleanup confirmed temporary PostgreSQL/API/web stopped and purpose
cluster removed; final-run cleanup remains part of coordinator closeout evidence.

Additional latest focused real-UI consent harness: opt-in → blank ordinary Add
persisted with **zero POST** → valid Quick Add emitted **one cost event**: PASS.
`personal_cost_saved` is narrowed to **valid Quick Add only**, not ordinary manual
Add. Do not interpret all local persisted rows as measured cost-save events.

These are reported **tree-level** results, not verification of a recorded source
SHA yet. Final root-review approval remains pending. Coordinator will select and fast-forward push the
tested source SHA; do not infer it from current HEAD or promote before handoff.

Earlier root-review blockers were consent revocation persistence after `removeItem`
failure and acceptance of unsafe0755 directories/0644 files. Both are now reported
fixed with regression coverage and the repeated446-test run above. The earlier
pre-fix test result was not release proof and is superseded by this run.
Root review separately rechecked ops helper31tests and confirmed its prior high/
medium findings fixed. Installation gates (actual ownership/mount, monitoring and
stopped-file cleanup) remain. No tested source SHA has been handed off.

Local preparation checks: archive-helper `bash -n` passed; ops
`ruby scripts/verify-assets.rb` passed with existing unknown-retention warnings.
`check-local-drift.rb` failed on historical Mac LaunchDaemon/backup paths and
other-service entries; no runtime asset changes have been made by this preparation.

### Ops main integration assessment

Read-only remote fetch of ops `origin/main` on2026-10-05 returned
`eb963842234d5178920d7ced31eae2025d17edb6`. This is already an ancestor of
`987e6fa` (left/right count4/0); the four additional commits are LCM release
documentation/registry history. No merge conflict or ancestry rewrite is currently
needed. Preserve this fetched ancestry, refetch before integration and use ordinary
fast-forward/merge or PR, never force. If new upstream changes produce unrelated
conflicts, stop/report rather than resolving other services. Dirty root remains
untouched. No ops push or main integration has yet been performed.

Operational helper contents live in isolated ops worktree:
`scripts/livingcost-prepare-archive.sh`, `scripts/livingcost-marketing-backup.py`,
`scripts/test-livingcost-marketing-backup.py`; optional logging example is
`runbooks/livingcost-marketing-nginx.conf.example`. All actual maintenance scripts
and unit definitions require code review/test evidence before production use.
Draft unit content: `runbooks/livingcost-marketing-backup.service` and `.timer`.
They are not installed: root oneshot, live directory read-only, backup directory
only writable application path, network isolation, daily UTC persistent timer.
Bounded timeout/resource limits do not replace failure monitoring. Verify target
systemd version and unit syntax locally/on approved candidate before activation.
Archive-helper/docs independent re-review reports no local-preparation blockers;
backup helper approval is recorded below. Final runtime gates remain separate.

### Maintenance code review gate

Initial helper revisions were rejected after independent reviewers reproduced
overlap/hard-link mutation, duplicate-key, budget, race, bound and permission defects.
Those revisions are not installation candidates. Corrected helper passes31 tests,
including process contention, FIFO replacement and source-alias metadata checks;
final independent approval and committed hashes are recorded below.

Budget is logical bytes (not filesystem block allocation), on trusted local POSIX
directories; hostile same-UID/root actors are outside this helper's threat model.
Unsafe/over-budget destinations fail closed and need operator remediation. Live
stopped/disabled-file cleanup remains the operations owner's responsibility, not
an action performed by this backup helper.

Approved correction passes31 tests and extends source immutability checks
to bytes/mode/inode/link-count/ctime plus unchanged destination for snapshot,
temporary-name and lock hard-link aliases. Approved helper/test hashes:

```text
7b5737ca37332b82c99ce9507facca20718f847764c62d2dcfb22e8837b70883  scripts/livingcost-marketing-backup.py
1395dae7f3ab7e76ec560c9a29c72197b6590c04d8c01714ab252e63642e01c8  scripts/test-livingcost-marketing-backup.py
```

Unsafe/over-budget destination validation happens before writes and may prevent
retention too; this is a monitored operator-remediated exception, not a promise to
clean arbitrary unsafe directories. Existing local Colima Ubuntu24.04/systemd was
used for isolated synthetic unit validation below; no OCI test deployment/new VM.

### Final operational-code approval

Independent OpenAI reviewer approved the second-correction hashes above:31/31
tests plus independent snapshot/temp/lock alias reproductions preserved live bytes,
mode, inode, link count, mtime/ctime and destination metadata. Parent independently
reran31 tests, archive-helper shell syntax and ops asset validation successfully.
Reviewed unit hashes: service
`ac19971ceafca0ac0e2bdac54aa91ce8aedbf29039af6ea04e8d1be4d91c1a2c`, timer
`a22ba15f1b9c4791ac795de6ea6676b0750c7225607445f37af26b00c52b6cad`.
This supersedes earlier pending code-review status, **not** tested-SHA, actual
installed-path/ownership or failure-monitoring gates. Local Linux validation follows.

Local ops preparation commit:
`dca74bec515d4b75ee57a80be8e9c1d1b31c7d21` on
`docs/lcm-marketing-20261005`. All four committed helper/test/service/timer blob
SHA256 values match independently reviewed values exactly. Ops worktree clean;
fetched origin/main ancestry preserved. No push/main integration or production
installation performed by this commit.
Follow-up local ops commits: `c85b505` records Linux unit evidence; `a741174` records
reviewed ingress templates. No ops push or main integration performed yet.

### Completed local Linux unit validation

Existing Colima0.10.3/Ubuntu24.04.4 arm64/systemd255/Python3.12.3 validated original
unit hashes and isolated path-remapped units with `systemd-analyze verify`.
Synthetic root probe confirmed live-path write/create/delete/chmod deniedEROFS,
backup-path RW with0700/0600, IPv4/IPv6 sockets denied and abstract Unix isolation.
**Filesystem Unix sockets remain reachable**; do not claim complete IPC or all
indirect-network isolation. No real host sockets/customer data were accessed.

Synthetic exit23 propagated failure; a test-only2-second timeout terminated in
2.112s. UTC calendar and persistent flags verified; timer never enabled/started.
Only paths/probe executable were remapped, plus the timeout-test override; original
units unchanged. Synthetic units and directories were removed and independently
checked absent. Report/harness/evidence: approved-root
`lcm-marketing-unit-verification/REPORT.md`, `validate.py`, `evidence.log`.

This closes local Linux syntax/sandbox validation, not actual production ownership,
reboot catch-up, full30-second timeout/escalation or monitoring handoff. Production
still waits for coordinator SHA/root review and installation-time verification.

## Source-document freeze

This preflight document is ready for the coordinator's application source commit.
No release SHA or runtime promotion is claimed. Subsequent ingress-test results and
deployment proof will be recorded in a separate documentation commit after the
coordinator fixes the exact tested source identity; they will not alter this frozen
application source input before handoff.
