import { useMemo, useState } from "react";
import { Button, Text } from "@mantine/core";
import { getUpcomingDues } from "@living-cost-manager/shared";
import type { FixedCost } from "../lib/budget";
import { buildHomePlan, type HomePlanSummary } from "../lib/homePlan";
import { formatWon } from "../lib/formatting";
import { buildPaydayTimeline } from "../lib/paydayTimeline";
import { formatCivilDateShort } from "../lib/planningTime";

interface UpcomingDuesProps {
  fixedCosts: FixedCost[];
  asOf?: Date;
  /** page 가 1회 계산한 정본 요약. 미전달 시 동일 헬퍼로 계산해 수치가 갈라지지 않는다. */
  plan?: HomePlanSummary;
  /** 항목 관리(접힌 섹션 포함)를 먼저 펼친 뒤 해당 행의 이름 입력으로 포커스한다. */
  onRevealItem?: (id: string) => void;
  /** 계획의 급여일(1..31). 있으면 기존 목록을 급여 전후로 나눠 표시(새 패널 아님). */
  paydayDay?: number | null;
}

const UPCOMING_MAX_DEFAULT = 3;
const UPCOMING_WINDOW_DAYS = 29;

function dueLabel(daysUntil: number): { text: string; urgent: boolean } {
  if (daysUntil <= 0) return { text: "오늘", urgent: true };
  if (daysUntil === 1) return { text: "내일", urgent: true };
  if (daysUntil <= 3) return { text: `${daysUntil}일 후`, urgent: true };
  return { text: `${daysUntil}일 후`, urgent: false };
}

function formatDueDate(dueDate: Date): string {
  return `${dueDate.getMonth() + 1}/${dueDate.getDate()}`;
}

/** 첫 화면의 유일한 납부 예정 정본: 30일 예정 합계(확인된 일정만) + 일정 미확인
 * 건수 + 가까운 납부 전체 목록(전체 보기 포함). InsightsPanel/MetricGrid 는
 * 이 수식을 복제하지 않는다. */
export function UpcomingDues({ fixedCosts, asOf, plan, onRevealItem, paydayDay = null }: UpcomingDuesProps) {
  const overview = useMemo(
    () => plan ?? buildHomePlan(fixedCosts, 0, asOf ?? new Date()),
    [plan, fixedCosts, asOf]
  );
  const upcoming = useMemo(() => {
    const [year, month, day] = overview.window.fromDate.split("-").map(Number);
    return getUpcomingDues(fixedCosts, new Date(year, month - 1, day), UPCOMING_WINDOW_DAYS);
  }, [fixedCosts, overview]);
  // 급여일 계획이 있을 때만: 기존 목록 위에 급여 전후 분할 요약(발생 전체 열거 기준).
  const timeline = useMemo(
    () => (paydayDay === null || paydayDay < 1 || paydayDay > 31
      ? null
      : buildPaydayTimeline(fixedCosts, overview.window.fromDate, overview.window.untilDateExclusive, paydayDay)),
    [fixedCosts, overview, paydayDay]
  );

  const [showAll, setShowAll] = useState(false);
  const displayed = showAll ? upcoming : upcoming.slice(0, UPCOMING_MAX_DEFAULT);
  const hasMore = upcoming.length > UPCOMING_MAX_DEFAULT;

  if (upcoming.length === 0 && fixedCosts.length === 0) {
    return null;
  }

  return (
    <section className="quiet-upcoming" aria-label="다음 납부 예정">
      <div className="quiet-upcoming-header">
        <Text fw={600} size="sm">다음 30일 예정 청구</Text>
        <Text className="quiet-upcoming-total tnum">
          {overview.thirtyDayDue === null ? "일정 미확인" : formatWon(overview.thirtyDayDue)}
        </Text>
      </div>
      {overview.thirtyDayDue !== null && overview.dueOccurrenceCount > 0 ? (
        <Text size="xs" c="dimmed">확인된 일정 {overview.dueOccurrenceCount}회 청구</Text>
      ) : null}
      {overview.unknownScheduleCount > 0 ? (
        <Text size="xs" c="dimmed" py="xs">일정 미확인 {overview.unknownScheduleCount}개</Text>
      ) : null}
      <details className="forecast-help">
        <summary>
          {overview.unknownScheduleCount > 0 ? `일정 미확인 ${overview.unknownScheduleCount}건` : "예정액 기준"}
        </summary>
        <Text size="xs">
          결제 완료액이 아닙니다. 한국 시간 {overview.window.fromDate}부터 {overview.window.untilDateExclusive} 전까지의
          확인된 일정만 합산합니다. 일정 미확인 항목은 제외됩니다. 월 환산액은 비교용입니다.
        </Text>
      </details>

      {timeline ? (
        <div className="payday-groups" role="group" aria-label="급여 주기별 예정 청구">
          <Text size="xs" c="dimmed">
            급여 주기 분할 · 확인된 일정만({timeline.paydayDate ? `다음 급여일 ${formatCivilDateShort(timeline.paydayDate)}` : "표시 범위 내 급여일 없음"})
          </Text>
          <div className="payday-group">
            <Text size="xs" fw={600}>급여 전</Text>
            <Text size="xs" c="dimmed">{formatCivilDateShort(timeline.window.from)}~{timeline.paydayDate ? formatCivilDateShort(timeline.paydayDate) : formatCivilDateShort(timeline.window.untilExclusive)}</Text>
            <Text size="sm" className="tnum" fw={600}>
              {timeline.before.total === null
                ? (timeline.before.occurrenceCount === 0 && timeline.unknownCount > 0 ? "확인 일정 없음(미확인 별도)" : "₩0")
                : formatWon(timeline.before.total)}
            </Text>
            <Text size="xs" c="dimmed">{timeline.before.occurrenceCount}회 청구</Text>
          </div>
          {timeline.after.occurrenceCount > 0 ? (
            <div className="payday-group">
              <Text size="xs" fw={600}>급여 후</Text>
              <Text size="xs" c="dimmed">{timeline.paydayDate ? formatCivilDateShort(timeline.paydayDate) : "—"}~{formatCivilDateShort(timeline.window.untilExclusive)}</Text>
              <Text size="sm" className="tnum" fw={600}>
                {timeline.after.total === null ? "확인 일정 없음" : formatWon(timeline.after.total)}
              </Text>
              <Text size="xs" c="dimmed">{timeline.after.occurrenceCount}회 청구</Text>
            </div>
          ) : null}
          {timeline.unknownCount > 0 ? <Text size="xs" c="dimmed">일정 미확인 {timeline.unknownCount}개는 위 합계에 포함되지 않았습니다.</Text> : null}
          <Text size="xs" c="dimmed">급여일까지 버틸 수 있는지의 답이 아니라, 확인된 납부의 기간 분할입니다. 실제 입금 보장·잔액 예측이 아닙니다.</Text>
        </div>
      ) : null}

      {upcoming.length === 0 && overview.unknownScheduleCount === 0 ? (
        <Text size="xs" c="dimmed" py="sm">
          30일 이내 납부 예정이 없습니다
        </Text>
      ) : upcoming.length > 0 ? (
        <>
          <ul className="quiet-upcoming-list">
            {displayed.map(({ item, dueDate, daysUntil }) => {
              const label = dueLabel(daysUntil);
              return (
                <li key={item.id} className="quiet-upcoming-item">
                  <Text size="sm" className="quiet-upcoming-name" truncate>{item.name}</Text>
                  <Text size="xs" c={label.urgent ? "rose" : "dimmed"} fw={label.urgent ? 600 : 400}>
                    {label.text}{label.urgent ? "" : ` · ${formatDueDate(dueDate)}`}
                  </Text>
                  <Text size="sm" fw={600} className="tnum">
                    {formatWon(item.amount)}
                  </Text>
                  {onRevealItem ? (
                    <Button
                      variant="subtle"
                      size="compact-xs"
                      className="quiet-upcoming-reveal"
                      onClick={() => onRevealItem(item.id)}
                      aria-label={`${item.name} 항목 관리에서 보기`}
                    >
                      보기
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {hasMore && (
            <div className="quiet-upcoming-footer">
              <Button
                variant="subtle"
                size="compact-xs"
                aria-expanded={showAll}
                onClick={() => setShowAll(!showAll)}
              >
                {showAll ? "접기" : `전체 보기 (${upcoming.length}건)`}
              </Button>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
