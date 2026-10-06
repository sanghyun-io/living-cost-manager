# Planned pricing release — 2026-10-06

## Scope and source

Monthly **990 KRW**, annual **9,900 KRW**, VAT-inclusive **assumption**. Annual
monthly equivalent 825 KRW is comparison only; annual total is 9,900 KRW. Savings
versus twelve monthly payments is 1,980 KRW / exactly one sixth (about 16.7%).
Guide + FAQ + FAQ JSON-LD say **planned / cannot purchase**. Existing local value
is usable without payment. No card input/payment SDK/order endpoint/webhook/billing
worker/paid entitlement/new PII storage/merchant application or contract was added.
Checkout stays OFF. No customer charge, email, production customer query, migration,
DB dump/restore or new paid resource was performed. Readiness uses SELECT 1 only.

- Application source: `c77079d622e23e2f763411f95e7dc6b2f7a92ab0`.
- Main advanced normally from `9752094…`; no force push. Original dirty checkout
  and existing marketing worktree were untouched. This release document is a later
  documentation commit, **not** a different deployed application build.
- Exact source tar SHA256:
  `a52b3c63fa67c9b60d9c8db290da2148da1740ef25767f0d1a4b2ee99bd660f2`.
- Production frontend tar SHA256:
  `76cb91ad55dfd94637f9f58145bc37a5a6670ed0c599a1849a07d3f6da1839b0`.
- FE built from that archive with canonical production API URL. Exported JS has
  the production URL and no loopback URL; release metadata equals the full SHA.

## Review and verification

Coordinator supplied independent reviewer `ses_ef0fa6d42ffedG651tpdYhg3pZ` and
security `ses_ef0f4cc48ffeXpLO6qZHNRcySg`: **PASS / no blocker**. Their partial
reproduction was shared109 + pricing browser; the implementer's full463 log is
separate evidence. Reviewer suggestions were applied: historical 2,900 KRW marked
superseded, twelve-payment wording corrected, shared prebuild for `verify:pricing`,
named link lookup, explicit missing FAQ assertions and primitive/array/own-key cases.

The own `__proto__` test first failed because Zod ignored that raw key. An explicit
raw own-key guard now rejects it, inherited plan IDs, symbol and other unknown keys.
This hardening was regression tested after the supplied reviews; do not claim the
reviewers independently re-reviewed the later guard. Security's gate remains: never
flip checkout OFF to ON without merchant/legal/tax/security and copy review.

Final `pnpm verify:usability`: **469 application tests** (shared115/web209/API145),
operator17, ownership2, SW3, production API/FE builds, local API sync/account deletion,
1440/390 usability, 13 marketing privacy cases, pricing/FAQ/JSON-LD/no-JS checks pass.
All purpose-created local DB/server fixtures were stopped/removed. Isolated full
verification did not use production credentials or customer data. Exact-archive
production FE `pnpm verify:pricing` also passed at390/1440.

## Baseline and rollback

Actual preflight FE project: `living-cost-manager`, direct upload (`source:null`),
production branch main, canonical `https://living-cost-manager.gamja.top`.
API/FE baseline source `b5bdb0bcf4c032b43cf1a33efdae1b0abc8709f5`.
Pages baseline `49e9519c-2a2f-4d19-a7bb-26968335b222`.
OCI baseline image:
`yny.ocir.io/axuouply2298/livingcost/backend@sha256:710811eed1afdbc63b97a27e4bf1353dfb577445ccae546e19318752905ecdad`.
Runtime backend running, restart `unless-stopped`, reminder timer active; SELECT1
passed. No backend host published port change, DB/tunnel/ingress/metrics settings change.

Protected rollback Compose:
`/opt/livingcost/releases/pricing-c77079d622e23e2f763411f95e7dc6b2f7a92ab0/compose.before.yml`,
SHA256 `9190c5f88089a8dd6c818e0744e7d49625c09d8f290eaa3538585343ebd92fa6`.
Before promotion, current Compose must still match that hash and runtime image must
match baseline. Only backend image digest is changed, keeping all other settings.
No DB migration/restore needed. Paired rollback: restore this protected Compose,
recreate backend only with baseline digest, return Pages to the baseline deployment,
then verify API header/body + both FE metadata equal baseline plus SELECT1/timer.
Preserve metrics single-writer/backup retention and do not replay synthetic events.

## Promotion and public checks

**Paired promotion completed.** OCI built from the exact source archive; revision
and `linux/arm64` platform verified. Existing OCIR push, remote manifest and digest
pull succeeded; baseline registry manifest and compatible rollback image verified.
Exact candidate image's pricing ran isolated with `--network none`, no DB/env:
990/9900 integer amounts, planned/OFF, annual savings and own-key rejection passed.

| Evidence | Actual result |
|---|---|
| OCI image | `yny.ocir.io/axuouply2298/livingcost/backend@sha256:d3c9c38ddfe7f8671acf071557b3d1ba16dc5b9afc35cd6baf3a3460164524a9` |
| Pages production deployment | `b48d54fb-2e23-4583-925d-6f4ba871b5d4` |
| Pages created / success | `2026-10-06T02:40:49.09309Z` / `2026-10-06T02:40:50.251583Z`, ad_hoc/main, clean source SHA above |
| Public API | HTTP200, `X-Release-Sha` and JSON `commitSha` equal full source SHA; `releaseId=lcm-<SHA>` |
| Canonical + pages.dev FE | HTTP200 `/release-meta.json`, both commitSha/releaseId equal full source SHA |
| Fresh-container readiness | SELECT1 only + internal identity passed |
| Installed Compose SHA256 | `b88dcea8bd8f0db6c7dad57033026f2a0d863a1a83ecba5eebbe5ab2f0116d30` |
| Runtime | Only backend recreated; `unless-stopped`, no published port; DB/tunnel unchanged; reminder and marketing-backup timers active |

Source/FE archives on OCI match local SHA256 exactly. Compose baseline was rechecked
before changing its single backend image digest; environment/metrics mounts/ingress
settings were unchanged. No schema migration or customer data query. Registry token
was short-lived from existing OCI API profile, piped privately over SSH stdin;
temporary Docker config was logged out/deleted and absence verified. Pages used its
existing scoped credential only in the deployment subprocess, no permission expansion.

Public checks passed after deployment:

- Five guide routes HTTP200, single H1/canonical. Guide and FAQ show 990/9900 price
  **preparation**, explicit cannot-purchase status, VAT assumption and no card forms
  or provider SDK. FAQ JSON-LD uses the same factual availability copy.
- 390/1440 with JavaScript ON and OFF: exact price/discount/monthly-equivalent copy,
  no overflow/runtime errors or external/write requests; screenshots retained.
- Existing public usability390/1440: IME/focus, renewal queue, duplicate/filter/undo,
  quota export/retry, import, accessibility and reload passed with writes blocked.
- All13 marketing privacy scenarios passed. Every marketing POST was intercepted;
  no customer/API writes, account creation, real aggregate pollution or emails.
  The previously observed exact Cloudflare script version was aborted before
  execution/egress, not broadly allowlisted or enabled. Default OFF/revoke/GPC/DNT,
  failed persistence, cross-tab and inflight cases remained intact.
- Browser contexts closed; isolated candidate used `--rm`; purpose-created test
  clusters/servers were already cleaned. The duplicate local FE build directory was
  removed only after source/FE tar hashes and archive listings were revalidated;
  immutable archives/logs/screenshots and the working review tree were retained.
  No persistent Mac runtime was added.

## Evidence and external gates

Local approved temp root: `lcm-pricing-reviewed-fullverify-final.log` (final),
`lcm-pricing-reviewed-fullverify.log` (first own-key regression failure),
`lcm-pricing-release-c77079d622e23e2f763411f95e7dc6b2f7a92ab0/` (exact archives,
build/proof/public-check logs and public-guide screenshots). No customer DB/real
aggregate data is copied here. OCI release directory above retains protected rollback
settings and immutable source/FE archives. Protected `evidence.tar` contains the
non-secret release summary/build/promotion/public-check logs and public-guide
screenshots; local and OCI SHA256 both equal
`7abb5452c61b9a28ed641871183b41de65de155a2f49b17a8e7cf79ea2b70f67`.
Credential values are never recorded.

No new provider/env/route/DB/worker/ownership configuration means no central gamja-ops
asset edit is required for this internal pricing/public-copy promotion. Real payment
integration must separately register scoped provider/secret/callback/worker ownership.

Actual billing is **not implemented or enabled**. Official rate comparisons and the
merchant identity/PG quote/sandbox/billing approval/tax/legal/cancellation/refund gates
are in [payment readiness](payment-readiness-20261006.md). PortOne platform Free is
not free PG processing; 3.4% + fee VAT is Toss's published general-card comparison
assumption, not LCM's contracted billing rate. No profitability/market result claimed.
