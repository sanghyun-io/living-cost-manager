import type { ReactNode } from "react";
import { Card, Text } from "@mantine/core";
import { buildBudgetSummary, getMonthlyEquivalentAmount } from "../lib/budget";
import { formatWon } from "../lib/formatting";

type BudgetSummary = ReturnType<typeof buildBudgetSummary>;

interface MetricGridProps {
  summary: BudgetSummary;
  fixedCostCount: number;
}

function MetricCard({
  label,
  value,
  hint,
  danger
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  danger?: boolean;
}) {
  return (
    <Card withBorder padding="md" radius="sm">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text fw={700} size="lg" c={danger ? "rose" : undefined}>
        {value}
      </Text>
      {hint ? (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      ) : null}
    </Card>
  );
}

export function MetricGrid({ summary, fixedCostCount }: MetricGridProps) {
  return (
    <section className="metric-grid" aria-label="핵심 지표">
      <MetricCard label="월 환산 고정비" value={formatWon(summary.monthlyExpense)} hint={`연 환산 ${formatWon(summary.annualExpense)}`} />
      <MetricCard
        label="남는 금액"
        value={formatWon(summary.remainingIncome)}
        hint={summary.remainingIncome < 0 ? "수입보다 고정비가 큽니다" : "고정비 차감 후"}
        danger={summary.remainingIncome < 0}
      />
      <MetricCard label="등록 항목" value={`${fixedCostCount}개`} />
      <MetricCard
        label="가장 큰 항목"
        value={summary.highestCost?.name ?? "없음"}
        hint={summary.highestCost ? "월 환산 " + formatWon(getMonthlyEquivalentAmount(summary.highestCost)) : "항목을 추가하세요"}
      />
      <MetricCard label="평균 고정비" value={formatWon(summary.averageExpense)} />
    </section>
  );
}
