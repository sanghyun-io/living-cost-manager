import { NumberInput, Text } from '@mantine/core';
import { kstThirtyDayWindow, summarizeWorkspaceBudget } from '@living-cost-manager/shared';
import type { FixedCost } from '../lib/budget';
import { formatWon } from '../lib/formatting';

interface BudgetStripProps {
  monthlyIncome: number;
  monthlyExpense: number;
  fixedCosts: FixedCost[];
  asOf: Date;
  canEdit: boolean;
  onIncomeChange: (value: number) => void;
}

export function BudgetStrip({ monthlyIncome, monthlyExpense, fixedCosts, asOf, canEdit, onIncomeChange }: BudgetStripProps) {
  const forecast = summarizeWorkspaceBudget(monthlyIncome, fixedCosts, asOf);
  const window = kstThirtyDayWindow(asOf);
  return (
    <section className="budget-strip" aria-label="고정비 요약">
      <div className="budget-strip-primary">
        <h1>고정비</h1>
        <Text size="sm" c="dimmed">월 환산 고정비</Text>
        <Text className="budget-strip-amount tnum">{formatWon(monthlyExpense)}</Text>
      </div>
      <div>
        <Text size="sm" c="dimmed">고정비 제외 잔액</Text>
        <Text className="budget-strip-value tnum" c={monthlyIncome > 0 && monthlyIncome < monthlyExpense ? 'rose' : undefined}>
          {monthlyIncome > 0 ? formatWon(monthlyIncome - monthlyExpense) : '수입 미입력'}
        </Text>
      </div>
      <NumberInput label="월 수입" id="monthly-income" min={0} thousandSeparator="," allowDecimal={false}
        allowNegative={false} hideControls value={monthlyIncome} disabled={!canEdit}
        onChange={value => onIncomeChange(typeof value === 'number' ? value : 0)} />
      <div className="budget-strip-forecast">
        <Text size="sm" c="dimmed">다음 30일 예정 청구</Text>
        <Text className="budget-strip-value tnum">{forecast.thirtyDayDue === null ? '일정 미확인' : formatWon(forecast.thirtyDayDue)}</Text>
        <details className="forecast-help">
          <summary>{forecast.unknownScheduleCount > 0 ? `일정 미확인 ${forecast.unknownScheduleCount}건` : '예정액 기준'}</summary>
          <Text size="xs">결제 완료액이 아닙니다. 한국 시간 {window.fromDate}부터 {window.untilDateExclusive} 전까지의 확인된 일정만 합산합니다. 일정 미확인 항목은 제외됩니다. 월 환산액은 비교용입니다.</Text>
        </details>
      </div>
    </section>
  );
}
