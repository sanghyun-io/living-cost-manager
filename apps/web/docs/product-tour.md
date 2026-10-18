# Optional product tour (frontend-local implementation)

Based on `52f4d129c94fc4e806aca74408c4418034d2fe1e`, using the separately implemented backend contract. No API, Prisma, shared source, dependency, lockfile, production environment, account, or DB change is included.

## Behavior and safety

- Small, dismissible **간단히 둘러볼까요?** invitation; never auto-starts the tour or claims the service itself is new to the user. Its fixed portal does not move the summary/list. After dismissal/completion there is no extra home copy.
- Four steps: add/quick-add → first visible due-date input or persistent due help (add fallback) → data management/browser backup → optional guest login or account cloud-sync management. These are whitelisted presentation-only DOM targets.
- The add (step 0) and due-date (step 1) targets live inside the collapsible 항목 관리 panel; entering those steps expands the panel (no other view, focus, or data changes). Steps 2-3 and dismissal never expand or collapse anything, so there is no open/close focus loop.
- Next/back/complete/close/skip only change tour preferences. They never add an item, open a modal, authenticate, upload a snapshot, delete, or change a ledger. Existing target controls retain their own user-initiated behavior.
- Tools → **둘러보기** replays even if the preference API is unavailable. Viewer/unverified users can explore; viewer copy does not promise editing. Sample mode permits manual exploration, suppresses automatic invitations, and cannot send account preference writes.
- Card only receives pointer events; the highlight/layer does not. Nonmodal `role=dialog`, `aria-modal=false`, no focus trap. Escape closes only the tour when no existing modal is active. User-opened modals pause/hide the tour and keep Escape priority.
- Target `aria-describedby` appends/removes only the tour ID, retaining existing help and concurrent changes. Missing/unmounted targets are safe. Start focuses a card control; finish restores the connected opener or the stable Tools trigger. Scope changes close stale tours without focusing an old account's controls.
- ResizeObserver + RAF-coalesced scroll/visualViewport/DOM observation are cleaned up; observers are inactive once invitation/tour is absent. Reduced motion avoids smooth scrolling. Compact cards clamp to the visual viewport; description can scroll independently of actions. Controls have 44px minimum hit sizes, light/dark and forced-color support.

## Account contract and isolated storage

The dedicated adapter uses the existing configured API prefix:

```
GET /onboarding/product-tour
PUT /onboarding/product-tour {version:1,status:"completed"|"skipped"}
→ {version:1,status:"unseen"|"completed"|"skipped",updatedAt:null|ISO timestamp}
```

The hook waits for loaded local/auth UI and nonbusy auth. The adapter additionally validates `GET /me` against **auth.serverSession.user.id**, never JWT decoding or a cached ID guess, before loading/writing tour preferences. A failed identity probe, unavailable API, 404, request failure, or malformed DTO defers automatic invitation but not manual replay.

Storage keys are dedicated `living-cost-manager:product-tour:v1:<encoded scope>` with `local:<localUserId>`, `account:<validated session userId>`, and `sample:<localUserId>` separation. Values contain only version/status/pending, no token, email, budget, legal/marketing consent, or shared cookie data. Storage failures use authoritative page-local memory. GET itself never creates a record on the server; only explicit tour finish/skip writes. No per-step writes or analytics.

Server terminal preferences suppress invitations in other browser profiles. Completed is monotonic (including replay-close and late skip). Pending failures belong only to their own account; retry is permitted after successful same-scope identity/GET on reload/re-entry, or an explicit finish. A server completion cancels a pending skip. Abort + generation fence logout, account, ledger, and sample transitions, including ignored-abort transports. Sample/local/mismatched scopes cannot receive account transport. Guest dismissal never becomes an account PUT; only the immediate login transition's repeated invitation is suppressed for that page, not other accounts' independent state.

## Local verification

All fixtures are synthetic local/mocked data. The browser harness serves only the local static export, fulfills the configured API origin in-process, and aborts all other remote requests. Never run it against a public/production origin.

```
pnpm --filter @living-cost-manager/web exec tsc --noEmit
pnpm --filter @living-cost-manager/web test
NEXT_PUBLIC_API_BASE_URL=https://api.gamja.top/living-cost-manager/v1 pnpm --filter @living-cost-manager/web build
node apps/web/tests/product-tour-browser.mjs
node apps/web/tests/quiet-editor-browser.mjs
node apps/web/tests/expense-row-ux-browser.mjs
node apps/web/tests/free-public-browser.mjs
```

Baseline workspace dependencies were installed frozen, with scripts disabled. Shared build output and an already-generated matching baseline Prisma client were used only for existing web test/type imports; no schema generation/migration, DB connection, or API execution took place. The existing opt-in local-DB billing test remains skipped.

New pure tests cover DTO/API strict request, own identity, storage fallback, scoped invitations, guest→login suppression, completion precedence, failed PUT queue/resume, unavailable API, and stale logout/account/ledger/sample responses. Browser tests cover empty/guest/sample/viewer/unverified, real target controls, help restoration, nontrapped Tab/Escape/opener focus, modal pause/priority, missing targets, mocked cross-profile completion, independent account skip, replay close, and failed API manual/reload recovery. Existing three active free-web browser suites retain their strong core assertions; their fake routers explicitly provide the new GET and guest fixtures dismiss the invitation rather than bypassing it.

Screenshot matrix: all four steps at 320/390/768/1440, light/dark, ordinary and correctly doubled computed text sizes; additionally Chromium CDP 200% page/pinch zoom (visualViewport, native keyboard activation) at each size/theme, plus 320px forced colors. 100 spotlight screenshots, final card clipping 0, 0 snapshot PUTs and 0 forwarded remote requests. Ordinary matrix uses native pointer activation; pinch-zoom matrix uses keyboard activation because Playwright's CDP pinch mouse coordinate mapping is unsuitable for those fixtures. This is not a claim of separate desktop browser-toolbar zoom or manual screen-reader testing.

Evidence directory for this implementation: `/private/var/folders/f_/kdvkncsn11l2nssxg_75xglc0000gp/T/opencode/product-tour-6112c268-evidence/` (`tour/results.json`, `tour/*.png`, retained `quiet/` and `rows/` evidence).

Final implementation verification on 2026-10-10: full web TypeScript passed; 36 unit files / 410 tests passed, 1 opt-in DB file/test skipped (37 files / 411 tests total); production-origin static build passed; new tour browser suite and all three active existing free-web browser suites passed. The 30 new pure-tour tests are part of those totals. These are implementer-run checks, not independent review.

An intermediate retained row-suite run exposed its final clone keyboard sequence's focus timing race. The harness now waits for and strongly asserts the clone menuitem's actual focus before Enter, retaining clone/new-ID/data/persistence assertions. Two consecutive final row-suite runs passed (`rows/`, `rows-confirm/`). Earlier construction runs are not counted as passing evidence.

Independent review, backend/frontend integration, public deployment/screenshots and actual production account preference verification are **not** performed by this frontend-only role; they remain main-session tasks.
