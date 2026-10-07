import { Text } from '@mantine/core';
import type { WorkspaceAggregateTotals } from '@living-cost-manager/shared';
const won = (value: number) => Math.round(value).toLocaleString('ko-KR') + '원';
export function LedgerSummary({ summary, fromDate, untilDateExclusive, aggregate = false }: { summary: WorkspaceAggregateTotals; fromDate: string; untilDateExclusive: string; aggregate?: boolean }) {
  return <section className="ledger-summary" aria-label={aggregate ? '선택 장부 합산 결과' : '장부 비용 요약'}>
    <h2>{aggregate ? '선택 장부 합산 · 읽기 전용' : '장부 비용 요약'}</h2>
    <dl><dt>월 환산 고정비</dt><dd>{won(summary.monthlyNormalizedExpense)}</dd><dt>다음 30일 예정 청구액 · 결제 완료액 아님</dt><dd>{summary.thirtyDayDue === null ? '일정 미확인' : won(summary.thirtyDayDue)}</dd></dl>
    <Text size="sm">{fromDate}부터 {untilDateExclusive} 전까지 · 한국 시간 기준</Text>
    <Text size="sm">항목 {summary.fixedCostCount}개 · 일정 확인 {summary.knownScheduleCount}개 · 일정 미확인 {summary.unknownScheduleCount}개{summary.unknownScheduleCount ? ' (미확인 청구는 예정액에서 제외)' : ''}</Text>
    {aggregate ? <Text size="sm">장부 간 같은 실제 지출도 각각 합산됩니다. 이름·금액이 같아도 중복 제거하지 않습니다. 수입·잔액·절감률은 합산하지 않습니다. 서버에 저장된 데이터 기준이며 미동기화 편집은 포함되지 않습니다.</Text> : null}
  </section>;
}
