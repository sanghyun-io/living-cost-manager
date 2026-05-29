// 월간 리포트 — 동기화 히스토리에서 전월 대비 추세를 규칙 기반으로 요약한다.
// LLM 없이 결정적으로 계산하는 순수 함수(외부 의존 0). LLM 코치는 별도(opt-in).
import type { SnapshotHistoryEntry } from "./snapshot.js";

/** "YYYY-MM" 월 키로 변환 (ISO createdAt 기준). */
function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

export type MonthlyPoint = {
  month: string; // YYYY-MM
  fixedCostMonthlyTotal: number;
  fixedCostCount: number;
  monthlyIncome: number;
};

export type MonthlyReport = {
  /** 가장 최근 달의 집계. 데이터가 없으면 null. */
  current: MonthlyPoint | null;
  /** 직전 달 집계(있을 때만). */
  previous: MonthlyPoint | null;
  /** 전월 대비 고정비 증감액(current - previous). previous 없으면 null. */
  deltaAmount: number | null;
  /** 전월 대비 증감률(%). 소수 1자리 반올림. previous 없거나 0이면 null. */
  deltaPercent: number | null;
  /** 사람이 읽는 한 줄 요약(한국어). */
  headline: string;
};

/**
 * 월별로 그룹화해 각 달의 "마지막 동기화"를 그 달의 대표값으로 삼는다
 * (월말 시점 상태에 가장 가깝다). 그 뒤 최근 달과 직전 달을 비교한다.
 */
export function buildMonthlyReport(entries: SnapshotHistoryEntry[]): MonthlyReport {
  // 월별 마지막 엔트리 집계. 정렬을 신뢰하지 않고 createdAt 으로 판단.
  const byMonth = new Map<string, SnapshotHistoryEntry>();
  for (const entry of entries) {
    const key = monthKey(entry.createdAt);
    const existing = byMonth.get(key);
    if (!existing || entry.createdAt > existing.createdAt) {
      byMonth.set(key, entry);
    }
  }

  const points: MonthlyPoint[] = [...byMonth.values()]
    .map((e) => ({
      month: monthKey(e.createdAt),
      fixedCostMonthlyTotal: e.fixedCostMonthlyTotal,
      fixedCostCount: e.fixedCostCount,
      monthlyIncome: e.monthlyIncome
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const current = points.length > 0 ? points[points.length - 1] : null;
  const previous = points.length > 1 ? points[points.length - 2] : null;

  if (!current) {
    return {
      current: null,
      previous: null,
      deltaAmount: null,
      deltaPercent: null,
      headline: "아직 리포트를 만들 데이터가 없어요. 동기화를 시작해 보세요."
    };
  }

  if (!previous) {
    return {
      current,
      previous: null,
      deltaAmount: null,
      deltaPercent: null,
      headline: `${current.month} 고정비는 월 ${current.fixedCostMonthlyTotal.toLocaleString("ko-KR")}원입니다. 다음 달부터 변화를 비교해 드릴게요.`
    };
  }

  const deltaAmount = current.fixedCostMonthlyTotal - previous.fixedCostMonthlyTotal;
  const deltaPercent =
    previous.fixedCostMonthlyTotal > 0
      ? Math.round((deltaAmount / previous.fixedCostMonthlyTotal) * 1000) / 10
      : null;

  let headline: string;
  if (deltaAmount === 0) {
    headline = `${current.month} 고정비는 지난달과 같아요 (월 ${current.fixedCostMonthlyTotal.toLocaleString("ko-KR")}원).`;
  } else {
    const dir = deltaAmount > 0 ? "늘었어요" : "줄었어요";
    const absAmount = Math.abs(deltaAmount).toLocaleString("ko-KR");
    const pctText = deltaPercent !== null ? ` (${deltaPercent > 0 ? "+" : ""}${deltaPercent}%)` : "";
    headline = `${current.month} 고정비가 지난달보다 ${absAmount}원 ${dir}${pctText}.`;
  }

  return { current, previous, deltaAmount, deltaPercent, headline };
}
