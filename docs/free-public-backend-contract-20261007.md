# FREE_PUBLIC backend contract (2026-10-07)

Local source change only, based on `b637490ca4d6b967c2d8b8e3a4b073fe92bc74b0`.
No production/customer queries, deletion, runtime configuration edits, provider
calls, deployments or Prisma/schema/migration changes accompany this change.

## Default boundary

`SERVICE_PAID_FEATURES_PUBLISHED` is a non-secret, strict `"true" | "false"`
startup parameter, default **`"false"`**. `yes`, `1`, booleans, whitespace and
case variants are rejected. It is not a client header/body option. Future
registration/delivery must use **opskv** and the existing approval process;
the free release needs no new runtime value. Do not edit a live `.env` as a
separate management source.

All paths beneath `/service-billing` are **unregistered** while dark: 404 for
readiness, subscription, quotes, instrument prepare/confirm/revoke, charges,
polling, cancellation, refund requests, mock controls, webhook/callback and
unknown routes. This holds with or without `API_BASE_PATH`. No billing service
or provider is constructed by application startup on that path. `/health`
remains `{ ok, releaseId, commitSha }`, not provider or merchant metadata.
Personal `FixedCost`, renewal-review/savings calculations, cards, income,
normal single-ledger snapshots/history, sharing roles and export data stay
free and retain their original authentication/authorization rules.

## Workspace and template APIs

| Request | FREE_PUBLIC behavior |
| --- | --- |
| `GET /workspaces` | All authorized existing memberships retained, even multiple owners |
| `POST /workspaces` | Verified user with **zero owner memberships** can create first owned cloud ledger |
| Additional creation | 403 `{ statusCode: 403, error: "Forbidden", code: "FREE_WORKSPACE_LIMIT", message: "FREE_WORKSPACE_LIMIT" }` |
| `POST /workspaces/aggregate` | Valid authenticated selection (even a single ledger) gets 403 with `code`/`message: "FEATURE_NOT_AVAILABLE"` |
| Existing snapshot/read/write/history, owner rename, member/invitation access | Original permission checks unchanged; no free-release data purge |

Malformed requests still get 400 and missing/invalid authentication gets 401;
existing verified-email and account-local rate limits retain precedence (429
after excessive calls). Error codes carry no actor IDs, financial rows or
upgrade URL. Frontend should use neutral non-upgrade copy and retain existing
selectors/data access. Creation is not newly idempotent: after a lost response,
reconcile membership listing before retrying rather than assuming absence.

Quota counts actual `WorkspaceMember.role = owner`, not shared editor/viewer
membership, signup date or alleged absence of existing users. Existing multiple
ledgers survive unchanged, but cannot create another free ledger. Both route
and direct workspace service use the guard. Signup's initial ledger is guarded
after creating the real User FK inside the same transaction.

Each creation locks **User first**, counts owned memberships after acquiring
the lock under PostgreSQL READ COMMITTED, then writes workspace/membership,
initial financial rows and backup atomically. Concurrent normal and
template-initialized creation share this exact lock, so only one free ledger
can commit. Missing user fails 401 before financial writes. Lock order matches
account deletion and billing's User-before-contract ordering.

**Source verification correction:** b637 has no `/templates/:id/apply`,
`newWorkspace` server endpoint or template `useCount` field. Authenticated
template application in `apps/web/app/page.tsx` calls `ledgers.create`, hence
`POST /workspaces` with `initialBudget`. That is the guarded transaction; a
denied application cannot rewrite existing data or private template metadata.
Guest template application remains browser-local and is not gated by this API.
Private template CRUD and structure-only public template shares remain free.
No overwrite-as-workaround or new template schema was introduced.
Normal signup already creates the first owned ledger, so an authenticated
template-to-new-ledger action on that account is denied, even if the existing
ledger is empty. Guest/local apply and template viewing remain available; no
implicit replacement of the signup ledger is authorized by this release.

## Private payment code and eventual activation

Crypto, models, PortOne/mock adapters and regression tests remain in private
source. Dark publication disables every dispatch capability, including CLI
instrument issuance, charge, renew, cancellation/revocation and refund.
`runBillingWorker(..., "renew" | "refund")` rejects before client construction
when dark. A private bounded **reconcile** worker is still possible only with
the existing fully verified scope/configuration and explicit registered
`workers.reconcile` capability. It can inspect existing outstanding attempts;
it cannot create charges/cycles or execute dark cancel/refund dispatch. There
are no automatically registered workers/timers or currently asserted approvals.

Publication **alone is insufficient**. Non-test HTTP billing exposure also
requires LIVE mode, encryption configuration, verified commercial manifest,
scoped provider credentials/webhook verification, and complete
issue/charge/renew readiness. Additional-ledger/aggregate entitlement requires
persisted current **LIVE**, verified `paid` attempt/paid-period coverage for
the actual account, matching provider/store/channel/catalog/approved feature
scope and scope version. Sandbox and mock payments never grant production
entitlement. Existing covered paid-through periods are not made contingent on
renewal cancellation being absent. Free quota applies to every actual account
without LIVE coverage, even if publication is true.

An actual future launch still needs explicit approved benefit/seller/policy,
legal/tax/VAT/merchant material, verified PG channel/store/key delivery,
registered bounded worker scope, financial/restore evidence and separate
frontend publication. **PG contract signature alone is not an ON switch.**
Known renewal operating-policy gap remains: current exact-due/+1 ms behavior
needs a separately approved future charging-window/first-period/next-charge
policy implementation and tests before paid launch. This task does not choose
consumer financial/refund policy, change dates or claim immediate paid readiness.

## Local verification fixtures

`buildApp({ testPaidFeatureAccess: true, env: loadEnv({ NODE_ENV: "test", ... }) })`
is an explicit in-process legacy multi-ledger fixture. Development/production
construction rejects it; `server.ts` supplies no such option. No environment,
header or body flag can activate it. Direct preserved aggregate tests explicitly
pass that app's policy. New default-free tests use no override.

Private payment fixtures now explicitly set publication `"true"` in isolated
test configuration; providers remain injected fake/mock transports. The billing
rate-limit test installs real development limiters, then explicitly registers
the private mock route fixture in-process with test-only configuration, not a
fake production LIVE approval or a production startup bypass.

Tests must target an owned loopback database **and schema containing test
markers** via `API_TEST_DATABASE_URL`. `tests/setup-test-db.ts` resets that
isolated schema, never `DATABASE_URL` fallback. Main must independently review
and test the combined frontend/backend merge before sequencing any deployment.

Implementation verification: offline frozen-lock install, Prisma client
generation from the unchanged schema, shared/API TypeScript builds, and full
API suite **402 tests / 26 files passed** (baseline 388 + 14 default-free
regressions). Tests used an independently created local
`lcm_free_backend_test_20261007` database and `lcm_free_backend_test` schema,
not another worktree's schema. No skips or expected-failure conversions were
added. Main's separate security/reviewer and combined frontend/deployment
checks are still pending; these results do not claim them complete.
