// 납부일 예측 · 절감 시뮬레이션 · 중복 구독 탐지 — 외부 의존 없는 순수 함수.
// web(FixedCost) 과 api(FixedCostDto) 양쪽에서 쓰도록 최소 구조로 제네릭화한다.
//
// 모든 날짜 함수는 기준 시각 `from: Date` 을 인자로 받는다(내부에서 Date.now()
// 를 부르지 않음) — 테스트 가능성과 결정성을 위해서다.

/** 예측에 필요한 고정비 최소 필드. */
export type PredictableFixedCost = {
  id: string;
  name: string;
  categoryId: string;
  amount: number;
  periodMonths: number;
  billingDay: number;
  isEndOfMonth: boolean;
};

function lastDayOfMonth(year: number, monthIndex: number): number {
  // monthIndex: 0-11. 다음 달 0일 = 이번 달 마지막 날.
  return new Date(year, monthIndex + 1, 0).getDate();
}

function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * 다음 납부 예정일을 계산한다.
 * - isEndOfMonth 면 그 달의 마지막 날.
 * - 아니면 billingDay(그 달 일수를 넘으면 마지막 날로 클램프).
 * - 이번 달 예정일이 from 이전이면 다음 달로 넘어간다.
 *
 * 주기(periodMonths)는 "며칠에 빠지는가"(billingDay)를 바꾸지 않으므로, 표시용
 * 다음 납부일은 billingDay 기준의 다음 도래일로 본다(월 1회 도래 가정). 분기/
 * 연 단위 항목도 어느 달인지 정보가 없으므로 이 근사가 가장 정직하다.
 */
export function computeNextDueDate(
  item: Pick<PredictableFixedCost, "billingDay" | "isEndOfMonth">,
  from: Date
): Date {
  const base = dateOnly(from);
  const y = base.getFullYear();
  const m = base.getMonth();
  const fromDay = base.getDate();

  const dayInMonth = (year: number, monthIndex: number) =>
    item.isEndOfMonth
      ? lastDayOfMonth(year, monthIndex)
      : Math.min(item.billingDay, lastDayOfMonth(year, monthIndex));

  const thisMonthDay = dayInMonth(y, m);
  if (thisMonthDay >= fromDay) {
    return new Date(y, m, thisMonthDay);
  }
  // 다음 달
  const ny = m === 11 ? y + 1 : y;
  const nm = m === 11 ? 0 : m + 1;
  return new Date(ny, nm, dayInMonth(ny, nm));
}

/** from 부터 다음 납부일까지 남은 일수(0 = 오늘). */
export function getDaysUntilDue(
  item: Pick<PredictableFixedCost, "billingDay" | "isEndOfMonth">,
  from: Date
): number {
  const due = computeNextDueDate(item, from);
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
  const result = items.map((item) => {
    const dueDate = computeNextDueDate(item, from);
    return { item, dueDate, daysUntil: getDaysUntilDue(item, from) };
  });
  const filtered =
    typeof withinDays === "number"
      ? result.filter((r) => r.daysUntil <= withinDays)
      : result;
  return filtered.sort((a, b) => a.daysUntil - b.daysUntil);
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
  monthlySavings: number;
  annualSavings: number;
  items: T[];
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
  // 임계 초과로 점검을 권할 만한지.
  isHigh: boolean;
};

/**
 * 보험료가 수입 대비 과한지 판정한다(점검 권유 여부).
 * 임계 초과가 아니면 isHigh=false 로, 코치는 보험을 굳이 건드리지 않는다.
 */
export function buildInsuranceCheck<T extends PredictableFixedCost>(
  items: T[],
  monthlyIncome: number
): InsuranceCheck {
  const monthlyInsuranceTotal = items
    .filter((i) => i.categoryId === "insurance")
    .reduce((sum, i) => sum + monthlyEquivalent(i), 0);

  const ratioOfIncome =
    monthlyIncome > 0 ? monthlyInsuranceTotal / monthlyIncome : null;

  const isHigh =
    ratioOfIncome !== null && ratioOfIncome > INSURANCE_RATIO_HIGH_THRESHOLD;

  return { monthlyInsuranceTotal, ratioOfIncome, isHigh };
}

/**
 * 액션형 절감 인사이트를 만든다(우선순위 순).
 *  1) 중복 구독 — 하나만 남기면 나머지 합계만큼 절감.
 *  2) 줄일 만한 항목 중 가장 큰 단일 항목 — 빼면 얼마 절감(참고용).
 *     단 주거·보험처럼 줄이기 어려운 카테고리는 후보에서 제외한다.
 */
export function buildSavingsInsights<T extends PredictableFixedCost>(
  items: T[]
): SavingsInsight<T>[] {
  const insights: SavingsInsight<T>[] = [];

  for (const dup of findDuplicateSubscriptions(items)) {
    // 하나는 유지한다고 가정 → 가장 비싼 1개를 제외한 나머지가 절감 가능액.
    const sortedDesc = [...dup.items].sort(
      (a, b) => monthlyEquivalent(b) - monthlyEquivalent(a)
    );
    const removable = sortedDesc.slice(1);
    const monthly = removable.reduce((sum, i) => sum + monthlyEquivalent(i), 0);
    if (monthly > 0) {
      insights.push({
        kind: "duplicate",
        title: `"${dup.items[0].name}" 중복 ${dup.items.length}건 — 하나만 남기면 절감`,
        monthlySavings: monthly,
        annualSavings: monthly * 12,
        items: removable
      });
    }
  }

  // 가장 큰 단일 항목 — 단 "줄일 만한"(주거·보험 제외) 항목 중에서만 고른다.
  const reducible = items.filter((i) => !isHardToReduceCategory(i.categoryId));
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
        title: `가장 큰 고정비 "${largest.name}"`,
        monthlySavings: monthly,
        annualSavings: monthly * 12,
        items: [largest]
      });
    }
  }

  return insights;
}
