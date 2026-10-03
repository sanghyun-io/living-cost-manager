import { useEffect, useState } from "react";
import { Button, Text, Title } from "@mantine/core";
import {
  buildMonthlyReport,
  buildSavingsInsights,
  buildShareSummary,
  getUpcomingDues,
  buildThirtyDayDueSummary,
  summarizeRenewalSavings,
  type SavingsInsight,
  type SnapshotHistoryEntry,
  type UpcomingDue
} from "@living-cost-manager/shared";
import type { FixedCost } from "../lib/budget";
import { formatWon } from "../lib/formatting";

interface InsightsPanelProps {
  fixedCosts: FixedCost[];
  history?: SnapshotHistoryEntry[];
  // 공유 요약용. 대시보드 summary 에서 전달.
  monthlyIncome: number;
  monthlyExpense: number;
  topCategoryLabel?: string;
  topCategoryAmount?: number;
}

const UPCOMING_WINDOW_DAYS = 29;
const UPCOMING_MAX = 5;
const TREND_MAX = 6;

function dueLabel(daysUntil: number): { text: string; urgent: boolean } {
  if (daysUntil <= 0) {
    return { text: "오늘", urgent: true };
  }
  if (daysUntil === 1) {
    return { text: "내일", urgent: true };
  }
  return { text: `${daysUntil}일 후`, urgent: daysUntil <= 3 };
}

function formatTrendDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function InsightsPanel({
  fixedCosts,
  history,
  monthlyIncome,
  monthlyExpense,
  topCategoryLabel,
  topCategoryAmount
}: InsightsPanelProps) {
  const [upcoming, setUpcoming] = useState<UpcomingDue<FixedCost>[] | null>(null);
  const [insights, setInsights] = useState<SavingsInsight<FixedCost>[]>([]);
  const [shareStatus, setShareStatus] = useState<string>("");

  useEffect(() => {
    const now = new Date();
    setUpcoming(getUpcomingDues(fixedCosts, now, UPCOMING_WINDOW_DAYS).slice(0, UPCOMING_MAX));
    setInsights(buildSavingsInsights(fixedCosts));
  }, [fixedCosts]);

  if (upcoming === null) {
    return null;
  }

  const trend = (history ?? []).slice(0, TREND_MAX);
  const monthlyReport = (history ?? []).length > 0 ? buildMonthlyReport(history ?? []) : null;
  const canShare = monthlyExpense > 0;
  const dueSummary = buildThirtyDayDueSummary(fixedCosts, new Date());
  const savings = summarizeRenewalSavings(fixedCosts);

  if (
    upcoming.length === 0 &&
    insights.length === 0 &&
    trend.length === 0 &&
    !monthlyReport &&
    !canShare &&
    fixedCosts.length === 0
  ) {
    return null;
  }

  async function handleShare() {
    const text = buildShareSummary({
      monthlyIncome,
      monthlyExpense,
      topCategoryLabel,
      topCategoryAmount
    });
    // Web Share API 우선, 미지원 시 클립보드 폴백.
    try {
      if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
        await navigator.share({ text });
        setShareStatus("");
        return;
      }
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setShareStatus("요약을 클립보드에 복사했어요.");
        return;
      }
      setShareStatus("이 브라우저에서는 공유를 지원하지 않아요.");
    } catch {
      // 사용자가 공유 시트를 취소한 경우 등 — 조용히 무시.
      setShareStatus("");
    }
  }

  return (
    <section className="insights-panel" aria-label="예측 및 절감 인사이트">
      <div className="insights-block">
        <Title order={2} size="h4">앞으로 30일 실제 납부 예정</Title>
        <Text fw={700} size="xl" className="tnum">{formatWon(dueSummary.total)} · {dueSummary.dues.length}회</Text>
        <Text size="sm">등록한 일정 기준 예상 청구액입니다. 월 환산 비용은 {formatWon(dueSummary.monthlyNormalized)}입니다.</Text>
        {dueSummary.unknownCount > 0 ? <Text size="sm" c="dimmed">일정 미확인 {dueSummary.unknownCount}건은 합계와 알림에서 제외됩니다. 기준 납부일과 정수 개월 주기를 입력하세요.</Text> : null}
        <a className="guide-link" href="#fixed-costs">납부일·갱신 계획 수정</a>
      </div>
      {upcoming.length > 0 ? (
        <div className="insights-block">
          <Title order={3} size="h5" mb="sm">가까운 납부 · 최대 5건</Title>
          <ul className="insights-list">
            {upcoming.map(({ item, daysUntil }) => {
              const label = dueLabel(daysUntil);
              return (
                <li key={item.id} className="insights-row">
                  <span className="insights-row-name">{item.name}</span>
                  <Text span size="sm" fw={label.urgent ? 700 : 400} c={label.urgent ? "rose" : "dimmed"}>
                    {label.text}
                  </Text>
                  <span className="insights-row-amount">{formatWon(item.amount)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <details className="insights-details">
        <summary>절감 검토와 고정비 요약</summary>
        <Text size="sm" mt="sm">예상 월 절감 {formatWon(savings.potential)} · 완료 후 직접 확인한 월 절감 {formatWon(savings.confirmed)}</Text>
      {insights.length > 0 ? (
        <div className="insights-block">
          <Title order={3} mb="sm">아낄 수 있는 곳</Title>
          <ul className="insights-list">
            {insights.map((insight, idx) => (
              <li key={`${insight.kind}-${idx}`} className="insights-row insights-row-insight">
                <span className="insights-row-name">{insight.title}</span>
                <Text span size="sm" c="dimmed">예상 월 절감 {formatWon(insight.monthlySavings)}</Text>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {monthlyReport ? (
        <div className="insights-block">
          <Title order={3} mb="sm">이번 달 요약</Title>
          <Text size="sm" className="insights-report-headline">{monthlyReport.headline}</Text>
        </div>
      ) : null}

      {trend.length > 0 ? (
        <div className="insights-block">
          <Title order={3} mb="sm">최근 월 고정비 변화</Title>
          <ul className="insights-list">
            {trend.map((entry) => (
              <li key={entry.id} className="insights-row">
                <span className="insights-row-name">{formatTrendDate(entry.createdAt)}</span>
                <span className="insights-row-amount">{formatWon(entry.fixedCostMonthlyTotal)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canShare ? (
        <div className="insights-block">
          <Title order={3} mb="sm">요약 카드 공유</Title>
          <Text size="sm" c="dimmed" mb="sm">
            월 고정비 합계를 공유합니다. 수입과 수입 대비 비율은 포함하지 않습니다.
          </Text>
          <Button variant="default" size="sm" onClick={handleShare}>
            고정비 요약 공유하기
          </Button>
          {shareStatus ? (
            <Text size="xs" c="dimmed" mt="xs">{shareStatus}</Text>
          ) : null}
        </div>
      ) : null}
      </details>
    </section>
  );
}
