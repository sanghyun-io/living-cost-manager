import { useMemo, useState } from "react";
import { Button, Text, Title } from "@mantine/core";
import {
  buildMonthlyReport,
  buildSavingsInsights,
  buildShareSummary,
  summarizeRenewalSavings,
  type SnapshotHistoryEntry
} from "@living-cost-manager/shared";
import type { FixedCost } from "../lib/budget";
import { formatWon } from "../lib/formatting";

interface InsightsPanelProps {
  asOf?: Date;
  fixedCosts: FixedCost[];
  history?: SnapshotHistoryEntry[];
  // 공유 요약용. 첫 화면 plan 과 같은 파생값(page 의 homePlan)에서 전달한다.
  monthlyIncome: number;
  monthlyExpense: number;
  topCategoryLabel?: string;
  topCategoryAmount?: number;
  protectedFixedCostIds?: ReadonlySet<string>;
  onKeepItem?: (id: string) => void;
  coachingPreferencesReady?: boolean;
}

const TREND_MAX = 6;
const EMPTY_PROTECTED_IDS: ReadonlySet<string> = new Set();
const PREFERENCES_UNAVAILABLE = "내 코칭 설정을 확인할 수 없어 절감 제안을 보류했습니다.";

function formatTrendDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 분석(2차) 전용 인사이트. 30일 예정 청구 합계와 가까운 납부 목록의 정본은
 * 첫 화면 UpcomingDues 에 있으므로 이곳에서 복제하지 않는다. */
export function InsightsPanel({
  fixedCosts,
  history,
  monthlyIncome,
  monthlyExpense,
  topCategoryLabel,
  topCategoryAmount
   , protectedFixedCostIds = EMPTY_PROTECTED_IDS, onKeepItem, coachingPreferencesReady = true
}: InsightsPanelProps) {
  const insights = useMemo(() => coachingPreferencesReady ? buildSavingsInsights(fixedCosts, { protectedFixedCostIds }) : [], [fixedCosts, protectedFixedCostIds, coachingPreferencesReady]);
  const [shareStatus, setShareStatus] = useState<string>("");

  const trend = (history ?? []).slice(0, TREND_MAX);
  const monthlyReport = (history ?? []).length > 0 ? buildMonthlyReport(history ?? []) : null;
  const canShare = monthlyExpense > 0;
  const savings = summarizeRenewalSavings(fixedCosts);

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
    <section className="insights-panel" aria-label="절감·리뷰 인사이트">
      {fixedCosts.length === 0 ? (
        <Text size="sm" c="dimmed">항목과 기준 납부일을 등록하면 절감 검토와 공유 요약을 볼 수 있습니다.</Text>
      ) : (
        <a className="guide-link" href="#fixed-costs">납부일·갱신 계획 수정</a>
      )}

      {!coachingPreferencesReady ? <Text role="status" size="sm">{PREFERENCES_UNAVAILABLE}</Text> : null}
      <details className="insights-details">
        <summary>절감 검토와 고정비 요약</summary>
        {coachingPreferencesReady ? <Text size="sm" mt="sm">예상 월 절감 {formatWon(savings.potential)} · 완료 후 직접 확인한 월 절감 {formatWon(savings.confirmed)}</Text> : null}
      {insights.length > 0 ? (
        <div className="insights-block">
          <Title order={3} mb="sm">아낄 수 있는 곳</Title>
          <ul className="insights-list">
            {insights.map((insight, idx) => (
              <li key={`${insight.kind}-${idx}`} className="insights-row insights-row-insight">
                <span className="insights-row-name">{insight.title}</span>
                <Text span size="sm" c="dimmed">예상 월 절감 {formatWon(insight.monthlySavings)}</Text>
                {onKeepItem ? insight.actionableItemIds.map(id => {
                  const item = fixedCosts.find(candidate => candidate.id === id);
                  return item && !protectedFixedCostIds.has(id) ? <Button key={id} variant="subtle" size="compact-xs" onClick={() => onKeepItem(id)} aria-label={`${item.name} 절감 제안 제외`}>{item.name} 절감 제안 제외</Button> : null;
                }) : null}
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
