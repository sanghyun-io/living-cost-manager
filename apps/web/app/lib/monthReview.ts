// 월말 점검(보고서 제안 5) 파생 — 계획 vs 기록은 '기간기록기준'이고 주가 월 경계를
// 걸치면 안분하지 않고 주 단위 그대로 별도 표시한다. 가정(what-if)은 순수 초안으로
// 만 계산되고 원본 고정비·수입을 명시적 적용 전까지 변경하지 않는다. AI·모델 없이
// 결정론적으로 동작한다.
import { planningWeekEnd, type WorkspacePlanningData } from "@living-cost-manager/shared";
import type { FixedCost } from "./budget";
import { kstCivilDateString, addCivilDays, parseCivilDate } from "./planningTime";

export const MAX_KRW_LIMIT = 2147483647;

type PlanningWeek = WorkspacePlanningData["weeks"][number];

export type MonthWindow = { from: string; toInclusive: string; label: string };

/** asOf 시점의 KST 오늘이 속한 달(또는 offsetMonths만큼 지난/지난 달) 창. */
export function monthWindowFor(asOf: Date, offsetMonths = 0): MonthWindow | null {
  const today = kstCivilDateString(asOf);
  if (!today) return null;
  const parsed = parseCivilDate(today)!;
  let year = parsed.year;
  let month = parsed.month + offsetMonths;
  while (month > 12) { month -= 12; year += 1; }
  while (month < 1) { month += 12; year -= 1; }
  if (year < 1 || year > 9999) return null;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    from: `${pad(year)}-${pad(month)}-01`,
    toInclusive: `${pad(year)}-${pad(month)}-${pad(lastDay)}`,
    label: `${year}년 ${month}월`
  };
}

export type PeriodCoverage = {
  /** 주 전체가 달 안에 있는 경우만 월 합산에 포함. */
  inside: PlanningWeek[];
  /** 경계를 걸치는 주: 안분하지 않고 그대로 별도 표시(또는 검토 대상). */
  straddling: PlanningWeek[];
  /** 기록이 있는 주 하나라도 달과 겹치는지(= '계획 vs 실적 비교 가능' 여부). */
  hasAnyWeekOverlap: boolean;
};

export function weeksForWindow(weeks: readonly PlanningWeek[], window: MonthWindow): PeriodCoverage {
  const inside: PlanningWeek[] = [];
  const straddling: PlanningWeek[] = [];
  for (const week of weeks) {
    let end: string;
    try { end = planningWeekEnd(week.weekStart); } catch { continue; }
    if (week.weekStart >= window.from && end <= window.toInclusive) inside.push(week);
    else if (end >= window.from && week.weekStart <= window.toInclusive) straddling.push(week);
  }
  return { inside, straddling, hasAnyWeekOverlap: inside.length + straddling.length > 0 };
}

export type PlanVsRecord = {
  planned: number | null;
  recorded: number | null;
  difference: number | null;
  /** 사용액 기록이 하나도 없으면 plan-vs-plan 모드(비교 미표시). */
  hasRecords: boolean;
};

export function summarizePlanVsRecord(coverage: PeriodCoverage): PlanVsRecord {
  const plannedWeeks = coverage.inside.filter(week => week.budgetAmount !== null);
  const spentWeeks = coverage.inside.filter(week => week.spentAmount !== null);
  const planned = plannedWeeks.length > 0 ? plannedWeeks.reduce((sum, week) => sum + (week.budgetAmount ?? 0), 0) : null;
  const recorded = spentWeeks.length > 0 ? spentWeeks.reduce((sum, week) => sum + (week.spentAmount ?? 0), 0) : null;
  const total = planned !== null && planned > MAX_KRW_LIMIT ? null : planned;
  const spent = recorded !== null && recorded > MAX_KRW_LIMIT ? null : recorded;
  return {
    planned: total,
    recorded: spent,
    difference: total !== null && spent !== null ? total - spent : null,
    hasRecords: spentWeeks.length > 0
  };
}

// ── what-if 시나리오 ─────────────────────────────────────────────────────
export type CostPatch = { costId: string; newAmount: number };

export type ScenarioDraft = {
  /** null = 수입 가정 변경 없음. */
  newIncome: number | null;
  costs: CostPatch[];
  /** 일회성 가정(원본 기록에 절대 저장되지 않음). */
  oneOff: number;
};

export type BaselineSnapshot = {
  scopeKey: string;
  monthlyIncome: number;
  /** 시나리오가 의존하는 모든 정본 필드(id/amount/periodMonths/billingDay/
   * isEndOfMonth)를 id 순 정렬로 포함 — 기준 변경 감지용. */
  costFingerprint: string;
};

export function monthlyEquivalentLocal(item: Pick<FixedCost, "amount" | "periodMonths">): number {
  if (!(item.periodMonths > 0) || !Number.isFinite(item.periodMonths)) return 0;
  return Math.round(item.amount / item.periodMonths);
}

export function captureBaseline(scopeKey: string, fixedCosts: readonly FixedCost[], monthlyIncome: number): BaselineSnapshot {
  const costFingerprint = [...fixedCosts]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map(item => `${item.id}:${item.amount}:${item.periodMonths}:${item.billingDay}:${item.isEndOfMonth ? 1 : 0}`)
    .join("|");
  return { scopeKey, monthlyIncome, costFingerprint };
}

export function baselineMatches(current: BaselineSnapshot, captured: BaselineSnapshot): boolean {
  return current.scopeKey === captured.scopeKey && current.monthlyIncome === captured.monthlyIncome && current.costFingerprint === captured.costFingerprint;
}

export type ScenarioComparison = {
  baselineExpense: number;
  scenarioExpense: number;
  expenseDelta: number;
  baselineBalance: number | null;
  scenarioBalance: number | null;
  /** 가정에 포함된 항목 중 현재 목록에 없는 것(삭제됨) — 적용 대상에서 제외. */
  invalidCostIds: string[];
  oneOff: number;
  hasChanges: boolean;
};

/** 순수 비교: 입력 배열/객체를 변경하지 않는다. */
export function simulateScenario(
  draft: ScenarioDraft,
  fixedCosts: readonly FixedCost[],
  monthlyIncome: number
): ScenarioComparison {
  const validIds = new Set(fixedCosts.map(item => item.id));
  const invalidCostIds = draft.costs.filter(patch => !validIds.has(patch.costId)).map(patch => patch.costId);
  const baselineExpense = fixedCosts.reduce((sum, item) => sum + monthlyEquivalentLocal(item), 0);
  const scenarioExpense = fixedCosts.reduce((sum, item) => {
    const patch = draft.costs.find(candidate => candidate.costId === item.id);
    return sum + monthlyEquivalentLocal(patch ? { amount: patch.newAmount, periodMonths: item.periodMonths } : item);
  }, 0);
  const income = draft.newIncome ?? monthlyIncome;
  return {
    baselineExpense,
    scenarioExpense,
    expenseDelta: scenarioExpense - baselineExpense,
    baselineBalance: monthlyIncome > 0 ? monthlyIncome - baselineExpense : null,
    scenarioBalance: income > 0 ? income - scenarioExpense : null,
    invalidCostIds,
    oneOff: draft.oneOff,
    hasChanges: draft.newIncome !== null || draft.costs.length > 0 || draft.oneOff > 0
  };
}

/** 적용 가능한 재발 항목 패치만 반환(일회성은 절대 원본에 삽입되지 않는다). */
export function applicablePatches(draft: ScenarioDraft, fixedCosts: readonly FixedCost[]): { newIncome: number | null; costs: CostPatch[] } {
  const validIds = new Set(fixedCosts.map(item => item.id));
  return {
    newIncome: draft.newIncome,
    costs: draft.costs.filter(patch => validIds.has(patch.costId))
  };
}

export function nextWindowLabel(current: MonthWindow): string {
  const nextMonthStart = addCivilDays(current.toInclusive, 1);
  return nextMonthStart ? nextMonthStart.slice(0, 7) : "";
}
