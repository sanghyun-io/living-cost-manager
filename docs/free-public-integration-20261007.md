# Free-public integration handoff — 2026-10-07

## Final free + expense-row UX handoff (supersedes earlier integration state below)

New isolated branch/worktree: `feat/lcm-free-ux-final` / `lcm-free-ux-final`. Frozen `bc74fc6aa84576cfd3f20a21f3484c5d91364f25` remains untouched. Applied backend `31ae137f364041341f8905472e7ddc705494b8ff` as `322966b`, then frontend UX `013c4110d3de334d05ac9801d88620050c0f788d` as `b7da056a960c023e800777bb3f865e520fe088ab`, without semantic conflict. Final handoff commit follows those two picks.

API/shared/Prisma/root lockfile match backend `31ae137` exactly. Runtime frontend matches UX `013c411` exactly (which includes free frontend `c34f3c7`). The only web differences are tests: the prior guarded private billing fixture, explicit required `billingDay: 1` in two UX unit fixtures, an asynchronous template-field visibility wait before counting/filling fields, and the UX browser's synthetic interception base matching the explicit production-origin export. All non-local browser requests are fulfilled with synthetic fixtures or aborted, never forwarded to production.

Final evidence directory (new exclusive directory, files 0600, screenshots preserved):
`/private/var/folders/f_/kdvkncsn11l2nssxg_75xglc0000gp/T/opencode/lcm-free-ux-evidence-779DDE95-EA34-4F38-BDD5-B5A0B4EFFF5B`

- Fresh loopback-only PostgreSQL 16 cluster/database/schema, port 55483; guarded setup applied all nine migrations; cluster stopped after testing. No operational credentials or existing databases used.
- `API_TEST_DATABASE_URL=<guarded synthetic loopback URL> LCM_WEB_LOCAL_BILLING_TEST=true pnpm -r --workspace-concurrency=1 test`: final pass (`full-test-final.log`), shared **166**, API **422**, web **374**, total **962** tests, **73** files, no skips. Explicit sequential execution prevents API reset from racing the real combined API/frontend mock-provider fixture. Free-default guards and dark refund recovery/private paid regressions all run; private fixture publication override does not change public false defaults.
- `NEXT_PUBLIC_API_BASE_URL=https://api.gamja.top/living-cost-manager/v1 pnpm build`: final shared/API/web pass (`build-final.log`). Web `tsc --noEmit` passes (`web-types-final.log`).
- Free browser passes (`free-browser-final.log`): unpublished subscription route 404, no paid HTML/JS/SEO/UI/SDK/aggregate entries, guest-local template and first OWN0 creation, OWN1/multiple and shared membership preservation, fail-closed list behavior.
- UX browser passes (`row-browser-final.log`, `row-browser-final/after-results.json` and PNGs): 30 rows at desktop 1440/mobile 375; one shared schedule explanation, no repeated row instruction; secondary copy menu; Enter/Space/ArrowDown/Escape/Tab/ShiftTab/outside/focus handling; copy once with new ID and preserved fields; cache/reload; delete cancel/confirm; disabled fieldset and workspace/profile switch cleanup. No remote network calls/page errors/overflow. Measured first-row height: desktop 121.78px, mobile 665.64px; this scoped change is **not** a full mobile row-height redesign.

Failures remain preserved: initial direct web TypeScript check found missing required `billingDay` in UX test fixtures (fixed without casts/type weakening); initial free browser counted template fields before asynchronous panel completion (fixed with a visibility wait); initial UX browser expected a historical loopback API origin while testing the production-origin export (fixed synthetic interception only). No financial test or safety guard was skipped/disabled.

No new financial policy, schema/migration, runtime configuration, worker, provider, opskv access, push or deployment was introduced. SQL hash remains `38f33ea4fb564637ebf82368d5e2a0c3abedb8e0521d4cb16d3c6bd2178fafdc`. Production's already-applied billing tables remain supplied main context, not independently queried here. Main must complete final independent review and sequenced deployment approval/backup/rollback/health checks. Existing personal expense/card/monthly calculations remain free; paid service controls remain hidden/dark. Future dates/renewal-window/PG readiness gaps remain separate future work, not one-click launch claims.

## Earlier integration evidence (historical, preserved)

## Source and scope

- Branch: `feat/lcm-free-public-final`, new isolated `lcm-free-public-final` worktree.
- Parent backend: `ca168f821dafc77c93d38d82d83af66b6a9db244`.
- Cherry-picked frontend: `c34f3c717756f75f9490690f6ac9fd41b5a2d632` (33 files, only `apps/web`).
- Both derive from frozen RC `b637490ca4d6b967c2d8b8e3a4b073fe92bc74b0`. Original dirty repository and both source worktrees were not modified.
- API/shared/Prisma/root lockfile are byte-identical to the backend parent. Integration changes only the private frontend opt-in fixture and this internal handoff.

The opt-in fixture now resolves `API_TEST_DATABASE_URL` through the existing loopback/test-database/test-schema guard rather than hard-coding a historical port and unguarded `public` schema. It explicitly publishes billing **inside its test-only in-process mock app**. Otherwise the newly combined real API correctly returns billing 404, so the old paid regression would fail. No production default or authorization guard was weakened; no real provider is contacted.

## Implementer verification (not independent review)

Protected evidence directory:
`/private/var/folders/f_/kdvkncsn11l2nssxg_75xglc0000gp/T/opencode/lcm-free-final-evidence-0B4858E5-D9D3-4949-BC06-15DB083016B7`

Files were created under umask 077. A new PostgreSQL 16 cluster listened only on loopback port 55479, with a fresh `lcm_free_test` database and `lcm_free_test` schema. All nine existing migrations were applied by the guarded API setup; the cluster was stopped afterward. No existing customer/production database was accessed.

- `pnpm install --frozen-lockfile`, `pnpm db:generate`, shared build: passed.
- `API_TEST_DATABASE_URL=<guarded synthetic loopback URL> LCM_WEB_LOCAL_BILLING_TEST=true pnpm test`: passed (`full-test-retry.log`).
- Explicit deterministic rerun: same environment, `pnpm -r --workspace-concurrency=1 test`: passed (`full-test-serial.log`); shared 12 files/166 tests, API 26 files/402 tests, web 33 files/368 tests. The real combined API/frontend adapter lost-response/mock-payment/refund/cancellation regression ran, **not skipped**. Free-default tests and preserved private paid financial regressions both pass.
- `NEXT_PUBLIC_API_BASE_URL=https://api.gamja.top/living-cost-manager/v1 pnpm build`: shared/API/web passed (`build.log`).
- `pnpm --filter @living-cost-manager/web exec tsc --noEmit`: passed (`web-types.log`).
- `node apps/web/tests/free-public-browser.mjs`: passed (`free-browser.log`). Synthetic loopback-only browser fixtures verify paid-route 404, no paid UI/aggregate/SDK calls or published HTML/JS/SEO entries, guest local template application, OWN0 first creation, shared viewer ownership exclusion, OWN1/multiple retained access/edit/cache, unknown list fail-closed and mobile overflow. This is not a browser connected to the real API or production.

The first test attempt failed because the PostgreSQL Unix socket path exceeded macOS's limit; the fresh cluster was restarted with Unix sockets disabled, retaining loopback TCP only. No test was hidden/skipped to repair that failure. Historical paid-route browser harnesses are preserved but not applicable to the free static export; they were not run. New free-page browser checks did run.

## Deployment packet for main (not executed here)

This is a free-only source release: service billing routes default to 404, money/instrument dispatch stays blocked, second OWN creation and aggregation are denied. Signup creates the default OWN ledger and consumes the free allowance. Existing ledgers, sharing and personal expense/card/renewal management remain usable. The frontend hides service pricing/checkout/extra creation/aggregation and archives paid modules outside routed entrypoints. Guest template application remains separate/local, never an overwrite of an account ledger.

No new worker, provider setup, credentials, runtime source configuration, domain, Compose or infrastructure changes are required by this integration. Leave `SERVICE_PAID_FEATURES_PUBLISHED` absent/default false; do not set it true for this release. Do not edit operational `.env` independently. Any future managed configuration follows opskv policy and separate approvals.

Migration SQL is unchanged: `20261007120000_service_billing_foundation/migration.sql` SHA-256 `38f33ea4fb564637ebf82368d5e2a0c3abedb8e0521d4cb16d3c6bd2178fafdc`. Main's supplied operational context says all nine migrations already exist in production; this implementer did not independently query that claim. This release introduces no production DB migration/write procedure.

After main's independent reviews/testing and approval, use normal source integration/push and the existing deployment procedure. Preserve previous image digest/Compose configuration, prepare rollback to the prior release, and verify public free pages, subscription 404, billing API 404, first/default/existing-ledger behavior and health afterward. Do not overlap production mutation with another operator. No push, deployment, operational configuration change or production verification was performed here.

Paid code preservation is not one-click PG readiness. Future publication requires separate configuration, provider/consent/policy/security/legal approvals and verification; exact future period/renewal window work is not claimed implemented by this free release. Technical local verification is not independent review, deployment or demonstrated business outcome.
