import { useEffect, useState } from "react";
import { Badge, Text, Title } from "@mantine/core";
import {
  buildSavingsInsights,
  getUpcomingDues,
  type SavingsInsight,
  type SnapshotHistoryEntry,
  type UpcomingDue
} from "@living-cost-manager/shared";
import type { FixedCost } from "../lib/budget";
import { formatWon } from "../lib/formatting";

interface InsightsPanelProps {
  fixedCosts: FixedCost[];
  // 서버 세션이 있을 때만 전달되는 동기화 히스토리(최신순). 없으면 추세 숨김.
  history?: SnapshotHistoryEntry[];
}

const UPCOMING_WINDOW_DAYS = 14;
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

export function InsightsPanel({ fixedCosts, history }: InsightsPanelProps) {
  // 날짜 의존 계산은 마운트 후에만 수행한다(정적 export 의 SSR/CSR hydration
  // 불일치 방지 — 서버와 클라이언트의 "오늘"이 다를 수 있음).
  const [upcoming, setUpcoming] = useState<UpcomingDue<FixedCost>[] | null>(null);
  const [insights, setInsights] = useState<SavingsInsight<FixedCost>[]>([]);

  useEffect(() => {
    const now = new Date();
    setUpcoming(getUpcomingDues(fixedCosts, now, UPCOMING_WINDOW_DAYS).slice(0, UPCOMING_MAX));
    setInsights(buildSavingsInsights(fixedCosts));
  }, [fixedCosts]);

  // 마운트 전(SSR/첫 페인트)에는 렌더하지 않는다.
  if (upcoming === null) {
    return null;
  }

  const trend = (history ?? []).slice(0, TREND_MAX);

  // 보여줄 내용이 전혀 없으면 패널 자체를 숨긴다.
  if (upcoming.length === 0 && insights.length === 0 && trend.length === 0) {
    return null;
  }

  return (
    <section className="insights-panel" aria-label="예측 및 절감 인사이트">
      {upcoming.length > 0 ? (
        <div className="insights-block">
          <Text className="section-label">다가오는 납부</Text>
          <Title order={3} mb="sm">{UPCOMING_WINDOW_DAYS}일 이내 예정</Title>
          <ul className="insights-list">
            {upcoming.map(({ item, daysUntil }) => {
              const label = dueLabel(daysUntil);
              return (
                <li key={item.id} className="insights-row">
                  <span className="insights-row-name">{item.name}</span>
                  <Badge color={label.urgent ? "red" : "blue"} variant="light" size="sm">
                    {label.text}
                  </Badge>
                  <span className="insights-row-amount">{formatWon(item.amount)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {insights.length > 0 ? (
        <div className="insights-block">
          <Text className="section-label">절감 인사이트</Text>
          <Title order={3} mb="sm">아낄 수 있는 곳</Title>
          <ul className="insights-list">
            {insights.map((insight, idx) => (
              <li key={`${insight.kind}-${idx}`} className="insights-row insights-row-insight">
                <span className="insights-row-name">{insight.title}</span>
                <Badge color={insight.kind === "duplicate" ? "orange" : "teal"} variant="light" size="sm">
                  월 -{formatWon(insight.monthlySavings)}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {trend.length > 0 ? (
        <div className="insights-block">
          <Text className="section-label">동기화 추세</Text>
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
    </section>
  );
}
