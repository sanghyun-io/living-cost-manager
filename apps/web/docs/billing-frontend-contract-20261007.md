# Billing frontend integration — INTERNAL, provisional

Base: `origin/main` **7031f74**. Isolated branch/worktree: `lcm-billing-frontend` in the approved OpenCode temporary directory. Only `apps/web/**` was edited. No shared/API/Prisma/root lock changes, production requests, keys, account fixtures from production, migration, push, or deployment.

## Delivered / not claimed

- Static `/subscription/`, noindex/nofollow; small data-settings and pricing-preview links. Existing read/export/member/workspace flows are unchanged, not paywalled.
- Existing session storage format and `serverApi.me` bearer identity verification; existing root login entry, no second account flow. Storage/focus/visibility account changes dispose previous requests/controller and clear the private view.
- Actual forms for quote selection, server amount/period/renewal display, separate initially unchecked versioned consents, hosted card registration, server-confirmed attempts, cancellation request, and refund **review request**.
- OFF/unregistered/404/failed readiness renders **결제 준비 중**. No activation toggle, synthetic production entitlement, fake history, invented legal policy, or new marketing consent.
- Synthetic tests exercise ready checkout. This does **not** mean current backend contracts exist, legal/seller/product approvals exist, commercial checkout is ON, or actual provider integration was tested.

## Expected HTTP (must align with frozen backend contract)

Client base is the existing `getServerApiBaseUrl()` / `NEXT_PUBLIC_API_BASE_URL`, with `/service-billing` appended. Deployment's actual service API base remains an integration check; no stale domain default was added. Auth uses the existing access `token`, never the refresh token. Responses are expected directly, **not wrapped**.

| Endpoint | Request / response |
| --- | --- |
| GET `/readiness` | public `Readiness` |
| GET `/subscription` | authenticated `Subscription` |
| POST `/quotes` | `{planId}` → `Quote` |
| POST `/instruments/prepare` | `{quoteId}` → `{instrumentId,sdkRequest}` |
| POST `/instruments/:id/confirm` | `{billingKey}` → JSON acknowledgement |
| POST `/charges` | quoteId, instrumentId, same idempotencyKey, versioned accepted consent → attempt with attemptId |
| GET `/attempts/:id` | owned `Attempt`; sole attempt-state display evidence |
| POST `/subscription/cancel` | `{atPeriodEnd:true}` → `Subscription` |
| POST `/attempts/:id/refund-requests` | `{idempotencyKey,reasonCode:'CUSTOMER_REQUEST'}` → `{requestId,status:'requested'|'pending'}` |

Exact provisional DTOs: `app/subscription/billing/types.ts`. Attempt statuses are **lowercase `pending|paid|failed`**, mode `mock|sandbox|live`, currency KRW, tax currently supported only `inclusive`. These are assumptions, not assertions about the parallel backend. All non-2xx responses are sanitized; 401/403 clear private display state. HTTP requests time out after 15 seconds, stop on disposal, use no-store and no automatic retries.

### Additional readiness/quote proof REQUIRED (missing = blocked)

`checkoutEnabled`, empty blockingCodes, distinct issueInstrument/charge/renew capabilities, approved VAT treatment, consentVersions and catalogVersion must agree. Explicit `approvals.{merchant,commerce,legal,featureScope}` must all be true. Real SDK mode additionally needs public `sdkConfig.{storeId,channelId}`. Mock checkout additionally requires an injected `synthetic:true` SDK; production adapter never qualifies.

Quote must bind quoteId, planId, catalogVersion, server price/currency/period, future expiresAt, mode, **featureScopeVersion**, **policyVersion**, nextChargeAt/nextChargeAmount, and approved display material:

- featureScope `{version,text}` matching featureScopeVersion;
- billingConsent / autoRenewConsent `{version,text}` matching readiness consent versions;
- sellerDisclosure `{version,text}`;
- policyDisclosure `{version,text}` matching policyVersion.

Only server-approved material is rendered as checkout terms. Internal proposal documents are **not** embedded or published as enacted policy. No undefined Pro benefits are sold. A mismatched/expired quote or refreshed readiness change clears both consents; a new quote is an explicit action. Server must independently enforce immutable quote scope/amount/versions and ownership; client comparisons are UX protection, not a security boundary.

### Cancellation proof is deliberately stricter than an ACK

Request, renewalStopped, and providerCancellationStatus are separately displayed. Confirmed wording requires **renewalStopped=true**, **providerCancellationStatus='confirmed'**, plus optional server `cancellationProof.{allChargePathsStopped,inFlightResolved}=true`. The backend must define/prove dispatch suppression, retries, provider schedules, and in-flight treatment before mapping these fields. `not_applicable` is **not** mapped to canceled. No “다음 결제 없음” promise is used. Checkout OFF does not itself block legitimate cancellation/refund capabilities; production mock mode cannot dispatch these mutations through the real adapter.

## Recovery and integration gaps — do not remove guards to “make it work”

Account-scoped **sessionStorage** intent is persisted before any instrument/charge side effect: quoteId, one UUID idempotencyKey, phase, instrumentId/attemptId if known, and one refund request UUID if used. No provider key/token/card data is persisted in this new storage, URL, logs, or messages. Existing auth storage is reused unchanged. Storage failure blocks checkout.

- A lost charge response with unknown attemptId **cannot** be reconciled using the current assumed endpoints. New quote/instrument/charge requests stay blocked; never replay with a new key. **Needed:** owned lookup by original idempotencyKey, or an equivalent latest unresolved intent/attempt endpoint keyed by account+quote. Integration must expose secure reconciliation and an explicit server-safe terminal resolution.
- SDK cancellation, issue/confirm ambiguity, and quote expiry after registration also keep the intent blocked. **Needed:** owned instrument status/reconciliation and safe cancellation/abandon flow before permitting reissuance. No blind duplicate instrument creation.
- With known attemptId, initial owned GET plus at most three user-requested checks; no background interval or infinite polling. Charge response/SDK success do not grant entitlement. Mock/sandbox always hide live paid access, even with inconsistent DTOs.
- A successful attempt is retained in the session for management/recovery. Failed terminal attempts currently do not offer a fresh checkout reset. This is intentionally conservative until server reconciliation/abandon contracts are frozen.
- Session-only intent cannot guarantee recovery after sessionStorage deletion, browser closure, or another tab/device. Server uniqueness and an owned unresolved-operation lookup must prevent duplicates across those cases. No client storage workaround substitutes for that invariant.
- No historical list API was assumed. Refund CTA refers only to the owned attempt read in this browser session, with the amount from owned GET. A review request never means refund approved/completed; repeated request uses its same UUID.
- Backend needs response alignment/validators and authoritative shared DTO import replacement before integrated checkout can be called complete. This frontend does not inspect or edit the backend worktree.

## Official SDK verification and remaining security/platform work

Verified 2026-10-07 official docs:

- https://developers.portone.io/sdk/ko/v2-sdk/readme — official `<script src="https://cdn.portone.io/v2/browser-sdk.js">`, global `window.PortOne`.
- https://developers.portone.io/sdk/ko/v2-sdk/billing-key-request — `requestIssueBillingKey`, CARD, **channelKey** (not channelId), issueId, customer.customerId.

`sdk.ts` lazily loads only this hardcoded official V2 CDN URL after an explicit pay click, approved readiness refresh, exact quote/consent checks, and server instrument preparation. Whitelisted server-bound public store/channel/issue/customer IDs are passed. No arbitrary script/redirect URL from readiness, PAN/CVC form, dependency addition, or noop “real SDK” shim.

The V2 CDN URL is official but rolling, not content-pinned. **CSP/Cloudflare deployed headers, integrity/version strategy, PG popup/frame origins, provider eligibility, hosted form customer requirements, mobile redirect behavior, and actual sandbox/live issuance/confirmation have not been validated.** Redirect callbacks carrying keys in URLs are unsupported here; provider/mobile integration must be designed and verified before readiness can honestly be enabled. Public config must never contain private provider API credentials. No runtime/provider settings were changed.

## Verification evidence

- Frozen-lock install with ignore-scripts; root lock unchanged. Local shared build used existing 7031 source only.
- Web Vitest: **29 files / 312 tests passed**, including **33 new subscription tests**. Web `tsc --noEmit` passed.
- Web static production build passed, `/subscription` prerendered; no personal JSON-LD or sitemap entry added. Build without API env is safe/off.
- `node apps/web/tests/subscription-browser.mjs` passed against local Next dev (port 3199), which was then stopped. All auth/billing/SDK routes are intercepted synthetic fixtures; all external network requests blocked. Covered 404/OFF/no SDK, 360px layout, keyboard/async focus retention, separate consent, duplicate charge protection, owned result vs sandbox entitlement, no card fields/key storage, refund request copy, and account logout privacy.
- Initial browser runs exposed a **test setup** hostname/HMR mismatch and then used localhost + fixture CORS; no production config workaround was applied.
- No independent reviewer was invoked by this subagent (no-subdelegate instruction). Main must arrange independent review and frozen backend integration; no self-review PASS, provider E2E, deployment, commercial activation, or real customer/business outcome is claimed.

## Read-only review follow-up (parent 496fdf3)

Two P2 findings addressed without changing API/shared/lock/provider configuration:

1. `subscriptionValidation.ts` now admits only explicit provisional lowercase states `draft|pending|active|payment_failed|ending|expired|closed`, plus legacy `free` or null **only for a no-contract/no-plan/free-access response**. No unknown/uppercase normalization. Required field types, paired contract/plan IDs, boolean true existingFreeAccess, known provider status, canonical UTC ISO dates (including calendar rollover checks), optional currency/environment/scope/proof shapes are validated. PaidAccess requires an active/ending contracted subscription with paidThrough strictly in the future; a nonnull nextChargeAt must not precede now or paidThrough. Historical inactive periods remain valid with paidAccess=false. Unknown/incomplete data clears the subscription view, displays unavailable, and cannot enable checkout. Mock/sandbox valid responses still never display live paid access.

   Optional `premiumScope` provisionally has `{version:string,features:string[]}`; optional `currency='KRW'` and `mode` must match readiness. These optional fields are NOT claims about the final backend. Current provider allowlist is `unconfirmed|requested|pending|confirmed|failed|not_applicable`; the main integration must explicitly map actual frozen enum values, not lowercase arbitrary strings. Final timestamp ordering/provider-local cancellation semantics likewise require backend alignment. No version/approval checkbox is fabricated, no benefits are applied, and existing free flows remain unchanged.

2. `SessionVerification` caches only a successful `/me` identity. Network/timeout/5xx failures produce **unavailable**, not a permanent fabricated logout. Focus/visibility retry is single-flight with 5s/10s/20s exponential minimum intervals (60s cap), at most three automatic failed attempts per unchanged identity, and no timer-driven polling. An explicit retry action obeys the same backoff. 401/403 or an identity mismatch stays refused until token/account changes; logout/account/token change aborts and invalidates old requests. Successful validation suppresses further event-storm requests. Verification is bounded at 15 seconds even if the transport ignores abort. The retry button stays mounted during/loading/after success to retain keyboard focus; messages never include token/key/provider error details.

Follow-up verification: **31 files / 348 Vitest tests passed** (36 additional tests above the initial 312), `tsc --noEmit` passed, and static build passed with explicit `NEXT_PUBLIC_API_BASE_URL=https://api.gamja.top/living-cost-manager/v1` and telemetry disabled. The build performs no billing/provider requests. The production-origin compiled static output is served **locally** for browser verification, with that exact API origin fully intercepted/fulfilled by synthetic fixtures BEFORE any external-network continuation; every other external request is aborted and the official SDK URL is fulfilled by a synthetic stub, never fetched. Real 15s held-timeout recovery, 503 recovery, single bounded same-token focus retry, verified-cache event storms, unknown live subscription rejection, and retained retry/checkout focus are exercised. Existing OFF/404/mobile/consent/uncertain-charge/refund/logout coverage remains. No production data, live activation, provider integration, push, or deployment is implied. The main independent reviewer must confirm these fixes and final DTO integration.

Static browser command (after the explicit-origin build): serve `apps/web/out` locally on port 3199, then `LCM_BROWSER_URL=http://localhost:3199 LCM_FIXTURE_API_BASE=https://api.gamja.top/living-cost-manager/v1 node apps/web/tests/subscription-browser.mjs`. Production origins are fixture interception selectors only, not allowed outbound requests.
