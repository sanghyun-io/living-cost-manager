import type { ReactNode } from "react";
import { Text } from "@mantine/core";
import { buildBudgetSummary, getMonthlyEquivalentAmount } from "../lib/budget";
import { formatWon } from "../lib/formatting";

type BudgetSummary = ReturnType<typeof buildBudgetSummary>;

interface MetricGridProps {
  summary: BudgetSummary;
  fixedCostCount: number;
}

// Two primary figures share a surface; secondary facts are not extra KPI cards.
function MetricCell({
  label,
  value,
  hint,
  danger,
  numeric = true
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  danger?: boolean;
  numeric?: boolean;
}) {
  return (
    <div className="metric-cell">
      <Text size="xs" fw={600} c="dimmed">
        {label}
      </Text>
      <Text
        component="div"
        className={`metric-value${numeric ? " tnum" : ""}${danger ? " is-danger" : ""}`}
      >
        {value}
      </Text>
      {hint ? (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      ) : null}
    </div>
  );
}

export function MetricGrid({ summary, fixedCostCount }: MetricGridProps) {
  return (
    <section className="budget-overview" aria-label="핵심 지표">
      <Text component="h2" fw={600} size="sm" mb="md">월 고정비 요약</Text>
      <div className="metric-grid">
      <MetricCell
        label="월 환산 고정비"
        value={formatWon(summary.monthlyExpense)}
        hint={`연 환산 ${formatWon(summary.annualExpense)}`}
      />
      <MetricCell
        label="남는 금액"
        value={formatWon(summary.remainingIncome)}
        hint={summary.remainingIncome < 0 ? "수입보다 고정비가 큽니다" : "고정비 차감 후"}
        danger={summary.remainingIncome < 0}
      />
      </div>
      <dl className="budget-facts">
        <div><dt>등록 항목</dt><dd className="tnum">{fixedCostCount}개</dd></div>
        <div><dt>가장 큰 항목</dt><dd>{summary.highestCost ? `${summary.highestCost.name} · 월 환산 ${formatWon(getMonthlyEquivalentAmount(summary.highestCost))}` : "없음"}</dd></div>
        <div><dt>평균 고정비</dt><dd className="tnum">{formatWon(summary.averageExpense)}</dd></div>
      </dl>
    </section>
  );
}
