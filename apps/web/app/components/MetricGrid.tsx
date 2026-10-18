import { Text } from "@mantine/core";
import { buildBudgetSummary, getMonthlyEquivalentAmount } from "../lib/budget";
import { formatWon } from "../lib/formatting";

type BudgetSummary = ReturnType<typeof buildBudgetSummary>;

interface MetricGridProps {
  summary: BudgetSummary;
  fixedCostCount: number;
}

/** 분석(2차) 전용: 첫 화면(BudgetStrip/UpcomingDues)이 이미 1회 표시하는
 * '월 환산 고정비'·계획금액·30일 청구 합계를 다시 렌더하지 않는다.
 * 여기서는 구성 사실(항목 수·최대·평균·연 환산 추정)만 다룬다. */
export function MetricGrid({ summary, fixedCostCount }: MetricGridProps) {
  return (
    <section className="budget-overview" aria-label="고정비 구성">
      <Text component="h2" fw={600} size="sm" mb="md">고정비 구성</Text>
      <dl className="budget-facts">
        <div><dt>등록 항목</dt><dd className="tnum">{fixedCostCount}개</dd></div>
        <div><dt>가장 큰 항목</dt><dd>{summary.highestCost ? `${summary.highestCost.name} · 월 환산 ${formatWon(getMonthlyEquivalentAmount(summary.highestCost))}` : "없음"}</dd></div>
        <div><dt>평균 고정비</dt><dd className="tnum">{formatWon(summary.averageExpense)}</dd></div>
        <div><dt>연 환산 (월 환산 × 12)</dt><dd className="tnum">{formatWon(summary.annualExpense)} · 추정</dd></div>
      </dl>
    </section>
  );
}
