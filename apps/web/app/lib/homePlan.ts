// 첫 화면(계획 요약 + 납부 예정)이 공유하는 유일한 파생 출처.
// BudgetStrip/UpcomingDues 가 각자 summarizeWorkspaceBudget 을 다시 호출하지
// 않도록 page 가 기준 시각(referenceInstant)으로 1회 계산해 내려준다.
import { kstThirtyDayWindow, summarizeWorkspaceBudget } from "@living-cost-manager/shared";
import type { FixedCost } from "./budget";

export type HomePlanSummary = {
  monthlyIncome: number;
  /** 월 환산 고정비(비교용·미반환 실제 청구 아님). */
  monthlyExpense: number;
  /** 고정비 제외 계획금액. 월수입이 0이면(스키마 기본값과 구별 불가) 미산출 —
   * '미입력'이라고 주장하지 않고 입력란의 표시값(0)만 진실로 보여준다. */
  planAmount: number | null;
  thirtyDayDue: number | null;
  dueOccurrenceCount: number;
  knownScheduleCount: number;
  unknownScheduleCount: number;
  fixedCostCount: number;
  window: { fromDate: string; untilDateExclusive: string };
};

export function buildHomePlan(
  fixedCosts: readonly FixedCost[],
  monthlyIncome: number,
  asOf: Date
): HomePlanSummary {
  const summary = summarizeWorkspaceBudget(monthlyIncome, fixedCosts, asOf);
  return {
    monthlyIncome,
    monthlyExpense: summary.monthlyNormalizedExpense,
    planAmount: monthlyIncome > 0 ? monthlyIncome - Math.round(summary.monthlyNormalizedExpense) : null,
    thirtyDayDue: summary.thirtyDayDue,
    dueOccurrenceCount: summary.dueOccurrenceCount,
    knownScheduleCount: summary.knownScheduleCount,
    unknownScheduleCount: summary.unknownScheduleCount,
    fixedCostCount: summary.fixedCostCount,
    window: kstThirtyDayWindow(asOf)
  };
}
