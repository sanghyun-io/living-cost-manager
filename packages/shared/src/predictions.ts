// 납부일 예측 · 절감 시뮬레이션 · 중복 구독 탐지 — 외부 의존 없는 순수 함수.
// web(FixedCost) 과 api(FixedCostDto) 양쪽에서 쓰도록 최소 구조로 제네릭화한다.
//
// 모든 날짜 함수는 기준 시각 `from: Date` 을 인자로 받는다(내부에서 Date.now()
// 를 부르지 않음) — 테스트 가능성과 결정성을 위해서다.

import { billingDateSchema } from "./billing.js";
import type { CoachingProtectionOptions } from "./coachingPreferences.js";

/** 예측에 필요한 고정비 최소 필드. */
export type PredictableFixedCost = {
  id: string;
  name: string;
  categoryId: string;
  amount: number;
  periodMonths: number;
  billingDay: number;
  isEndOfMonth: boolean;
  billingAnchorDate?: string | null;
};

function lastDayOfMonth(year: number, monthIndex: number): number {
  // monthIndex: 0-11. 다음 달 0일 = 이번 달 마지막 날.
  return new Date(year, monthIndex + 1, 0).getDate();
}

function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

type Schedule = Pick<PredictableFixedCost, "billingDay" | "isEndOfMonth"> & Partial<Pick<PredictableFixedCost, "periodMonths" | "billingAnchorDate">>;

/** Anchor determines the recurrence month and day; end-of-month overrides day.
 * Missing anchors and non-integral month periods cannot produce a known date. */
export function computeNextDueDate(
  item: Schedule,
  from: Date
): Date | null {
  if (!billingDateSchema.safeParse(item.billingAnchorDate).success ||
      !Number.isInteger(item.periodMonths) || !item.periodMonths || item.periodMonths < 1 || item.periodMonths > 120 ||
      !Number.isFinite(from.getTime())) return null;
  const [year, month, day] = item.billingAnchorDate!.split("-").map(Number);
  const period = item.periodMonths;
  const base = dateOnly(from);
  const elapsed = (base.getFullYear() - year) * 12 + base.getMonth() - (month - 1);
  let step = Math.max(0, Math.floor(elapsed / period));
  const occurrence = (n: number) => {
    const start = new Date(year, month - 1 + n * period, 1);
    const last = lastDayOfMonth(start.getFullYear(), start.getMonth());
    start.setDate(item.isEndOfMonth ? last : Math.min(day, last));
    return start;
  };
  let due = occurrence(step);
  if (due < base) due = occurrence(++step);
  return due;
}

/** from 부터 다음 납부일까지 남은 일수(0 = 오늘). */
export function getDaysUntilDue(
  item: Schedule,
  from: Date
): number | null {
  const due = computeNextDueDate(item, from);
  if (!due) return null;
  const base = dateOnly(from);
  const ms = due.getTime() - base.getTime();
  return Math.round(ms / 86_400_000);
}

export type UpcomingDue<T extends PredictableFixedCost> = {
  item: T;
  dueDate: Date;
  daysUntil: number;
};

/**
 * 다가오는 납부 목록을 가까운 순으로 반환한다. withinDays 가 주어지면 그 안에
 * 도래하는 것만 남긴다.
 */
export function getUpcomingDues<T extends PredictableFixedCost>(
  items: T[],
  from: Date,
  withinDays?: number
): UpcomingDue<T>[] {
  const result: UpcomingDue<T>[] = items.flatMap((item) => {
    if (item.amount <= 0) return [];
    const dueDate = computeNextDueDate(item, from);
    if (!dueDate) return [];
    return [{ item, dueDate, daysUntil: getDaysUntilDue(item, from)! }];
  });
  const filtered =
    typeof withinDays === "number"
      ? result.filter((r) => r.daysUntil <= withinDays)
      : result;
  return filtered.sort((a, b) => a.daysUntil - b.daysUntil);
}

/** Actual full charges in [today, today + 30 days), including repeated occurrences. */
export function buildThirtyDayDueSummary<T extends PredictableFixedCost>(items: T[], from: Date) {
  const end = dateOnly(from);
  end.setDate(end.getDate() + 30);
  const dues: UpcomingDue<T>[] = [];
  let unknownCount = 0;
  for (const item of items) {
    if (item.amount <= 0) continue;
    let due = computeNextDueDate(item, from);
    if (!due) { unknownCount++; continue; }
    while (due < end) {
      dues.push({ item, dueDate: due, daysUntil: Math.round((due.getTime() - dateOnly(from).getTime()) / 86400000) });
      const next: Date = new Date(due);
      next.setDate(next.getDate() + 1);
      due = computeNextDueDate(item, next)!;
    }
  }
  dues.sort((a, b) => a.daysUntil - b.daysUntil);
  return { dues, total: dues.reduce((sum, due) => sum + due.item.amount, 0), unknownCount,
    monthlyNormalized: items.reduce((sum, item) => sum + monthlyEquivalent(item), 0) };
}

/** 월 환산 금액(주기로 나눈 값). periodMonths<=0 이면 0. */
export function monthlyEquivalent(
  item: Pick<PredictableFixedCost, "amount" | "periodMonths">
): number {
  if (item.periodMonths <= 0) {
    return 0;
  }
  return Math.round(item.amount / item.periodMonths);
}

export type RemovalSimulation = {
  itemId: string;
  monthlySavings: number;
  annualSavings: number;
};

/** 특정 항목을 제거했을 때의 월/연 절감액. */
export function simulateRemoval(
  items: PredictableFixedCost[],
  itemId: string
): RemovalSimulation | null {
  const target = items.find((i) => i.id === itemId);
  if (!target) {
    return null;
  }
  const monthly = monthlyEquivalent(target);
  return {
    itemId,
    monthlySavings: monthly,
    annualSavings: monthly * 12
  };
}

export type DuplicateGroup<T extends PredictableFixedCost> = {
  normalizedName: string;
  items: T[];
  /** 그룹을 모두 유지할 때 월 합계(중복 의심 비용 규모). */
  monthlyTotal: number;
};

/**
 * 이름이 사실상 같은(정규화 후 동일) 고정비를 2개 이상 묶어 중복 후보로 반환한다.
 * "넷플릭스" 가 두 번 등록된 경우 등 — 카테고리와 무관하게 이름 기준으로 본다.
 */
export function findDuplicateSubscriptions<T extends PredictableFixedCost>(
  items: T[]
): DuplicateGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = item.name.trim().toLowerCase().replace(/\s+/g, "");
    if (key.length === 0) {
      continue;
    }
    const arr = groups.get(key) ?? [];
    arr.push(item);
    groups.set(key, arr);
  }
  const result: DuplicateGroup<T>[] = [];
  for (const [normalizedName, grouped] of groups) {
    if (grouped.length >= 2) {
      const monthlyTotal = grouped.reduce((sum, i) => sum + monthlyEquivalent(i), 0);
      result.push({ normalizedName, items: grouped, monthlyTotal });
    }
  }
  // 의심 규모가 큰 순으로.
  return result.sort((a, b) => b.monthlyTotal - a.monthlyTotal);
}

export type SavingsInsight<T extends PredictableFixedCost> = {
  kind: "duplicate" | "largest";
  title: string;
  /** Hypothetical amount only; never realized savings or a ledger mutation. */
  monthlySavings: number;
  annualSavings: number;
  items: T[];
  /** Only these IDs are actionable; items retains its existing source-item semantics. */
  actionableItemIds: string[];
};

// 구조적으로 줄이기 어려운(필수·계약형) 카테고리. 월세(주거)·보험은 "구독을
// 끊으세요" 식 절감 조언이 헛다리이므로, "largest" 절감 후보에서 제외한다.
// (중복 구독 인사이트는 카테고리와 무관하게 유효하므로 그대로 둔다.)
export const HARD_TO_REDUCE_CATEGORY_IDS: ReadonlySet<string> = new Set([
  "housing",
  "insurance"
]);

export function isHardToReduceCategory(categoryId: string): boolean {
  return HARD_TO_REDUCE_CATEGORY_IDS.has(categoryId);
}

// 보험은 "무조건 줄이기 어려움"이 아니라 "과하면 점검 여지 있음"으로 다룬다.
// 공공 통계의 보험 항목이 민간 보장성보험과 정확히 매칭되지 않아(사회보험 혼재,
// 연령대별 약함) 외부 API 대신, 보험업계 통설인 "보장성보험료는 가처분소득의
// 8~12%가 적정"을 휴리스틱 임계로 쓴다. 수입 대비 보험 비중이 이 상단(12%)을
// 넘을 때만 "점검 권유"를 띄운다.
export const INSURANCE_RATIO_HIGH_THRESHOLD = 0.12;

export type InsuranceCheck = {
  // 보험 카테고리 월 환산 합계.
  monthlyInsuranceTotal: number;
  // 월 수입 대비 비율(0~1). 수입 0이면 null.
  ratioOfIncome: number | null;
  // 전체 보험료 비중의 임계 초과 사실. 권유 UI는 canSuggestReview를 사용한다.
  isHigh: boolean;
  reviewItemIds: string[];
  /** Scope any review prompt to reviewItemIds, never all insurance items. */
  canSuggestReview: boolean;
};

/**
 * 전체 보험료 비중은 그대로 계산하고, 권유 대상만 개인 보호 설정으로 제한한다.
 * canSuggestReview가 true일 때 reviewItemIds에 한해서만 점검을 권유한다.
 */
export function buildInsuranceCheck<T extends PredictableFixedCost>(
  items: T[],
  monthlyIncome: number,
  options?: CoachingProtectionOptions
): InsuranceCheck {
  const monthlyInsuranceTotal = items
    .filter((i) => i.categoryId === "insurance")
    .reduce((sum, i) => sum + monthlyEquivalent(i), 0);

  const ratioOfIncome =
    monthlyIncome > 0 ? monthlyInsuranceTotal / monthlyIncome : null;

  const isHigh =
    ratioOfIncome !== null && ratioOfIncome > INSURANCE_RATIO_HIGH_THRESHOLD;

  const protectedIds = new Set(options?.protectedFixedCostIds);
  const reviewItemIds = items.filter(i => i.categoryId === "insurance" && !protectedIds.has(i.id) && monthlyEquivalent(i) > 0).map(i => i.id);
  return { monthlyInsuranceTotal, ratioOfIncome, isHigh, reviewItemIds, canSuggestReview: isHigh && reviewItemIds.length > 0 };
}

/**
 * 액션형 절감 인사이트를 만든다(우선순위 순).
 *  1) 중복 구독 — 하나만 남기면 나머지 합계만큼 절감.
 *  2) 줄일 만한 항목 중 가장 큰 단일 항목 — 빼면 얼마 절감(참고용).
 *     단 주거·보험처럼 줄이기 어려운 카테고리는 후보에서 제외한다.
 */
export function buildSavingsInsights<T extends PredictableFixedCost>(
  items: T[],
  options?: CoachingProtectionOptions
): SavingsInsight<T>[] {
  const insights: SavingsInsight<T>[] = [];
  const protectedIds = new Set(options?.protectedFixedCostIds);
  const candidates = items.filter(item => !protectedIds.has(item.id));

  for (const dup of findDuplicateSubscriptions(candidates)) {
    // 하나는 유지한다고 가정 → 가장 비싼 1개를 제외한 나머지가 절감 가능액.
    const sortedDesc = [...dup.items].sort(
      (a, b) => monthlyEquivalent(b) - monthlyEquivalent(a)
    );
    const removable = sortedDesc.slice(1);
    const monthly = removable.reduce((sum, i) => sum + monthlyEquivalent(i), 0);
    if (monthly > 0) {
      insights.push({
        kind: "duplicate",
        title: `점검 가능한 "${dup.items[0].name}" ${dup.items.length}건 — 중복 여부 확인 후 하나만 유지할 경우의 예상액`,
        monthlySavings: monthly,
        annualSavings: monthly * 12,
        items: removable,
        actionableItemIds: removable.map(item => item.id)
      });
    }
  }

  // 가장 큰 단일 항목 — 단 "줄일 만한"(주거·보험 제외) 항목 중에서만 고른다.
  const reducible = candidates.filter((i) => !isHardToReduceCategory(i.categoryId));
  if (reducible.length > 0) {
    const largest = reducible.reduce((max, i) =>
      monthlyEquivalent(i) > monthlyEquivalent(max) ? i : max
    );
    const monthly = monthlyEquivalent(largest);
    const alreadyInDuplicate = insights.some((ins) =>
      ins.items.some((i) => i.id === largest.id)
    );
    if (monthly > 0 && !alreadyInDuplicate) {
      insights.push({
        kind: "largest",
        title: `유지 표시·주거·보험을 제외한 최대 항목 "${largest.name}" — 필요성 점검 (전액 제외 가정의 예상액, 실제 절감 아님)`,
        monthlySavings: monthly,
        annualSavings: monthly * 12,
        items: [largest],
        actionableItemIds: [largest.id]
      });
    }
  }

  return insights;
}
