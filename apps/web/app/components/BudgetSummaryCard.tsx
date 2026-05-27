import { formatWon } from "../lib/formatting";
import type { BudgetSnapshotSummary } from "../lib/syncStatus";

interface BudgetSummaryCardProps {
  title: string;
  summary: BudgetSnapshotSummary;
}

export function BudgetSummaryCard({ title, summary }: BudgetSummaryCardProps) {
  return (
    <div className="sync-summary-card">
      <span>{title}</span>
      <strong>{formatWon(summary.monthlyExpense)}</strong>
      <small>
        월 수입 {formatWon(summary.monthlyIncome)} · 항목 {summary.fixedCostCount}개 · 카테고리 {summary.categoryCount}개 · 카드 {summary.cardCount}개
      </small>
    </div>
  );
}
