import type { ReactNode } from "react";
import { Text } from "@mantine/core";
import { buildBudgetSummary, getMonthlyEquivalentAmount } from "../lib/budget";
import { formatWon } from "../lib/formatting";

type BudgetSummary = ReturnType<typeof buildBudgetSummary>;

interface MetricGridProps {
  summary: BudgetSummary;
  fixedCostCount: number;
}

// One cell of the KPI health strip. The strip card look comes from the
// .metric-grid CSS; cells are plain divs to avoid Mantine Card padding fights.
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
      <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: "0.04em" }}>
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
    <section className="metric-grid" aria-label="핵심 지표">
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
      <MetricCell label="등록 항목" value={`${fixedCostCount}개`} />
      <MetricCell
        label="가장 큰 항목"
        value={summary.highestCost?.name ?? "없음"}
        numeric={false}
        hint={
          summary.highestCost
            ? "월 환산 " + formatWon(getMonthlyEquivalentAmount(summary.highestCost))
            : "항목을 추가하세요"
        }
      />
      <MetricCell label="평균 고정비" value={formatWon(summary.averageExpense)} />
    </section>
  );
}
