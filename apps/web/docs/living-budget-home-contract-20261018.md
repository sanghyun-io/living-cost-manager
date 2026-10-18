# Living-budget Home Contract (Release 1 · Phase 1)

Owner-scoped frontend change under `apps/web` only. No DB, API, Prisma, shared
source, CI, lockfile, dependency, or production change. Baseline `0e20b06`.

## What the first screen answers

1. **이번 달 계획** (`BudgetStrip`, one derived source): 월 환산 고정비 (비교용),
   고정비 제외 계획금액 with one `변동지출·실제잔액 미반영` safety note, and the
   neutral `월수입` editor (`#monthly-income`, `inputMode`/`enterKeyHint` real HTML
   attrs). Income `0` is the stored schema default and is shown as `월수입 ₩0 기준`
   — never as `미입력` (we cannot distinguish unset from a real 0) and never as a
   negative headline. Negative plan values appear only once income > 0, styled
   `rose`, without `role="alert"`.
2. **다음 납부 예정** (`UpcomingDues`, the single canonical dues component): the
   30-day confirmed-schedule total (`결제 완료액이 아닙니다` help window text lives
   here now), `일정 미확인 N개` tally, `확인된 일정 N회 청구`, the near-payment list
   (default 3, `전체 보기`/`접기` with `aria-expanded`), and a per-row `보기` action
   calling the single `revealItem` handler. Quarterly items show the actual charge
   total, not the monthly normalization.

All amounts derive from `buildHomePlan()` (`app/lib/homePlan.ts`), computed once
per page render from `referenceInstant` and shared with the components; no
component re-runs `summarizeWorkspaceBudget` for headline numbers.

## De-duplicated replicas

- `MetricGrid` (지출 분석) no longer re-shows 월 환산 고정비/남는 금액; it keeps
  구성 facts only (count, largest, average, `연 환산 (월 환산 × 12) · 추정`).
- `InsightsPanel` no longer renders the 30-day total block or a second
  near-payment list; savings/report/trend/share and the read-only
  `납부일·갱신 계획 수정` link remain. The link and the root skip link both call
  the existing `budget.requestManagementOpen` on click before native fragment
  navigation, so a `#fixed-costs` entry is supported even while management is
  collapsed (reviewer P2 follow-up commit). No forced clicks, no global DOM
  hacks; viewer ledger fields stay disabled through the per-region fieldset
- The analysis/renewal pane is no longer wrapped in a disabled `fieldset`, so
  native `<summary>` and read-only/reveal/preference controls work for viewers;
  every ledger write (table edits, quick add, delete/duplicate, income,
  import apply, category/card mutations) remains inside per-region
  `disabled={!canEdit}` guards.

## Management/analysis as secondary, one click

- `항목 관리 · N개` toggle button (`aria-expanded`, `aria-controls="management-panel"`,
  stable ids, 44px) collapses the canonical fixed-cost table via the `hidden`
  attribute — the table is never unmounted, so drafts, row state, and focus
  ownership survive toggling. Default: open while the ledger is empty (onboarding
  CTA `기록할 항목 추가`), quiet when populated. Scope switches/snapshot loads
  (`applyBudgetSnapshot`, `saveBeforeSwitch`, boot load) reset the view default
  without touching data.
- `revealItem` (used by row reveal, 갱신 검토, duplicates, imports' focus paths)
  sets open + clears filters + focus request in one state batch, so focus only
  ever lands on a connected, visible field; `focusIntent.flush` still refuses
  hidden/inert/disabled targets.
- Product tour steps 0/1 auto-expand the panel only while active
  (`tourNeedsManagementOpen`), never steps 2/3 and never a focus loop.
- The live fixed-cost detail disclosure behavior (9 desktop / 3 mobile exposed
  fields), name draft autosave, DataModal compactness, CoachingPreferencesPanel
  (own-private, works for viewers), AI 코칭 availability, sample banner, empty
  device load CTA, and worker prep/consent UI are unchanged.

## Verification (this phase)

- `pnpm --filter @living-cost-manager/web test`: 720 passed | 1 skipped
  (baseline 705 + 1 skipped; +15 behavior tests across `livingBudgetHome`,
  `quietHome`, `upcomingDues`, `budgetUsability`, `focusIntent`, `productTour`;
  `coachingControls` updated to the canonical-source contract).
- `packages/shared`: 197 passed (source unchanged).
- `tsc --noEmit --incremental false` clean.
- `NEXT_PUBLIC_API_BASE_URL=https://api.gamja.top/living-cost-manager/v1 pnpm build`
  static chunks reference only the prefixed base; coach worker artifact remains
  `_coachWorker.fb0b9fa40a4470a7.js` (no SDK/param change).
- Not covered here (deferred to the separate reviewer/tester pass): real Chrome
  viewport/hierarchy checks at 390/768/1280/1440 and touch-target audit — unit
  tests do not prove WCAG conformance.
