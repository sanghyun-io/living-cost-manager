import { useEffect, useState } from "react";
import { Button, Text } from "@mantine/core";
import { getUpcomingDues, kstThirtyDayWindow, type UpcomingDue } from "@living-cost-manager/shared";
import type { FixedCost } from "../lib/budget";
import { formatWon } from "../lib/formatting";

interface UpcomingDuesProps {
  fixedCosts: FixedCost[];
  asOf?: Date;
}

const UPCOMING_MAX_DEFAULT = 3;
const UPCOMING_WINDOW_DAYS = 29;

function dueLabel(daysUntil: number): { text: string; urgent: boolean } {
  if (daysUntil <= 0) return { text: "오늘", urgent: true };
  if (daysUntil === 1) return { text: "내일", urgent: true };
  if (daysUntil <= 3) return { text: `${daysUntil}일 후`, urgent: true };
  return { text: `${daysUntil}일 후`, urgent: false };
}

export function UpcomingDues({ fixedCosts, asOf }: UpcomingDuesProps) {
  const [upcoming, setUpcoming] = useState<UpcomingDue<FixedCost>[]>([]);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const [year, month, day] = kstThirtyDayWindow(asOf ?? new Date()).fromDate.split('-').map(Number);
    const now = new Date(year, month - 1, day);
    const dues = getUpcomingDues(fixedCosts, now, UPCOMING_WINDOW_DAYS);
    setUpcoming(dues);
  }, [fixedCosts, asOf]);

  const displayed = showAll ? upcoming : upcoming.slice(0, UPCOMING_MAX_DEFAULT);
  const hasMore = upcoming.length > UPCOMING_MAX_DEFAULT;

  if (upcoming.length === 0 && fixedCosts.length === 0) {
    return null;
  }

  return (
    <aside className="quiet-upcoming" aria-label="가까운 납부 예정">
      <div className="quiet-upcoming-header">
        <Text fw={600} size="sm">다음 납부 예정</Text>
        {upcoming.length > 0 && (
          <Text size="xs" c="dimmed">
            {upcoming.length}건
          </Text>
        )}
      </div>

      {upcoming.length === 0 ? (
        <Text size="xs" c="dimmed" py="sm">
          30일 이내 납부 예정이 없습니다
        </Text>
      ) : (
        <>
          <div className="quiet-upcoming-list">
            {displayed.map(({ item, daysUntil }) => {
              const label = dueLabel(daysUntil);
              return (
                <div key={item.id} className="quiet-upcoming-item">
                  <Text size="sm" className="quiet-upcoming-name" truncate>{item.name}</Text>
                  <Text size="xs" c={label.urgent ? "rose" : "dimmed"} fw={label.urgent ? 600 : 400}>
                    {label.text}
                  </Text>
                  <Text size="sm" fw={600} className="tnum">
                    {formatWon(item.amount)}
                  </Text>
                </div>
              );
            })}
          </div>
          
          {hasMore && (
            <div className="quiet-upcoming-footer">
              <Button 
                variant="subtle" 
                size="compact-xs" 
                onClick={() => setShowAll(!showAll)}
              >
                {showAll ? '접기' : `전체 보기 (${upcoming.length}건)`}
              </Button>
            </div>
          )}
        </>
      )}
    </aside>
  );
}
