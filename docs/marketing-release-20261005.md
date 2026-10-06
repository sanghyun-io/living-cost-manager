# Marketing release — deployed 2026-10-06

## Current result

Paired OCI + Cloudflare Pages promotion completed from **one clean Git archive**:
`b5bdb0bcf4c032b43cf1a33efdae1b0abc8709f5`. Normal source-main fast-forward;
no force push, migration, DB dump/customer query, production synthetic event,
new paid resource or expanded credential scope.

| Evidence | Actual result |
| --- | --- |
| OCI image | `yny.ocir.io/axuouply2298/livingcost/backend@sha256:710811eed1afdbc63b97a27e4bf1353dfb577445ccae546e19318752905ecdad` |
| Platform / runtime user | `linux/arm64`, UID/GID `0:0` |
| Pages production deployment | `49e9519c-2a2f-4d19-a7bb-26968335b222` |
| Pages created | `2026-10-06T00:21:36.764598Z`; success, ad_hoc, main, source null/direct upload |
| Public identity | API header/body and canonical + pages.dev release metadata equal full source SHA; `releaseId=lcm-<SHA>` |
| Readiness | Fresh-container **SELECT 1 only**, internal/public health pass |
| Runtime | Backend only recreated, `unless-stopped`; existing DB/tunnel untouched; reminder timer active |

Coordinator independently reconfirmed API/FE identity and **all13 public privacy
scenarios passed** on the canonical production site with every analytics POST
intercepted: blank Add persisted with zeroPOST → valid Quick Add one intercepted
event; failed-remove revocation across two tabs and clean reload stayed OFF with
zeroPOST; GPC/DNT/default-off/failed-save/revoke/error cases passed. No real aggregate
pollution. Evidence: approved-root `lcm-marketing-public-verified.log`.

The first harness attempt correctly failed on an unrecognized Cloudflare-versioned
script. The rerun used the exact observed version
`v31edd6df95cf4e85bb4c19e7a9bdbcba1788362987495` via harness environment configuration;
the script request was still aborted before execution/no analytics egress. This was
a transparent harness adjustment, not an application-source change or weakened
production security rule.

Coordinator also passed public usability at1440/390: baseline actions, IME/focus,
renewal queue, duplicate/filter/undo, quota export/retry, import, accessibility,
overflow and reload; contexts closed and writes blocked. Five canonical guides
returned200 with single H1/canonical checks. Evidence:
`lcm-marketing-public-usability.log`. No further application tests are pending.

## Immutable build and verification

- Source tar SHA256: `64714fb197be3bc8d41f38dacbe191194b0d87616caafc43f4bffbb29af07db0`.
- Production FE tar SHA256: `758d37f1ce11bace39410319c5d0ab84e580a09d033306f2f728797d1859918b`.
- OCI build from exact archive; existing OCIR push, remote manifest and digest pull
  verified. Revision/platform and compatible rollback digest verified. Temporary
  registry credentials logged out and removed.
- FE frozen install/build uses `https://api.gamja.top/living-cost-manager/v1`;
  exported JS contains production URL, no loopback URLs. Same-SHA metadata verified;
  local/OCI tar checksums match. No development artifacts promoted.
- Final source verification after both high-risk fixes: **446 application tests**
  (shared92/web209/API145), operator17, ownership2, SW3; production builds/base E2E
  and13 privacy scenarios pass. Final independent application review passed.
- Failed-remove consent revocation persists across two tabs/reload with zeroPOST.
  Focused real-UI check: blank ordinary Add gives zeroPOST; valid Quick Add gives one
  cost event. `personal_cost_saved` measures **valid Quick Add only**, not manual Add.
- Isolated same-image/network-none temporary-file tests passed: valid202 increment,
  GPC/DNT202 unchanged, malformed400, GET404, oversized413, serialized exact counts,
  atomic replacement, permissions, capacity507, corruption503 and disabled404.
  Zero DB accesses. Candidate container/synthetic directory removed.
- Public non-recording checks passed: GET404, malformed POST400, query rejection400,
  encoded alias400. **No valid synthetic event was sent to the real aggregate.**

## Ingress approval and installed scope

Actual target Nginx1.24.0 received only the reviewed gateway insertion and new
`/etc/nginx/conf.d/lcm-marketing-status.conf`. The nested marketing location has
status-only access logging and `error_log /dev/null`. It covers canonical/nested
suffixes, all trailing slashes and decoded LF/CR; a raw-URI guard rejects encoded
aliases before forwarding to the app. Other routing, proxy headers, CORS behavior
and global/server/other-route security logs are unchanged.

| Artifact | SHA256 |
| --- | --- |
| Exact approved diff | `04859d6a1e6c55346d209f0592435576871da3e6f4e82a458153515fae2f35d3` |
| Installed gateway | `fec19f4268ff81abfcb5c9e4963187badeed4e7cb00f5f9d5fb3f6b65c61deb0` |
| Status format | `c7207ac0c251f59df09a6951082d5a97b5b95f98cee2da708218ae93fc7f0c1a` |
| Unchanged nginx.conf | `48c6a4ec1e1fd28ccf968490f07e34a1d7f755793b2108a3ed8670b1ee2a0aa2` |

Reviewer `ses_ef7dc1dd8ffewg7k4LsMgdpdtk` explicitly approved **ingress GATE PASS**
after target tests: **110 cases ×3 fixtures =330 requests**, three `nginx -t`
checks, query/body/header canaries, aliases/query spoofing, OPTIONS/GET/rejections,
oversized413, upstream502/504, unrelated-log preservation and parent `^~` precedence.
Matched logs contain status only, no canaries. All isolated processes/files cleaned.
Live baseline hashes were rechecked; actual-tree `nginx -t` passed before reload.

**Boundary:** malformed HTTP/errors before location selection and Cloudflare
security/network metadata may still be logged. This is not universal transport
anonymity. The older map/access-only proposal is **superseded; do not install it**.

## Aggregate storage and backup

- Explicit Compose env: `MARKETING_METRICS_ENABLED=true`,
  `MARKETING_METRICS_FILE=/var/lib/lcm-marketing/aggregate.json`.
- Exactly one writer. Host `/opt/livingcost/marketing-data` is mounted writable as
  `/var/lib/lcm-marketing`; root-owned directory0700, file0600 verified. Existing
  unsafe modes/symlinks are rejected. Stop the writer before repair/maintenance.
- Bounded90 UTC dates,90 entries,65536 bytes;5000/event/day,10000 total/day;
  API120/min,32 pending writes,256-byte body. Fixed sibling temp file; file fsync →
  rename → directory fsync. Ambiguity/corruption latches metrics503 without retry;
  financial API health may remain200. No public/JWT aggregate read endpoint.
- Startup prune plus60-second cleanup after5 minutes idle. This is not instantaneous
  midnight deletion and cannot clean a stopped process's file.
- Private `/opt/livingcost/marketing-backups`: root0700/files0600; at most **seven
  daily snapshots**, each pruned to today-minus89 through today; total managed logical
  bytes **<1,000,000**, including temp/lock. Backup never modifies the live file.
- `livingcost-marketing-backup.timer`: enabled/active, daily00:00 UTC, persistent;
  first manual service run `Result=success`, `ExecMainStatus=0`, private snapshot
  verified. Installed unit has live directory RO and backup directory RW.
- No aggregate data in Git, forever release folders or new offsite resources.
  Inspected existing PostgreSQL backup scripts do not include these directories.
  Do not add them to general/volume backups without enforcing equivalent retention.
- Unsafe/aliased/over-budget directories fail closed and can prevent retention;
  failures require monitored operator remediation, not an unconditional guarantee.

### Monitoring and stopped-file cleanup

**Owner: service deployment/operations owner.** Check daily00:05 UTC and before
exports/recovery; external automated notification delivery is not configured:

```sh
ssh gamja-oci 'systemctl is-active livingcost-marketing-backup.timer; systemctl show livingcost-marketing-backup.service -p Result -p ExecMainStatus; systemctl list-timers livingcost-marketing-backup.timer --no-pager'
```

On failure inspect only category/status output, protect private files and remediate.
For disabled/stopped metrics, the owner must explicitly stop the backend, prevent
any concurrent writer and invoke the reviewed helper with the recorded digest/SHA:

```sh
# On OCI, only within an approved stopped-backend maintenance window:
sudo env LCM_STOPPED_MAINTENANCE_APPROVED=yes \
  /opt/livingcost/ops/livingcost-marketing-prune-stopped.sh "$IMAGE_DIGEST" "$SOURCE_SHA"
```

It checks stopped state, successful container inspection, overlapping mounts,
ownership/symlinks and image identity, then runs the same Store startup prune in an
isolated maintenance container with no network/DB/events. It does not silently
repair corruption. Keep backend stopped until it completes, then perform approved
restart/readiness checks. This maintenance was **not unnecessarily run on live data**.

Independent code review: backup31tests; stopped-helper14 mocked guards at Python
optimization0/1/2. Approved/installed hashes:

```text
7b5737ca37332b82c99ce9507facca20718f847764c62d2dcfb22e8837b70883  backup.py
2397ca8fe30f417400a1dd8d1901af452246964533679a17dcc3fbdd43085da4  prune-stopped.sh
ac19971ceafca0ac0e2bdac54aa91ce8aedbf29039af6ea04e8d1be4d91c1a2c  backup.service
a22ba15f1b9c4791ac795de6ea6676b0750c7225607445f37af26b00c52b6cad  backup.timer
```

Local Linux unit tests verified root/permissions, live RO, backup RW, IP socket
denial, failure propagation and shortened timeout. Filesystem Unix sockets are not
fully isolated. Target unit syntax passed; unrelated existing OCI monitoring units
produced executable-mode warnings and were not altered.

## Rollback and evidence locations

Paired baseline source `e44808e28da2f9d91b1b50bd41ed6cb0f079f786`:
OCI digest `sha256:c565ec1b63192338dd7570db5293f8b7d9ff6d76ec414737b85532d414673be6`,
Pages `0e2ad67f-4a64-47de-9b5b-d326877075d3`. Restore protected prior Compose,
backend-only recreation without overlapping writers, rollback Pages, then verify
identity and SELECT1. No DB restore/reset/migration. Keep backup retention active
and assign stopped-file cleanup even after metrics rollback.

Protected OCI release directory:
`/opt/livingcost/releases/marketing-b5bdb0bcf4c032b43cf1a33efdae1b0abc8709f5/`.
It contains source/FE archives, remote manifests, isolated-test evidence, reviewed
ops files, Compose and gateway backups, installed hashes and activation timestamps;
**no customer DB dump or real aggregate snapshots**. Compose backup SHA256
`6c8b35b76e3317aec8a8da0de7741d8df2132361466813ff4cc18659c2bbdab1`.

Local approved-root evidence: `lcm-marketing-ingress-gate-final/REPORT.md`,
`lcm-marketing-unit-verification/REPORT.md`, `lcm-marketing-release-b5bdb0b/`.
Ops main fast-forward completed `eb96384 → f6348e90895430020c3ac322d6d97dc56dbf40e7`;
remote main verified, no force/conflict. Isolated `lcm-marketing-ops` is clean;
original dirty checkout preserved. Registry reviewer approved scoped assets and
`verify-assets.rb` passed. `check-local-drift.rb` still reports historical Mac/
other-service entries and incorrectly checks the OCI backup path on Mac; actual OCI
path/permissions were verified. Full output: local release `ops-local-drift.log`.
The exact reviewed unified diff retains its required blank-context space; Git's
blank-at-EOL check was disabled for that validation invocation only, not repo config.

## External limitations

- Cloudflare Web Analytics metadata returned403 with the existing Pages credential;
  no permission expansion or dashboard-configuration success claimed.
- GSC/manual CSV steps remain operator-owned; no auth scraping or repeat submission.
- Counts are anonymous submitted milestones, not unique people/conversion/retention;
  public submissions can be forged. No traffic outcome claimed from deployment.
- One Python-urllib public probe received403; ordinary curl verified health and all
  listed non-recording checks. No Cloudflare rule/security setting was weakened.
