# Billing frontend integration — INTERNAL technical handoff

## Immutable source and ownership

Authoritative backend base verified as **1fecf301304f2165a4c6f01b8d2f5ea089c9e30f** (2026-10-07). New worktree `lcm-billing-ui-integrated`, branch `feat/lcm-billing-ui-integrated`, in the approved OpenCode temp directory. Web-only commits `496fdf3` and `dc39c6c` were cherry-picked as `3da1528` and `d63f471`. Original frontend worktree remains historical and unchanged; backend worktree/uncommitted corrections were not inspected.

This document replaces the **provisional planner DTO** handoff only on the new integration branch. Sources of truth are this immutable base's `docs/service-billing-provider-contract.md` and `packages/shared/src/serviceBilling.ts`. No API/shared/Prisma/root-lock edits, merchant credentials, operational parameters, provider/customer calls, signup/mail, production DB migration, push or deployment. Generated Prisma/node_modules/build files are ignored local artifacts only.

## Integrated contract

`billing/types.ts` aliases the authoritative shared DTOs; response parsing uses exported **strict shared Zod schemas** for readiness, quote, attempt, subscription, instrument snapshots and refund responses. Preparation and confirmation have no exported complete shared response schemas at this base, so the HTTP boundary adds minimal strict runtime checks for the documented shape; confirmation's status uses the shared enum. Unknown JSON/status/fields fail closed and errors are sanitized. Generic invalid responses also clear previous subscription evidence; 401/403 clear all private views.

All HTTP routes are joined to existing `getServerApiBaseUrl()` with `/service-billing`. Existing bearer access token is used, never refresh token. No duplicate auth/signup flow. Requests are no-store, abort on account disposal and time out at 15s, without automatic POST retry. `/me` recovery from `dc39c6c` remains: successful identity cache, separate unavailable/refused state, single-flight focus/visibility retry with 5s/10s/20s backoff and three automatic failed attempts; manual retry remains throttled. Account/token changes invalidate late responses. Retry and checkout buttons retain focus while pending.

| Route | Frontend behavior |
| --- | --- |
| GET readiness | Parse actual mode, capabilities, approvedVersions/material/status, catalog and public SDK configuration |
| GET subscription | Actual `free|idle|active|cancel_at_period_end`, cancellation `none|pending|verified`, premiumScope `provisional|account-subscription-v1` |
| POST quotes | Send only planId; exact server total/currency/period/TTL and all five version/material snapshots checked |
| POST instruments/prepare | Send only quoteId; server-owned issue/customer/instrument binding |
| POST instruments/:id/confirm | Ephemeral billingKey; returned same instrument and verified status required |
| POST charges | Original quoteId/instrumentId/UUID and billing+autoRenew versions, accepted:true; no browser amount/policy/feature override |
| GET attempts/:id | Owned attempt only; exact `created|dispatch_unknown|paid|failed|manual_review|canceled_before_dispatch|refunded`, reviewRequired and paidPeriod |
| GET attempts/by-idempotency/:key | Owned original UUID lookup only; lost response can now reconcile without returned attemptId |
| GET instruments/:id; POST instruments/:id/revoke `{}` | Registration ambiguity status/revocation, distinct from contract cancellation/refund |
| POST subscription/cancel `{atPeriodEnd:true}` | Renewal stop vs provider cancellation pending/verified kept separate |
| POST attempts/:id/refund-requests | Same refund UUID, reasonCode other; server requestAmount/KRW and exact shared status displayed, never execute a refund |

## Actual readiness, quote and consent gates

Real sandbox/live requires checkoutEnabled, issueInstrument+charge+renew, no blocking codes, inclusive tax, approvalStatus **approved**, nonempty approvedMaterial plaintext for all five fields, public storeId/channelId/**channelKey**, and consentVersions equal approvedVersions billing/autoRenew. These are protected server manifest evidence, not frontend approval switches. No invented `approvals` booleans, material versions, subscription state normalization, or client premium scope switch remains.

Quote has **no mode, nextChargeAt, nextChargeAmount, or separate per-material version objects**. It must match readiness catalog, exact fixed server price/period/KRW, future expiry, consentVersions, all **featureScope/policy/seller/billing/autoRenew** approvedVersions, and every material plaintext value. Refreshed readiness before issuing detects changes and clears the quote and both consents. Expiry also requires explicit new quote and fresh consent. Approved material is rendered through React text nodes, never HTML; bounded by shared schemas. Declining consent leaves every existing free feature available. Marketing settings are untouched.

Server subscription nextChargeAt is displayed only when available. The frozen quote has no authoritative pre-purchase period start/end/next charge timestamp; the UI says server verification is needed rather than inventing dates or browser-calculated renewal guarantees. **Release/product review must decide whether further immutable pre-purchase dates/renewal disclosures are needed in the quote contract.** Do not solve this by copying internal drafts into commercial policy.

Paid access display requires the strict subscription schema, known active/cancel_at_period_end status, paired contract/plan IDs, approved account-subscription-v1 scope, and future paidThrough. It additionally requires LIVE readiness approved status. Mock/sandbox responses never display LIVE paid access, even if inconsistent. Owned attempt reviewRequired blocks fresh checkout and refund requests; after lookup, it also suppresses the displayed paid state. SDK success and charge POST responses do not grant access.

### Explicit local mock, not commercial approval

`browserBillingSdk(hostname)` supports mock only on localhost/127.0.0.1/IPv6 loopback. Mock readiness must have mock_draft, null material/config and only the documented MOCK_ONLY/product/legal blocking codes. The mock adapter returns `mock_${serverIssueId}` to the **mock server** without loading a script or calling a provider. No frontend NODE_ENV override or production activation toggle exists; the server separately prohibits production mock activation.

Visible wording is **모의 결제 · 실제 청구 없음**. Mock confirmation controls explicitly say flow checks, not real purchase/renewal consent. No legal/seller draft is represented as approved policy. Mock button explicitly says simulated registration/charge; no card field is collected or transmitted. Real-mode material is displayed only from approved immutable server quote snapshots.

## Recovery and management semantics

Account-scoped sessionStorage contains only original quoteId/instrumentId, idempotency UUID, progress phase, createdAt, same **nonsecret charge payload** and returned attemptId when known; refund UUID is similarly reused. No billing key, card information, token, amount or customer finance data is added to recovery storage, logs, URLs or messages. Existing auth storage remains unchanged. Storage failure/corrupt intent blocks checkout.

- Before prepare and charge, persist intent. On lost charge response, reload/check uses original UUID GET by-idempotency. **404 is not proof of no dispatch**: same intent and payload stay blocked. No blind re-POST, fresh key, new instrument, or automatic redispatch.
- Initial owned lookup plus up to three explicit checks; no interval/background polling. Created/dispatch_unknown/manual_review never become success; known paid requires server paidAt and an ordered paidPeriod. No client timestamps grant entitlement.
- Registration cancellation/confirmation ambiguity can inspect/revoke the owned instrument. Empty/unknown provider key lookup remains manual review server-side. Revoked status never clears an uncertain original charge. Confirmed paid/refunded sessions use contract management rather than the separate registration cleanup control.
- A terminal attempt stays visible; this UI **does not clear/restart checkout**, even after failed/refunded/revoked evidence. Supporting a new purchase requires server lifecycle/initial-cycle eligibility decisions and explicit safe resolution. This conservative limitation avoids incorrect retry of an already-dispatched attempt.
- SessionStorage cannot guarantee recovery across deletion/browser closure/another device. Server uniqueness and owned lookup remain mandatory; no local marker substitutes for server idempotency. A future owned unresolved-operation/history endpoint would improve cross-device recovery; none is fabricated here.
- Verified cancellation means actual renewalStopped plus actual providerCancellationStatus verified. This follows the frozen backend's one internal renewal worker and verified provider key deletion semantics; no fabricated remote schedule mapping or `not_applicable` waiver. UI does not promise “다음 결제 없음”, automatically refund, or remove remaining paid/free access.
- Refund responses use actual requested/dispatch_unknown/verified/rejected/manual_review enums. Requested is explicitly a review request, not refund completion. Verified status and amount appear only from owned server response. No amount input, fake prorating, operator execution API, or browser refund-worker activation.
- Attempt DTO has no historical amount or quote binding display fields. No amount/history is invented from current catalog. Refund amount is displayed only after the server computes the request; a richer owned receipt/history/pre-request estimate is a future backend UX contract, not falsely claimed implemented.

## SDK provenance and remaining platform release gates

Official docs verified 2026-10-07:
https://developers.portone.io/sdk/ko/v2-sdk/readme
https://developers.portone.io/sdk/ko/v2-sdk/billing-key-request

Real adapter lazily loads only hardcoded `https://cdn.portone.io/v2/browser-sdk.js` and calls actual `window.PortOne.requestIssueBillingKey`. Whitelisted browser parameters are storeId/**channelKey**/issueId/CARD and `customer.customerId` mapped from server's opaque customer.id. Server-only channelId is checked against readiness but is **not** passed as channelKey. No arbitrary script/redirect URLs, PAN/CVC form, placeholder noop integration, or dependency/root lock change.

Official V2 CDN is rolling, not content-pinned. Actual merchant/test/live config, PG customer requirements, mobile redirect handling, popup/frame origins, deployed Cloudflare CSP and integrity strategy still require independent platform/security verification. Redirect callbacks exposing billing keys in URLs are unsupported. No real SDK or provider E2E was run, and readiness manifest/merchant/legal/seller/paid-benefit/tax approvals remain actual launch gates.

## Implementer verification, not independent approval

- Frozen-lock install + existing shared build; root lock/shared source unchanged. Generated Prisma client uses this immutable base's schema.
- **32 test files / 359 tests passed**, including opt-in actual frozen API integration; TypeScript and static production build passed with explicit `NEXT_PUBLIC_API_BASE_URL=https://api.gamja.top/living-cost-manager/v1`, telemetry disabled. No server-side billing request is made by static build.
- New actual API test (`subscriptionLocalApi.test.ts`) uses Fastify **app.inject**, real shared schemas/API/auth/Prisma service and an explicitly injected in-memory mock provider. It signs only a newly created synthetic test user in its isolated DB; no signup/email/provider network. Real generated quote/prepare/confirm/charge + response loss + same UUID lookup + request-only refund + cancellation pass. Provider dispatchCount remains one and LIVE paidAccess stays false. The raw key/JWT never reaches intent storage.
- Dedicated ephemeral postgres:16-alpine container `lcm-ui-frozen-test`, loopback **55443**, fresh `lcm_billing_test` synthetic data only. All nine already-frozen migrations applied there; no migration was edited or applied elsewhere. No backend's existing validation DB was touched. Container is stopped/removed after validation.
- Opt-in command: `LCM_WEB_LOCAL_BILLING_TEST=true pnpm --filter @living-cost-manager/web test`. Default tests skip only this isolated-DB case. Its DB URL is hardcoded to the dedicated synthetic loopback target, never inherited from runtime DATABASE_URL; ephemeral fixture signing/encryption material is generated in process and not operational credentials.
- Static browser tests serve only local output; exact API origin and official SDK URL are intercepted/fulfilled locally before any external continuation, all other external requests aborted. Passed frozen DTO alignment, OFF/404, unknown LIVE status, 503/real 15s timeout auth recovery, event storms, 360px layout, keyboard/async focus, separate consent, duplicate prevention, sandbox entitlement suppression, request-only refund, logout privacy, and explicit local mock checkout with **no SDK load** plus lost-response UUID lookup/no redispatch.
- Material escaping, all five version/material mismatch gates, unknown/strict schemas, uncertainty/manual review, SDK cancellation/failure, storage denial, account disposal and refund/cancel capabilities covered by unit tests.
- Independent reviewer/security and final backend runtime P2 corrections remain main-session responsibilities. This branch used immutable 1fecf30, not uncommitted backend fixes. No self-review PASS, production deployment, LIVE activation, actual provider approval, real charge/refund or business outcome is claimed.
