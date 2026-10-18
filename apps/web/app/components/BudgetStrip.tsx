import { NumberInput, Text } from '@mantine/core';
import type { HomePlanSummary } from '../lib/homePlan';
import { formatWon } from '../lib/formatting';

interface BudgetStripProps {
  plan: HomePlanSummary;
  canEdit: boolean;
  onIncomeChange: (value: number) => void;
}

/** 첫 화면 1차: 이번 달 계획. 금액은 page 가 1회 계산한 plan 에서만 읽는다
 * (중복 계산·복사 표시 금지). 30일 예정 청구 합계와 납부 목록의 정본은
 * UpcomingDues 에 있다. */
export function BudgetStrip({ plan, canEdit, onIncomeChange }: BudgetStripProps) {
  const negative = plan.planAmount !== null && plan.planAmount < 0;
  return (
    <section className="budget-strip" aria-label="이번 달 계획">
      <div className="budget-strip-primary">
        <h1>이번 달 계획</h1>
        <Text size="sm" c="dimmed">월 환산 고정비 · 비교용</Text>
        <Text className="budget-strip-amount tnum">{formatWon(plan.monthlyExpense)}</Text>
      </div>
      <div>
        <Text size="sm" c="dimmed">고정비 제외 계획금액</Text>
        <Text className="budget-strip-value tnum" c={negative ? 'rose' : undefined}>
          {plan.planAmount !== null ? formatWon(plan.planAmount) : `월수입 ${formatWon(plan.monthlyIncome)} 기준`}
        </Text>
        <Text size="xs" c="dimmed">변동지출·실제잔액 미반영</Text>
      </div>
      <NumberInput label="월수입" id="monthly-income" min={0} thousandSeparator="," allowDecimal={false}
        allowNegative={false} hideControls inputMode="numeric" enterKeyHint="done"
        value={plan.monthlyIncome} disabled={!canEdit}
        onChange={value => onIncomeChange(typeof value === 'number' ? value : 0)} />
    </section>
  );
}
