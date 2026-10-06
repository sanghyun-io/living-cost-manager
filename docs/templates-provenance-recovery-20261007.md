# Templates corrective evidence — 2026-10-07

## Status: partial remediation, NOT incident resolved / ALL PASS

No application code, live API image, production database, Pages deployment or
credential changed in this corrective task. Owner token revocation/rotation and
independent read-only review remain pending. Existing dirty checkouts are preserved.

This evidence branch starts at reviewed template source
`8c4e1282614a99c1654abdac0b3618ddd998d231`; freshly fetched origin/main still
resolved to `21dd449e7aaae497d2d24d721e9041302317c676` during this task.
Do not infer a later main merge was pushed from another worker's narrative.

## Credential containment

Actual assignment value in `/Users/sanghyun/docs/templates-frontend-repair-20261007.md`
(reviewer discovery line47) was replaced internally without exposing its value
to tools/chat/arguments. Main had already set0600; cleanup preserved other notes.
A correction distinguishes that historical narrative from verified provenance.
Private incident receipt is `docs/templates-security-incident-20261007.md` in this
branch; it records exact scan limits without any token or fingerprint.

The initial exact-value helper timed out after redaction while scanning too much
temporary evidence. Its original in-process token was lost; no exhaustive absence
claim is justified. Follow-up inspected57 local markdown/task-prefixed evidence
files using candidate assignment matching, found0 candidate-bearing files, but
cannot conclusively link candidates to the now-redacted value. Git history,
OpenCode conversation/database logs and oversized files remain unverified. No
conversation record deletion/history rewrite occurred. Owner-approved revocation
is still required because redaction does not revoke a credential.

## Fresh clean-source build: success; full byte equivalence: BLOCKED

Command: `python3 scripts/templates-clean-build-proof.py 8c4e1282614a99c1654abdac0b3618ddd998d231`.
The helper archives the exact commit, extracts a new private tree, uses only the
existing offline pnpm cache/frozen lockfile, removes inherited provider/DB env,
sets production public API base, and does not deploy or fabricate release metadata.

Second receipt (readonly0400 inside private0700 directory):
`/private/var/folders/f_/kdvkncsn11l2nssxg_75xglc0000gp/T/opencode/lcm-clean-proof-je1is0ew/receipt.json`.

- Source archive SHA256
  `b026dde8d916dd5ff3e30035bfcb39879be9035cf23f3f85f9bb8cfdc0e6e42d`,
  identical to the OCI template release `source.tar` actually rechecked.
- Offline install, shared build and web build each exit0.186 output files;
  compiled JS contains `https://api.gamja.top/living-cost-manager/v1`.
- Artifact-manifest SHA256
  `59e1c10daa947befd670fbe892bf7f981d4bb447693415565a8d9b6a1464af81`.
- Public root/guide template HTML references9 unique JS assets:8 exact byte/hash
  matches; public `/_next/static/chunks/04zky9c.tarbv.js` is absent from this clean
  artifact. Closest local candidate `0_mxdd465o0zy.js` has666373 bytes vs public
  666357; difference is NOT explained by substituting recorded Next BUILD_IDs.
  Cause is unconfirmed; do not claim deterministic source equivalence or CDN fault.
- First receipt `lcm-clean-proof-0eyljs6l/receipt.json` preserves build success and
  Python HTTP fetch failures. Switching only public transport to curl succeeded.
  Neither receipt was rewritten. The subsequently hardened helper exits2 when
  public equivalence fails; the original recorded invocation exited0 for build
  success, with `all_compared_public_js_match=false` explicitly recorded.
- Diff investigations timed out; no output/code/token spans were emitted. No
  source edit, metadata relabel, upload, rollback or redeploy was used to hide mismatch.

## Actual OCI restore, registry and rollback

`scripts/templates-oci-restore-proof.sh` actually restored the approved existing
37095-byte pre-template archive into a cached PostgreSQL16 disposable container,
network:none, no host ports, tmpfs data, unique ownership label. `pg_restore` exit0;
exact template migration exit0 (5s lock/30s statement timeouts);13→15 tables,
existing schema equal, new constraints validated; no customer row query.
Owned container/volumes removed. Production only observed through table metadata;
it has15 base tables and the2 expected template tables. No production migration
was repeated and no backup was copied to Mac.

Receipt OCI directory:
`/opt/livingcost/releases/templates-8c4e1282614a99c1654abdac0b3618ddd998d231/restore-proof-20261007.5fgteR`
(0700, files0600; `completed_utc=2026-10-06T16:06:40Z`). Initial wrapper final chmod
failed after successful restore/cleanup due to root-only glob expansion;
permissions were safely finalized separately, stat verified, helper fixed.

Registry correction branch `incident/lcm-backup-proof-20261007` is based on freshly
fetched gamja-ops main `f6348e90895430020c3ac322d6d97dc56dbf40e7` in
`lcm-backup-proof`. It records actual OCI livingcost backup timer enabled/active,
service exit0, daily04:10UTC+10m/persistent, daily14/monthly93day pruning, protected
receipts, unverified offsite copy, and recovery limitations.

Correct rollback uses template release **compose.before.yml + image.before.txt**,
old API digest `ca5f75291d563ba032981af1b158bf8e21cae9afa99bae4bd790559d900d68bd`,
and prior immutable Pages production deployment
`c443ace1-07e9-4bea-bc48-3047784a12a9`. Never old-SHA-label the new output.
Retain new template tables/data; never restore the pre-template DB to undo this
feature. Actual rollback/provider access remains unexecuted and approval gated.
See gamja-ops `runbooks/livingcost-templates-recovery-20261007.md`.

Registry YAML verification passed with expected unknown-policy/offsite warnings.
`python3 scripts/test-templates-clean-build-proof.py`:5 tests PASS;
`bash -n scripts/templates-oci-restore-proof.sh`:PASS. Full application tests were
not repeated for these helper/document-only changes; main must arrange independent
read-only review and any additional verification before merge/use.
Local drift command exit1 lists existing Mac-service removals and remote OCI paths
as missing locally; it is not evidence of OCI backup failure or permission to fix
unrelated services. No generated policy was manually edited.

Remaining: Owner-approved credential revocation/rotation, complete bounded exact
exposure/history investigation where possible, missing-JS provenance analysis,
independent helper/registry review, and any approved fresh deployment/public smoke.
No new billed infrastructure was created; GPT calls are within the approved task.

## Reviewer-requested helper correction (local synthetic verification only)

Following conditional independent review, the reusable restore helper was corrected:

- Replaced asynchronous process-substitution diagnostic writers with synchronous
  `sudo sh` redirections in the private root-owned0700 receipt directory. Both
  log files must open before executing restore/migration; noclobber and077 umask
  apply, and pipeline failures propagate. No diagnostic body is printed publicly.
- Cleanup is armed before Docker startup, because a failed `docker run` may still
  create a container. Pre-existing exact names are rejected before arming. Cleanup
  inspects only the unique name and verifies its exact ownership label before
  `docker rm -f -v`; it never removes another owner's container or global volumes.
  Inspect failure requires a successful exact-name absence check rather than
  guessing absence. Unverified ownership/resources remain intact with failure.
- EXIT cleanup preserves the original startup/restore/diagnostic failure status;
  cleanup failure cannot produce a successful completed receipt. The completion
  timestamp and `proof_complete=true` are written only after synchronous commands,
  owned-target cleanup and final permission checks succeed. Explicit exits make
  safety guards fail closed even on local Bash3.2 conditional-errexit behavior.
- Pinned release directories and backup/migration leaf symlinks are checked;
  receipt ownership/mode is checked before privileged log writes.

Actual local verification after these edits:
`bash -n scripts/templates-oci-restore-proof.sh` PASS;
`python3 scripts/test-templates-oci-restore-proof.py` **10 tests PASS**;
`python3 scripts/test-templates-clean-build-proof.py` **5 tests PASS**;
`git diff --check` PASS. Protected combined log (0600):
`/private/var/folders/f_/kdvkncsn11l2nssxg_75xglc0000gp/T/opencode/lcm-restore-helper-review-fix-20261007.log`.

The executable-level restore tests use fake Docker/sudo commands and test-owned
temporary synthetic fixtures only. They cover successful awaited private logs,
startup-fails-after-creation cleanup, wrong-label preservation, pre-existing-name
preservation, inspect/daemon failures, restore/migration diagnostic writer failures,
stderr-open failure, restore exit propagation, cleanup failure and preservation of
the original startup exit when cleanup also fails. Removal assertions permit only
the owned unique target with `-v`; diagnostics/receipts are absent from completed
public output on failure. Tests do not prove real daemon or volume behavior.

No OCI restore was repeated for these corrections. The earlier actual restore
receipt remains historical evidence of that execution, not evidence that these
new failure cases occurred or passed in production. No registry worktree, app
API/web/shared source, credential or provider operation was changed. Existing
untracked `scripts/__pycache__/` is preserved. Main must obtain follow-up independent
review of this correction; credential incident and JS provenance blockers remain open.
