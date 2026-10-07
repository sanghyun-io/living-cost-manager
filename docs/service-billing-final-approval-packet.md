# Billing final integration — INTERNAL deployment approval packet

2026-10-07. Technical preparation only; NOT commercial/legal approval or a
production change. Main will group actual approval decisions after independent
tester/reviewer/security checks against the frozen final commit.

## Immutable integration and customer result

- Backend: `ec088092236a9aabc360fb5984426eaceec41d93`, parent
  `1fecf301304f2165a4c6f01b8d2f5ea089c9e30f`.
- Frontend: `d16cc34e7020bb6f5ad512695cda3dfb48fbd636`; verified its three
  linear, web-only commits `3da1528`, `d63f471`, `d16cc34` before cherry-picking
  onto the exact backend into new `feat/lcm-billing-final`.
- Integration commits: `2934d2f`, `3ed0700`, `778625a`. No conflicts or source
  fixes. Web tree equals original frontend; API/shared/Prisma equal backend.
  This packet is the only additional source file.
- Existing free functions remain available. No business gates, checkout defaults,
  paid scope, or commercial materials were changed. Outcome demonstrated is safe
  local synthetic checkout/recovery/management, NOT revenue or LIVE activation.
- Original dirty repository and every historical/frozen worktree were preserved.
  Actual web domain: `living-cost-manager.gamja.top`.

## Exact unapplied additive SQL approval scope

The complete SQL (including every column/default/index/check/function/trigger/FK)
is [the tracked migration](../prisma/migrations/20261007120000_service_billing_foundation/migration.sql).
Approve this exact file, not only the following table summary. Its SHA-256 is
`38f33ea4fb564637ebf82368d5e2a0c3abedb8e0521d4cb16d3c6bd2178fafdc`.
Reproduce the exact additive SQL diff from the pre-foundation source:

```sh
git diff aeddfee^ ec088092236a9aabc360fb5984426eaceec41d93 -- prisma/migrations/20261007120000_service_billing_foundation/migration.sql
```

Seven new models/tables: `ServiceSubscriptionContract`, `ServiceBillingQuote`,
`ServiceBillingInstrument`, `ServicePaymentAttempt`, `ServicePaidPeriod`,
`ServiceBillingEventReceipt`, `ServiceRefundRecord`. Later phase-two amendments
inside this UNAPPLIED draft add quote approved-material snapshots, instrument
lease/version, attempt review, refund approval/lease, and contract overdue-review
and verified-cancellation revision. Shared DTOs are unchanged.

The existing-table dependency is explicitly:

```sql
ALTER TABLE "ServiceSubscriptionContract" ADD CONSTRAINT "ServiceSubscriptionContract_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

No existing `User` column or ledger table is rewritten. This FK nonetheless
references/locks existing `User` and changes deletion behavior: unlink the user,
retain financial audit. New binary account-deletion safeguards require the new
schema. Actual production schema/migration history/role and lock impact are
UNVERIFIED. If this draft has been applied anywhere outside the isolated tests,
do not edit an applied migration: prepare a separately reviewed forward migration.
Other historical pending migrations are NOT approved by this seven-model packet.

## Intended worker/runtime configuration — names only

Existing runtime inputs: `NODE_ENV`, `DATABASE_URL`, `API_BASE_PATH`, `JWT_SECRET`.
Billing inputs: `SERVICE_BILLING_MODE`, `SERVICE_BILLING_MOCK_ENABLED`,
`SERVICE_BILLING_ENCRYPTION_KEY`, `SERVICE_BILLING_KEY_VERSION`,
`SERVICE_BILLING_APPROVAL_MANIFEST`, `PORTONE_LCM_API_SECRET`,
`PORTONE_LCM_WEBHOOK_SECRETS`. Frontend build input: `NEXT_PUBLIC_API_BASE_URL`.
No operational values, secret files, or provider accounts were read/provisioned.
Subsequent approved registration/delivery must use opskv
and update gamja-ops; unverified imported values must not activate billing.

Manifest field names are defined by `billingApprovalManifestSchema` in
`apps/api/src/services/service-billing-config.ts`; protected verified approval,
configuration/launch/worker references, merchant/store/channel/domain, approved
versions/materials/tax, separate capabilities and workers are required. No
synthetic manifest is deployment evidence.

Intended worker entry: `apps/api/dist/services/service-billing-worker.js` with
explicit `--job=reconcile --once`, `--job=renew --bounded=<1..10>`, or separately
approved `--job=refund --once --request=<id> --operation=<id> --policy=<version>`.
Only internal due-cycle renewal; no remote provider scheduler. No worker is
registered by the server. Actual supervisor/timer identity, cadence, alerting and
deployment remain to be approved/verified; reconcile must operate before checkout.
Refund is never automatically executed by the frontend or cancellation.

## Rollout / non-destructive rollback proposal (NOT executed)

1. Confirm target/role/migration history; approve exact diff and scope. Protect
   backup and rehearse representative restore, FK/locking and old/new compatibility.
2. Apply approved additive schema before new binary; provision verified protected
   configuration and reconcile/cancel readiness, then verify workers and gates.
3. Enable checkout/renew only after commercial, merchant, security and activation
   approvals; real provider validation remains separate from synthetic evidence.
4. On rollback disable issuance/charge/renew capabilities and renewal worker while
   preserving approved reconciliation/cancellation paths for outstanding records.
   Uncertain dispatch stays same-ID lookup-only. Preserve encryption key access
   for retained envelopes; do not rotate/delete keys as an incidental rollback.
5. Keep all seven tables, migrations, receipts, consent/quote snapshots, attempts,
   refund audit and periods. No DROP/TRUNCATE/down migration or historical backup
   restore over new audit data. Prefer feature-disable on new binary; old binaries
   lack these deletion guards, so old-binary rollback needs verified prevention of
   account deletion for financial subjects and independent compatibility rehearsal.

## Implementer evidence / remaining grouped gates

All logs below are mode 0600 in the approved OpenCode temp parent directory:

- `lcm-final-install.log`: frozen-lock install, Prisma generate passed.
- `lcm-final-build.log`: `NEXT_TELEMETRY_DISABLED=1`
  `NEXT_PUBLIC_API_BASE_URL=https://api.gamja.top/living-cost-manager/v1 pnpm build`
  passed shared/API/web TypeScript and static export, including `/subscription`.
- `lcm-final-db.log`: all nine migrations passed on owned ephemeral PG16 container
  `lcm-billing-final-test`, loopback 55443, synthetic database only; API uses
  isolated `billing_test` schema, web opt-in uses separate `public` schema.
- `lcm-final-additive-sql.diff`: exact additive migration diff above, including
  existing User FK. `lcm-final-schema-bound-diff.log`: Prisma schema-bound diff
  with `DATABASE_URL` explicitly matching the test schema returned no difference.
  First unbound invocation exited 2 because the datamodel defaulted to public
  (`lcm-final-schema-diff.log`); matching both schemas corrected the command,
  not source/schema. Prisma diff does not validate custom trigger/check semantics.
- `lcm-final-tests.log`: `pnpm test` with isolated `API_TEST_DATABASE_URL` and
  `LCM_WEB_LOCAL_BILLING_TEST=true`: shared **166**, API **343**, web **359** passed.
  Provider transport is fake/in-process; actual API web test uses app.inject and
  synthetic user/mock provider, lost-response lookup with only one dispatch.
- `lcm-final-browser.log`: local static export served at loopback 3198; exact
  production API origin and SDK requests intercepted/fulfilled, other external
  requests aborted. Browser suite passed recovery/OFF/404/unknown status,
  layout/focus/consent, mock no-SDK, same-ID recovery, refund request/logout privacy.

Owned synthetic container was removed and local static server stopped after tests.

No production DB/environment, provider call, real customer record, push, deployment,
public policy or legal publication was performed. Independent review is NOT yet
complete. Remaining grouped gates: independent frozen-source testing/security/review;
exact DB/backup/locking/rollback approval; actual LCM merchant/channel/domain and SDK
platform verification; selected paid benefit/seller/consent/tax/refund/retention and
pre-purchase date disclosure decisions; opskv/registry provisioning; worker and
activation approval. Existing free functions remain untouched throughout.
