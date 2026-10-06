# Noncharging billing foundation / settings UX release — 2026-10-06

## Source and approved scope

Application source **`442640be7cb399d2324e9ac24bc86f3f9a3276f8`** is a normal merge of the separately preserved implementation history into `origin/main`. Source push advanced `fe0c568 → 442640b` without force. Original dirty checkout and other worktrees were preserved. A later release-document commit is not a new application deployment SHA.

- `3794fc0`: pure server billing domain and truthful public renewal preparation.
- `2bf66e2`: optional statistics in Data management, understandable purpose/scope/withdrawal, page-lifetime privacy guards; viewport-wide outer header and aligned constrained content.
- `f247eed`: runtime string/nonempty/200-character reference validation and boolean cancellation intent, regression coverage. No route/SDK/webhook/worker/payment credentials/card form/durable billing ledger or paid unlock.

**Actual charge OFF.** Existing free functions unchanged. Monthly990 / annual9900 preparation;825 monthly equivalent is not a monthly charge;1980 annual comparison savings; VAT-inclusive assumption remains unverified. KCP amount-setting correspondence belongs to the user and was not performed. Merchant/legal/tax/live activation approval is not inferred from this noncharging release.

## Review and verification

Main coordinator supplied reviewer `ses_eefd9dd79ffeLw34Q6M2nEnSUG` and security `ses_eefd9b2dcffeX5WuQ3aY3yyVH3`: **PASS / blockers0**. They directly reproduced shared115/billing37/consent6/API TypeScript. Runtime guard follow-ups were then tested under the coordinator's explicit conditional promotion approval; no independent re-review of those later lines is claimed.

Final `verify:usability`: **557 application tests**, shared115/web210/API232 including billing87; operator17/ownership2/SW3 separately. API+FE builds, local real API sync/conflict/relogin/account deletion,1440/390 layout/keyboard/restored focus,13 privacy scenarios and pricing/static HTML passed. Purpose-created PostgreSQL/server processes stopped and cluster removed. No production DSN/customer data used.

Immutable source archive SHA256 `4233e60315e3999fea682455425ace806f7e901e6de96b28e4aaf1b6a4f0c182`.
Production FE archive SHA256 `2ff1cc8e221498733d2dabcb1184671e2c3ee7b9f8e686e9705dd4718a567e84`.
FE frozen build from exact archive used production API `https://api.gamja.top/living-cost-manager/v1`; exported JS has that URL and no loopback URL. Metadata has full source SHA. Exact artifact pricing and settings390/1440/keyboard/privacy-consent checks passed.

First archive FE install attempt selected Corepack's global package version because its working directory was the outer archive directory. It failed before building. Rerun inside exact extracted project correctly used pinned pnpm11.1.3/frozen lockfile and passed; source/config/version checks were not weakened.

## Actual baseline and rollback

Preflight verified API header/body and both frontend metadata source `c77079d622e23e2f763411f95e7dc6b2f7a92ab0`.
OCI image `yny.ocir.io/axuouply2298/livingcost/backend@sha256:d3c9c38ddfe7f8671acf071557b3d1ba16dc5b9afc35cd6baf3a3460164524a9`.
Pages production baseline `b48d54fb-2e23-4583-925d-6f4ba871b5d4`, existing project `living-cost-manager`, production branch main, source:null/direct upload.

Compose baseline SHA256 `b88dcea8bd8f0db6c7dad57033026f2a0d863a1a83ecba5eebbe5ab2f0116d30`.
Protected release directory `/opt/livingcost/releases/pricing-442640be7cb399d2324e9ac24bc86f3f9a3276f8/` (existing noncharging procedure prefix reused) contains `compose.before.yml`, `image.before.txt`, environment-file hash and immutable source/FE archives. Archive hashes matched local exactly. No env contents, DB dump or real aggregate snapshot copied.

Rollback restores protected Compose, recreates **backend only** with compatible baseline image, rolls Pages back to baseline deployment, then checks API/FE identities,SELECT1 and timers. No DB restoration or migration. Recheck baseline Compose/image before promotion. Preserve single writer, existing marketing volume and private retention-bound backups. Source schema/env/app route diffs are empty.

Preflight: running backend, `unless-stopped`, no published ports; reminder and marketing-backup timers active; existing marketing directory0700/file0600 and backup directory0700. Readiness used **SELECT1 only**. No customer financial records or real aggregate contents read.

## Promotion and public evidence

**Paired promotion and public browser regressions completed.** No runtime,provider,secret,route,DB/worker/ownership configuration change was made; central ops assets are therefore unchanged. Existing authoritative runbook and current runtime were cross-checked rather than relying on the original stale README.

| Evidence | Actual result |
|---|---|
| OCI image | `yny.ocir.io/axuouply2298/livingcost/backend@sha256:a9a9567cd09c4eb55bf3b53c82da568b37766cf7c0587c55ca6922a6c08de8ac` |
| OCI revision/platform | exact full source SHA / linux/arm64; remote manifest/push/digest pull and compatible baseline image verified |
| Exact image isolation | pricing planned/OFF and runtime invalid-reference/boolean guards passed with `--network none`, no DB/env, `--rm` |
| Pages production | `50114e8b-6bde-45f3-93d1-73a88ed47187` |
| Pages created / success | `2026-10-06T07:55:29.346317Z` / `2026-10-06T07:55:30.946992Z`, ad_hoc/main/clean source |
| Public API | HTTP200; header X-Release-Sha and body commitSha/releaseId equal full source SHA |
| Canonical and pages.dev | HTTP200 release-meta.json, both commitSha/releaseId equal full source SHA |
| Installed Compose SHA256 | `e8852b1e2ea8561eaa3ccedd3647ffc9a36d61686003937c3b361c11e14d79b3` |
| Runtime preservation | backend only recreated; unless-stopped/no host ports/identical marketing mount; env-file hash unchanged; both timers active; private0700/0600 storage modes retained |
| Readiness | new-container SELECT1 only and internal identity passed |

Only the backend image digest changed in Compose, protected baseline rechecked immediately before replacement. No migration/customer query/aggregate snapshot or synthetic real event. Registry login used the existing OCI API profile's short-lived token over SSH stdin; temporary Docker credential directory was logged out/deleted and its absence verified. Pages used its existing scoped token only in the deployment subprocess, without scope expansion.

Public pricing checks passed390/1440 with JavaScript ON/OFF: exact price/comparison/preparation copy, guide+FAQ/JSON-LD, no checkout/card/provider scripts, overflow/errors/egress absent. All five guide routes HTTP200 with single H1/canonical. Public paired API/FE identities matched source. Public header/settings screenshots were directly inspected at1440/390; outer width/border reached viewport, content stayed aligned, control was absent from header and present in Data management with unchecked default and explicit purpose. Keyboard opening/focus/Escape/restoration assertions passed.

All **13 public privacy scenarios passed**: default-off/consent, network/server failures, unsent withdrawal,GPC,DNT,storage read/write/marker/removal faults,failed personal save,cross-tab and inflight abort. Every marketing POST was intercepted; no customer API writes/account creation/email/real aggregate pollution. The exact previously observed Cloudflare script URL was aborted before execution/egress, not enabled or broadly allowlisted. Existing public usability1440/390 passed IME/focus,renewal queue,duplicate/filter/undo,quota export/retry,import/cancel/apply,accessibility/overflow/reload.

Evidence is retained in approved temp root `lcm-billing-release-442640be7cb399d2324e9ac24bc86f3f9a3276f8/`: source/FE archives, build/registry/domain/promotion logs, Cloudflare metadata, public pricing/privacy/usability logs and public settings/guide screenshots. Final isolated full-test log is sibling `lcm-billing-hardened-verify.log`. Temporary DB/server fixtures and all browser contexts were closed; no persistent Mac service added. The own duplicate archive FE build directory was removed after source/FE checksum+archive-list validation; original review worktree remains available. Protected local/OCI `evidence.tar` hashes both equal `bcaa7b19056624f8caa85364ee0e3413575839cb6d0f2d8dcddf04238c4a14a0`. It contains non-secret logs/metadata/synthetic screenshots, not real customer/aggregate data.

## Remaining business/legal boundaries

This deploy does not prove customer demand, repeated use, willingness to pay, revenue or profitability. Server domain is pure/unwired, not an account's real paid subscription. Durable unique/row locks/fences/atomic event receipt/paid period/refund storage and actual provider signature/sandbox tests remain prerequisites for real billing. Legal/merchant/tax/cancel/refund/grace/privacy retention decisions require the defined Owner/professional gates. Existing reminder crash/per-device partial failure limitations are documented in the foundation audit, not claimed solved.
