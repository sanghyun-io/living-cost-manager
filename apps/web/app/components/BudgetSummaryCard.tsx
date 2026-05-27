import { Card, Text } from "@mantine/core";
import { formatWon } from "../lib/formatting";
import type { BudgetSnapshotSummary } from "../lib/syncStatus";

interface BudgetSummaryCardProps {
  title: string;
  summary: BudgetSnapshotSummary;
}

export function BudgetSummaryCard({ title, summary }: BudgetSummaryCardProps) {
  return (
    <Card withBorder padding="sm" radius="sm">
      <Text size="sm" c="dimmed">
        {title}
      </Text>
      <Text fw={700}>{formatWon(summary.monthlyExpense)}</Text>
      <Text size="xs" c="dimmed">
        월 수입 {formatWon(summary.monthlyIncome)} · 항목 {summary.fixedCostCount}개 · 카테고리 {summary.categoryCount}개 · 카드 {summary.cardCount}개
      </Text>
    </Card>
  );
}
