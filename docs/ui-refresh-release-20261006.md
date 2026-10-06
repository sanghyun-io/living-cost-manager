# Reviewed UI refresh — 2026-10-06

## Source and scope

Paired OCI API and Cloudflare Pages promotion uses application source **`02ae219d2d87c45df0cd35343799d4eb132e749e`**, a normal merge of reviewed checkpoint `9eafeee4917709cba46f30168dde83705ab2623a` (app implementation `b7d6fb9876a79ad1e8619ed9081032503269399a`). `git diff 9eafeee HEAD` was empty before release documentation. Source main advanced `e829520 → 02ae219` without force. This document is a later documentation commit, not another deployed source SHA.

Coordinator supplied independent read-only review `ses_eef9e8f55ffePgaiiQhUQ1i5l1`: **PASS / blockers0**. No application edits were made after that checkpoint. Optional CoachModal copy changes were skipped rather than altering reviewed behavior/privacy disclosure. Original dirty checkout, frozen UI tree and ongoing template branch were not modified or interrupted. Templates are not part of this release.

Monthly-normalized budget and actual upcoming payments are clearer; restrained colors, task hierarchy, filters, responsive editing and full-width outer header are preserved. No new collection, dependencies, DB schema, env, provider, routing, worker or billing activation. **Charge OFF**, planned990/9900, optional statistics default OFF remain unchanged. Demand, willingness to pay, revenue and profitability are unmeasured.

## Verification and immutable artifacts

The release agent reran full isolated `verify:usability` at the exact merge source: **557 application tests = shared115 + web210 + API232**, all PASS. Operator17 / verification ownership2 / service worker3 are separate counts. API/FE builds, real purpose-created local API sync/conflict/relogin/profile/account deletion, four-width usability/UI checks, all13 privacy scenarios and planned-pricing/static-no-JS tests passed. Temporary PostgreSQL cluster and API/static-server processes were stopped/removed. No production DSN/customer query was used for tests.

Production FE was built separately from the immutable source archive with frozen lockfile and `https://api.gamja.top/living-cost-manager/v1`. Exported JS contains that URL and no loopback URL; release metadata equals the full SHA. This artifact is not the loopback test build. Exact production artifact UI checks at1440/1280/390/360 plus pricing390/1440 and static HTML passed; its local server closed.

| Artifact | SHA256 |
|---|---|
| Source archive | `82dd214abf36738d74595ad58a41ac68ff577f0ac413f703aa22815bd638686f` |
| Production frontend archive | `8feb4e2c00cbef3b0d0f99490ba2f81834df0e8ea9ae34a18f80414bdad48ae4` |

OCI archive hashes matched local. Exact candidate image revision/platform verified (`linux/arm64`), pushed to existing OCIR, remote manifest inspected and pulled by digest. Compatible baseline manifest/image verified. Exact image planned/OFF pricing and own-key guards passed isolated with `--network none`, no DB/env and `--rm`. Temporary Docker credentials were logged out/removed. Existing scoped Pages token was used only in its subprocess; no scope expansion.

## Live baseline, promotion and rollback

Preflight API and canonical/pages.dev metadata were all `442640be7cb399d2324e9ac24bc86f3f9a3276f8`. OCI baseline was `yny.ocir.io/axuouply2298/livingcost/backend@sha256:a9a9567cd09c4eb55bf3b53c82da568b37766cf7c0587c55ca6922a6c08de8ac`; Pages baseline `50114e8b-6bde-45f3-93d1-73a88ed47187`. Actual SSH Bastion-backed alias and live assets were checked; stale Meshnet/old domains/retired FE Actions were not used.

Protected rollback directory `/opt/livingcost/releases/pricing-02ae219d2d87c45df0cd35343799d4eb132e749e/` reuses the existing noncharging procedure prefix. It contains protected Compose/image/env-hash baseline and immutable source/FE archives, no DB dump or aggregate snapshot. Baseline Compose SHA256 `e8852b1e2ea8561eaa3ccedd3647ffc9a36d61686003937c3b361c11e14d79b3` was rechecked immediately before changing only the backend image digest.

| Evidence | Actual result |
|---|---|
| OCI image | `yny.ocir.io/axuouply2298/livingcost/backend@sha256:ca5f75291d563ba032981af1b158bf8e21cae9afa99bae4bd790559d900d68bd` |
| Pages project | existing `living-cost-manager`, direct upload/source:null, production/main |
| Pages deployment | `c443ace1-07e9-4bea-bc48-3047784a12a9` |
| Pages created / success UTC | `2026-10-06T08:58:41.532885Z` / `2026-10-06T08:58:42.839003Z` |
| Pages trigger | ad_hoc/main, exact source SHA, commit_dirty:false |
| API identity | HTTP200; X-Release-Sha and body commitSha match full source, releaseId=lcm-SHA |
| Canonical + pages.dev | HTTP200 release-meta.json, matching commitSha/releaseId |
| Fresh-container readiness | SELECT1 only + internal identity PASS |
| Installed Compose SHA256 | `8897e9a0d569d64d63aaffd4732aa0a5cdc3042058725685098484ede06e39be` |
| Runtime preservation | backend only recreated; unless-stopped, no host ports, identical marketing mount, unchanged env-file hash, both timers active |
| Storage | existing marketing directory0700/file0600 and backup directory0700/files0600; stat-only backup check within existing file/byte bounds |

Rollback: first exclude a subsequent unrelated deployment; restore protected Compose, recreate backend only using the compatible baseline digest, roll Pages back to recorded baseline, then check API/FE identities, SELECT1, timers and preserved runtime/storage settings. No DB migration or restoration; current API/schema contracts are identical. Preserve single marketing writer and retention-bound storage. No customer financial records, real aggregate contents, synthetic production events, KCP correspondence, emails or new paid resources were involved.

No central ops edit was necessary: this internal application promotion did not change registry-owned runtime/route/provider/secret/DB/backup configuration. The generated policy was not manually edited.

## Public acceptance and retained evidence

**Public regression acceptance PASS**, final paired identity recheck at `2026-10-06T09:01:32.178389Z`. Canonical production UI and existing edit regressions passed1440/1280/390/360: hierarchy, sample isolation, annual120000 actual due vs monthly10000 comparison, header/content alignment, no horizontal overflow, touch44px, AA contrast, keyboard/focus/Escape/restoration and dark mode. UI screenshots at1440 sample,390 privacy settings and360 scheduled editing were directly inspected by the release agent; this is additional artifact/public verification, not a replacement for the supplied independent review.

All **13 public privacy scenarios PASS**: default-off/consent, network/server failure, unsent withdrawal, GPC/DNT, storage read/write/marker/remove failures, failed personal save, cross-tab and inflight abort. Every marketing POST was intercepted; synthetic counts in harness logs are intercepted fixture counts, not real production aggregates. Known exact Cloudflare-versioned script was aborted before execution/egress. No real account creation or financial/marketing API write, persistent browser profile or test email.

Public planned-pricing checks passed390/1440 with JavaScript ON/OFF: exact990/9900/comparison/preparation copy, guide/FAQ JSON-LD, no checkout/card/provider scripts/egress/errors/overflow. Five canonical guide routes HTTP200 with one H1/canonical. All browser contexts closed. Full isolated test cluster/server cleanup and exact-artifact local-server cleanup passed.

Approved local evidence root: `/private/var/folders/f_/kdvkncsn11l2nssxg_75xglc0000gp/T/opencode/lcm-ui-release-evidence/`.

- `full-verify.log`, `candidate-check.log`, `oci-build.log`, `oci-registry-proof.log`, `oci-promote.log`, `pages-deploy.log`.
- `public-{ui,usability,privacy,pricing}.log`, `public-final.log`, `cloudflare.{before,after}.json`, `runtime.after.json`, `release-summary.json`.
- Local-only screenshot links (also retained in protected evidence archive): [public desktop sample](file:///private/var/folders/f_/kdvkncsn11l2nssxg_75xglc0000gp/T/opencode/lcm-ui-release-evidence/public-screenshots/after-sample-1440.png), [public390 privacy settings](file:///private/var/folders/f_/kdvkncsn11l2nssxg_75xglc0000gp/T/opencode/lcm-ui-release-evidence/public-screenshots/after-settings-390.png), [public360 scheduled edit](file:///private/var/folders/f_/kdvkncsn11l2nssxg_75xglc0000gp/T/opencode/lcm-ui-release-evidence/public-screenshots/after-scheduled-360.png). All contain only generated sample/local fixture data.
- Local and protected OCI `evidence.tar` SHA256 both `2859a011cc933fc8188e2775f4d7cfc597c9481f9bc33542f2cc1ca6cb2ebf57`; non-secret logs/metadata/synthetic screenshots only. No customer DB, real aggregate or credential values copied.

Remaining boundaries: templates remain separate/unreleased; optional CoachModal wording and further mobile field-order refinement are not included. Payment/legal/merchant activation and KCP correspondence still belong to their separately approved owners. This release verifies technical delivery, not business outcomes.
