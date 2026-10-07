# LCM service billing backend — phase-one contract

**Historical phase-one handoff for frozen `42265e9`.** Phase two supersedes its
mock-only provider limitation and DTO fields; use
`service-billing-provider-contract.md` and current shared response schemas for
integration. The frozen phase-one worktree was not modified.

Internal implementation handoff, 2026-10-07. Base: `origin/main`
`7031f74039be06484b0742328edc503e5fa8202b`. This is **not** a published paid
product, commercial approval, deployment, or permission to migrate production.
The customer FixedCost/card/workspace ledger is untouched. Existing free
features, read, export and viewer paths have no premium middleware or gating.
One authenticated user account owns one contract across their own ledgers; a
shared workspace does not imply anyone else's subscription or payment consent.

## Actual implementation and gates

- Durable seven-table Prisma foundation, local migration with constraints/triggers,
  encrypted instruments, immutable quotes/consents, exactly-one dispatch claim per
  cycle, reconciliation, cancellation intent, refund request capture, simulated
  full refund/renewal, and existing account-deletion integration are implemented.
- **Only explicitly configured development/test MOCK checkout can be enabled.**
  The default mode is `sandbox`, checkout disabled. `live` and `sandbox` dispatch
  remain unavailable, regardless of any keys in another service. Production mock
  is always unavailable. All entitlements remain `paidAccess:false`.
- Mock capabilities describe the simulation only. `blockingCodes` still report
  mock-only, provisional paid-product and legal/tax approval. Never present mock
  readiness as production/sandbox merchant readiness. `sdkConfig:null` means do
  not load/call the real browser SDK. Mock confirm uses a locally generated
  `mock_` + `sdkRequest.issueId` token, solely in a development simulation; do not
  display/log/store it in browser persistence.
- Synthetic provider observations live in process memory, independently of the
  durable application ledger. Restart loses this fake provider's observations.
  Unknown dispatches are looked up, bounded, and sent to manual review, NEVER
  redispatched. Mock is not a durable external payment emulator or approval proof.
- `@portone/server-sdk` is pinned at `0.19.0`. Separate unregistered phase-two
  evidence helpers use official `Webhook.verify` on exact UTF-8 raw bytes and
  validate official typed GET results. They make **no merchant calls**. The real
  PortOne adapter, raw-body route parser/registration, authoritative GET client,
  channel verification, cancellation reconciliation, partial cancellations,
  external instrument deletion and live refund policy are still required before
  sandbox/live checkout can be enabled. No fake provider-environment response
  field is invented; environment is verified channel configuration, reinforced
  by official channel `type` (`TEST`/`LIVE`). Missing optional issueId/customer.id/
  channel.id fails binding verification rather than trusting key possession.
- No SDK key, merchant secret, webhook secret, production config, provider call,
  real charge, provider/customer contact, email, customer record, push or deployment
  was performed. Harudo source was consulted for verifier/GET patterns only;
  its keys, users and B2B refund terms are not reused. Harudo periodic approval
  and any staging key names are not proof of an LCM sandbox/live approval.
- Paid benefit selection, seller/legal disclosures, VAT treatment, consent text,
  refund/proration/grace/retention rules and actual LCM channel/domain approval
  remain Owner decisions. Prices are the server-owned 990/9900 KRW proposal;
  `taxTreatment:"pending"` does not claim VAT-inclusive approval. The application
  domain is `living-cost-manager.gamja.top`, not stale `.ai/infra.yaml` domains.

## Frozen HTTP contract for frontend

Register **relative** `/service-billing` below existing `API_BASE_PATH`. With the
actual production-shaped prefix the URL is
`/living-cost-manager/v1/service-billing` (never append another `/v1`). Requests
and TypeScript DTOs are exported from `packages/shared/src/serviceBilling.ts`.
JSON requests are strict: unknown fields/client amounts are rejected. ISO dates
are UTC strings; monetary values are integer KRW. IDs are opaque and owned.
No payment ID, billing key, provider payload, signature, ciphertext or internal
subject is returned except the minimal opaque SDK customer ID in preparation.

| Method + relative path | Request | Response |
| --- | --- | --- |
| GET `/readiness` | Public | `ServiceBillingReadinessDto` below |
| GET `/subscription` | Auth | `ServiceBillingSubscriptionDto` below |
| POST `/quotes` | `{planId:"monthly"\|"annual"}` | `ServiceBillingQuoteDto` below |
| POST `/instruments/prepare` | `{quoteId}` | `{instrumentId,sdkRequest:{storeId,channelId,issueId,customer:{id},billingKeyMethod:"CARD"}}` |
| POST `/instruments/:id/confirm` | `{billingKey}` (1–1024 chars) | `{instrumentId,status:"verified"}` |
| POST `/charges` | `{quoteId,instrumentId,idempotencyKey,consent:{billingVersion,autoRenewVersion,accepted:true}}` | `ServiceBillingAttemptDto` |
| GET `/attempts/:id` | Auth, own attempt | `ServiceBillingAttemptDto`; authoritative lookup only, NEVER charge |
| POST `/subscription/cancel` | `{atPeriodEnd:true}` | `ServiceBillingSubscriptionDto` |
| POST `/attempts/:id/refund-requests` | `{idempotencyKey,reasonCode:"changed_mind"\|"service_issue"\|"other"}` | `{requestId,status,requestAmount,currency:"KRW"}` |
| POST `/webhooks/portone` | Unsupported phase one | 404 `WEBHOOK_NOT_CONFIGURED`, no grant |
| POST `/mock/renew` | `{}`; development simulation, due cycle only | `ServiceBillingAttemptDto` |
| POST `/mock/refund-requests/:id/execute` | `{}`; development simulation only | `{requestId,status,requestAmount,currency:"KRW"}` |

```ts
type ServiceBillingReadinessDto = {
  mode: "mock" | "sandbox" | "live";
  checkoutEnabled: boolean;
  blockingCodes: string[];
  catalogVersion: "lcm-990-9900-v1";
  catalog: {
    monthly: { totalAmount: 990; periodMonths: 1 };
    annual: { totalAmount: 9900; periodMonths: 12 };
  };
  currency: "KRW";
  taxTreatment: "pending" | "inclusive"; // phase one always pending
  consentVersions: { billing: string; autoRenew: string };
  capabilities: { issueInstrument: boolean; charge: boolean; renew: boolean; cancel: boolean; refund: boolean };
  sdkConfig: null | { storeId: string; channelId: string }; // phase one always null
};
type ServiceBillingSubscriptionDto = {
  contractId: string | null; planId: string | null; status: string;
  paidAccess: boolean; paidThrough: string | null; nextChargeAt: string | null;
  cancelAtPeriodEnd: boolean; renewalStopped: boolean;
  providerCancellationStatus: string;
  premiumScope: "provisional"; existingFreeAccess: true;
};
type ServiceBillingQuoteDto = {
  quoteId: string; planId: "monthly" | "annual"; catalogVersion: string;
  totalAmount: number; currency: "KRW"; periodMonths: number; expiresAt: string;
  consentVersions: { billing: string; autoRenew: string };
};
type ServiceBillingAttemptDto = {
  attemptId: string; status: string; mode: "mock" | "sandbox" | "live";
  paidAt: string | null;
  paidPeriod: null | { startsAt: string; endsAt: string };
};
```

Idempotency key: `[A-Za-z0-9_-]{16,100}`. A key is durable per contract; changing
quote/instrument/consent shape under the same key gives 409 `IDEMPOTENCY_CONFLICT`.
Quotes expire after 15 minutes and are consumed in the attempt-creation
transaction. Parallel preparations reuse one issuance; parallel purchases cannot
reserve two cycles. Initial purchases cannot replace/upsell an existing plan.
Current provisional consent versions: `billing-draft-v1`, `auto-renew-draft-v1`;
server saves exact versions and accepted server time, no IP/UA.

Attempt statuses: `created`, `dispatch_unknown`, `paid`, `failed`,
`manual_review`, `canceled_before_dispatch`, `refunded`. Refund statuses:
`requested`, `dispatch_unknown`, `verified` (future rejection is reserved).
Contract: `idle`, `active`, `cancel_at_period_end`. Cancellation:
`none`, `pending`, `verified`. Local renewal stop is immediate and durable;
provider cancellation is never falsely labeled verified after an uncertain I/O.
There is no phase-one resume/plan switch/automatic failure retry.

All authenticated writes require verified email, existing access-token issuer,
audience/type/expiry and current user tokenVersion. Reads require current auth.
Coarse pre-auth backstop: 10,000 requests/minute per billing plugin process;
post-auth quota: 60 requests/minute per user. Invalid JWTs don't spend another
user's quota; shared proxy sockets are not subjected to a low user quota.
`TRUST_PROXY` is unchanged. JSON bodies are capped at 4096 bytes (webhook 16384).
Responses/errors are explicit safe serializers. Billing request logging and
unsanitized route errors are suppressed. Quotas are in-memory per process, not
a distributed limiter. Auth/DB availability errors are sanitized to 503.

## Lifecycle, consistency and privacy

Financial child FKs are RESTRICT, user FK is SET NULL. Contract subject and scope,
first anchor, quote contents, request amount/currency/consent/binding, period
identity and refund identity are immutable via SQL. Scoped IDs, contract cycles,
attempt period, quote use and idempotency are unique. SQL checks validate positive
amounts/cycles, envelope structure and period bounds; binding triggers validate
contract/store/environment/quote/instrument relationships and refund reservation
limits. Period trigger locks the parent contract before checking non-overlap;
application period writes use the same contract lock. No extension is required.

Contract/user locks and dispatch/lookup leases are short transactions. Provider
I/O is outside database locks. Payment IDs are opaque 35-character alphanumeric
LCM IDs (under KCP's 40-character limit), persisted before any charge I/O. Any
ambiguity—including crashing after claim but before actual send—is same-ID
lookup-only. Lease fencing rejects late worker settlement. Eight unsuccessful
lookups/event retries lead to manual review. Webhook receipts contain scoped
event/payment IDs and retry metadata, not raw body/signature/PII; events never
grant a period without authoritative payment validation. Settled paid attempts
aren't downgraded by stale failed events. External refund/cancel event coverage
is a phase-two gate, not claimed by mock tests.

The first period starts at the provider's exact verified paid instant. Ends are
the original KST date's midnight after 1/12 calendar months, with independent
month-end clamping. Following periods are adjacent at that boundary, preserving
the original day. This is not a rolling 30-day period and the first calendar
period can have a partial first day. No grace policy is invented. Mock renewal
uses same plan/amount/currency and original consent, refusing changed versions
or prices. There is no scheduled renewal worker/production auto-charge.

An opt-in reconciliation-only CLI is implemented in
`apps/api/src/services/service-billing-worker.ts`: execute with `tsx` and an
explicit `--once` or `--bounded=1..10`. It refuses production, sandbox/live,
remote hosts, and database/schema names without a test marker. Configuration
comes from the protected process environment only; it reads no `.env` files and
prints aggregate counts, never secret values. It never creates a cycle, charge
or refund. Server startup registers no worker or timer. As with any fresh mock
process, existing synthetic provider observations are unavailable after restart.

Instrument envelopes use AES-256-GCM random 12-byte nonces/16-byte tags with AAD
binding instrument ID, contract, provider, store and environment. The key is
injected, never static/fallback. Envelope keyVersion allows identifying old
envelopes; phase one fails closed on a mismatched version. Multi-key rotation
and operator re-encryption tooling are NOT implemented. Verified mock schedule
cancellation revokes/clears the synthetic instrument. Real external billing-key
revocation must be independently confirmed before real account deletion.

Refund request amounts are server calculated as paid minus all reserved requests;
mock policy is full refund only. No live refund execution, unilateral B2B terms
or final proration policy. Mock verified refunds truncate `accessEndsAt` without
rewriting financial period boundaries and never revoke existing free features.

Account deletion checks billing inside the existing serializable transaction,
locking user then contract before ANY workspace/member/account destruction.
Unresolved attempts/events/refunds, unrevoked instruments, active renewal or
uncertain cancellation block with 409 `BillingAccountDeleteBlocked`. Closed,
verified-safe audit is retained with userId null and no copied name/email/order
PII. Old accounts without a service contract remain compatible. Financial record
retention duration and legal basis remain **UNVERIFIED**, not legal compliance
claims; minimal processing purpose is reconciliation, disputes and billing audit.
Application role/RLS hardening and legally approved retention/deletion controls
are not newly provisioned by this migration; authenticated API ownership checks
are implemented, not a claim of operator-proof financial storage.

## Declared local parameters / operational handoff

`SERVICE_BILLING_MODE` optional (`mock|sandbox|live`, default sandbox);
`SERVICE_BILLING_MOCK_ENABLED` optional literal `true|false`;
`SERVICE_BILLING_ENCRYPTION_KEY` optional base64 encoding of 32 random bytes;
`SERVICE_BILLING_KEY_VERSION` optional non-secret version label. Development
mock requires all explicit fields, nonproduction NODE_ENV and a valid key. Tests
generate keys only in memory. No `.env` edits/reads or secret lookup was needed.

These are **source declarations**, not registered/provisioned runtime settings.
Before rollout, the orchestrator must register approved names/references through
gamja-ops/opskv, verify scope and deliver `.env` only from verified protected
opskv values. This scoped subagent did not edit agent-owned registry/policy files.
No Harudo keys or unverified historical/staging values should be copied.

### Production migration approval packet (not executed)

Draft: `prisma/migrations/20261007120000_service_billing_foundation/migration.sql`.
Adds exactly seven tables, indexes, child FKs, checks and three functions/triggers;
the only reference to an existing table is contract.userId -> User.id SET NULL.
No existing customer ledger table, column, data or enum is modified. Prisma User
only gains a virtual optional relation. FK creation takes a brief lock on User
and scans empty new tables; production lock time is not measured. Trigger
functions are new schema-local names. No PG extension is added.

Before applying: obtain explicit approval for this exact SQL/target schema;
confirm actual OCI runtime/database/schema/role independently of stale metadata;
take protected encrypted backup and record migration metadata + existing/new
row counts; restore into disposable PG16 and rehearse the exact migration;
measure User FK locking with representative workload, set reviewed lock/statement
timeouts, and verify rollback and old binary compatibility. Run old free/auth/
export/viewer regression paths and independent reviewer/security/tester review.

Roll out additively with checkout/capabilities OFF.
The new backend binary requires this additive migration first, including account
deletion's billing guard; do not deploy the binary onto an unmigrated old schema.
Public readiness itself does not query billing tables. Other new routes fail
sanitized/unavailable on a missing schema, not via a customer-ledger fallback.

Do not flip a generic Boolean
to enable provider dispatch. Production live needs independently verified LCM
merchant/store/channel/domain approvals, per-mode capabilities, premium scope,
VAT/seller/consent policy, encryption rotation/backup and official provider
contracts. App rollback can retain additive audit tables and use the old binary;
never drop financial records or use a destructive down migration. Any removal
requires separate approval. Worker dispatch remains absent/disabled. Verify
public release SHA and behavior only after an independently authorized deploy.

### Local test reproduction

Use a freshly created disposable PG16, loopback bind, obvious test DB AND schema,
not a runtime connection. Existing test guard refuses non-loopback/non-test URLs.
Run migration deploy/reset only on that disposable target, then:

```
pnpm prisma generate
pnpm --filter @living-cost-manager/shared build
pnpm --filter @living-cost-manager/api build
pnpm --filter @living-cost-manager/api exec vitest run tests/service-billing.test.ts tests/service-billing-portone-evidence.test.ts
```

Pass `API_TEST_DATABASE_URL` using a protected environment, never an actual
production credential. Shared/API full regression and independent review are
separate validation steps; a mock SDK signature fixture does not prove channel
approval or live entitlement.

Official references read 2026-10-07:
https://developers.portone.io/opi/ko/integration/webhook/readme-v2
and pinned SDK `IssuedBillingKeyInfo`, `PaidPayment`, `SelectedChannel`,
`Webhook.verify` declarations. Initial `/api/rest-v2/billingKey/getBillingKeyInfo`
fetch returned navigation, NOT sufficient provider-contract evidence; do not
claim that as a verified endpoint contract. Harudo pattern source:
`backend/src/integrations/portone-service.js` verifier/getPayment symbols only.

## Implementation validation evidence (not independent review)

Fresh local run started `2026-10-07T05:36:21Z`. Prisma validate/generate, the final nine migrations
on a disposable PG16 target, shared build and API build succeeded. Shared:
**166/166** tests across 12 files. API: **302/302** tests across 20 files, including
32 durable billing tests and four official SDK evidence tests. No skips were
reported. Existing API/free/account regression suites are included. No web files
were changed or web/browser deployment verification claimed.

Protected local evidence directory:
`/private/var/folders/f_/kdvkncsn11l2nssxg_75xglc0000gp/T/opencode/`.

- `lcm-billing-validation-final-20261007.log`: fresh migration/build/full tests
  and synthetic dump/restore at `2026-10-07T05:37:07.707Z`.
- `lcm-billing-schema-diff-final.log`: corrected, schema-bound read-only Prisma
  diff at `2026-10-07T05:37:22Z`, **empty migration**. The preceding diagnostic
  diff in the test log lacked target DATABASE_URL and compared `billing_test` to
  default `public`; it was never executed and is not migration approval SQL.
- `lcm-billing-synthetic-restore-ba5e9c48-f117-4f97-8c48-27329400893d.dump`:
  synthetic-only custom-format backup, mode 0600. Restored to a newly named
  disposable test DB; nine finished migration rows, 3 synthetic users, 1 each
  contract/quote/instrument/attempt/paid period, zero receipts/refunds matched.
  The restored AES-GCM envelope decrypted with the same random in-memory fixture
  key, no persisted/plaintext key or token. Restore DB was then removed.

Rehearsal script: `apps/api/tests/service-billing-restore.ts`. Opt in only with
`BILLING_TEST_RESTORE=true` and `BILLING_TEST_EVIDENCE_DIR` pointing at an approved
protected directory. It additionally requires our explicit disposable
`lcm-billing-backend-test` container running `postgres:16-alpine` bound to
`127.0.0.1:55439`, DB `lcm_billing_test`, schema `billing_test`, no DB password.
It refuses every runtime/remote/non-test target. This local synthetic rehearsal
is not a production backup/restore test or actual merchant integration.

The implementing subagent did not subdelegate. Independent tester, security and
reviewer review remain for the main session; none is claimed here. Production
migration/configuration/provider approval/deployment and customer outcomes are
all **not performed**.
