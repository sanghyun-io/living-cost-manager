import { buildBudgetSummary, getMonthlyEquivalentAmount } from "../lib/budget";
import { formatWon } from "../lib/formatting";

type BudgetSummary = ReturnType<typeof buildBudgetSummary>;

interface MetricGridProps {
  summary: BudgetSummary;
  fixedCostCount: number;
}

export function MetricGrid({ summary, fixedCostCount }: MetricGridProps) {
  return (
    <section className="metric-grid" aria-label="핵심 지표">
      <article>
        <span>월 환산 고정비</span>
        <strong>{formatWon(summary.monthlyExpense)}</strong>
        <small>연 환산 {formatWon(summary.annualExpense)}</small>
      </article>
      <article>
        <span>남는 금액</span>
        <strong className={summary.remainingIncome < 0 ? "danger-text" : undefined}>
          {formatWon(summary.remainingIncome)}
        </strong>
        <small>{summary.remainingIncome < 0 ? "수입보다 고정비가 큽니다" : "고정비 차감 후"}</small>
      </article>
      <article>
        <span>등록 항목</span>
        <strong>{fixedCostCount}개</strong>
      </article>
      <article>
        <span>가장 큰 항목</span>
        <strong>{summary.highestCost?.name ?? "없음"}</strong>
        <small>{summary.highestCost ? "월 환산 " + formatWon(getMonthlyEquivalentAmount(summary.highestCost)) : "항목을 추가하세요"}</small>
      </article>
      <article>
        <span>평균 고정비</span>
        <strong>{formatWon(summary.averageExpense)}</strong>
      </article>
    </section>
  );
}
