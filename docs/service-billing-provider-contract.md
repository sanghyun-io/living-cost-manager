# LCM billing phase two — provider/backend handoff

Internal technical handoff, 2026-10-07, branch `feat/lcm-billing-provider`, based
on **frozen `42265e9`** in a new isolated worktree. No phase-one review files,
web files, business/legal policy, operational configuration or provider account
were changed. Existing free features/read/export/viewer remain ungated.

## Implemented code, not launch claims

- Actual PortOne V2 HTTP adapter, using pinned `@portone/server-sdk@0.19.0`
  method/input/result contracts and official endpoint forms. Default origin is
  fixed `https://api.portone.io`; no redirects/arbitrary URL, automatic retry,
  raw provider error retention or credentials in logs. Eight-second AbortSignal
  timeout; response capped at 256 KiB. All implementation tests inject an
  in-process fake fetch and make **zero merchant/provider network calls**.
- Browser issuance preparation returns actual public `channelKey`, server-owned
  `issueId` and opaque customer ID. Card credentials never pass through LCM.
  Authoritative getBillingKeyInfo must return matching merchant/store/channel,
  TEST/LIVE type, issueId and customer.id. Missing optional binding fails closed;
  possession of a billing key alone is insufficient.
- Real payWithBillingKey request uses the persisted opaque payment ID, exact
  server amount/KRW, public channelKey, store scope and opaque customer ID. POST
  response never settles: authoritative GET payment evidence does. Ambiguous
  charge, response loss or expired lease means **same-ID lookup only**.
- Raw webhook route registered under existing API prefix, locally encapsulated
  `application/json` Buffer parser (16 KiB), fatal UTF-8 decoding and official
  `Webhook.verify` over exact bytes. One or two trusted active in-memory webhook
  secrets supported. Signature/header/store failures are sanitized 400; inactive
  route 404; unsupported type/content 415; durable accepted events 202. Unknown
  signed event types and nonpayment messages are ignored. Unknown scoped payment
  IDs cause no provider GET or receipt. No body/signature/billing-key event stored.
- Durable signed receipts precede ACK and asynchronous bounded worker lookup.
  Invalid signature never reaches receipt storage; event contents alone never
  grant coverage. Existing attempt/receipt leases and fences protect duplicate
  events, expired worker claims and out-of-order results.
- **One scheduler only: internal due-cycle worker.** No PortOne remote schedule
  is created, so there is no competing remote/local renewal path. Renewals use
  frozen plan/price, original consent and original KST anchor; changed policy,
  feature/seller/consent/material versions require reconsent. Missed already
  expired cycles cannot be back-billed/caught up. Failed/ambiguous attempts are
  never automatically recharged.
- Cancellation stops local renewal under the contract lock immediately, then
  verifies deletion of every relevant provider billing key using GET DELETED
  with original bindings. In-memory scheduler-stop flags are not enough to mark
  cancellation verified. Unknown deletion/key/ownership remains pending/manual
  review and account deletion blocked. Provider I/O occurs outside DB locks;
  instrument version/lease fencing rejects late revocation commits.
- Refunds are customer **requests only**, with server-computed paid-minus-reserved
  amount. Real execution requires separately enabled refund worker/capability,
  approved policy version and immutable explicit operator operation ID. One
  cancelPayment POST uses amount and currentCancellableAmount; uncertain results
  are lookup-only with durable refund claim/lease/fence and at most eight
  observations before manual review. GET cancellation must match payment/customer/total/KRW,
  request marker, exact amount and unique cancellation ID. No auto refund on
  cancellation. This implementation supports explicitly approved full-remaining
  manual refunds, not invented legal proration or Harudo B2B terms.
- Authoritative unsolicited partial/full cancellations are not silently treated
  as an approved customer refund. Premium coverage is conservatively truncated,
  renewal stopped, unknown cancellation flagged `reviewRequired`, audit retained
  and account deletion blocked pending review. Free access is never revoked.
- Live paidAccess now works when actual verified LIVE coverage + configured
  commercial approval scope are present. Mock and TEST/sandbox coverage cannot
  grant LIVE access. No premium enforcement was added to any existing free path.

## Frozen frontend changes from phase one

All paths below are relative to `${API_BASE_PATH}/service-billing`, typically
`/living-cost-manager/v1/service-billing`. Existing request shapes remain strict
and unchanged, including charges consent `{billingVersion,autoRenewVersion,
accepted:true}`. The server's immutable quote binds the other approved versions
and exact approved material snapshot; clients cannot submit a price/policy/scope.

- Readiness adds `approvedVersions:{featureScope,policy,seller,billing,autoRenew}`,
  `approvedMaterial:null|{billing,autoRenew,features,policy,seller}`,
  `approvalStatus:"mock_draft"|"blocked"|"approved"`. `sdkConfig` is null when
  unavailable/mock, otherwise `{storeId,channelId,channelKey}`. Use the browser
  SDK's **channelKey**, not channelId; channelId is server verification metadata.
- Quote adds the same `approvedVersions` and immutable `approvedMaterial`.
- Prepared SDK request:
  `{storeId,channelId,channelKey?,issueId,customer:{id},billingKeyMethod:"CARD"}`.
  Real `requestIssueBillingKey` inputs are storeId/channelKey/issueId/customer/
  billingKeyMethod; don't pass server-only channelId as a substitute for channelKey.
- Attempt adds **`reviewRequired:boolean`**. Status enum is exactly `created`,
  `dispatch_unknown`, `paid`, `failed`, `manual_review`, `canceled_before_dispatch`,
  `refunded`; mode is mock/sandbox/live; paidAt and period ISO UTC fields remain.
- Subscription status is exactly `free|idle|active|cancel_at_period_end` (not
  frontend-invented `ending`). planId monthly/annual/null. Cancellation status:
  `none|pending|verified`. premiumScope: provisional/account-subscription-v1;
  existingFreeAccess is always true. paidAccess is only authoritative approved
  LIVE coverage now. Cancellation does not remove already paid remaining coverage.
- **GET `/attempts/by-idempotency/:key`**: auth/own key, same safe attempt DTO,
  lookup only. Lost POST response recovery can reuse the original UUID without
  depending on a returned attempt ID. 404 is not proof that an in-flight original
  request cannot later persist: keep/reuse the same key and payload, never create
  a blind new charge key. GET never dispatches a new charge.
- **GET `/instruments/:id`**: auth/own instrument,
  `{instrumentId,status,requiresManualReview}`.
- **POST `/instruments/:id/revoke`**: verified-email auth, strict `{}` body,
  same safe instrument snapshot. Status enum: prepared/verified/revocation_pending/
  revoked/manual_review. Stored keys are deleted and deletion verified. Browser-
  lost keys can be recovered through provider's narrowly scoped own-customer list
  and exact issueId/store/channel/customer match. Empty/ambiguous/truncated lookup
  cannot prove key absence: remain manual_review, not falsely revoked. No key is
  returned to the client. Exception resolution needs explicit operator review;
  there is no automatic waiver of financial/audit safeguards.
- Existing `/mock/renew` and `/mock/refund-requests/:id/execute` remain mock-only.
  There is no unauthenticated/public refund-execution API or premium scope switch.

Strict shared Zod response schemas are exported for readiness, quote, attempt,
subscription, instrument snapshot and refund. Unknown statuses/fields or bad date
formats fail serialization rather than crossing the frontend contract boundary.
Approved material is plain text; frontend must render it as text, not HTML. Mock
always has draft versions, null material and a visible mock-only badge.

Example complete **mock** readiness (never merchant approval proof):
```json
{"mode":"mock","checkoutEnabled":true,"blockingCodes":["MOCK_ONLY","PAID_PRODUCT_APPROVAL_PENDING","LEGAL_TAX_APPROVAL_PENDING"],"catalogVersion":"lcm-990-9900-v1","catalog":{"monthly":{"totalAmount":990,"periodMonths":1},"annual":{"totalAmount":9900,"periodMonths":12}},"currency":"KRW","taxTreatment":"pending","consentVersions":{"billing":"billing-draft-v1","autoRenew":"auto-renew-draft-v1"},"capabilities":{"issueInstrument":true,"charge":true,"renew":true,"cancel":true,"refund":true},"sdkConfig":null,"approvedVersions":{"featureScope":"feature-draft-v1","policy":"policy-draft-v1","seller":"seller-draft-v1","billing":"billing-draft-v1","autoRenew":"auto-renew-draft-v1"},"approvedMaterial":null,"approvalStatus":"mock_draft"}
```

## Activation: typed declarations, no runtime provisioning

New optional source parameters: `SERVICE_BILLING_APPROVAL_MANIFEST`,
`PORTONE_LCM_API_SECRET`, `PORTONE_LCM_WEBHOOK_SECRETS` (JSON of 1..2 base64
32-byte secrets). Existing mode/encryption/version declarations remain.
Manifest exact schema: `billingApprovalManifestSchema` in
`apps/api/src/services/service-billing-config.ts`. It requires:

- actual matching mode, verified status, LCM merchant/store/channel ID and public
  channelKey, actual domain living-cost-manager.gamja.top, fixed catalog version;
- separate configuration, Owner approval, launch and worker registration reference
  metadata (non-draft/unverified), approved feature/policy/seller/billing/renewal
  versions, five approved materials, confirmed inclusive tax treatment;
- individual issuance/charge/renew/cancel/refund capabilities and independent
  reconcile/renew/refunds worker declarations; refund policy nullable or explicit
  full_remaining_manual_v1.

One Boolean/key alone cannot activate. Invalid/missing/draft metadata, wrong mode,
absent secrets/crypto or absent reconciliation/cancellation readiness fails closed.
Checkout additionally requires issuance+charge+renew capabilities. Cancellation/
reconciliation may remain enabled during a charge-disable rollback. Approval
references are trusted protected operator configuration, NOT cryptographic proof
of legal/merchant approval. They must only be registered after actual Owner/provider
verification. Code does not manufacture those facts or turn synthetic fixtures
into deployment configuration. Current actual commercial approval remains pending.

No operational values were read/written, no `.env` files read/generated/edited,
no keys registered/looked up, and no provider account/customer calls were made.
Later provisioning belongs to the orchestrator's exact approved gamja-ops/opskv
change: get secrets only to new protected 0600 files; never argv/log/chat. This
subagent does not own registry/policy files and did not edit them. Do not reuse
Harudo keys/customer IDs, its pending approval, or unverified staging key names.

## Workers / approval boundaries

`apps/api/src/services/service-billing-worker.ts` supports explicit:
`--job=reconcile --once`, `--job=renew --bounded=1..10`, or
`--job=refund --once --request=<opaque> --operation=<approved-op> --policy=<version>`.
No command runs by default; no timer/cron/job deployment is created. Production
code requires fully verified per-mode manifests and the selected worker/capability
approval. Mock commands additionally refuse remote/non-test DB/schema targets.
Only aggregate counts are printed; errors are sanitized without original stacks.
Independent deployment review must configure/run the bounded reconciliation worker
before enabling checkout. Refund execution remains a separately approved financial
operation; the agent executed none. Due renewals require prior original customer
autoRenew consent and never change plan/price/material silently.

## Schema / migration / remaining release gates

Still seven additive revenue tables. The UNAPPLIED production draft migration
was amended only on this new branch: immutable quote feature/policy/seller/scope
and material snapshot, instrument revocation lease/version, attempt review flag,
and immutable refund operation/policy approval. New checks/indexes apply only to
the new tables. Never edit an already applied production migration; here none
has been approved/applied. Use a fresh isolated local DB for amended draft tests.

Production release still needs exact schema diff approval, actual target/role
verification, protected backup + representative restore/locking rehearsal,
independent tester/security/reviewer review, old/new binary rollback validation,
actual LCM merchant/domain/TEST or LIVE channel verification, final selected paid
benefit/seller/consent/VAT/refund/retention decisions, protected opskv parameter
registration/delivery, worker deployment verification, and explicit activation
approval. The new binary requires the additive tables before its deletion guard.
There is no destructive down migration, existing customer ledger change, external
remote schedule, provider/customer contact, production DB change, push or deploy.
Current-key-only envelope decryption still fails closed on rotation mismatch;
multi-key re-encryption/operator tooling is not falsely claimed implemented.

## Official source evidence

Public documentation read 2026-10-07:
https://developers.portone.io/opi/ko/integration/start/v2/billing/issue?v=v2
https://developers.portone.io/opi/ko/integration/start/v2/billing/payment?v=v2
https://developers.portone.io/opi/ko/integration/cancel/v2/readme?v=v2
https://developers.portone.io/opi/ko/integration/webhook/readme-v2

Pinned SDK generated methods inspected: PaymentClient.payWithBillingKey,
getPayment, cancelPayment; BillingKeyClient.getBillingKeyInfo, deleteBillingKey,
getBillingKeyInfos; Issued/DeletedBillingKeyInfo, SelectedChannel,
SucceededPaymentCancellation, GetBillingKeyInfosResponse; Webhook.verify.
Transport parity: POST `/payments/{id}/billing-key`, GET `/payments/{id}?storeId`,
POST `/payments/{id}/cancel`; GET/DELETE `/billing-keys/{key}?storeId`,
GET `/billing-keys?requestBody=<scoped-filter-json>`. Requester values are official
ADMIN/CUSTOMER. Responses have no invented environment field; verified channel
configuration supplies environment, reinforced by official TEST/LIVE type.

## Implementer validation (not independent review)

- Shared/API TypeScript builds passed; shared tests **166/166**, API full suite
  **324/324** (22 new fake-HTTP provider cases, phase-one regressions retained).
- All nine migrations applied fresh on isolated Docker postgres:16-alpine,
  loopback 55440, lcm_billing_test/billing_test. Schema-bound Prisma diff: empty.
- Synthetic-only pg_dump/pg_restore passed 2026-10-07T06:11:37Z, all seven revenue
  table row counts and nine migration records preserved; restored synthetic
  AES-GCM envelope successfully decrypted with the in-memory fixture key.
- Protected evidence: approved-temp `lcm-provider-validation-final.log` and
  `lcm-billing-synthetic-restore-ffaa6850-5e4d-4678-88c9-7811fc055e22.dump` (0600).
  Test fixture keys never registered/stored as runtime configuration.
- Independent tester/security/reviewer, real merchant contracts, worker deployment,
  production locking/rollback rehearsal and actual live checkout are **not**
  validated by these synthetic results. Main session must perform independent review.
