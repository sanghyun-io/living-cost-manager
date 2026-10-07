# Multi-ledger backend contract (2026-10-07)

Source base: reviewed template integration `8c4e128`. No new Ledger table or
schema migration: Workspace is the ledger, and User has many WorkspaceMember
rows with unique `(workspaceId,userId)`. Browser AppUser/profile IDs are never
server account/owner IDs. Existing single-workspace routes remain compatible.

## API

All routes use the current access JWT and tokenVersion checks. Invalid new
request bodies return generic 400; membership denial returns generic 403 without
the unauthorized ledger's existence, name or partial totals.

### POST /workspaces

Verified email required. Payload:

```json
{"name":"Personal","initialBudget":{"monthlyIncome":3000000,"categories":[],"cards":[],"fixedCosts":[]}}
```

`initialBudget` may be omitted (empty ledger). Budget entity fields match
WorkspaceSnapshot **without** workspaceId; syncVersion cannot be supplied.
Cards/categories/fixedCosts keep their ledger-local IDs. The server binds all
entities and the owner membership to a newly generated workspace ID and the
authenticated User ID. Name is trimmed, 1–100 characters; budget arrays max
200 categories, 200 cards, 2000 costs; income/amount fit PostgreSQL Int.
Ownership/role/workspace/profile overrides and unknown payload keys are rejected.
Duplicate IDs/category labels and missing budget references are rejected.

201: `{workspace:{id,name,role:"owner"},snapshot:WorkspaceSnapshot}`.
Initial `syncVersion=0`. Workspace, membership, initial rows and initial backup
are one transaction; a late failure rolls all of them back. Existing local data
is not modified or moved by this operation. Rate limit: 20/minute per IP, before
database authentication, alongside the existing global test-mode disablement.

### PATCH /workspaces/:workspaceId

Verified email and current owner role required. Body `{name:string}` only.
Returns WorkspaceDto. Owner check and rename run in Serializable isolation;
serialization conflicts return 409 (retry after refreshing membership). Does
not change financial syncVersion or overwrite the financial snapshot.

### POST /workspaces/aggregate

Authenticated account; owner/editor/viewer may read. Body
`{workspaceIds:string[]}` with 1–20 entries before deduplication. Duplicates
count once; output preserves first-selected order. No implicit "all ledgers"
selection and no client-specified account, currency or clock.

Response `AggregateWorkspacesResponse` exported from shared:

- `currency:"KRW"`, `timeZone:"Asia/Seoul"`, sampled `asOf` ISO instant,
  `fromDate`, `untilDateExclusive` (calendar dates).
- `workspaces`: ID, name, current role, syncVersion and financial summary.
- `totals`: summed financial summary. No email, membership list, cost names,
  categories or payment details returned.
- Summary: `monthlyIncome`, `monthlyNormalizedExpense`, `fixedCostCount`,
  `knownScheduleCount`, `unknownScheduleCount`, `dueOccurrenceCount`,
  `thirtyDayDue` (number or null).

ALL memberships are read/validated before financial reads. Membership and
financial reads use one RepeatableRead snapshot, with bounded batched lookup
and minimal fields, not per-workspace full snapshots. A revocation committed
before the transaction snapshot fails the whole request; a request already
authorized on its snapshot can finish during a concurrent revocation. This is
not a promise to cancel in-flight responses retroactively. Membership writes
and snapshot writes are still governed by their existing authorization and
optimistic locking rules. Rate limit: 60/minute per IP.

## Financial semantics

The shared pure calculator uses UTC calendar arithmetic after deriving KST's
calendar date from the instant; it never depends on browser/process timezone.
Thirty-day actual charges use `[KST today,KST today+30 days)`, not 30x24 hours
from the reference time. Today's charge is included; day +30 is excluded.
Integral periods 1–120 months with valid anchors are known schedules. Original
anchor day is sticky across short-month/leap-year clamps; end-of-month overrides
anchor day. Every occurrence inside the window contributes its full amount.
Future anchors cannot schedule charges before the anchor.

Missing/invalid anchors and fractional/zero periods are unknown schedules for
positive-cost items; they are excluded from actual due sums but explicitly
counted, never guessed. If positive costs exist but no schedule is known,
`thirtyDayDue=null`; mixed known/unknown returns the known-only sum and unknown
count. Empty/zero-cost-only budgets return zero. A known schedule with no charge
in the window returns zero. "Actual" means scheduled full charges, not bank
settlement verification.

Monthly normalized expense sums raw `amount/periodMonths` for positive periods
(including supported fractional periods); zero period contributes zero. Round
only the **final display** in KRW, not each cost or each ledger. This deliberately
avoids the existing `monthlyEquivalent` per-item rounding discrepancy; existing
single-ledger/UI callers are unchanged. Frontend integration must adopt this
contract for both individual and selected summaries, or clearly label old
per-item-rounded displays. Actual known schedules are regression-tested against
the existing single-ledger prediction for the same KST calendar day.

## Scope and verification

Only shared workspace contracts/calculator, workspace API/service/tests, and
this document are changed. No frontend, production data/environment, migration,
deployment, credentials, payment provider or ops helper changes. API integration
tests require the repository's guarded **local test database and schema**.
Implementation author does not claim independent reviewer signoff; the parent
session must arrange its separate read-only review and frontend integration.

Author-run validation: shared/API TypeScript builds passed; shared 12 files /
165 tests and API 17 files / 260 tests passed against a newly initialized local
PostgreSQL cluster (`127.0.0.1:55439`, database `lcm_multiledger_test`, schema
`multiledger_test`). The 7 aggregation fixtures also passed in separate processes
with `TZ=UTC`, `TZ=Asia/Seoul`, and `TZ=America/Los_Angeles`. Tests include a real
transaction rollback on injected backup failure and a concurrent committed
membership revocation plus finance/version update between transaction reads.
The temporary cluster was stopped after verification. No production DB accessed.
