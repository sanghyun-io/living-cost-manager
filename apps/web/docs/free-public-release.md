# Free public frontend release (2026-10-07)

Baseline paid-capable RC: `b637490ca4d6b967c2d8b8e3a4b073fe92bc74b0` remains frozen. This change affects only `apps/web`. It does not delete any account, ledger, cache or shared membership, and does not assert production has no users.

## Public scope

- Local fixed-cost/budget/payment-card/renewal management, backup/export and template structure editing/sharing remain available. Personal subscriptions are not service billing.
- A verified account with a current successfully loaded list and no **owned** ledger may create its first ledger. Shared editor/viewer memberships do not consume this limit. Unknown/failed/stale lists cannot authorize creation. The server must enforce the atomic cap separately.
- Existing multiple ledgers stay selectable with their current read/edit/export/sharing rights. No additional-owned-ledger entry, cross-ledger aggregate entry, service pricing, checkout or subscription navigation is published.
- Templates still copy to a separate local guest space. Authenticated template application only creates a first owned ledger; it never overwrites an existing ledger. Account amounts/income go to the server on creation, not into a shared structure.
- `/subscription/` has no Next route or static export. No placeholder/coming-soon/upgrade CTA substitutes for it. No billing SDK is loaded by public entrypoints.

## Preserved paid-ready source and restoration recipe

`app/features/service-subscription/` is non-routed source. Controller/API adapter/SDK, session verification, validation, CSS and UI are preserved; `route-entry.tsx` archives the former `app/subscription/page.tsx`. `pricing-preview.tsx` archives the former `app/guide/pricing-preview.tsx`. Public pages do not import them. Unit tests import the internal module and continue to run.

For a **separately reviewed and approved paid release**, create `app/subscription/page.tsx` importing `SubscriptionPage` from `../features/service-subscription/subscription-page`, and restore the metadata from `features/service-subscription/route-entry.tsx`. Do not copy the archived relative import unchanged into a different directory. Restore pricing through an explicit reviewed import and approved copy, not a browser flag. Restore paid ledger controls/policy only alongside the corresponding server entitlement enforcement. Full former public guide/FAQ wording can be retrieved from baseline `git show b637490:apps/web/app/guide/content.ts`; do not restore old draft pricing or feature claims blindly.

PG contract alone is **not** proof of launch readiness. Provider configuration and callbacks, product/price/consent/seller/policy approvals, legal/tax review where needed, entitlement/refund/cancellation behavior, exact period boundary/date policies, security and release tests remain launch gates. No one-click enablement or live charge verification is claimed here. Do not expose an internal preview via a production Next route, query parameter or localStorage switch.

`subscription-browser.mjs`, `multiledger-browser.mjs` and `multiledger-review-browser.mjs` are retained paid-capable synthetic regression harnesses; their paid-control expectations no longer apply to the free export. Run them only in an isolated local paid test fixture/worktree after deliberately restoring that fixture's route/policy. The free production app must never acquire a preview route for those tests.

## Local verification

Install with frozen lockfile; generate the local Prisma client for the existing opt-in test's type imports (no DB access), build shared, run web tests and TypeScript. Build explicitly with `NEXT_PUBLIC_API_BASE_URL=https://api.gamja.top/living-cost-manager/v1`. `node apps/web/tests/free-public-browser.mjs` starts a loopback-only static server and intercepts every external request with synthetic fixtures or aborts it; it checks missing paid routes, ownership limits, guest templates, retained cache/edit/viewer access and mobile overflow. Never point it at production.

The existing billing real-API/mock-provider test is opt-in and skipped by default; public deployment, actual provider charging and business outcomes are not frontend completion evidence. Main agent performs independent review and combined backend/frontend testing before sequenced deployment.

Implementer evidence in this branch: 32 web test files passed, 367 tests passed, one isolated-DB opt-in file/test skipped (33 files/368 tests total); local TypeScript and explicit-production-origin static export passed. Local synthetic browser checks pass for guest application, first ordinary/template creation, shared viewer not consuming ownership, existing one/multiple ledgers, preserved cached edits/sample-return focus, viewer restrictions, unavailable-list fail-closed, free first-create keyboard focus, mobile overflow, absent billing/aggregate/SDK requests, paid-route 404 and public HTML/JS/SEO absence of paid entries. Browser harness failures during construction were corrected (server root boundary, required-label selector and waiting for asynchronous template-list completion); the final passing run is separate evidence. This does not claim all historical paid browser tests, independent review or deployment were run here.
