# Free-public integration handoff — 2026-10-07

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
